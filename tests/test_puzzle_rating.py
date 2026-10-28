"""Numerical reference, convergence, and durable Glicko-2 integration."""
import json
import math

import pytest

import blindfold_rating
import db
import puzzle_rating as rating
import puzzle_training as puzzles
from test_puzzle_training import store, start, action
from test_training_skills import client, ok
from test_blindfold_rating import mate, start as blind_start, solve, finish


def test_glickman_published_three_opponent_example():
    r, rd, sigma = rating.calculate(1500, 200, .06,
        [(1400, 30, 1), (1550, 100, 0), (1700, 300, 0)], tau=.5)
    assert r == pytest.approx(1464.05, abs=.01)
    assert rd == pytest.approx(151.52, abs=.01)
    assert sigma == pytest.approx(.059996, abs=.000001)


@pytest.mark.parametrize('success', [True, False])
def test_initial_changes_are_large_and_settled_changes_are_small(success):
    fresh = rating.rate_puzzle({'rating': 1500}, 1500, success, now=1)
    settled = rating.rate_puzzle({'rating': 1500, 'rating_deviation': 45,
                                  'volatility': .09}, 1500, success, now=1)
    assert abs(fresh['rating'] - 1500) > 200
    assert abs(settled['rating'] - 1500) < 10
    assert fresh['rating_deviation'] < 500
    assert (fresh['rating'] > 1500) == success


def test_repeated_comparable_results_converge_and_reduce_uncertainty():
    state = {'rating': 1500}
    changes = []
    for i in range(80):
        updated = rating.rate_puzzle(state, 1500, i % 2 == 0, now=i)
        changes.append(abs(updated['rating'] - state['rating']))
        state = updated
    assert 1450 < state['rating'] < 1550
    assert state['rating_deviation'] < 110
    assert not rating.public_profile(state, now=80)['provisional']
    assert sum(changes[-10:]) < sum(changes[:10]) / 5


def test_established_high_performer_calibrates_in_few_attempts():
    state = {'rating': 1500}
    for i in range(5):
        state = rating.rate_puzzle(state, state['rating'], True, now=i)
    assert state['rating'] > 2100


def test_inactivity_increases_uncertainty_without_mutating_or_resetting_rating():
    profile = {'rating': 1900, 'rating_deviation': 60, 'volatility': .09,
               'last_rated_at': 1, 'rated_count': 300}
    after = rating.public_profile(profile, now=1 + 365 * 86400)
    assert after['rating_deviation'] == pytest.approx(math.sqrt(60**2 + 365 * .21436 * (173.7178 * .09)**2))
    assert after['rating_deviation'] > 110 and after['provisional']
    assert after['rating'] == profile['rating'] == 1900
    assert profile['rating_deviation'] == 60
    assert rating.live_deviation(profile, now=0) == 60
    assert rating.live_deviation(profile, now=10**12) == 500


@pytest.mark.parametrize('mode', ['opening', 'positions'])
def test_provisional_depends_on_uncertainty_instead_of_attempt_count(client, mode):
    with db.get_conn() as conn:
        conn.execute('''INSERT INTO blindfold_profiles(user_id,mode,rating,rated_count,rating_deviation)
                        VALUES(1,?,1500,200,200)''', (mode,))
        assert blindfold_rating.profiles(conn, 1)[mode]['provisional']
        conn.execute('UPDATE blindfold_profiles SET rated_count=1,rating_deviation=60 WHERE mode=?', (mode,))
        assert not blindfold_rating.profiles(conn, 1)[mode]['provisional']


def test_opponent_uncertainty_and_selected_themes_are_weighted_like_lichess():
    assert rating.puzzle_weight([], True, 45) == 1
    assert rating.puzzle_weight([], False, 110) == pytest.approx(.3)
    assert rating.puzzle_weight(['mateIn1'], True, 45) == .1
    assert rating.puzzle_weight(['mateIn2'], True, 45) == .2
    assert rating.puzzle_weight(['backRankMate'], True, 45) == .1
    assert rating.puzzle_weight(['fork'], True, 45) == .2
    assert rating.puzzle_weight(['endgame'], False, 45) == .8
    known = rating.rate_puzzle({'rating': 1500}, 1500, False, opponent_rd=45)
    uncertain = rating.rate_puzzle({'rating': 1500}, 1500, False, opponent_rd=400)
    assert abs(uncertain['rating'] - 1500) < abs(known['rating'] - 1500)


@pytest.mark.parametrize('before,opponent,success,minimum,maximum', [
    (400, 4000, False, 400, 4000), (4000, 400, True, 400, 4000),
    (500, 3000, False, 500, 3000), (3000, 500, True, 500, 3000),
    (400, 4000, True, 400, 4000), (4000, 400, False, 400, 4000),
])
def test_extreme_results_remain_finite_and_bounded(before, opponent, success, minimum, maximum):
    state = rating.rate_puzzle({'rating': before}, opponent, success, minimum=minimum, maximum=maximum)
    assert minimum <= state['rating'] <= maximum
    assert abs(state['rating'] - before) <= 700
    assert 45 <= state['rating_deviation'] <= 500
    assert 0 < state['volatility'] <= .1
    assert all(math.isfinite(v) for v in state.values())


def test_classic_grade_persists_glicko_state_and_request_retry_is_identical(store):
    a = start()
    r = action(a, 'd7d5')
    with db.get_conn() as conn:
        before = dict(conn.execute('SELECT * FROM puzzle_profile').fetchone())
    replay = puzzles.play_move(a['id'], puzzles.Action(request_id='request-01', version=0, move='d7d5'))
    assert replay == r
    puzzles.init_puzzles()
    with db.get_conn() as conn:
        assert dict(conn.execute('SELECT * FROM puzzle_profile').fetchone()) == before
    profile = puzzles.overview()['profile']
    assert profile['rating_system'] == 'glicko2'
    assert profile['rating_deviation'] == pytest.approx(r['attempt']['rating_deviation'], abs=.01)
    assert before['volatility'] != .09 and before['last_rated_at'] > 0


def test_classic_theme_selection_is_snapshotted_for_rating(store):
    selected = puzzles.start_attempt(puzzles.StartAttempt(filters=puzzles.Filters(themes=['fork'])))
    with db.get_conn() as conn:
        snapshot = json.loads(conn.execute('SELECT snapshot FROM puzzle_attempts WHERE id=?', (selected['id'],)).fetchone()[0])
    assert snapshot['rating_themes'] == ['fork']


def test_legacy_classic_rating_below_lichess_floor_still_loses_on_failure(store):
    with db.get_conn() as conn:
        conn.execute('UPDATE puzzle_profile SET rating=250 WHERE id=1')
    failed = action(start(), 'd7d5')['attempt']
    assert 100 <= failed['rating_after'] < failed['rating_before'] == 250


def test_blindfold_uses_same_glicko_calculation_and_preserves_mode_isolation(client, mate):
    session = blind_start(client)
    solve(client, session)
    result = finish(client, session)['result']
    expected = rating.rate_puzzle({'rating': 500}, result['exercise_rating'], True,
                                  minimum=500, maximum=3000)
    profiles = ok(client.get('/api/skills/blindfold/overview'))['profiles']
    state = profiles['positions']
    assert state['rating'] == pytest.approx(expected['rating'])
    assert state['rating'] - 500 > 200
    assert state['rating_deviation'] == pytest.approx(expected['rating_deviation'], abs=.01)
    assert profiles['opening']['rating'] == 500 and profiles['opening']['rating_deviation'] == 500


@pytest.mark.parametrize('table', ['puzzle_profile', 'blindfold_profiles'])
def test_legacy_schema_migration_preserves_rating_counts_and_settings(table):
    import sqlite3
    with sqlite3.connect(':memory:') as conn:
        conn.row_factory = sqlite3.Row
        conn.execute(f'CREATE TABLE {table}(rating REAL,rated_count INTEGER,settings TEXT)')
        conn.execute(f'INSERT INTO {table} VALUES(1823.5,47,?)', ('{"kept":true}',))
        rating.init_profile(conn, table)
        rating.init_profile(conn, table)
        row = dict(conn.execute(f'SELECT * FROM {table}').fetchone())
        assert row == {'rating': 1823.5, 'rated_count': 47, 'settings': '{"kept":true}',
                       'rating_deviation': 500, 'volatility': .09, 'last_rated_at': None}
