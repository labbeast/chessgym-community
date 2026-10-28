"""Activity totals remain independent of goals, programmes and attribution."""
import json
from uuid import uuid4

import db
import training_activity as a
import training_categories as categories
import training_native as native
import training_programs as p
from test_training_programs import client, request, block, program, activate, run, review, reading


def category(client, activity):
    return next(item for item in request(client, 'GET', '/overview')['categories'] if item['id'] == activity)


def test_empty_overview_has_every_category_and_read_does_not_create_programmes(client):
    result = request(client, 'GET', '/overview')
    assert [item['id'] for item in result['categories']] == list(p.ACTIVITIES)
    assert result['active_program'] is None and result['active_week'] is None
    assert result['duration_ms'] == 0
    assert all(item['progress']['duration_ms'] == 0 and not item['progress']['complete'] for item in result['categories'])
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM training_programs').fetchone()[0] == 0


def test_all_programmes_and_unassigned_activity_are_counted_once_without_list_limit(client):
    first = activate(client, program(client))
    episode = run(client, first)
    with db.get_conn() as conn:
        review(conn, episode['id'], seconds=60)
    activate(client, program(client, [block('reading')]))
    with db.get_conn() as conn:
        for index in range(120):
            review(conn, seconds=1, card_id='card-' + str(index))
        reading(conn, seconds=30)
    result = request(client, 'GET', '/overview')
    assert result['duration_ms'] == 210000
    review_category = next(item for item in result['categories'] if item['id'] == 'review')
    assert review_category['progress']['duration_ms'] == 180000
    assert review_category['today']['duration_ms'] == 180000
    assert review_category['target_minutes'] == 0
    assert review_category['progress']['complete'] is False
    assert len(review_category['resources']) == 1
    stats = request(client, 'GET', '/statistics?date_from=2026-10-19&date_to=2026-10-25')
    assert stats['totals']['duration_ms'] == result['duration_ms']
    assert stats['days'][-1]['by_activity']['review'] == 180000


def test_daily_and_weekly_goals_and_resume_use_distinct_remaining_time(client):
    value = block('coordinates', resource={'type': 'tool', 'id': 'coordinates'}, target=20,
                  session_minutes=5, unit='positions')
    week = activate(client, program(client, [value]))
    initial = category(client, 'coordinates')
    assert initial['target_minutes'] == 20
    assert initial['daily_target_minutes'] == 5
    with db.get_conn() as conn:
        native.register(conn, 1, 'coordinates', 'native-one')
        native.record(conn, 1, 'coordinates', 'native-one', duration_ms=60000, quantity=5, attempts=5)
    daily = request(client, 'POST', '/categories/coordinates/runs', {'goal_scope': 'today'})
    assert daily['launch']['minutes'] == 4
    assert daily['launch']['goal']['target'] == 5
    weekly = request(client, 'POST', '/categories/coordinates/runs', {'goal_scope': 'week', 'run_id': daily['id']})
    assert weekly['id'] == daily['id']
    assert weekly['launch']['minutes'] == 19
    assert weekly['launch']['goal']['target'] == 20
    old_route = request(client, 'POST', f"/weeks/{week['id']}/blocks/{value['id']}/runs", {'goal_scope': 'today'})
    # This source was not assigned to the old block, but its daily target is 5.
    assert old_route['launch']['goal']['target'] == 5


def test_zero_goals_persist_and_free_runs_do_not_need_a_programme(client):
    body = {'mutation_id': str(uuid4()), 'target_minutes': 20, 'daily_target_minutes': 5, 'expected_revision': 0}
    saved = request(client, 'PATCH', '/category-goals/coordinates', body)
    assert request(client, 'PATCH', '/category-goals/coordinates', body) == saved
    request(client, 'PATCH', '/category-goals/coordinates', {**body, 'mutation_id': str(uuid4())}, status=409)
    request(client, 'PATCH', '/category-goals/coordinates', {'target_minutes': 0, 'daily_target_minutes': 0, 'expected_revision': 1})
    result = request(client, 'POST', '/categories/coordinates/runs', {'goal_scope': 'today'})
    assert result['launch']['free'] is True
    assert result['launch']['minutes'] is None and 'goal' not in result['launch']
    assert request(client, 'GET', '/programs')['items'] == []
    with db.get_conn() as conn:
        native.register(conn, 1, 'coordinates', 'free', training_run_id=result['id'])
        native.record(conn, 1, 'coordinates', 'free', duration_ms=30000, quantity=3, attempts=3)
    values = category(client, 'coordinates')
    assert values['progress']['duration_ms'] == 30000
    assert values['today']['complete'] is False
    assert values['progress']['complete'] is False
    assert request(client, 'GET', '/overview')['active_program'] is None


def test_manual_without_programme_and_snapshot_survive_block_removal(client):
    created = request(client, 'POST', '/manual-activities', {'activity': 'analysis', 'date': '2026-10-25', 'duration_minutes': 7})
    assert created['activity'] == 'analysis'
    assert category(client, 'analysis')['progress']['duration_ms'] == 420000
    changed = request(client, 'PATCH', '/manual-activities/' + created['id'], {'expected_revision': 1, 'duration_minutes': 8})
    assert changed['activity'] == 'analysis'
    old_block = block('external', resource={'type': 'external', 'name': 'Book'}, unit='sessions')
    week = activate(client, program(client, [old_block]))
    declaration = request(client, 'POST', '/manual-activities', {'week_id': week['id'], 'block_id': old_block['id'], 'date': '2026-10-25', 'duration_minutes': 4})
    request(client, 'PATCH', '/weeks/' + week['id'], {'expected_revision': 1, 'definition': {**week['definition'], 'blocks': []}})
    assert category(client, 'external')['progress']['duration_ms'] == 240000
    request(client, 'PATCH', '/manual-activities/' + declaration['id'], {'expected_revision': 1, 'duration_minutes': 5})
    assert category(client, 'external')['progress']['duration_ms'] == 300000
    request(client, 'DELETE', '/manual-activities/' + created['id'], {'expected_revision': changed['revision']})
    assert category(client, 'analysis')['progress']['duration_ms'] == 0


def test_legacy_review_and_native_baseline_are_included_but_not_credited_twice(client):
    with db.get_conn() as conn:
        _, history_id, _, _ = review(conn, seconds=10)
        # Older native review answer not present in the credit ledger.
        conn.execute('''INSERT INTO review_history(card_id,reviewed_at,grade,proposed_grade,requested_grade,errors,hints,elapsed_ms,assisted,mode,interval_days,due)
            SELECT card_id,reviewed_at,grade,proposed_grade,requested_grade,errors,hints,20000,assisted,mode,interval_days,due FROM review_history WHERE id=?''', (history_id,))
        native.record(conn, 1, 'storm', 'legacy', duration_ms=30000, quantity=3, attempts=3)
        native.record(conn, 1, 'storm', 'legacy', duration_ms=45000, quantity=5, attempts=5)
    values = request(client, 'GET', '/overview')
    assert values['duration_ms'] == 75000
    assert category(client, 'review')['progress']['duration_ms'] == 30000
    assert category(client, 'puzzles')['progress']['duration_ms'] == 45000
    assert category(client, 'puzzles')['progress']['attempts'] == 5


def test_unknown_durations_are_preserved_and_accounts_are_scoped(client):
    with db.get_conn() as conn:
        link = a._link(conn, user_id=1, source_key='unknown-game', tool='computer', source_id='old', title='Old game')
        a._credit(conn, link, 'finished', quantity=1, unit='games')
        conn.execute('PRAGMA ignore_check_constraints=ON')
        conn.execute("INSERT INTO users VALUES(2,'second','unused','today')")
        conn.execute('PRAGMA ignore_check_constraints=OFF')
        other = a._link(conn, user_id=2, source_key='other', tool='analysis', source_id='other', title='Other')
        a._credit(conn, other, 'time', duration_ms=900000, duration_kind='active')
    values = request(client, 'GET', '/overview')
    assert values['duration_ms'] is None
    assert values['unknown_duration_count'] == 1
    assert category(client, 'computer')['progress']['duration_ms'] is None
    assert category(client, 'analysis')['progress']['duration_ms'] == 0
    request(client, 'GET', '/statistics?date_from=2026-10-26&date_to=2026-10-25', status=422)
    request(client, 'GET', '/statistics?date_from=2020-01-01&date_to=2026-10-25', status=422)


def test_credits_keep_their_accepted_study_date_after_preferences_change(client):
    with db.get_conn() as conn:
        link = a._link(conn, user_id=1, source_key='late', tool='analysis', source_id='late', title='Analysis')
        a._credit(conn, link, 'time', duration_ms=60000, duration_kind='active', recorded_at='2026-10-25T01:00:00+00:00')
        accepted = conn.execute('SELECT study_date FROM training_activity_credits WHERE activity_id=?', (link['id'],)).fetchone()[0]
        conn.execute("INSERT OR REPLACE INTO preferences(key,value) VALUES('study_day',?)", (json.dumps({'timezone': 'America/Toronto', 'start_hour': 4}),))
    stats = request(client, 'GET', '/statistics?date_from=2026-10-23&date_to=2026-10-26')
    assert next(day for day in stats['days'] if day['date'] == accepted)['by_activity']['analysis'] == 60000


def test_zero_minute_programme_target_is_valid_and_not_complete(client):
    week = activate(client, program(client, [block(target=0)]))
    assert week['blocks'][0]['progress']['complete'] is False
    values = category(client, 'review')
    assert values['target_minutes'] == 0 and values['daily_target_minutes'] == 0


def test_historical_tools_share_one_projection_and_tracked_time_wins_over_wall_clock(client):
    import puzzle_training
    import guess_move
    import training_skills
    import color_training
    from test_training_history import seed_puzzle, seed_skill, seed_color, seed_guess, insert, EPOCH, STAMP
    puzzle_training.init_puzzles()
    guess_move.init_guess_move()
    training_skills.init_training_skills()
    color_training.init_color_training()
    with db.get_conn() as conn:
        seed_puzzle(conn)
        seed_skill(conn, 'coordinates')
        seed_skill(conn, 'blindfold')
        seed_color(conn)
        seed_guess(conn)
        insert(conn, 'puzzle_storm', id='storm', configuration_name='Classic', color='white',
               status='completed', started_ms=int(EPOCH * 1000), deadline_ms=int((EPOCH + 60) * 1000),
               finished_at='2026-10-24T12:00:30+00:00', score=2, clock_started=1)
        native.register(conn, 1, 'storm', 'storm')
        native.record(conn, 1, 'storm', 'storm', duration_ms=12000, quantity=2, attempts=2, finished=True)
    values = request(client, 'GET', '/overview')
    mapping = {item['id']: item['progress']['duration_ms'] for item in values['categories']}
    assert mapping['puzzles'] == 17000  # 5s old puzzle + 12s accepted Storm, never its 30s wall clock.
    assert mapping['coordinates'] == 30000
    assert mapping['blindfold'] == 6000
    assert mapping['color'] == 30000
    assert mapping['guess'] == 4000
    assert values['duration_ms'] == 87000
    stats = request(client, 'GET', '/statistics?date_from=2026-10-24&date_to=2026-10-25')
    assert stats['totals']['duration_ms'] == 87000
    assert stats['days'][0]['by_activity']['puzzles'] == 5000
    assert stats['days'][1]['by_activity']['puzzles'] == 12000


def test_editing_manual_keeps_original_category_if_a_block_is_repurposed(client):
    old = block('reading', target=0)
    week = activate(client, program(client, [old]))
    declaration = request(client, 'POST', '/manual-activities', {'week_id': week['id'], 'block_id': old['id'], 'date': '2026-10-25', 'duration_minutes': 3})
    changed = {**week['definition']['blocks'][0], 'activity': 'review', 'unit': 'cards'}
    request(client, 'PATCH', '/weeks/' + week['id'], {'expected_revision': 1, 'definition': {**week['definition'], 'blocks': [changed]}})
    edited = request(client, 'PATCH', '/manual-activities/' + declaration['id'], {'expected_revision': 1, 'duration_minutes': 4})
    assert edited['activity'] == 'reading' and edited['unit'] == 'games'
    assert category(client, 'reading')['progress']['duration_ms'] == 240000
    assert category(client, 'review')['progress']['duration_ms'] == 0


def test_existing_quantity_run_can_resume_for_category_time_without_duplicate_native_work(client):
    value = block('coordinates', resource={'type': 'tool', 'id': 'coordinates'}, metric='quantity',
                  target=100, session_minutes=5, unit='positions')
    week = activate(client, program(client, [value]))
    original = run(client, week)
    request(client, 'PATCH', '/category-goals/coordinates', {'target_minutes': 20, 'daily_target_minutes': 5, 'expected_revision': 0})
    with db.get_conn() as conn:
        native.register(conn, 1, 'coordinates', 'existing', training_run_id=original['id'])
        native.record(conn, 1, 'coordinates', 'existing', duration_ms=120000, quantity=17, attempts=17)
    resumed = request(client, 'POST', '/categories/coordinates/runs', {'run_id': original['id'], 'goal_scope': 'today'})
    assert resumed['native_ref'] == {'tool': 'coordinates', 'id': 'existing'}
    assert resumed['launch']['goal']['metric'] == 'minutes'
    assert resumed['launch']['goal']['remaining'] == 3
    assert resumed['launch']['goal']['baseline_duration_ms'] == 120000
    with db.get_conn() as conn:
        native.record(conn, 1, 'coordinates', 'existing', duration_ms=180000, quantity=25, attempts=25)
        native.record(conn, 1, 'coordinates', 'existing', duration_ms=180000, quantity=25, attempts=25)
    latest = request(client, 'GET', '/runs/' + original['id'])
    continued = request(client, 'PATCH', '/runs/' + original['id'], {'action': 'resume', 'goal_scope': 'week', 'expected_revision': latest['revision']})
    assert continued['launch']['minutes'] == 17
    assert continued['launch']['goal']['baseline_duration_ms'] == 180000
    progress = category(client, 'coordinates')['progress']
    assert progress['duration_ms'] == 180000 and progress['attempts'] == 25
