"""Disposable opening statistics and upstream cooldowns, separate from user data.

The query key and value contain only public aggregate statistics. Credentials,
credential hashes, PGNs, and library metadata are never stored here. The path is
resolved when used, so isolated application databases also get isolated caches.
"""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3

import db


CACHE_PATH = None  # Optional path override for an embedding application or tests.
MAX_CACHE_ENTRIES = 10_000


def cache_path():
    return Path(CACHE_PATH) if CACHE_PATH is not None else Path(db.DB_PATH).with_name(
        Path(db.DB_PATH).stem + '.explorer-cache.sqlite3')


@contextmanager
def _connection():
    path = cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=2)
    try:
        with conn:
            conn.execute('''CREATE TABLE IF NOT EXISTS statistics (
                query_key TEXT PRIMARY KEY, fetched_at REAL NOT NULL,
                accessed_at REAL NOT NULL, payload TEXT NOT NULL)''')
            conn.execute('''CREATE TABLE IF NOT EXISTS upstream_state (
                name TEXT PRIMARY KEY, until REAL NOT NULL)''')
            yield conn
    finally:
        conn.close()


def load(query_key, now):
    with _connection() as conn:
        row = conn.execute('SELECT fetched_at,payload FROM statistics WHERE query_key=?',
                           (query_key,)).fetchone()
        if row is None:
            return None
        conn.execute('UPDATE statistics SET accessed_at=? WHERE query_key=?', (now, query_key))
    try:
        return row[0], json.loads(row[1])
    except (ValueError, TypeError, RecursionError):
        return None


def save(query_key, fetched_at, payload):
    serialized = json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    with _connection() as conn:
        conn.execute('''INSERT INTO statistics(query_key,fetched_at,accessed_at,payload)
            VALUES(?,?,?,?) ON CONFLICT(query_key) DO UPDATE SET
            fetched_at=excluded.fetched_at,accessed_at=excluded.accessed_at,payload=excluded.payload''',
            (query_key, fetched_at, fetched_at, serialized))
        conn.execute('''DELETE FROM statistics WHERE query_key IN
            (SELECT query_key FROM statistics ORDER BY accessed_at DESC,fetched_at DESC,query_key
             LIMIT -1 OFFSET ?)''', (MAX_CACHE_ENTRIES,))


def cooldown():
    with _connection() as conn:
        row = conn.execute("SELECT until FROM upstream_state WHERE name='rate_limit'").fetchone()
    return row[0] if row else 0.0


def set_cooldown(until):
    with _connection() as conn:
        # A second client must not shorten a cooldown already recorded on disk.
        conn.execute('''INSERT INTO upstream_state(name,until) VALUES('rate_limit',?)
            ON CONFLICT(name) DO UPDATE SET until=MAX(until,excluded.until)''', (until,))
