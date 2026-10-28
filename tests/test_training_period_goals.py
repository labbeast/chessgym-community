"""Scoped resumes budget only the work still needed for the chosen period."""
import copy
from datetime import datetime, timezone
from uuid import uuid4

import pytest

import db
import training_programs as programs
from test_training_programs import client, request, block, program, activate, run, review
from test_training_native_tools import native_block


def declared(client, week, day, **values):
    return request(client, 'POST', '/manual-activities', {
        'week_id': week['id'], 'block_id': week['blocks'][0]['id'], 'date': day, **values})


def start(client, week, scope):
    return request(client, 'POST', f"/weeks/{week['id']}/blocks/{week['blocks'][0]['id']}/runs",
                   {'goal_scope': scope})


def test_create_goals_use_today_or_week_credits_without_changing_them(client):
    week = activate(client, program(client, [block(target=20)]))
    declared(client, week, '2026-10-23', duration_minutes=6)
    declared(client, week, '2026-10-25', duration_minutes=3)
    before = request(client, 'GET', '/weeks/' + week['id'])
    today, weekly = start(client, week, 'today'), start(client, week, 'week')
    # A block's daily time target is its session duration (15), while the
    # weekly target remains 20. Each period deducts only its own accepted work.
    assert today['launch']['minutes'] == 12 and weekly['launch']['minutes'] == 11
    assert today['launch']['goal'] == {
        'scope': 'today', 'study_date': '2026-10-25', 'week_start': '2026-10-19',
        'metric': 'minutes', 'unit': 'minutes', 'target': 15, 'realized': 3, 'remaining': 12,
        'baseline_duration_ms': 0, 'baseline_quantity': 0, 'baseline_sessions': 0}
    after = request(client, 'GET', '/weeks/' + week['id'])
    assert after['duration_ms'] == before['duration_ms'] == 540000
    assert after['today']['duration_ms'] == before['today']['duration_ms'] == 180000
    assert after['activities'] == before['activities']


def test_scoped_minutes_keep_fractional_remaining_and_do_not_cap_weekly_target(client):
    week = activate(client, program(client, [block(target=20)]))
    declared(client, week, '2026-10-25', duration_minutes=14.75)
    assert start(client, week, 'today')['launch']['minutes'] == .25
    large = activate(client, program(client, [block(target=500)]))
    assert start(client, large, 'week')['launch']['minutes'] == 500


def test_resume_snapshots_run_baseline_and_exact_receipt_without_recounting(client):
    week = activate(client, program(client, [block(target=20)]))
    execution = run(client, week)
    with db.get_conn() as conn:
        review(conn, execution['id'], seconds=360, at='2026-10-23T16:00:00+00:00', card_id='friday')
        review(conn, execution['id'], seconds=180, card_id='sunday')
    paused = request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'pause', 'expected_revision': execution['revision']})
    body = {'action': 'resume', 'goal_scope': 'today', 'expected_revision': paused['revision'], 'mutation_id': str(uuid4())}
    resumed = request(client, 'PATCH', '/runs/' + execution['id'], body)
    goal = resumed['launch']['goal']
    assert resumed['id'] == execution['id'] and resumed['native_ref'] == execution['native_ref']
    assert resumed['block'] == execution['block']
    assert resumed['duration_ms'] == goal['baseline_duration_ms'] == 540000
    assert resumed['quantity'] == goal['baseline_quantity'] == 2
    assert goal['target'] == 15
    assert goal['remaining'] == resumed['launch']['minutes'] == 12
    with db.get_conn() as conn:
        review(conn, execution['id'], seconds=60, card_id='more-work')
    assert request(client, 'PATCH', '/runs/' + execution['id'], body) == resumed
    latest = request(client, 'GET', '/runs/' + execution['id'])
    assert latest['duration_ms'] == 600000 and latest['launch']['goal'] == goal
    weekly = request(client, 'PATCH', '/runs/' + execution['id'], {
        'action': 'resume', 'goal_scope': 'week', 'expected_revision': latest['revision']})
    assert weekly['launch']['goal']['remaining'] == 10
    assert weekly['launch']['goal']['baseline_duration_ms'] == 600000
    # An ordinary resume preserves the previously selected allowance.
    ordinary = request(client, 'PATCH', '/runs/' + execution['id'], {
        'action': 'resume', 'expected_revision': weekly['revision']})
    assert ordinary['launch'] == weekly['launch']


@pytest.mark.parametrize('definition', [
    block(metric='quantity', target=5),
    block('reading', metric='quantity', target=5),
    native_block('puzzles', metric='quantity', target=5),
])
def test_quantity_goals_use_the_block_unit_and_have_no_competing_timer(client, definition):
    week = activate(client, program(client, [definition]))
    declared(client, week, '2026-10-23', quantity=2)
    declared(client, week, '2026-10-25', quantity=1)
    today, weekly = start(client, week, 'today'), start(client, week, 'week')
    assert today['launch']['goal']['remaining'] == 4
    assert weekly['launch']['goal']['remaining'] == 2
    assert today['launch']['goal']['unit'] == definition['unit']
    assert today['launch']['minutes'] is None and weekly['launch']['minutes'] is None


def test_card_goal_counts_distinct_cards_not_repeated_answers(client):
    week = activate(client, program(client, [block(metric='quantity', target=5)]))
    execution = run(client, week)
    with db.get_conn() as conn:
        review(conn, execution['id'], card_id='a', at='2026-10-23T16:00:00+00:00')
        review(conn, execution['id'], card_id='b', at='2026-10-23T16:00:00+00:00')
        review(conn, execution['id'], card_id='c')
        review(conn, execution['id'], card_id='c')
        review(conn, execution['id'], card_id='a')
    resumed = request(client, 'PATCH', '/runs/' + execution['id'], {
        'action': 'resume', 'goal_scope': 'today', 'expected_revision': execution['revision']})
    assert resumed['attempts'] == 5 and resumed['quantity'] == 3
    assert resumed['launch']['goal']['realized'] == 1
    assert resumed['launch']['goal']['remaining'] == 4
    assert resumed['launch']['goal']['baseline_quantity'] == 3


def test_sessions_keep_episode_timer_without_turning_sessions_into_exercises(client):
    week = activate(client, program(client, [block(metric='sessions', target=4, session_minutes=15)]))
    declared(client, week, '2026-10-23', sessions=1)
    declared(client, week, '2026-10-25', sessions=1)
    today, weekly = start(client, week, 'today'), start(client, week, 'week')
    assert today['launch']['goal']['unit'] == 'sessions'
    assert today['launch']['goal']['remaining'] == 3
    assert weekly['launch']['goal']['remaining'] == 2
    assert today['launch']['minutes'] == weekly['launch']['minutes'] == 15


def test_scope_errors_leave_run_and_credits_unchanged(client, monkeypatch):
    week = activate(client, program(client, [block(target=20)]))
    execution = run(client, week)
    for payload in [
        {'action': 'resume', 'goal_scope': 'month'},
        {'action': 'resume', 'goal_scope': None},
        {'action': 'pause', 'goal_scope': 'today'},
    ]:
        request(client, 'PATCH', '/runs/' + execution['id'], {
            **payload, 'expected_revision': execution['revision']}, status=422)
    declared(client, week, '2026-10-25', duration_minutes=20)
    request(client, 'PATCH', '/runs/' + execution['id'], {
        'action': 'resume', 'goal_scope': 'today', 'expected_revision': execution['revision']}, status=409)
    request(client, 'POST', f"/weeks/{week['id']}/blocks/{week['blocks'][0]['id']}/runs",
            {'goal_scope': 'week'}, status=409)
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 16, tzinfo=timezone.utc))
    request(client, 'PATCH', '/runs/' + execution['id'], {
        'action': 'resume', 'goal_scope': 'today', 'expected_revision': execution['revision']}, status=409)
    assert request(client, 'GET', '/runs/' + execution['id']) == execution


def test_scope_uses_current_target_but_rejects_a_changed_native_configuration(client):
    week = activate(client, program(client, [block(target=20)]))
    execution = run(client, week)
    definition = copy.deepcopy(week['definition'])
    definition['blocks'][0].update(metric='quantity', target=5)
    week = request(client, 'PATCH', '/weeks/' + week['id'], {'definition': definition, 'expected_revision': week['revision']})
    resumed = request(client, 'PATCH', '/runs/' + execution['id'], {
        'action': 'resume', 'goal_scope': 'week', 'expected_revision': execution['revision']})
    assert resumed['block']['metric'] == 'minutes'
    assert resumed['launch']['goal']['metric'] == 'quantity' and resumed['launch']['goal']['remaining'] == 5
    definition['blocks'][0]['activity'] = 'reading'
    definition['blocks'][0]['unit'] = 'games'
    definition['blocks'][0]['options'] = {}
    request(client, 'PATCH', '/weeks/' + week['id'], {'definition': definition, 'expected_revision': week['revision']})
    request(client, 'PATCH', '/runs/' + execution['id'], {
        'action': 'resume', 'goal_scope': 'week', 'expected_revision': resumed['revision']}, status=409)
    assert request(client, 'GET', '/runs/' + execution['id']) == resumed
