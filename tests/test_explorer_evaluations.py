"""Each explorer move receives its own root-constrained, White-POV score."""
import asyncio
import io
import json
import threading
from types import SimpleNamespace

import chess
import pytest
from fastapi import HTTPException
from local_test_client import TestClient

import app
import db
import engine
import explorer_evaluations as evaluations


@pytest.fixture(autouse=True)
def empty_cache():
    evaluations.clear_cache()
    yield
    evaluations.clear_cache()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'evaluations.sqlite3')

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        yield client


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


def score_stub(monkeypatch, cp=23, mate=None):
    calls = []
    monkeypatch.setattr(engine, 'binary_path', lambda: '/test/stockfish')
    def run(board, time_ms, **kwargs):
        calls.append((board.fen(), time_ms, kwargs))
        return {'engine': 'Testfish', 'lines': [{'uci': kwargs['root_moves'][0].uci(), 'cp': cp, 'mate': mate, 'depth': 12}]}
    monkeypatch.setattr(engine, '_run', run)
    return calls


def test_endpoint_requires_owner_and_restricts_exact_move(owner, monkeypatch):
    calls = score_stub(monkeypatch)
    response = owner.post('/api/explorer/evaluate', json={'fen': chess.STARTING_FEN, 'uci': 'a2a3'})
    assert response.status_code == 200, response.text
    assert response.json() == {'fen': chess.STARTING_FEN, 'uci': 'a2a3', 'cp': 23, 'mate': None,
                               'depth': 12, 'engine': 'Testfish', 'cached': False,
                               'requested_depth': None, 'depth_reached': True}
    assert len(calls) == 1
    fen, time_ms, kwargs = calls[0]
    assert fen == chess.STARTING_FEN and time_ms == 250
    assert isinstance(kwargs.pop('cancel'), threading.Event)
    assert kwargs == {'multipv': 1, 'root_moves': [chess.Move.from_uci('a2a3')]}
    owner.cookies.clear()
    assert owner.post('/api/explorer/evaluate', json={'fen': chess.STARTING_FEN, 'uci': 'a2a3'}, headers={'Host': 'remote.invalid'}).status_code == 403


@pytest.mark.parametrize('payload', [
    {}, {'fen': chess.STARTING_FEN}, {'uci': 'e2e4'},
    {'fen': chess.STARTING_FEN, 'uci': 'e2e4', 'time_ms': 500000},
    {'fen': True, 'uci': 'e2e4'}, {'fen': {}, 'uci': 'e2e4'},
    {'fen': 'x' * 257, 'uci': 'e2e4'}, {'fen': '', 'uci': 'e2e4'},
    {'fen': 'broken', 'uci': 'e2e4'}, {'fen': chess.STARTING_FEN, 'uci': True},
    {'fen': chess.STARTING_FEN, 'uci': ['e2e4']}, {'fen': chess.STARTING_FEN, 'uci': 'E2E4'},
    {'fen': chess.STARTING_FEN, 'uci': 'e2e5'}, {'fen': chess.STARTING_FEN, 'uci': '0000'},
    {'fen': chess.STARTING_FEN, 'uci': 'e2e4q'}, {'fen': chess.STARTING_FEN, 'uci': 'e2e4\nquit'},
])
def test_invalid_input_never_invokes_engine(owner, monkeypatch, payload):
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('Invalid request invoked engine'))
    assert owner.post('/api/explorer/evaluate', json=payload).status_code == 422


def test_root_automatic_draw_is_rejected_even_if_moves_exist(monkeypatch):
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('Game-over root invoked engine'))
    for fen, uci in [('7k/8/8/8/8/8/8/K7 w - - 0 1', 'a1a2'),
                     ('7k/8/8/8/8/8/8/K5R1 w - - 150 1', 'g1g2')]:
        with pytest.raises(HTTPException) as error:
            evaluations.evaluate({'fen': fen, 'uci': uci})
        assert error.value.status_code == 422


@pytest.mark.parametrize('fen,uci,cp,mate', [
    ('7k/8/5KQ1/8/8/8/8/8 w - - 0 1', 'g6g7', None, 1),
    ('8/8/8/8/8/5kq1/8/7K b - - 0 1', 'g3g2', None, -1),
    ('7k/8/5KQ1/8/8/8/8/8 w - - 0 1', 'g6f7', 0, None),
    ('7k/8/8/8/8/8/1r6/K7 w - - 0 1', 'a1b2', 0, None),
    ('7k/8/8/8/8/8/8/K5R1 w - - 149 1', 'g1g2', 0, None),
])
def test_immediate_terminal_move_is_exact_without_engine(monkeypatch, fen, uci, cp, mate):
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('Terminal child does not need engine'))
    response = evaluations.evaluate({'fen': fen, 'uci': uci})
    assert response['cp'] == cp and response['mate'] == mate
    assert response['depth'] == 0 and response['engine'] == 'Règles des échecs'


def test_cache_keeps_full_position_engine_identity_and_is_bounded(monkeypatch):
    calls = score_stub(monkeypatch)
    monkeypatch.setattr(evaluations, 'CACHE_LIMIT', 2)
    payload = {'fen': chess.STARTING_FEN, 'uci': 'e2e4'}
    result = evaluations.evaluate(payload)
    result['cp'] = 9000
    assert evaluations.evaluate(payload)['cp'] == 23
    assert evaluations.evaluate(payload)['cached'] is True
    assert len(calls) == 1
    changed_clock = chess.STARTING_FEN.replace('0 1', '99 50')
    evaluations.evaluate({**payload, 'fen': changed_clock})
    assert len(calls) == 2
    monkeypatch.setattr(engine, 'binary_path', lambda: '/other/stockfish')
    assert evaluations.evaluate(payload)['cached'] is False
    assert len(calls) == 3 and len(evaluations._CACHE) == 2
    monkeypatch.setattr(engine, 'binary_path', lambda: '/test/stockfish')
    assert evaluations.evaluate(payload)['cached'] is False  # Oldest was evicted.
    assert len(calls) == 4


def test_cache_normalizes_equivalent_fen_and_preserves_underpromotion(monkeypatch):
    calls = score_stub(monkeypatch)
    fen = '7k/P7/8/8/8/8/8/KR6 w - - 0 1'
    result = evaluations.evaluate({'fen': fen, 'uci': 'a7a8n'})
    assert result['uci'] == 'a7a8n'
    assert calls[0][2]['root_moves'] == [chess.Move.from_uci('a7a8n')]
    assert evaluations.evaluate({'fen': ' '.join(fen.split()[:4]), 'uci': 'a7a8n'})['cached'] is True
    assert evaluations.evaluate({'fen': fen, 'uci': 'a7a8q'})['cached'] is False


@pytest.mark.parametrize('line', [None, {'uci': 'd2d4', 'cp': 90, 'mate': None},
    {'uci': 'e2e4', 'cp': None, 'mate': None}, {'uci': 'e2e4', 'cp': True, 'mate': None},
    {'uci': 'e2e4', 'cp': 30, 'mate': 2}])
def test_missing_or_wrong_move_score_is_never_cached(monkeypatch, line):
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: {'engine': 'Testfish', 'lines': [line] if line else []})
    with pytest.raises(HTTPException) as error:
        evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': 'e2e4'})
    assert error.value.status_code == 503
    assert not evaluations._CACHE


def fake_worker(monkeypatch, lines):
    sent = []
    class Input(io.StringIO):
        def write(self, text):
            sent.append(text.strip())
            return super().write(text)
    worker = SimpleNamespace(stdin=Input(), stdout=io.StringIO(lines), wait=lambda **kw: 0, kill=lambda: None)
    monkeypatch.setattr(engine, 'binary_path', lambda: '/test/stockfish')
    monkeypatch.setattr(engine.subprocess, 'Popen', lambda *a, **kw: worker)
    monkeypatch.setattr(engine, '_NAME', None)
    return sent


@pytest.mark.parametrize('turn,kind,score,expected', [
    (chess.WHITE, 'cp', 37, 37), (chess.BLACK, 'cp', 37, -37),
    (chess.WHITE, 'mate', -4, -4), (chess.BLACK, 'mate', 3, -3),
])
def test_uci_searchmoves_and_white_score_conversion(monkeypatch, turn, kind, score, expected):
    board = chess.Board()
    if turn == chess.BLACK:
        board.push_uci('e2e4')
    uci = 'a2a3' if turn == chess.WHITE else 'a7a6'
    sent = fake_worker(monkeypatch, f'uciok\nreadyok\ninfo depth 9 score {kind} {score} pv {uci}\nbestmove {uci}\n')
    result = engine._run(board, 250, multipv=1, root_moves=[chess.Move.from_uci(uci)])
    assert f'go movetime 250 searchmoves {uci}' in sent
    assert result['lines'][0][kind] == expected
    assert result['lines'][0]['uci'] == uci


@pytest.mark.parametrize('info_move,best_move', [('d2d4', 'd2d4'), ('d2d4', 'e2e4'), ('e2e4', 'd2d4')])
def test_engine_ignoring_root_constraint_is_not_accepted(monkeypatch, info_move, best_move):
    fake_worker(monkeypatch, f'uciok\nreadyok\ninfo depth 9 score cp 20 pv {info_move}\nbestmove {best_move}\n')
    with pytest.raises(HTTPException) as error:
        engine._run(chess.Board(), 250, multipv=1, root_moves=[chess.Move.from_uci('e2e4')])
    assert error.value.status_code == 503


def test_unavailable_engine_is_reported_without_cached_score(monkeypatch):
    monkeypatch.setattr(engine, 'binary_path', lambda: None)
    with pytest.raises(HTTPException) as error:
        evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': 'e2e4'})
    assert error.value.status_code == 503
    assert not evaluations._CACHE


@pytest.mark.parametrize('fen,uci,sign', [
    ('6k1/5ppp/8/8/8/8/5PPP/3Q2K1 w - - 0 1', 'd1a1', 1),
    ('3q2k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1', 'd8a8', -1),
])
def test_real_stockfish_white_pov_for_both_sides(fen, uci, sign):
    if not engine.binary_path():
        pytest.skip('Stockfish is required')
    result = evaluations.evaluate({'fen': fen, 'uci': uci})
    assert result['uci'] == uci and result['depth'] > 0
    score = result['cp'] if result['cp'] is not None else result['mate']
    assert score * sign > 0


def test_real_stockfish_evaluates_a_move_outside_top_three():
    if not engine.binary_path():
        pytest.skip('Stockfish is required')
    leaders = {line['uci'] for line in engine.analyse(chess.STARTING_FEN, multipv=3, time_ms=150)['lines']}
    candidate = next(move for move in ['g2g4', 'f2f3', 'a2a3', 'h2h3'] if move not in leaders)
    result = evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': candidate})
    assert result['uci'] == candidate and result['depth'] > 0
    assert result['cp'] is not None or result['mate'] is not None


@pytest.mark.parametrize('depth', [False, True, 0, 2**31, -1, 12.0, '12', [], {}])
def test_invalid_depth_never_invokes_engine(monkeypatch, depth):
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('Invalid depth invoked engine'))
    with pytest.raises(HTTPException) as error:
        evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': 'e2e4', 'depth': depth})
    assert error.value.status_code == 422


@pytest.mark.parametrize('depth,reached', [(1, True), (7, True), (12, True), (31, False), (64, False)])
def test_custom_depth_is_real_and_reports_attained_depth(monkeypatch, depth, reached):
    calls = score_stub(monkeypatch)
    result = evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': 'e2e4', 'depth': depth})
    assert calls[0][1] is None
    assert calls[0][2]['depth'] == depth
    assert result['requested_depth'] == depth
    assert result['depth'] == 12 and result['depth_reached'] is reached
    assert result['cp'] == 23  # A result below the requested target remains explicitly marked.


def test_cache_isolates_requested_depth_and_quick_time(monkeypatch):
    calls = score_stub(monkeypatch)
    payload = {'fen': chess.STARTING_FEN, 'uci': 'e2e4'}
    assert evaluations.evaluate(payload)['cached'] is False
    assert evaluations.evaluate({**payload, 'depth': None})['cached'] is True
    assert evaluations.evaluate({**payload, 'depth': 12})['cached'] is False
    assert evaluations.evaluate({**payload, 'depth': 18})['cached'] is False
    assert evaluations.evaluate({**payload, 'depth': 12})['cached'] is True
    monkeypatch.setattr(evaluations, 'TIME_MS', 500)
    assert evaluations.evaluate({**payload, 'depth': 18})['cached'] is True
    assert evaluations.evaluate(payload)['cached'] is False
    assert calls[-1][1] == 500 and len(calls) == 4


def test_terminal_result_is_exact_even_at_high_requested_depth(monkeypatch):
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('Terminal child invoked engine'))
    result = evaluations.evaluate({'fen': '7k/8/5KQ1/8/8/8/8/8 w - - 0 1', 'uci': 'g6g7', 'depth': 30})
    assert result['requested_depth'] == 30 and result['depth'] == 0
    assert result['depth_reached'] is True and result['mate'] == 1


def test_custom_depth_uci_command_retains_movetime_limit(monkeypatch):
    sent = fake_worker(monkeypatch, 'uciok\nreadyok\ninfo depth 12 score cp 20 pv e2e4\nbestmove e2e4\n')
    result = engine._run(chess.Board(), 10000, multipv=1,
                         root_moves=[chess.Move.from_uci('e2e4')], depth=12)
    assert 'go depth 12 movetime 10000 searchmoves e2e4' in sent
    assert result['lines'][0]['depth'] == 12


def test_real_stockfish_reaches_custom_depth():
    if not engine.binary_path():
        pytest.skip('Stockfish is required')
    result = evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': 'e2e4', 'depth': 12})
    assert result['requested_depth'] == 12
    assert result['depth'] >= 12 and result['depth_reached'] is True
    assert result['cp'] is not None or result['mate'] is not None


def _run_in_test_thread(callback):
    errors = []
    def run():
        try:
            callback()
        except Exception as error:
            errors.append(error)
    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    return worker, errors


def test_cancel_while_waiting_for_shared_engine_does_not_release_other_owner(monkeypatch):
    monkeypatch.setattr(engine, 'binary_path', lambda: '/test/stockfish')
    monkeypatch.setattr(engine.subprocess, 'Popen', lambda *a, **kw: pytest.fail('Canceled request started engine'))
    cancel = threading.Event()
    assert engine._LOCK.acquire(timeout=1)
    try:
        worker, errors = _run_in_test_thread(lambda: engine._run(chess.Board(), None, multipv=1, depth=64, cancel=cancel))
        cancel.set()
        worker.join(timeout=1)
        assert not worker.is_alive()
        assert len(errors) == 1 and isinstance(errors[0], engine.AnalysisCancelled)
        assert engine._LOCK.locked()  # The first request still owns it.
    finally:
        engine._LOCK.release()


def test_cancel_silent_engine_closes_process_and_releases_lock(monkeypatch):
    search_started, output_closed = threading.Event(), threading.Event()
    sent, closed = [], []
    class Input(io.StringIO):
        def write(self, text):
            sent.append(text.strip())
            if text.startswith('go '):
                search_started.set()
            return super().write(text)
    class Output:
        def __iter__(self):
            yield 'uciok\n'
            yield 'readyok\n'
            output_closed.wait(3)
        def close(self):
            closed.append(True)
            output_closed.set()
    process = SimpleNamespace(stdin=Input(), stdout=Output(),
                              wait=lambda **kw: output_closed.set(), kill=lambda: output_closed.set())
    monkeypatch.setattr(engine, 'binary_path', lambda: '/test/stockfish')
    monkeypatch.setattr(engine.subprocess, 'Popen', lambda *a, **kw: process)
    cancel = threading.Event()
    worker, errors = _run_in_test_thread(lambda: engine._run(chess.Board(), 10000, multipv=1, depth=30, cancel=cancel))
    try:
        assert search_started.wait(1)
        cancel.set()
        worker.join(timeout=1)
        assert not worker.is_alive()
        assert len(errors) == 1 and isinstance(errors[0], engine.AnalysisCancelled)
        assert closed and 'quit' in sent and not engine._LOCK.locked()
    finally:
        cancel.set()
        output_closed.set()
        worker.join(timeout=2)
    # A subsequent board can immediately use the same shared engine.
    fake_worker(monkeypatch, 'uciok\nreadyok\ninfo depth 8 score cp 12 pv e2e4\nbestmove e2e4\n')
    assert engine._run(chess.Board(), 250, multipv=1)['lines'][0]['cp'] == 12


def test_cancellation_after_calculation_never_caches_score(monkeypatch):
    cancel = threading.Event()
    def calculate(*args, **kwargs):
        cancel.set()
        return {'cp': 20, 'mate': None, 'depth': 12, 'depth_reached': True, 'engine': 'Testfish'}
    monkeypatch.setattr(evaluations, '_calculate', calculate)
    with pytest.raises(engine.AnalysisCancelled):
        evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': 'e2e4'}, cancel=cancel)
    assert not evaluations._CACHE


def test_app_disconnect_cancels_worker_through_http_middleware(owner, monkeypatch):
    started, cancelled = threading.Event(), threading.Event()
    def slow_run(*args, cancel=None, **kwargs):
        started.set()
        if cancel.wait(2):
            cancelled.set()
            raise engine.AnalysisCancelled()
        pytest.fail('Disconnected request kept the engine busy')
    monkeypatch.setattr(engine, '_run', slow_run)
    body = json.dumps({'fen': chess.STARTING_FEN, 'uci': 'e2e4', 'depth': 30}).encode()
    cookie = '; '.join(f'{key}={value}' for key, value in owner.cookies.items()).encode()
    async def dispatch():
        incoming = asyncio.Queue()
        incoming.put_nowait({'type': 'http.request', 'body': body, 'more_body': False})
        sent = []
        async def send(message):
            sent.append(message)
        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
                 'method': 'POST', 'scheme': 'http', 'path': '/api/explorer/evaluate',
                 'raw_path': b'/api/explorer/evaluate', 'query_string': b'', 'root_path': '',
                 'headers': [(b'host', b'localhost'), (b'content-type', b'application/json'),
                             (b'content-length', str(len(body)).encode()), (b'cookie', cookie)],
                 'client': ('127.0.0.1', 50000), 'server': ('localhost', 80)}
        request_task = asyncio.create_task(app.app(scope, incoming.get, send))
        try:
            for _ in range(100):
                if started.is_set():
                    break
                await asyncio.sleep(0.01)
            assert started.is_set(), sent
            incoming.put_nowait({'type': 'http.disconnect'})
            await asyncio.wait_for(request_task, timeout=2)
        finally:
            if not request_task.done():
                request_task.cancel()
                await asyncio.gather(request_task, return_exceptions=True)
    asyncio.run(dispatch())
    assert cancelled.is_set() and not evaluations._CACHE


def test_endpoint_task_cancellation_signals_worker_and_does_not_cache(monkeypatch):
    started, cancelled = threading.Event(), threading.Event()
    def slow_run(*args, cancel=None, **kwargs):
        started.set()
        if cancel.wait(2):
            cancelled.set()
            raise engine.AnalysisCancelled()
        pytest.fail('Canceled request kept the engine busy')
    monkeypatch.setattr(engine, '_run', slow_run)
    class Request:
        async def receive(self):
            await asyncio.Event().wait()
    async def dispatch():
        task = asyncio.create_task(evaluations.evaluate_request(
            {'fen': chess.STARTING_FEN, 'uci': 'e2e4', 'depth': 30}, Request()))
        for _ in range(100):
            if started.is_set():
                break
            await asyncio.sleep(0.01)
        assert started.is_set()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        for _ in range(100):
            if cancelled.is_set():
                break
            await asyncio.sleep(0.01)
        assert cancelled.is_set()
        await asyncio.sleep(0.02)  # Let the callback consume the worker's exception.
    asyncio.run(dispatch())
    assert not evaluations._CACHE


def test_cache_invalidates_when_engine_replaced_at_same_path(monkeypatch):
    calls = score_stub(monkeypatch)
    identity = ['old-build']
    monkeypatch.setattr(engine, 'binary_identity', lambda path: identity[0])
    payload = {'fen': chess.STARTING_FEN, 'uci': 'e2e4'}
    assert evaluations.evaluate(payload)['cached'] is False
    assert evaluations.evaluate(payload)['cached'] is True
    identity[0] = 'new-build'
    assert evaluations.evaluate(payload)['cached'] is False
    assert len(calls) == 2


def test_selection_change_during_calculation_is_not_cached_under_old_engine(monkeypatch):
    calls = score_stub(monkeypatch)
    run = engine._run
    def change_engine(*args, **kwargs):
        result = run(*args, **kwargs)
        monkeypatch.setattr(engine, 'binary_path', lambda: '/new/engine')
        return result
    monkeypatch.setattr(engine, '_run', change_engine)
    assert evaluations.evaluate({'fen': chess.STARTING_FEN, 'uci': 'e2e4'})['cp'] == 23
    assert len(calls) == 1 and not evaluations._CACHE


def test_depth_only_uci_command_has_no_hidden_time_limit(monkeypatch):
    sent = fake_worker(monkeypatch, 'uciok\nreadyok\ninfo depth 64 score cp 20 pv e2e4\nbestmove e2e4\n')
    result = engine._run(chess.Board(), None, multipv=1,
                         root_moves=[chess.Move.from_uci('e2e4')], depth=64)
    assert 'go depth 64 searchmoves e2e4' in sent
    assert not any('movetime' in message for message in sent)
    assert result['lines'][0]['depth'] == 64
