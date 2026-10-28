"""Pedagogical passes in imported studies must be retained without legalizing them."""
import chess
import pytest

import pgnlib


STUDY = '''[Event "Synthetic study"]
[Result "*"]

{Root note} 1. e4 $1 {Main idea}
({Alternative start} 1. d4 $5 d5 2. c4 -- {Imagine no reply}
3. Nc3 (3. Nf3 $6 {Other development}))
1... e5 ({Hypothetical reply} 1... Z0 $6 {Threat [%eval 0.35,18]}
2. d4 d5) 2. Nf3 *
'''


@pytest.mark.parametrize('marker', sorted(pgnlib.NULL_TOKENS))
def test_each_explicit_null_notation_is_retained_and_canonicalized(marker):
    game = pgnlib.load_game(f'1. e4 e5 (1... {marker} 2. d4) 2. Nf3 *')
    passed = pgnlib.node_at(game, '0.1')
    assert passed.move == chess.Move.null()
    assert passed.san() == '--'
    assert passed.board().turn == chess.WHITE
    assert passed.variations[0].move.uci() == 'd2d4'
    exported = pgnlib.export_game(game)
    assert '1... --' in exported
    assert pgnlib.game_payload(pgnlib.load_game(exported)) == pgnlib.game_payload(game)


def test_nested_hypothetical_pass_and_complete_annotations_roundtrip():
    game = pgnlib.load_game('\ufeff' + STUDY)
    original = pgnlib.game_payload(game)
    assert sum(node.move == chess.Move.null() for node in pgnlib.walk_nodes(game)) == 2
    assert all(node.move != chess.Move.null() for node in game.mainline())
    assert pgnlib.node_at(game, '1.0.0.0').comment == 'Imagine no reply'
    assert pgnlib.node_at(game, '0.1').starting_comment == 'Hypothetical reply'
    assert pgnlib.node_at(game, '0.1').nags == {6}
    assert pgnlib.node_at(game, '0.1').eval().white().score() == 35
    for _ in range(3):
        game = pgnlib.load_game(pgnlib.export_game(game))
        assert pgnlib.game_payload(game) == original


@pytest.mark.parametrize('marker', sorted(pgnlib.NULL_TOKENS))
def test_null_on_actual_game_mainline_is_rejected(marker):
    with pytest.raises(ValueError, match='ligne principale'):
        pgnlib.load_game(f'1. e4 {marker} 2. d4 *')


@pytest.mark.parametrize('marker', sorted(pgnlib.NULL_TOKENS))
def test_single_annotated_pass_is_a_text_chapter_at_initial_position(marker):
    game = pgnlib.load_game(
        '[White "Introduction"]\n[Black "Course"]\n[PlyCount "1"]\n'
        '[Source "Personal notes"]\n\n'
        f'{{Initial note}} 1. {marker} {{Chapter text [%csl Ge4]}} *'
    )
    assert not game.variations
    assert game.board().fen() == chess.STARTING_FEN
    assert game.comment == 'Initial note\n\nChapter text [%csl Ge4]'
    assert game.headers['White'] == 'Introduction'
    assert game.headers['Black'] == 'Course'
    assert game.headers['Source'] == 'Personal notes'
    assert game.headers['PlyCount'] == '0'
    payload = pgnlib.game_payload(game)
    assert pgnlib.game_payload(pgnlib.load_game(payload['pgn'])) == payload


@pytest.mark.parametrize('source', [
    '1. Z0 *',
    '1. Z0 $5 {A move annotation must not disappear} *',
    '1. Z0 {Intro} e5 *',
    '1. Z0 {Intro} (1. e4) *',
    '1. e4 Z0 {A pass after a real move} *',
    '1. Z0 {Not an unfinished text chapter} 1-0',
    '1. Z0 {Intro} * ignored',
    '[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4r3/4K3 w - - 0 1"]\n\n1. Z0 {Check} *',
])
def test_text_chapter_compatibility_does_not_discard_other_content(source):
    with pytest.raises(ValueError):
        pgnlib.load_game(source)


def test_text_chapter_keeps_explicit_starting_position_and_headers():
    fen = '7k/8/8/8/8/8/8/K7 b - - 0 21'
    game = pgnlib.load_game(f'[SetUp "1"]\n[FEN "{fen}"]\n\n21... Z0 {{Diagram note}} *')
    assert game.board().fen() == fen
    assert game.headers['FEN'] == fen
    assert game.headers['SetUp'] == '1'
    assert 'PlyCount' not in game.headers
    assert game.comment == 'Diagram note'
    assert not game.variations


def test_null_cannot_skip_a_check_even_inside_variation():
    with pytest.raises(ValueError, match='ignorer un échec'):
        pgnlib.load_game('1. e4 f6 2. Qh5+ g6 (2... --) *')


@pytest.mark.parametrize('pgn', [
    '1. e4 e5 (1... --oops 2. d4) *',
    '1. e4 e5 (1... Z0oops 2. d4) *',
    '1. e4 e5 (1... 0000oops 2. d4) *',
    '1. e4 e5 (1... @@@@oops 2. d4) *',
    '1. e4 e5 (1... -- 2. d4) * unrecognized',
    '[Event "Study"] 0000\n\n1. e4 *',
    '1. e4 e5 (1... -- 2. e4) *',
    '1. e4 e5 (1... -- 2. Qa8) *',
])
def test_null_support_does_not_hide_unknown_or_illegal_moves(pgn):
    with pytest.raises(ValueError):
        pgnlib.load_game(pgn)


def test_all_moves_are_counted_and_other_games_and_zero_castles_survive():
    text = '1. e4 e5 (1... 0000 2. d4) 2. Nf3 Nc6 3. Bc4 Nf6 4. 0-0 *'
    games = pgnlib.parse_games(text + '\n\n' + STUDY)
    assert len(games) == 2
    assert len(list(games[0].mainline())) == 7
    assert pgnlib._validate_lexical(text) == 9
    assert pgnlib.node_at(games[0], '0.1').move == chess.Move.null()


def test_user_move_entry_and_line_preview_stay_strict():
    with pytest.raises(ValueError, match='illégal'):
        pgnlib.line_positions(chess.Board(), ['0000'])
    with pytest.raises(ValueError, match='Position impossible'):
        pgnlib.validate_board('8/8/8/8/8/8/8/8 w - - 0 1')


@pytest.mark.parametrize(('path', 'action'), [
    ('0.1', 'promote'),
    ('0.1', 'up'),
    ('0.1.0', 'main'),
    ('0.0', 'down'),
    ('0.0', 'delete'),
    ('1', 'main'),
    ('0', 'delete'),
])
def test_tree_changes_cannot_promote_nulls_to_mainline_and_rollback(path, action):
    game = pgnlib.load_game(STUDY)
    before = pgnlib.export_game(game)
    with pytest.raises(ValueError, match='coup nul pédagogique dans la ligne principale'):
        pgnlib.edit_tree(game, path, action)
    assert pgnlib.export_game(game) == before
    # The same in-memory object is still usable after a failed edit.
    assert pgnlib.load_game(pgnlib.export_game(game))


def test_null_branch_can_be_edited_or_deleted_without_affecting_actual_line():
    game = pgnlib.load_game(STUDY)
    played = [node.move.uci() for node in game.mainline()]
    result = pgnlib.edit_tree(game, '1.0.0.0.1', 'promote')
    assert result['changed']
    assert [node.move.uci() for node in game.mainline()] == played
    assert pgnlib.load_game(pgnlib.export_game(game))
    result = pgnlib.edit_tree(game, '0.1', 'delete')
    assert result['changed']
    assert [node.move.uci() for node in game.mainline()] == played
    assert sum(node.move == chess.Move.null() for node in pgnlib.walk_nodes(game)) == 1
