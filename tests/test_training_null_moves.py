"""Course annotations must never become null-move training answers."""
import json

import chess
import pytest
from fastapi import HTTPException

import db
import training


COURSE = (
    '[Event "Synthetic course"]\n\n'
    '1. e4 {Keep this note} e5 '
    '(1... -- {Imagine White moving again} 2. d4 d5 3. Nc3) '
    '(1... c5 2. Nf3 $1) 2. Nf3 Nc6 *'
)


@pytest.fixture()
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'training-null.sqlite3')
    db.init_db()
    training.init_training()


def make_base(**settings):
    configuration = {'review_enabled': True, 'type': 'moves', 'color': 'white',
                     'new_limit': 100}
    configuration.update(settings)
    with db.get_conn() as conn:
        return conn.execute(
            'INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
            ('Synthetic study', json.dumps(configuration), training.stamp()),
        ).lastrowid


def make_entry(base_id, pgn=COURSE, start_path=''):
    with db.get_conn() as conn:
        return conn.execute(
            '''INSERT INTO entries(base_id,title,pgn,selected,start_path,created_at,updated_at)
               VALUES (?,?,?,1,?,?,?)''',
            (base_id, 'Synthetic course', pgn, start_path, training.stamp(), training.stamp()),
        ).lastrowid


def saved_entries():
    with db.get_conn() as conn:
        return [dict(row) for row in conn.execute('SELECT * FROM entries ORDER BY id')]


def assert_playable(card):
    board = chess.Board(card['fen'])
    assert card['answers']
    assert all(chess.Move.from_uci(answer) in board.legal_moves for answer in card['answers'])
    for line in card['solutions']:
        position = board.copy()
        for uci in line:
            move = chess.Move.from_uci(uci)
            assert move and move in position.legal_moves
            position.push(move)


def test_opening_cards_skip_whole_null_branch_preserve_ordinal_paths_and_pgn(database):
    bid = make_base()
    make_entry(bid)
    before = saved_entries()
    cards = training.queue(bid, all=True)['cards']
    assert {card['path'] for card in cards} == {'', '0.0', '0.2'}
    assert len(cards) == 3
    for card in cards:
        assert_playable(card)
    assert training.reviews()['bases'][0]['total'] == 3
    assert saved_entries() == before


def test_solve_keeps_real_variations_and_never_accepts_null_answer(database):
    bid = make_base(type='solve')
    make_entry(bid, start_path='0')
    before = saved_entries()
    card, = training.queue(bid)['cards']
    assert card['answers'] == ['e7e5', 'c7c5']
    assert card['solutions'] == [
        ['e7e5', 'g1f3', 'b8c6'],
        ['c7c5', 'g1f3'],
    ]
    assert_playable(card)
    assert saved_entries() == before


def test_solution_stops_at_legal_prefix_when_only_null_continuation_exists():
    game = training.load_game('1. e4 e5 (1... c5 2. -- Nf6) *')
    assert training.solution_lines(game) == [
        ['e2e4', 'e7e5'],
        ['e2e4', 'c7c5'],
    ]
    assert training.solution_lines(training.node_at(game, '0.1')) == []


@pytest.mark.parametrize('exercise_type', ['moves', 'solve'])
def test_no_empty_card_for_position_with_only_null_answer(database, exercise_type):
    bid = make_base(type=exercise_type, color='white')
    make_entry(bid, '1. e4 e5 (1... c5 2. -- Nf6) *', start_path='0.1')
    cards = training.queue(bid)['cards']
    if exercise_type == 'solve':
        assert cards == []
    else:
        assert len(cards) == 1
        assert cards[0]['path'] == ''
        assert cards[0]['answers'] == ['e2e4']
        assert_playable(cards[0])


def test_explicitly_selected_hypothetical_diagram_can_have_legal_solution(database):
    bid = make_base(type='solve')
    make_entry(bid, start_path='0.1')
    card, = training.queue(bid)['cards']
    assert card['path'] == '0.1'
    assert card['answers'] == ['d2d4']
    assert card['solutions'] == [['d2d4', 'd7d5', 'b1c3']]
    assert_playable(card)


@pytest.mark.parametrize('existing_line', ['', '1. e4 *'])
def test_extension_rejects_null_source_even_past_empty_repertoire_leaf(database, existing_line):
    bid = make_base(is_repertoire=True, primary=True)
    if existing_line:
        make_entry(bid, existing_line)
    source_base = make_base(review_enabled=False)
    source_id = make_entry(source_base)
    before = saved_entries()
    check = training.compatibility(source_id, '0.1.0')['white']
    assert not check['compatible'] and not check['extendable']
    assert 'coup nul' in check['reason']
    with pytest.raises(HTTPException) as error:
        training.extend(bid, training.ExtendRequest(entry_id=source_id, path='0.1.0'))
    assert error.value.status_code == 409
    assert saved_entries() == before


def test_repertoire_prunes_null_continuations_from_transposition_positions(database):
    bid = make_base(is_repertoire=True, primary=True)
    make_entry(bid, '1. e4 e5 (1... -- 2. d4 -- 3. Nc3) *')
    source_id = make_entry(
        make_base(review_enabled=False), '1. d4 Nf6 2. e4 Ng8 3. Nc3 *',
    )
    before = saved_entries()
    check = training.compatibility(source_id, '0.0.0.0.0')['white']
    assert not check['compatible']
    assert not check['transposition']
    assert saved_entries() == before


def test_legal_source_can_extend_course_repertoire_without_erasing_null_annotations(database):
    bid = make_base(is_repertoire=True, primary=True)
    target = make_entry(bid)
    source_id = make_entry(
        make_base(review_enabled=False), '1. e4 c5 2. Nf3 d6 *',
    )
    with db.get_conn() as conn:
        source_before = conn.execute('SELECT pgn FROM entries WHERE id=?', (source_id,)).fetchone()[0]
    check = training.compatibility(source_id, '0.0.0.0')['white']
    assert check['compatible'] and check['extendable']
    assert training.extend(
        bid, training.ExtendRequest(entry_id=source_id, path='0.0.0.0'),
    )['added_moves'] == 1
    with db.get_conn() as conn:
        updated = conn.execute('SELECT pgn FROM entries WHERE id=?', (target,)).fetchone()[0]
        assert conn.execute('SELECT pgn FROM entries WHERE id=?', (source_id,)).fetchone()[0] == source_before
    game = training.load_game(updated)
    hypothetical = training.node_at(game, '0.1')
    assert hypothetical.move == chess.Move.null()
    assert hypothetical.comment == 'Imagine White moving again'
    assert training.node_at(game, '0.2.0.0').move.uci() == 'd7d6'
