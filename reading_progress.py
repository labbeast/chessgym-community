"""Main-line reading bookmarks, independent from training and PGN annotations."""
import hashlib
import json
import math
import re
from datetime import datetime, timezone

from fastapi import HTTPException

import pgnlib


def stamp():
    return datetime.now(timezone.utc).isoformat()


def init_schema(conn):
    conn.execute('''
        CREATE TABLE IF NOT EXISTS reading_progress (
            entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
            content_key TEXT NOT NULL, root_fen TEXT NOT NULL, moves TEXT NOT NULL,
            total_moves INTEGER NOT NULL, read_moves INTEGER NOT NULL DEFAULT 0,
            visited INTEGER NOT NULL DEFAULT 0, active_seconds REAL NOT NULL DEFAULT 0,
            measured_moves INTEGER NOT NULL DEFAULT 0,
            last_visit_at TEXT, revision INTEGER NOT NULL DEFAULT 0
        )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS reading_receipts (
            entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            request_id TEXT NOT NULL, created_at TEXT NOT NULL,
            PRIMARY KEY(entry_id,request_id)
        )''')


def enabled(conn, base_id):
    row = conn.execute('''SELECT settings FROM bases WHERE id=? AND NOT EXISTS
        (SELECT 1 FROM reference_bases WHERE base_id=bases.id)''', (base_id,)).fetchone()
    return bool(row and json.loads(row['settings']).get('reading_enabled', False))


def path_for(plies):
    return '.'.join(['0'] * plies)


def _project_state(entry_id, prior, *, key, fen, moves):
    """Reconcile a bookmark once for both read-only summaries and stored state.

    Only the common main-line prefix is still read after a content change.
    Annotation-only edits retain completion; a changed root resets visitation.
    This projection never writes and never mutates the caller's prior state.
    """
    encoded_moves = json.dumps(moves)
    if prior is None:
        return dict(entry_id=entry_id, content_key=key, root_fen=fen, moves=encoded_moves,
                    total_moves=len(moves), read_moves=0, visited=0, active_seconds=0,
                    measured_moves=0, last_visit_at=None, revision=0)
    state = dict(prior)
    if state['content_key'] == key:
        return state
    old_moves = json.loads(state['moves'])
    same_root = state['root_fen'] == fen
    prefix = 0
    if same_root:
        for before, after in zip(old_moves, moves):
            if before != after:
                break
            prefix += 1
    state.update(content_key=key, root_fen=fen, moves=encoded_moves,
                 total_moves=len(moves), read_moves=min(state['read_moves'], prefix),
                 visited=state['visited'] if same_root else 0,
                 revision=state['revision'] + int(not same_root or old_moves != moves))
    return state


def _state(conn, entry, game=None):
    """Reconcile edits lazily, including writers outside the analysis editor."""
    if not conn.in_transaction:
        conn.execute('BEGIN IMMEDIATE')
    # Callers normally select the entry in the same write transaction. Also
    # defend helper callers that retained a snapshot before acquiring the lock:
    # an old GET must never reconcile the bookmark back onto an older PGN.
    saved = conn.execute('SELECT pgn FROM entries WHERE id=?', (entry['id'],)).fetchone()
    if saved is None:
        raise HTTPException(404, 'Cette partie ou position est introuvable.')
    if saved['pgn'] != entry['pgn']:
        entry = {**dict(entry), 'pgn': saved['pgn']}
        game = None
    key = hashlib.sha256(entry['pgn'].encode('utf-8')).hexdigest()
    prior = conn.execute('SELECT * FROM reading_progress WHERE entry_id=?', (entry['id'],)).fetchone()
    if prior is not None and prior['content_key'] == key:
        return dict(prior)
    game = game or pgnlib.load_game(entry['pgn'])
    fen = game.board().fen()
    moves = [move.uci() for move in game.mainline_moves()]
    state = _project_state(entry['id'], prior, key=key, fen=fen, moves=moves)
    if prior is None:
        conn.execute('''INSERT INTO reading_progress(entry_id,content_key,root_fen,moves,total_moves)
            VALUES(?,?,?,?,?)''', (entry['id'], key, fen, state['moves'], state['total_moves']))
    else:
        conn.execute('''UPDATE reading_progress SET content_key=?,root_fen=?,moves=?,total_moves=?,
            read_moves=?,visited=?,revision=? WHERE entry_id=?''',
            (key, fen, state['moves'], state['total_moves'], state['read_moves'],
             state['visited'], state['revision'], entry['id']))
    return state


def _payload(entry, state):
    total, read = state['total_moves'], state['read_moves']
    completed = bool(state['visited'] and (not total or read == total))
    return {
        'enabled': True, 'entry_id': entry['id'], 'base_id': entry['base_id'],
        'bookmark_path': path_for(read), 'read_moves': read, 'total_moves': total,
        'percent': round(100 * read / total, 1) if total else (100.0 if completed else 0.0),
        'active_seconds': round(state['active_seconds'], 1), 'completed': completed,
        'visited': bool(state['visited']), 'last_visit_at': state['last_visit_at'],
        'content_key': state['content_key'], 'revision': state['revision'],
    }


def catalog_state(conn, entry, derived):
    """Pure projection of a bookmark onto current derived mainline metadata."""
    prior = conn.execute('SELECT * FROM reading_progress WHERE entry_id=?', (entry['id'],)).fetchone()
    return _project_state(entry['id'], prior, key=derived['pgn_digest'],
                          fen=derived['root_fen'], moves=json.loads(derived['moves']))


def catalog_summary(conn, entry, derived, *, enabled=True):
    if not enabled:return {'enabled':False,'entry_id':entry['id'],'base_id':entry['base_id']}
    return _payload(entry,catalog_state(conn,entry,derived))


def entry_summary(conn, entry, game=None):
    if not enabled(conn, entry['base_id']):
        return {'enabled': False, 'entry_id': entry['id'], 'base_id': entry['base_id']}
    return _payload(entry, _state(conn, entry, game))


def update(conn, entry, payload, *, user_id=1):
    import reading_visits
    reading_visits.checked(payload)
    if not enabled(conn, entry['base_id']):
        raise HTTPException(409, 'Le suivi de lecture est désactivé pour cette base.')
    mode, path = payload.get('mode', 'visit'), payload.get('path', '')
    if mode not in ('visit', 'bookmark'):
        raise ValueError('Action de lecture invalide.')
    if not isinstance(path, str) or not re.fullmatch(r'(?:\d+(?:\.\d+)*)?', path):
        raise ValueError('Chemin de coup invalide.')
    seconds = payload.get('active_seconds', 0)
    if isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not math.isfinite(seconds) or not 0 <= seconds <= 60:
        raise ValueError('Le temps de lecture doit être compris entre 0 et 60 secondes.')
    request_id = payload.get('request_id')
    if request_id is not None and (not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}', request_id)):
        raise ValueError('Identifiant de suivi invalide.')
    if seconds and request_id is None:
        raise ValueError('Un identifiant est nécessaire pour enregistrer le temps de lecture.')
    state = _state(conn, entry)
    # A retry of an explicit bookmark must not undo more recent navigation.
    if request_id and conn.execute('SELECT 1 FROM reading_receipts WHERE entry_id=? AND request_id=?',
                                   (entry['id'], request_id)).fetchone():
        return _payload(entry, state)
    if payload.get('content_key', state['content_key']) != state['content_key']:
        raise HTTPException(409, 'La partie a changé : recharge-la avant de poursuivre le suivi de lecture.')
    if payload.get('revision', state['revision']) != state['revision']:
        raise HTTPException(409, 'Le signet a changé sur un autre écran. Recharge son état.')
    game = pgnlib.load_game(entry['pgn'])
    node = pgnlib.node_at(game, path)
    if payload.get('fen', node.board().fen()) != node.board().fen():
        raise HTTPException(409, 'Cette position ne correspond plus à la partie enregistrée.')
    mainline = not path or all(part == '0' for part in path.split('.'))
    if not mainline:
        if mode == 'bookmark':
            raise ValueError('Le signet de lecture suit uniquement la ligne principale.')
        return _payload(entry, state)
    if payload.get('visit_id') is not None and 'visit_path' in payload:
        viewed = pgnlib.node_at(game, payload['visit_path'])
        if payload.get('visit_fen', viewed.board().fen()) != viewed.board().fen():
            raise HTTPException(409, 'La position relue ne correspond plus à la partie enregistrée.')
    target = len(path.split('.')) if path else 0
    read = target if mode == 'bookmark' else max(state['read_moves'], target)
    gained = max(0, read - state['read_moves']) if mode == 'visit' else 0
    timestamp = stamp()
    conn.execute('''UPDATE reading_progress SET read_moves=?,visited=1,active_seconds=active_seconds+?,
        measured_moves=measured_moves+?,last_visit_at=?,revision=revision+? WHERE entry_id=?''',
        (read, seconds, gained, timestamp, int(mode == 'bookmark'), entry['id']))
    if request_id:
        conn.execute('INSERT INTO reading_receipts(entry_id,request_id,created_at) VALUES(?,?,?)',
                     (entry['id'], request_id, timestamp))
    updated = dict(conn.execute('SELECT * FROM reading_progress WHERE entry_id=?', (entry['id'],)).fetchone())
    reading_visits.record(conn, entry, payload, updated, user_id=user_id, timestamp=timestamp)
    if mode == 'visit':
        import training_activity
        training_activity.record_reading(conn, entry=entry, payload=payload,
            user_id=user_id, recorded_at=timestamp)
    return _payload(entry, updated)


def base_summary(conn, base):
    entries = [dict(row) for row in conn.execute('SELECT e.id,e.base_id,e.created_at,c.pgn_digest,c.root_fen,c.moves FROM entries e LEFT JOIN entry_catalog c ON c.entry_id=e.id WHERE e.base_id=? ORDER BY e.created_at,e.id', (base['id'],))]
    if any(entry['pgn_digest'] is None for entry in entries):
        raise HTTPException(503,'La bibliothèque vient de changer. Actualise la liste.',headers={'Retry-After':'1','X-ChessGym-Reason':'catalog-changed'})
    # Fetch all bookmarks together: a book summary should not issue one query
    # per chapter. Reuse the same read-only projection as individual entries.
    prior_states = {row['entry_id']: row for row in conn.execute('''
        SELECT p.* FROM reading_progress p JOIN entries e ON e.id=p.entry_id
        WHERE e.base_id=?''', (base['id'],))}
    states = [(entry, _project_state(entry['id'], prior_states.get(entry['id']),
               key=entry['pgn_digest'], fen=entry['root_fen'], moves=json.loads(entry['moves'])))
              for entry in entries]
    total_moves = sum(state['total_moves'] for _, state in states)
    read_moves = sum(state['read_moves'] for _, state in states)
    # A diagram/text chapter contributes one unit so a book containing prose
    # chapters can genuinely reach 100%, including a book with no moves at all.
    units = sum(max(1, state['total_moves']) for _, state in states)
    read_units = sum(state['read_moves'] if state['total_moves'] else int(bool(state['visited'])) for _, state in states)
    seconds = sum(state['active_seconds'] for _, state in states)
    measured = sum(state['measured_moves'] for _, state in states)
    completed = sum(bool(state['visited'] and state['read_moves'] == state['total_moves']) for _, state in states)
    last = max((pair for pair in states if pair[1]['last_visit_at']), key=lambda pair: (pair[1]['last_visit_at'], pair[0]['id']), default=None)
    pending = [pair for pair in states if not (pair[1]['visited'] and pair[1]['read_moves'] == pair[1]['total_moves'])]
    pending_ids = {entry['id'] for entry, _ in pending}
    next_item = None
    if pending:
        if last and last[0]['id'] in pending_ids:
            next_item = last
        elif last:
            index = states.index(last)
            next_item = next((pair for pair in states[index + 1:] if pair[0]['id'] in pending_ids), pending[0])
        else:
            next_item = pending[0]
    remaining = 0 if states and read_units == units else round((units - read_units) * seconds / measured) if measured >= 3 and seconds >= 30 else None
    return {
        'base_id': base['id'], 'name': base['name'], 'total_moves': total_moves, 'read_moves': read_moves,
        'total_units': units, 'read_units': read_units,
        'percent': round(100 * read_units / units, 1) if units else 0,
        'total_entries': len(states), 'completed_entries': completed,
        'started_entries': sum(bool(state['visited']) for _, state in states),
        'active_seconds': round(seconds, 1), 'remaining_seconds': remaining,
        'last_entry_id': last[0]['id'] if last else None,
        'last_path': path_for(last[1]['read_moves']) if last else None,
        'last_visit_at': last[1]['last_visit_at'] if last else None,
        'continue_entry_id': next_item[0]['id'] if next_item else None,
        'continue_path': path_for(next_item[1]['read_moves']) if next_item else None,
    }


def mark_base(conn, base, action):
    if action not in ('read', 'unread'):
        raise ValueError('Choisis lu ou non lu pour cette base.')
    if not enabled(conn, base['id']):
        raise HTTPException(409, 'Active le suivi de lecture dans les réglages de cette base.')
    import entry_catalog
    for entry in conn.execute('SELECT * FROM entries WHERE base_id=?', (base['id'],)).fetchall():
        entry_catalog.get(conn, entry)
        state = _state(conn, entry)
        conn.execute('''UPDATE reading_progress SET read_moves=?,visited=?,revision=revision+1 WHERE entry_id=?''',
                     (state['total_moves'] if action == 'read' else 0, int(action == 'read'), entry['id']))
    return base_summary(conn, base)


def dashboard(conn):
    if not conn.in_transaction:
        conn.execute('BEGIN')
    bases = conn.execute('''SELECT bases.* FROM bases WHERE NOT EXISTS
        (SELECT 1 FROM reference_bases WHERE base_id=bases.id) ORDER BY sort_order,id''').fetchall()
    return {'bases': [base_summary(conn, base) for base in bases if json.loads(base['settings']).get('reading_enabled', False)]}
