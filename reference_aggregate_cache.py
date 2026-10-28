"""Bounded, disposable Explorer snapshots; reference archives stay read-only.

The key includes each complete committed corpus version and all query filters.
No partial result or timeout enters this cache. It is optional and regenerable.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import time
import zlib

import db

MAX_ENTRIES = 128
MAX_BYTES = 16 * 1024 * 1024
MAX_RESULT_BYTES = 2 * 1024 * 1024
VERSION = 1


def version(paths, profile):
    """Return an exact version key and whether every source reached its end.

    Rejected records do not make a completed corpus mutable: its retained games
    still have exact statistics, while the caller keeps the rejection warning.
    """
    import reference_store
    versions = []
    completed = True
    for path in paths:
        file = Path(path).resolve()
        stat = file.stat()
        with reference_store._connect(file, readonly=True) as conn:
            conn.execute('BEGIN')
            meta = {row[0]: json.loads(row[1]) for row in conn.execute("SELECT key,value FROM meta WHERE key IN ('totals','import','schema_version','utc_date_fallback')")}
        state = meta.get('import', {})
        completed = completed and state.get('status') == 'completed'
        versions.append((str(file), stat.st_dev, stat.st_ino, getattr(stat, 'st_birthtime_ns', None),
                         meta.get('totals'), state.get('fingerprint'), state.get('encoding'), state.get('status'), state.get('rejected'),
                         meta.get('schema_version'), meta.get('utc_date_fallback')))
    digest = hashlib.sha256(json.dumps([VERSION, versions, profile], ensure_ascii=False, sort_keys=True,
        separators=(',', ':')).encode()).hexdigest()
    return digest, bool(versions) and completed


def key(paths, profile):
    return version(paths, profile)[0]


def _connect():
    path = Path(db.DB_PATH).with_name('reference-query-cache.sqlite3')
    conn = sqlite3.connect(path, timeout=.1, factory=db.ManagedConnection)
    try:
        conn.execute('CREATE TABLE IF NOT EXISTS snapshots(key TEXT PRIMARY KEY,payload BLOB NOT NULL,size INTEGER NOT NULL,touched REAL NOT NULL)')
        return conn
    except BaseException:
        conn.close()
        raise


def read(cache_key):
    try:
        with _connect() as conn:
            row = conn.execute('SELECT payload FROM snapshots WHERE key=?', (cache_key,)).fetchone()
            if row is None:
                return None
            conn.execute('UPDATE snapshots SET touched=? WHERE key=?', (time.time(), cache_key))
            result=json.loads(zlib.decompress(row[0]))
            return result if isinstance(result,dict) and result.get('status')=='ok' else None
    except (sqlite3.Error, OSError, ValueError, zlib.error):
        return None


def write(cache_key, result):
    raw = json.dumps(result, ensure_ascii=False, separators=(',', ':')).encode()
    if len(raw) > MAX_RESULT_BYTES:
        return
    payload = zlib.compress(raw)
    try:
        with _connect() as conn:
            conn.execute('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?)', (cache_key,payload,len(payload),time.time()))
            count, size = conn.execute('SELECT count(*),coalesce(sum(size),0) FROM snapshots').fetchone()
            if count > MAX_ENTRIES or size > MAX_BYTES:
                for old_key, old_size in conn.execute('SELECT key,size FROM snapshots ORDER BY touched').fetchall():
                    if count <= MAX_ENTRIES and size <= MAX_BYTES:
                        break
                    conn.execute('DELETE FROM snapshots WHERE key=?', (old_key,))
                    count -= 1
                    size -= old_size
    except (sqlite3.Error, OSError):
        pass  # Losing a derived cache must never make a real query fail.
