"""Separate, bounded upkeep schedules; legacy mastery and history stay intact."""
from __future__ import annotations

from collections import Counter
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

import review_preferences

SCHEDULER_VERSION = 'maintenance-v1'


def init_schema(conn):
    """Join the caller's transaction; schema creation must never commit its data."""
    conn.execute('''CREATE TABLE IF NOT EXISTS review_maintenance (
        card_id TEXT PRIMARY KEY REFERENCES review_cards(id) ON DELETE CASCADE,
        due TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        repetitions INTEGER NOT NULL DEFAULT 0, last_reviewed_at TEXT,
        scheduler_version TEXT NOT NULL DEFAULT 'maintenance-v1'
    )''')
    conn.execute('CREATE INDEX IF NOT EXISTS review_maintenance_due ON review_maintenance(due,card_id)')
    conn.execute('''CREATE TABLE IF NOT EXISTS review_maintenance_events (
        history_id INTEGER PRIMARY KEY REFERENCES review_history(id) ON DELETE CASCADE,
        card_id TEXT NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
        reviewed_at TEXT NOT NULL, grade INTEGER NOT NULL, previous_due TEXT NOT NULL,
        next_due TEXT, scheduler_version TEXT NOT NULL
    )''')
    conn.execute('CREATE INDEX IF NOT EXISTS review_maintenance_events_date ON review_maintenance_events(reviewed_at)')


def _stamp(value):
    return value.isoformat(timespec='seconds')


def _timestamp(value):
    parsed = datetime.fromisoformat(value)
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def _slots(conn, day):
    occupied = Counter()
    for row in conn.execute('SELECT due,COUNT(*) n FROM review_maintenance GROUP BY due'):
        occupied[review_preferences.study_date(_timestamp(row['due']), day)] += row['n']
    return occupied


def _next_due(day, date, occupied, limit):
    while occupied[date] >= limit:
        date += timedelta(days=1)
    occupied[date] += 1
    return _stamp(datetime.combine(date, time(day['start_hour']), ZoneInfo(day['timezone'])).astimezone(timezone.utc))


def ensure_scheduled(conn, current):
    """Gradually admit old mastered cards without changing a legacy card field.

    First reminders start on the next study day, at most daily_limit per day.
    The unchanged path is read-only, including after a restart.
    """
    prefs = review_preferences.read(conn)
    config = prefs['review_maintenance']
    if not config['enabled']:
        return
    query = """SELECT c.id FROM review_cards c LEFT JOIN review_maintenance m ON m.card_id=c.id
        WHERE c.state='mastered' AND c.active=1 AND m.card_id IS NULL ORDER BY c.id"""
    if conn.execute(query + ' LIMIT 1').fetchone() is None:
        return
    if not conn.in_transaction:
        conn.execute('BEGIN IMMEDIATE')
        prefs = review_preferences.read(conn)
        config = prefs['review_maintenance']
        if not config['enabled']:
            return
    cards = conn.execute(query).fetchall()
    day = prefs['study_day']
    occupied = _slots(conn, day)
    date = review_preferences.study_date(current, day) + timedelta(days=1)
    rows = []
    for card in cards:
        due = _next_due(day, date, occupied, config['daily_limit'])
        date = review_preferences.study_date(_timestamp(due), day)
        rows.append((card['id'], due, _stamp(current), _stamp(current)))
    conn.executemany('INSERT INTO review_maintenance(card_id,due,created_at,updated_at) VALUES (?,?,?,?)', rows)


def schedule_cards(conn, card_ids, current):
    """Allocate a whole migration in one pass over occupied calendar slots."""
    prefs = review_preferences.read(conn)
    config, day = prefs['review_maintenance'], prefs['study_day']
    date = review_preferences.study_date(current, day) + timedelta(days=config['interval_days'])
    occupied = _slots(conn, day)
    due_by_id = {}
    for card_id in card_ids:
        due = _next_due(day, date, occupied, config['daily_limit'])
        date = review_preferences.study_date(_timestamp(due), day)
        due_by_id[card_id] = due
    conn.executemany('''INSERT INTO review_maintenance(card_id,due,created_at,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(card_id) DO UPDATE SET due=excluded.due,updated_at=excluded.updated_at''',
        ((card_id, due, _stamp(current), _stamp(current)) for card_id, due in due_by_id.items()))
    return due_by_id


def schedule_card(conn, card_id, current):
    """Start/renew upkeep after genuine mastery; never pull existing cards forward."""
    return schedule_cards(conn, [card_id], current)[card_id]


def get(conn, card_id):
    row = conn.execute('SELECT * FROM review_maintenance WHERE card_id=?', (card_id,)).fetchone()
    return dict(row) if row else None


def due_card_ids(conn, current, base_ids=None):
    """Global daily allowance across all bases, checked under the grader's lock."""
    prefs = review_preferences.read(conn)
    config = prefs['review_maintenance']
    if not config['enabled']:
        return set()
    _, start, end = review_preferences.day_bounds(current, prefs['study_day'])
    completed = conn.execute('''SELECT COUNT(*) FROM review_maintenance_events
        WHERE reviewed_at>=? AND reviewed_at<?''', (_stamp(start), _stamp(end))).fetchone()[0]
    remaining = max(0, config['daily_limit'] - completed)
    if not remaining:
        return set()
    scope = ''
    params = [_stamp(current)]
    if base_ids is not None:
        if not base_ids:
            return set()
        scope = ' AND c.base_id IN (' + ','.join('?' for _ in base_ids) + ')'
        params.extend(base_ids)
    params.append(remaining)
    return {row['id'] for row in conn.execute('''SELECT c.id FROM review_maintenance m
        JOIN review_cards c ON c.id=m.card_id JOIN bases b ON b.id=c.base_id
        WHERE c.state='mastered' AND c.active=1 AND m.due<=?
        AND CASE WHEN json_valid(b.settings) THEN json_extract(b.settings,'$.review_enabled') ELSE 0 END=1
        ''' + scope + ' ORDER BY m.due,c.id LIMIT ?', params)}


def is_due(conn, card_id, current):
    row = conn.execute('SELECT base_id FROM review_cards WHERE id=?', (card_id,)).fetchone()
    return bool(row) and card_id in due_card_ids(conn, current, base_ids=[row['base_id']])


def record_grade(conn, card_id, history_id, grade, current):
    previous = get(conn, card_id)
    if previous is None:
        raise ValueError('A maintenance grade requires a schedule.')
    due = schedule_card(conn, card_id, current) if grade > 0 else None
    if grade > 0:
        conn.execute('UPDATE review_maintenance SET repetitions=repetitions+1,last_reviewed_at=? WHERE card_id=?',
                     (_stamp(current), card_id))
    else:
        conn.execute('DELETE FROM review_maintenance WHERE card_id=?', (card_id,))
    conn.execute('''INSERT INTO review_maintenance_events
        (history_id,card_id,reviewed_at,grade,previous_due,next_due,scheduler_version) VALUES (?,?,?,?,?,?,?)''',
        (history_id, card_id, _stamp(current), grade, previous['due'], due, SCHEDULER_VERSION))
    return due


def counts_for_base(conn, base_id, current, eligible_ids=None):
    if eligible_ids is None:
        eligible_ids = due_card_ids(conn, current, base_ids=[base_id])
    scheduled = conn.execute("""SELECT COUNT(*) FROM review_cards c JOIN review_maintenance m ON m.card_id=c.id
        WHERE c.base_id=? AND c.active=1 AND c.state='mastered'""", (base_id,)).fetchone()[0]
    due = 0
    if eligible_ids:
        due = conn.execute('SELECT COUNT(*) FROM review_cards WHERE base_id=? AND id IN (' +
            ','.join('?' for _ in eligible_ids) + ')', [base_id, *eligible_ids]).fetchone()[0]
    return {'maintenance_due': due, 'maintenance_scheduled': scheduled}
