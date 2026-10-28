"""Color drill scoring, first-answer timing, ownership and perfect-only records."""
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi import FastAPI
from local_test_client import TestClient

import db
import color_training as color
from accounts_api import require_user


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'color.sqlite3')
    db.init_db()
    color.init_color_training()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users VALUES(1,'owner','unused','today')")
    application = FastAPI()
    application.include_router(color.router)
    application.dependency_overrides[require_user] = lambda: {'id': 1}
    with TestClient(application) as client:
        yield client


@pytest.fixture
def now(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(color.time, 'time', lambda: clock[0])
    return clock


def answer(client, session, *, correct=True):
    expected = color.square_color(session['target']['square'])
    selected = expected if correct else ('black' if expected == 'white' else 'white')
    return ok(client.post('/api/skills/color/' + session['id'] + '/answer', json={
        'index': session['index'], 'nonce': session['nonce'], 'color': selected,
    }))


def stored(session):
    with db.get_conn() as conn:
        return color._row(conn, session['id'], 1)


def test_square_colors_match_all_64_squares():
    assert color.square_color('a1') == 'black'
    assert color.square_color('h8') == 'black'
    assert color.square_color('a8') == 'white'
    assert color.square_color('h1') == 'white'
    assert sum(color.square_color(square) == 'white' for square in color.SQUARES) == 32
    for rank in range(1, 9):
        for file in range(7):
            assert color.square_color(chr(97 + file) + str(rank)) != color.square_color(chr(98 + file) + str(rank))


def test_ready_session_has_no_running_deadline_until_first_accepted_answer(client, now):
    session = ok(client.post('/api/skills/color', json={}))
    assert session['config'] == {'duration': 30}
    assert session['started_at'] is None and session['deadline'] is None
    now[0] += 500
    reloaded = ok(client.get('/api/skills/color/' + session['id']))
    assert reloaded['target'] == session['target'] and reloaded['nonce'] == session['nonce']
    assert not reloaded['finished'] and reloaded['deadline'] is None
    assert client.post('/api/skills/color/' + session['id'] + '/finish').status_code == 409
    started = answer(client, reloaded)
    assert started['score'] == 1 and started['answered'] == 1
    assert started['started_at'] == 1500 and started['deadline'] == 1530
    assert started['target'] != session['target'] and started['nonce'] != session['nonce']
    assert 'events' not in started and 'response_ms' not in started


def test_wrong_answer_advances_the_question_and_does_not_stop_the_run(client, now):
    session = ok(client.post('/api/skills/color', json={'duration': 60}))
    wrong = answer(client, session, correct=False)
    assert wrong['score'] == 0 and wrong['errors'] == 1 and wrong['index'] == 1
    assert wrong['target'] != session['target'] and wrong['nonce'] != session['nonce']
    assert wrong['last_answer']['square'] == session['target']['square'] and not wrong['last_answer']['correct']
    assert not wrong['finished'] and wrong['deadline'] == 1060
    now[0] += .4
    right = answer(client, wrong)
    assert right['score'] == 1 and right['errors'] == 1 and right['index'] == 2
    now[0] = right['deadline']
    final = ok(client.post('/api/skills/color/' + right['id'] + '/finish'))
    assert final['result']['score'] == 1 and final['result']['accuracy'] == 50
    assert final['result']['mean_ms'] == 200
    assert not final['result']['record_eligible']
    history = ok(client.get('/api/skills/color/history'))
    assert history['history'][0]['errors'] == 1 and not history['records']


def test_nonce_and_index_prevent_duplicate_or_stale_points(client, now):
    session = ok(client.post('/api/skills/color', json={}))
    payload = {'index': 0, 'nonce': session['nonce'], 'color': color.square_color(session['target']['square'])}
    route = '/api/skills/color/' + session['id'] + '/answer'
    first = ok(client.post(route, json=payload))
    now[0] += .2
    repeated = ok(client.post(route, json=payload))
    assert repeated['score'] == 1 and repeated['index'] == 1 and repeated['nonce'] == first['nonce']
    conflicting = {**payload, 'color': 'white' if payload['color'] == 'black' else 'black'}
    assert client.post(route, json=conflicting).status_code == 409
    assert client.post(route, json={**payload, 'index': 1}).status_code == 409
    second = answer(client, repeated)
    assert second['score'] == 2
    assert client.post(route, json=payload).status_code == 409
    assert len(stored(session)['state']['events']) == 2


def test_invalid_initial_receipt_does_not_start_the_clock(client, now):
    session = ok(client.post('/api/skills/color', json={}))
    route = '/api/skills/color/' + session['id'] + '/answer'
    assert client.post(route, json={'index': 0, 'nonce': 'invalid_nonce', 'color': 'black'}).status_code == 409
    assert stored(session)['started_at'] is None
    assert client.post(route, json={'index': True, 'nonce': session['nonce'], 'color': 'black'}).status_code == 422
    assert client.post(route, json={'index': 0, 'nonce': session['nonce'], 'color': 'purple'}).status_code == 422
    assert client.post(route, json={'index': 0, 'nonce': session['nonce'], 'color': 'black', 'score': 100}).status_code == 422
    assert client.post('/api/skills/color', json={'duration': 10}).status_code == 422
    assert client.post('/api/skills/color', json={'score': 100}).status_code == 422


def test_late_answers_never_score_and_finish_is_idempotent(client, now):
    session = answer(client, ok(client.post('/api/skills/color', json={})))
    assert client.post('/api/skills/color/' + session['id'] + '/finish').status_code == 409
    now[0] = session['deadline']
    final = answer(client, session)
    assert final['finished'] and final['score'] == 1 and final['index'] == 1
    assert final['result']['record_eligible'] and final['result']['completed']
    now[0] += 100
    again = answer(client, final, correct=False)
    assert again['result'] == final['result']
    assert ok(client.post('/api/skills/color/' + session['id'] + '/finish'))['result'] == final['result']
    assert stored(session)['finished_at'] == session['deadline']


def test_history_finishes_expired_runs_even_if_browser_closed(client, now):
    session = answer(client, ok(client.post('/api/skills/color', json={})))
    now[0] = session['deadline'] + 3600
    history = ok(client.get('/api/skills/color/history'))
    assert len(history['records']) == 1 and history['records'][0]['score'] == 1
    assert history['history'][0]['record_eligible']
    assert history['history'][0]['finished_at'] == session['deadline']
    assert ok(client.get('/api/skills/color/' + session['id']))['finished']


def test_new_run_abandons_only_unfinished_attempts_and_keeps_expired_record(client, now):
    first = answer(client, ok(client.post('/api/skills/color', json={})))
    second = ok(client.post('/api/skills/color', json={}))
    old = ok(client.get('/api/skills/color/' + first['id']))
    assert old['result']['abandoned'] and not old['result']['record_eligible']
    third = ok(client.post('/api/skills/color', json={}))
    assert stored(second)['result']['abandoned']
    assert len(ok(client.get('/api/skills/color/history'))['history']) == 1
    third = answer(client, third)
    now[0] = third['deadline'] + 1
    ok(client.post('/api/skills/color', json={}))
    record = ok(client.get('/api/skills/color/history'))['records'][0]
    assert record['id'] == third['id'] and record['record_eligible']


def test_records_are_separate_by_duration_and_ignore_inaccurate_higher_score(client, now):
    sessions = []
    for duration, correct_count, errors in [(30, 2, 0), (30, 4, 1), (60, 1, 0), (30, 3, 0)]:
        session = ok(client.post('/api/skills/color', json={'duration': duration}))
        for _ in range(correct_count):
            session = answer(client, session)
            now[0] += .2
        for _ in range(errors):
            session = answer(client, session, correct=False)
            now[0] += .2
        now[0] = session['deadline']
        sessions.append(ok(client.post('/api/skills/color/' + session['id'] + '/finish')))
        now[0] += 5
    history = ok(client.get('/api/skills/color/history'))
    assert len(history['history']) == 4
    assert {item['duration']: item['score'] for item in history['records']} == {30: 3, 60: 1}
    assert sessions[1]['result']['score'] == 4 and not sessions[1]['result']['record_eligible']


def test_perfect_record_is_exact_not_rounded_percentage(client, now):
    session = answer(client, ok(client.post('/api/skills/color', json={})))
    with db.get_conn() as conn:
        row = color._row(conn, session['id'], 1)
        row['state']['correct'] = 9999
        row['state']['errors'] = 1
        color._save(conn, row)
    now[0] = session['deadline']
    final = ok(client.post('/api/skills/color/' + session['id'] + '/finish'))
    assert final['result']['accuracy'] == 100.0
    assert not final['result']['record_eligible']
    assert not ok(client.get('/api/skills/color/history'))['records']


def test_sessions_are_owner_scoped_and_nonlocal_access_is_rejected(client, now):
    session = ok(client.post('/api/skills/color', json={}))
    client.app.dependency_overrides[require_user] = lambda: {'id': 2}
    assert client.get('/api/skills/color/' + session['id']).status_code == 404
    assert client.post('/api/skills/color/' + session['id'] + '/finish').status_code == 404
    assert client.post('/api/skills/color/' + session['id'] + '/answer', json={'index': 0, 'nonce': session['nonce'], 'color': 'black'}).status_code == 404
    assert ok(client.get('/api/skills/color/history')) == {'history': [], 'records': []}
    client.app.dependency_overrides.clear()
    assert client.get('/api/skills/color/history', headers={'Host': 'remote.example'}).status_code == 403
    assert client.post('/api/skills/color', json={}, headers={'Host': 'remote.example'}).status_code == 403


def test_simultaneous_identical_answers_count_once(client, now):
    session = ok(client.post('/api/skills/color', json={}))
    payload = color.ColorAnswer(index=session['index'], nonce=session['nonce'], color=color.square_color(session['target']['square']))
    with ThreadPoolExecutor(max_workers=2) as pool:
        answers = list(pool.map(lambda _: color.color_answer(session['id'], payload, user={'id': 1}), range(2)))
    assert all(item['score'] == 1 and item['index'] == 1 for item in answers)
    assert len(stored(session)['state']['events']) == 1
