import threading
import time
from concurrent.futures import ThreadPoolExecutor

import chess
import pytest
from fastapi import HTTPException

import engine
import interactive_engine as live


@pytest.fixture(autouse=True)
def isolated_lane(monkeypatch):
    live.close()
    import resource_policy
    monkeypatch.setattr(resource_policy,'_CURRENT',resource_policy.defaults())
    monkeypatch.setattr(resource_policy,'_DESIRED',resource_policy.defaults())
    monkeypatch.setattr(resource_policy,'_IMPORT_ACTIVE',None)
    with live._CACHE_LOCK:
        live._CACHE.clear()
    yield
    live.close()
    with live._CACHE_LOCK:
        live._CACHE.clear()


@pytest.fixture
def real_engine():
    if not engine.binary_path():
        pytest.skip('Stockfish is not installed')


def after(*moves):
    board = chess.Board()
    for move in moves:
        board.push_uci(move)
    return board.fen()


def test_parser_rejects_bounds_malformed_rank_depth_and_scores():
    valid = 'info depth 12 multipv 1 score cp 30 pv e2e4 e7e5'
    assert live._raw_info(valid, 3)[0] == 1
    for line in [valid.replace('cp 30', 'cp 30 lowerbound'),
                 valid.replace('cp 30', 'cp 30 upperbound'),
                 valid.replace('cp 30', 'cp nope'),
                 valid.replace('cp 30', 'cp 1000001'),
                 valid.replace('cp 30', 'mate 10001'),
                 valid.replace('multipv 1', 'multipv 4'),
                 valid.replace('depth 12', f'depth {live.MAX_DEPTH + 1}'),
                 valid.replace('depth 12', 'depth 0'),
                 valid.replace('pv e2e4 e7e5', 'pv')]:
        assert live._raw_info(line, 3) is None


@pytest.mark.parametrize('kind,score,field,value', [('cp', 35, 'cp', -35), ('mate', -3, 'mate', 3)])
def test_snapshot_has_white_point_of_view_and_legal_positions(kind, score, field, value):
    board = chess.Board(after('e2e4'))
    result = live._line(board, {'kind': kind, 'score': score, 'depth': 12, 'pv': ['e7e5', 'g1f3']})
    assert result[field] == value
    assert result['san'] == ['e5', 'Nf3']
    assert result['positions'][-1]['fen'] == after('e2e4', 'e7e5', 'g1f3')
    assert live._line(board, {'kind': kind, 'score': score, 'depth': 12, 'pv': ['e7e5', 'e2e4']}) is None


def test_cache_is_bounded_and_returns_independent_copies():
    for index in range(live._CACHE_SIZE + 2):
        live._remember(index, {'lines': [{'pv': ['e2e4']}], 'cached': False})
    assert len(live._CACHE) == live._CACHE_SIZE
    assert live._cached(0) is None
    result = live._cached(2)
    result['lines'][0]['pv'].append('e7e5')
    assert live._cached(2)['lines'][0]['pv'] == ['e2e4']
    assert result['cached'] is True


def test_invalid_and_terminal_positions_do_not_start_worker():
    for fen in [None, 'invalid', '8/8/8/8/8/8/8/8 w - - 0 1']:
        with pytest.raises(HTTPException) as error:
            live.analyse(fen)
        assert error.value.status_code == 422
    result = live.analyse('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1')
    assert result['lines'] == []
    assert live._LANE is None


def test_real_stream_arrives_before_completion_and_reuses_process(real_engine):
    received = []
    result = live.analyse(chess.STARTING_FEN, 3, 500, on_update=lambda item: received.append((time.monotonic(), item)))
    finished = time.monotonic()
    assert received
    assert finished - received[0][0] > .15
    assert 1 <= len(result['lines']) <= 3
    assert result['cached'] is False
    worker = live._LANE.worker
    live.analyse(after('e2e4'), 3, 100)
    assert live._LANE.worker is worker
    assert worker.poll() is None
    for _, snapshot in received:
        for line in snapshot['lines']:
            board = chess.Board(snapshot['fen'])
            for uci, position in zip(line['pv'], line['positions']):
                board.push_uci(uci)
                assert board.fen() == position['fen']


def test_real_cache_options_force_and_callback_mutation(real_engine, monkeypatch):
    fen = chess.STARTING_FEN
    first = live.analyse(fen, 1, 100)
    worker = live._LANE.worker
    sent = []
    original = live._LANE._send
    monkeypatch.setattr(live._LANE, '_send', lambda command: (sent.append(command), original(command))[-1])
    cached = live.analyse(fen, 1, 100, on_update=lambda item: item['lines'].clear())
    assert cached['cached'] and cached['lines'] == first['lines']
    assert not sent
    assert live.analyse(fen, 1, 100, force=True)['cached'] is False
    assert any(command.startswith('go ') for command in sent)
    assert live._LANE.worker is worker
    assert live.analyse(fen, 2, 100)['cached'] is False
    assert live.analyse(fen, 1, 200)['cached'] is False
    changed_clock = fen.replace(' 0 1', ' 2 1')
    assert live.analyse(changed_clock, 1, 100)['cached'] is False
    changed_number = fen.replace(' 0 1', ' 0 2')
    assert live.analyse(changed_number, 1, 100)['cached'] is False


def test_live_lane_does_not_wait_for_report_or_explorer_gate(real_engine):
    assert engine._LOCK.acquire(timeout=.1)
    try:
        result = live.analyse(chess.STARTING_FEN, 1, 100)
        assert result['lines']
    finally:
        engine._LOCK.release()


def test_cancel_stops_promptly_drains_old_search_and_does_not_cache_it(real_engine):
    cancel = threading.Event()
    snapshots = []

    def changed(item):
        snapshots.append(item)
        cancel.set()

    started = time.monotonic()
    with pytest.raises(engine.AnalysisCancelled):
        live.analyse(chess.STARTING_FEN, 3, 3000, cancel=cancel, on_update=changed)
    assert time.monotonic() - started < 2
    assert snapshots
    worker = live._LANE.worker
    assert worker is not None and worker.poll() is None
    assert not live._CACHE
    fen = after('d2d4')
    result = live.analyse(fen, 3, 100)
    assert live._LANE.worker is worker
    assert result['fen'] == fen
    for line in result['lines']:
        board = chess.Board(fen)
        board.push_uci(line['uci'])
        assert line['positions'][0]['fen'] == board.fen()


def test_queued_cancellation_does_not_start_another_search(real_engine):
    active, cancel_active, cancel_queued = threading.Event(), threading.Event(), threading.Event()
    with ThreadPoolExecutor(max_workers=2) as pool:
        running = pool.submit(live.analyse, chess.STARTING_FEN, 1, 3000,
                              cancel=cancel_active, on_update=lambda _: active.set())
        assert active.wait(3)
        queued = pool.submit(live.analyse, after('e2e4'), 1, 1000, cancel=cancel_queued)
        cancel_queued.set()
        with pytest.raises(engine.AnalysisCancelled):
            queued.result(timeout=1)
        cancel_active.set()
        with pytest.raises(engine.AnalysisCancelled):
            running.result(timeout=2)
    assert not live._CACHE


def test_cached_read_bypasses_busy_live_lane_and_honours_cancel(real_engine):
    live.analyse(chess.STARTING_FEN, 1, 100)
    assert live._LANE.gate.acquire(timeout=.1)
    try:
        assert live.analyse(chess.STARTING_FEN, 1, 100)['cached']
        cancelled = threading.Event()
        cancelled.set()
        with pytest.raises(engine.AnalysisCancelled):
            live.analyse(chess.STARTING_FEN, 1, 100, cancel=cancelled)
    finally:
        live._LANE.gate.release()


def test_dead_process_recovers_on_next_request_and_close_releases_process(real_engine):
    live.analyse(chess.STARTING_FEN, 1, 100)
    worker = live._LANE.worker
    worker.kill()
    worker.wait(timeout=2)
    assert live.analyse(after('e2e4'), 1, 100)['lines']
    replacement = live._LANE.worker
    assert replacement is not worker
    live.close()
    assert replacement.poll() is not None
    assert live._LANE is None
    live.close()
    assert live.analyse(after('d2d4'), 1, 100)['lines']


def test_close_during_search_cancels_and_leaks_no_process(real_engine):
    ready = threading.Event()
    with ThreadPoolExecutor(max_workers=1) as pool:
        result = pool.submit(live.analyse, chess.STARTING_FEN, 1, 3000,
                             on_update=lambda _: ready.set())
        assert ready.wait(3)
        worker = live._LANE.worker
        live.close()
        with pytest.raises(engine.AnalysisCancelled):
            result.result(timeout=2)
    assert worker.poll() is not None


def test_callback_failure_stops_search_and_next_position_is_clean(real_engine):
    def broken(_):
        raise RuntimeError('consumer gone')
    with pytest.raises(RuntimeError, match='consumer gone'):
        live.analyse(chess.STARTING_FEN, 1, 3000, on_update=broken)
    assert not live._CACHE
    assert live.analyse(after('e2e4'), 1, 100)['lines']


def test_cancel_during_startup_closes_partial_handshake(real_engine, monkeypatch):
    cancel, workers = threading.Event(), []
    original = live._Lane._send

    def send(lane, command):
        original(lane, command)
        if command == 'uci':
            workers.append(lane.worker)
            cancel.set()

    monkeypatch.setattr(live._Lane, '_send', send)
    with pytest.raises(engine.AnalysisCancelled):
        live.analyse(chess.STARTING_FEN, cancel=cancel)
    assert workers and workers[0].poll() is not None
    assert live._LANE.worker is None


def test_crash_during_search_returns_clean_error_and_next_request_recovers(real_engine):
    def crash(_):
        live._LANE.worker.kill()

    with pytest.raises(HTTPException) as error:
        live.analyse(chess.STARTING_FEN, 1, 3000, on_update=crash)
    assert error.value.status_code == 503
    assert not live._CACHE
    assert live.analyse(after('e2e4'), 1, 100)['lines']


def test_concurrent_positions_are_serialized_without_mixing_results(real_engine):
    fens = [chess.STARTING_FEN, after('e2e4'), after('d2d4')]
    with ThreadPoolExecutor(max_workers=3) as pool:
        pending = [pool.submit(live.analyse, fen, 3, 100) for fen in fens]
        results = [future.result(timeout=5) for future in pending]
    assert [result['fen'] for result in results] == fens
    for result in results:
        assert result['lines']
        for line in result['lines']:
            board = chess.Board(result['fen'])
            board.push_uci(line['uci'])
            assert board.fen() == line['positions'][0]['fen']


@pytest.fixture
def scripted_lane(monkeypatch):
    """Exercise actual search orchestration without waiting for a minute."""
    lane = live._Lane()
    commands, deadlines = [], []
    monkeypatch.setattr(live, '_LANE', lane)
    monkeypatch.setattr(engine, 'binary_path', lambda: 'scripted-stockfish')
    def start(path, cancel):
        lane.ready = True
        lane.options = {'MultiPV'}
    def receive(deadline, cancel=None, **kwargs):
        deadlines.append(deadline)
        return next(lane.script)
    def send(command):
        commands.append(command)
        if command.startswith('go '):
            lane.script = iter(['info depth 8 multipv 1 score cp 20 pv e2e4 e7e5', 'bestmove e2e4'])
    monkeypatch.setattr(lane, '_start', start)
    monkeypatch.setattr(lane, '_ready', lambda *args, **kwargs: None)
    monkeypatch.setattr(lane, '_send', send)
    monkeypatch.setattr(lane, '_next', receive)
    return lane, commands, deadlines


def test_time_mode_supports_full_budget_without_depth_and_has_bounded_deadline(scripted_lane):
    _, commands, deadlines = scripted_lane
    before = time.monotonic()
    result = live.analyse(chess.STARTING_FEN, 3, 60000)
    assert result['lines'] and 'go movetime 60000' in commands
    assert all(before + 64 <= deadline <= time.monotonic() + 66 for deadline in deadlines)


def test_queue_has_a_separate_bounded_wait(scripted_lane, monkeypatch):
    lane, commands, _ = scripted_lane
    original = lane.gate.acquire
    waits = []
    cancelled = threading.Event()

    def acquire(timeout=-1, **options):
        waits.append((timeout, options.get('cancel')))
        return original(timeout=timeout, **options)

    monkeypatch.setattr(lane.gate, 'acquire', acquire)
    result = live.analyse(chess.STARTING_FEN, 3, 100, cancel=cancelled)
    assert result['lines'] and 'go movetime 100' in commands
    assert len(waits) == 1 and waits[0][0] == 15
    cancelled.set()
    assert waits[0][1].is_set()


def test_long_queue_deadline_still_cancels_promptly_before_search(scripted_lane, monkeypatch):
    lane, commands, _ = scripted_lane
    original = lane.gate.acquire
    waiting, cancelled = threading.Event(), threading.Event()
    assert original(timeout=.1)  # Another board currently owns the shared lane.

    def acquire(timeout=-1, **options):
        assert timeout == 15
        waiting.set()
        return original(timeout=timeout, **options)

    monkeypatch.setattr(lane.gate, 'acquire', acquire)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            queued = pool.submit(live.analyse, chess.STARTING_FEN, 3, 100, cancel=cancelled)
            try:
                assert waiting.wait(1)
            finally:
                cancelled.set()
            with pytest.raises(engine.AnalysisCancelled):
                queued.result(timeout=1)
        assert not commands and not live._CACHE
        assert lane.gate.locked()  # The cancelled waiter did not release its owner.
    finally:
        lane.gate.release()
        monkeypatch.setattr(lane.gate, 'acquire', original)
    assert live.analyse(chess.STARTING_FEN, 3, 100)['lines']


def test_depth_only_has_no_time_limit_and_cache_keeps_searches_separate(scripted_lane):
    _, commands, deadlines = scripted_lane
    fen = chess.STARTING_FEN
    assert not live.analyse(fen, 3, 3600000)['cached']
    assert 'go movetime 3600000' in commands
    deadlines.clear()
    assert not live.analyse(fen, 3, depth=80)['cached']
    assert 'go depth 80' in commands
    assert deadlines and all(deadline is None for deadline in deadlines)
    assert live.analyse(fen, 3, None, depth=80)['cached']
    assert not live.analyse(fen, 3, 1000, depth=80)['cached']
    assert 'go depth 80 movetime 1000' in commands
    assert live.analyse(fen, 3, 3600000)['cached']
    assert len([command for command in commands if command.startswith('go ')]) == 3
    assert not live.analyse(fen, 3, depth=80, force=True)['cached']


def test_infinite_mode_sends_no_depth_or_time_budget(scripted_lane):
    _, commands, deadlines = scripted_lane
    assert live.analyse(chess.STARTING_FEN, 3, None)['lines']
    assert 'go infinite' in commands
    assert deadlines and all(deadline is None for deadline in deadlines)


@pytest.mark.parametrize('options', [
    {'time_ms': 99}, {'time_ms': live.MAX_TIME_MS + 1}, {'time_ms': True}, {'time_ms': '1000'},
    {'depth': 0}, {'depth': live.MAX_DEPTH + 1}, {'depth': False}, {'depth': '18'},
])
def test_invalid_direct_limits_do_not_start_or_cache(options):
    with pytest.raises(HTTPException) as error:
        live.analyse(chess.STARTING_FEN, **options)
    assert error.value.status_code == 422
    assert live._LANE is None and not live._CACHE


@pytest.mark.parametrize('duration,depth', [(3600000, None), (None, 80), (None, None)])
def test_long_budget_cancel_is_prompt_and_never_cached(real_engine, duration, depth):
    cancelled = threading.Event()
    started = time.monotonic()
    with pytest.raises(engine.AnalysisCancelled):
        live.analyse(chess.STARTING_FEN, 3, duration, depth=depth, cancel=cancelled,
                     on_update=lambda value: cancelled.set())
    assert time.monotonic() - started < 2
    assert not live._CACHE
    assert live.analyse(after('g1f3'), 1, 100)['lines']


def test_close_cancels_wait_for_cpu_budget_before_starting_a_process(scripted_lane, monkeypatch):
    import resource_policy
    lane, commands, _ = scripted_lane
    waiting = threading.Event()
    def busy(cancel=None, **options):
        waiting.set()
        deadline = time.monotonic() + 2
        while not cancel.is_set() and time.monotonic() < deadline:
            time.sleep(.01)
        assert cancel.is_set(), 'Shutdown did not reach the CPU waiter'
        raise engine.AnalysisCancelled()
    monkeypatch.setattr(resource_policy, 'acquire', busy)
    with ThreadPoolExecutor(max_workers=1) as pool:
        task = pool.submit(live.analyse, chess.STARTING_FEN, 3, None)
        assert waiting.wait(1)
        lane.close()
        with pytest.raises(engine.AnalysisCancelled):
            task.result(timeout=1)
    assert not lane.gate.locked() and not commands
