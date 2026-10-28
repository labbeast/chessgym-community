"""PGN payloads retain every branch and clock without replaying its ancestors."""
import chess
import chess.pgn
import pytest

import pgnlib


ANNOTATED = '''[TimeControl "600+5"]

{Introduction}
1. e4 {[%clk 0:10:03]}
(1. d4 {[%clk 0:09:40]} d5 {[%clk 0:09:45]} 2. c4 {[%clk 0:09:30]})
e5 {[%clk 0:10:00]} 2. Nf3 $1 {[%clk 0:10:01]}
(2. Bc4 {[%clk 0:09:50]} Nf6 {[%clk 0:09:40]})
Nc6 {[%clk 0:09:56]} 3. Bb5 {[%emt 0:00:02.5]} a6 {[%clk 0:09:50]}
4. Ba4 {[%clk 0:09:40]} *'''


def test_branches_restore_board_and_clock_context_without_mutating_tree():
    game = pgnlib.load_game(ANNOTATED)
    before = pgnlib.export_game(game)
    payload = pgnlib.game_payload(game)
    nodes = {node['path']: node for node in payload['nodes']}
    expected_elapsed = {
        '': None, '0': 2, '1': 25, '1.0': 20, '1.0.0': 15,
        '0.0': 5, '0.0.0': 7, '0.0.1': 18, '0.0.1.0': 25,
        '0.0.0.0': 9, '0.0.0.0.0': 2.5, '0.0.0.0.0.0': 11,
        '0.0.0.0.0.0.0': None,
    }
    assert {path: item['elapsed'] for path, item in nodes.items()} == expected_elapsed
    for path, item in nodes.items():
        source = pgnlib.node_at(game, path)
        assert item['fen'] == source.board().fen()
        assert item['san'] == (source.san() if path else None)
        assert item['comment'] == source.comment
        assert item['nags'] == sorted(source.nags)
        assert item['elapsed'] == pgnlib._elapsed(source, game)
    assert payload['pgn'] == before == pgnlib.export_game(game)


def test_nonstandard_root_uses_only_known_previous_clocks():
    fen = chess.Board()
    fen.push_uci('e2e4')
    source = f'''[SetUp "1"]
[FEN "{fen.fen()}"]
[TimeControl "600+5"]

1... e5 {{[%clk 0:09:50]}} 2. Nf3 {{[%clk 0:09:40]}} Nc6 {{[%clk 0:09:30]}} *'''
    nodes = pgnlib.game_payload(pgnlib.load_game(source))['nodes']
    assert [node['elapsed'] for node in nodes] == [None, None, None, 25]


@pytest.mark.parametrize('control', ['?', '-', '40/7200:3600'])
def test_unknown_and_complex_controls_only_keep_explicit_move_time(control):
    source = '[TimeControl "' + control + '"]\n\n1. e4 {[%clk 0:09:50]} e5 {[%clk 0:09:40] [%emt 0:00:03]} *'
    assert [node['elapsed'] for node in pgnlib.game_payload(pgnlib.load_game(source))['nodes']] == [None, None, 3]


def test_long_lines_do_not_rebuild_child_positions(monkeypatch):
    game, board = chess.pgn.Game(), chess.Board()
    node = game
    for uci in ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 100:
        move = chess.Move.from_uci(uci)
        node = node.add_variation(move)
        board.push(move)
    # Reconstructing every child's ancestor chain made serialization quadratic.
    def rebuilding(*args):
        raise AssertionError('Payload construction replayed an ancestor chain')
    monkeypatch.setattr(chess.pgn.ChildNode, 'board', rebuilding)
    payload = pgnlib.game_payload(game)
    assert len(payload['nodes']) == 401
    assert payload['nodes'][-1]['fen'] == board.fen()
