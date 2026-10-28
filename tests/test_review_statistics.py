"""Statistics distinguish historical activity, current workload and local dates."""
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from local_test_client import TestClient

import app
import db
import review_statistics as stats
import training


@pytest.fixture
def clock(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'statistics.sqlite3')
    db.init_db()
    training.init_training()
    value = [datetime(2026, 10, 20, 16, tzinfo=timezone.utc)]
    monkeypatch.setattr(stats, 'now', lambda: value[0])
    monkeypatch.setattr(training, 'now', lambda: value[0])
    return value


def base(name='Cours', **settings):
    settings = {'review_enabled': True, 'type': 'solve', 'new_limit': 10, **settings}
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
                            (name, json.dumps(settings), training.stamp())).lastrowid


def cards(base_id, count=1):
    with db.get_conn() as conn:
        for index in range(count):
            conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES (?,?,?,?,?)''',
                         (base_id, f'Partie {index}', '1. e4 e5 2. Nf3 *', training.stamp(), training.stamp()))
    return training.queue(base_id, all=True)['cards']


def history(card, at, grade=2, elapsed=15000, assisted=False):
    at = at.isoformat() if isinstance(at, datetime) else at
    with db.get_conn() as conn:
        conn.execute('''INSERT INTO review_history(card_id,reviewed_at,grade,proposed_grade,requested_grade,
            errors,hints,elapsed_ms,assisted,mode,interval_days,due) VALUES (?,?,?,?,?,0,0,?,?,?,3,?)''',
            (card['id'], at, grade, grade, grade, elapsed, int(assisted), 'hybrid', at))


def schedule(card, at, state='learned', interval=3):
    at = at.isoformat() if isinstance(at, datetime) else at
    with db.get_conn() as conn:
        conn.execute('UPDATE review_cards SET state=?,due=?,interval_days=?,repetitions=2 WHERE id=?',
                     (state, at, interval, card['id']))


def update_base(base_id, **changes):
    with db.get_conn() as conn:
        old = conn.execute('SELECT settings FROM bases WHERE id=?', (base_id,)).fetchone()
        settings = json.loads(old['settings']) | changes
        conn.execute('UPDATE bases SET settings=? WHERE id=?', (json.dumps(settings), base_id))


def test_empty_statistics_are_complete_without_fake_activity(clock):
    result = stats.review_statistics(days=7, tz='America/Toronto')
    assert result['today'] == '2026-10-20'
    assert result['period'] == {'start': '2026-10-14', 'end': '2026-10-20', 'days': 7}
    assert result['summary']['today']['reviewed'] == 0
    assert result['summary']['period']['median_seconds'] is None
    assert result['summary']['period']['grade_counts'] == [0, 0, 0, 0]
    assert len(result['activity']) == 7 and len(result['forecast']['items']) == 30
    assert sum(item['count'] for item in result['activity']) == 0
    assert all(item['due'] == item['estimated_minutes'] == 0 for item in result['planner'])
    assert result['streak'] == {'current': 0, 'longest': 0, 'scope': 'period'}
    assert all(item['assumed'] and not item['sample_count'] for item in result['estimates']['by_type'])


def test_sync_new_cards_without_resetting_existing_schedule(clock):
    bid = base(type='moves')
    items = cards(bid)
    assert len(items) == 2
    schedule(items[0], clock[0] - timedelta(hours=1), interval=7)
    history(items[0], clock[0] - timedelta(hours=2))
    result = stats.review_statistics()
    assert {key: result['current'][key] for key in ('total', 'unseen', 'learned', 'due_now')} == {
        'total': 2, 'unseen': 1, 'learned': 1, 'due_now': 1}
    with db.get_conn() as conn:
        saved = conn.execute('SELECT * FROM review_cards WHERE id=?', (items[0]['id'],)).fetchone()
        assert saved['repetitions'] == 2 and saved['interval_days'] == 7
        assert saved['due'] == (clock[0] - timedelta(hours=1)).isoformat()
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 1


def test_local_today_and_period_exclude_future_and_before_start(clock):
    clock[0] = datetime(2026, 1, 15, 2, tzinfo=timezone.utc)
    card = cards(base())[0]
    history(card, '2026-01-14T23:00:00+00:00', grade=3, elapsed=9000)
    history(card, '2026-01-15T01:00:00+00:00', grade=0, elapsed=3000, assisted=True)
    history(card, '2026-01-08T04:59:59+00:00')  # Jan7 local, outside 7 days.
    history(card, '2026-01-08T05:00:00+00:00', grade=1, elapsed=0)
    history(card, '2026-01-15T03:00:00+00:00')  # Future data is not activity yet.
    result = stats.review_statistics(days=7, tz='America/Toronto')
    assert result['today'] == '2026-01-14'
    assert result['summary']['today']['reviewed'] == 2
    assert result['summary']['today']['grade_counts'] == [1, 0, 0, 1]
    assert result['summary']['period']['reviewed'] == 3
    assert result['summary']['period']['unique_cards'] == 1
    assert result['summary']['period']['assisted'] == 1
    assert result['summary']['period']['elapsed_ms'] == 12000
    assert result['summary']['period']['days_studied'] == 2


@pytest.mark.parametrize('today,earlier,just_before,next_midnight', [
    ('2026-03-08T07:30:00+00:00', '2026-03-08T04:59:59+00:00', '2026-03-09T03:59:59+00:00', '2026-03-09T04:00:00+00:00'),
    ('2026-11-01T07:30:00+00:00', '2026-11-01T03:59:59+00:00', '2026-11-02T04:59:59+00:00', '2026-11-02T05:00:00+00:00'),
])
def test_forecast_uses_local_calendar_across_dst(clock, today, earlier, just_before, next_midnight):
    clock[0] = datetime.fromisoformat(today)
    items = cards(base(), count=3)
    for card, due in zip(items, (earlier, just_before, next_midnight)):
        schedule(card, due)
    result = stats.review_statistics(tz='America/Toronto')
    assert result['current']['overdue'] == result['forecast']['overdue'] == 1
    assert [item['count'] for item in result['forecast']['items'][:2]] == [1, 1]
    assert sum(item['count'] for item in result['forecast']['items']) + result['forecast']['overdue'] == 3


def test_cumulative_planner_excludes_unseen_and_includes_each_deadline_once(clock):
    items = cards(base(), count=7)
    hours = [-30, -1, 0.5, 3, 23, 167]
    for card, offset in zip(items, hours):
        schedule(card, clock[0] + timedelta(hours=offset))
    # Even a malformed unseen card with a due date is not a scheduled review.
    schedule(items[-1], clock[0] - timedelta(days=5), state='unseen')
    result = stats.review_statistics()
    assert [item['due'] for item in result['planner']] == [2, 3, 4, 5, 5, 6]
    assert result['current']['due_now'] == 2
    assert result['forecast']['overdue'] == 1
    assert sum(item['count'] for item in result['forecast']['items']) == 5
    assert sum(item['count'] for item in result['intervals']) == 6
    assert result['planner'][0]['estimated_minutes'] == 1.5
    assert result['planner'][0]['assumed_cards'] == 2


def test_inactive_and_disabled_history_remains_but_workload_does_not(clock):
    enabled = base('Actif')
    inactive, active = cards(enabled, count=2)
    disabled = base('Désactivé')
    old = cards(disabled)[0]
    hidden = base('Jamais révisable', review_enabled=False)
    for card in (inactive, active, old):
        history(card, clock[0], elapsed=1000)
        schedule(card, clock[0] - timedelta(hours=1))
    update_base(disabled, review_enabled=False)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=0 WHERE id=?', (inactive['entry_id'],))
    result = stats.review_statistics()
    assert result['current']['total'] == result['current']['due_now'] == 1
    assert result['summary']['period']['reviewed'] == 3
    assert {row['id'] for row in result['filters']['bases']} == {enabled, disabled}
    assert hidden not in {row['base_id'] for row in result['by_base']}
    selected = stats.review_statistics(base_id=disabled)
    assert selected['current']['total'] == 0 and selected['summary']['period']['reviewed'] == 1
    assert selected['by_base'][0]['review_enabled'] is False
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=?', (disabled,))
    assert stats.review_statistics()['summary']['period']['reviewed'] == 2


def test_new_availability_ignores_legacy_quota_and_excludes_inactive_cards(clock):
    clock[0] = datetime(2026, 1, 15, 2, tzinfo=timezone.utc)
    bid = base(new_limit=2)
    items = cards(bid, count=4)
    history(items[0], '2026-01-15T01:00:00+00:00')
    schedule(items[0], clock[0] + timedelta(days=1))
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=0 WHERE id=?', (items[0]['entry_id'],))
    history(items[1], '2026-01-14T23:00:00+00:00')
    schedule(items[1], clock[0] + timedelta(days=1))
    result = stats.review_statistics(tz='America/Toronto')
    assert result['current']['unseen'] == 2
    assert result['current']['new_available_today'] == 2
    assert result['current']['quota_resets_at'] == '2026-01-16T00:00:00+00:00'
    assert result['current']['quota_timezone'] == 'UTC'
    assert len(training.queue(bid)['cards']) == 2
    assert result['summary']['today']['reviewed'] == 2


def test_time_estimates_use_positive_recent_median_per_type_and_filtered_scope(clock):
    moves = cards(base('Ouverture', type='moves'))[0]
    solve_base = base('Puzzle')
    solve = cards(solve_base)[0]
    play = cards(base('Finale', type='play'))[0]
    for card in (moves, solve, play):
        schedule(card, clock[0] - timedelta(hours=1))
    for elapsed in (0, 10000, 20000, 500000):
        history(moves, clock[0] - timedelta(days=30), elapsed=elapsed)
    history(moves, clock[0] - timedelta(days=91), elapsed=999999)
    history(solve, clock[0] - timedelta(days=1), elapsed=60000)
    result = stats.review_statistics(days=7)
    estimates = {row['type']: row for row in result['estimates']['by_type']}
    assert estimates['moves'] == {'type': 'moves', 'seconds': 20.0, 'sample_count': 3, 'assumed': False}
    assert estimates['solve']['seconds'] == 60 and estimates['solve']['sample_count'] == 1
    assert estimates['play']['seconds'] == 120 and estimates['play']['assumed'] is True
    assert result['planner'][0]['estimated_minutes'] == pytest.approx(3.33)
    assert result['planner'][0]['assumed_cards'] == 1
    assert result['summary']['period']['reviewed'] == 1
    filtered = stats.review_statistics(base_id=solve_base)
    assert filtered['current']['total'] == 1
    assert filtered['summary']['period']['reviewed'] == 1
    assert filtered['estimates']['by_type'][0]['assumed'] is True
    assert filtered['planner'][0]['estimated_minutes'] == 1


def test_positive_short_time_estimate_is_not_rounded_to_zero(clock):
    card = cards(base())[0]
    history(card, clock[0], elapsed=1)
    schedule(card, clock[0])
    result = stats.review_statistics()
    assert result['planner'][0]['estimated_minutes'] > 0
    assert result['estimates']['by_type'][1]['seconds'] == 0.001


@pytest.mark.parametrize('offsets,current,longest', [([0, 1, 2, 5], 3, 3), ([1, 2, 4, 5, 6], 2, 3), ([2, 3, 4], 0, 3), ([], 0, 0)])
def test_streak_counts_days_not_reviews_and_accepts_yesterday(clock, offsets, current, longest):
    card = cards(base())[0]
    for offset in offsets:
        for repeat in range(2):
            history(card, clock[0] - timedelta(days=offset, minutes=repeat))
    result = stats.review_statistics(days=7)
    assert result['streak'] == {'current': current, 'longest': longest, 'scope': 'period'}


def test_interval_bucket_boundaries_use_reviewed_active_cards(clock):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO preferences VALUES('auto_mastery_days','720')")
    intervals = [0.1, 1, 6.99, 7, 29.99, 30, 89.99, 90, 365]
    items = cards(base(), count=len(intervals) + 1)
    for card, interval in zip(items, intervals):
        schedule(card, clock[0], interval=interval)
    assert [row['count'] for row in stats.review_statistics()['intervals']] == [1, 2, 2, 2, 2]


@pytest.fixture
def browser(clock):
    # No lifespan worker is needed; all requests use this fixture's private database.
    client = TestClient(app.app, base_url='http://localhost')
    yield client
    client.close()


def local_profile(client):
    assert client.get('/api/status').json()['local_mode'] is True


def test_endpoint_requires_local_access_and_accepts_numeric_query_parameters(browser):
    assert browser.get('/api/reviews/statistics?days=90', headers={'Host': 'remote.invalid'}).status_code == 403
    local_profile(browser)
    bid = base()
    cards(bid)
    response = browser.get(f'/api/reviews/statistics?base_id={bid}&days=30&tz=America%2FToronto')
    assert response.status_code == 200, response.text
    assert response.json()['filters']['base_id'] == bid
    assert response.json()['filters']['days'] == 30
    assert browser.get('/api/reviews/statistics').status_code == 200


@pytest.mark.parametrize('query,status', [
    ('days=14', 422), ('days=abc', 422), ('base_id=0', 422), ('base_id=-1', 422),
    ('base_id=999', 404), ('base_id=abc', 422), ('tz=Not/AZone', 422), ('tz=', 422), ('tz=../UTC', 422),
])
def test_endpoint_rejects_invalid_filters_before_sync(browser, query, status):
    local_profile(browser)
    bid = base()
    with db.get_conn() as conn:
        conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES (?,?,?,?,?)''',
                     (bid, 'Non synchronisé', '1. e4 *', training.stamp(), training.stamp()))
    response = browser.get('/api/reviews/statistics?' + query)
    assert response.status_code == status, response.text
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_cards').fetchone()[0] == 0


def test_mastered_cards_stay_learned_without_due_workload_or_fake_activity(clock):
    bid = base()
    learned, learning, mastered, pending_mastered, unscheduled_mastered, unseen = cards(bid, count=6)
    schedule(learned, clock[0] - timedelta(hours=1), interval=7)
    schedule(learning, clock[0] + timedelta(days=1), state='learning', interval=1)
    # Defensively exclude old due dates even if an older client left them behind.
    schedule(mastered, clock[0] - timedelta(days=5), state='mastered', interval=180)
    schedule(pending_mastered, clock[0] + timedelta(days=3), state='mastered', interval=720)
    schedule(unscheduled_mastered, None, state='mastered', interval=0)
    history(mastered, clock[0] - timedelta(days=1), grade=2, elapsed=30000)
    result = stats.review_statistics(base_id=bid)
    expected = {'total': 6, 'unseen': 1, 'learning': 1, 'learned': 4, 'mastered': 3,
                'due_now': 1, 'overdue': 0, 'new_available_today': 1,
                'maintenance_due': 0, 'maintenance_scheduled': 3}
    assert {key: result['current'][key] for key in stats.COUNT_FIELDS} == expected
    assert {key: result['by_base'][0]['current'][key] for key in stats.COUNT_FIELDS} == expected
    assert result['by_base'][0]['current']['progress_counts'] == {'mastered': 3, 'learned': 0, 'due': 1, 'unlearned': 2}
    assert result['current']['unseen'] + result['current']['learning'] + result['current']['learned'] == 6
    assert [item['due'] for item in result['planner']] == [1, 1, 1, 2, 2, 2]
    assert result['forecast']['overdue'] == 0
    assert sum(item['count'] for item in result['forecast']['items']) == 2
    assert sum(item['count'] for item in result['intervals']) == 2
    assert result['summary']['period']['reviewed'] == 1
    assert result['summary']['period']['grade_counts'] == [0, 0, 1, 0]
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM review_cards WHERE state='mastered'").fetchone()[0] == 3


def test_mastered_activity_remains_for_inactive_cards_and_disabled_bases(clock):
    active_base = base('Actif')
    inactive, active = cards(active_base, count=2)
    disabled_base = base('Désactivé')
    disabled = cards(disabled_base)[0]
    for card in (inactive, active, disabled):
        schedule(card, clock[0] - timedelta(days=2), state='mastered')
        history(card, clock[0] - timedelta(hours=1))
    update_base(disabled_base, review_enabled=False)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=0 WHERE id=?', (inactive['entry_id'],))
    result = stats.review_statistics()
    assert result['current']['total'] == result['current']['learned'] == result['current']['mastered'] == 1
    assert result['current']['due_now'] == result['current']['overdue'] == 0
    assert result['summary']['period']['reviewed'] == 3
    assert all(item['due'] == 0 for item in result['planner'])
    assert sum(item['count'] for item in result['forecast']['items']) == 0
    assert sum(item['count'] for item in result['intervals']) == 0
    filtered = stats.review_statistics(base_id=disabled_base)
    assert filtered['current']['total'] == filtered['current']['mastered'] == filtered['current']['learned'] == 0
    assert filtered['summary']['period']['reviewed'] == 1
