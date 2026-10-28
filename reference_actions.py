"""Explicit selection actions on indexed reference games.

Only selected PGNs are decoded. Position writes use the existing exact-position
primary key, so deleting a game never scans a multi-million-game archive.
"""
from contextlib import ExitStack
import json
import zlib

from fastapi import HTTPException

import db
import reference_library as library
import reference_store as store
from api_common import now
from library_service import get_base

MAX_GAME_ID = 9223372036854775807
GAME_COLUMNS = ('identity,identity_payload,title,headers,pgn,white,black,event,date,'
                'year,white_elo,black_elo,speed,outcome,plies')


def validate(payload, base_id):
    action = payload.get('action')
    if action not in ('duplicate', 'move', 'delete'):
        raise ValueError('Action de groupe inconnue.')
    allowed = {'action', 'game_ids'}
    if action != 'delete':
        allowed.add('target_base_id')
    if set(payload) - allowed:
        raise ValueError('Cette action contient des options incompatibles.')
    ids = payload.get('game_ids')
    if not isinstance(ids, list) or not 1 <= len(ids) <= 10000:
        raise ValueError('Sélectionne entre 1 et 10 000 parties.')
    if any(type(value) is not int or not 1 <= value <= MAX_GAME_ID for value in ids):
        raise ValueError('Les identifiants de la sélection doivent être des entiers positifs.')
    if len(set(ids)) != len(ids):
        raise ValueError('Une partie ne peut apparaître qu’une fois dans la sélection.')
    target_id = payload.get('target_base_id', base_id if action == 'duplicate' else None)
    if action != 'delete' and (type(target_id) is not int or not 1 <= target_id <= MAX_GAME_ID):
        raise ValueError('Choisis une base de destination valide.')
    if action == 'move' and target_id == base_id:
        raise ValueError('Choisis une autre base pour déplacer la sélection.')
    return action, ids, target_id


def _meta(conn, schema, key, default=None):
    row = conn.execute(f'SELECT value FROM {schema}.meta WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def _set_meta(conn, schema, key, value):
    conn.execute(f'''INSERT INTO {schema}.meta(key,value) VALUES(?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value''',
        (key, json.dumps(value, ensure_ascii=False, separators=(',', ':'))))


def _change_totals(conn, schema, games, positions):
    totals = _meta(conn, schema, 'totals')
    totals['game_count'] += games
    totals['indexed_positions'] += positions
    totals['revision'] = totals.get('revision', 0) + 1
    _set_meta(conn, schema, 'totals', totals)


def _copy_game(conn, source, target, game_id, parsed):
    next_id = conn.execute(f'''SELECT max(
        COALESCE((SELECT max(id) FROM {target}.games),0),
        COALESCE((SELECT CAST(value AS INTEGER) FROM {target}.meta
                  WHERE key='game_id_high_water'),0)) + 1''').fetchone()[0]
    if next_id > MAX_GAME_ID:
        raise ValueError('Cette base ne peut plus recevoir de nouvelles parties.')
    conn.execute(f'''INSERT INTO {target}.games(id,{GAME_COLUMNS})
        SELECT ?,{GAME_COLUMNS} FROM {source}.games WHERE id=?''', (next_id, game_id))
    conn.executemany(f'''INSERT INTO {target}.positions(position_key,game_id,ply,next_move,san)
        VALUES(?,?,?,?,?)''', ((key, next_id, *sample) for key, sample in parsed.positions.items()))
    return next_id


def _delete_game(conn, schema, game_id, parsed):
    removed = conn.executemany(f'DELETE FROM {schema}.positions WHERE position_key=? AND game_id=?',
                              ((key, game_id) for key in parsed.positions)).rowcount
    if removed != len(parsed.positions):
        raise ValueError('L’index de cette partie est incomplet. Aucune partie n’a été modifiée.')
    conn.execute(f'DELETE FROM {schema}.games WHERE id=?', (game_id,))
    return removed


def _delete_selection(conn, source, ids):
    # Preserve the highest allocated ID even when the final game is deleted.
    high_water = max(_meta(conn, source, 'game_id_high_water', 0),
                     conn.execute(f'SELECT max(id) FROM {source}.games').fetchone()[0])
    _set_meta(conn, source, 'game_id_high_water', high_water)
    position_count = 0
    for game_id in ids:
        row = conn.execute(f'SELECT pgn FROM {source}.games WHERE id=?', (game_id,)).fetchone()
        parsed = store._parse_record(zlib.decompress(row['pgn']))
        position_count += _delete_game(conn, source, game_id, parsed)
    _change_totals(conn, source, -len(ids), -position_count)


def batch(base_id, payload):
    action, ids, target_id = validate(payload, base_id)
    # Match the existing importer/deletion lock order: library gate, store locks,
    # then study write transaction. The OS lock also excludes external workers.
    with library._lock, ExitStack() as stack:
        source_row = library.require_reference(base_id)
        reference_rows = {base_id: source_row}
        with db.get_conn() as lookup:
            if target_id is not None:
                get_base(lookup, target_id)
                target_row = library.reference_row(lookup, target_id)
                if target_row:
                    reference_rows[target_id] = target_row
        paths = {}
        for bid, row in sorted(reference_rows.items()):
            library.ensure_deletable(bid)
            path = library.store_path(row['storage_key'])
            if not path.is_file():
                raise HTTPException(409, 'Le fichier de cette grande base est absent.')
            paths[bid] = path
            try:
                stack.enter_context(store._import_lock(path))
            except ValueError as exc:
                raise HTTPException(409, 'Mets l’import en pause avant de modifier les parties de cette base.') from exc
        with db.get_conn() as conn:
            conn.execute('ATTACH DATABASE ? AS reference_source', (str(paths[base_id]),))
            source = 'reference_source'
            target = source if target_id == base_id else 'reference_target' if target_id in paths else None
            if target == 'reference_target':
                conn.execute('ATTACH DATABASE ? AS reference_target', (str(paths[target_id]),))
            if action == 'move':
                # WAL transactions spanning files are not crash-atomic. Commit
                # a durable destination copy before ever deleting the source.
                destination = target or 'main'
                conn.execute(f'PRAGMA {destination}.synchronous=FULL')
            conn.execute('BEGIN IMMEDIATE')
            get_base(conn, base_id)
            if target_id is not None:
                get_base(conn, target_id)
            found = set()
            for offset in range(0, len(ids), 500):
                chunk = ids[offset:offset + 500]
                marks = ','.join('?' for _ in chunk)
                found.update(row[0] for row in conn.execute(
                    f'SELECT id FROM {source}.games WHERE id IN ({marks})', chunk))
            if found != set(ids):
                raise HTTPException(409, 'La sélection a changé : certaines parties ne se trouvent plus dans cette base. Actualise la liste.')
            affected_ids, position_count = [], 0
            stamp = now()
            if action == 'delete':
                _delete_selection(conn, source, ids)
            else:
                for game_id in ids:
                    row = conn.execute(f'SELECT title,pgn FROM {source}.games WHERE id=?', (game_id,)).fetchone()
                    raw = zlib.decompress(row['pgn'])
                    if target:
                        parsed = store._parse_record(raw)
                        position_count += len(parsed.positions)
                        affected_ids.append(_copy_game(conn, source, target, game_id, parsed))
                    else:
                        copied = conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
                            VALUES(?,?,?,?,?)''', (target_id, row['title'], raw.decode('utf-8-sig'), stamp, stamp))
                        affected_ids.append(copied.lastrowid)
                if target:
                    _change_totals(conn, target, len(ids), position_count)
                else:
                    import training
                    training._sync_base(conn, training.get_base(conn, target_id))
                if action == 'move':
                    # A crash between these commits can leave copies in both
                    # bases, but can never lose the only copy of a game.
                    conn.commit()
                    try:
                        conn.execute('BEGIN IMMEDIATE')
                        # A personal-base edit can run between the commits.
                        # Never remove originals if a destination copy vanished.
                        get_base(conn, target_id)
                        for offset in range(0, len(affected_ids), 500):
                            chunk = affected_ids[offset:offset + 500]
                            marks = ','.join('?' for _ in chunk)
                            if target:
                                count = conn.execute(f'SELECT count(*) FROM {target}.games WHERE id IN ({marks})', chunk).fetchone()[0]
                            else:
                                count = conn.execute(f'SELECT count(*) FROM entries WHERE base_id=? AND id IN ({marks})',
                                                     [target_id, *chunk]).fetchone()[0]
                            if count != len(chunk):
                                raise ValueError('La destination a changé pendant le déplacement.')
                        _delete_selection(conn, source, ids)
                        conn.commit()
                    except Exception as exc:
                        conn.rollback()
                        raise HTTPException(409, 'Les parties ont été copiées dans la destination, '
                            'mais leur suppression de la base source a échoué. Les originaux sont conservés. '
                            'Actualise les deux bases avant de réessayer.') from exc
            result = {'action': action, 'count': len(ids), 'source_base_id': base_id,
                      'game_ids': affected_ids if target else list(ids)}
            if target_id is not None:
                result['target_base_id'] = target_id
                if target is None:
                    result['entry_ids'] = affected_ids
        return result
