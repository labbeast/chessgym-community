"""Global review defaults are validated and snapshotted only into new bases."""
import json
import sqlite3

import pytest
from fastapi import HTTPException
from local_test_client import TestClient

import app
import db
import review_preferences
import training


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'preferences.sqlite3')
    db.init_db()
    training.init_training()

    client = TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000))
    response = client.get('/api/status')
    assert response.status_code == 200, response.text
    yield client
    client.close()


def test_default_response_partial_merge_language_and_restart(owner):
    initial = owner.get('/api/preferences').json()
    assert initial['language'] == 'fr' and initial['auto_mastery_days'] == 180
    assert initial['review_defaults'] == review_preferences.DEFAULT_REVIEW_SETTINGS
    assert owner.get('/api/status').json()['capabilities']['review_preferences'] is True
    response = owner.patch('/api/preferences', json={'review_defaults': {'again': 20, 'hard': 3, 'new_limit': 7}, 'language': 'en'})
    assert response.status_code == 200, response.text
    assert response.json()['review_defaults'] == {'again': 20, 'hard': 3, 'medium': 5, 'easy': 10, 'new_limit': 7}
    response = owner.patch('/api/preferences', json={'review_defaults': {'easy': 12, 'new_limit': ''}})
    assert response.json()['review_defaults'] == {'again': 20, 'hard': 3, 'medium': 5, 'easy': 12, 'new_limit': None}
    db.init_db()
    assert owner.get('/api/preferences').json()['language'] == 'en'
    assert owner.get('/api/preferences').json()['review_defaults'] == response.json()['review_defaults']


def test_new_bases_snapshot_defaults_but_existing_values_and_explicit_overrides_survive(owner):
    old = owner.post('/api/bases', json={'name': 'Existing'}).json()
    assert old['settings']['hard'] == 2 and old['settings']['new_limit'] is None
    assert owner.patch('/api/preferences', json={'review_defaults': {'hard': 4, 'medium': 8, 'new_limit': 11}}).status_code == 200
    new = owner.post('/api/bases', json={'name': 'New', 'settings': {'easy': 22, 'new_limit': 0}}).json()
    assert new['settings']['hard'] == 4 and new['settings']['medium'] == 8
    assert new['settings']['easy'] == 22 and new['settings']['new_limit'] == 0
    changed = owner.patch('/api/bases/' + str(old['id']), json={'name': 'Renamed'}).json()
    assert changed['settings']['hard'] == 2 and changed['settings']['medium'] == 5
    assert changed['settings']['new_limit'] is None
    assert owner.patch('/api/preferences', json={'review_defaults': {'hard': 9}}).status_code == 200
    still_new = owner.patch('/api/bases/' + str(new['id']), json={'name': 'Also renamed'}).json()
    assert still_new['settings']['hard'] == 4


def test_preference_validation_is_atomic_and_authenticated(owner):
    before = owner.get('/api/preferences').json()
    for patch in [
        {'language': 'unsupported', 'theme': 'sage'},
        {'theme': 'sage', 'auto_mastery_days': True},
        {'auto_mastery_days': 90, 'review_defaults': {'unknown': 1}},
        {'review_defaults': {'new_limit': 1.2}},
        {'auto_mastery_days': 180.0},
    ]:
        response = owner.patch('/api/preferences', json=patch)
        assert response.status_code == 400, response.text
        assert owner.get('/api/preferences').json() == before
    owner.cookies.clear()
    assert owner.get('/api/preferences', headers={'Host': 'remote.invalid'}).status_code == 403
    assert owner.patch('/api/preferences', json={'language': 'en'}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_threshold_update_applies_in_same_transaction_without_reactivating(owner):
    base = owner.post('/api/bases', json={'name': 'Cards', 'settings': {'review_enabled': True}}).json()
    for index in range(3):
        pgn = '[Event \"Card ' + str(index) + '\"]\n\n1. e4 e5 *'
        assert owner.post('/api/bases/' + str(base['id']) + '/import', json={'pgn': pgn}).status_code == 200
    cards = training.queue(base['id'], all=True)['cards']
    assert len(cards) == 3
    with db.get_conn() as conn:
        for card, interval in zip(cards, (199, 200, 201)):
            conn.execute("UPDATE review_cards SET state='learned',interval_days=?,due='2027-01-01T00:00:00+00:00' WHERE id=?", (interval, card['id']))
    response = owner.patch('/api/preferences', json={'auto_mastery_days': 200})
    assert response.status_code == 200, response.text
    with db.get_conn() as conn:
        states = [dict(conn.execute('SELECT state,interval_days,due FROM review_cards WHERE id=?', (card['id'],)).fetchone()) for card in cards]
        assert [item['state'] for item in states] == ['learned', 'learned', 'mastered']
        assert states[-1]['interval_days'] == 201 and states[-1]['due'] is None
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 0
    assert owner.patch('/api/preferences', json={'auto_mastery_days': 300}).status_code == 200
    with db.get_conn() as conn:
        assert conn.execute('SELECT state FROM review_cards WHERE id=?', (cards[-1]['id'],)).fetchone()[0] == 'mastered'


def test_invalid_stored_values_fall_back_without_overriding_valid_fields(owner):
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences VALUES (?,?)', ('auto_mastery_days', 'broken-json'))
        conn.execute('INSERT INTO preferences VALUES (?,?)', ('review_defaults', json.dumps({'hard': 7, 'medium': False, 'new_limit': 'bad'})))
        conn.execute('INSERT INTO preferences VALUES (?,?)', ('language', '"invalid"'))
    value = owner.get('/api/preferences').json()
    assert value['auto_mastery_days'] == 180 and value['language'] == 'fr'
    assert value['review_defaults'] == {'again': 10, 'hard': 7, 'medium': 5, 'easy': 10, 'new_limit': None}


@pytest.mark.parametrize('patch', [None, [], {'bad': 2}, {'max': 720}, {'again': False}, {'hard': float('nan')},
    {'medium': float('inf')}, {'easy': -1}, {'again': 0}, {'again': 1441}, {'hard': 0}, {'easy': 3651},
    {'new_limit': True}, {'new_limit': -1}, {'new_limit': 1001}, {'new_limit': 2.5}, {'new_limit': '5'}])
def test_invalid_defaults(patch):
    with pytest.raises(HTTPException) as error:
        review_preferences.checked_review_defaults(patch)
    assert error.value.status_code == 400


@pytest.mark.parametrize('value', [None, True, False, 0, 3651, 1.5, '180'])
def test_invalid_threshold(value):
    with pytest.raises(HTTPException):
        review_preferences.checked_auto_mastery(value)


def test_boundaries_and_no_shared_mutation():
    values = review_preferences.checked_review_defaults({'again': 1440, 'hard': .01, 'medium': 3650, 'new_limit': 1000})
    assert values['new_limit'] == 1000 and values['hard'] == .01
    assert review_preferences.checked_auto_mastery(1) == 1
    assert review_preferences.checked_auto_mastery(3650) == 3650
    values['again'] = 1
    assert review_preferences.DEFAULT_REVIEW_SETTINGS['again'] == 10


def test_global_multipliers_merge_persist_and_reject_atomic_bad_patch(owner):
    assert owner.get('/api/preferences').json()['review_multipliers'] == {'hard': 1.2, 'medium': 2, 'easy': 3}
    response = owner.patch('/api/preferences', json={'review_multipliers': {'medium': 2.5}})
    assert response.status_code == 200, response.text
    expected = {'hard': 1.2, 'medium': 2.5, 'easy': 3}
    assert response.json()['review_multipliers'] == expected
    assert owner.patch('/api/preferences', json={'review_multipliers': {'hard': False}, 'language': 'en'}).status_code == 400
    actual = owner.get('/api/preferences').json()
    assert actual['review_multipliers'] == expected and actual['language'] == 'fr'
    assert owner.patch('/api/preferences', json={'review_multipliers': {'hard': .1, 'easy': 10}}).status_code == 200


@pytest.mark.parametrize('patch', [None, [], {'again': 1}, {'hard': True}, {'easy': .09}, {'medium': 10.01}, {'easy': float('inf')}, {'medium': float('nan')}, {'hard': '2'}])
def test_global_multiplier_validation(patch):
    with pytest.raises(HTTPException):
        review_preferences.checked_review_multipliers(patch)


def test_legacy_schema_without_preferences_uses_defaults():
    with sqlite3.connect(':memory:') as conn:
        assert review_preferences.read(conn) == {
            'auto_mastery_days': 180,
            'review_defaults': {'again': 10, 'hard': 2, 'medium': 5, 'easy': 10, 'new_limit': None},
            'review_multipliers': {'hard': 1.2, 'medium': 2, 'easy': 3},
            'review_session_defaults': {'minutes': None, 'cards': None},
            'study_day': {'timezone': 'UTC', 'start_hour': 0},
            'review_maintenance': {'enabled': True, 'interval_days': 30, 'daily_limit': 5},
        }
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='preferences'").fetchone() is None


def test_invalid_preferences_schema_is_not_silently_ignored():
    with sqlite3.connect(':memory:') as conn:
        conn.execute('CREATE TABLE preferences (key TEXT)')
        with pytest.raises(sqlite3.OperationalError, match='no such column: value'):
            review_preferences.read(conn)


def test_locked_preferences_are_not_silently_ignored():
    class LockedConnection:
        def execute(self, *args):
            raise sqlite3.OperationalError('database is locked')
    with pytest.raises(sqlite3.OperationalError, match='database is locked'):
        review_preferences.read(LockedConnection())


def test_review_preferences_are_one_read_snapshot_without_stale_cache():
    with sqlite3.connect(':memory:') as conn:
        conn.execute('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT)')
        conn.executemany('INSERT INTO preferences VALUES (?,?)', [
            ('auto_mastery_days', '240'),
            ('review_defaults', '{"hard":7,"medium":false}'),
            ('review_multipliers', '{"easy":4}'),
            ('review_session_defaults', '{"cards":20}'),
            ('study_day', '{"timezone":"UTC","start_hour":4}'),
            ('unrelated', 'not-json'),
        ])
        statements = []
        conn.set_trace_callback(statements.append)
        value = review_preferences.read(conn)
        assert len(statements) == 1 and statements[0].startswith('SELECT ')
        assert value['auto_mastery_days'] == 240
        assert value['review_defaults']['hard'] == 7
        assert value['review_defaults']['medium'] == 5
        assert value['review_multipliers']['easy'] == 4
        assert value['review_session_defaults']['cards'] == 20
        assert value['study_day']['start_hour'] == 4
        conn.execute("UPDATE preferences SET value='90' WHERE key='auto_mastery_days'")
        assert review_preferences.read(conn)['auto_mastery_days'] == 90
