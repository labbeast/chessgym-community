"""Cancellable local engine evaluations for individual opening explorer moves."""
import asyncio
from collections import OrderedDict
from threading import Event, Lock

import chess
from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

import engine
from analysis_limits import MIN_DEPTH, MAX_DEPTH


router = APIRouter(prefix='/api/explorer')
TIME_MS = 250
CACHE_LIMIT = 2048
_CACHE = OrderedDict()
_CACHE_LOCK = Lock()


def clear_cache():
    with _CACHE_LOCK:
        _CACHE.clear()


def _validated_position(payload):
    if (not isinstance(payload, dict) or not {'fen', 'uci'} <= set(payload)
            or set(payload) - {'fen', 'uci', 'depth'}):
        raise HTTPException(422, 'Indique une position FEN et le coup à évaluer.')
    depth = payload.get('depth')
    if depth is not None and (type(depth) is not int or not MIN_DEPTH <= depth <= MAX_DEPTH):
        raise HTTPException(422, 'Choisis une profondeur entière positive, ou le mode rapide.')
    fen, uci = payload['fen'], payload['uci']
    if not isinstance(fen, str) or not 1 <= len(fen) <= 256:
        raise HTTPException(422, 'Indique une position FEN valide.')
    if not isinstance(uci, str) or len(uci) not in (4, 5):
        raise HTTPException(422, 'Indique un coup UCI légal.')
    board = engine.valid_board(fen)
    if board.is_game_over():
        raise HTTPException(422, 'La partie est terminée dans cette position.')
    try:
        move = chess.Move.from_uci(uci)
    except ValueError:
        raise HTTPException(422, 'Indique un coup UCI légal.')
    if move.uci() != uci or move not in board.legal_moves:
        raise HTTPException(422, 'Ce coup est illégal dans la position affichée.')
    return board, move, depth


def _calculate(board, move, depth=None, cancel=None):
    # Terminal children have an exact result, even when an engine omits a PV.
    child = board.copy()
    child.push(move)
    outcome = child.outcome()
    if outcome is not None:
        return {'cp': 0 if outcome.winner is None else None,
                'mate': None if outcome.winner is None else (1 if outcome.winner == chess.WHITE else -1),
                'depth': 0, 'depth_reached': True, 'engine': 'Règles des échecs'}
    kwargs = {'multipv': 1, 'root_moves': [move]}
    if depth is not None:
        kwargs['depth'] = depth
    if cancel is not None:
        kwargs['cancel'] = cancel
    result = engine._run(board, None if depth is not None else TIME_MS, **kwargs)
    line = next((line for line in result.get('lines', []) if line.get('uci') == move.uci()), None)
    if line is None:
        raise HTTPException(503, 'Le moteur n’a pas fourni d’évaluation pour ce coup.')
    cp, mate = line.get('cp'), line.get('mate')
    actual_depth = line.get('depth', 0)
    if not ((type(cp) is int and mate is None) or (cp is None and type(mate) is int)):
        raise HTTPException(503, 'Le moteur n’a pas fourni d’évaluation pour ce coup.')
    if type(actual_depth) is not int or actual_depth < 0:
        raise HTTPException(503, 'Le moteur n’a pas fourni une profondeur exploitable.')
    return {'cp': cp, 'mate': mate, 'depth': actual_depth,
            'depth_reached': depth is None or actual_depth >= depth, 'engine': result['engine']}


def evaluate(payload: dict, cancel=None):
    engine._check_cancelled(cancel)
    board, move, depth = _validated_position(payload)
    fen = board.fen()
    # Keep the move counters: the fifty/seventy-five move rules affect the score.
    # A deeper request must never borrow a score computed in the quick mode.
    time_ms = None if depth is not None else TIME_MS
    path = engine.binary_path()
    identity = engine.binary_identity(path)
    key = (path, identity, depth, time_ms, fen, move.uci())
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is not None:
            _CACHE.move_to_end(key)
            return {**cached, 'cached': True}
    evaluation = {'fen': fen, 'uci': move.uci(),
                  **_calculate(board, move, depth=depth, cancel=cancel),
                  'requested_depth': depth, 'cached': False}
    # A navigation/pause may occur just after the last engine message.
    engine._check_cancelled(cancel)
    # A host selection or external executable replacement during calculation
    # must not publish the result under the previous engine's cache key.
    current_path = engine.binary_path()
    if (current_path, engine.binary_identity(current_path)) != (path, identity):
        return evaluation
    with _CACHE_LOCK:
        _CACHE[key] = evaluation.copy()
        _CACHE.move_to_end(key)
        while len(_CACHE) > CACHE_LIMIT:
            _CACHE.popitem(last=False)
    return evaluation


def _consume_finished_task(task):
    # A canceled request can leave its worker finishing cleanup in the background.
    if not task.cancelled():
        task.exception()


async def _wait_for_disconnect(request):
    # The request body has already been parsed by FastAPI. Read the remaining
    # ASGI messages directly: is_disconnected() polling is unreliable through
    # BaseHTTPMiddleware's receive wrapper on some AnyIO versions.
    while True:
        if (await request.receive())['type'] == 'http.disconnect':
            return


@router.post('/evaluate')
async def evaluate_request(payload: dict, request: Request):
    cancel = Event()
    task = asyncio.create_task(run_in_threadpool(evaluate, payload, cancel=cancel))
    disconnected = asyncio.create_task(_wait_for_disconnect(request))
    try:
        await asyncio.wait({task, disconnected}, return_when=asyncio.FIRST_COMPLETED)
        if disconnected.done():
            await disconnected  # Propagate receive failures as well as cancellation.
            cancel.set()
            try:
                await task
            except engine.AnalysisCancelled:
                pass
            raise HTTPException(499, 'Analyse annulée.')
        return await task
    finally:
        cancel.set()
        disconnected.cancel()
        await asyncio.gather(disconnected, return_exceptions=True)
        if not task.done():
            task.add_done_callback(_consume_finished_task)
