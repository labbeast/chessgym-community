import io
import json
import sqlite3
import zipfile

import pytest
from local_test_client import TestClient

import app
import db
import pgnlib

PGN = '''[Event "Tree"]
[White "White"]
[Black "Black"]
[Result "*"]

1. e4 {root [%clk 0:10:00]} (1. d4 d5 2. c4)
1... e5 (1... c5 2. Nf3 d6 (2... Nc6 3. Bb5 $1 {Rossolimo}))
2. Nf3 Nc6 (2... Nf6 $5 {Petrov} 3. d4) (2... d6 3. d4) *
'''


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'tree.sqlite3')

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        assert client.get('/api/status').status_code == 200
        yield client


def make_entry(owner, pgn=PGN, start_path=''):
    base = owner.post('/api/bases', json={'name': 'Tree'}).json()['id']
    response = owner.post('/api/entries', json={'base_id': base, 'pgn': pgn, 'start_path': start_path})
    assert response.status_code == 200, response.text
    return response.json()


def tree(owner, entry_id, path, action):
    response = owner.post(f'/api/entries/{entry_id}/tree', json={'explicit_save': True, 'path': path, 'action': action})
    assert response.status_code == 200, response.text
    return response.json()


def read(owner, entry_id):
    return owner.get(f'/api/entries/{entry_id}').json()


def history(owner, entry_id, action):
    response = owner.post(f'/api/entries/{entry_id}/{action}', json={'explicit_save': True})
    assert response.status_code == 200, response.text
    return response.json()


def moves(entry, path):
    node = pgnlib.node_at(pgnlib.load_game(entry['pgn']), path)
    return [child.move.uci() for child in node.variations]


def test_local_promote_tracks_descendant_and_review_start(owner):
    entry = make_entry(owner, start_path='0.1.0.1.0')
    result = tree(owner, entry['id'], '0.1.0.1.0', 'promote')
    assert result['path'] == '0.1.0.0.0'
    assert result['entry']['start_path'] == result['path']
    assert moves(result['entry'], '') == ['e2e4', 'd2d4']
    assert moves(result['entry'], '0') == ['e7e5', 'c7c5']
    assert moves(result['entry'], '0.1.0') == ['b8c6', 'd7d6']
    selected = pgnlib.node_at(pgnlib.load_game(result['entry']['pgn']), result['path'])
    assert selected.comment == 'Rossolimo' and selected.nags == {1}
    undone = history(owner, entry['id'], 'undo')
    assert undone['entry']['pgn'] == entry['pgn']
    assert undone['path'] == '0.1.0.1.0'
    assert undone['entry']['start_path'] == entry['start_path']
    redone = history(owner, entry['id'], 'redo')
    assert redone['entry']['pgn'] == result['entry']['pgn']


def test_main_promotes_all_ancestors_and_preserves_old_lines(owner):
    entry = make_entry(owner, start_path='0.0.0.1.0')
    result = tree(owner, entry['id'], '0.1.0.1.0', 'main')
    assert result['path'] == '0.0.0.0.0'
    assert moves(result['entry'], '0') == ['c7c5', 'e7e5']
    assert moves(result['entry'], '0.0.0') == ['b8c6', 'd7d6']
    assert result['entry']['start_path'] == '0.1.0.1.0'
    assert '[%clk 0:10:00]' in result['entry']['pgn']
    assert '{ Petrov }' in result['entry']['pgn']


def test_up_down_nearest_branch_and_noops_do_not_clear_redo(owner):
    entry = make_entry(owner)
    result = tree(owner, entry['id'], '0.0.0.2.0', 'up')
    assert result['path'] == '0.0.0.1.0'
    assert moves(result['entry'], '0.0.0') == ['b8c6', 'd7d6', 'g8f6']
    result = tree(owner, entry['id'], result['path'], 'down')
    assert result['entry']['pgn'] == entry['pgn']
    history(owner, entry['id'], 'undo')
    history(owner, entry['id'], 'undo')
    noop = tree(owner, entry['id'], '0', 'promote')
    assert noop['changed'] is False
    assert noop['history'] == {'can_undo': False, 'can_redo': True}
    assert owner.post(f"/api/entries/{entry['id']}/undo", json={'explicit_save': True}).status_code == 409


def test_delete_exact_subtree_rebases_start_and_can_restore(owner):
    entry = make_entry(owner, start_path='0.1.0.1.0')
    result = tree(owner, entry['id'], '0.1', 'delete')
    assert result['path'] == '0'
    assert result['entry']['start_path'] == '0'
    assert moves(result['entry'], '0') == ['e7e5']
    assert 'Rossolimo' not in result['entry']['pgn']
    restored = history(owner, entry['id'], 'undo')
    assert restored['entry']['pgn'] == entry['pgn']
    assert restored['entry']['start_path'] == entry['start_path']
    assert owner.post(f"/api/entries/{entry['id']}/tree", json={'explicit_save': True, 'path': '', 'action': 'delete'}).status_code == 400
    assert read(owner, entry['id'])['pgn'] == entry['pgn']


def test_repeated_positions_keep_identity_not_fen(owner):
    entry = make_entry(owner, pgn='1. Nf3 Nf6 2. Ng1 Ng8 3. e4 (3. d4 d5) *', start_path='0.0.0.0.1.0')
    result = tree(owner, entry['id'], '0.0.0.0.1.0', 'promote')
    assert result['path'] == '0.0.0.0.0.0'
    assert result['entry']['start_path'] == result['path']
    assert moves(result['entry'], '') == ['g1f3']
    assert moves(result['entry'], '0.0.0.0') == ['d2d4', 'e2e4']


def test_free_tree_same_transform_without_persistence(owner):
    entry = make_entry(owner, start_path='0.1.0.1.0')
    free = owner.post('/api/board/tree', json={'pgn': entry['pgn'], 'path': entry['start_path'], 'start_path': entry['start_path'], 'action': 'main'})
    assert free.status_code == 200, free.text
    free = free.json()
    assert free['doc']['start_path'] == '0.0.0.0.0'
    assert read(owner, entry['id'])['pgn'] == entry['pgn']
    saved = tree(owner, entry['id'], entry['start_path'], 'main')
    assert free['doc']['pgn'] == saved['entry']['pgn']
    assert owner.post('/api/board/tree', json={'pgn': entry['pgn'], 'path': '99', 'action': 'main'}).status_code == 400


def test_history_all_edit_routes_and_branch_invalidation(owner):
    entry = make_entry(owner, pgn='1. e4 *')
    eid = entry['id']
    endpoint = f'/api/entries/{eid}'
    updated = owner.patch(endpoint, json={'headers': {'White': 'Alice', 'WhiteElo': '1700'}, 'view_path': '0'}).json()
    assert updated['history']['can_undo']
    comment = owner.patch(endpoint+'/node', json={'explicit_save': True, 'path': '0', 'comment': 'New comment', 'nags': [1]}).json()
    added = owner.post(endpoint+'/move', json={'explicit_save': True, 'path': '0', 'uci': 'e7e5'}).json()
    line = owner.post(endpoint+'/line', json={'explicit_save': True, 'path': added['path'], 'moves': ['g1f3', 'b8c6']}).json()
    assert line['entry']['history']['can_undo']
    assert history(owner, eid, 'undo')['entry']['pgn'] == added['entry']['pgn']
    assert history(owner, eid, 'undo')['entry']['pgn'] == comment['pgn']
    assert history(owner, eid, 'undo')['entry']['pgn'] == updated['pgn']
    assert history(owner, eid, 'undo')['entry']['pgn'] == entry['pgn']
    assert history(owner, eid, 'redo')['entry']['pgn'] == updated['pgn']
    owner.patch(endpoint, json={'selected': False})
    assert read(owner, eid)['history']['can_redo']
    history(owner, eid, 'undo')
    assert read(owner, eid)['selected'] is False
    owner.patch(endpoint, json={'title': 'Different branch'})
    assert read(owner, eid)['history'] == {'can_undo': True, 'can_redo': False}
    assert owner.post(endpoint+'/redo', json={'explicit_save': True}).status_code == 409


def test_invalid_changes_rollback_history_and_content(owner):
    entry = make_entry(owner)
    endpoint = f"/api/entries/{entry['id']}"
    for path, action in [('99', 'delete'), ('', 'unknown'), ('invalid', 'main')]:
        assert owner.post(endpoint+'/tree', json={'explicit_save': True, 'path': path, 'action': action}).status_code == 400
    assert owner.post(endpoint+'/line', json={'explicit_save': True, 'path': '', 'moves': ['e2e4', 'd7d5', 'a1a8']}).status_code == 400
    assert owner.patch(endpoint+'/node', json={'explicit_save': True, 'path': '0', 'comment': 'Valid', 'nags': [999]}).status_code == 400
    current = read(owner, entry['id'])
    assert current['pgn'] == entry['pgn']
    assert current['history'] == {'can_undo': False, 'can_redo': False}


def test_history_is_per_entry_capped_and_cascades(owner):
    first, second = make_entry(owner), make_entry(owner)
    for i in range(105):
        assert owner.patch(f"/api/entries/{first['id']}", json={'title': f'Title {i}'}).status_code == 200
    assert read(owner, second['id'])['history'] == {'can_undo': False, 'can_redo': False}
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entry_history WHERE entry_id=?', (first['id'],)).fetchone()[0] == 100
    owner.delete(f"/api/entries/{first['id']}")
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entry_history').fetchone()[0] == 0


def test_history_survives_connection_reopen_and_is_in_backup(owner):
    entry = make_entry(owner)
    tree(owner, entry['id'], '1', 'main')
    zipped = owner.get('/api/backup')
    assert zipped.status_code == 200
    with zipfile.ZipFile(io.BytesIO(zipped.content)) as archive:
        data = archive.read('chessgym.sqlite3')
    snapshot = sqlite3.connect(':memory:')
    snapshot.deserialize(data)
    assert snapshot.execute('SELECT COUNT(*) FROM entry_history').fetchone()[0] == 1
    snapshot.close()
    assert history(owner, entry['id'], 'undo')['entry']['pgn'] == entry['pgn']


def test_external_content_edit_never_gets_overwritten_by_stale_undo(owner):
    entry = make_entry(owner)
    tree(owner, entry['id'], '1', 'main')
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET title=? WHERE id=?', ('External extension', entry['id']))
    assert read(owner, entry['id'])['history'] == {'can_undo': False, 'can_redo': False}
    assert owner.post(f"/api/entries/{entry['id']}/undo", json={'explicit_save': True}).status_code == 409
    owner.patch(f"/api/entries/{entry['id']}", json={'title': 'Fresh edit'})
    assert history(owner, entry['id'], 'undo')['entry']['title'] == 'External extension'


def test_delete_and_undo_keep_review_attempts_and_due_dates(owner):
    entry = make_entry(owner, pgn='1. e4 e5 2. Nf3 *')
    bid, eid = entry['base_id'], entry['id']
    owner.patch(f'/api/bases/{bid}', json={'settings': {'review_enabled': True, 'type': 'moves', 'color': 'white'}})
    cards = owner.get(f'/api/bases/{bid}/queue?all=true').json()['cards']
    card = next(item for item in cards if item['answers'] == ['g1f3'])
    graded = owner.post(f"/api/reviews/{card['id']}/grade", json={'grade': 2, 'errors': 0, 'hints': 0, 'elapsed_ms': 900, 'assisted': False})
    assert graded.status_code == 200, graded.text
    with db.get_conn() as conn:
        initial_history = [dict(row) for row in conn.execute('SELECT * FROM review_history')]
        initial_due = conn.execute('SELECT due FROM review_cards WHERE id=?', (card['id'],)).fetchone()[0]
    tree(owner, eid, '0.0.0', 'delete')
    assert all(item['id'] != card['id'] for item in owner.get(f'/api/bases/{bid}/queue?all=true').json()['cards'])
    history(owner, eid, 'undo')
    restored = next(item for item in owner.get(f'/api/bases/{bid}/queue?all=true').json()['cards'] if item['id'] == card['id'])
    assert restored['state'] == 'learned'
    with db.get_conn() as conn:
        assert [dict(row) for row in conn.execute('SELECT * FROM review_history')] == initial_history
        assert conn.execute('SELECT due FROM review_cards WHERE id=?', (card['id'],)).fetchone()[0] == initial_due
