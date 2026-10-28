"""Authenticated study-game imports, batch operations and explicit PGN editing."""
import json

import chess
import chess.pgn
from fastapi import APIRouter, Depends, Query, Response

import db
import entry_catalog
import game_search
import pgnlib
import reference_library
from accounts_api import require_user
from api_common import fail, now
from entry_service import (get_entry, check_entry_revision, require_explicit_entry_save,
                           _history_rows, history_state, save_content, entry_payload, title_for)
from library_service import get_base, text_field

router = APIRouter()


def _entry_batch_ids(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 10000:
        fail('Sélectionne entre 1 et 10 000 parties ou exercices.')
    if any(type(item) is not int or not 1 <= item <= 9223372036854775807 for item in value):
        fail('Les identifiants de la sélection doivent être des entiers positifs.')
    if len(set(value)) != len(value):
        fail('Une partie ou un exercice ne peut apparaître qu’une fois dans la sélection.')
    return value



def _entry_batch_chunks(ids):
    # Stay below SQLite builds with the traditional 999-variable limit.
    for offset in range(0, len(ids), 500):
        chunk = ids[offset:offset + 500]
        yield chunk, ','.join('?' for _ in chunk)



def _cancel_deleted_entry_analysis(conn, entry_ids, stamp):
    selected = set(entry_ids)
    for job in conn.execute("SELECT id,payload FROM jobs WHERE kind='analyse' AND status IN ('queued','running')").fetchall():
        try:
            payload = json.loads(job['payload'])
        except (ValueError, TypeError):
            continue
        if not isinstance(payload, dict) or type(payload.get('entry_id')) is not int or payload['entry_id'] not in selected:
            continue
        conn.execute("""UPDATE jobs SET cancel_requested=1,
                     status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
                     message='Partie supprimée',updated_at=? WHERE id=?""", (stamp, job['id']))



@router.post('/api/bases/{base_id}/entries/batch')
def batch_entries(base_id: int, payload: dict, user=Depends(require_user)):
    action = payload.get('action')
    if action not in ('delete', 'duplicate', 'move', 'review', 'metadata'):
        fail('Action de groupe inconnue.')
    allowed = {'action', 'entry_ids', 'expected_revisions'}
    if action in ('duplicate', 'move'):
        allowed.add('target_base_id')
    if action == 'review':
        allowed.add('selected')
    if action == 'metadata':
        allowed.add('headers')
    if set(payload) - allowed:
        fail('Cette action contient des options incompatibles.')
    entry_ids = _entry_batch_ids(payload.get('entry_ids'))
    target_id = payload.get('target_base_id', base_id if action == 'duplicate' else None)
    if action in ('duplicate', 'move') and (type(target_id) is not int or not 1 <= target_id <= 9223372036854775807):
        fail('Choisis une base de destination valide.')
    if action == 'move' and target_id == base_id:
        fail('Choisis une autre base pour déplacer la sélection.')
    if action == 'review' and type(payload.get('selected')) is not bool:
        fail('La participation aux révisions doit être oui ou non.')
    if action == 'metadata' and (not isinstance(payload.get('headers'), dict) or not payload['headers']):
        fail('Choisis au moins une information PGN à modifier.')
    stamp = now()
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        get_base(conn, base_id)
        if target_id is not None:
            get_base(conn, target_id)
            reference_library.require_study_base(conn, target_id)
        rows = {}
        for chunk, marks in _entry_batch_chunks(entry_ids):
            for row in conn.execute(f'SELECT * FROM entries WHERE id IN ({marks})', chunk).fetchall():
                rows[row['id']] = row
        if len(rows) != len(entry_ids) or any(row['base_id'] != base_id for row in rows.values()):
            fail('La sélection a changé : certaines parties ne se trouvent plus dans cette base. Actualise la liste.', 409)
        if 'expected_revisions' in payload:
            revisions = payload['expected_revisions']
            if not isinstance(revisions, dict) or set(revisions) != {str(eid) for eid in entry_ids}:
                fail('Indique la révision de chaque partie sélectionnée.')
            for entry_id in entry_ids:
                check_entry_revision(rows[entry_id], {'expected_revision': revisions[str(entry_id)]})
        affected_ids = list(entry_ids)
        if action == 'metadata':
            # Prepare every document before writing any of them. The same patch
            # changes only explicitly selected tags, including intentional clears.
            prepared = []
            for entry_id in entry_ids:
                row = rows[entry_id]
                game = pgnlib.load_game(row['pgn'])
                old_headers = dict(game.headers)
                old_title = title_for(game)
                pgnlib.patch_headers(game, payload['headers'])
                title = title_for(game) if row['title'] == old_title else row['title']
                pgn = row['pgn'] if dict(game.headers) == old_headers else pgnlib.export_game(game)
                prepared.append((row, title, pgn))
            for row, title, pgn in prepared:
                save_content(conn, row, title=title, pgn=pgn,
                             before_path=row['start_path'], after_path=row['start_path'])
        elif action == 'duplicate':
            affected_ids = []
            for entry_id in entry_ids:
                row = rows[entry_id]
                copied = conn.execute('''INSERT INTO entries
                    (base_id,title,pgn,selected,start_path,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?)''',
                    (target_id, row['title'], row['pgn'], row['selected'], row['start_path'], stamp, stamp))
                affected_ids.append(copied.lastrowid)
        else:
            if action == 'delete':
                _cancel_deleted_entry_analysis(conn, entry_ids, stamp)
            for chunk, marks in _entry_batch_chunks(entry_ids):
                if action == 'delete':
                    conn.execute(f'DELETE FROM entries WHERE id IN ({marks})', chunk)
                elif action == 'move':
                    conn.execute(f'UPDATE entries SET base_id=?,updated_at=? WHERE id IN ({marks})', [target_id, stamp, *chunk])
                    # This is a destination-specific deduplication index, not the
                    # exercise content or its PGN source metadata. Retaining it
                    # would return the moved exercise when creating in the old base.
                    conn.execute(f'DELETE FROM game_analysis_exercises WHERE exercise_entry_id IN ({marks})', chunk)
                    # Keep sync_imports as provenance at the original download
                    # destination, so the next sync does not recreate this game.
                elif action == 'review':
                    conn.execute(f'UPDATE entries SET selected=?,updated_at=? WHERE id IN ({marks})', [int(payload['selected']), stamp, *chunk])
        import training
        affected_bases = {target_id} if action == 'duplicate' else {base_id}
        if action == 'move':
            affected_bases.add(target_id)
        for affected_base in sorted(affected_bases):
            training._sync_base(conn, training.get_base(conn, affected_base))
        result = {'action': action, 'count': len(affected_ids), 'entry_ids': affected_ids, 'source_base_id': base_id}
        if target_id is not None:
            result['target_base_id'] = target_id
        if action == 'metadata':
            result['updated_entries'] = []
            for entry_id in entry_ids:
                row = get_entry(conn, entry_id)
                summary = entry_payload(row, False, conn)
                summary['history'] = history_state(conn, row)
                result['updated_entries'].append(summary)
        return result



@router.get('/api/entries')
def all_entries(played: bool = False, offset: int = Query(0, ge=0), limit: int | None = Query(None, ge=1, le=200),
                search: str = Query('', max_length=200), inclusion: str = 'all', sort: str | None = None,
                descending: bool | None = None, around_id: int | None = Query(None, ge=1), user=Depends(require_user),
                advanced: game_search.AdvancedGameSearch = Depends(game_search.parse_query)):
    return entry_catalog.page(played=played, offset=offset, limit=limit, search=search,
        inclusion=inclusion, sort=sort, descending=descending, around_id=around_id, advanced=advanced)



@router.post('/api/bases/{base_id}/import')
def import_pgn(base_id: int, payload: dict, user=Depends(require_user)):
    games = pgnlib.parse_games(payload.get('pgn'))
    # Parse everything first. An invalid later game never leaves a partial import.
    canonical = [(game, pgnlib.export_game(game)) for game in games]
    imported, duplicates = 0, 0
    with db.get_conn() as conn:
        get_base(conn, base_id)
        reference_library.require_study_base(conn, base_id)
        existing = {row['pgn'] for row in conn.execute('SELECT pgn FROM entries WHERE base_id=?', (base_id,))}
        for game, pgn in canonical:
            if pgn in existing:
                duplicates += 1
                continue
            stamp = now()
            conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)', (base_id, title_for(game), pgn, stamp, stamp))
            existing.add(pgn)
            imported += 1
    return {'imported': imported, 'duplicates': duplicates, 'warnings': []}



@router.get('/api/bases/{base_id}/export')
def export_base(base_id: int, user=Depends(require_user)):
    with db.get_conn() as conn:
        source = get_base(conn, base_id)
        if source.get('reference'):
            return reference_library.export_pgn(base_id)
        text = '\n\n'.join(row['pgn'] for row in conn.execute('SELECT pgn FROM entries WHERE base_id=? ORDER BY id', (base_id,)))
    return Response(text + ('\n' if text else ''), media_type='application/x-chess-pgn', headers={'Content-Disposition': 'attachment; filename="chessgym-base-' + str(base_id) + '.pgn"'})



@router.post('/api/entries')
def create_entry(payload: dict, user=Depends(require_user)):
    if payload.get('pgn'):
        game = pgnlib.load_game(payload['pgn'])
    else:
        game = chess.pgn.Game()
        game.setup(pgnlib.validate_board(payload.get('fen', chess.STARTING_FEN)))
    path = payload.get('start_path', '')
    pgnlib.node_at(game, path)
    title = text_field(payload.get('title', title_for(game)), 'Le titre')
    base_id = payload.get('base_id')
    stamp = now()
    with db.get_conn() as conn:
        get_base(conn, base_id)
        reference_library.require_study_base(conn, base_id)
        cur = conn.execute('INSERT INTO entries(base_id,title,pgn,start_path,created_at,updated_at) VALUES(?,?,?,?,?,?)', (base_id, title, pgnlib.export_game(game), path, stamp, stamp))
        return entry_payload(get_entry(conn, cur.lastrowid), conn=conn)



@router.get('/api/entries/{entry_id}')
def read_entry(entry_id: int, user=Depends(require_user)):
    entry_catalog.prepare(entry_id=entry_id)
    with db.get_conn() as conn:
        conn.execute('BEGIN')
        return entry_payload(get_entry(conn, entry_id), conn=conn, readonly=True)



@router.post('/api/entries/{entry_id}/seen')
def mark_entry_seen(entry_id: int, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        get_entry(conn, entry_id)
        seen_at = db.mark_entry_seen(conn, entry_id, now())
        return {'seen_at': seen_at, 'is_new': False}



@router.patch('/api/entries/{entry_id}')
def update_entry(entry_id: int, payload: dict, user=Depends(require_user)):
    if 'pgn' in payload:
        require_explicit_entry_save(payload)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = get_entry(conn, entry_id)
        check_entry_revision(row, payload)
        game = pgnlib.load_game(payload.get('pgn', row['pgn']))
        old_title = title_for(game)
        if 'headers' in payload:
            pgnlib.patch_headers(game, payload['headers'])
        default_title = title_for(game) if 'headers' in payload and row['title'] == old_title else row['title']
        title = text_field(payload.get('title', default_title), 'Le titre')
        selected = payload.get('selected', bool(row['selected']))
        if not isinstance(selected, bool):
            fail('La sélection doit être oui ou non.')
        path = payload.get('start_path', row['start_path'])
        pgnlib.node_at(game, path)
        view_path = payload.get('view_path', '')
        save_content(conn, row, title=title, pgn=pgnlib.export_game(game), start_path=path, before_path=view_path, after_path=view_path)
        if bool(row['selected']) != selected:
            conn.execute('UPDATE entries SET selected=?,updated_at=? WHERE id=?', (int(selected), now(), entry_id))
        return entry_payload(get_entry(conn, entry_id), conn=conn)



@router.post('/api/entries/{entry_id}/move')
def add_move(entry_id: int, payload: dict, user=Depends(require_user)):
    require_explicit_entry_save(payload)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = get_entry(conn, entry_id)
        check_entry_revision(row, payload)
        game = pgnlib.load_game(row['pgn'])
        path = payload.get('path', '')
        parent = pgnlib.node_at(game, path)
        try:
            move = chess.Move.from_uci(payload.get('uci', ''))
        except (ValueError, TypeError):
            fail('Coup invalide.')
        if move not in parent.board().legal_moves:
            fail('Ce coup est illégal dans cette position.')
        child = next((node for node in parent.variations if node.move == move), None)
        if child is None:
            child = parent.add_variation(move)
        index = parent.variations.index(child)
        child_path = path + '.' + str(index) if path else str(index)
        save_content(conn, row, pgn=pgnlib.export_game(game), before_path=path, after_path=child_path)
        return {'entry': entry_payload(get_entry(conn, entry_id), conn=conn), 'path': child_path}



@router.patch('/api/entries/{entry_id}/node')
def annotate_node(entry_id: int, payload: dict, user=Depends(require_user)):
    require_explicit_entry_save(payload)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = get_entry(conn, entry_id)
        check_entry_revision(row, payload)
        game = pgnlib.load_game(row['pgn'])
        node = pgnlib.node_at(game, payload.get('path', ''))
        if 'comment' in payload:
            if not isinstance(payload['comment'], str) or len(payload['comment']) > 100000 or '}' in payload['comment'] or '{' in payload['comment']:
                fail('Commentaire invalide : évite les accolades et limite-le à 100 000 caractères.')
            node.comment = pgnlib.merge_comment(node.comment, payload['comment'])
        if 'nags' in payload:
            nags = payload['nags']
            if not isinstance(nags, list) or any(isinstance(n, bool) or not isinstance(n, int) or not 0 <= n <= 255 for n in nags):
                fail('Les symboles NAG doivent être des nombres de 0 à 255.')
            node.nags = set(nags)
        save_content(conn, row, pgn=pgnlib.export_game(game), before_path=payload.get('path', ''), after_path=payload.get('path', ''))
        return entry_payload(get_entry(conn, entry_id), conn=conn)



@router.post('/api/entries/{entry_id}/tree')
def change_tree(entry_id: int, payload: dict, user=Depends(require_user)):
    require_explicit_entry_save(payload)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = get_entry(conn, entry_id)
        check_entry_revision(row, payload)
        game = pgnlib.load_game(row['pgn'])
        path = payload.get('path', '')
        change = pgnlib.edit_tree(game, path, payload.get('action'), row['start_path'])
        if change['changed']:
            save_content(conn, row, pgn=pgnlib.export_game(game), start_path=change['start_path'], before_path=path, after_path=change['path'])
        result = entry_payload(get_entry(conn, entry_id), conn=conn)
        return {'entry': result, 'path': change['path'], 'history': result['history'], 'changed': change['changed']}



def restore_history(entry_id, *, redo=False, payload=None):
    require_explicit_entry_save(payload or {})
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = get_entry(conn, entry_id)
        check_entry_revision(row, payload or {})
        undo_row, redo_row = _history_rows(conn, row)
        record = redo_row if redo else undo_row
        if record is None:
            fail('Aucune modification à rétablir.' if redo else 'Aucune modification à annuler.', 409)
        content = json.loads(record['after_content'] if redo else record['before_content'])
        path = record['after_path'] if redo else record['before_path']
        conn.execute('UPDATE entries SET title=?,pgn=?,start_path=?,updated_at=? WHERE id=?', (content['title'], content['pgn'], content['start_path'], now(), entry_id))
        conn.execute('UPDATE entry_history SET undone=? WHERE id=?', (0 if redo else 1, record['id']))
        result = entry_payload(get_entry(conn, entry_id), conn=conn)
        return {'entry': result, 'path': path, 'history': result['history']}



@router.post('/api/entries/{entry_id}/undo')
def undo_entry(entry_id: int, payload: dict, user=Depends(require_user)):
    return restore_history(entry_id, payload=payload)



@router.post('/api/entries/{entry_id}/redo')
def redo_entry(entry_id: int, payload: dict, user=Depends(require_user)):
    return restore_history(entry_id, redo=True, payload=payload)



@router.delete('/api/entries/{entry_id}')
def delete_entry(entry_id: int, expected_revision: str | None = None, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = get_entry(conn, entry_id)
        if expected_revision is not None:
            check_entry_revision(row, {'expected_revision': expected_revision})
        conn.execute('DELETE FROM entries WHERE id=?', (entry_id,))
    return {'ok': True}



@router.post('/api/entries/{entry_id}/line')
def add_line(entry_id: int, payload: dict, user=Depends(require_user)):
    require_explicit_entry_save(payload)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = get_entry(conn, entry_id)
        check_entry_revision(row, payload)
        game = pgnlib.load_game(row['pgn'])
        path = payload.get('path', '')
        parent = pgnlib.node_at(game, path)
        positions = pgnlib.line_positions(parent.board(), payload.get('moves'))
        # Validation finishes before the first change. One invalid later move
        # cannot leave an accepted prefix stored in the entry.
        for position in positions:
            move = chess.Move.from_uci(position['uci'])
            child = next((node for node in parent.variations if node.move == move), None)
            if child is None:
                child = parent.add_variation(move)
            index = parent.variations.index(child)
            path = path + '.' + str(index) if path else str(index)
            parent = child
        save_content(conn, row, pgn=pgnlib.export_game(game), before_path=payload.get('path', ''), after_path=path)
        return {'entry': entry_payload(get_entry(conn, entry_id), conn=conn), 'path': path}

