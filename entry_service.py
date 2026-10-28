"""Saved PGN content, revision checks and undo history within caller transactions."""
import hmac
import json
import re
from datetime import datetime

import db
import entry_catalog
import pgnlib
import reading_progress
from api_common import fail, now
from entry_content import content_snapshot, entry_revision


def get_entry(conn, entry_id):
    row = conn.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone()
    if row is None:
        fail('Cette partie ou position est introuvable.', 404)
    return dict(row)



def check_entry_revision(row, payload):
    # Older clients omit this field. New clients use the advertised capability
    # and always send it; their stale drafts must never overwrite saved content.
    if 'expected_revision' not in payload:
        return
    expected = payload['expected_revision']
    if not isinstance(expected, str) or not re.fullmatch(r'[0-9a-f]{64}', expected):
        fail('La révision de la partie est invalide.')
    if not hmac.compare_digest(expected, entry_revision(row)):
        fail('Cette partie a changé sur un autre appareil. Conserve ton brouillon, puis recharge la partie ou enregistre une copie.', 409)



def require_explicit_entry_save(payload):
    """Reject automatic writes from browser tabs loaded before manual saving.

    The new editor only sends this marker after a save action. A revision token
    alone cannot distinguish an old automatic move/annotation write from one
    the user actually chose to save.
    """
    if payload.get('explicit_save') is not True:
        fail('Recharge ChessGym pour utiliser la sauvegarde manuelle. Les modifications de cette ancienne fenêtre n’ont pas été enregistrées.', 409)



def _history_rows(conn, row):
    undo = conn.execute('SELECT * FROM entry_history WHERE entry_id=? AND undone=0 ORDER BY id DESC LIMIT 1', (row['id'],)).fetchone()
    redo = conn.execute('SELECT * FROM entry_history WHERE entry_id=? AND undone=1 ORDER BY id LIMIT 1', (row['id'],)).fetchone()
    expected = json.loads(undo['after_content']) if undo else json.loads(redo['before_content']) if redo else None
    # An external content writer (for example a repertoire extension) must not
    # let an older undo/redo silently discard its new content.
    if expected is not None and expected != content_snapshot(row):
        return None, None
    return undo, redo



def history_state(conn, row):
    undo, redo = _history_rows(conn, row)
    return {'can_undo': undo is not None, 'can_redo': redo is not None}



def safe_view_path(pgn, path):
    game = pgnlib.load_game(pgn)
    if not isinstance(path, str) or not re.fullmatch(r'(?:\d+(?:\.\d+)*)?', path):
        return ''
    while path:
        try:
            pgnlib.node_at(game, path)
            return path
        except ValueError:
            path = path.rsplit('.', 1)[0] if '.' in path else ''
    return ''



def save_content(conn, row, *, pgn=None, title=None, start_path=None, before_path='', after_path=''):
    before = content_snapshot(row)
    after = {'title': row['title'] if title is None else title,
             'pgn': row['pgn'] if pgn is None else pgn,
             'start_path': row['start_path'] if start_path is None else start_path}
    if before == after:
        return False
    if not any(history_state(conn, row).values()):
        conn.execute('DELETE FROM entry_history WHERE entry_id=?', (row['id'],))
    conn.execute('DELETE FROM entry_history WHERE entry_id=? AND undone=1', (row['id'],))
    stamp = now()
    conn.execute('INSERT INTO entry_history(entry_id,before_content,after_content,before_path,after_path,created_at) VALUES(?,?,?,?,?,?)',
                 (row['id'], json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False),
                  safe_view_path(before['pgn'], before_path), safe_view_path(after['pgn'], after_path), stamp))
    conn.execute('DELETE FROM entry_history WHERE entry_id=? AND id NOT IN (SELECT id FROM entry_history WHERE entry_id=? ORDER BY id DESC LIMIT 100)', (row['id'], row['id']))
    conn.execute('UPDATE entries SET title=?,pgn=?,start_path=?,updated_at=? WHERE id=?', (after['title'], after['pgn'], after['start_path'], stamp, row['id']))
    return True



def entry_payload(row, complete=True, conn=None, *, readonly=False):
    if conn is None:
        with db.get_conn() as payload_conn:
            return entry_payload(row, complete, payload_conn, readonly=readonly)
    game = pgnlib.load_game(row['pgn']) if complete else None
    metadata = entry_catalog.get(conn, row, game, persist=not readonly)
    result = dict(row)
    result['revision'] = metadata['revision']
    result['selected'] = bool(result['selected'])
    result['is_new'] = result['seen_at'] is None
    result['reading'] = (reading_progress.catalog_summary(conn, row, metadata, enabled=reading_progress.enabled(conn, row['base_id']))
                         if readonly else reading_progress.entry_summary(conn, row, game))
    if complete:
        result.update(pgnlib.game_payload(game))
        result['history'] = history_state(conn, row)
    else:
        result.pop('pgn', None)
        result['headers'] = json.loads(metadata['headers'])
    return result



def played_game_order(entry):
    """Played games follow their PGN date, independently of download order.

    Prefer UTC tags, then conventional Date/StartTime. Unknown dates sort after
    dated games; insertion time and id make ties deterministic. Library/base
    lists keep their existing insertion order.
    """
    headers = entry.get('headers', {})
    day = None
    for name in ('UTCDate', 'Date'):
        value = headers.get(name)
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}\.\d{2}\.\d{2}', value):
            continue
        try:
            day = datetime.strptime(value, '%Y.%m.%d').date().toordinal()
            break
        except ValueError:
            continue
    seconds = -1
    for name in ('UTCTime', 'StartTime', 'Time'):
        value = headers.get(name)
        if not isinstance(value, str) or not re.fullmatch(r'\d{2}:\d{2}:\d{2}', value):
            continue
        try:
            parsed = datetime.strptime(value, '%H:%M:%S')
            seconds = parsed.hour * 3600 + parsed.minute * 60 + parsed.second
            break
        except ValueError:
            continue
    return (day is not None, day or 0, seconds, entry.get('created_at', ''), entry.get('id', 0))



def title_for(game):
    event = game.headers.get('Event', '?')
    white, black = game.headers.get('White', '?'), game.headers.get('Black', '?')
    if white != '?' or black != '?':
        return (white + ' — ' + black)[:200]
    return event[:200] if event != '?' else ('Position' if 'FEN' in game.headers else 'Partie sans titre')

