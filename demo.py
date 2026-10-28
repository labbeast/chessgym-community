"""Small, opt-in teaching bases; existing study material is never replaced."""
import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends

from accounts_api import require_user
from db import get_conn
from library_service import checked_settings
import pgnlib

router = APIRouter(prefix='/api', dependencies=[Depends(require_user)])
PACK = json.loads((Path(__file__).parent / 'examples' / 'starter.json').read_text(encoding='utf-8'))
PREFERENCE = 'starter_examples_v1'


def _installed(conn):
    saved = conn.execute('SELECT value FROM preferences WHERE key=?', (PREFERENCE,)).fetchone()
    records = json.loads(saved['value']) if saved else {}
    existing = {}
    for key, record in records.items():
        # Base IDs can be reused after deletion. The creation timestamp keeps a
        # newly created personal base from being mistaken for a deleted example.
        row = conn.execute('SELECT id,name,folder_id,settings FROM bases WHERE id=? AND created_at=?',
                           (record['base_id'], record['created_at'])).fetchone()
        if row:
            existing[key] = dict(row)
    return records, existing


def _snapshot(conn):
    _, existing = _installed(conn)
    examples = []
    for item in PACK['examples']:
        row = existing.get(item['key'])
        flag = {'repertoire': 'is_repertoire', 'guess': 'guess_enabled', 'reading': 'reading_enabled'}[item['mode']]
        examples.append({'key': item['key'], 'mode': item['mode'],
                         'name': row['name'] if row else item['name'],
                         'mode_enabled': bool(row and json.loads(row['settings']).get(flag)),
                         'base_id': row['id'] if row else None, 'installed': row is not None})
    return {'ok': True, 'installed': all(item['installed'] for item in examples),
            'bases': [item['base_id'] for item in examples if item['installed']],
            'examples': examples, 'license': PACK['license']}


@router.get('/demo')
def example_status():
    with get_conn() as conn:
        return _snapshot(conn)


@router.post('/demo')
def create_examples():
    with get_conn() as conn:
        # Serialize double clicks and concurrent requests before reading the
        # manifest. The entire small pack commits or rolls back together.
        conn.execute('BEGIN IMMEDIATE')
        records, existing = _installed(conn)
        missing = [item for item in PACK['examples'] if item['key'] not in existing]
        if not missing:
            return _snapshot(conn)
        folder = next((row['folder_id'] for row in existing.values() if row['folder_id']), None)
        if folder is None:
            row = conn.execute('SELECT id FROM folders WHERE name=? AND parent_id IS NULL ORDER BY id LIMIT 1',
                               ('Exemples ChessGym',)).fetchone()
            folder = row['id'] if row else conn.execute(
                'INSERT INTO folders(name,parent_id) VALUES (?,NULL)', ('Exemples ChessGym',)).lastrowid
        stamp = datetime.now(timezone.utc).isoformat()
        for item in missing:
            settings = checked_settings(item['settings'])
            base_id = conn.execute('INSERT INTO bases(name,folder_id,tags,settings,created_at) VALUES (?,?,?,?,?)',
                (item['name'], folder, json.dumps(item['tags'], ensure_ascii=False), json.dumps(settings), stamp)).lastrowid
            for entry in item['entries']:
                # Validate bundled content with the same parser used by imports.
                game = pgnlib.load_game(entry['pgn'])
                conn.execute('INSERT INTO entries(base_id,title,pgn,selected,start_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
                    (base_id, entry['title'], pgnlib.export_game(game), 1, '', stamp, stamp))
            records[item['key']] = {'base_id': base_id, 'created_at': stamp}
        conn.execute('INSERT OR REPLACE INTO preferences(key,value) VALUES (?,?)', (PREFERENCE, json.dumps(records)))
        return _snapshot(conn)
