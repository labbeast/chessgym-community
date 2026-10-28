"""Bounded account-owned drafts, independent of saved PGNs.

All writes use compare-and-swap. Revisions come from an account clock so
removing and recreating a key never makes an obsolete version current again.
"""
import json
import re
from datetime import datetime, timezone
from fastapi import HTTPException

MAX_ITEM_BYTES = 2 * 1024 * 1024
MAX_ACCOUNT_BYTES = 16 * 1024 * 1024
MAX_ITEMS = 128
KEY = re.compile(r'[a-zA-Z0-9][a-zA-Z0-9:._-]{0,159}\Z')


def init_schema(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS user_workspace_clock (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 0)""")
    conn.execute("""CREATE TABLE IF NOT EXISTS user_workspaces (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL, revision INTEGER NOT NULL,
        data TEXT NOT NULL, size_bytes INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,key))""")


def checked_key(key):
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise HTTPException(400, 'Identifiant de brouillon invalide.')


def document(row, key):
    if row is None:
        return {'key': key, 'revision': 0, 'data': None, 'updated_at': None}
    return {'key': row['key'], 'revision': row['revision'],
            'data': json.loads(row['data']), 'updated_at': row['updated_at']}


def read(conn, user_id, key):
    checked_key(key)
    return document(conn.execute('SELECT * FROM user_workspaces WHERE user_id=? AND key=?',
                                 (user_id, key)).fetchone(), key)


def list_items(conn, user_id):
    return {'items': [document(row, row['key']) for row in conn.execute(
        'SELECT * FROM user_workspaces WHERE user_id=? ORDER BY updated_at DESC,key', (user_id,))],
        'limits': {'item_bytes': MAX_ITEM_BYTES, 'account_bytes': MAX_ACCOUNT_BYTES, 'items': MAX_ITEMS}}


def _check_revision(row, expected):
    if type(expected) is not int or not 0 <= expected < 9223372036854775807:
        raise HTTPException(400, 'Indique la révision du brouillon à enregistrer.')
    actual = row['revision'] if row else 0
    if expected != actual:
        raise HTTPException(409, 'Ce brouillon a changé sur un autre appareil. Conserve ton brouillon local avant de choisir la version à reprendre.')


def write(conn, user_id, key, payload):
    checked_key(key)
    if set(payload) - {'expected_revision', 'data'} or not isinstance(payload.get('data'), dict):
        raise HTTPException(400, 'Le brouillon doit contenir un objet de données et sa révision.')
    try:
        encoded = json.dumps(payload['data'], ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        size = len(encoded.encode('utf-8'))
    except (ValueError, TypeError, RecursionError, UnicodeError):
        raise HTTPException(400, 'Les données du brouillon sont invalides.') from None
    if size > MAX_ITEM_BYTES:
        raise HTTPException(413, 'Ce brouillon dépasse la limite de 2 Mo. Sauvegarde la partie dans une base.')
    row = conn.execute('SELECT * FROM user_workspaces WHERE user_id=? AND key=?', (user_id, key)).fetchone()
    _check_revision(row, payload.get('expected_revision'))
    count, total = conn.execute('SELECT count(*),coalesce(sum(size_bytes),0) FROM user_workspaces WHERE user_id=?', (user_id,)).fetchone()
    if (row is None and count >= MAX_ITEMS) or total - (row['size_bytes'] if row else 0) + size > MAX_ACCOUNT_BYTES:
        raise HTTPException(413, 'Les brouillons occupent tout l’espace prévu. Sauvegarde ou supprime un brouillon avant de continuer.')
    conn.execute("""INSERT INTO user_workspace_clock(user_id,revision) VALUES(?,1)
                    ON CONFLICT(user_id) DO UPDATE SET revision=revision+1""", (user_id,))
    revision = conn.execute('SELECT revision FROM user_workspace_clock WHERE user_id=?', (user_id,)).fetchone()[0]
    stamp = datetime.now(timezone.utc).isoformat()
    conn.execute("""INSERT INTO user_workspaces(user_id,key,revision,data,size_bytes,updated_at) VALUES(?,?,?,?,?,?)
                    ON CONFLICT(user_id,key) DO UPDATE SET revision=excluded.revision,
                    data=excluded.data,size_bytes=excluded.size_bytes,updated_at=excluded.updated_at""",
                 (user_id, key, revision, encoded, size, stamp))
    return {'key': key, 'revision': revision, 'data': payload['data'], 'updated_at': stamp}


def delete(conn, user_id, key, expected_revision):
    checked_key(key)
    row = conn.execute('SELECT revision FROM user_workspaces WHERE user_id=? AND key=?', (user_id, key)).fetchone()
    _check_revision(row, expected_revision)
    conn.execute('DELETE FROM user_workspaces WHERE user_id=? AND key=?', (user_id, key))
    return document(None, key)
