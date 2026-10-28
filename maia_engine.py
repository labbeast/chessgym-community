"""Local Maia 3 policy inference through the official, isolated Python runtime.

Maia shares the existing background Stockfish gate, so it does not add a third
CPU lane alongside live analysis and imports. One reusable CPU process is kept;
changing Elo does not reload its model. Runtime model downloads are disabled.
"""
from __future__ import annotations

import atexit
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import time

import chess
from fastapi import HTTPException

import engine
from engine_output import start_reader
import resource_policy

# The Maia website recommends Lichess target ratings from 600 to 2600.
LEVELS = tuple(range(600, 2700, 100))
MODELS = ('maia3-5m', 'maia3-23m', 'maia3-79m')
ROOT = Path(__file__).resolve().parent / 'engines' / 'maia3'
_MANAGER = threading.Lock()
_WORKER = None


def root_path():
    import engine_catalog
    registered, selected = engine_catalog.selection('maia')
    if registered and selected:
        return Path(selected['path'])
    return Path(os.environ.get('CHESSGYM_MAIA3_ROOT', str(ROOT))).expanduser().resolve()


def _manifest():
    try:
        path = root_path() / 'manifest.json'
        if path.stat().st_size > 256 * 1024:
            return {}
        value = json.loads(path.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _installed_file(relative, *, runtime=False):
    """Manifest paths stay inside the isolated runtime; explicit env paths may not."""
    if not isinstance(relative, str):
        return None
    root = root_path()
    candidate = Path(os.path.abspath(root / relative))
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    # POSIX virtualenv interpreters normally symlink the system Python. Keep
    # their virtualenv path intact so Python still discovers pyvenv.cfg.
    if not runtime and not candidate.resolve().is_relative_to(root):
        return None
    return str(candidate)


def binary_path():
    import engine_catalog
    registered, _ = engine_catalog.selection('maia')
    configured = None if registered else os.environ.get('CHESSGYM_MAIA3_PYTHON')
    if configured:
        candidate = Path(configured).expanduser()
        return str(candidate.absolute()) if candidate.is_file() else None
    default = 'runtime/Scripts/python.exe' if os.name == 'nt' else 'runtime/bin/python'
    return _installed_file(_manifest().get('python', default), runtime=True)


def selected_model():
    import engine_catalog
    registered, selected = engine_catalog.selection('maia')
    if registered:
        return selected.get('model') if selected else None
    model = os.environ.get('CHESSGYM_MAIA3_MODEL', _manifest().get('default_model', MODELS[0]))
    return model if model in MODELS else None


def model_path(model=None):
    model = model or selected_model()
    if model not in MODELS:
        return None
    import engine_catalog
    registered, _ = engine_catalog.selection('maia')
    configured = None if registered else os.environ.get('CHESSGYM_MAIA3_CHECKPOINT')
    if configured:
        candidate = Path(configured).expanduser()
        return str(candidate.resolve()) if candidate.is_file() else None
    models = _manifest().get('models', {})
    spec = models.get(model, {}) if isinstance(models, dict) else {}
    relative = spec.get('path', f'models/{model}.pt') if isinstance(spec, dict) else None
    return _installed_file(relative)


def status():
    import engine_catalog
    with engine_catalog.configuration_lock():
        registered, selected = engine_catalog.selection('maia')
        model = selected_model()
        available = bool(binary_path() and model and model_path(model))
        name = selected.get('name', 'Maia 3') if selected else 'Maia 3'
    return {'available': available, 'name': name, 'levels': list(LEVELS) if available else [],
            'model': model,
            **({} if available else {'message': 'Maia 3 est indisponible. Exécutez scripts/install_maia.py pour installer le moteur et le modèle.'})}


def _board(fen, history, initial_fen):
    board = engine.valid_board(fen)
    if history is None:
        return board
    if not isinstance(history, (list, tuple)) or len(history) > 2000:
        raise HTTPException(422, 'L’historique de coups est invalide ou trop long.')
    replay = engine.valid_board(initial_fen or chess.STARTING_FEN)
    try:
        for uci in history:
            move = chess.Move.from_uci(uci)
            if move not in replay.legal_moves:
                raise ValueError('Illegal move')
            replay.push(move)
    except (ValueError, TypeError, AttributeError):
        raise HTTPException(422, 'L’historique contient un coup illégal.')
    if replay.fen() != board.fen():
        raise HTTPException(422, 'L’historique ne correspond pas à la position fournie.')
    return replay


class _Worker(engine._Worker):
    """Reuse the bounded UCI queue/cancellation/cleanup implementation."""
    def start(self, path, weights, model, cancel):
        self.check(cancel)
        key = (path, weights, model)
        if self.process is not None and self.path == key and self.process.poll() is None:
            return
        self.dispose()
        self.check(cancel)
        args = [path, '-I', '-u', '-m', 'maia3.uci', '--model', model,
                '--checkpoint-path', weights, '--device', 'cpu', '--no-use-amp',
                '--use-uci-history', '--local-files-only', '--multipv', '1',
                '--temperature', '1', '--top-p', '1', '--seed', str(secrets.randbelow(2 ** 31))]
        environment = {**os.environ, 'OMP_NUM_THREADS': '1',
                       'OPENBLAS_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1',
                       'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                       'HF_HUB_DISABLE_TELEMETRY': '1', 'CUDA_VISIBLE_DEVICES': ''}
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        self.process = process = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding='utf-8', errors='replace', bufsize=1,
            env=environment, cwd=str(Path(path).parent), **kwargs)
        self.path = key
        self.messages, self.reader_stop, self.reader = start_reader(
            process.stdout, name='chessgym-maia', max_queue_size=256)
        self.send('uci')
        deadline = time.monotonic() + 30
        self.options = set()
        while True:
            line = self.next_line(deadline, cancel)
            if line == 'uciok':
                break
            if line.startswith('option name ') and ' type ' in line:
                self.options.add(line[12:].split(' type ', 1)[0])
        if not {'Elo', 'Temperature', 'TopP', 'MultiPV'}.issubset(self.options):
            raise ValueError('The runtime does not expose the required Maia 3 options')


def _worker():
    global _WORKER
    with _MANAGER:
        if _WORKER is None or _WORKER.closed.is_set():
            _WORKER = _Worker()
        return _WORKER


def play(fen, level=1500, history=None, initial_fen=None, cancel=None):
    if type(level) is not int or level not in LEVELS:
        raise HTTPException(422, 'Choisissez un niveau Maia 3 de 600 à 2600, par pas de 100.')
    engine._check_cancelled(cancel)
    board = _board(fen, history, initial_fen)
    if board.is_game_over(claim_draw=True):
        return {'uci': None, 'san': None, 'fen': board.fen(), 'game_over': True,
                'result': board.result(claim_draw=True)}
    import engine_catalog
    with engine_catalog.configuration_lock():
        model = selected_model()
        path, weights = binary_path(), model_path(model)
    if not path or not weights or not model:
        raise HTTPException(503, 'Le moteur Maia 3 ou son modèle n’est pas installé.')
    worker = _worker()
    cancel = engine._CancellationSignal(cancel, worker.closed)
    if not engine._LOCK.acquire(timeout=15, cancel=cancel):
        raise HTTPException(503, 'Le moteur est occupé. Réessayez dans quelques instants.')
    lease = None
    successful = False
    try:
        lease = resource_policy.acquire(cancel=cancel)
        worker.start(path, weights, model, cancel)
        # One model covers every level. Always reset options between callers so
        # two sessions with different target ratings cannot affect each other.
        for name, value in (('Elo', level), ('Temperature', 1), ('TopP', 1), ('MultiPV', 1)):
            worker.send(f'setoption name {name} value {value}')
        worker.send('ucinewgame')
        worker.send('isready')
        # The first isready loads the local tensor checkpoint. Later calls reuse it.
        deadline = time.monotonic() + 60
        while worker.next_line(deadline, cancel) != 'readyok':
            pass
        command = 'position fen ' + board.root().fen()
        if board.move_stack:
            command += ' moves ' + ' '.join(move.uci() for move in board.move_stack)
        worker.send(command)
        worker.send('go nodes 1')
        deadline = time.monotonic() + 15
        while True:
            line = worker.next_line(deadline, cancel)
            if line.startswith('bestmove '):
                parts = line.split()
                move = chess.Move.from_uci(parts[1])
                break
        if move not in board.legal_moves:
            raise ValueError('Illegal engine move')
        san = board.san(move)
        board.push(move)
        worker.check(cancel)
        successful = True
        return {'uci': move.uci(), 'san': san, 'fen': board.fen(),
                'game_over': board.is_game_over(claim_draw=True),
                'result': board.result(claim_draw=True)}
    except (OSError, ValueError, TimeoutError, IndexError) as error:
        raise HTTPException(503, 'Maia 3 n’a pas pu terminer son calcul. Vérifiez son installation.') from error
    finally:
        try:
            if not successful or worker.closed.is_set():
                worker.dispose()
        finally:
            try:
                if lease is not None:
                    lease.release()
            finally:
                engine._LOCK.release()


def shutdown():
    with _MANAGER:
        worker = _WORKER
        if worker is None:
            return
        worker.closed.set()
    if engine._LOCK.acquire(timeout=5):
        try:
            worker.dispose()
        finally:
            engine._LOCK.release()


atexit.register(shutdown)


def test_installation(root, model):
    """Check one model in a disposable worker, without modifying selection."""
    root = Path(root).resolve()
    try:
        manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
        path = root / manifest.get('python', 'runtime/Scripts/python.exe' if os.name == 'nt' else 'runtime/bin/python')
        weights = root / manifest['models'][model]['path']
        if not weights.resolve().is_relative_to(root) or not path.is_file() or not weights.is_file():
            raise ValueError('paths')
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise HTTPException(422, 'L’installation du modèle Maia est incomplète.') from exc
    worker = _Worker()
    if not engine._LOCK.acquire(timeout=15):
        raise HTTPException(503, 'Le moteur est occupé. Réessaie dans quelques instants.')
    lease = None
    try:
        lease = resource_policy.acquire()
        worker.start(str(path), str(weights), model, None)
        worker.send('setoption name Elo value 1500')
        worker.send('isready')
        deadline = time.monotonic() + 60
        while worker.next_line(deadline, None) != 'readyok':
            pass
        worker.send('position startpos')
        worker.send('go nodes 1')
        deadline = time.monotonic() + 15
        while True:
            line = worker.next_line(deadline, None)
            if line.startswith('bestmove '):
                if chess.Move.from_uci(line.split()[1]) not in chess.Board().legal_moves:
                    raise ValueError('move')
                return True
    except (OSError, ValueError, TimeoutError, IndexError) as exc:
        raise HTTPException(422, 'Le modèle Maia n’a pas fourni de réponse légale.') from exc
    finally:
        worker.dispose()
        if lease is not None:
            lease.release()
        engine._LOCK.release()
