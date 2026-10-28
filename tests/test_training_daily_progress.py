"""Daily programme effort uses the same dated, idempotent facts as the week."""
import copy
import json
from datetime import datetime, timezone

import db
import training_activity as activity
import training_native as native
import training_programs as programs
from test_training_programs import client, request, block, program, activate, run, review, reading
from test_training_native_tools import native_block


def test_free_work_is_automatically_counted_once_today_and_this_week(client):
    week = activate(client, program(client, [native_block('color')]))
    with db.get_conn() as conn:
        native.register(conn, 1, 'color', 'free-color')
        for duration, count in [(60000, 2), (60000, 2), (30000, 1), (90000, 3)]:
            native.record(conn, 1, 'color', 'free-color', duration_ms=duration, quantity=count)
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['duration_ms'] == result['today']['duration_ms'] == 90000
    assert result['attempts'] == result['today']['attempts'] == 3
    assert result['blocks'][0]['today']['attempts'] == 3
    assert result['blocks'][0]['progress']['sessions'] == 0
    assert result['unassigned'] == []
    assert result['activities'][0]['origin'] == 'automatic'
    assert result['activities'][0]['attempts'] == 3
    assert len(result['days']) == 7
    assert sum(day['attempts'] or 0 for day in result['days']) == 3


def test_daily_totals_split_new_increments_and_keep_weekly_totals(client, monkeypatch):
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 23, 16, tzinfo=timezone.utc))
    week = activate(client, program(client, [native_block('puzzles')]))
    with db.get_conn() as conn:
        native.register(conn, 1, 'puzzles', 'continued')
        native.record(conn, 1, 'puzzles', 'continued', duration_ms=60000, quantity=2)
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 25, 16, tzinfo=timezone.utc))
    with db.get_conn() as conn:
        native.record(conn, 1, 'puzzles', 'continued', duration_ms=150000, quantity=5)
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['duration_ms'] == 150000 and result['attempts'] == 5
    assert result['today']['duration_ms'] == 90000 and result['today']['attempts'] == 3
    friday = next(day for day in result['days'] if day['date'] == '2026-10-23')
    assert friday['duration_ms'] == 60000 and friday['attempts'] == 2
    assert result['blocks'][0]['today']['positions'] == 3


def test_native_write_prepares_new_week_at_the_configured_study_boundary(client, monkeypatch):
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences VALUES(?,?)', ('study_day', json.dumps({'timezone': 'America/Toronto', 'start_hour': 4})))
    week = activate(client, program(client, [native_block('coordinates')]))
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 7, 59, tzinfo=timezone.utc))
    with db.get_conn() as conn:
        native.register(conn, 1, 'coordinates', 'across-boundary')
        native.record(conn, 1, 'coordinates', 'across-boundary', duration_ms=1000, quantity=1)
    assert request(client, 'GET', '/weeks/' + week['id'])['today']['date'] == '2026-10-25'
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 8, 1, tzinfo=timezone.utc))
    with db.get_conn() as conn:
        native.record(conn, 1, 'coordinates', 'across-boundary', duration_ms=3000, quantity=2)
        new_week_id = conn.execute("SELECT id FROM training_weeks WHERE week_start='2026-10-26'").fetchone()['id']
    result = request(client, 'GET', '/weeks/' + new_week_id)
    assert result['today']['date'] == '2026-10-26'
    assert result['duration_ms'] == result['today']['duration_ms'] == 2000
    assert result['attempts'] == 1
    assert request(client, 'GET', '/weeks/' + week['id'])['duration_ms'] == 1000


def test_tool_started_before_opening_planning_applies_pending_activation(client, monkeypatch):
    activate(client, program(client))
    next_program = program(client, [native_block('color')])
    request(client, 'POST', '/programs/' + next_program['id'] + '/activate', {'expected_revision': next_program['revision'], 'effective': 'next_week'})
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 16, tzinfo=timezone.utc))
    with db.get_conn() as conn:
        native.register(conn, 1, 'color', 'monday')
        native.record(conn, 1, 'color', 'monday', duration_ms=3000, quantity=1)
        assert programs.active_program(conn, 1)['id'] == next_program['id']
        new_week_id = conn.execute('SELECT id FROM training_weeks WHERE program_id=?', (next_program['id'],)).fetchone()['id']
    result = request(client, 'GET', '/weeks/' + new_week_id)
    assert result['today']['attempts'] == 1 and result['unassigned'] == []


def test_ambiguous_assignment_moves_daily_effort_without_duplicating_it(client):
    week = activate(client, program(client, [native_block('color'), native_block('color')]))
    with db.get_conn() as conn:
        native.register(conn, 1, 'color', 'ambiguous')
        native.record(conn, 1, 'color', 'ambiguous', duration_ms=60000, quantity=2)
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['duration_ms'] is None
    free = result['unassigned'][0]
    for target in week['blocks']:
        free = request(client, 'PUT', '/activities/' + free['id'] + '/assignment', {'week_id': week['id'], 'block_id': target['id'], 'expected_revision': free['revision']})
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['duration_ms'] == 60000 and result['today']['attempts'] == 2
    assert result['blocks'][0]['today']['attempts'] is None
    assert result['blocks'][1]['today']['attempts'] == 2


def test_review_repetitions_count_as_attempts_but_preserve_card_goal(client):
    week = activate(client, program(client, [block(metric='quantity', target=3)]))
    execution = run(client, week)
    with db.get_conn() as conn:
        credit, history_id, card, key = review(conn, execution['id'])
        activity.record_review(conn, history_id=history_id, card=card, request_id=key, run_id=execution['id'])
        review(conn, execution['id'])
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['attempts'] == 2
    assert result['blocks'][0]['progress']['cards'] == 1
    assert result['blocks'][0]['today']['duration_ms'] == 24000


def test_automatically_assigned_work_can_finish_one_explicit_episode(client):
    week = activate(client, program(client, [native_block('guess', metric='sessions', target=2)]))
    with db.get_conn() as conn:
        native.register(conn, 1, 'guess', 'zero-time-answer')
        native.record(conn, 1, 'guess', 'zero-time-answer', duration_ms=0, quantity=0, attempts=1, finished=True)
    result = request(client, 'GET', '/weeks/' + week['id'])
    episode = request(client, 'POST', '/episodes', {'week_id': week['id'], 'block_id': week['blocks'][0]['id'], 'activity_ids': [result['activities'][0]['id']]})
    assert episode['sessions'] == 1 and episode['attempts'] == 1 and episode['duration_ms'] == 0
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['attempts'] == 1 and result['today']['sessions'] == 1


def test_reading_time_is_acquired_before_finishing_without_inventing_attempts(client):
    week = activate(client, program(client, [block('reading')]))
    with db.get_conn() as conn:
        reading(conn, receipt='daily-reading-receipt', seconds=20)
        reading(conn, receipt='daily-reading-receipt', seconds=20)
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['duration_ms'] == 20000
    assert result['today']['attempts'] is None and result['today']['sessions'] == 0


def test_manual_corrections_and_removed_blocks_keep_daily_totals_consistent(client):
    week = activate(client, program(client, [block('external', resource={'type': 'external', 'name': 'Club'})]))
    item = request(client, 'POST', '/manual-activities', {'week_id': week['id'], 'block_id': week['blocks'][0]['id'], 'date': '2026-10-25', 'duration_minutes': 20, 'sessions': 1})
    changed = request(client, 'PATCH', '/manual-activities/' + item['id'], {'expected_revision': item['revision'], 'duration_minutes': 10})
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['duration_ms'] == 600000 and result['today']['sessions'] == 1
    definition = copy.deepcopy(week['definition'])
    definition['blocks'] = []
    result = request(client, 'PATCH', '/weeks/' + week['id'], {'expected_revision': week['revision'], 'definition': definition})
    assert result['today']['duration_ms'] == result['unmatched']['duration_ms'] == 600000
    request(client, 'DELETE', '/manual-activities/' + item['id'], {'expected_revision': changed['revision']})
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['duration_ms'] is None and result['today']['sessions'] == 0


def test_migration_preserves_known_attempts_and_baselines_unknown_guess_counts(client):
    activate(client, program(client, [native_block('color'), native_block('guess')]))
    with db.get_conn() as conn:
        native.register(conn, 1, 'color', 'old-color')
        native.record(conn, 1, 'color', 'old-color', duration_ms=1000, quantity=2)
        native.register(conn, 1, 'guess', 'old-guess')
        native.record(conn, 1, 'guess', 'old-guess', duration_ms=1000, quantity=0, attempts=3)
        conn.execute('ALTER TABLE training_activity_credits DROP COLUMN attempts')
        conn.execute('ALTER TABLE training_native_sources DROP COLUMN attempts')
        programs.init_schema(conn)
        programs.init_schema(conn)
        color = next(item for item in activity.activities(conn, 1) if item['tool'] == 'color')
        guess = next(item for item in activity.activities(conn, 1) if item['tool'] == 'guess')
        assert color['attempts'] == 2 and guess['attempts'] is None
        native.record(conn, 1, 'guess', 'old-guess', duration_ms=2000, quantity=0, attempts=4)
        native.record(conn, 1, 'guess', 'old-guess', duration_ms=3000, quantity=0, attempts=5)
        assert activity.activity_document(conn, 1, guess['id'])['attempts'] == 1
