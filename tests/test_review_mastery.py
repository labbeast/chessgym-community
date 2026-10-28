"""Mastery is durable exclusion without fabricated repetitions or schedule resets."""
import hashlib
import json
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from local_test_client import TestClient

import app
import db
import training


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'mastery.sqlite3')
    monkeypatch.setattr(training, 'now', lambda: datetime(2026, 10, 20, 16, tzinfo=timezone.utc))
    db.init_db()
    training.init_training()


def create_base(**changes):
    settings = {'review_enabled': True, 'type': 'solve', 'color': 'white', 'mode': 'hybrid',
                'new_limit': 10, 'spacing': 'adaptive', **changes}
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
                            ('Exercices', json.dumps(settings), training.stamp())).lastrowid


def add_entry(bid, pgn='1. e4 e5 2. Nf3 *'):
    with db.get_conn() as conn:
        return conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
                               VALUES (?,?,?,?,?)''',
                            (bid, 'Exercice', pgn, training.stamp(), training.stamp())).lastrowid


def saved(card_id):
    with db.get_conn() as conn:
        return dict(conn.execute('SELECT * FROM review_cards WHERE id=?', (card_id,)).fetchone())


def history():
    with db.get_conn() as conn:
        return [dict(row) for row in conn.execute('SELECT * FROM review_history ORDER BY id')]


def update_base(bid, **changes):
    with db.get_conn() as conn:
        settings = json.loads(conn.execute('SELECT settings FROM bases WHERE id=?', (bid,)).fetchone()[0])
        settings.update(changes)
        conn.execute('UPDATE bases SET settings=? WHERE id=?', (json.dumps(settings), bid))


def base_settings(bid):
    with db.get_conn() as conn:
        return json.loads(conn.execute('SELECT settings FROM bases WHERE id=?', (bid,)).fetchone()[0])


@pytest.mark.parametrize('kind', ['solve', 'moves', 'play'])
def test_mastery_excludes_every_queue_and_remains_in_learned(database, kind):
    bid = create_base(type=kind)
    add_entry(bid)
    original = training.queue(bid, all=True)['cards']
    card = original[0]
    result = training.master_card(card['id'])
    assert result == {'state': 'mastered', 'due': None, 'interval_days': 0}
    assert saved(card['id'])['repetitions'] == saved(card['id'])['lapses'] == 0
    assert history() == []
    for free in (False, True):
        assert card['id'] not in [item['id'] for item in training.queue(bid, all=free)['cards']]
    counts = training.reviews()['bases'][0]
    assert counts['total'] == len(original)
    assert counts['learned'] == counts['mastered'] == 1
    assert counts['due'] == counts['learning'] == 0
    assert counts['unseen'] == len(original) - 1
    # Repeated requests and a server restart leave the mastery intact.
    assert training.master_card(card['id']) == result
    training.init_training()
    assert saved(card['id'])['state'] == 'mastered'
    assert history() == []


def test_mastery_keeps_past_answers_counters_and_other_cards(database):
    bid = create_base(type='moves')
    add_entry(bid)
    first, other = training.queue(bid, all=True)['cards']
    for grade in (0, 2, 3):
        training.grade_card(first['id'], training.GradeRequest(grade=grade, elapsed_ms=12000))
    training.grade_card(other['id'], training.GradeRequest(grade=1))
    before, untouched, prior_history = saved(first['id']), saved(other['id']), history()
    training.master_card(first['id'])
    after = saved(first['id'])
    assert after['repetitions'] == before['repetitions'] == 3
    assert after['lapses'] == before['lapses'] == 1
    assert history() == prior_history
    assert saved(other['id']) == untouched
    assert after['state'] == 'mastered' and after['due'] is None and after['interval_days'] == 0


def test_stale_grade_cannot_reactivate_mastered_card(database):
    bid = create_base(mode='automatic')
    add_entry(bid)
    card = training.queue(bid)['cards'][0]
    training.master_card(card['id'])
    before = saved(card['id'])
    with pytest.raises(HTTPException) as error:
        training.grade_card(card['id'], training.GradeRequest(grade=2, errors=1))
    assert error.value.status_code == 409
    assert saved(card['id']) == before
    assert history() == []


@pytest.mark.parametrize('inactive', ['unselected', 'disabled', 'deleted'])
def test_mastery_rejects_cards_removed_from_active_reviews(database, inactive):
    bid = create_base()
    eid = add_entry(bid)
    card = training.queue(bid)['cards'][0]
    if inactive == 'disabled':
        update_base(bid, review_enabled=False)
    else:
        with db.get_conn() as conn:
            if inactive == 'unselected':
                conn.execute('UPDATE entries SET selected=0 WHERE id=?', (eid,))
            else:
                conn.execute('DELETE FROM entries WHERE id=?', (eid,))
    with pytest.raises(HTTPException) as error:
        training.master_card(card['id'])
    assert error.value.status_code == 409
    assert saved(card['id'])['state'] == 'unseen'
    assert history() == []


def test_unknown_card_cannot_be_mastered(database):
    with pytest.raises(HTTPException) as error:
        training.master_card('missing-card')
    assert error.value.status_code == 404


def test_mastery_survives_resync_path_edit_and_reenable(database):
    bid = create_base(type='moves')
    eid = add_entry(bid)
    card = next(item for item in training.queue(bid)['cards'] if item['answers'] == ['g1f3'])
    training.master_card(card['id'])
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=?,selected=0 WHERE id=?',
                     ('1. d4 (1. e4 e5 2. Nf3 {Annotation ajoutée}) d5 *', eid))
    assert training.queue(bid, all=True)['cards'] == []
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=1 WHERE id=?', (eid,))
    update_base(bid, type='play')
    assert training.queue(bid)['cards'][0]['state'] == 'unseen'
    update_base(bid, type='moves')
    assert card['id'] not in [item['id'] for item in training.queue(bid, all=True)['cards']]
    restored = saved(card['id'])
    assert restored['state'] == 'mastered' and restored['active'] == 1
    assert restored['path'] == '1.0' and restored['comment'] == ''
    assert training.reviews()['bases'][0]['mastered'] == 1


def test_mastery_of_shared_opening_position_is_scoped_to_its_base(database):
    first = create_base(type='moves')
    second = create_base(type='moves')
    for bid in (first, second):
        add_entry(bid)
        add_entry(bid, '1. e4 e5 2. Bc4 *')
    card = next(item for item in training.queue(first)['cards'] if item['path'] == '')
    training.master_card(card['id'])
    assert len(training.queue(first, all=True)['cards']) == 1
    assert len(training.queue(second, all=True)['cards']) == 2


def test_master_endpoint_is_local_and_returns_no_fake_grade(database):
    client = TestClient(app.app, base_url='http://localhost')
    try:
        bid = create_base()
        add_entry(bid)
        card = training.queue(bid)['cards'][0]
        url = f'/api/reviews/{card["id"]}/master'
        assert client.post(url, json={}, headers={'Host': 'remote.invalid'}).status_code == 403
        response = client.post(url, json={})
        assert response.status_code == 200, response.text
        assert response.json() == {'state': 'mastered', 'due': None, 'interval_days': 0}
        assert client.post(url, json={}).json() == response.json()
        assert client.get(f'/api/bases/{bid}/queue?all=true').json()['cards'] == []
        assert client.get('/api/reviews').json()['bases'][0]['learned'] == 1
        assert client.post(f'/api/reviews/{card["id"]}/grade', json={'grade': 2}).status_code == 409
        assert history() == []
    finally:
        client.close()


def test_default_schedule_is_adaptive_then_masters_above_180_days(database):
    settings = app.checked_settings({})
    assert settings['spacing'] == 'adaptive' and settings['max'] == 720
    bid = create_base()
    add_entry(bid)
    card = training.queue(bid)['cards'][0]
    intervals = [training.grade_card(card['id'], training.GradeRequest(grade=2))['interval_days'] for _ in range(7)]
    assert intervals == [5, 10, 20, 40, 80, 160, 320]
    assert saved(card['id'])['state'] == 'mastered'
    assert training.queue(bid, all=True)['cards'] == []
    assert training._schedule({'interval_days': 500}, {}, 3)[0] == 720
    assert training._schedule({'interval_days': 500}, {'max': 180}, 3)[0] == 180
    assert training._schedule({'interval_days': 500}, {'max': 900}, 3)[0] == 900


@pytest.mark.parametrize('legacy', ['fixed', 'custom'])
def test_removed_modes_rejected_by_new_settings_and_never_use_fixed_schedule(database, legacy):
    with pytest.raises(HTTPException):
        app.checked_settings({'spacing': legacy})
    assert training._schedule({'interval_days': 30}, {'spacing': legacy}, 2)[0] == 60


def test_migration_upgrades_only_old_defaults_and_preserves_schedules(database):
    standard = create_base(spacing='custom', max=180, hard=2, medium=5, easy=9, new_limit=4)
    missing = create_base(spacing='fixed')
    custom = create_base(max=365)
    add_entry(standard)
    card = training.queue(standard)['cards'][0]
    training.grade_card(card['id'], training.GradeRequest(grade=0))
    before, old_history = saved(card['id']), history()
    with db.get_conn() as conn:
        conn.execute('DELETE FROM training_migrations')
        original_entries = [dict(row) for row in conn.execute('SELECT * FROM entries')]
    training.init_training()
    assert base_settings(standard) == {'review_enabled': True, 'type': 'solve', 'color': 'white',
        'mode': 'hybrid', 'new_limit': 4, 'spacing': 'adaptive', 'max': 720, 'hard': 2, 'medium': 5, 'easy': 9}
    assert base_settings(missing)['spacing'] == 'adaptive' and base_settings(missing)['max'] == 720
    assert base_settings(custom)['max'] == 365
    assert saved(card['id']) == before and history() == old_history
    with db.get_conn() as conn:
        assert [dict(row) for row in conn.execute('SELECT * FROM entries')] == original_entries
        assert {row[0] for row in conn.execute('SELECT name FROM training_migrations')} == {'adaptive_spacing_max_720_v1', 'hard_grade_learned_v1'}
    # A new explicit choice of 180 after upgrade must survive every restart.
    update_base(standard, max=180)
    training.init_training()
    assert base_settings(standard)['max'] == 180
    assert saved(card['id']) == before and history() == old_history


def test_migration_failure_rolls_back_changes_and_marker(database):
    first = create_base(spacing='custom', max=180)
    second = create_base(spacing='fixed', max=180)
    before = {bid: base_settings(bid) for bid in (first, second)}
    with db.get_conn() as conn:
        conn.execute('DELETE FROM training_migrations')
        conn.execute(f'''CREATE TRIGGER fail_migration BEFORE UPDATE ON bases WHEN old.id={second}
                         BEGIN SELECT RAISE(ABORT, 'migration test'); END''')
    with pytest.raises(Exception, match='migration test'):
        training.init_training()
    assert {bid: base_settings(bid) for bid in (first, second)} == before
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM training_migrations').fetchone()[0] == 0
        conn.execute('DROP TRIGGER fail_migration')
    training.init_training()
    assert base_settings(first)['max'] == base_settings(second)['max'] == 720
