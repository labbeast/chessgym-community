"""Progressive engine transport, independent of Stockfish and personal databases."""
import asyncio
import json
import threading

import chess
import pytest
from fastapi import HTTPException
from local_test_client import TestClient

import app
import db
import interactive_engine
import jobs
import training


class Connection:
    disconnected = False

    async def is_disconnected(self):
        return self.disconnected


def snapshot(depth=1, fen=chess.STARTING_FEN):
    return {'fen': fen, 'engine': 'Stockfish test', 'lines': [
        {'cp': 25, 'mate': None, 'depth': depth, 'uci': ['e2e4'], 'san': ['e4']}]}


def decode(value):
    return json.loads(value)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'engine-stream.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)
    monkeypatch.setattr(interactive_engine, 'close', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as value:
        yield value


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


def test_snapshot_arrives_before_final_engine_result(monkeypatch):
    finish = threading.Event()
    completed = threading.Event()

    def analyse(fen, multipv, time_ms, *, depth=None, cancel, on_update, force=False):
        assert (fen, multipv, time_ms) == (chess.STARTING_FEN, 2, 900)
        on_update(snapshot(4))
        assert finish.wait(2)
        completed.set()
        return snapshot(18)

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)

    async def scenario():
        response = await training.analyse_stream(Connection(), training.StreamAnalysisRequest(
            fen=chess.STARTING_FEN, multipv=2, time_ms=900))
        assert response.media_type == 'application/x-ndjson'
        first = decode(await asyncio.wait_for(anext(response.body_iterator), 1))
        assert first['type'] == 'info' and first['lines'][0]['depth'] == 4
        assert not completed.is_set()
        finish.set()
        remaining = [decode(chunk) async for chunk in response.body_iterator]
        assert remaining[-1]['type'] == 'done' and remaining[-1]['lines'][0]['depth'] == 18
        assert completed.is_set()

    try:
        asyncio.run(scenario())
    finally:
        finish.set()


def test_disconnect_cancels_running_search_and_awaits_release(monkeypatch):
    stopped = threading.Event()
    connection = Connection()

    def analyse(fen, multipv, time_ms, *, depth=None, cancel, on_update, force=False):
        on_update(snapshot())
        assert cancel.wait(2)
        stopped.set()
        return snapshot(2)

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)

    async def scenario():
        response = await training.analyse_stream(connection, training.StreamAnalysisRequest(fen=chess.STARTING_FEN))
        assert decode(await anext(response.body_iterator))['type'] == 'info'
        connection.disconnected = True
        assert [chunk async for chunk in response.body_iterator] == []
        assert stopped.is_set()

    asyncio.run(scenario())


def test_generator_close_cancels_running_search(monkeypatch):
    stopped = threading.Event()

    def analyse(fen, multipv, time_ms, *, depth=None, cancel, on_update, force=False):
        on_update(snapshot())
        assert cancel.wait(2)
        stopped.set()
        return snapshot()

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)

    async def scenario():
        response = await training.analyse_stream(Connection(), training.StreamAnalysisRequest(fen=chess.STARTING_FEN))
        await anext(response.body_iterator)
        await response.body_iterator.aclose()
        assert stopped.is_set()

    asyncio.run(scenario())


def test_cancel_while_queued_signals_worker_without_waiting_for_first_result(monkeypatch):
    started = threading.Event()
    stopped = threading.Event()

    def analyse(fen, multipv, time_ms, *, depth=None, cancel, on_update, force=False):
        started.set()
        assert cancel.wait(2)
        stopped.set()
        return snapshot()

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)

    async def scenario():
        response = await training.analyse_stream(Connection(), training.StreamAnalysisRequest(fen=chess.STARTING_FEN))
        pending = asyncio.create_task(anext(response.body_iterator))
        assert await asyncio.to_thread(started.wait, 1)
        pending.cancel()
        with pytest.raises(asyncio.CancelledError):
            await pending
        assert stopped.is_set()

    asyncio.run(scenario())


def test_already_disconnected_client_does_not_start_engine(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('A disconnected board must not start an engine search.')

    monkeypatch.setattr(interactive_engine, 'analyse', forbidden)
    connection = Connection()
    connection.disconnected = True

    async def scenario():
        response = await training.analyse_stream(connection, training.StreamAnalysisRequest(fen=chess.STARTING_FEN))
        assert [chunk async for chunk in response.body_iterator] == []

    asyncio.run(scenario())


def test_slow_consumer_gets_latest_final_result_without_backlog(monkeypatch):
    release = threading.Event()
    finished = threading.Event()

    def analyse(fen, multipv, time_ms, *, depth=None, cancel, on_update, force=False):
        on_update(snapshot(1))
        assert release.wait(2)
        for depth in range(2, 2000):
            on_update(snapshot(depth))
        finished.set()
        return snapshot(2000)

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)

    async def scenario():
        response = await training.analyse_stream(Connection(), training.StreamAnalysisRequest(fen=chess.STARTING_FEN))
        assert decode(await anext(response.body_iterator))['type'] == 'info'
        release.set()
        assert await asyncio.to_thread(finished.wait, 1)
        chunks = [decode(chunk) async for chunk in response.body_iterator]
        assert len(chunks) <= 2
        assert chunks[-1]['type'] == 'done' and chunks[-1]['lines'][0]['depth'] == 2000

    asyncio.run(scenario())


def test_invalid_fen_is_rejected_before_stream_headers(owner, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Invalid input must never reach the engine.')

    monkeypatch.setattr(interactive_engine, 'analyse', forbidden)
    for fen in ['not a fen', '8/8/8/8/8/8/8/8 w - - 0 1']:
        response = owner.post('/api/engine/analyse/stream', json={'fen': fen})
        assert response.status_code == 422
        assert response.headers['content-type'].startswith('application/json')


def test_authentication_and_origin_guard_stream(client, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('Unauthorized requests must never reach the engine.')

    monkeypatch.setattr(interactive_engine, 'analyse', forbidden)
    body = {'fen': chess.STARTING_FEN}
    assert client.post('/api/engine/analyse/stream', json=body, headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.get('/api/status').status_code == 200
    assert client.post('/api/engine/analyse/stream', json=body, headers={'Origin': 'https://foreign.example'}).status_code == 403


@pytest.mark.parametrize('fields', [{'multipv': 4}, {'multipv': 0}, {'time_ms': 50}, {'time_ms': interactive_engine.MAX_TIME_MS + 1}, {}])
def test_request_limits_before_stream(owner, fields, monkeypatch):
    monkeypatch.setattr(interactive_engine, 'analyse', lambda *args, **kwargs: pytest.fail('Invalid request reached engine'))
    body = {'fen': chess.STARTING_FEN, **fields} if fields else {}
    assert owner.post('/api/engine/analyse/stream', json=body).status_code == 422


@pytest.mark.parametrize('error,detail', [
    (HTTPException(503, 'Stockfish est indisponible.'), 'Stockfish est indisponible.'),
    (RuntimeError('private file / secret stderr'), 'L’analyse du moteur a été interrompue. Réessaie dans un instant.'),
    (HTTPException(503, {'secret': 'not user text'}), 'L’analyse du moteur a été interrompue. Réessaie dans un instant.'),
])
def test_stream_errors_keep_safe_message_and_finish(owner, monkeypatch, error, detail):
    def analyse(*args, **kwargs):
        raise error

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)
    response = owner.post('/api/engine/analyse/stream', json={'fen': chess.STARTING_FEN})
    assert response.status_code == 200
    messages = [json.loads(line) for line in response.text.splitlines()]
    assert messages == [{'type': 'error', 'fen': chess.STARTING_FEN, 'detail': detail}]
    assert response.headers['cache-control'] == 'no-store'
    assert response.headers['x-accel-buffering'] == 'no'


def test_cached_completion_preserves_requested_fen(owner, monkeypatch):
    board = chess.Board()
    board.push_uci('e2e4')
    fen = board.fen(en_passant='fen')
    normalized = board.fen()
    assert normalized != fen
    monkeypatch.setattr(interactive_engine, 'analyse', lambda *args, **kwargs: {**snapshot(15, normalized), 'cached': True})
    response = owner.post('/api/engine/analyse/stream', json={'fen': fen})
    messages = [json.loads(line) for line in response.text.splitlines()]
    assert len(messages) == 1 and messages[0]['type'] == 'done'
    assert messages[0]['cached'] and messages[0]['fen'] == fen


def test_old_json_analysis_route_remains_compatible(owner, monkeypatch):
    monkeypatch.setattr(training.engine, 'analyse', lambda *args, **kwargs: snapshot(12))
    response = owner.post('/api/engine/analyse', json={'fen': chess.STARTING_FEN})
    assert response.status_code == 200 and response.json() == snapshot(12)


def test_shutdown_closes_interactive_engine_after_jobs_stop(tmp_path, monkeypatch):
    events = []
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'shutdown.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: events.append('start'))
    monkeypatch.setattr(jobs, 'stop_worker', lambda: events.append('stop'))
    monkeypatch.setattr(interactive_engine, 'close', lambda: events.append('close'))
    with TestClient(app.app, base_url='http://localhost'):
        assert events == ['start']
    assert events == ['start', 'stop', 'close']


@pytest.mark.parametrize('spec_version', ['2.3', '2.4'])
def test_asgi_disconnect_releases_search_even_when_send_raises(monkeypatch, spec_version):
    stopped = threading.Event()

    def analyse(fen, multipv, time_ms, *, depth=None, cancel, on_update, force=False):
        on_update(snapshot())
        assert cancel.wait(2)
        stopped.set()
        return snapshot()

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)

    async def scenario():
        from starlette.requests import ClientDisconnect
        disconnected = asyncio.Event()
        response = await training.analyse_stream(Connection(), training.StreamAnalysisRequest(fen=chess.STARTING_FEN))

        async def receive():
            await disconnected.wait()
            return {'type': 'http.disconnect'}

        async def send(message):
            if message['type'] == 'http.response.body' and message.get('body'):
                if spec_version == '2.4':
                    raise OSError('Disconnected transport')
                disconnected.set()

        scope = {'type': 'http', 'asgi': {'spec_version': spec_version}}
        if spec_version == '2.4':
            with pytest.raises(ClientDisconnect):
                await response(scope, receive, send)
        else:
            await response(scope, receive, send)
        assert stopped.is_set()

    asyncio.run(scenario())


@pytest.mark.parametrize('refresh', [False, True])
def test_manual_refresh_is_forwarded_to_engine(owner, monkeypatch, refresh):
    seen = []

    def analyse(fen, multipv, time_ms, *, depth=None, cancel, on_update, force):
        seen.append(force)
        return snapshot()

    monkeypatch.setattr(interactive_engine, 'analyse', analyse)
    response = owner.post('/api/engine/analyse/stream', json={'fen': chess.STARTING_FEN, 'refresh': refresh})
    assert response.status_code == 200 and seen == [refresh]
