"""Analysis receipts count actual time without needing a programme or target."""
import json
from uuid import uuid4

from fastapi import FastAPI
from local_test_client import TestClient
import pytest

import analysis_time
from accounts_api import require_user
import db
import training
import training_categories
import training_programs as programs


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'analysis.sqlite3')
    db.init_db()
    training.init_training()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users VALUES(1,'owner','unused','today')")
        programs.init_schema(conn)
    app = FastAPI()
    app.include_router(analysis_time.router)
    app.dependency_overrides[require_user] = lambda: {'id': 1}
    with TestClient(app) as client:
        yield client


def payload(**changes):
    return {'mutation_id': str(uuid4()), 'visit_id': 'analysis-visit', 'title': 'Board', 'duration_ms': 15000, **changes}


def test_free_analysis_and_exact_retry_count_once_without_a_plan(client):
    body = payload()
    first = client.post('/api/training/analysis-time', json=body)
    assert first.status_code == 200, first.text
    assert client.post('/api/training/analysis-time', json=body).json() == first.json()
    assert client.post('/api/training/analysis-time', json=payload(duration_ms=5000)).status_code == 200
    with db.get_conn() as conn:
        link = conn.execute('SELECT * FROM training_activity_links').fetchone()
        credits = conn.execute('SELECT * FROM training_activity_credits').fetchall()
        assert link['tool'] == 'analysis' and link['origin'] == 'free' and link['program_id'] is None
        assert json.loads(link['resource']) == {'type': 'tool', 'id': 'analysis'}
        assert sum(row['duration_ms'] for row in credits) == 20000
        assert all(row['duration_kind'] == 'active' and row['quantity'] == 0 for row in credits)
        assert conn.execute('SELECT COUNT(*) FROM training_programs').fetchone()[0] == 0
        category = next(row for row in training_categories.overview(conn, 1)['categories'] if row['id'] == 'analysis')
        assert category['today']['duration_ms'] == category['progress']['duration_ms'] == 20000
        assert category['today']['target'] == category['progress']['target'] == 0
    assert client.post('/api/training/analysis-time', json={**body, 'duration_ms': 20000}).status_code == 409


@pytest.mark.parametrize('duration', [0, -1, 90001, 1.5, True, '15000', None])
def test_reject_invalid_or_unbounded_duration(client, duration):
    assert client.post('/api/training/analysis-time', json=payload(duration_ms=duration)).status_code == 422


def test_saved_game_and_deleted_source_keep_original_resource(client):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(1,'Study','{}','today')")
        conn.execute("INSERT INTO entries(id,base_id,title,pgn,created_at,updated_at) VALUES(1,1,'Game','1. e4 *','today','today')")
        programs.init_schema(conn)
    assert client.post('/api/training/analysis-time', json=payload(entry_id=1)).status_code == 200
    with db.get_conn() as conn:
        first = dict(conn.execute('SELECT * FROM training_activity_links').fetchone())
        assert json.loads(first['resource'])['type'] == 'base'
        assert first['title'] == 'Game'
        conn.execute('DELETE FROM entries WHERE id=1')
    assert client.post('/api/training/analysis-time', json=payload(entry_id=1)).status_code == 200
    with db.get_conn() as conn:
        assert conn.execute('SELECT resource FROM training_activity_links').fetchone()[0] == first['resource']
        assert conn.execute('SELECT SUM(duration_ms) FROM training_activity_credits').fetchone()[0] == 30000


def test_endpoint_rejects_nonlocal_access_without_recording_time(client):
    client.app.dependency_overrides.clear()
    assert client.post('/api/training/analysis-time', json=payload(), headers={'Host': 'remote.example'}).status_code == 403
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM training_activity_credits').fetchone()[0] == 0
