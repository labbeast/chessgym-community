"""Owner-only analysis, queueing, completed reports and training entry integration."""
import json

import chess
import pytest
from local_test_client import TestClient

import app
import db
import engine
import game_analysis as ga
import jobs


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'game-analysis-api.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        yield client


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


def game(owner):
    base = owner.post('/api/bases', json={'name': 'Mes parties'}).json()['id']
    response = owner.post('/api/entries', json={'base_id': base, 'pgn': '1. e4 e5 *'})
    assert response.status_code == 200, response.text
    with db.get_conn() as conn:
        return conn.execute('SELECT id FROM entries WHERE base_id=?', (base,)).fetchone()[0]


def fake(board, time_ms, **kwargs):
    index = len(board.move_stack)
    return {'lines': [{'cp': (200, 0, 200)[index], 'mate': None,
                       'pv': [('d2d4', 'g8f6', 'g1f3')[index]], 'depth': 12}]}


def test_all_analysis_endpoints_require_owner(client):
    assert client.get('/api/game-analysis/1', headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.post('/api/game-analysis/1', json={}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.post('/api/game-analysis/1/exercise', json={'ply': 1, 'base_id': 2}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_queue_report_exercise_and_existing_training_work_together(owner, monkeypatch):
    monkeypatch.setattr(engine, 'status', lambda: {'available': True})
    monkeypatch.setattr(engine, '_run', fake)
    entry_id = game(owner)
    assert owner.get(f'/api/game-analysis/{entry_id}').json()['status'] == 'none'
    response = owner.post(f'/api/game-analysis/{entry_id}', json={'depth': 14, 'time_ms': 500})
    assert response.status_code == 200, response.text
    job = response.json()['job']
    assert job['kind'] == 'analyse' and job['status'] == 'queued'
    queued = owner.get(f'/api/game-analysis/{entry_id}').json()
    assert queued['job']['id'] == job['id'] and queued['status'] == 'queued'
    worker = jobs.Worker()
    worker.execute(worker.claim())
    report = owner.get(f'/api/game-analysis/{entry_id}').json()
    assert report['status'] == 'done' and report['job']['status'] == 'done'
    assert report['summary']['blunders'] == 2
    assert report['findings'][0]['before_path'] == ''
    destination = owner.post('/api/bases', json={'name': 'Erreurs à réviser'}).json()['id']
    assert owner.patch(f'/api/bases/{destination}', json={'settings': {'review_enabled': True, 'type': 'solve'}}).status_code == 200
    made = owner.post(f'/api/game-analysis/{entry_id}/exercise', json={'ply': 1, 'base_id': destination, 'comment': 'Trouver le plan.'})
    assert made.status_code == 200, made.text
    exercise_id = made.json()['entry_id']
    exercises = owner.get(f'/api/bases/{destination}/queue').json()['cards']
    assert len(exercises) == 1 and exercises[0]['entry_id'] == exercise_id
    assert exercises[0]['fen'] == chess.STARTING_FEN
    assert exercises[0]['answers'] == ['d2d4']
    duplicate = owner.post(f'/api/game-analysis/{entry_id}/exercise', json={'ply': 1, 'base_id': destination}).json()
    assert duplicate['entry_id'] == exercise_id and duplicate['duplicate']


@pytest.mark.parametrize('payload', [{'time_ms': True}, {'time_ms': 0}, {'depth': 0}, {'depth': 2**31}, {'bad': 1}])
def test_invalid_queue_request_never_enqueues(owner, payload):
    entry_id = game(owner)
    response = owner.post(f'/api/game-analysis/{entry_id}', json=payload)
    assert response.status_code == 422
    assert jobs.latest_for('analyse', {'entry_id': entry_id}) is None


def test_exercise_requires_current_analysis_and_keeps_foreign_base_safe(owner):
    entry_id = game(owner)
    response = owner.post(f'/api/game-analysis/{entry_id}/exercise', json={'ply': 1, 'base_id': 999999})
    assert response.status_code == 404
    with db.get_conn() as conn:
        base = conn.execute('SELECT base_id FROM entries WHERE id=?', (entry_id,)).fetchone()[0]
    assert owner.post(f'/api/game-analysis/{entry_id}/exercise', json={'ply': 1, 'base_id': base}).status_code == 409
    assert owner.post(f'/api/game-analysis/{entry_id}/exercise', json={'ply': 1, 'base_id': base, 'comment': 'A {broken} comment'}).status_code == 422


def test_missing_entry_and_cross_origin_are_rejected(owner):
    assert owner.get('/api/game-analysis/999999').status_code == 404
    assert owner.post('/api/game-analysis/999999', json={}).status_code == 404
    assert owner.post('/api/game-analysis/1', json={}, headers={'Origin': 'https://unrelated.invalid'}).status_code == 403
