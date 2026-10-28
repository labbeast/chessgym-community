"""Maia protocol, bounded failure paths and optional real installed runtime."""
import io
import json
from pathlib import Path
import threading
import time

import chess
from fastapi import HTTPException
import pytest

import engine
import maia_engine as maia


class FakeWorker:
    def __init__(self, lines=None):
        self.lines = iter(lines or ['readyok', 'info nodes 1', 'bestmove e2e4'])
        self.commands = []
        self.closed = threading.Event()
        self.disposed = False
        self.starts = []

    def start(self, path, weights, model, cancel):
        self.starts.append((path, weights, model))
        self.check(cancel)

    def check(self, cancel):
        engine._check_cancelled(self.closed)
        engine._check_cancelled(cancel)

    def send(self, command):
        self.commands.append(command)

    def next_line(self, deadline, cancel):
        self.check(cancel)
        value = next(self.lines)
        if isinstance(value, Exception):
            raise value
        return value

    def dispose(self):
        self.disposed = True


@pytest.fixture
def lane(monkeypatch):
    worker = FakeWorker()
    gate = engine._EngineGate()
    releases = []
    class Lease:
        def release(self):
            releases.append(True)
    monkeypatch.setattr(maia, '_worker', lambda: worker)
    monkeypatch.setattr(engine, '_LOCK', gate)
    monkeypatch.setattr(maia, 'binary_path', lambda: 'python')
    monkeypatch.setattr(maia, 'selected_model', lambda: 'maia3-5m')
    monkeypatch.setattr(maia, 'model_path', lambda model=None: 'maia3-5m.pt')
    monkeypatch.setattr(maia.resource_policy, 'acquire', lambda **kwargs: Lease())
    return worker, gate, releases


def test_human_policy_options_and_legal_result(lane):
    worker, gate, releases = lane
    result = maia.play(chess.STARTING_FEN, level=1500)
    assert result['uci'] == 'e2e4' and result['san'] == 'e4'
    assert result['game_over'] is False and result['result'] == '*'
    assert worker.commands == ['setoption name Elo value 1500', 'setoption name Temperature value 1',
                               'setoption name TopP value 1', 'setoption name MultiPV value 1',
                               'ucinewgame', 'isready', 'position fen ' + chess.STARTING_FEN, 'go nodes 1']
    assert not worker.disposed and not gate.locked() and releases == [True]


def test_complete_history_is_sent_from_original_fen(lane):
    worker, _, _ = lane
    history = ['e2e4', 'e7e5', 'g1f3']
    board = chess.Board()
    for move in history:
        board.push_uci(move)
    worker.lines = iter(['readyok', 'bestmove b8c6'])
    result = maia.play(board.fen(), 1700, history=history)
    assert result['san'] == 'Nc6'
    assert worker.commands[-2] == 'position fen ' + chess.STARTING_FEN + ' moves ' + ' '.join(history)
    assert worker.starts[0][1:] == ('maia3-5m.pt', 'maia3-5m')
    assert worker.commands[0] == 'setoption name Elo value 1700'


def test_custom_initial_position_history_is_preserved(lane):
    worker, _, _ = lane
    initial = '8/7k/8/8/8/3K4/4P3/8 w - - 0 1'
    board = chess.Board(initial)
    board.push_uci('e2e4')
    worker.lines = iter(['readyok', 'bestmove h7g6'])
    result = maia.play(board.fen(), history=['e2e4'], initial_fen=initial)
    assert result['san'] == 'Kg6'
    assert worker.commands[-2] == 'position fen ' + initial + ' moves e2e4'


@pytest.mark.parametrize('level', [True, 0, 500, 1050, 1550, 2700, '1500', None])
def test_invalid_level_never_starts(lane, level):
    with pytest.raises(HTTPException) as error:
        maia.play(chess.STARTING_FEN, level=level)
    assert error.value.status_code == 422
    assert lane[0].starts == []


@pytest.mark.parametrize('history', [['0000'], ['e2e5'], ['garbage'], [None], 'e2e4', ['e2e4'], ['a'] * 2001])
def test_bad_or_mismatching_history_rejected(lane, history):
    with pytest.raises(HTTPException) as error:
        maia.play(chess.STARTING_FEN, history=history)
    assert error.value.status_code == 422
    assert lane[0].starts == []


def test_invalid_fen_rejected(lane):
    with pytest.raises(HTTPException) as error:
        maia.play('not a fen')
    assert error.value.status_code == 422
    assert lane[0].starts == []


def test_threefold_history_returns_draw_without_engine(lane):
    moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 2
    board = chess.Board()
    for move in moves:
        board.push_uci(move)
    result = maia.play(board.fen(), history=moves)
    assert result['game_over'] and result['result'] == '1/2-1/2' and result['uci'] is None
    assert lane[0].starts == []


@pytest.mark.parametrize('response', ['bestmove e2e5', 'bestmove invalid', OSError('exit'), TimeoutError('late')])
def test_engine_failure_disposes_process_and_releases_gate(lane, response):
    worker, gate, releases = lane
    worker.lines = iter(['readyok', response])
    with pytest.raises(HTTPException) as error:
        maia.play(chess.STARTING_FEN)
    assert error.value.status_code == 503
    assert worker.disposed and not gate.locked() and releases == [True]


def test_cancel_before_start_does_not_spawn(lane):
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(engine.AnalysisCancelled):
        maia.play(chess.STARTING_FEN, cancel=cancel)
    assert lane[0].starts == [] and lane[2] == []


def test_cancellation_during_read_disposes_and_releases(lane):
    worker, gate, releases = lane
    worker.lines = iter(['readyok', engine.AnalysisCancelled()])
    with pytest.raises(engine.AnalysisCancelled):
        maia.play(chess.STARTING_FEN)
    assert worker.disposed and not gate.locked() and releases == [True]


def test_cancel_while_waiting_for_stockfish_gate(lane):
    worker, gate, _ = lane
    cancel = threading.Event()
    assert gate.acquire()
    timer = threading.Timer(.05, cancel.set)
    timer.start()
    started = time.monotonic()
    try:
        with pytest.raises(engine.AnalysisCancelled):
            maia.play(chess.STARTING_FEN, cancel=cancel)
    finally:
        gate.release()
        timer.join()
    assert time.monotonic() - started < .75
    assert worker.starts == []


def test_missing_installation_is_explicit(lane, monkeypatch):
    monkeypatch.setattr(maia, 'binary_path', lambda: None)
    assert maia.status()['available'] is False
    with pytest.raises(HTTPException) as error:
        maia.play(chess.STARTING_FEN)
    assert error.value.status_code == 503 and lane[0].starts == []


def test_terminal_position_does_not_require_installation(lane, monkeypatch):
    monkeypatch.setattr(maia, 'binary_path', lambda: None)
    result = maia.play('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1')
    assert result['game_over'] and result['result'] == '1-0'
    assert result['uci'] is None and lane[0].starts == []


def test_configured_paths_and_installed_levels(monkeypatch, tmp_path):
    exe = tmp_path / 'python-custom'
    exe.write_bytes(b'engine')
    model = tmp_path / 'maia3-79m.pt'
    model.write_bytes(b'model')
    monkeypatch.setenv('CHESSGYM_MAIA3_PYTHON', str(exe))
    monkeypatch.setenv('CHESSGYM_MAIA3_MODEL', 'maia3-79m')
    monkeypatch.setenv('CHESSGYM_MAIA3_CHECKPOINT', str(model))
    assert maia.binary_path() == str(exe.resolve())
    assert maia.status() == {'available': True, 'name': 'Maia 3', 'levels': list(maia.LEVELS),
                             'model': 'maia3-79m'}


@pytest.mark.skipif(not maia.status()['available'], reason='Optional Maia 3 runtime not installed')
def test_real_installed_model_plays_all_ratings_with_one_process_and_history():
    maia.shutdown()
    process = None
    try:
        for level in maia.LEVELS:
            board = chess.Board()
            result = maia.play(board.fen(), level, history=[])
            assert chess.Move.from_uci(result['uci']) in board.legal_moves
            board.push_uci(result['uci'])
            result = maia.play(board.fen(), level, history=[m.uci() for m in board.move_stack])
            assert chess.Move.from_uci(result['uci']) in board.legal_moves
            assert result['fen'] != board.fen()
            if process is None:
                process = maia._WORKER.process
            assert process is maia._WORKER.process
    finally:
        maia.shutdown()
    assert process.poll() is not None


def test_manifest_selects_model_and_rejects_paths_outside_runtime(monkeypatch, tmp_path):
    root = tmp_path / 'runtime-root'
    root.mkdir()
    monkeypatch.setenv('CHESSGYM_MAIA3_ROOT', str(root))
    for variable in ('CHESSGYM_MAIA3_PYTHON', 'CHESSGYM_MAIA3_MODEL', 'CHESSGYM_MAIA3_CHECKPOINT'):
        monkeypatch.delenv(variable, raising=False)
    (root / 'python').write_bytes(b'runtime')
    (root / 'weights.pt').write_bytes(b'checkpoint')
    manifest = {'python': 'python', 'default_model': 'maia3-79m',
                'models': {'maia3-79m': {'path': 'weights.pt'}}}
    (root / 'manifest.json').write_text(json.dumps(manifest))
    assert maia.status()['available'] and maia.selected_model() == 'maia3-79m'
    assert maia.binary_path() == str(root / 'python')
    assert maia.model_path() == str(root / 'weights.pt')
    (tmp_path / 'outside.pt').write_bytes(b'not installed here')
    manifest['models']['maia3-79m']['path'] = '../outside.pt'
    (root / 'manifest.json').write_text(json.dumps(manifest))
    assert maia.model_path() is None and not maia.status()['available']
    monkeypatch.setenv('CHESSGYM_MAIA3_MODEL', 'untrusted/remote-model')
    assert maia.selected_model() is None and not maia.status()['available']


def test_legacy_lc0_environment_never_enables_maia3(monkeypatch, tmp_path):
    monkeypatch.setenv('CHESSGYM_MAIA3_ROOT', str(tmp_path))
    for variable in ('CHESSGYM_MAIA3_PYTHON', 'CHESSGYM_MAIA3_MODEL', 'CHESSGYM_MAIA3_CHECKPOINT'):
        monkeypatch.delenv(variable, raising=False)
    legacy = tmp_path / 'lc0.exe'
    legacy.write_bytes(b'legacy')
    monkeypatch.setenv('CHESSGYM_MAIA_ENGINE', str(legacy))
    monkeypatch.setenv('CHESSGYM_MAIA_MODELS', str(tmp_path))
    assert not maia.status()['available']


def test_cpu_offline_process_is_reused_until_model_changes(monkeypatch):
    launches = []
    closed = []
    class Process:
        def __init__(self):
            self.stdin = io.StringIO()
            self.stdout = io.StringIO('\n'.join([
                'id name Maia3', 'option name Elo type spin default 1500 min 0 max 5000',
                'option name Temperature type string default 1',
                'option name TopP type string default 1', 'option name MultiPV type spin default 1',
                'uciok', '']))
        def poll(self):
            return None
    def popen(args, **kwargs):
        process = Process()
        launches.append((args, kwargs, process))
        return process
    monkeypatch.setattr(maia.subprocess, 'Popen', popen)
    monkeypatch.setattr(engine, '_close_worker', lambda process: closed.append(process))
    worker = maia._Worker()
    try:
        worker.start('python', 'small.pt', 'maia3-5m', None)
        worker.start('python', 'small.pt', 'maia3-5m', None)
        assert len(launches) == 1
        args, options, _ = launches[0]
        assert args[:8] == ['python', '-I', '-u', '-m', 'maia3.uci', '--model', 'maia3-5m', '--checkpoint-path']
        assert args[8] == 'small.pt' and '--use-uci-history' in args
        assert '--local-files-only' in args and '--no-use-amp' in args and '--trust-checkpoint' not in args
        assert args[args.index('--device') + 1] == 'cpu'
        assert options['env']['OMP_NUM_THREADS'] == options['env']['MKL_NUM_THREADS'] == '1'
        assert options['env']['HF_HUB_OFFLINE'] == '1'
        worker.start('python', 'large.pt', 'maia3-79m', None)
        assert len(launches) == 2 and len(closed) == 1
    finally:
        worker.dispose()
    assert len(closed) == 2


@pytest.mark.parametrize('level', [600, 1000, 2000, 2600])
def test_extended_target_ratings_use_the_same_checkpoint(lane, level):
    worker, _, _ = lane
    maia.play(chess.STARTING_FEN, level=level)
    assert worker.commands[0] == f'setoption name Elo value {level}'
    assert worker.starts[0][1:] == ('maia3-5m.pt', 'maia3-5m')

