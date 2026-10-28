"""Programme hooks share native receipts and transactions, without history backfill."""
from uuid import uuid4

import pytest
from fastapi import HTTPException

import db
import reading_progress
import review_sessions
import training
import training_activity
import training_programs
from test_review_sessions import database, make_base
from test_training_programs import client, block as plan_block, program as make_program, activate, run as start_run, request as plan_request


def session(bid, **extra):
    return review_sessions.create_session(review_sessions.CreateSession(
        base_id=bid, request_id=uuid4(), **extra))


def grade_request(created, **extra):
    card = created['cards'][0]
    return training.GradeRequest(grade=2, elapsed_ms=12000, request_id=uuid4(),
        session_id=created['session_id'], session_index=card['session_index'],
        content_key=card['content_key'], **extra)


def test_planned_session_context_and_binding_are_one_creation_transaction(database, monkeypatch):
    bid = make_base(2)
    run_id = str(uuid4())
    calls = []
    def validate(conn, *args, **kw):
        calls.append(('validate', args, kw))
        return {'launch': {'options': {}}}
    monkeypatch.setattr(training_activity, 'validate_run', validate)
    def bind(conn, user_id, run, tool, native_id, **kw):
        row = conn.execute('SELECT training_run_id FROM review_sessions WHERE id=?', (native_id,)).fetchone()
        assert row['training_run_id'] == run_id
        assert conn.in_transaction
        calls.append(('bind', run, tool, native_id))
    monkeypatch.setattr(training_activity, 'bind_native', bind)
    request = review_sessions.CreateSession(base_id=bid, request_id=uuid4(), training_run_id=run_id)
    created = review_sessions.create_session(request)
    assert created['training_run_id'] == run_id
    assert review_sessions.create_session(request) == created
    assert len(calls) == 2
    assert calls[0][1] == (1, run_id, 'review')
    assert calls[1][1:3] == (run_id, 'review')
    with db.get_conn() as conn:
        assert review_sessions.training_run(conn, created['session_id']) == run_id


def test_failed_binding_rolls_back_native_creation_and_its_receipt(database, monkeypatch):
    bid = make_base(1)
    monkeypatch.setattr(training_activity, 'validate_run', lambda *args, **kw: {'launch': {'options': {}}})
    def reject(*args, **kw):
        raise HTTPException(409, 'Run already bound')
    monkeypatch.setattr(training_activity, 'bind_native', reject)
    with pytest.raises(HTTPException):
        session(bid, training_run_id=uuid4())
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_sessions').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM review_session_items').fetchone()[0] == 0


def test_review_credits_only_new_accepted_grade_and_uses_server_context(database, monkeypatch):
    bid = make_base(2)
    created = session(bid)
    run_id = str(uuid4())
    with db.get_conn() as conn:
        conn.execute('UPDATE review_sessions SET training_run_id=? WHERE id=?', (run_id, created['session_id']))
    calls = []
    def record(conn, **values):
        assert conn.in_transaction
        history = conn.execute('SELECT * FROM review_history WHERE id=?', (values['history_id'],)).fetchone()
        assert history['elapsed_ms'] == 12000
        calls.append(values)
    monkeypatch.setattr(training_activity, 'record_review', record)
    request = grade_request(created)
    result = training.grade_card(created['cards'][0]['id'], request)
    assert training.grade_card(created['cards'][0]['id'], request) == result
    assert len(calls) == 1
    assert calls[0]['run_id'] == run_id
    assert calls[0]['session_id'] == created['session_id']
    assert calls[0]['request_id'] == str(request.request_id)
    card = created['cards'][1]
    training.master_card(card['id'], training.MasterRequest(request_id=uuid4(),
        session_id=created['session_id'], session_index=card['session_index'], content_key=card['content_key']))
    assert len(calls) == 1, 'Manual mastery must never fabricate programme work'


def test_credit_failure_rolls_back_grade_history_membership_and_receipt(database, monkeypatch):
    created = session(make_base(1))
    request = grade_request(created)
    def reject(*args, **kw):
        raise HTTPException(409, 'Run is completed')
    monkeypatch.setattr(training_activity, 'record_review', reject)
    with pytest.raises(HTTPException):
        training.grade_card(created['cards'][0]['id'], request)
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM review_grade_receipts').fetchone()[0] == 0
        assert conn.execute('SELECT repetitions FROM review_cards').fetchone()[0] == 0
        assert conn.execute('SELECT completed_at FROM review_session_items').fetchone()[0] is None


def reading_entry():
    bid = make_base(1, reading_enabled=True)
    with db.get_conn() as conn:
        conn.execute("INSERT OR IGNORE INTO users VALUES(1,'native-reader','unused','today')")
        return dict(conn.execute('SELECT * FROM entries WHERE base_id=?', (bid,)).fetchone())


def read(entry, payload):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return reading_progress.update(conn, entry, payload)


def test_reading_credits_new_increment_once_and_keeps_zero_context_for_validation(database, monkeypatch):
    entry = reading_entry()
    calls = []
    def record(conn, **values):
        assert conn.in_transaction
        payload = values['payload']
        assert conn.execute('SELECT 1 FROM reading_receipts WHERE entry_id=? AND request_id=?',
            (entry['id'], payload['request_id'])).fetchone()
        calls.append(dict(payload))
    monkeypatch.setattr(training_activity, 'record_reading', record)
    run = str(uuid4())
    first = {'path':'', 'active_seconds':0, 'request_id':'reading-first',
             'training_run_id':run, 'visit_id':'visit-first', 'visit_sequence':1}
    read(entry, first)
    body = {**first, 'active_seconds':11, 'request_id':'reading-second', 'visit_sequence':2}
    read(entry, body)
    assert read(entry, body)['active_seconds'] == 11
    assert [item['active_seconds'] for item in calls] == [0, 11]
    assert all(item['training_run_id'] == run for item in calls)
    read(entry, {'mode':'bookmark','path':'0','request_id':'manual-bookmark'})
    assert len(calls) == 2


def test_reading_credit_failure_rolls_back_native_time_visit_and_receipt(database, monkeypatch):
    entry = reading_entry()
    def reject(*args, **kw):
        raise HTTPException(409, 'Wrong resource')
    monkeypatch.setattr(training_activity, 'record_reading', reject)
    with pytest.raises(HTTPException):
        read(entry, {'path':'0','active_seconds':9,'request_id':'failed-reading',
            'visit_id':'failed-visit','visit_sequence':1,'training_run_id':str(uuid4())})
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM reading_receipts').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM reading_visits').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM reading_progress').fetchone()[0] == 0


def test_migration_does_not_attach_old_native_sessions(database):
    created = session(make_base(1))
    with db.get_conn() as conn:
        review_sessions.init_schema(conn)
        assert review_sessions.training_run(conn, created['session_id']) is None


@pytest.mark.parametrize('daily', [False, True])
def test_native_grade_reaches_real_programme_credit_and_only_explicit_finish_counts_session(client, monkeypatch, daily):
    monkeypatch.setattr(training, 'now', training_programs.now)
    week = activate(client, make_program(client))
    run = start_run(client, week)
    if daily:
        create_request = review_sessions.CreateDailySession(base_ids=[1], request_id=run['id'], training_run_id=run['id'])
        native = review_sessions.create_daily(create_request)
        assert review_sessions.create_daily(create_request) == native
    else:
        native = session(1, training_run_id=run['id'])
    assert native['training_run_id'] == run['id']
    answer = grade_request(native)
    saved = training.grade_card(native['cards'][0]['id'], answer)
    assert training.grade_card(native['cards'][0]['id'], answer) == saved
    current = plan_request(client, 'GET', '/runs/' + run['id'])
    assert current['native_ref'] == {'tool':'review', 'id':native['session_id']}
    assert current['duration_ms'] == 12000 and current['quantity'] == 1
    assert current['sessions'] == 0
    finished = plan_request(client, 'PATCH', '/runs/' + run['id'],
        {'action':'finish', 'expected_revision':current['revision']})
    assert finished['sessions'] == 1 and finished['duration_ms'] == 12000
    # Retrying the already accepted native answer remains valid after finish.
    assert training.grade_card(native['cards'][0]['id'], answer) == saved


def test_planned_daily_requires_one_base_and_does_not_bind_an_empty_selection(client, monkeypatch):
    monkeypatch.setattr(training, 'now', training_programs.now)
    week = activate(client, make_program(client))
    run = start_run(client, week)
    for bases in (None, [], [1, 1]):
        with pytest.raises(HTTPException) as error:
            review_sessions.create_daily(review_sessions.CreateDailySession(base_ids=bases,
                request_id=uuid4(), training_run_id=run['id']))
        assert error.value.status_code == 422
    with pytest.raises(HTTPException) as error:
        review_sessions.create_daily(review_sessions.CreateDailySession(base_ids=[1], selection='review',
            request_id=uuid4(), training_run_id=run['id']))
    assert error.value.status_code == 409
    assert plan_request(client, 'GET', '/runs/' + run['id'])['native_ref'] is None
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_sessions').fetchone()[0] == 0


def test_native_reading_multiple_visits_accumulate_without_inventing_studied_games(client, monkeypatch):
    monkeypatch.setattr(reading_progress, 'stamp', training_programs.stamp)
    week = activate(client, make_program(client, [plan_block('reading')]))
    run = start_run(client, week)
    with db.get_conn() as conn:
        entry = dict(conn.execute('SELECT * FROM entries WHERE id=1').fetchone())
    opening = {'path':'', 'active_seconds':0, 'request_id':'planned-opening',
        'visit_id':'planned-visit-a', 'visit_sequence':1, 'training_run_id':run['id']}
    read(entry, opening)
    first = {**opening, 'active_seconds':12, 'request_id':'planned-time-a', 'visit_sequence':2, 'visit_end':True}
    read(entry, first)
    read(entry, first)
    read(entry, {**opening, 'active_seconds':8, 'request_id':'planned-time-b', 'visit_id':'planned-visit-b'})
    current = plan_request(client, 'GET', '/runs/' + run['id'])
    assert current['duration_ms'] == 20000
    assert current['quantity'] == 0 and current['sessions'] == 0
    studied = plan_request(client, 'PATCH', '/runs/' + run['id'],
        {'action':'confirm_reading', 'entry_id':1, 'expected_revision':current['revision']})
    assert studied['quantity'] == 1 and studied['duration_ms'] == 20000
    finished = plan_request(client, 'PATCH', '/runs/' + run['id'],
        {'action':'finish', 'expected_revision':studied['revision']})
    assert finished['sessions'] == 1 and finished['duration_ms'] == 20000
