"""Independent exercise drafts never modify the game they were opened from."""
import chess
import pytest
from local_test_client import TestClient

import app
import db
import pgnlib


SOURCE_PGN = '''[Event "Partie à conserver"]
[White "Alice"]
[Black "Bob"]
[Result "*"]
[TimeControl "600+5"]

1. e4 $1 {Centre [%clk 0:10:00] [%eval 0.25]}
1... e5 2. Nf3 Nc6 (2... Nf6 {Autre défense})
3. Bb5 a6 *
'''


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'exercise-creation.sqlite3')

    with TestClient(app.app, base_url='http://localhost',
                    client=('127.0.0.1', 51040)) as client:
        ok(client.get('/api/status'))
        yield client


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def make_base(owner, name, **settings):
    return ok(owner.post('/api/bases', json={
        'name': name, 'settings': settings,
    }))['id']


def source(owner):
    bid = make_base(owner, 'Parties et analyses')
    entry = ok(owner.post('/api/entries', json={
        'base_id': bid, 'title': 'Analyse en cours',
        'pgn': SOURCE_PGN, 'start_path': '0.0',
    }))
    # Include a real edit history and a non-default review selection in the
    # snapshot; creation must preserve these as well as the visible PGN.
    entry = ok(owner.patch(f"/api/entries/{entry['id']}", json={
        'title': 'Analyse personnelle', 'selected': False,
        'view_path': '0.0.0',
    }))
    return entry


def snapshot(entry_id):
    with db.get_conn() as conn:
        return {
            'entry': dict(conn.execute(
                'SELECT * FROM entries WHERE id=?', (entry_id,),
            ).fetchone()),
            'history': [dict(row) for row in conn.execute(
                'SELECT * FROM entry_history WHERE entry_id=? ORDER BY id',
                (entry_id,),
            )],
        }


def count_entries():
    with db.get_conn() as conn:
        return conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0]


def node(doc, path):
    return next(value for value in doc['nodes'] if value['path'] == path)


def draft_pgn(root, movetext, comment=''):
    game = pgnlib.load_game(root['pgn'])
    game.comment = comment
    # The move text represents deliberate user input, not an engine result or
    # the continuation from the source game.
    headers = pgnlib.export_game(game).rsplit('\n\n', 1)[0]
    return headers + '\n\n' + (f'{{ {comment} }} ' if comment else '') + movetext


@pytest.mark.parametrize('path', ['0.0', '0.0.0'])
def test_new_draft_contains_only_selected_position_and_can_be_abandoned(owner, path):
    original = source(owner)
    before = snapshot(original['id'])
    selected = node(original, path)
    draft = ok(owner.post('/api/board', json={'fen': selected['fen']}))

    assert len(draft['nodes']) == 1
    assert node(draft, '')['fen'] == selected['fen']
    assert node(draft, '')['children'] == []
    assert '[%clk' not in draft['pgn']
    assert 'Analyse personnelle' not in draft['pgn']

    # Moving a piece in the composer is a stateless validation operation.
    board = chess.Board(selected['fen'])
    uci = 'f1c4' if board.turn == chess.WHITE else 'd7d6'
    moved = ok(owner.post('/api/move', json={'fen': selected['fen'], 'uci': uci}))
    board.push_uci(uci)
    assert moved['fen'] == board.fen()
    assert snapshot(original['id']) == before
    assert count_entries() == 1


def test_save_manual_solution_tree_creates_new_card_and_preserves_source(owner):
    original = source(owner)
    before = snapshot(original['id'])
    fen = node(original, '0.0')['fen']
    draft = ok(owner.post('/api/board', json={'fen': fen}))
    manual = draft_pgn(
        draft,
        '2. Nf3 $1 {Développer avec tempo} '
        '(2. Bc4 Nc6) 2... Nc6 (2... Nf6 3. d4) *',
        'Trouver un développement actif.',
    )
    edited = ok(owner.post('/api/board', json={'pgn': manual}))
    assert count_entries() == 1
    target = make_base(owner, 'Mes exercices', review_enabled=True, type='solve')
    saved = ok(owner.post('/api/entries', json={
        'base_id': target, 'title': 'Développement', 'pgn': edited['pgn'],
        'start_path': '',
    }))

    assert saved['id'] != original['id']
    assert saved['base_id'] == target
    assert saved['start_path'] == ''
    assert saved['headers']['FEN'] == fen
    assert saved['headers']['SetUp'] == '1'
    assert node(saved, '0')['nags'] == [1]
    assert node(saved, '0')['comment'] == 'Développer avec tempo'
    assert node(saved, '')['comment'] == 'Trouver un développement actif.'
    assert snapshot(original['id']) == before

    cards = ok(owner.get(f'/api/bases/{target}/queue'))['cards']
    assert len(cards) == 1
    card = cards[0]
    assert card['entry_id'] == saved['id'] and card['path'] == ''
    assert card['fen'] == fen
    assert set(card['answers']) == {'g1f3', 'f1c4'}
    assert sorted(card['solutions']) == sorted([
        ['g1f3', 'b8c6'],
        ['g1f3', 'g8f6', 'd2d4'],
        ['f1c4', 'b8c6'],
    ])
    assert card['comment'] == 'Trouver un développement actif.'
    assert snapshot(original['id']) == before
    assert count_entries() == 2


def test_custom_black_root_retains_turn_number_and_all_deliberate_variations(owner):
    original = source(owner)
    before = snapshot(original['id'])
    board = chess.Board()
    board.push_uci('e2e4')
    board.fullmove_number = 37
    fen = board.fen()
    draft = ok(owner.post('/api/board', json={'fen': fen}))
    edited = ok(owner.post('/api/board', json={'pgn': draft_pgn(
        draft, '37... c5 (37... e5 38. Nf3) 38. Nf3 d6 (38... Nc6) *',
    )}))
    target = make_base(owner, 'Défenses', review_enabled=True, type='solve', color='black')
    saved = ok(owner.post('/api/entries', json={
        'base_id': target, 'title': 'Choisir une défense',
        'pgn': edited['pgn'], 'start_path': '',
    }))

    assert saved['headers']['FEN'] == fen
    assert '37... c5' in saved['pgn']
    assert '( 37... e5' in saved['pgn']
    assert node(saved, '0')['san'] == 'c5'
    assert chess.Board(node(saved, '0')['fen']).fullmove_number == 38
    assert chess.Board(node(saved, '0')['fen']).turn == chess.WHITE
    card = ok(owner.get(f'/api/bases/{target}/queue'))['cards'][0]
    assert card['fen'] == fen
    assert set(card['answers']) == {'c7c5', 'e7e5'}
    assert sorted(card['solutions']) == sorted([
        ['c7c5', 'g1f3', 'd7d6'],
        ['c7c5', 'g1f3', 'b8c6'],
        ['e7e5', 'g1f3'],
    ])
    assert snapshot(original['id']) == before


def test_promote_and_delete_are_isolated_until_save(owner):
    original = source(owner)
    before = snapshot(original['id'])
    root = ok(owner.post('/api/board', json={'fen': node(original, '0.0')['fen']}))
    draft = ok(owner.post('/api/board', json={'pgn': draft_pgn(
        root, '2. Nf3 Nc6 (2... Nf6 3. d4) (2... d6 3. Bc4) *',
    )}))
    promoted = ok(owner.post('/api/board/tree', json={
        'pgn': draft['pgn'], 'path': '0.1.0', 'start_path': '', 'action': 'main',
    }))
    assert promoted['path'] == '0.0.0'
    assert promoted['doc']['start_path'] == ''
    assert node(promoted['doc'], '0.0')['uci'] == 'g8f6'
    assert node(promoted['doc'], '0.1')['uci'] == 'b8c6'
    removed = ok(owner.post('/api/board/tree', json={
        'pgn': promoted['doc']['pgn'], 'path': '0.2',
        'start_path': '', 'action': 'delete',
    }))
    assert removed['path'] == '0'
    assert node(removed['doc'], '0')['children'] == ['0.0', '0.1']
    assert count_entries() == 1
    assert snapshot(original['id']) == before

    target = make_base(owner, 'Cartes choisies', review_enabled=True, type='solve')
    saved = ok(owner.post('/api/entries', json={
        'base_id': target, 'pgn': removed['doc']['pgn'], 'start_path': '',
    }))
    card = ok(owner.get(f'/api/bases/{target}/queue'))['cards'][0]
    assert card['entry_id'] == saved['id']
    assert card['solutions'] == [
        ['g1f3', 'g8f6', 'd2d4'],
        ['g1f3', 'b8c6'],
    ]
    assert snapshot(original['id']) == before


def test_invalid_draft_or_save_does_not_touch_source_or_leave_partial_entry(owner):
    original = source(owner)
    before = snapshot(original['id'])
    target = make_base(owner, 'Exercices', review_enabled=True, type='solve')
    root = ok(owner.post('/api/board', json={'fen': node(original, '0.0')['fen']}))
    valid = draft_pgn(root, '2. Nf3 Nc6 *')

    assert owner.post('/api/move', json={
        'fen': node(root, '')['fen'], 'uci': 'e4e6',
    }).status_code == 400
    assert owner.post('/api/board/tree', json={
        'pgn': valid, 'path': '99', 'start_path': '', 'action': 'delete',
    }).status_code == 400
    assert owner.post('/api/entries', json={
        'base_id': target, 'pgn': draft_pgn(root, '2. Nf3 Nc6 3. Bh6 *'),
        'start_path': '',
    }).status_code == 400
    assert owner.post('/api/entries', json={
        'base_id': target, 'pgn': valid, 'start_path': '99',
    }).status_code == 400

    assert count_entries() == 1
    assert snapshot(original['id']) == before
    assert ok(owner.get(f'/api/bases/{target}/queue'))['cards'] == []
