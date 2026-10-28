"""Account-owned coordinate and blindfold sessions, isolated from saved PGNs.

Blindfold positions/answers stay on the server until the attempt ends. Coordinate
scores are derived from accepted clicks, never supplied as a score by the client.
"""
from __future__ import annotations

import io
import hashlib
import json
import random
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from typing import Literal

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field

import db
import training_native
import blindfold_rating
import explorer_credentials
import pgnlib
from accounts_api import require_user
from language_preferences import Language

router = APIRouter(prefix='/api/skills', tags=['Training skills'])
_source_lock = threading.Lock()
_source_next = 0.0


def init_training_skills():
    with db.get_conn() as conn:
        init_schema(conn)


def init_schema(conn):
    conn.executescript('''
      CREATE TABLE IF NOT EXISTS skill_sessions (
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL, config TEXT NOT NULL, state TEXT NOT NULL,
        created_at REAL NOT NULL, started_at REAL, finished_at REAL, result TEXT
      );
      CREATE INDEX IF NOT EXISTS skill_history ON skill_sessions(user_id,kind,finished_at);
      CREATE TABLE IF NOT EXISTS skill_source_games (
        game_id TEXT PRIMARY KEY, pgn TEXT, fetched_at REAL NOT NULL, retry_after REAL NOT NULL DEFAULT 0,
        credential_key TEXT NOT NULL DEFAULT ''
      );
    ''')
    if 'credential_key' not in {row['name'] for row in conn.execute('PRAGMA table_info(skill_source_games)')}:
        conn.execute("ALTER TABLE skill_source_games ADD COLUMN credential_key TEXT NOT NULL DEFAULT ''")
    blindfold_rating.init_schema(conn)


class StrictPayload(BaseModel):
    model_config = ConfigDict(extra='forbid')


class CoordinateConfig(StrictPayload):
    training_run_id: str | None = Field(None, min_length=8, max_length=160)
    request_id: str | None = Field(None, min_length=8, max_length=160)
    mode: Literal['coordinates', 'notation', 'mixed'] = 'coordinates'
    orientation: Literal['white', 'black', 'random'] = 'white'
    duration: Literal[30, 60] = 30
    coordinates: bool = False


class CoordinateAnswer(StrictPayload):
    index: int = Field(ge=0, le=10000)
    square: str = Field(pattern=r'^[a-h][1-8]$')


class BlindfoldConfig(StrictPayload):
    training_run_id: str | None = Field(None, min_length=8, max_length=160)
    request_id: str | None = Field(None, min_length=8, max_length=160)
    mode: Literal['opening', 'positions', 'endgame', 'reconstruct'] = 'opening'
    # Existing API callers and saved sessions retain their unranked behavior.
    # The current UI explicitly opts into rated Blindfold Puzzles by default.
    rated: bool = False
    rating_min: int = Field(default=1000, ge=0, le=4000)
    rating_max: int = Field(default=2000, ge=0, le=4000)
    max_moves: int = Field(default=10, ge=1, le=200)
    max_pieces: int = Field(default=7, ge=2, le=32)
    input: Literal['board', 'text'] = 'board'
    hide_prompt: bool = True
    reconstruct_after: bool = True
    entry_id: int | None = Field(default=None, ge=1, le=2**63 - 1)
    whole_game: bool = False
    language: Language = 'fr'


class BlindfoldAnswer(StrictPayload):
    move: str = Field(min_length=1, max_length=30)
    index: int = Field(ge=0, le=10000)
    language: Language = 'fr'


class ReconstructionAnswer(StrictPayload):
    pieces: dict[str, str] = Field(max_length=32)


def _dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _row(conn, session_id, user_id, kind=None):
    row = conn.execute('SELECT * FROM skill_sessions WHERE id=? AND user_id=?', (session_id, user_id)).fetchone()
    if row is None or (kind and row['kind'] != kind):
        raise HTTPException(404, 'Séance introuvable.')
    value = dict(row)
    value['config'] = json.loads(value['config'])
    value['state'] = json.loads(value['state'])
    value['result'] = json.loads(value['result']) if value['result'] else None
    return value


def _new_session(conn, user_id, kind, config, state, *, started=True, request_payload=None):
    base_id = None
    if config.get('entry_id'):
        entry = conn.execute('SELECT base_id FROM entries WHERE id=?', (config['entry_id'],)).fetchone()
        base_id = entry['base_id'] if entry else None
    if kind == 'coordinates':
        for previous in conn.execute("SELECT id FROM skill_sessions WHERE user_id=? AND kind='coordinates' AND finished_at IS NULL", (user_id,)).fetchall():
            old = _row(conn, previous['id'], user_id, kind)
            if time.time() >= old['started_at'] + old['config']['duration']:
                _coordinate_result(old, time.time())
                _save(conn, old)
    active = [row['id'] for row in conn.execute('SELECT id FROM skill_sessions WHERE user_id=? AND kind=? AND finished_at IS NULL', (user_id, kind))]
    resumed = training_native.creation(conn, user_id, kind, config.get('training_run_id'), config.get('request_id'), base_id=base_id, active_ids=active, request_payload=request_payload or config)
    if resumed:
        return _row(conn, resumed, user_id, kind)
    identity, stamp = secrets.token_urlsafe(24), time.time()
    if kind == 'blindfold':
        active = conn.execute("SELECT id FROM skill_sessions WHERE user_id=? AND kind='blindfold' AND finished_at IS NULL", (user_id,)).fetchall()
        for previous in active:
            old = _row(conn, previous['id'], user_id, 'blindfold')
            _finish_blind(old, abandoned=True)
            _save(conn, old)
    if kind == 'coordinates':
        for previous in active:
            old = _row(conn, previous, user_id, kind)
            old['finished_at'] = stamp
            old['result'] = {'abandoned': True}
            _save(conn, old)
    # One running session per discipline avoids parallel score farming and
    # bounds stale sessions. An interrupted attempt is retained as abandoned.
    conn.execute('''UPDATE skill_sessions SET finished_at=?,result=?
        WHERE user_id=? AND kind=? AND finished_at IS NULL''',
        (stamp, _dump({'abandoned': True}), user_id, kind))
    conn.execute('INSERT INTO skill_sessions VALUES(?,?,?,?,?,?,?,?,?)',
                 (identity, user_id, kind, _dump(config), _dump(state), stamp, stamp if started else None, None, None))
    training_native.register(conn, user_id, kind, identity, training_run_id=config.get('training_run_id'), request_id=config.get('request_id'), base_id=base_id, title=state.get('title'), options={key: value for key, value in (request_payload or config).items() if key not in ('training_run_id', 'request_id', 'entry_id', 'language')}, request_payload=request_payload or config)
    return _row(conn, identity, user_id)


def _save(conn, row):
    if row['kind'] == 'blindfold' and row['finished_at'] is not None:
        blindfold_rating.grade(conn, row)
    conn.execute('UPDATE skill_sessions SET state=?,started_at=?,finished_at=?,result=? WHERE id=?',
                 (_dump(row['state']), row['started_at'], row['finished_at'],
                  _dump(row['result']) if row['result'] is not None else None, row['id']))
    training_native.skill(conn, row)


def _target(config, previous=None):
    choices = [square for square in chess.SQUARE_NAMES if square != previous]
    square = secrets.choice(choices)
    notation = config['mode'] == 'notation' or (config['mode'] == 'mixed' and secrets.randbelow(2) == 1)
    return {'square': square, 'piece': secrets.choice('KQRBN') if notation else '', 'notation': notation}


def _coordinate_result(row, stamp):
    state, duration = row['state'], row['config']['duration']
    responses = state['correct'] + state['errors']
    row['finished_at'] = stamp
    row['result'] = {'score': state['correct'], 'errors': state['errors'],
                     'accuracy': round(100 * state['correct'] / responses, 1) if responses else 0,
                     'mean_ms': round(sum(state['response_ms']) / len(state['response_ms'])) if state['response_ms'] else None,
                     'duration': duration}


def _coordinate_public(row):
    return {'id': row['id'], 'training_run_id': row['config'].get('training_run_id'), 'config': row['config'], 'target': row['state']['target'],
            'index': row['state']['index'], 'score': row['state']['correct'], 'errors': row['state']['errors'],
            'deadline': row['started_at'] + row['config']['duration'], 'server_time': time.time(),
            'finished': row['finished_at'] is not None, 'result': row['result']}


@router.post('/coordinates')
def coordinate_start(payload: CoordinateConfig, user=Depends(require_user)):
    config = payload.model_dump()
    if config['orientation'] == 'random':
        config['orientation'] = secrets.choice(['white', 'black'])
    state = {'target': _target(config), 'index': 0, 'correct': 0, 'errors': 0,
             'target_at': time.time(), 'response_ms': [], 'events': []}
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return _coordinate_public(_new_session(conn, user['id'], 'coordinates', config, state, request_payload=payload.model_dump()))


@router.post('/coordinates/{session_id}/answer')
def coordinate_answer(session_id: str, payload: CoordinateAnswer, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'coordinates')
        if row['finished_at'] is not None:
            return _coordinate_public(row)
        stamp, state = time.time(), row['state']
        if stamp >= row['started_at'] + row['config']['duration']:
            _coordinate_result(row, stamp)
        elif payload.index != state['index']:
            raise HTTPException(409, 'Cette réponse a déjà été traitée. Recharge la séance.')
        else:
            correct = payload.square == state['target']['square']
            state['events'].append({'square': payload.square, 'target': state['target'],
                                    'elapsed_ms': round(1000 * (stamp - row['started_at'])), 'correct': correct})
            state['index'] += 1
            if correct:
                state['correct'] += 1
                state['response_ms'].append(round(1000 * max(0, stamp - state['target_at'])))
                state['target'] = _target(row['config'], state['target']['square'])
                state['target_at'] = stamp
            else:
                state['errors'] += 1
        _save(conn, row)
        return _coordinate_public(row)


@router.post('/coordinates/{session_id}/finish')
def coordinate_finish(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'coordinates')
        if row['finished_at'] is None:
            if time.time() < row['started_at'] + row['config']['duration']:
                raise HTTPException(409, 'Le chronomètre n’est pas encore terminé.')
            _coordinate_result(row, time.time())
            _save(conn, row)
        return _coordinate_public(row)


@router.get('/coordinates/history')
def coordinate_history(user=Depends(require_user)):
    with db.get_conn() as conn:
        rows = conn.execute('''SELECT id,config,finished_at,result FROM skill_sessions
            WHERE user_id=? AND kind='coordinates' AND result IS NOT NULL ORDER BY finished_at DESC''', (user['id'],)).fetchall()
    history, best = [], {}
    for row in rows:
        config, result = json.loads(row['config']), json.loads(row['result'])
        if result.get('abandoned'):
            continue
        entry = {'id': row['id'], 'config': config, 'finished_at': row['finished_at'], **result}
        key = (config['mode'], config['orientation'], config['duration'], config['coordinates'])
        if key not in best or result['score'] > best[key]['score']:
            best[key] = entry
        if len(history) < 30:
            history.append(entry)
    return {'history': history, 'records': list(best.values())}


@router.get('/coordinates/{session_id}')
def coordinate_get(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'coordinates')
        if row['finished_at'] is None and time.time() >= row['started_at'] + row['config']['duration']:
            _coordinate_result(row, time.time())
            _save(conn, row)
        return _coordinate_public(row)


class _NoSourceRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # A bearer token must never be forwarded to a redirect destination.
        return None


def _source_game(game_url):
    """Fetch one public Lichess game, with bounded reads, cache and global cooldown."""
    global _source_next
    parsed = urlsplit(game_url or '')
    if parsed.scheme != 'https' or parsed.hostname != 'lichess.org':
        raise ValueError('Source Lichess non disponible.')
    match = re.match(r'^/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:/(?:white|black))?/?$', parsed.path)
    if not match:
        raise ValueError('Source Lichess non disponible.')
    game_id, stamp = match.group(1), time.time()
    with db.get_conn() as conn:
        cached = conn.execute('SELECT * FROM skill_source_games WHERE game_id=?', (game_id,)).fetchone()
    if cached and cached['pgn']:
        return pgnlib.load_game(cached['pgn'])
    token = explorer_credentials.get_token()
    credential_key = hashlib.sha256(token.encode()).hexdigest() if token else ''
    if cached and cached['retry_after'] > stamp and cached['credential_key'] == credential_key:
        raise ValueError('Partie source temporairement indisponible.')
    with _source_lock:
        if stamp < _source_next:
            raise ValueError('Lichess demande de patienter avant de charger une autre partie source.')
        _source_next = stamp + 1.0
        headers = {'Accept': 'application/x-chess-pgn', 'Accept-Encoding': 'identity', 'User-Agent': 'ChessGym/1.0 blindfold-training'}
        if token:
            headers['Authorization'] = 'Bearer ' + token
        req = urllib.request.Request('https://lichess.org/game/export/' + game_id + '?clocks=false&evals=false&opening=false', headers=headers)
        try:
            with urllib.request.build_opener(_NoSourceRedirect()).open(req, timeout=10) as response:
                final_url = urlsplit(response.geturl()) if hasattr(response, 'geturl') else urlsplit(req.full_url)
                if final_url.scheme != 'https' or final_url.netloc != 'lichess.org' or final_url.path != '/game/export/' + game_id:
                    raise ValueError('Adresse de partie source inattendue.')
                content_type = getattr(response, 'headers', {}).get('Content-Type', '').split(';')[0].strip().lower()
                if content_type == 'text/html':
                    raise ValueError('Lichess demande une connexion. Configure ou vérifie le jeton Lichess dans les réglages de l’explorer.')
                if content_type and content_type not in {'application/x-chess-pgn', 'application/vnd.chess-pgn', 'text/plain', 'application/octet-stream'}:
                    raise ValueError('Format de partie source inattendu.')
                data = response.read(2_000_001)
            if len(data) > 2_000_000:
                raise ValueError('Partie source trop volumineuse.')
            text = data.decode('utf-8-sig')
            if text.lstrip().lower().startswith(('<!doctype', '<html')):
                raise ValueError('Lichess demande une connexion. Configure ou vérifie le jeton Lichess dans les réglages de l’explorer.')
            game = pgnlib.load_game(text)
        except (OSError, ValueError) as exc:
            cooldown = 60 if isinstance(exc, urllib.error.HTTPError) and exc.code == 429 else 300
            _source_next = time.time() + (60 if cooldown == 60 else 1)
            with db.get_conn() as conn:
                conn.execute('INSERT OR REPLACE INTO skill_source_games VALUES(?,?,?,?,?)', (game_id, None, stamp, stamp + cooldown, credential_key))
            code = getattr(exc, 'code', None)
            if isinstance(exc, urllib.error.HTTPError):
                exc.close()
            if code in (301, 302, 303, 307, 308, 401, 403) or 'Lichess demande une connexion.' in str(exc):
                raise ValueError('Lichess demande une connexion. Configure ou vérifie le jeton Lichess dans les réglages de l’explorer.') from exc
            raise ValueError('La partie source est indisponible; essaie un autre puzzle plus tard.') from exc
    with db.get_conn() as conn:
        conn.execute('INSERT OR REPLACE INTO skill_source_games VALUES(?,?,?,0,?)', (game_id, text, stamp, credential_key))
    return game


def _position_key(board):
    # Full counters do not change the position; castling/en passant do.
    return ' '.join(board.fen().split()[:4])


def opening_prefix(puzzle):
    game = _source_game(puzzle['game_url'])
    board = game.board()
    if board.fen() != chess.STARTING_FEN:
        raise ValueError('Cette partie ne commence pas à la position initiale standard.')
    expected = chess.Board(puzzle['start_fen'])
    target_ply = expected.ply()
    words = []
    for move in game.mainline_moves():
        if board.ply() >= target_ply:
            break
        words.append({'number': board.fullmove_number, 'color': 'white' if board.turn else 'black', 'san': board.san(move)})
        board.push(move)
    if board.ply() != target_ply or _position_key(board) != _position_key(expected):
        raise ValueError('La partie source ne correspond pas exactement à la position du puzzle.')
    return words


def position_description(fen):
    board = chess.Board(fen)
    return {'white': [{'piece': piece.symbol(), 'square': chess.square_name(square)} for square, piece in sorted(board.piece_map().items()) if piece.color],
            'black': [{'piece': piece.symbol(), 'square': chess.square_name(square)} for square, piece in sorted(board.piece_map().items()) if not piece.color],
            'turn': 'white' if board.turn else 'black', 'castling': board.castling_xfen(),
            'en_passant': chess.square_name(board.ep_square) if board.ep_square is not None else None}


def _puzzle_document(state):
    game = chess.pgn.Game()
    game.setup(chess.Board(state['start_fen']))
    game.headers['Event'] = 'Blindfold puzzle ' + state['puzzle_id']
    game.headers['Site'] = state.get('game_url', '')
    node = game
    for uci in state.get('completed_solution', state['solution']):
        node = node.add_variation(chess.Move.from_uci(uci))
    return pgnlib.game_payload(game)


def _blind_public(row):
    state = row['state']
    phase = 'finished' if row['finished_at'] is not None else state.get('phase', 'reconstruct' if row['config']['mode'] == 'reconstruct' else 'solve')
    preparation_ms = ((row['result'] or {}).get('preparation_ms') if row['finished_at'] is not None
                      else _blind_preparation_ms(row, time.time()))
    result = {'id': row['id'], 'training_run_id': row['config'].get('training_run_id'), 'config': row['config'], 'phase': phase, 'started': row['started_at'] is not None,
              'finished': row['finished_at'] is not None, 'result': row['result'],
              'preparation_ms': preparation_ms,
              'index': state.get('index', 0), 'errors': state.get('errors', 0),
              'answer_index': len(state.get('attempts', [])),
              'played': [] if phase == 'reconstruct' and row['config']['mode'] != 'reconstruct' else state.get('played', []), 'title': state.get('title', ''),
              'puzzle_id': state.get('puzzle_id'), 'rating': state.get('rating'),
              'rated': row['config'].get('rated', False), 'rating_eligible': state.get('rating_eligible'),
              'challenge': state.get('challenge')}
    if state.get('start_fen'):
        result['color'] = 'white' if chess.Board(state['start_fen']).turn else 'black'
    if (row['started_at'] is None or not row['config']['hide_prompt']) and not (phase == 'reconstruct' and state.get('solve_result')):
        result['prompt'] = state['prompt']
    if state.get('solve_result'):
        result['solve_result'] = state['solve_result']
    if row['finished_at'] is not None and not (row['result'] or {}).get('abandoned'):
        result['document'] = state['document'] if row['config']['mode'] == 'reconstruct' else _puzzle_document(state)
        result['attempts'] = state.get('attempts', [])
    return result


@router.get('/blindfold/overview')
def blindfold_overview(user=Depends(require_user)):
    with db.get_conn() as conn:
        active = conn.execute("SELECT id FROM skill_sessions WHERE user_id=? AND kind='blindfold' AND finished_at IS NULL ORDER BY created_at DESC LIMIT 1", (user['id'],)).fetchone()
        return {'profiles': blindfold_rating.profiles(conn, user['id']),
                'active_session': _blind_public(_row(conn, active['id'], user['id'], 'blindfold')) if active else None}


@router.get('/blindfold/bases')
def blindfold_bases(user=Depends(require_user)):
    with db.get_conn() as conn:
        rows = conn.execute('''SELECT b.id,b.name,COUNT(e.id) AS count FROM bases b
            JOIN entries e ON e.base_id=b.id
            WHERE NOT EXISTS(SELECT 1 FROM reference_bases r WHERE r.base_id=b.id)
            GROUP BY b.id ORDER BY b.sort_order,b.id''').fetchall()
    return {'bases': [dict(row) for row in rows]}


@router.post('/blindfold')
def blindfold_start(payload: BlindfoldConfig, user=Depends(require_user)):
    config = payload.model_dump()
    if config['mode'] == 'endgame':
        config['mode'] = 'positions'
    if payload.mode == 'reconstruct':
        config['rated'] = False
    if config['rated']:
        config.update(hide_prompt=True)
    if payload.rating_min > payload.rating_max:
        raise HTTPException(400, 'La cote minimale doit être inférieure à la cote maximale.')
    if payload.mode == 'reconstruct':
        if payload.entry_id is None:
            raise HTTPException(400, 'Choisis une partie à reconstituer.')
        with db.get_conn() as conn:
            entry = conn.execute('SELECT id,title,pgn FROM entries WHERE id=?', (payload.entry_id,)).fetchone()
        if entry is None:
            raise HTTPException(404, 'Cette partie est introuvable.')
        source = pgnlib.load_game(entry['pgn'])
        root = source.board()
        game = chess.pgn.Game()
        game.headers.update(source.headers)
        game.setup(root)
        board, node, words = root.copy(), game, []
        # X full moves means X pairs from the supplied starting position, even
        # for a custom FEN. The displayed count explicitly distinguishes plies.
        limit = 10000 if payload.whole_game else payload.max_moves * 2
        for index, move in enumerate(source.mainline_moves()):
            if index >= limit:
                break
            words.append({'number': board.fullmove_number, 'color': 'white' if board.turn else 'black', 'san': board.san(move)})
            node = node.add_variation(move)
            board.push(move)
        if not words:
            raise HTTPException(400, 'Cette partie ne contient aucun coup à visualiser.')
        state = {'title': entry['title'], 'document': pgnlib.game_payload(game),
                 'target_fen': board.fen(), 'prompt': {'moves': words,
                   'initial_position': position_description(root.fen()) if root.fen() != chess.STARTING_FEN else None},
                 'index': 0, 'errors': 0}
        config['hide_prompt'] = True
    else:
        import puzzle_store
        filters = {'rating_min': payload.rating_min, 'rating_max': payload.rating_max}
        filters['max_initial_ply' if payload.mode == 'opening' else 'max_pieces'] = payload.max_moves * 2 if payload.mode == 'opening' else payload.max_pieces
        with db.get_conn() as conn:
            recent = [json.loads(row['state']).get('puzzle_id') for row in conn.execute(
                "SELECT state FROM skill_sessions WHERE user_id=? AND kind='blindfold' ORDER BY created_at DESC LIMIT 50", (user['id'],)).fetchall()]
        challenge = None
        try:
            if config['rated']:
                with db.get_conn() as conn:
                    rows, challenge = blindfold_rating.selection(conn, user['id'], config['mode'], [x for x in recent if x])
            else:
                rows = puzzle_store.search_puzzles(filters, limit=20, exclude_ids=[x for x in recent if x])
                if not rows:
                    rows = puzzle_store.search_puzzles(filters, limit=20)
        except puzzle_store.PuzzleSelectionTimeout as exc:
            raise HTTPException(503, 'La sélection de puzzles prend trop de temps. Réessaie ou précise les filtres.') from exc
        if not rows:
            raise HTTPException(404, 'Aucun puzzle ne correspond à ces critères. Importe la banque Lichess ou élargis les filtres.')
        problem = None
        for raw in rows:
            try:
                puzzle = puzzle_store.prepared_puzzle(raw)
                prompt = {'moves': opening_prefix(puzzle)} if payload.mode == 'opening' else {'position': position_description(puzzle['start_fen'])}
                break
            except ValueError as exc:
                problem = str(exc)
                # The shared source gate permits only one uncached request per
                # second. Cached candidates can still be tried without a wait.
        else:
            raise HTTPException(503, problem or 'Aucune partie source disponible. Réessaie plus tard.')
        state = {'puzzle_id': puzzle['id'], 'rating': puzzle['rating'], 'game_url': puzzle['game_url'],
                 'start_fen': puzzle['start_fen'], 'fen': puzzle['start_fen'], 'solution': puzzle['solution'],
                 'index': 0, 'errors': 0, 'attempts': [], 'played': [], 'played_uci': [], 'prompt': prompt}
        if challenge:
            config.update(max_moves=challenge['targets']['moves_max'],
                          max_pieces=challenge['targets']['pieces_max'],
                          rating_min=challenge['tactical_min'], rating_max=challenge['tactical_max'])
            state['challenge'] = blindfold_rating.exercise(challenge, config['mode'],
                moves=(puzzle['start_ply'] + 1) // 2,
                pieces=len(chess.Board(puzzle['start_fen']).piece_map()), puzzle_rating=puzzle['rating'],
                puzzle_deviation=puzzle.get('rating_deviation', 45))
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return _blind_public(_new_session(conn, user['id'], 'blindfold', config, state, started=False, request_payload=payload.model_dump()))


@router.post('/blindfold/{session_id}/ready')
def blindfold_ready(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'blindfold')
        if row['finished_at'] is not None:
            raise HTTPException(409, 'Cette séance est terminée.')
        if row['started_at'] is None:
            row['started_at'] = time.time()
            blindfold_rating.claim_attempt(conn, row)
            _save(conn, row)
        return _blind_public(row)


def parse_answer(board, text, language='fr'):
    text = text.strip()
    # An empty board cannot reveal whether a selected piece is a pawn. The
    # client always supplies its promotion preference; apply it only when needed.
    coordinate_choice = re.fullmatch(r'([a-h][1-8][a-h][1-8])=([qrbn])', text.lower())
    if coordinate_choice:
        text = coordinate_choice.group(1)
        origin = board.piece_at(chess.parse_square(text[:2]))
        if origin and origin.piece_type == chess.PAWN and text[3] in '18':
            text += coordinate_choice.group(2)
    if re.fullmatch('[a-h][1-8][a-h][1-8][qrbn]?', text.lower()):
        move = chess.Move.from_uci(text.lower())
        if move in board.legal_moves:
            return move
        raise ValueError('Illegal move')
    if language == 'fr' and text and text[0] in 'RDTFC':
        text = {'R': 'K', 'D': 'Q', 'T': 'R', 'F': 'B', 'C': 'N'}[text[0]] + text[1:]
    return board.parse_san(text)


def _blind_preparation_ms(row, stamp):
    end = row['started_at'] if row['started_at'] is not None else stamp
    return round(1000 * max(0, end - row['created_at']))


def _blind_result(row, stamp, *, revealed=False):
    preparation_ms = _blind_preparation_ms(row, stamp)
    elapsed_ms = round(1000 * max(0, stamp - row['started_at'])) if row['started_at'] is not None else 0
    return {'success': not revealed and row['state'].get('errors', 0) == 0,
            'errors': row['state'].get('errors', 0), 'revealed': revealed,
            'elapsed_ms': elapsed_ms, 'preparation_ms': preparation_ms,
            'total_elapsed_ms': preparation_ms + elapsed_ms}


def _finish_blind(row, *, revealed=False, abandoned=False):
    row['finished_at'] = time.time()
    row['result'] = _blind_result(row, row['finished_at'], revealed=revealed)
    solve = row['state'].get('solve_result')
    if solve:
        row['result'].update(success=solve['success'], solve_success=solve['success'], solve_errors=solve['errors'],
            solve_elapsed_ms=solve['elapsed_ms'], reconstruction_success=False,
            reconstruction_elapsed_ms=round(1000 * max(0, row['finished_at'] - row['state']['reconstruction_started_at'])))
        if revealed or abandoned:
            row['result']['reconstruction_skipped'] = True
    elif row['config']['mode'] != 'reconstruct':
        # A missing reconstruction stage must not make an unfinished puzzle a
        # win. Only a completed, error-free solution earns rating credit.
        state = row['state']
        success = (not revealed and not abandoned and row['started_at'] is not None
                   and bool(state.get('solution')) and state.get('index') == len(state['solution'])
                   and state.get('errors', 0) == 0)
        row['result'].update(success=success, solve_success=success,
                            solve_errors=state.get('errors', 0),
                            solve_elapsed_ms=row['result']['elapsed_ms'])
    if abandoned and not solve:
        row['result'].update(abandoned=True, success=False)


def _begin_final_reconstruction(row):
    stamp = time.time()
    row['state'].update(phase='reconstruct', target_fen=row['state']['fen'],
        solve_result=_blind_result(row, stamp), reconstruction_started_at=stamp)


@router.post('/blindfold/{session_id}/answer')
def blindfold_answer(session_id: str, payload: BlindfoldAnswer, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'blindfold')
        if row['config']['mode'] == 'reconstruct':
            raise HTTPException(400, 'Utilise la reconstitution de position.')
        if row['finished_at'] is not None:
            return _blind_public(row)
        if row['started_at'] is None:
            raise HTTPException(409, 'Commence la résolution avant de répondre.')
        if row['state'].get('phase') == 'reconstruct':
            raise HTTPException(409, 'La suite est résolue. Reconstitue maintenant la position finale.')
        state = row['state']
        if payload.index != len(state['attempts']):
            raise HTTPException(409, 'Cette réponse a déjà été traitée.')
        if len(state['attempts']) >= 1000:
            raise HTTPException(400, 'Trop de tentatives dans cette séance.')
        board, move = chess.Board(state['fen']), None
        try:
            move = parse_answer(board, payload.move, payload.language)
        except ValueError:
            pass
        alternative_mate = False
        if move and move.uci() != state['solution'][state['index']]:
            alternative = board.copy()
            alternative.push(move)
            alternative_mate = alternative.is_checkmate()
        correct = bool(move and (move.uci() == state['solution'][state['index']] or alternative_mate))
        state['attempts'].append({'move': payload.move, 'uci': move.uci() if move else None,
                                  'correct': correct, 'solution_index': state['index'],
                                  'elapsed_ms': round(1000 * (time.time() - row['started_at']))})
        if not correct:
            state['errors'] += 1
        else:
            state.setdefault('played_uci', list(state['solution'][:state['index']])).append(move.uci())
            state['played'].append({'san': board.san(move), 'color': 'white' if board.turn else 'black', 'number': board.fullmove_number})
            board.push(move)
            state['index'] = len(state['solution']) if alternative_mate else state['index'] + 1
            if state['index'] < len(state['solution']):
                reply = chess.Move.from_uci(state['solution'][state['index']])
                state['played_uci'].append(reply.uci())
                state['played'].append({'san': board.san(reply), 'color': 'white' if board.turn else 'black', 'number': board.fullmove_number})
                board.push(reply)
                state['index'] += 1
            state['fen'] = board.fen()
            if state['index'] == len(state['solution']):
                state['completed_solution'] = list(state['played_uci'])
                # Missing flags identify legacy sessions, whose original flow
                # remains unchanged. New configs opt into the second stage.
                if row['config'].get('reconstruct_after', False):
                    _begin_final_reconstruction(row)
                else:
                    _finish_blind(row)
        _save(conn, row)
        return {**_blind_public(row), 'correct': correct, 'answer_index': len(state['attempts'])}


def compare_position(target_fen, proposed):
    expected = {chess.square_name(square): piece.symbol() for square, piece in chess.Board(target_fen).piece_map().items()}
    for square, piece in proposed.items():
        if square not in chess.SQUARE_NAMES or piece not in 'KQRBNPkqrbnp' or len(piece) != 1:
            raise HTTPException(400, 'La position proposée contient une case ou une pièce invalide.')
    correct = [square for square, piece in expected.items() if proposed.get(square) == piece]
    missing = [{'square': square, 'piece': piece} for square, piece in expected.items() if square not in proposed]
    misplaced = [{'square': square, 'piece': piece, 'expected': expected.get(square)} for square, piece in proposed.items() if expected.get(square) != piece]
    return {'success': expected == proposed, 'correct': correct, 'missing': missing, 'misplaced': misplaced,
            'expected': expected, 'proposed': proposed, 'accuracy': round(100 * len(correct) / max(len(expected), len(proposed), 1), 1)}


@router.post('/blindfold/{session_id}/position')
def reconstruction_answer(session_id: str, payload: ReconstructionAnswer, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'blindfold')
        puzzle_reconstruction = row['config']['mode'] != 'reconstruct'
        if puzzle_reconstruction and not row['state'].get('solve_result'):
            raise HTTPException(409, 'Résous la suite avant de reconstituer la position finale.')
        if row['finished_at'] is not None:
            return _blind_public(row)
        if row['started_at'] is None:
            raise HTTPException(409, 'Commence la reconstitution avant de répondre.')
        comparison = compare_position(row['state']['target_fen'], payload.pieces)
        _finish_blind(row)
        row['result'].update(comparison)
        if puzzle_reconstruction:
            solve = row['state']['solve_result']
            row['result'].update(reconstruction_success=comparison['success'],
                                success=solve['success'])
        _save(conn, row)
        return _blind_public(row)


@router.post('/blindfold/{session_id}/reveal')
def blindfold_reveal(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'blindfold')
        if row['finished_at'] is None:
            _finish_blind(row, revealed=True)
            _save(conn, row)
        return _blind_public(row)


@router.post('/blindfold/{session_id}/abandon')
def blindfold_abandon(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'], 'blindfold')
        if row['finished_at'] is None:
            _finish_blind(row, abandoned=True)
            _save(conn, row)
        return _blind_public(row)


@router.get('/blindfold/history')
def blindfold_history(user=Depends(require_user)):
    with db.get_conn() as conn:
        rows = conn.execute('''SELECT id,config,finished_at,result,state FROM skill_sessions
            WHERE user_id=? AND kind='blindfold' AND result IS NOT NULL ORDER BY finished_at DESC LIMIT 100''', (user['id'],)).fetchall()
    history = []
    for row in rows:
        result = json.loads(row['result'])
        if result.get('abandoned'):
            continue
        state = json.loads(row['state'])
        history.append({'id': row['id'], 'config': json.loads(row['config']), 'finished_at': row['finished_at'],
                        'title': state.get('title', state.get('puzzle_id', '')), **result})
    with db.get_conn() as conn:
        return {'history': history[:30], 'profiles': blindfold_rating.profiles(conn, user['id'])}


@router.get('/blindfold/{session_id}')
def blindfold_get(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        return _blind_public(_row(conn, session_id, user['id'], 'blindfold'))
