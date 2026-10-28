"""Stateless computer games, isolated from saved games and analysis documents.

Every request replays legal moves from its starting position. Engine results are
checked against that same board, so repetition and draw rules survive requests.
Nothing in this module opens a database or changes a source PGN.
"""
from __future__ import annotations

from typing import Annotated, Literal

import chess
import chess.pgn
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints

import engine
import maia_engine
import pgnlib

router = APIRouter(prefix='/computer')

UciMove = Annotated[str, StringConstraints(pattern=r'^[a-h][1-8][a-h][1-8][qrbn]?$')]
Fen = Annotated[str, StringConstraints(min_length=1, max_length=256)]
MAIA_LEVELS = maia_engine.LEVELS


class PositionState(BaseModel):
    model_config = ConfigDict(extra='forbid')

    initial_fen: Fen = chess.STARTING_FEN
    history: list[UciMove] = Field(default_factory=list, max_length=2000)
    fen: Fen | None = None


class PositionRequest(PositionState):
    move: UciMove | None = None


class ComputerMoveRequest(PositionState):
    provider: Literal['stockfish', 'maia'] = 'stockfish'
    skill: StrictInt = Field(default=10, ge=0, le=20)
    level: StrictInt = Field(default=1500, ge=MAIA_LEVELS[0], le=MAIA_LEVELS[-1])
    time_ms: StrictInt = Field(default=500, ge=100, le=2000)


class TimeoutRequest(PositionState):
    loser: Literal['white', 'black']


def timeout_snapshot(board, loser):
    """Adjudicate a local practice clock without changing a library document."""
    state = _snapshot(board)
    if state['game_over']:
        return state
    if loser != ('white' if board.turn else 'black'):
        raise HTTPException(422, 'Seul le camp au trait peut perdre au temps.')
    winner = not board.turn
    result = '1/2-1/2' if board.has_insufficient_material(winner) else ('1-0' if winner else '0-1')
    state.update(game_over=True, result=result, reason='timeout', legal_moves=[])
    state['legalState'].update(game_over=True, result=result, moves=[])
    game = chess.pgn.Game.from_board(board)
    game.headers['Result'] = result
    state['doc'] = pgnlib.game_payload(game)
    return state


@router.post('/timeout')
def timeout(request: TimeoutRequest):
    return timeout_snapshot(_replay(request), request.loser)


def _legal_move(board, uci):
    try:
        move = chess.Move.from_uci(uci)
    except (TypeError, ValueError):
        raise HTTPException(422, 'Coup invalide.')
    # push_uci accepts null moves. A played game must never accept them.
    if move not in board.legal_moves:
        raise HTTPException(422, 'Ce coup est illégal dans cette position.')
    return move


def _replay(request):
    board = engine.valid_board(request.initial_fen)
    for uci in request.history:
        # A player may decline a claimable draw, but cannot play on after an
        # automatic game end. Only the final state auto-claims for this mode.
        if board.is_game_over():
            raise HTTPException(422, 'L’historique contient un coup après la fin de la partie.')
        board.push(_legal_move(board, uci))
    if request.fen is not None and engine.valid_board(request.fen).fen() != board.fen():
        raise HTTPException(422, 'L’historique ne correspond pas à la position fournie.')
    return board


def _snapshot(board, *, played=None):
    outcome = board.outcome(claim_draw=True)
    result = outcome.result() if outcome else '*'
    game = chess.pgn.Game.from_board(board)
    game.headers['Result'] = result
    doc = pgnlib.game_payload(game)
    moves = [] if outcome else [move.uci() for move in board.legal_moves]
    fen = board.fen()
    return {
        'initial_fen': board.root().fen(),
        'fen': fen,
        'history': [move.uci() for move in board.move_stack],
        'legal_moves': moves,
        'turn': 'white' if board.turn else 'black',
        'last_move': board.peek().uci() if board.move_stack else None,
        'uci': played.uci() if played is not None else None,
        'san': doc['nodes'][-1]['san'] if played is not None else None,
        'check': board.is_check(),
        'game_over': outcome is not None,
        'result': result,
        'reason': outcome.termination.name.lower() if outcome else None,
        'claimable_draws': {
            'threefold_repetition': board.can_claim_threefold_repetition(),
            'fifty_moves': board.can_claim_fifty_moves(),
        },
        'doc': doc,
        'path': doc['nodes'][-1]['path'],
        'legalState': {'fen': fen, 'moves': moves, 'game_over': outcome is not None, 'result': result},
    }


@router.get('/opponents')
def opponents():
    stockfish = engine.status()
    maia = maia_engine.status()
    return {'engines': [
        {'id': 'stockfish', 'name': stockfish.get('name', 'Stockfish'),
         'available': stockfish['available'],
         'skills': stockfish.get('capabilities', {}).get('skills', list(range(21))),
         'default_skill': 10 if stockfish.get('capabilities', {}).get('skill', True) else 20,
         **({'message': 'Le moteur UCI est indisponible sur ce serveur.'} if not stockfish['available'] else {})},
        {'id': 'maia', 'name': maia.get('name', 'Maia 3'), 'available': maia['available'],
         'levels': list(maia.get('levels', MAIA_LEVELS)), 'default_level': 1500,
         **({'message': maia['message']} if maia.get('message') else {})},
    ]}


@router.post('/position')
def position(request: PositionRequest):
    board = _replay(request)
    played = None
    if request.move is not None:
        if board.is_game_over(claim_draw=True):
            raise HTTPException(409, 'Cette partie est terminée. Commence une nouvelle partie pour jouer.')
        played = _legal_move(board, request.move)
        board.push(played)
    return _snapshot(board, played=played)


@router.post('/move')
def computer_move(request: ComputerMoveRequest):
    board = _replay(request)
    if board.is_game_over(claim_draw=True):
        return _snapshot(board)
    history = [move.uci() for move in board.move_stack]
    if request.provider == 'maia':
        if request.level not in MAIA_LEVELS:
            raise HTTPException(422, 'Choisissez un niveau Maia 3 de 600 à 2600, par pas de 100.')
        available = maia_engine.status()
        if not available['available']:
            raise HTTPException(503, available.get('message') or 'Maia 3 est indisponible sur ce serveur.')
        reply = maia_engine.play(board.fen(), level=request.level,
                                 history=history, initial_fen=board.root().fen())
    else:
        # The shared play lane has a bounded queue/search and never writes data.
        # Abandoning a browser request therefore cannot change a saved game.
        reply = engine.play(board.fen(), skill=request.skill, time_ms=request.time_ms,
                            history=history, initial_fen=board.root().fen())
    try:
        played = _legal_move(board, reply.get('uci'))
    except (HTTPException, AttributeError) as exc:
        raise HTTPException(503, 'Le moteur n’a pas fourni de coup légal.') from exc
    board.push(played)
    if reply.get('fen') != board.fen():
        raise HTTPException(503, 'Le moteur a fourni une position incohérente.')
    return _snapshot(board, played=played)
