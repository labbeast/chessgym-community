"""Additive upkeep migration, globally bounded work and durable actual attempts."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
import sqlite3
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

import db
import preferences_api
import review_maintenance as maintenance
import review_preferences as prefs
import review_statistics as statistics
import training


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'maintenance.sqlite3')
    current = [datetime(2026, 10, 24, 16, tzinfo=timezone.utc)]
    monkeypatch.setattr(training, 'now', lambda: current[0])
    monkeypatch.setattr(statistics, 'now', lambda: current[0])
    db.init_db()
    training.init_training()
    return current


def make_base(count=4):
    with db.get_conn() as conn:
        bid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
            ('Acquis', json.dumps({'review_enabled': True, 'type': 'solve'}), training.stamp())).lastrowid
        conn.executemany('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES (?,?,?,?,?)',
            ((bid, f'Exercise {index}', '1. e4 e5 *', training.stamp(), training.stamp()) for index in range(count)))
    return bid, training.queue(bid)['cards']


def set_pref(value):
    return preferences_api.update_preferences({'review_maintenance': value}, user={'id': 1})


def due_mastered(bid, cards):
    for card in cards:
        training.master_card(card['id'])
    with db.get_conn() as conn:
        conn.execute("UPDATE review_maintenance SET due='2026-01-01T00:00:00+00:00'")
    return training.queue(bid)['cards']


def rows(table):
    with db.get_conn() as conn:
        return [dict(row) for row in conn.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]


def test_schema_creation_does_not_commit_caller_data_and_rolls_back_tables():
    with sqlite3.connect(':memory:') as conn:
        conn.execute('CREATE TABLE legacy_data(value TEXT)')
        conn.execute("INSERT INTO legacy_data VALUES ('preserved')")
        conn.commit()
        before = conn.execute('SELECT name,type FROM sqlite_master ORDER BY name').fetchall()
        conn.execute('BEGIN IMMEDIATE')
        conn.execute("UPDATE legacy_data SET value='pending-change'")
        maintenance.init_schema(conn)
        assert conn.in_transaction
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='review_maintenance'").fetchone()
        conn.rollback()
        assert conn.execute('SELECT value FROM legacy_data').fetchall() == [('preserved',)]
        assert conn.execute('SELECT name,type FROM sqlite_master ORDER BY name').fetchall() == before


def test_upgrade_preserves_every_legacy_field_and_spreads_large_mastery_collection(database):
    bid, cards = make_base(1007)
    training.grade_card(cards[0]['id'], training.GradeRequest(grade=2, elapsed_ms=9000))
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET state='mastered',due=NULL,interval_days=222,updated_at='2025-01-01'")
    before = {table: rows(table) for table in ('entries', 'review_cards', 'review_history')}
    training.init_training()
    assert {table: rows(table) for table in before} == before
    schedule = rows('review_maintenance')
    assert len(schedule) == 1007
    assert max(Counter(row['due'] for row in schedule).values()) == 5
    assert min(row['due'] for row in schedule).startswith('2026-10-25')
    assert training.queue(bid)['cards'] == []
    training.init_training()
    assert rows('review_maintenance') == schedule
    assert {table: rows(table) for table in before} == before
    database[0] += timedelta(days=1)
    queued = training.queue(bid)['cards']
    assert len(queued) == 5
    assert all(card['maintenance'] and card['selection_reason'] == 'maintenance' for card in queued)
    assert all(card['state'] == 'mastered' and card['due'] is None for card in queued)


def test_preferences_disable_without_loss_and_reenable_with_daily_cap(database):
    bid, cards = make_base(8)
    set_pref({'daily_limit': 2})
    due_mastered(bid, cards)
    original = rows('review_maintenance')
    assert len(training.queue(bid)['cards']) == 2
    set_pref({'enabled': False})
    assert training.queue(bid, all=True)['cards'] == []
    assert rows('review_maintenance') == original
    set_pref({'enabled': True})
    assert len(training.queue(bid, all=True)['cards']) == 2
    assert rows('review_maintenance') == original
    assert training.reviews()['bases'][0]['maintenance_due'] == 2
    assert statistics.review_statistics()['current']['maintenance_scheduled'] == 8


def test_success_preserves_mastery_interval_and_records_only_one_actual_attempt(database):
    bid, cards = make_base(1)
    card = due_mastered(bid, cards)[0]
    before = rows('review_cards')[0]
    request = training.GradeRequest(grade=2, request_id=uuid4(), content_key=card['content_key'], elapsed_ms=5000)
    answer = training.grade_card(card['id'], request)
    assert answer['state'] == 'mastered' and answer['due'] is None
    assert answer['maintenance_due'].startswith('2026-11-23')
    assert training.grade_card(card['id'], request) == answer
    after = rows('review_cards')[0]
    assert after['interval_days'] == before['interval_days']
    assert after['repetitions'] == before['repetitions'] + 1
    assert len(rows('review_history')) == len(rows('review_maintenance_events')) == 1
    context = json.loads(rows('review_attempt_context')[0]['snapshot'])
    assert context['context']['kind'] == 'maintenance'
    assert context['scheduler_version'] == maintenance.SCHEDULER_VERSION
    assert context['card']['repetitions'] == before['repetitions']
    assert training.queue(bid)['cards'] == []
    with pytest.raises(HTTPException) as conflict:
        training.grade_card(card['id'], request.model_copy(update={'request_id': uuid4()}))
    assert conflict.value.status_code == 409


@pytest.mark.parametrize('request_values', [{'grade': 0}, {'grade': 3, 'errors': 1}, {'grade': 3, 'hints': 1}])
def test_failed_recall_reactivates_learning_without_erasing_mastery_history(database, request_values):
    bid, cards = make_base(1)
    card = due_mastered(bid, cards)[0]
    result = training.grade_card(card['id'], training.GradeRequest(content_key=card['content_key'], **request_values))
    assert result['state'] == 'learning' and result['grade'] == 0
    assert result['maintenance_due'] is None and result['due'] is not None
    assert rows('review_cards')[0]['lapses'] == 1
    assert rows('review_maintenance') == []
    assert len(rows('review_maintenance_events')) == len(rows('review_history')) == 1
    database[0] += timedelta(minutes=11)
    assert not training.queue(bid)['cards'][0]['maintenance']


def test_global_limit_is_serialized_across_bases_and_parallel_grades(database):
    set_pref({'daily_limit': 1})
    one, one_cards = make_base(1)
    two, two_cards = make_base(1)
    first = due_mastered(one, one_cards)[0]
    second = due_mastered(two, two_cards)[0]
    def grade(card):
        try:
            return training.grade_card(card['id'], training.GradeRequest(grade=2, request_id=uuid4(), content_key=card['content_key']))
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(2) as pool:
        answers = list(pool.map(grade, [first, second]))
    assert sum(isinstance(answer, dict) for answer in answers) == 1
    assert 409 in answers
    assert len(rows('review_history')) == len(rows('review_maintenance_events')) == 1
    assert training.queue(one)['cards'] == training.queue(two)['cards'] == []
    database[0] += timedelta(days=1)
    assert sum(len(training.queue(bid)['cards']) for bid in (one, two)) == 1


def test_requested_base_does_not_wait_for_unselected_base(database):
    set_pref({'daily_limit': 1})
    one, first = make_base(2)
    two, second = make_base(1)
    due_mastered(one, first)
    due_mastered(two, second)
    with db.get_conn() as conn:
        assert maintenance.due_card_ids(conn, training.now(), base_ids=[two]) == {second[0]['id']}
        assert maintenance.due_card_ids(conn, training.now(), base_ids=[]) == set()


@pytest.mark.parametrize('daily', [False, True])
def test_durable_session_maintenance_is_recorded_once_and_resume_skips_answer(database, daily):
    import review_sessions as sessions
    bid, cards = make_base(1)
    due_mastered(bid, cards)
    if daily:
        first = sessions.create_daily(sessions.CreateDailySession(base_ids=[bid], request_id=uuid4()))
    else:
        first = sessions.create_session(sessions.CreateSession(base_id=bid, request_id=uuid4()))
    card = first['cards'][0]
    assert card['maintenance'] and card['selection_reason'] == 'maintenance'
    request = training.GradeRequest(grade=2, request_id=uuid4(), content_key=card['content_key'],
        session_id=UUID(first['session_id']), session_index=card['session_index'], elapsed_ms=4000)
    answer = training.grade_card(card['id'], request)
    assert answer['session_completed'] == 1
    assert training.grade_card(card['id'], request) == answer
    resumed = sessions.get_session(UUID(first['session_id']), 0, 20)
    assert resumed['cards'] == [] and resumed['skipped_completed'] == [0]
    assert resumed['completed'] == 1 and resumed['elapsed_ms'] == 4000
    assert len(rows('review_history')) == 1


def test_upkeep_quota_uses_shared_local_study_day(database):
    preferences_api.update_preferences({'study_day': {'timezone': 'America/Toronto', 'start_hour': 4}}, user={'id': 1})
    set_pref({'daily_limit': 1})
    bid, cards = make_base(2)
    database[0] = datetime(2026, 10, 24, 7, 59, tzinfo=timezone.utc)
    first = due_mastered(bid, cards)[0]
    training.grade_card(first['id'], training.GradeRequest(grade=2, content_key=first['content_key']))
    assert training.queue(bid)['cards'] == []
    database[0] += timedelta(minutes=1)
    assert len(training.queue(bid)['cards']) == 1


def test_personal_backup_restores_maintenance_attempt_context_and_session_resume(database, tmp_path, monkeypatch):
    import backup_service
    import review_sessions as sessions
    # A user's external public puzzle bank must not be inspected by this test.
    monkeypatch.setenv('CHESSGYM_PUZZLE_BANK', str(tmp_path / 'unused-puzzle-bank.sqlite3'))
    bid, cards = make_base(2)
    due_mastered(bid, cards)
    first = sessions.create_daily(sessions.CreateDailySession(base_ids=[bid], request_id=uuid4()))
    card = first['cards'][0]
    request = training.GradeRequest(grade=2, request_id=uuid4(), content_key=card['content_key'],
        session_id=UUID(first['session_id']), session_index=card['session_index'], elapsed_ms=4000)
    answer = training.grade_card(card['id'], request)
    tables = ('bases', 'entries', 'review_cards', 'review_history', 'review_maintenance',
              'review_maintenance_events', 'review_attempt_context', 'review_sessions',
              'review_session_items', 'review_grade_receipts')
    expected = {table: rows(table) for table in tables}
    archive = tmp_path / 'learning-backup.zip'
    backup_service.build_archive(archive)
    assert backup_service.verify_archive(archive)['valid']
    # Change only the disposable source, proving restore restores a real snapshot.
    other = first['cards'][1]
    training.grade_card(other['id'], training.GradeRequest(grade=0, content_key=other['content_key']))
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET pgn='1. d4 d5 *' WHERE id=?", (other['entry_id'],))
    assert rows('review_history') != expected['review_history']
    assert backup_service.restore_offline(archive, confirm=True)['restored']
    training.init_training()
    assert {table: rows(table) for table in tables} == expected
    assert training.grade_card(card['id'], request) == answer
    resumed = sessions.get_session(UUID(first['session_id']), 0, 20)
    assert resumed['completed'] == 1 and resumed['elapsed_ms'] == 4000
    assert resumed['skipped_completed'] == [card['session_index']]
    assert [item['id'] for item in resumed['cards']] == [other['id']]


def test_legacy_receipt_serialization_survives_new_optional_session_fields(database):
    _, cards = make_base(1)
    request = training.GradeRequest(grade=2, request_id=uuid4())
    fields = request.model_dump(mode='json', exclude={'session_id', 'session_index'})
    with db.get_conn() as conn:
        encoded = training.review_generation.json_text({'action': 'grade', 'card_id': cards[0]['id'], **fields})
        conn.execute('INSERT INTO review_grade_receipts VALUES (?,?,?,?)',
            (str(request.request_id), encoded, '{"legacy":true}', training.stamp()))
    assert training.grade_card(cards[0]['id'], request) == {'legacy': True}
    assert rows('review_history') == []


@pytest.mark.parametrize('invalid', [{'enabled': 1}, {'daily_limit': 0}, {'daily_limit': 101},
    {'interval_days': 0}, {'interval_days': True}, {'interval_days': 3651}, {'unknown': 2}, []])
def test_maintenance_preferences_validate_atomically(database, invalid):
    before = preferences_api.preferences(user={'id': 1})
    with pytest.raises(HTTPException):
        set_pref(invalid)
    assert preferences_api.preferences(user={'id': 1}) == before
