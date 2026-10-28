"""Bounded, serialized UCI access. Analysis always uses the engine's full strength."""
from __future__ import annotations

import atexit
import os
from pathlib import Path
import shutil
import subprocess
import threading
import queue
import time

import chess
import chess.engine
import resource_policy
from analysis_limits import MAX_TIME_MS, MAX_DEPTH
from engine_variations import line_snapshot
from engine_output import start_reader
from fastapi import HTTPException

_NAME = None


class AnalysisCancelled(Exception):
    """The requesting board has gone away; release the shared engine promptly."""


def _check_cancelled(cancel):
    if cancel is not None and cancel.is_set():
        raise AnalysisCancelled()


class _CancellationSignal:
    """Combine caller cancellation and engine shutdown while waiting for CPU."""
    def __init__(self, *events):
        self.events = events

    def is_set(self):
        return any(event is not None and event.is_set() for event in self.events)


class _EngineGate:
    """One engine at a time; queued interactive work precedes background work.

    The current search is never preempted. Cancellation is checked while waiting
    so a paused background job cannot leave an interactive waiter registered.
    The small Lock-compatible API also permits direct contention tests.
    """
    def __init__(self):
        self._condition = threading.Condition()
        self._busy = False
        self._waiting_interactive = 0

    def acquire(self, timeout=-1, *, background=False, cancel=None):
        deadline = None if timeout is None or timeout < 0 else time.monotonic() + timeout
        with self._condition:
            if not background:
                self._waiting_interactive += 1
            try:
                while True:
                    _check_cancelled(cancel)
                    if not self._busy and (not background or not self._waiting_interactive):
                        self._busy = True
                        return True
                    remaining = None if deadline is None else deadline - time.monotonic()
                    if remaining is not None and remaining <= 0:
                        return False
                    self._condition.wait(.1 if remaining is None else min(.1, remaining))
            finally:
                if not background:
                    self._waiting_interactive -= 1
                    # A cancelled/timed-out foreground waiter may have been the
                    # last reason a background request could not proceed.
                    self._condition.notify_all()

    def release(self):
        with self._condition:
            if not self._busy:
                raise RuntimeError('release unlocked engine gate')
            self._busy = False
            self._condition.notify_all()

    def locked(self):
        with self._condition:
            return self._busy


_LOCK = _EngineGate()


def binary_path():
    import engine_catalog
    registered, selected = engine_catalog.selection('analysis')
    if registered:
        path = selected.get('path') if selected else None
        return path if path and Path(path).is_file() else None
    return engine_catalog.native_discovery()


def binary_identity(path):
    import engine_catalog
    return engine_catalog.fingerprint(path)


def status():
    import engine_catalog
    path = binary_path()
    registered, selected = engine_catalog.selection('analysis')
    name = selected.get('name', 'Moteur UCI') if selected else (_NAME or 'Stockfish')
    capabilities = selected.get('capabilities', {}) if selected else {'skills': list(range(21)), 'skill': True}
    return {'available': path is not None, 'identity': binary_identity(path),
            'id': selected['id'] if selected else None, 'capabilities': capabilities,
            **({'name': name} if path else {})}


def valid_board(fen):
    try:
        board = chess.Board(fen)
    except (ValueError, TypeError):
        raise HTTPException(422, 'Position FEN invalide.')
    if not board.is_valid():
        raise HTTPException(422, 'La position ne respecte pas les règles des échecs.')
    return board


def _run(board, time_ms, *, multipv=None, skill=20, root_moves=None, depth=None, cancel=None, background=False, expected_identity=None):
    global _NAME
    _check_cancelled(cancel)
    if depth is not None and (type(depth) is not int or not 1 <= depth <= MAX_DEPTH):
        raise HTTPException(422, 'La profondeur du moteur doit être un entier positif.')
    if time_ms is not None and (type(time_ms) is not int or not 1 <= time_ms <= MAX_TIME_MS):
        raise HTTPException(422, 'La durée doit être un nombre entier de millisecondes positif.')
    if time_ms is None and depth is None:
        raise HTTPException(422, 'Choisis une durée ou une profondeur de calcul.')
    if root_moves is not None:
        root_moves = tuple(root_moves)
        if not root_moves or any(move not in board.legal_moves for move in root_moves):
            raise HTTPException(422, 'Le moteur attend des coups de départ légaux.')
        allowed_roots = {move.uci() for move in root_moves}
    else:
        allowed_roots = None
    path = binary_path()
    if not path:
        raise HTTPException(503, 'Le moteur d’analyse est indisponible. Choisis un moteur dans les réglages globaux.')
    # Interactive callers keep a bounded wait. Background reports yield at each
    # position boundary and remain cancellable while the user analyses a board.
    worker = _get_worker()
    cancel = _CancellationSignal(cancel, worker.closed)
    if not _LOCK.acquire(timeout=-1 if background else 15, background=background, cancel=cancel):
        raise HTTPException(503, 'Le moteur est occupé. Réessayez dans quelques instants.')
    successful = False
    lease = None
    try:
        lease = resource_policy.acquire(cancel=cancel, timeout=None if background else 15)
        _check_cancelled(cancel)
        if expected_identity is not None and binary_identity(path) != expected_identity:
            raise HTTPException(409, 'Le moteur a changé. Relance l’analyse de cette partie.')
        worker.start(path, cancel)
        send = worker.send
        next_line = lambda deadline: worker.next_line(deadline, cancel)
        options = worker.options
        desired = {'Threads':lease.config['engine_threads'], 'Hash':lease.config['engine_hash_mb'], 'UCI_LimitStrength':'false',
                   'Skill Level':20 if multipv is not None else skill,
                   'MultiPV':min(multipv,board.legal_moves.count()) if multipv is not None else 1}
        # Generic UCI engines without Skill Level play at their full strength.
        # Old saved computer games remain resumable after changing engines.
        for option,value in desired.items():
            if option in options:
                if option in ('Threads', 'Hash') and worker.applied_resources.get(option) == value:
                    continue
                send(f'setoption name {option} value {value}')
                if option in ('Threads', 'Hash'):
                    worker.applied_resources[option] = value
        send('ucinewgame')
        send('isready')
        deadline = time.monotonic() + 8
        while next_line(deadline) != 'readyok':
            pass
        command = 'position fen ' + board.root().fen()
        if board.move_stack:
            command += ' moves ' + ' '.join(move.uci() for move in board.move_stack)
        send(command)
        search = 'go' + (f' depth {depth}' if depth is not None else '')
        if time_ms is not None:
            search += f' movetime {time_ms}'
        if root_moves is not None:
            search += ' searchmoves ' + ' '.join(move.uci() for move in root_moves)
        send(search)
        deadline = None if time_ms is None else time.monotonic() + time_ms / 1000 + 5
        infos = {}
        bestmove = None
        while True:
            line = next_line(deadline)
            if line.startswith('bestmove '):
                bestmove = line.split()[1]
                break
            if not line.startswith('info ') or ' pv ' not in line or ' score ' not in line:
                continue
            tokens = line.split()
            try:
                rank = int(tokens[tokens.index('multipv')+1]) if 'multipv' in tokens else 1
                actual_depth = int(tokens[tokens.index('depth')+1]) if 'depth' in tokens else 0
                score_at = tokens.index('score')
                score_kind,score = tokens[score_at+1],int(tokens[score_at+2])
                if score_kind not in ('cp','mate') or 'lowerbound' in tokens or 'upperbound' in tokens:
                    continue
                value = line_snapshot(board, {
                    'pv': tokens[tokens.index('pv')+1:], 'kind': score_kind,
                    'score': score, 'depth': actual_depth,
                }, require_full_line=False, keep_history=True)
                if value and (allowed_roots is None or value['uci'] in allowed_roots):
                    infos[rank] = value
            except (ValueError,IndexError):
                continue
        if allowed_roots is not None and bestmove not in allowed_roots:
            raise HTTPException(503, 'Le moteur n’a pas respecté le coup demandé.')
        if multipv is not None:
            if not infos:
                raise HTTPException(503, 'Le moteur n’a pas fourni d’évaluation exploitable.')
            successful = True
            return {'fen':board.fen(), 'engine':getattr(worker, 'name', None) or _NAME or 'Moteur UCI',
                    'lines':[infos[rank] for rank in sorted(infos)[:multipv]]}
        try:
            move = chess.Move.from_uci(bestmove)
        except ValueError:
            raise HTTPException(503, 'Le moteur n’a pas fourni de coup légal.')
        if move not in board.legal_moves:
            raise HTTPException(503, 'Le moteur n’a pas fourni de coup légal.')
        san = board.san(move)
        board.push(move)
        successful = True
        return {'uci':move.uci(), 'san':san, 'fen':board.fen(),
                'game_over':board.is_game_over(claim_draw=True),
                'result':board.result(claim_draw=True)}
    except HTTPException:
        raise
    except (OSError, ValueError, TimeoutError) as error:
        raise HTTPException(503, 'Le moteur n’a pas pu terminer son calcul. Vérifiez son installation.') from error
    finally:
        try:
            if not successful or worker.closed.is_set():
                worker.dispose()
        finally:
            try:
                if lease is not None:
                    lease.release()
            finally:
                _LOCK.release()


def _close_worker(worker):
    try:
        try:
            worker.stdin.write('quit\n')
            worker.stdin.flush()
            worker.wait(timeout=1)
        except (OSError, ValueError, subprocess.TimeoutExpired):
            worker.kill()
            worker.wait(timeout=2)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        pass
    finally:
        for stream in (worker.stdin, worker.stdout):
            if stream:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass


class _Worker:
    """One reusable process, accessed only while the shared priority gate is held."""
    def __init__(self):
        self.process = None
        self.path = None
        self.options = set()
        self.applied_resources = {}
        self.reader = None
        self.reader_stop = None
        self.messages = None
        self.closed = threading.Event()

    def check(self, cancel):
        _check_cancelled(self.closed)
        _check_cancelled(cancel)

    def send(self, command):
        self.process.stdin.write(command + '\n')
        self.process.stdin.flush()

    def next_line(self, deadline, cancel):
        while True:
            self.check(cancel)
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise TimeoutError('Engine response timeout')
            try:
                line = self.messages.get(timeout=.1 if remaining is None else min(remaining, .1))
            except queue.Empty:
                continue
            if line is None:
                raise OSError('Engine exited')
            return line

    def start(self, path, cancel):
        global _NAME
        self.check(cancel)
        if (self.process is not None and self.path == path and self.identity == binary_identity(path) and
                callable(getattr(self.process, 'poll', None)) and self.process.poll() is None):
            return
        self.dispose()
        self.check(cancel)
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        self.process = process = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace', bufsize=1, **kwargs)
        self.path = path
        self.identity = binary_identity(path)
        self.name = _NAME = Path(path).stem
        self.messages, self.reader_stop, self.reader = start_reader(
            process.stdout, name='chessgym-background-stockfish')
        self.send('uci')
        deadline = time.monotonic() + 8
        self.options = set()
        self.applied_resources = {}
        while True:
            line = self.next_line(deadline, cancel)
            if line == 'uciok':
                break
            if line.startswith('id name '):
                self.name = _NAME = line[8:]
            if line.startswith('option name ') and ' type ' in line:
                self.options.add(line[12:].split(' type ', 1)[0])

    def dispose(self):
        process, reader = self.process, self.reader
        self.process = self.reader = None
        self.path = None
        if self.reader_stop:
            self.reader_stop.set()
        if process is not None:
            _close_worker(process)
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=1)
        self.messages = None


_WORKER = None
_WORKER_MANAGER = threading.Lock()


def _get_worker():
    global _WORKER
    with _WORKER_MANAGER:
        if _WORKER is None or _WORKER.closed.is_set():
            _WORKER = _Worker()
        return _WORKER


def shutdown():
    """Interrupt active work and release handles; a later app lifespan can restart."""
    with _WORKER_MANAGER:
        worker = _WORKER
        if worker is None:
            return
        worker.closed.set()
    if _LOCK.acquire(timeout=5):
        try:
            worker.dispose()
        finally:
            _LOCK.release()


atexit.register(shutdown)


def analyse(fen, multipv=3, time_ms=1000, *, cancel=None):
    board = valid_board(fen)
    if board.is_game_over():
        return {'fen': board.fen(), 'engine': status().get('name', 'Stockfish'), 'lines': []}
    return _run(board, time_ms, multipv=max(1, min(3, multipv)), cancel=cancel)


def play(fen, skill=10, time_ms=500, history=None, initial_fen=None):
    board = valid_board(fen)
    if history is not None:
        replay = valid_board(initial_fen or chess.STARTING_FEN)
        if len(history) > 2000:
            raise HTTPException(422, 'L’historique de coups est trop long.')
        try:
            for uci in history:
                replay.push_uci(uci)
        except ValueError:
            raise HTTPException(422, 'L’historique contient un coup illégal.')
        if replay.fen() != board.fen():
            raise HTTPException(422, 'L’historique ne correspond pas à la position fournie.')
        board = replay
    if board.is_game_over(claim_draw=True):
        return {'uci': None, 'san': None, 'fen': board.fen(), 'game_over': True,
                'result': board.result(claim_draw=True)}
    return _run(board, max(100, min(2000, time_ms)), skill=max(0, min(20, skill)))
