"""Additive, portable context for review history; the history remains authoritative.

No historical context is guessed during migration. New snapshots live in the
same SQLite backup as the existing history and disappear with that history.
Every function participates in the caller's transaction without committing it.
"""
from datetime import datetime, timezone
import hashlib
import json


SCHEMA_VERSION = 1
CONTEXT_VERSION = 1


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def _object(value):
    try:
        result = json.loads(value or '{}')
        return result if isinstance(result, dict) else {}
    except (TypeError, ValueError):
        return {}


def init_schema(conn):
    """Idempotent migration, including when called inside an existing write."""
    # executescript would commit the caller's pending work before the migration.
    conn.execute('''CREATE TABLE IF NOT EXISTS learning_schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )''')
    conn.execute('''CREATE TABLE IF NOT EXISTS review_attempt_context (
        history_id INTEGER PRIMARY KEY REFERENCES review_history(id) ON DELETE CASCADE,
        context_version INTEGER NOT NULL, request_id TEXT,
        base_id INTEGER NOT NULL, card_type TEXT NOT NULL, scheduler_version TEXT NOT NULL,
        content_key TEXT NOT NULL, snapshot TEXT NOT NULL, recorded_at TEXT NOT NULL
    )''')
    conn.execute('''CREATE INDEX IF NOT EXISTS review_attempt_context_source
        ON review_attempt_context(base_id,card_type,history_id)''')
    conn.execute('''INSERT OR IGNORE INTO learning_schema_migrations(version,name,applied_at)
        VALUES(?,?,?)''', (SCHEMA_VERSION, 'review_attempt_context_v1',
                          datetime.now(timezone.utc).isoformat(timespec='seconds')))


def source_provenance(conn, entry_id):
    """Read optional sources without requiring the puzzle/analysis extensions."""
    if entry_id is None:
        return []
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
        "('puzzle_copies','game_analysis_exercises','game_analysis_reports')")}
    sources = []
    if 'puzzle_copies' in tables:
        sources.extend({'kind': 'puzzle', 'puzzle_id': row['puzzle_id']}
                       for row in conn.execute(
                           'SELECT puzzle_id FROM puzzle_copies WHERE entry_id=? ORDER BY puzzle_id',
                           (entry_id,)))
    if 'game_analysis_exercises' in tables:
        for row in conn.execute('''SELECT source_entry_id,source_fingerprint,ply
                FROM game_analysis_exercises WHERE exercise_entry_id=?
                ORDER BY source_entry_id,source_fingerprint,ply''', (entry_id,)):
            source = {'kind': 'game_error', **dict(row)}
            if 'game_analysis_reports' in tables:
                report = conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?',
                                      (row['source_entry_id'],)).fetchone()
                if report is not None and report['fingerprint'] == row['source_fingerprint']:
                    report = dict(report)
                    # The source relation predates this snapshot. A report may
                    # have been recalculated since exercise creation, so this
                    # is explicitly the matching report observed at review.
                    source['analysis_at_review'] = {
                        'fingerprint': report['fingerprint'], 'status': report['status'],
                        'settings': _object(report['settings']),
                        'provenance': _object(report.get('provenance')) or None,
                        'updated_at': report['updated_at'],
                    }
            sources.append(source)
    return sources


def record_attempt(conn, *, history_id, card, settings, content_key,
                   scheduler_version, request_id=None, context=None):
    """Attach immutable context to an already inserted, canonical attempt.

    The grade receipt remains responsible for request idempotency. Re-attaching
    the same history is harmless and never rewrites the original snapshot.
    Source IDs in JSON are historical values, not new mutable foreign keys.
    """
    existing = conn.execute('SELECT history_id FROM review_attempt_context WHERE history_id=?',
                            (history_id,)).fetchone()
    if existing is not None:
        return history_id
    history = conn.execute('SELECT card_id,reviewed_at FROM review_history WHERE id=?',
                           (history_id,)).fetchone()
    if history is None or history['card_id'] != card['id']:
        raise ValueError('Attempt context must refer to the matching review history.')
    base = conn.execute('SELECT id,name FROM bases WHERE id=?', (card['base_id'],)).fetchone()
    entry = (conn.execute('SELECT id,title,pgn,updated_at FROM entries WHERE id=?',
                          (card['entry_id'],)).fetchone() if card['entry_id'] is not None else None)
    fields = ('id', 'entry_id', 'type', 'identity', 'path', 'fen', 'answers', 'solutions',
              'title', 'comment', 'state', 'due', 'interval_days', 'repetitions', 'lapses')
    values = dict(card)
    snapshot = {
        'context_version': CONTEXT_VERSION,
        'base': dict(base) if base is not None else {'id': card['base_id'], 'name': None},
        'card': {field: values[field] for field in fields if field in values},
        'settings': dict(settings), 'content_key': content_key,
        'scheduler_version': str(scheduler_version), 'context': dict(context or {}),
        'entry': ({'id': entry['id'], 'title': entry['title'], 'updated_at': entry['updated_at'],
                   'pgn_sha256': hashlib.sha256(entry['pgn'].encode()).hexdigest()}
                  if entry is not None else None),
        'sources': source_provenance(conn, card['entry_id']),
    }
    conn.execute('''INSERT INTO review_attempt_context
        (history_id,context_version,request_id,base_id,card_type,scheduler_version,
         content_key,snapshot,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)''',
        (history_id, CONTEXT_VERSION, str(request_id) if request_id is not None else None,
         card['base_id'], card['type'], str(scheduler_version), content_key,
         _json(snapshot), history['reviewed_at']))
    return history_id
