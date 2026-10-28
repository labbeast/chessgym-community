"""The engine's preview snapshots must match the actual legal PV, move by move."""
import chess
import pytest
import engine


def test_stockfish_previews_match_every_variation_position():
    if not engine.binary_path():
        pytest.skip('Stockfish is required')
    original = chess.STARTING_FEN
    response = engine.analyse(original, multipv=3, time_ms=150)
    assert response['fen'] == original
    assert len(response['lines']) == 3
    for line in response['lines']:
        board = chess.Board(original)
        assert len(line['positions']) == len(line['pv']) == len(line['san'])
        for uci, san, snapshot in zip(line['pv'], line['san'], line['positions']):
            move = chess.Move.from_uci(uci)
            assert move in board.legal_moves
            assert board.san(move) == san == snapshot['san']
            board.push(move)
            assert snapshot['uci'] == uci
            assert snapshot['fen'] == board.fen()
            assert snapshot['game_over'] == board.is_game_over()
            assert snapshot['result'] == board.result()
