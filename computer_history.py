"""Account-owned computer-game history, separate from drafts and study PGNs.

All positions are replayed legally and all exported PGNs are generated here.
Copies are insert-only and deduplicated by game/destination; a later move,
clock checkpoint or takeback never rewrites a user's library document.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from datetime import datetime, timezone

import chess
import chess.pgn
from fastapi import HTTPException
from pydantic import ValidationError

import computer_api
import training_native
import pgnlib
from entry_service import title_for

MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024
MAX_MS = 31 * 24 * 3600 * 1000
GAME_ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,159}\Z')


def init_schema(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS computer_game_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        auto_copy INTEGER NOT NULL DEFAULT 0 CHECK(auto_copy IN (0,1)),
        base_id INTEGER REFERENCES bases(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS computer_games (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        id TEXT NOT NULL, revision INTEGER NOT NULL,
        snapshot TEXT NOT NULL, pgn TEXT NOT NULL,
        white TEXT NOT NULL, black TEXT NOT NULL,
        side TEXT NOT NULL, provider TEXT NOT NULL,
        result TEXT NOT NULL, reason TEXT, auto_copy_error TEXT,
        mutation_id TEXT, request_hash TEXT,
        ply_count INTEGER NOT NULL, time_control TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
        PRIMARY KEY(user_id,id)
    );
    CREATE INDEX IF NOT EXISTS computer_games_by_date
        ON computer_games(user_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS computer_game_copies (
        user_id INTEGER NOT NULL, game_id TEXT NOT NULL,
        base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
        entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(user_id,game_id,base_id),
        FOREIGN KEY(user_id,game_id) REFERENCES computer_games(user_id,id) ON DELETE CASCADE
    );
    ''')
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(computer_games)')}
    for column in ('auto_copy_error', 'mutation_id', 'request_hash'):
        if column not in columns:
            conn.execute(f'ALTER TABLE computer_games ADD COLUMN {column} TEXT')


def _now():
    return datetime.now(timezone.utc).isoformat()


def checked_id(value):
    if not isinstance(value, str) or not GAME_ID.fullmatch(value):
        raise HTTPException(422, 'Identifiant de partie invalide.')


def _revision(row, expected):
    if type(expected) is not int or not 0 <= expected < 9223372036854775807:
        raise HTTPException(422, 'Indique la révision de la partie à enregistrer.')
    actual = row['revision'] if row else 0
    if expected != actual:
        raise HTTPException(409, 'Cette partie a changé sur un autre appareil. Recharge son historique avant de la reprendre.')


def _base(conn, base_id):
    if type(base_id) is not int or not 1 <= base_id <= 9223372036854775807:
        raise HTTPException(422, 'Choisis une base de destination.')
    row = conn.execute('SELECT id,name FROM bases WHERE id=?', (base_id,)).fetchone()
    if row is None:
        raise HTTPException(404, 'La base de destination est introuvable.')
    if conn.execute('SELECT 1 FROM reference_bases WHERE base_id=?', (base_id,)).fetchone():
        raise HTTPException(422, 'Choisis une base personnelle, plutôt qu’une base de référence.')
    return row


def settings(conn, user_id):
    row = conn.execute('SELECT * FROM computer_game_settings WHERE user_id=?', (user_id,)).fetchone()
    return {'revision': row['revision'] if row else 0,
            'auto_copy': bool(row and row['auto_copy']), 'base_id': row['base_id'] if row else None,
            'bases': [dict(item) for item in conn.execute('''SELECT id,name FROM bases b
                WHERE NOT EXISTS(SELECT 1 FROM reference_bases r WHERE r.base_id=b.id)
                ORDER BY name COLLATE NOCASE,id''')]}


def update_settings(conn, user_id, payload):
    if not isinstance(payload, dict) or set(payload) - {'auto_copy', 'base_id', 'expected_revision'}:
        raise HTTPException(422, 'Réglages du mode ordinateur invalides.')
    row = conn.execute('SELECT * FROM computer_game_settings WHERE user_id=?', (user_id,)).fetchone()
    _revision(row, payload.get('expected_revision'))
    auto = payload.get('auto_copy', bool(row and row['auto_copy']))
    base_id = payload.get('base_id', row['base_id'] if row else None)
    if type(auto) is not bool:
        raise HTTPException(422, 'La copie automatique doit être activée ou désactivée.')
    if base_id is not None:
        _base(conn, base_id)
    if auto and base_id is None:
        raise HTTPException(422, 'Choisis une base pour activer la copie automatique.')
    revision = (row['revision'] if row else 0) + 1
    conn.execute('''INSERT INTO computer_game_settings(user_id,revision,auto_copy,base_id)
        VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,
        auto_copy=excluded.auto_copy,base_id=excluded.base_id''', (user_id, revision, int(auto), base_id))
    return settings(conn, user_id)


def _encoded(value):
    try:
        text = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False, sort_keys=True)
        if len(text.encode('utf-8')) > MAX_SNAPSHOT_BYTES:
            raise HTTPException(413, 'Cette partie dépasse la limite de 2 Mo.')
        return text
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise HTTPException(422, 'Les données de cette partie sont invalides.') from None


def _milliseconds(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= MAX_MS:
        raise HTTPException(422, 'La pendule contient une durée invalide.')
    return value


def _activity(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != {'version', 'elapsed_ms'} or type(value['version']) is not int or value['version'] != 1:
        raise HTTPException(422, 'Format de durée active inconnu.')
    elapsed = value['elapsed_ms']
    if isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or not math.isfinite(elapsed) or not 0 <= elapsed <= MAX_MS:
        raise HTTPException(422, 'La durée active de la partie est invalide.')
    return {'version': 1, 'elapsed_ms': elapsed}


def _remaining(value):
    if not isinstance(value, dict) or set(value) != {'white', 'black'}:
        raise HTTPException(422, 'Les temps des deux camps sont requis.')
    return {color: _milliseconds(value[color]) for color in ('white', 'black')}


def _clock(value, baseline, count):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get('version') != 1:
        raise HTTPException(422, 'Format de pendule inconnu.')
    initial, increment = _milliseconds(value.get('initial_ms')), _milliseconds(value.get('increment_ms'))
    if not initial or increment > 3600 * 1000:
        raise HTTPException(422, 'Cadence invalide.')
    if value.get('running') not in (None, 'white', 'black') or type(value.get('paused')) is not bool or value.get('expired') not in (None, 'white', 'black'):
        raise HTTPException(422, 'État de pendule invalide.')
    history = value.get('history', [])
    if not isinstance(history, list) or len(history) > 2001:
        raise HTTPException(422, 'Historique de pendule trop long.')
    records, last = [], -1
    for record in history:
        if not isinstance(record, dict) or type(record.get('ply')) is not int or not baseline <= record['ply'] <= count or record['ply'] <= last:
            raise HTTPException(422, 'Historique de pendule incohérent.')
        last = record['ply']
        records.append({'ply': last, 'remaining': _remaining(record.get('remaining'))})
    return {'version': 1, 'initial_ms': initial, 'increment_ms': increment,
            'remaining': _remaining(value.get('remaining')), 'running': value.get('running'),
            'paused': value['paused'], 'expired': value.get('expired'), 'history': records}


def canonical_snapshot(game_id, snapshot):
    checked_id(game_id)
    _encoded(snapshot)
    if not isinstance(snapshot, dict) or snapshot.get('version') != 1 or not isinstance(snapshot.get('session'), dict):
        raise HTTPException(422, 'La sauvegarde doit contenir une partie contre l’ordinateur.')
    value = copy.deepcopy(snapshot)
    session = value['session']
    if session.get('training_run_id') is not None:
        if not isinstance(session['training_run_id'], str) or not 8 <= len(session['training_run_id']) <= 160:
            raise HTTPException(422, 'Contexte d’entraînement invalide.')
    if session.get('id') != game_id:
        raise HTTPException(422, 'L’identifiant ne correspond pas à cette partie.')
    raw = session.get('position')
    if not isinstance(raw, dict):
        raise HTTPException(422, 'Position de la partie manquante.')
    try:
        request = computer_api.PositionState.model_validate({key: raw[key] for key in ('initial_fen', 'history', 'fen') if key in raw})
    except ValidationError:
        raise HTTPException(422, 'L’historique de la partie est invalide.') from None
    board = computer_api._replay(request)
    side = session.get('side')
    config = session.get('config')
    if side not in ('white', 'black') or not isinstance(config, dict) or config.get('provider') not in ('stockfish', 'maia'):
        raise HTTPException(422, 'Camp ou adversaire invalide.')
    baseline = session.get('baseline', 0)
    if type(baseline) is not int or not 0 <= baseline <= len(board.move_stack):
        raise HTTPException(422, 'Position de départ incohérente.')
    resigned = session.get('resigned', False)
    if type(resigned) is not bool:
        raise HTTPException(422, 'État de partie invalide.')
    timeout = session.get('timeout')
    if timeout not in (None, 'white', 'black'):
        raise HTTPException(422, 'Camp perdant au temps invalide.')
    clock = _clock(session.get('clock'), baseline, len(board.move_stack))
    if 'activity' in session:
        session['activity'] = _activity(session['activity'])
    position = computer_api._snapshot(board)
    if timeout is not None and not position['game_over']:
        if clock is None or clock['remaining'][timeout] != 0 or clock['expired'] != timeout:
            raise HTTPException(422, 'Une perte au temps exige une pendule écoulée.')
        position = computer_api.timeout_snapshot(board, timeout)
    elif resigned and not position['game_over']:
        result = '0-1' if side == 'white' else '1-0'
        position.update(game_over=True, result=result, reason='resignation', legal_moves=[])
        position['legalState'].update(game_over=True, result=result, moves=[])
    result = position['result']
    game = chess.pgn.Game.from_board(board)
    headers = session.get('headers', {})
    if not isinstance(headers, dict):
        raise HTTPException(422, 'Informations PGN invalides.')
    try:
        pgnlib.patch_headers(game, {key: val for key, val in headers.items() if key.casefold() not in ('fen', 'setup', 'variant')})
    except (ValueError, AttributeError):
        raise HTTPException(422, 'Informations PGN invalides.') from None
    game.headers['Result'] = result
    game.headers['TimeControl'] = (str(int(clock['initial_ms'] / 1000)) + '+' + str(int(clock['increment_ms'] / 1000))) if clock else '-'
    game.headers['Termination'] = 'time forfeit' if position['reason'] == 'timeout' else 'normal' if result != '*' else 'unterminated'
    if clock:
        ticks = {item['ply']: item['remaining'] for item in clock['history']}
        for ply, node in enumerate(game.mainline(), 1):
            if ply in ticks and ply > baseline:
                color = 'white' if node.parent.board().turn else 'black'
                node.set_clock(ticks[ply][color] / 1000)
        if position['game_over']:
            clock['running'] = None
            clock['paused'] = True
    session['position'] = position
    session['clock'] = clock
    session['resigned'] = position['reason'] == 'resignation'
    session['timeout'] = timeout if position['reason'] == 'timeout' else None
    session['headers'] = dict(game.headers)
    session['baseline'] = baseline
    position['doc'] = pgnlib.game_payload(game)
    value['pendingMove'] = None if position['game_over'] else value.get('pendingMove')
    return value, pgnlib.export_game(game)


def _copies(conn, user_id, game_id):
    return [dict(row) for row in conn.execute('''SELECT c.base_id,c.entry_id,b.name AS base_name
        FROM computer_game_copies c JOIN bases b ON b.id=c.base_id
        WHERE c.user_id=? AND c.game_id=? ORDER BY c.created_at,c.base_id''', (user_id, game_id))]


def _row(conn, user_id, game_id):
    checked_id(game_id)
    row = conn.execute('SELECT * FROM computer_games WHERE user_id=? AND id=?', (user_id, game_id)).fetchone()
    if row is None:
        raise HTTPException(404, 'Cette partie contre l’ordinateur est introuvable.')
    return row


def document(conn, row):
    return {'id': row['id'], 'revision': row['revision'], 'snapshot': json.loads(row['snapshot']),
            'pgn': row['pgn'], 'created_at': row['created_at'], 'updated_at': row['updated_at'],
            'finished_at': row['finished_at'], 'result': row['result'], 'reason': row['reason'],
            'copies': _copies(conn, row['user_id'], row['id']), 'auto_copy_error': row['auto_copy_error']}


def read(conn, user_id, game_id):
    return document(conn, _row(conn, user_id, game_id))


def list_games(conn, user_id, *, offset=0, limit=50):
    rows = conn.execute('''SELECT * FROM computer_games WHERE user_id=?
        ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?''', (user_id, limit, offset)).fetchall()
    items = []
    for row in rows:
        snapshot = json.loads(row['snapshot'])
        clock = snapshot['session'].get('clock')
        items.append({key: row[key] for key in ('id', 'revision', 'white', 'black', 'result', 'reason',
            'side', 'provider', 'ply_count', 'time_control', 'created_at', 'updated_at', 'finished_at', 'auto_copy_error')})
        items[-1].update(finished=row['result'] != '*', moves=(row['ply_count'] + 1) // 2,
            clock={key: clock[key] for key in ('initial_ms', 'increment_ms', 'remaining', 'paused')} if clock else None,
            copies=_copies(conn, user_id, row['id']))
    total = conn.execute('SELECT count(*) FROM computer_games WHERE user_id=?', (user_id,)).fetchone()[0]
    return {'items': items, 'total': total, 'offset': offset, 'limit': limit}


def copy_game(conn, user_id, game_id, base_id, *, automatic=False):
    row = _row(conn, user_id, game_id)
    _base(conn, base_id)
    existing = conn.execute('''SELECT entry_id FROM computer_game_copies
        WHERE user_id=? AND game_id=? AND base_id=?''', (user_id, game_id, base_id)).fetchone()
    # A moved or manually edited copy still belongs to this original operation.
    # A deleted copy is a deliberate user action, not an invitation to auto-recreate.
    if existing:
        if existing['entry_id'] is not None or automatic:
            return {'base_id': base_id, 'entry_id': existing['entry_id'], 'created': False}
        conn.execute('DELETE FROM computer_game_copies WHERE user_id=? AND game_id=? AND base_id=?',
                     (user_id, game_id, base_id))
    stamp = _now()
    game = pgnlib.load_game(row['pgn'])
    entry = conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
        VALUES(?,?,?,?,?)''', (base_id, title_for(game), row['pgn'], stamp, stamp)).lastrowid
    conn.execute('''INSERT INTO computer_game_copies(user_id,game_id,base_id,entry_id,created_at)
        VALUES(?,?,?,?,?)''', (user_id, game_id, base_id, entry, stamp))
    return {'base_id': base_id, 'entry_id': entry, 'created': True}


def prepare_write(game_id, snapshot, mutation_id=None):
    """Perform replay and PGN generation before taking SQLite's write lock."""
    if mutation_id is not None:
        checked_id(mutation_id)
    request_hash = hashlib.sha256(_encoded(snapshot).encode('utf-8')).hexdigest()
    value, pgn = canonical_snapshot(game_id, snapshot)
    return value, pgn, _encoded(value), request_hash


def write(conn, user_id, game_id, snapshot, expected_revision, mutation_id=None, *, prepared=None):
    value, pgn, encoded, request_hash = prepared or prepare_write(game_id, snapshot, mutation_id)
    row = conn.execute('SELECT * FROM computer_games WHERE user_id=? AND id=?', (user_id, game_id)).fetchone()
    if mutation_id is not None and row is not None and row['mutation_id'] == mutation_id:
        if row['request_hash'] != request_hash:
            raise HTTPException(409, 'Cet enregistrement a déjà été utilisé pour une autre version de la partie.')
        return document(conn, row)
    # Retrying the exact same normalized snapshot after a lost response is safe.
    identical = row is not None and row['snapshot'] == encoded
    if not identical:
        _revision(row, expected_revision)
    else:
        if type(expected_revision) is not int or expected_revision not in (row['revision'], row['revision'] - 1):
            _revision(row, expected_revision)
    position, session = value['session']['position'], value['session']
    stamp = _now()
    if not identical:
        revision = (row['revision'] if row else 0) + 1
        created_at = row['created_at'] if row else stamp
        finished_at = (row['finished_at'] if row and row['finished_at'] else stamp) if position['game_over'] else None
        conn.execute('''INSERT INTO computer_games
            (user_id,id,revision,snapshot,pgn,white,black,side,provider,result,reason,ply_count,time_control,created_at,updated_at,finished_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET
            revision=excluded.revision,snapshot=excluded.snapshot,pgn=excluded.pgn,
            white=excluded.white,black=excluded.black,side=excluded.side,provider=excluded.provider,
            result=excluded.result,reason=excluded.reason,ply_count=excluded.ply_count,
            time_control=excluded.time_control,updated_at=excluded.updated_at,finished_at=excluded.finished_at''',
            (user_id, game_id, revision, encoded, pgn, session['headers'].get('White', '?'),
             session['headers'].get('Black', '?'), session['side'], session['config']['provider'],
             position['result'], position['reason'], len(position['history']), session['headers']['TimeControl'],
             created_at, stamp, finished_at))
    auto_error = None
    prefs = settings(conn, user_id)
    newly_finished = row is None or row['result'] == '*'
    retry_copy = bool(row and row['auto_copy_error'])
    if position['game_over'] and prefs['auto_copy'] and (newly_finished or retry_copy):
        conn.execute('SAVEPOINT automatic_computer_copy')
        try:
            copy_game(conn, user_id, game_id, prefs['base_id'], automatic=True)
        except HTTPException as exc:
            conn.execute('ROLLBACK TO automatic_computer_copy')
            auto_error = exc.detail
        finally:
            conn.execute('RELEASE automatic_computer_copy')
    conn.execute('UPDATE computer_games SET auto_copy_error=?,mutation_id=?,request_hash=? WHERE user_id=? AND id=?',
                 (auto_error, mutation_id, request_hash, user_id, game_id))
    training_native.computer(conn, user_id, game_id, session, is_new=row is None)
    result = read(conn, user_id, game_id)
    result['auto_copy_error'] = auto_error
    return result
