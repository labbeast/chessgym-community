"""Both engine transports share legal positions while retaining their policies."""
import chess
import pytest

from engine_variations import line_snapshot


def raw(pv, **changes):
    return {'pv': pv, 'kind': 'cp', 'score': 42, 'depth': 18, **changes}


@pytest.mark.parametrize('kind,score', [('cp', 42), ('mate', 3), ('mate', -3)])
def test_shared_variations_are_white_relative_and_do_not_change_board(kind, score):
    board = chess.Board()
    board.push_uci('e2e4')
    before, history = board.fen(), list(board.move_stack)
    value = line_snapshot(board, raw(['e7e5', 'g1f3'], kind=kind, score=score),
                          require_full_line=True, keep_history=False)
    assert value[kind] == -score
    assert value['mate' if kind == 'cp' else 'cp'] is None
    assert value['uci'] == 'e7e5' and value['san'] == ['e5', 'Nf3']
    replay = board.copy()
    for snapshot, uci in zip(value['positions'], value['pv']):
        replay.push_uci(uci)
        assert snapshot['fen'] == replay.fen()
        assert snapshot['game_over'] == replay.is_game_over()
    assert board.fen() == before and board.move_stack == history


def test_live_transport_rejects_illegal_tail_while_report_keeps_legal_prefix():
    board = chess.Board()
    value = raw(['e2e4', 'e7e4'])
    assert line_snapshot(board, value, require_full_line=True, keep_history=False) is None
    partial = line_snapshot(board, value, require_full_line=False, keep_history=True)
    assert partial['pv'] == ['e2e4'] and partial['san'] == ['e4']
    for full in (True, False):
        assert line_snapshot(board, raw(['e2e4', 'invalid']),
                             require_full_line=full, keep_history=True) is None
        assert line_snapshot(board, raw([]), require_full_line=full, keep_history=True) is None


def test_report_positions_keep_repetition_history_but_live_fen_has_none():
    board = chess.Board()
    cycle = ['g1f3', 'g8f6', 'f3g1', 'f6g8']
    for uci in cycle * 3 + cycle[:3]:
        board.push_uci(uci)
    value = raw(['f6g8'])
    report = line_snapshot(board, value, require_full_line=False, keep_history=True)
    live = line_snapshot(board, value, require_full_line=True, keep_history=False)
    assert report['positions'][-1]['game_over'] is True
    assert report['positions'][-1]['result'] == '1/2-1/2'
    assert live['positions'][-1]['game_over'] is False
    assert live['positions'][-1]['result'] == '*'
