"""Resumable, private game reports and exercises, without rewriting source PGNs."""
from __future__ import annotations

from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
import math
import threading
from urllib.parse import urlsplit

import chess
import chess.pgn
from fastapi import APIRouter, HTTPException

from db import get_conn
import engine
from analysis_limits import MIN_DEPTH, MAX_DEPTH, MIN_TIME_MS, MAX_TIME_MS
import pgnlib

router = APIRouter(prefix='/api/game-analysis')
DEFAULT_OPTIONS = {'depth': None, 'time_ms': 400}
MAX_PLIES = 1000
MAX_PV = 32
QUALITY = 'Première analyse indicative ; vérifier les positions importantes avec une analyse approfondie.'
CHANCE_METHOD = 'Indice indicatif dérivé de l’évaluation, non personnalisé au classement du joueur.'
VERIFY_OPTIONS = {'depth': 24, 'time_ms': 2000}
ACTION_SECONDS = 20
RETRY_TOLERANCE = 3.0
_ACTION_LOCK = threading.Lock()
REPORT_VERSION = 1
EVALUATION_VERSION = 1
CLASSIFICATION_VERSION = 2


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


def init_analysis():
    with get_conn() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS game_analysis_reports (
            entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
            fingerprint TEXT NOT NULL, settings TEXT NOT NULL, status TEXT NOT NULL,
            error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS game_analysis_positions (
            entry_id INTEGER NOT NULL REFERENCES game_analysis_reports(entry_id) ON DELETE CASCADE,
            ply INTEGER NOT NULL, fen TEXT NOT NULL, evaluation TEXT NOT NULL,
            PRIMARY KEY(entry_id,ply)
        );
        CREATE TABLE IF NOT EXISTS game_analysis_exercises (
            source_entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            source_fingerprint TEXT NOT NULL, ply INTEGER NOT NULL,
            base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
            exercise_entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            UNIQUE(source_entry_id,source_fingerprint,ply,base_id)
        );
        ''')
        # Existing reports keep unknown provenance: do not retroactively claim
        # they were calculated using today's implementation or engine settings.
        if 'provenance' not in {row['name'] for row in conn.execute('PRAGMA table_info(game_analysis_reports)')}:
            conn.execute('ALTER TABLE game_analysis_reports ADD COLUMN provenance TEXT')


def analysis_provenance(options):
    """Only record parameters passed to the engine, never infer its version.

    The existing engine identity fingerprints local binary metadata, not the
    executable contents or a UCI version. The actual UCI name is stored on each
    evaluation; a read never inspects whichever engine is selected now.
    """
    return {
        'report_version': REPORT_VERSION, 'evaluation_version': EVALUATION_VERSION,
        'classification_version': CLASSIFICATION_VERSION,
        'engine_identity': options.get('engine_identity'),
        'engine_identity_kind': 'local-binary-metadata-v1',
        'requested': {**{key: options.get(key) for key in DEFAULT_OPTIONS},
                      'multipv': 1, 'skill': 20},
    }


def report_provenance(recorded):
    """Separate stored calculation provenance from today's derived findings."""
    if isinstance(recorded, str):
        try:
            recorded = json.loads(recorded)
        except (ValueError, TypeError):
            recorded = None
    if not isinstance(recorded, dict) or not recorded:
        recorded = None
    versions = {'report_version': REPORT_VERSION, 'evaluation_version': EVALUATION_VERSION,
                'classification_version': CLASSIFICATION_VERSION}
    # This is version agreement only, not a promise of engine reproducibility.
    match = (None if recorded is None or any(key not in recorded for key in versions)
             else all(recorded.get(key) == value for key, value in versions.items()))
    return {'recorded': recorded, 'rendered_with': {
        'report_version': REPORT_VERSION, 'classification_version': CLASSIFICATION_VERSION},
        'versions_match': match}


def options_of(payload):
    if not isinstance(payload, dict) or set(payload) - set(DEFAULT_OPTIONS):
        raise HTTPException(422, 'Réglages d’analyse invalides.')
    options = {**DEFAULT_OPTIONS, **payload}
    # A depth-only request must not acquire the default time limit. Explicit
    # time+depth settings from saved jobs remain valid and retain both limits.
    if payload.get('depth') is not None and 'time_ms' not in payload:
        options['time_ms'] = None
    depth, duration = options['depth'], options['time_ms']
    if depth is not None and (type(depth) is not int or not MIN_DEPTH <= depth <= MAX_DEPTH):
        raise HTTPException(422, 'La profondeur doit être un entier positif compatible avec le moteur.')
    if duration is not None and (type(duration) is not int or not MIN_TIME_MS <= duration <= MAX_TIME_MS):
        raise HTTPException(422, 'Le temps par position doit être un entier d’au moins 100 ms, représentable sans perte.')
    if duration is None and depth is None:
        raise HTTPException(422, 'Choisis une durée ou une profondeur pour analyser la partie.')
    return options


def _entry(conn, entry_id):
    if type(entry_id) is not int or entry_id <= 0:
        raise HTTPException(422, 'Identifiant de partie invalide.')
    row = conn.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone()
    if row is None:
        raise HTTPException(404, 'Partie introuvable.')
    return row


def game_snapshot(pgn):
    try:
        game = pgnlib.load_game(pgn)
    except ValueError as exc:
        raise HTTPException(422, 'Le PGN ne peut pas être analysé.') from exc
    moves = list(game.mainline_moves())
    if len(moves) > MAX_PLIES:
        raise HTTPException(422, 'L’analyse est limitée à 1 000 demi-coups par partie.')
    canonical = game.board().fen() + '\n' + ' '.join(move.uci() for move in moves)
    fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
    return game, moves, fingerprint


def _snapshot(entry_id):
    with get_conn() as conn:
        entry = dict(_entry(conn, entry_id))
    game, moves, fingerprint = game_snapshot(entry['pgn'])
    return entry, game, moves, fingerprint


def _site_identity(value):
    """Recognize an exact provider name/host without following PGN links."""
    value = str(value or '').strip().lower()
    labels = {'chess.com': 'chesscom', 'www.chess.com': 'chesscom',
              'lichess': 'lichess', 'lichess.org': 'lichess', 'www.lichess.org': 'lichess'}
    if value in labels:
        return labels[value]
    try:
        parts = urlsplit(value)
    except ValueError:
        return None
    if parts.scheme not in ('http', 'https') or parts.username or parts.password:
        return None
    return labels.get(parts.netloc)


def user_side(conn, entry_id, headers):
    """Use connected chess identities, never a local login or the opponent's site.

    Imported identity remains useful after the PGN's Site/Link is edited. A
    disabled connection is still the user's account; only synchronization is
    disabled. Unknown sites or matches for both players require a manual choice.
    """
    sites = {row['site'] for row in conn.execute(
        'SELECT DISTINCT site FROM sync_imports WHERE entry_id=?', (entry_id,))}
    if not sites:
        sites = {_site_identity(headers.get(key)) for key in ('Site', 'Link')}
        sites.discard(None)
    if len(sites) != 1:
        return None
    names = {row['username'].strip().casefold() for row in conn.execute(
        'SELECT username FROM sync_accounts WHERE site=?', (next(iter(sites)),))}
    matches = [side for side in ('white', 'black')
               if headers.get(side.title(), '').strip().casefold() in names]
    return matches[0] if len(matches) == 1 else None


def queue_analysis(entry_id, options=None):
    import jobs
    options = options_of({} if options is None else options)
    _, _, _, fingerprint = _snapshot(entry_id)
    if not engine.status()['available']:
        raise HTTPException(503, 'Le moteur d’analyse est indisponible.')
    return jobs.enqueue('analyse', {'entry_id': entry_id, 'fingerprint': fingerprint,
                                   'engine_identity': _engine_identity(), **options},
                        dedupe_key=f'analyse:{entry_id}')


def _engine_identity():
    return engine.binary_identity(engine.binary_path())


def _ensure_engine(options):
    expected = options.get('engine_identity')
    if expected is not None and _engine_identity() != expected:
        raise HTTPException(409, 'Le moteur a changé. Relance l’analyse de cette partie.')


def _settings_key(options):
    return json.dumps(options, sort_keys=True, separators=(',', ':'))


def _ensure_current(conn, entry_id, fingerprint, known_pgn=None):
    pgn = _entry(conn, entry_id)['pgn']
    # Most checkpoints see the identical document. Do not reparse a potentially
    # large annotated tree once per move; changed content is still checked fully.
    if known_pgn is not None and pgn == known_pgn:
        return pgn
    _, _, current = game_snapshot(pgn)
    if current != fingerprint:
        raise HTTPException(409, 'La ligne principale a changé. Relance l’analyse de cette partie.')
    return pgn


def _report_matches(row, fingerprint, settings):
    return row is not None and row['fingerprint'] == fingerprint and row['settings'] == settings


def _start_report(entry_id, fingerprint, options, known_pgn=None):
    settings = _settings_key(options)
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        _ensure_current(conn, entry_id, fingerprint, known_pgn)
        report = conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone()
        # Interrupted/cancelled runs resume their checkpoints. An explicit new run
        # of a completed report recalculates, even at the same requested settings.
        reuse = _report_matches(report, fingerprint, settings) and report['status'] != 'done'
        provenance = report['provenance'] if reuse else _settings_key(analysis_provenance(options))
        if not reuse:
            conn.execute('DELETE FROM game_analysis_reports WHERE entry_id=?', (entry_id,))
            conn.execute('''INSERT INTO game_analysis_reports
                (entry_id,fingerprint,settings,status,created_at,updated_at,provenance)
                VALUES(?,?,?,'running',?,?,?)''',
                (entry_id, fingerprint, settings, stamp(), stamp(), provenance))
        else:
            conn.execute("UPDATE game_analysis_reports SET status='running',error=NULL,updated_at=? WHERE entry_id=?",
                         (stamp(), entry_id))
        positions = {row['ply']: json.loads(row['evaluation']) for row in conn.execute(
            'SELECT ply,evaluation FROM game_analysis_positions WHERE entry_id=? ORDER BY ply', (entry_id,))}
    return positions, provenance


def _checkpoint(entry_id, fingerprint, options, ply, fen, evaluation, known_pgn=None):
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        _ensure_engine(options)
        current_pgn = _ensure_current(conn, entry_id, fingerprint, known_pgn)
        report = conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone()
        if not _report_matches(report, fingerprint, _settings_key(options)):
            raise HTTPException(409, 'Une autre analyse a remplacé ce calcul.')
        conn.execute('''INSERT INTO game_analysis_positions(entry_id,ply,fen,evaluation) VALUES(?,?,?,?)
            ON CONFLICT(entry_id,ply) DO UPDATE SET fen=excluded.fen,evaluation=excluded.evaluation''',
            (entry_id, ply, fen, json.dumps(evaluation)))
        conn.execute('UPDATE game_analysis_reports SET updated_at=? WHERE entry_id=?', (stamp(), entry_id))
    return current_pgn


def _finish(entry_id, fingerprint, options, status, error=None, known_pgn=None):
    with get_conn() as conn:
        if status == 'done':
            conn.execute('BEGIN IMMEDIATE')
            _ensure_engine(options)
            _ensure_current(conn, entry_id, fingerprint, known_pgn)
        conn.execute('''UPDATE game_analysis_reports SET status=?,error=?,updated_at=?
            WHERE entry_id=? AND fingerprint=? AND settings=?''',
            (status, error, stamp(), entry_id, fingerprint, _settings_key(options)))


def _legal_pv(board, pv):
    replay, ucis, sans = board.copy(), [], []
    if not isinstance(pv, list):
        return ucis, sans
    for token in pv[:MAX_PV]:
        try:
            move = chess.Move.from_uci(token) if isinstance(token, str) else None
        except ValueError:
            break
        if move is None or move not in replay.legal_moves or replay.is_game_over():
            break
        sans.append(replay.san(move))
        ucis.append(move.uci())
        replay.push(move)
    return ucis, sans


def evaluate_position(board, options, cancel=None):
    _ensure_engine(options)
    # Automatic draws need the entire move stack. A merely claimable draw is not
    # forced: a player may choose to keep playing a winning position.
    outcome = board.outcome(claim_draw=False)
    if outcome:
        winner = None if outcome.winner is None else ('white' if outcome.winner else 'black')
        return {'cp': 0 if winner is None else None, 'mate': 0 if winner else None,
                'winner': winner, 'depth': None, 'terminal': True, 'result': outcome.result(),
                'pv': [], 'pv_san': [], 'best_uci': None, 'best_san': None,
                'provenance': {'evaluation_version': EVALUATION_VERSION, 'method': 'rules'}}
    identity = options.get('engine_identity')
    guard = {'expected_identity': identity} if identity is not None else {}
    result = engine._run(board.copy(), options['time_ms'], multipv=1,
                         depth=options['depth'], cancel=cancel, background=True, **guard)
    _ensure_engine(options)
    lines = result.get('lines') or []
    if not lines:
        raise HTTPException(503, 'Le moteur n’a pas fourni d’évaluation exploitable.')
    line = lines[0]
    cp, mate = line.get('cp'), line.get('mate')
    if not ((type(cp) is int and mate is None) or (type(mate) is int and mate != 0 and cp is None)):
        raise HTTPException(503, 'Le moteur n’a pas fourni d’évaluation exploitable.')
    pv, sans = _legal_pv(board, line.get('pv'))
    if not pv:
        raise HTTPException(503, 'Le moteur n’a pas fourni de variante légale.')
    depth = line.get('depth')
    return {'cp': cp, 'mate': mate, 'depth': depth if type(depth) is int and depth >= 0 else None,
            'engine_identity': identity, 'engine_name': result.get('engine', 'Moteur UCI'),
            'provenance': {**analysis_provenance(options), 'method': 'engine'},
            'winner': ('white' if mate > 0 else 'black') if mate is not None else None,
            'terminal': False, 'pv': pv, 'pv_san': sans, 'best_uci': pv[0], 'best_san': sans[0]}


def _mate_sign(evaluation):
    if evaluation.get('mate') is None:
        return None
    winner = evaluation.get('winner')
    if winner in ('white', 'black'):
        return 1 if winner == 'white' else -1
    mate = evaluation.get('mate')
    return (1 if mate > 0 else -1) if type(mate) is int and mate != 0 else None


def winning_chances(evaluation, side):
    """Lichess-inspired indicative score, not a personalized win prediction.

    Mapping documented at https://lichess.org/page/accuracy. This is not an
    accuracy/Elo metric. Mate transitions are classified separately below.
    """
    sign = 1 if side == 'white' else -1
    mate = _mate_sign(evaluation)
    if mate is not None:
        return 100.0 if mate == sign else 0.0
    cp = evaluation.get('cp')
    if type(cp) not in (int, float) or not math.isfinite(cp):
        raise HTTPException(503, 'Évaluation inutilisable pour comparer les coups.')
    exponent = max(-60, min(60, -.00368208 * cp * sign))
    return 100 / (1 + math.exp(exponent))


def classify(before, after, side, played_uci):
    """Contextual loss from the mover's side; mates are never fake centipawns."""
    if before.get('best_uci') == played_uci:
        return None
    sign = 1 if side == 'white' else -1
    before_mate, after_mate = _mate_sign(before), _mate_sign(after)
    before_chance, after_chance = winning_chances(before, side), winning_chances(after, side)
    loss_win = max(0, before_chance - after_chance)
    extra = {'loss_win_pct': round(loss_win, 3)}
    if before_mate is not None or after_mate is not None:
        if before_mate == after_mate or after_mate == sign or before_mate == -sign:
            return None
        # Lichess Advice.scala treats gaining/losing a forced mate separately
        # from centipawn loss. A large surviving advantage (or an already lost
        # position) reduces the severity, without inventing a numeric mate loss.
        # https://github.com/lichess-org/lila/blob/master/modules/tree/src/main/Advice.scala
        lost_win = before_mate == sign and (after.get('cp') is None or after['cp'] * sign < 100)
        theme = 'missed_mate' if before_mate == sign else 'defense'
        if before_mate == sign:
            remaining_advantage = (after.get('cp') or 0) * sign
            kind = ('inaccuracy' if remaining_advantage > 999 else
                    'mistake' if remaining_advantage > 700 else 'blunder')
        else:
            previous_advantage = before['cp'] * sign
            kind = ('inaccuracy' if previous_advantage < -999 else
                    'mistake' if previous_advantage < -700 else 'blunder')
        return {'kind': kind,
                'loss_cp': None, 'mate_change': True, 'missed_opportunity': bool(lost_win),
                'missed_mate': before_mate == sign, 'theme': theme,
                'explanation': ('Un mat forcé était disponible avant ce coup et ne l’est plus dans l’analyse.'
                    if theme == 'missed_mate' else 'Ce coup permet à l’adversaire un mat forcé selon l’analyse.'), **extra}
    loss = max(0, (before['cp'] - after['cp']) * sign)
    # Lichess's 0.1/0.2/0.3 cutoffs use a [-1, +1] scale, equivalent to
    # 5/10/15 percentage points on the [0, 100] scale used here.
    if loss_win < 5:
        return None
    missed = before['cp'] * sign >= 200 and after['cp'] * sign < 100
    theme = ('lost_advantage' if missed else 'defense' if before_chance <= 55 and after_chance < 40
             else 'conversion' if before_chance >= 85 and after_chance >= 70 else 'evaluation_loss')
    explanations = {
        'lost_advantage': 'L’avantage disponible avant ce coup est fortement réduit ou perdu.',
        'defense': 'La position devient plus difficile à défendre selon le moteur.',
        'conversion': 'La position reste favorable, mais la conversion devient moins sûre.',
        'evaluation_loss': 'Ce coup dégrade l’évaluation de la position selon le moteur.',
    }
    return {'kind': 'blunder' if loss_win >= 15 else 'mistake' if loss_win >= 10 else 'inaccuracy',
            'loss_cp': loss, 'mate_change': False, 'missed_mate': False,
            'missed_opportunity': missed, 'theme': theme, 'explanation': explanations[theme], **extra}


def build_report(game, moves, evaluations, options, provenance=None):
    board = game.board()
    nodes = list(game.mainline())
    positions, findings = [], []
    for ply in range(len(moves) + 1):
        value = evaluations.get(ply)
        if value is not None:
            positions.append({'ply': ply, 'path': '.'.join(['0'] * ply), 'fen': board.fen(), **value})
        if ply == len(moves):
            break
        move = moves[ply]
        before_fen, side, san = board.fen(), 'white' if board.turn else 'black', board.san(move)
        before = evaluations.get(ply)
        board.push(move)
        after = evaluations.get(ply + 1)
        if before is None or after is None:
            continue
        finding = classify(before, after, side, move.uci())
        if finding:
            # A concrete opponent error immediately before this decision can
            # turn a lost advantage into a missed chance. No tactical cause is
            # inferred from a score or from the player's thinking time alone.
            previous = evaluations.get(ply - 1)
            if (previous is not None and not finding['missed_mate']
                    and winning_chances(before, side) - winning_chances(previous, side) >= 10
                    and finding['missed_opportunity']):
                finding['theme'] = 'missed_chance'
                finding['explanation'] = 'Le coup précédent offrait une occasion favorable qui n’a pas été conservée.'
            findings.append({'ply': ply + 1, 'path': '.'.join(['0'] * (ply + 1)),
                'before_path': '.'.join(['0'] * ply), 'fen': before_fen, 'after_fen': board.fen(),
                'san': san, 'uci': move.uci(), 'side': side, 'before': before, 'after': after,
                'best_uci': before.get('best_uci'), 'best_san': before.get('best_san'),
                'pv': before.get('pv', []), 'pv_san': before.get('pv_san', []),
                'clock': nodes[ply].clock(), 'elapsed': pgnlib._elapsed(nodes[ply], game),
                'verified': bool(before.get('verified') and after.get('verified')),
                'exercise_ids': [], **finding})
    summary = {'moves': len(moves), 'total_positions': len(moves) + 1,
               'analysed_positions': len(positions),
               'settings': {key: options[key] for key in DEFAULT_OPTIONS if key in options},
               'engine_identity': options.get('engine_identity'),
               'engine_name': next((value.get('engine_name') for value in evaluations.values() if value.get('engine_name')), None),
               'provenance': report_provenance(provenance),
               'quality': QUALITY,
               'inaccuracies': sum(x['kind'] == 'inaccuracy' for x in findings),
               'mistakes': sum(x['kind'] == 'mistake' for x in findings),
               'blunders': sum(x['kind'] == 'blunder' for x in findings),
               'missed_opportunities': sum(x['missed_opportunity'] for x in findings),
               'chance_method': CHANCE_METHOD}
    def priority(items):
        return [item['ply'] for item in sorted(items, key=lambda item:
            (-item['loss_win_pct'], not item['missed_mate'], item['ply']))]
    summary['priority_plies'] = priority(findings)
    summary['by_side'] = {side: {
        'moves': (len(moves) + int(game.board().turn == (side == 'white'))) // 2,
        'inaccuracies': sum(x['side'] == side and x['kind'] == 'inaccuracy' for x in findings),
        'mistakes': sum(x['side'] == side and x['kind'] == 'mistake' for x in findings),
        'blunders': sum(x['side'] == side and x['kind'] == 'blunder' for x in findings),
        'missed_opportunities': sum(x['side'] == side and x['missed_opportunity'] for x in findings),
        'verified': sum(x['side'] == side and x['verified'] for x in findings),
        'priority_plies': priority([x for x in findings if x['side'] == side]),
    } for side in ('white', 'black')}
    return {'summary': summary, 'positions': positions, 'findings': findings}


def analyse_game(ctx, payload):
    entry_id = payload.get('entry_id')
    options = options_of({key: payload[key] for key in DEFAULT_OPTIONS if key in payload})
    entry, game, moves, fingerprint = _snapshot(entry_id)
    if payload.get('fingerprint') not in (None, fingerprint):
        raise HTTPException(409, 'La partie a changé depuis sa mise en attente. Relance son analyse.')
    ctx.check_cancelled()
    options['engine_identity'] = payload.get('engine_identity') or _engine_identity()
    _ensure_engine(options)
    known_pgn = entry['pgn']
    evaluations, provenance = _start_report(entry_id, fingerprint, options, known_pgn)
    board = game.board()
    try:
        for ply in range(len(moves) + 1):
            ctx.check_cancelled()
            _ensure_engine(options)
            if ply not in evaluations:
                evaluation = evaluate_position(board, options, ctx.cancel_event)
                ctx.check_cancelled()
                known_pgn = _checkpoint(entry_id, fingerprint, options, ply, board.fen(), evaluation, known_pgn)
                evaluations[ply] = evaluation
            ctx.progress(ply + 1, len(moves) + 1, f'Analyse : {ply + 1}/{len(moves) + 1} positions')
            if ply < len(moves):
                board.push(moves[ply])
        _finish(entry_id, fingerprint, options, 'done', known_pgn=known_pgn)
        return build_report(game, moves, evaluations, options, provenance)['summary']
    except BaseException as exc:
        cancelled = ctx.cancel_event.is_set() or isinstance(exc, engine.AnalysisCancelled)
        message = str(exc.detail) if isinstance(exc, HTTPException) else 'Le calcul a été interrompu.'
        _finish(entry_id, fingerprint, options, 'cancelled' if cancelled else 'error', message)
        raise


@router.get('/{entry_id}')
def get_analysis(entry_id: int):
    import jobs
    with get_conn() as conn:
        # A replacement analysis can atomically change its settings and all
        # positions. Read the PGN, metadata and evaluations from one WAL snapshot
        # so a response never combines one game/version with another's scores.
        conn.execute('BEGIN')
        pgn = _entry(conn, entry_id)['pgn']
        game, moves, fingerprint = game_snapshot(pgn)
        own_side = user_side(conn, entry_id, game.headers)
        report = conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone()
        evaluations = {row['ply']: json.loads(row['evaluation']) for row in conn.execute(
            'SELECT ply,evaluation FROM game_analysis_positions WHERE entry_id=? ORDER BY ply', (entry_id,))}
        exercises = {}
        for item in conn.execute('''SELECT ply,exercise_entry_id FROM game_analysis_exercises
                WHERE source_entry_id=? AND source_fingerprint=? ORDER BY exercise_entry_id''', (entry_id, fingerprint)):
            exercises.setdefault(item['ply'], []).append(item['exercise_entry_id'])
    job = jobs.latest_for('analyse', {'entry_id': entry_id})
    active = job and job['status'] in ('queued', 'running')
    if report is None:
        return {'status': job['status'] if job else 'none', 'job': job, 'user_side': own_side, 'fingerprint': fingerprint,
                'summary': None, 'positions': [], 'findings': []}
    if report['fingerprint'] != fingerprint:
        return {'status': 'stale', 'job': job, 'user_side': own_side, 'fingerprint': fingerprint, 'summary': None, 'positions': [], 'findings': [],
                'message': 'La ligne principale a changé. Relance l’analyse.'}
    status = job['status'] if active else report['status']
    if status == 'running' and job and job['status'] in ('error', 'cancelled'):
        status = job['status']
    result = build_report(game, moves, evaluations, json.loads(report['settings']), report['provenance'])
    for finding in result['findings']:
        finding['exercise_ids'] = exercises.get(finding['ply'], [])
    return {'status': status, 'job': job, 'user_side': own_side, 'fingerprint': fingerprint, 'message': report['error'],
            'updated_at': report['updated_at'], **result}


@router.post('/{entry_id}')
def request_analysis(entry_id: int, payload: dict):
    return {'job': queue_analysis(entry_id, payload)}


@contextmanager
def _action_budget():
    """One short verification/retry at a time; engine queue waits are cancellable."""
    if not _ACTION_LOCK.acquire(blocking=False):
        raise HTTPException(503, 'Une vérification est déjà en cours. Réessaie dans un instant.')
    cancel = threading.Event()
    timer = threading.Timer(ACTION_SECONDS, cancel.set)
    timer.daemon = True
    timer.start()
    try:
        yield cancel
        if cancel.is_set():
            raise HTTPException(503, 'La vérification a dépassé le temps disponible. Réessaie.')
    except engine.AnalysisCancelled as exc:
        raise HTTPException(503, 'La vérification a dépassé le temps disponible. Réessaie.') from exc
    finally:
        timer.cancel()
        _ACTION_LOCK.release()


def _action_snapshot(entry_id, payload, allowed):
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise HTTPException(422, 'Options de vérification invalides.')
    ply, fingerprint = payload.get('ply'), payload.get('fingerprint')
    if type(ply) is not int or ply < 1 or not isinstance(fingerprint, str) or len(fingerprint) != 64:
        raise HTTPException(422, 'Choisis un coup et la version actuelle de la partie.')
    with get_conn() as conn:
        conn.execute('BEGIN')
        entry = dict(_entry(conn, entry_id))
        game, moves, current = game_snapshot(entry['pgn'])
        if fingerprint != current:
            raise HTTPException(409, 'La ligne principale a changé. Actualise le bilan.')
        if ply > len(moves):
            raise HTTPException(422, 'Ce coup n’existe pas dans la partie.')
        row = conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone()
        if row is None or row['fingerprint'] != current:
            raise HTTPException(409, 'Analyse d’abord la version actuelle de cette partie.')
        if row['status'] == 'running':
            raise HTTPException(409, 'Attends la fin de l’analyse en cours avant de vérifier ce coup.')
        report = dict(row)
        report_options = json.loads(report['settings'])
        if not report_options.get('engine_identity'):
            raise HTTPException(409, 'Relance ce bilan pour identifier son moteur avant de vérifier un coup.')
        _ensure_engine(report_options)
        evaluations = [tuple(item) for item in conn.execute('''SELECT ply,fen,evaluation
            FROM game_analysis_positions WHERE entry_id=? ORDER BY ply''', (entry_id,))]
    board = game.board()
    for move in moves[:ply - 1]:
        board.push(move)
    return {'entry_id': entry_id, 'ply': ply, 'fingerprint': current, 'entry': entry,
            'report': report, 'evaluations': evaluations, 'board': board, 'move': moves[ply - 1],
            'verification_options': {**VERIFY_OPTIONS, 'engine_identity': report_options['engine_identity']}}


def _action_current(conn, snapshot):
    _ensure_engine(snapshot['verification_options'])
    _ensure_current(conn, snapshot['entry_id'], snapshot['fingerprint'], snapshot['entry']['pgn'])
    report = conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (snapshot['entry_id'],)).fetchone()
    evaluations = [tuple(item) for item in conn.execute('''SELECT ply,fen,evaluation
        FROM game_analysis_positions WHERE entry_id=? ORDER BY ply''', (snapshot['entry_id'],))]
    if report is None or dict(report) != snapshot['report'] or evaluations != snapshot['evaluations']:
        raise HTTPException(409, 'Le bilan a changé pendant la vérification. Actualise-le et réessaie.')


@router.post('/{entry_id}/verify')
def verify_finding(entry_id: int, payload: dict):
    with _action_budget() as cancel:
        snapshot = _action_snapshot(entry_id, payload, {'ply', 'fingerprint'})
        board = snapshot['board']
        before = evaluate_position(board, snapshot['verification_options'], cancel)
        after_board = board.copy()
        after_board.push(snapshot['move'])
        after = evaluate_position(after_board, snapshot['verification_options'], cancel)
        if cancel.is_set():
            raise engine.AnalysisCancelled()
        verified_at = stamp()
        with get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            _action_current(conn, snapshot)
            if cancel.is_set():
                raise engine.AnalysisCancelled()
            for ply, position, value in ((snapshot['ply'] - 1, board, before),
                                         (snapshot['ply'], after_board, after)):
                value = {**value, 'verified': True, 'verified_at': verified_at,
                         'verification_settings': dict(snapshot['verification_options'])}
                conn.execute('''INSERT INTO game_analysis_positions(entry_id,ply,fen,evaluation) VALUES(?,?,?,?)
                    ON CONFLICT(entry_id,ply) DO UPDATE SET fen=excluded.fen,evaluation=excluded.evaluation''',
                    (entry_id, ply, position.fen(), json.dumps(value)))
            conn.execute('UPDATE game_analysis_reports SET updated_at=? WHERE entry_id=?', (verified_at, entry_id))
            if cancel.is_set():
                raise engine.AnalysisCancelled()
    return {'verified': True, 'ply': snapshot['ply'], 'fingerprint': snapshot['fingerprint'],
            'report': get_analysis(entry_id)}


@router.post('/{entry_id}/retry')
def retry_finding(entry_id: int, payload: dict):
    with _action_budget() as cancel:
        snapshot = _action_snapshot(entry_id, payload, {'ply', 'fingerprint', 'uci', 'reveal'})
        if type(payload.get('reveal', False)) is not bool:
            raise HTTPException(422, 'Le choix d’afficher la solution doit être vrai ou faux.')
        board = snapshot['board']
        try:
            if not isinstance(payload.get('uci'), str):
                raise ValueError('missing move')
            move = board.parse_uci(payload['uci'])
            if not move or move not in board.legal_moves:
                raise ValueError('illegal move')
        except ValueError as exc:
            raise HTTPException(422, 'Joue un coup légal depuis la position proposée.') from exc
        san = board.san(move)
        before = evaluate_position(board, snapshot['verification_options'], cancel)
        after_board = board.copy()
        after_board.push(move)
        after = evaluate_position(after_board, snapshot['verification_options'], cancel)
        if cancel.is_set():
            raise engine.AnalysisCancelled()
        side = 'white' if board.turn else 'black'
        sign = 1 if board.turn else -1
        loss = max(0, winning_chances(before, side) - winning_chances(after, side))
        before_mate, after_mate = _mate_sign(before), _mate_sign(after)
        preserves_mate = before_mate != sign or after_mate == sign
        avoids_new_mate = after_mate != -sign or before_mate == -sign
        accepted = (move.uci() == before.get('best_uci') or
                    (loss <= RETRY_TOLERANCE and preserves_mate and avoids_new_mate))
        with get_conn() as conn:
            conn.execute('BEGIN')
            _action_current(conn, snapshot)
        result = {'accepted': accepted, 'ply': snapshot['ply'], 'uci': move.uci(), 'san': san,
                  'fingerprint': snapshot['fingerprint'], 'loss_win_pct': round(loss, 3), 'verified': True}
        if payload.get('reveal'):
            result.update(best_uci=before.get('best_uci'), best_san=before.get('best_san'),
                          before=before, after=after, pv=before.get('pv', []), pv_san=before.get('pv_san', []))
    return result


@router.post('/{entry_id}/exercise')
def create_exercise(entry_id: int, payload: dict):
    if not isinstance(payload, dict) or set(payload) - {'ply', 'base_id', 'title', 'comment', 'plies', 'pgn', 'fingerprint'}:
        raise HTTPException(422, 'Options d’exercice invalides.')
    ply, base_id = payload.get('ply'), payload.get('base_id')
    if type(ply) is not int or ply < 1 or type(base_id) is not int or base_id < 1:
        raise HTTPException(422, 'Choisis un coup analysé et une base de destination.')
    plies = payload.get('plies', 1)
    if type(plies) is not int or not 1 <= plies <= MAX_PV:
        raise HTTPException(422, 'La solution doit contenir entre 1 et 32 demi-coups.')
    title, comment = payload.get('title', ''), payload.get('comment', '')
    if not isinstance(title, str) or len(title) > 200 or not isinstance(comment, str) or len(comment) > 4000:
        raise HTTPException(422, 'Le titre est limité à 200 caractères et le commentaire à 4 000.')
    if '{' in comment or '}' in comment:
        raise HTTPException(422, 'Évite les accolades dans le commentaire PGN.')
    manual = 'pgn' in payload
    exercise = None
    if manual:
        if not isinstance(payload.get('fingerprint'), str) or len(payload['fingerprint']) != 64:
            raise HTTPException(422, 'La version de la partie source est requise pour cet exercice.')
        try:
            exercise = pgnlib.load_game(payload['pgn'])
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, 'La solution PGN de l’exercice est invalide.') from exc
        if not exercise.variations or not exercise.variations[0].move:
            raise HTTPException(422, 'Ajoute au moins un coup légal à la solution de cet exercice.')
        if sum(1 for _ in pgnlib.walk_nodes(exercise)) > 5000:
            raise HTTPException(422, 'La solution de cet exercice est limitée à 5 000 positions.')
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        source = _entry(conn, entry_id)
        game, moves, fingerprint = game_snapshot(source['pgn'])
        if 'fingerprint' in payload and payload['fingerprint'] != fingerprint:
            raise HTTPException(409, 'La ligne principale a changé. Actualise le bilan avant de créer l’exercice.')
        if ply > len(moves):
            raise HTTPException(422, 'Ce coup n’existe pas dans la partie.')
        base = conn.execute('SELECT * FROM bases WHERE id=?', (base_id,)).fetchone()
        if base is None:
            raise HTTPException(404, 'Base de destination introuvable.')
        if conn.execute('SELECT 1 FROM reference_bases WHERE base_id=?', (base_id,)).fetchone():
            raise HTTPException(422, 'Choisis une base d’étude pour enregistrer cet exercice.')
        report = conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone()
        if report is None or report['fingerprint'] != fingerprint:
            raise HTTPException(409, 'Analyse d’abord la version actuelle de cette partie.')
        board = game.board()
        for move in moves[:ply - 1]:
            board.push(move)
        if manual and exercise.board().fen() != board.fen():
            raise HTTPException(422, 'La solution doit commencer exactement à la position avant le coup choisi.')
        existing = conn.execute('''SELECT exercise_entry_id FROM game_analysis_exercises
            WHERE source_entry_id=? AND source_fingerprint=? AND ply=? AND base_id=?''',
            (entry_id, fingerprint, ply, base_id)).fetchone()
        if existing:
            return {'entry_id': existing['exercise_entry_id'], 'base_id': base_id, 'duplicate': True}
        if not manual:
            row = conn.execute('SELECT evaluation FROM game_analysis_positions WHERE entry_id=? AND ply=?',
                               (entry_id, ply - 1)).fetchone()
            if row is None:
                raise HTTPException(409, 'Cette position n’est pas encore analysée.')
            before = json.loads(row['evaluation'])
            pv, _ = _legal_pv(board, before.get('pv'))
            if not pv:
                raise HTTPException(409, 'Cette position ne possède pas de solution exploitable.')
            exercise = chess.pgn.Game()
            exercise.setup(board)
            node = exercise
            for uci in pv[:plies]:
                node = node.add_main_variation(chess.Move.from_uci(uci))
        exercise.headers.update({'Event': 'Exercice issu de mes parties', 'Result': '*',
            'White': game.headers.get('White', '?'), 'Black': game.headers.get('Black', '?'),
            'Date': game.headers.get('Date', '????.??.??'), 'SourceEntry': str(entry_id),
            'SourcePly': str(ply), 'SourceFingerprint': fingerprint,
            'SourceWhite': game.headers.get('White', '?'), 'SourceBlack': game.headers.get('Black', '?'),
            'AnalysisEngine': before.get('engine_name', 'Moteur UCI') if not manual else 'Moteur UCI',
            'SolutionSource': 'manual' if manual else 'engine'})
        recorded_options = json.loads(report['settings'])
        for tag, key in (('AnalysisTimeMs', 'time_ms'), ('AnalysisDepth', 'depth')):
            if recorded_options.get(key) is not None:
                exercise.headers[tag] = str(recorded_options[key])
            else:
                exercise.headers.pop(tag, None)
        for key in ('Site', 'Link', 'WhiteElo', 'BlackElo', 'TimeControl'):
            if key in game.headers:
                exercise.headers[key] = game.headers[key]
        if not manual or 'comment' in payload:
            exercise.comment = comment.strip()
        # No original wrong-move branch: every PGN variation is accepted by the
        # training engine as a solution, so adding that branch would teach errors.
        pgn = pgnlib.export_game(exercise)
        pgnlib.load_game(pgn)
        title = title.strip() or f'{source["title"][:155]} · coup {board.fullmove_number}{"." if board.turn else "…"}'
        cursor = conn.execute('''INSERT INTO entries(base_id,title,pgn,selected,start_path,created_at,updated_at)
            VALUES(?,?,?,1,'',?,?)''', (base_id, title, pgn, stamp(), stamp()))
        new_id = cursor.lastrowid
        conn.execute('''INSERT INTO game_analysis_exercises
            (source_entry_id,source_fingerprint,ply,base_id,exercise_entry_id) VALUES(?,?,?,?,?)''',
            (entry_id, fingerprint, ply, base_id, new_id))
    return {'entry_id': new_id, 'base_id': base_id, 'duplicate': False}
