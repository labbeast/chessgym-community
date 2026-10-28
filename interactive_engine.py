"""Persistent, cancellable Stockfish lane for the board's live evaluation.

Full-game reports, explorer batches and training retain their existing worker.
This lane reserves the configured CPU/cache budget and streams legal snapshots.
Only completed searches are cached, with all six FEN fields and search options.
"""
from __future__ import annotations

from collections import OrderedDict
from copy import deepcopy
import os
import queue
import subprocess
import threading
import time

import chess
from fastapi import HTTPException

import engine
from engine_variations import line_snapshot
from engine_output import start_reader
import resource_policy
from analysis_limits import MIN_TIME_MS, MAX_TIME_MS, MIN_DEPTH, MAX_DEPTH

_CACHE_SIZE = 128
_UPDATE_INTERVAL = .08
_CACHE = OrderedDict()
_CACHE_LOCK = threading.Lock()
_MANAGER_LOCK = threading.Lock()
_LANE = None


def _cached(key):
    with _CACHE_LOCK:
        if key not in _CACHE:
            return None
        _CACHE.move_to_end(key)
        result = deepcopy(_CACHE[key])
    result['cached'] = True
    return result


def _remember(key, result):
    with _CACHE_LOCK:
        _CACHE[key] = deepcopy(result)
        _CACHE.move_to_end(key)
        while len(_CACHE) > _CACHE_SIZE:
            _CACHE.popitem(last=False)


def _raw_info(line, multipv):
    """Validate inexpensive UCI metadata before constructing SAN snapshots."""
    if not line.startswith('info ') or ' score ' not in line or ' pv ' not in line:
        return None
    tokens = line.split()
    if 'lowerbound' in tokens or 'upperbound' in tokens:
        return None
    try:
        rank = int(tokens[tokens.index('multipv') + 1]) if 'multipv' in tokens else 1
        depth = int(tokens[tokens.index('depth') + 1])
        at = tokens.index('score')
        kind, score = tokens[at + 1], int(tokens[at + 2])
        pv = tokens[tokens.index('pv') + 1:]
        if (not 1 <= rank <= multipv or not 1 <= depth <= MAX_DEPTH or
                kind not in ('cp', 'mate') or abs(score) > (1_000_000 if kind == 'cp' else 10_000) or
                not pv or len(pv) > 256):
            return None
        return rank, {'depth': depth, 'kind': kind, 'score': score, 'pv': pv}
    except (ValueError, IndexError):
        return None


def _line(board, raw):
    return line_snapshot(board, raw, require_full_line=True, keep_history=False)


class _Lane:
    def __init__(self):
        self.gate = engine._EngineGate()
        self.closed = threading.Event()
        self.worker = None
        self.messages = None
        self.reader = None
        self.reader_stop = None
        self.path = None
        self.options = set()
        self.applied_resources = {}
        self.name = 'Stockfish'
        self.ready = False

    def _check(self, cancel):
        if self.closed.is_set():
            raise engine.AnalysisCancelled()
        engine._check_cancelled(cancel)

    def _send(self, command):
        self.worker.stdin.write(command + '\n')
        self.worker.stdin.flush()

    def _next(self, deadline, cancel=None, *, draining=False):
        while True:
            if not draining:
                self._check(cancel)
            remaining = None if deadline is None else deadline - time.monotonic()
            if remaining is not None and remaining <= 0:
                raise TimeoutError('Stockfish response timeout')
            try:
                line = self.messages.get(timeout=.025 if remaining is None else min(.025, remaining))
            except queue.Empty:
                continue
            if line is None:
                raise OSError('Stockfish exited')
            return line

    def _dispose(self):
        worker, reader = self.worker, self.reader
        self.worker = None
        self.reader = None
        if self.reader_stop:
            self.reader_stop.set()
        if worker is not None:
            try:
                engine._close_worker(worker)
            except (OSError, ValueError):
                # Windows may report a broken pipe again while closing stdin
                # after an engine crash; still close the remaining handles.
                pass
            finally:
                for stream in (worker.stdin, worker.stdout):
                    if stream is not None:
                        try:
                            stream.close()
                        except (OSError, ValueError):
                            pass
        if reader is not None and reader is not threading.current_thread():
            reader.join(timeout=1)
        self.messages = None
        self.path = None
        self.ready = False

    def _start(self, path, cancel):
        if self.worker is not None and self.path == path and self.identity == engine.binary_identity(path) and self.worker.poll() is None:
            return
        self._dispose()
        self._check(cancel)
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        self.worker = subprocess.Popen([path], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True, encoding='utf-8',
                                       errors='replace', bufsize=1, **kwargs)
        self.path = path
        self.identity = engine.binary_identity(path)
        self.name = os.path.basename(path)
        self.messages, self.reader_stop, self.reader = start_reader(
            self.worker.stdout, name='chessgym-live-stockfish')
        self._send('uci')
        deadline = time.monotonic() + 8
        self.options = set()
        while True:
            line = self._next(deadline, cancel)
            if line == 'uciok':
                break
            if line.startswith('id name '):
                self.name = line[8:]
                engine._NAME = self.name
            if line.startswith('option name ') and ' type ' in line:
                self.options.add(line[12:].split(' type ', 1)[0])
        self.applied_resources = {}
        for name, value in {'UCI_LimitStrength': 'false', 'Skill Level': 20}.items():
            if name in self.options:
                self._send(f'setoption name {name} value {value}')
        self._send('ucinewgame')
        self._ready(cancel)
        self.ready = True

    def _ready(self, cancel=None, *, draining=False):
        self._send('isready')
        deadline = time.monotonic() + (1 if draining else 8)
        while self._next(deadline, cancel, draining=draining) != 'readyok':
            pass

    def _stop_search(self):
        """Consume bestmove and readiness before another position may be sent."""
        try:
            self._send('stop')
            deadline = time.monotonic() + 1
            while not self._next(deadline, draining=True).startswith('bestmove '):
                pass
            self._ready(draining=True)
        except (OSError, ValueError, TimeoutError, AttributeError):
            self._dispose()

    def analyse(self, board, multipv, time_ms, path, key, cancel, on_update, force=False, depth=None):
        cancel = engine._CancellationSignal(cancel, self.closed)
        self._check(cancel)
        # Queue wait is bounded independently of the search duration. A long
        # search is stopped only by its chosen limit, cancellation or shutdown.
        if not self.gate.acquire(timeout=15, cancel=cancel):
            raise HTTPException(503, 'Le moteur est occupé. Réessayez dans quelques instants.')
        searching = False
        lease = None
        try:
            lease = resource_policy.acquire(cancel=cancel)
            key = (*key[:-2], lease.config['engine_threads'], lease.config['engine_hash_mb'])
            self._check(cancel)
            cached = None if force else _cached(key)
            if cached is not None:
                if on_update:
                    on_update(deepcopy(cached))
                return cached
            self._start(path, cancel)
            for name, value in {'Threads': lease.config['engine_threads'], 'Hash': lease.config['engine_hash_mb']}.items():
                if name in self.options and self.applied_resources.get(name) != value:
                    self._send(f'setoption name {name} value {value}')
                    self.applied_resources[name] = value
            if 'MultiPV' in self.options:
                self._send(f'setoption name MultiPV value {min(multipv, board.legal_moves.count())}')
            self._ready(cancel)
            self._send('position fen ' + board.fen())
            limits = []
            if depth is not None:
                limits.append(f'depth {depth}')
            if time_ms is not None:
                limits.append(f'movetime {time_ms}')
            self._send('go ' + (' '.join(limits) if limits else 'infinite'))
            searching = True
            deadline = None if time_ms is None else time.monotonic() + time_ms / 1000 + 5
            infos = {}
            last_sent = 0.0

            def snapshot():
                lines, seen = [], set()
                for rank in sorted(infos):
                    value = _line(board, infos[rank])
                    if value is not None and value['uci'] not in seen:
                        lines.append(value)
                        seen.add(value['uci'])
                return {'fen': board.fen(), 'engine': self.name, 'lines': lines, 'cached': False}

            while True:
                line = self._next(deadline, cancel)
                if line.startswith('bestmove '):
                    searching = False
                    break
                parsed = _raw_info(line, multipv)
                if parsed is None:
                    continue
                rank, info = parsed
                infos[rank] = info
                now = time.monotonic()
                if on_update and now - last_sent >= _UPDATE_INTERVAL:
                    payload = snapshot()
                    if payload['lines']:
                        self._check(cancel)
                        on_update(payload)
                        last_sent = time.monotonic()
            self._check(cancel)
            result = snapshot()
            if not result['lines']:
                raise HTTPException(503, 'Le moteur n’a pas fourni d’évaluation exploitable.')
            _remember(key, result)
            return result
        except (OSError, ValueError, TimeoutError) as error:
            self._dispose()
            searching = False
            raise HTTPException(503, 'Le moteur n’a pas pu terminer son calcul. Vérifiez son installation.') from error
        finally:
            if searching and self.worker is not None:
                self._stop_search()
            # Cancellation during startup must not retain an incomplete handshake.
            try:
                if self.closed.is_set() or not self.ready:
                    self._dispose()
            finally:
                try:
                    if lease is not None:
                        lease.release()
                finally:
                    self.gate.release()

    def close(self):
        self.closed.set()
        if self.gate.acquire(timeout=3):
            try:
                self._dispose()
            finally:
                self.gate.release()
        elif self.worker is not None:
            # A failed or unresponsive local process must not survive shutdown.
            try:
                self.worker.kill()
            except OSError:
                pass


_DEFAULT_TIME = object()


def analyse(fen, multipv=3, time_ms=_DEFAULT_TIME, *, depth=None, cancel=None, on_update=None, force=False):
    if time_ms is _DEFAULT_TIME:
        time_ms = 1000 if depth is None else None
    global _LANE
    engine._check_cancelled(cancel)
    if not isinstance(fen, str):
        raise HTTPException(422, 'Position FEN invalide.')
    board = engine.valid_board(fen)
    multipv = max(1, min(3, int(multipv)))
    if time_ms is not None and (type(time_ms) is not int or not MIN_TIME_MS <= time_ms <= MAX_TIME_MS):
        raise HTTPException(422, 'La durée doit être un nombre positif d’au moins 0,1 seconde.')
    if depth is not None and (type(depth) is not int or not MIN_DEPTH <= depth <= MAX_DEPTH):
        raise HTTPException(422, 'La profondeur doit être un entier positif accepté par le moteur.')
    if board.is_game_over():
        result = {'fen': board.fen(), 'engine': engine.status().get('name', 'Stockfish'), 'lines': [], 'cached': False}
        if on_update:
            on_update(deepcopy(result))
        return result
    path = engine.binary_path()
    if not path:
        raise HTTPException(503, 'Le moteur d’analyse est indisponible. Choisis un moteur dans les réglages globaux.')
    config = resource_policy.settings()
    key = path, engine.binary_identity(path), board.fen(), multipv, time_ms, depth, config['engine_threads'], config['engine_hash_mb']
    cached = None if force else _cached(key)
    if cached is not None:
        engine._check_cancelled(cancel)
        if on_update:
            on_update(deepcopy(cached))
        return cached
    with _MANAGER_LOCK:
        if _LANE is None or _LANE.closed.is_set():
            _LANE = _Lane()
        lane = _LANE
    return lane.analyse(board, multipv, time_ms, path, key, cancel, on_update, force, depth)


def close():
    """Stop the live lane; a later application lifespan can start a fresh one."""
    global _LANE
    with _MANAGER_LOCK:
        lane, _LANE = _LANE, None
    if lane is not None:
        lane.close()
