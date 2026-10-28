"""Persisted live-analysis limits, separate from play/explorer/legacy analysis."""
import json

import chess
import pytest
from local_test_client import TestClient

import app
import db
from analysis_limits import MAX_TIME_MS, MAX_DEPTH
import interactive_engine
import jobs
import training


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'engine-settings.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)
    monkeypatch.setattr(interactive_engine, 'close', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 51006)) as value:
        yield value


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


def preferences():
    with db.get_conn() as conn:
        return {row['key']: row['value'] for row in conn.execute('SELECT key,value FROM preferences')}


def test_settings_require_owner_and_same_origin(client):
    assert client.get('/api/engine/settings', headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.patch('/api/engine/settings', json={'depth': 20}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.get('/api/status').status_code == 200
    assert client.patch('/api/engine/settings', json={'depth': 20},
                        headers={'Origin': 'https://foreign.example'}).status_code == 403


def test_defaults_read_without_write_and_partial_updates_persist(owner):
    before = preferences()
    assert owner.get('/api/engine/settings').json() == {'mode': 'time', 'time_ms': 1000, 'depth': 18}
    assert preferences() == before
    first = owner.patch('/api/engine/settings', json={'mode': 'depth', 'depth': 24})
    assert first.status_code == 200
    assert first.json() == {'mode': 'depth', 'time_ms': 1000, 'depth': 24}
    assert owner.patch('/api/engine/settings', json={'time_ms': 4500}).json() == {
        'mode': 'depth', 'time_ms': 4500, 'depth': 24}
    after = preferences()
    stored = json.loads(after.pop(training.ENGINE_SETTINGS_KEY))
    assert stored == owner.get('/api/engine/settings').json()
    assert after == before
    assert owner.patch('/api/engine/settings', json={'mode': 'time'}).json() == {
        'mode': 'time', 'time_ms': 4500, 'depth': 24}


@pytest.mark.parametrize('patch', [
    {'mode': 'unknown'}, {'mode': True}, {'mode': None}, {'mode': []},
    {'time_ms': 99}, {'time_ms': MAX_TIME_MS + 1}, {'time_ms': True}, {'time_ms': False},
    {'time_ms': 1000.5}, {'time_ms': '1000'}, {'time_ms': None},
    {'depth': 0}, {'depth': MAX_DEPTH + 1}, {'depth': True}, {'depth': 18.5}, {'depth': '18'}, {'depth': None},
    {'threads': 16}, {'engine_depth': 18},
])
def test_invalid_patch_is_atomic(owner, patch):
    assert owner.patch('/api/engine/settings', json={'mode': 'depth', 'time_ms': 2000, 'depth': 20}).status_code == 200
    before = preferences()
    response = owner.patch('/api/engine/settings', json={'time_ms': 5000, **patch})
    assert response.status_code == 400, response.text
    assert preferences() == before
    assert owner.get('/api/engine/settings').json() == {'mode': 'depth', 'time_ms': 2000, 'depth': 20}


@pytest.mark.parametrize('time_ms,depth', [(100, 1), (60001, 80), (3600000, 245), (MAX_TIME_MS, MAX_DEPTH)])
def test_settings_accept_exact_bounds(owner, time_ms, depth):
    response = owner.patch('/api/engine/settings', json={'time_ms': time_ms, 'depth': depth})
    assert response.status_code == 200 and response.json() == {'mode': 'time', 'time_ms': time_ms, 'depth': depth}


@pytest.mark.parametrize('raw,expected', [
    ('{"mode":"depth"}', {'mode': 'depth', 'time_ms': 1000, 'depth': 18}),
    ('{"time_ms":false,"depth":25,"other":1}', {'mode': 'time', 'time_ms': 1000, 'depth': 25}),
    ('not json', {'mode': 'time', 'time_ms': 1000, 'depth': 18}),
    ('[]', {'mode': 'time', 'time_ms': 1000, 'depth': 18}),
])
def test_partial_or_invalid_persisted_settings_read_safely_without_rewrite(owner, raw, expected):
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences(key,value) VALUES(?,?)', (training.ENGINE_SETTINGS_KEY, raw))
    before = preferences()
    assert owner.get('/api/engine/settings').json() == expected
    assert preferences() == before


@pytest.mark.parametrize('time_ms,depth', [(100, None), (3600000, None), (None, 80), (None, None), (60000, 30)])
def test_stream_forwards_time_and_depth_options(owner, monkeypatch, time_ms, depth):
    seen = []
    def analyse(fen, multipv, duration, **options):
        seen.append((fen, multipv, duration, options['depth'], options['force']))
        return {'fen': fen, 'engine': 'test', 'lines': []}
    monkeypatch.setattr(interactive_engine, 'analyse', analyse)
    response = owner.post('/api/engine/analyse/stream', json={
        'fen': chess.STARTING_FEN, 'multipv': 3, 'time_ms': time_ms, 'depth': depth, 'refresh': True})
    assert response.status_code == 200
    assert seen == [(chess.STARTING_FEN, 3, time_ms, depth, True)]
    assert json.loads(response.text)['type'] == 'done'


@pytest.mark.parametrize('patch', [
    {'time_ms': 99}, {'time_ms': MAX_TIME_MS + 1}, {'time_ms': True}, {'time_ms': '1000'}, {'time_ms': 1000.0},
    {'depth': 0}, {'depth': MAX_DEPTH + 1}, {'depth': True}, {'depth': '18'}, {'depth': 18.0},
])
def test_stream_limits_reject_before_engine_or_stream_headers(owner, monkeypatch, patch):
    monkeypatch.setattr(interactive_engine, 'analyse', lambda *args, **kwargs: pytest.fail('Invalid request reached engine'))
    response = owner.post('/api/engine/analyse/stream', json={'fen': chess.STARTING_FEN, **patch})
    assert response.status_code == 422
    assert response.headers['content-type'].startswith('application/json')


def test_json_analysis_accepts_long_duration_and_play_stays_bounded(owner, monkeypatch):
    seen = []
    monkeypatch.setattr(training.engine, 'analyse', lambda *args, **kwargs: seen.append(args) or {'lines': []})
    monkeypatch.setattr(training.engine, 'play', lambda *args, **kwargs: pytest.fail('Invalid play request reached engine'))
    assert owner.post('/api/engine/analyse', json={'fen': chess.STARTING_FEN, 'time_ms': 3600000}).status_code == 200
    assert seen == [(chess.STARTING_FEN, 3, 3600000)]
    assert owner.post('/api/engine/play', json={'fen': chess.STARTING_FEN, 'time_ms': 2001}).status_code == 422


def test_depth_only_stream_does_not_inherit_default_time(owner, monkeypatch):
    seen = []
    def analyse(fen, multipv, duration, **options):
        seen.append((duration, options['depth']))
        return {'lines': []}
    monkeypatch.setattr(interactive_engine, 'analyse', analyse)
    assert owner.post('/api/engine/analyse/stream', json={'fen': chess.STARTING_FEN, 'depth': 80}).status_code == 200
    assert seen == [(None, 80)]


def test_infinite_mode_persists_without_losing_other_choices(owner):
    response = owner.patch('/api/engine/settings', json={'mode': 'infinite', 'time_ms': 3600000, 'depth': 80})
    assert response.status_code == 200
    assert owner.get('/api/engine/settings').json() == {'mode': 'infinite', 'time_ms': 3600000, 'depth': 80}


def test_json_analysis_cancels_worker_when_client_disconnects(monkeypatch):
    import asyncio
    import threading
    import engine_api
    import engine
    from fastapi import HTTPException
    started, stopped = threading.Event(), threading.Event()
    def analyse(*args, cancel=None):
        started.set()
        assert cancel.wait(2), 'Disconnected JSON search did not receive cancellation'
        stopped.set()
        raise engine.AnalysisCancelled()
    class Connection:
        async def is_disconnected(self):
            return started.is_set()
    monkeypatch.setattr(engine, 'analyse', analyse)
    with pytest.raises(HTTPException) as error:
        asyncio.run(engine_api.analyse(
            engine_api.AnalysisRequest(fen=chess.STARTING_FEN, time_ms=86400000), Connection()))
    assert error.value.status_code == 499
    assert stopped.is_set()
