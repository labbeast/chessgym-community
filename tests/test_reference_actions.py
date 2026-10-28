"""Selection mutations preserve indexed reference data and isolated study copies."""
import sqlite3

import chess
import pytest

import db
import reference_actions as actions
import reference_library as library
import reference_store as store
from test_reference_library import PGN, client, owner, synchronous, create


def path_for(base_id):
    return library.store_path(library.require_reference(base_id)['storage_key'])


def batch(owner, base_id, action, ids, **options):
    return owner.post(f'/api/reference-bases/{base_id}/games/batch',
                      json={'action': action, 'game_ids': ids, **options})


def test_selection_rejects_nonlocal_requests_without_deleting_games(owner, tmp_path, synchronous):
    base_id = create(owner, tmp_path)['id']
    path = path_for(base_id)
    original = store.read_game(path, 1)
    response = owner.post(f'/api/reference-bases/{base_id}/games/batch',
                          json={'action': 'delete', 'game_ids': [1]},
                          headers={'Host': 'remote.example'})
    assert response.status_code == 403
    assert store.read_game(path, 1) == original


def test_duplicate_in_reference_preserves_original_and_positions(owner, tmp_path, synchronous):
    base_id = create(owner, tmp_path)['id']
    path = path_for(base_id)
    original = store.read_game(path, 1)
    original_status = store.status(path)
    response = batch(owner, base_id, 'duplicate', [1])
    assert response.status_code == 200, response.text
    assert response.json()['game_ids'] == [2]
    assert store.read_game(path, 2)['pgn'] == original['pgn']
    assert store.status(path)['game_count'] == 2
    assert store.status(path)['indexed_positions'] == 2 * original_status['indexed_positions']
    assert store.search_position(path, chess.STARTING_FEN)['total'] == 2
    assert {row['game_id'] for row in store.search_position(path, chess.STARTING_FEN)['matches']} == {1, 2}
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 0


def test_delete_only_selected_removes_positions_and_keeps_source_pgn(owner, tmp_path, synchronous):
    base_id = create(owner, tmp_path, PGN + '\n' + PGN.replace('Alice', 'Carol'))['id']
    row = library.require_reference(base_id)
    from pathlib import Path
    source = Path(row['source'])
    original = source.read_bytes()
    path = path_for(base_id)
    status = store.status(path)
    assert batch(owner, base_id, 'delete', [1]).status_code == 200
    assert store.list_games(path)['entries'][0]['id'] == 2
    assert store.search_position(path, chess.STARTING_FEN)['total'] == 1
    assert store.status(path)['indexed_positions'] == status['indexed_positions'] // 2
    assert store.status(path)['imported'] == 2  # Import history is not corpus size.
    assert owner.get(f'/api/reference-bases/{base_id}/games/1').status_code == 404
    assert source.read_bytes() == original
    assert owner.get('/api/library').json()['bases'][0]['entry_count'] == 1
    with sqlite3.connect(path) as conn:
        assert conn.execute('SELECT count(*) FROM positions WHERE game_id=1').fetchone()[0] == 0
        assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'


@pytest.mark.parametrize('action', ['duplicate', 'move'])
def test_copy_or_move_to_personal_preserves_annotations(owner, tmp_path, synchronous, action):
    base_id = create(owner, tmp_path)['id']
    study = owner.post('/api/bases', json={'name': 'Étude', 'settings': {'review_enabled': True}}).json()['id']
    original = store.read_game(path_for(base_id), 1)['pgn']
    response = batch(owner, base_id, action, [1], target_base_id=study)
    assert response.status_code == 200, response.text
    entry_id = response.json()['entry_ids'][0]
    with db.get_conn() as conn:
        entry = conn.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone()
        assert entry['base_id'] == study and entry['pgn'] == original
        assert entry['selected'] == 1
        assert conn.execute('SELECT count(*) FROM review_cards WHERE entry_id=?', (entry_id,)).fetchone()[0] > 0
    page = owner.get(f'/api/bases/{study}/entries', params={'limit': 50}).json()
    assert page['total'] == 1 and page['entries'][0]['id'] == entry_id
    assert page['entries'][0]['headers']['White'] == 'Alice'
    assert store.status(path_for(base_id))['game_count'] == (1 if action == 'duplicate' else 0)
    assert store.search_position(path_for(base_id), chess.STARTING_FEN)['total'] == (1 if action == 'duplicate' else 0)


@pytest.mark.parametrize('action', ['duplicate', 'move'])
def test_copy_or_move_between_references(owner, tmp_path, synchronous, action):
    source = create(owner, tmp_path)['id']
    target = create(owner, tmp_path, PGN.replace('Alice', 'Zoe'))['id']
    original = store.read_game(path_for(source), 1)['pgn']
    response = batch(owner, source, action, [1], target_base_id=target)
    assert response.status_code == 200, response.text
    assert response.json()['game_ids'] == [2]
    assert store.read_game(path_for(target), 2)['pgn'] == original
    assert store.status(path_for(target))['game_count'] == 2
    assert store.search_position(path_for(target), chess.STARTING_FEN)['total'] == 2
    assert store.status(path_for(source))['game_count'] == (1 if action == 'duplicate' else 0)


@pytest.mark.parametrize('ids', [[], [True], ['1'], [0], [1, 1], [1, 9999]])
def test_invalid_or_stale_selection_never_applies_partially(owner, tmp_path, synchronous, ids):
    base_id = create(owner, tmp_path)['id']
    response = batch(owner, base_id, 'delete', ids)
    assert response.status_code == (409 if ids == [1, 9999] else 400)
    assert store.status(path_for(base_id))['game_count'] == 1


def test_move_delete_failure_keeps_durable_copies_and_originals(owner, tmp_path, synchronous, monkeypatch):
    source = create(owner, tmp_path, PGN + '\n' + PGN.replace('Alice', 'Carol'))['id']
    target = create(owner, tmp_path, PGN.replace('Alice', 'Zoe'))['id']
    before = {bid: store.status(path_for(bid)) for bid in (source, target)}
    original = actions._delete_game
    def fail_second(conn, schema, game_id, parsed):
        if game_id == 2:
            raise ValueError('Simulated write failure')
        return original(conn, schema, game_id, parsed)
    monkeypatch.setattr(actions, '_delete_game', fail_second)
    response = batch(owner, source, 'move', [1, 2], target_base_id=target)
    assert response.status_code == 409
    assert 'Les originaux sont conservés' in response.json()['detail']
    assert store.status(path_for(source)) == before[source]
    assert store.list_games(path_for(source))['total'] == 2
    assert store.search_position(path_for(source), chess.STARTING_FEN)['total'] == 2
    assert store.list_games(path_for(target))['total'] == 3
    assert store.search_position(path_for(target), chess.STARTING_FEN)['total'] == 3


def test_deleted_last_id_not_reused_by_resume_or_duplicate(owner, tmp_path, synchronous):
    base_id = create(owner, tmp_path, PGN + '\n' + PGN.replace('Alice', 'Carol'), max_games=1)['id']
    path = path_for(base_id)
    assert batch(owner, base_id, 'delete', [1]).status_code == 200
    assert owner.post(f'/api/reference-bases/{base_id}/resume', json={}).status_code == 200
    assert store.list_games(path)['entries'][0]['id'] == 2
    assert batch(owner, base_id, 'delete', [1]).status_code == 409
    assert batch(owner, base_id, 'duplicate', [2]).json()['game_ids'] == [3]
    assert batch(owner, base_id, 'delete', [3]).status_code == 200
    assert batch(owner, base_id, 'duplicate', [2]).json()['game_ids'] == [4]


def test_mutation_revision_prevents_reusing_filtered_results(owner, tmp_path, synchronous):
    base_id = create(owner, tmp_path, PGN + '\n' + PGN.replace('Alice', 'Carol'))['id']
    path = path_for(base_id)
    assert store.list_games(path, search='Alice')['total'] == 1
    assert batch(owner, base_id, 'delete', [1]).status_code == 200
    assert batch(owner, base_id, 'duplicate', [2]).status_code == 200
    assert store.list_games(path, search='Alice')['total'] == 0
    assert store.list_games(path, search='Carol')['total'] == 2
    assert store.status(path)['revision'] == 2


def test_active_import_blocks_mutation(owner, tmp_path, synchronous):
    base_id = create(owner, tmp_path)['id']
    class Active:
        def poll(self):
            return None
    key = (str(db.DB_PATH.resolve()), base_id)
    library._processes[key] = Active()
    try:
        assert batch(owner, base_id, 'delete', [1]).status_code == 409
    finally:
        library._processes.pop(key)
    with store._import_lock(path_for(base_id)):
        assert batch(owner, base_id, 'duplicate', [1]).status_code == 409
    assert store.status(path_for(base_id))['game_count'] == 1


def test_move_copy_failure_leaves_both_bases_unchanged(owner, tmp_path, synchronous, monkeypatch):
    source = create(owner, tmp_path, PGN + '\n' + PGN.replace('Alice', 'Carol'))['id']
    target = create(owner, tmp_path, PGN.replace('Alice', 'Zoe'))['id']
    before = {bid: store.status(path_for(bid)) for bid in (source, target)}
    original = actions._copy_game
    def fail_second(conn, source_schema, target_schema, game_id, parsed):
        if game_id == 2:
            raise ValueError('Simulated copy failure')
        return original(conn, source_schema, target_schema, game_id, parsed)
    monkeypatch.setattr(actions, '_copy_game', fail_second)
    assert batch(owner, source, 'move', [1, 2], target_base_id=target).status_code == 400
    for bid in (source, target):
        assert store.status(path_for(bid)) == before[bid]
        assert store.list_games(path_for(bid))['total'] == before[bid]['game_count']


def test_move_keeps_originals_if_destination_disappears_between_commits(owner, tmp_path, synchronous, monkeypatch):
    source = create(owner, tmp_path)['id']
    target = owner.post('/api/bases', json={'name': 'Étude'}).json()['id']
    before = store.status(path_for(source))
    original_commit = db.ManagedConnection.commit
    original_get_conn = db.get_conn
    interrupted = False
    def commit_then_remove_copy(conn):
        nonlocal interrupted
        original_commit(conn)
        if not interrupted:
            interrupted = True
            # Models another tab deleting the personal destination just after
            # durable copy, before the move reacquires the database write lock.
            with original_get_conn() as other:
                other.execute('DELETE FROM entries WHERE base_id=?', (target,))
    monkeypatch.setattr(db.ManagedConnection, 'commit', commit_then_remove_copy)
    response = batch(owner, source, 'move', [1], target_base_id=target)
    assert interrupted and response.status_code == 409
    assert 'Les originaux sont conservés' in response.json()['detail']
    assert store.status(path_for(source)) == before
    assert store.read_game(path_for(source), 1)['headers']['White'] == 'Alice'
