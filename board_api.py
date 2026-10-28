"""Stateless chessboard operations: these routes never save library content."""
import chess
import chess.pgn
from fastapi import APIRouter, Depends

import pgnlib
from accounts_api import require_user
from api_common import fail

router = APIRouter()


@router.post('/api/board/tree')
def change_free_tree(payload: dict, user=Depends(require_user)):
    game = pgnlib.load_game(payload.get('pgn'))
    change = pgnlib.edit_tree(game, payload.get('path', ''), payload.get('action'), payload.get('start_path', ''))
    doc = pgnlib.game_payload(game)
    doc['start_path'] = change['start_path']
    return {'doc': doc, 'path': change['path'], 'changed': change['changed']}



@router.post('/api/board')
def board(payload: dict, user=Depends(require_user)):
    if payload.get('pgn'):
        game = pgnlib.load_game(payload['pgn'])
    else:
        game = chess.pgn.Game()
        game.setup(pgnlib.validate_board(payload.get('fen', chess.STARTING_FEN)))
    if 'headers' in payload:
        pgnlib.patch_headers(game, payload['headers'])
    return pgnlib.game_payload(game)



@router.post('/api/line')
def preview_line(payload: dict, user=Depends(require_user)):
    board = pgnlib.validate_board(payload.get('fen'))
    return {'positions': pgnlib.line_positions(board, payload.get('moves'))}



@router.post('/api/move')
def move(payload: dict, user=Depends(require_user)):
    board = pgnlib.validate_board(payload.get('fen'))
    try:
        played = chess.Move.from_uci(payload.get('uci', ''))
    except (ValueError, TypeError):
        fail('Coup invalide.')
    if played not in board.legal_moves:
        fail('Ce coup est illégal dans cette position.')
    san = board.san(played)
    board.push(played)
    return {'fen': board.fen(), 'san': san, 'uci': played.uci(), 'legal_moves': [m.uci() for m in board.legal_moves], 'game_over': board.is_game_over(), 'result': board.result()}



@router.get('/api/legal')
def legal(fen: str, user=Depends(require_user)):
    board = pgnlib.validate_board(fen)
    return {'moves': [m.uci() for m in board.legal_moves], 'game_over': board.is_game_over(), 'result': board.result()}

