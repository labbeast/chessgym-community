"""Cheap exact frequencies while a huge reference is still being imported."""
import chess
import pytest

import db
import explorer
import explorer_local
import reference_library
import reference_queries
import reference_store as store
from test_reference_store import pgn, source, after


@pytest.fixture
def archive(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'study.sqlite3')
    monkeypatch.setattr(store, 'IMPORT_FREQUENCY_THRESHOLD', 0)
    db.init_db()
    reference_queries.clear_cache()
    explorer_local.clear_cache()
    path = reference_library.store_path('1' * 32)
    games = [pgn(['e2e4', 'e7e5'], white='A', result='1-0', WhiteElo='1800', BlackElo='1900', TimeControl='600'),
             pgn(['e2e4', 'c7c5'], white='B', result='0-1', WhiteElo='1700', BlackElo='1800', TimeControl='180'),
             pgn(['d2d4'], white='C', result='1/2-1/2', WhiteElo='1800', BlackElo='1900', TimeControl='600'),
             pgn([], white='Empty')]
    imported = source(tmp_path, *games)
    store.import_file(path, imported)
    set_status(path, 'running')
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(1,'Lichess','today')")
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source,status) VALUES(?,?,?,?)',
                     (1, '1' * 32, str(imported), 'running'))
    yield path, games
    reference_queries.clear_cache()
    explorer_local.clear_cache()


def set_status(path, status):
    with store._connect(path) as conn:
        state = store._get_meta(conn, 'import')
        store._set_meta(conn, 'import', {**state, 'status': status})


def test_fast_path_counts_exact_frequencies_not_terminal_games_or_fake_unknowns(archive):
    path, _ = archive
    result = store.explorer_data(path, chess.STARTING_FEN, allow_import_frequencies=True)
    assert result['status'] == 'ok' and result['complete'] is False and result['results_available'] is False
    assert result['game_count'] == 4 and result['total'] == 3 and result['terminal_count'] == 1
    assert {row['uci']: row['total'] for row in result['moves']} == {'e2e4': 2, 'd2d4': 1}
    assert result['unknown'] == 0 and all(row['unknown'] == 0 for row in result['moves'])
    assert all(row['results_available'] is False for row in result['moves'])
    terminal = store.explorer_data(path, after('d2d4'), allow_import_frequencies=True)
    assert terminal['total'] == 0 and terminal['terminal_count'] == 1 and terminal['moves'] == []


def test_fast_frequency_path_does_not_read_game_rows(archive, monkeypatch):
    path, _ = archive
    original = store._import_frequency_rows
    def guarded(conn, *args):
        # Deny any access to the large games table once frequency counting starts.
        import sqlite3
        conn.set_authorizer(lambda action, name, *_: sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and name == 'games' else sqlite3.SQLITE_OK)
        return original(conn, *args)
    monkeypatch.setattr(store, '_import_frequency_rows', guarded)
    assert store.explorer_data(path, chess.STARTING_FEN, allow_import_frequencies=True)['total'] == 3


@pytest.mark.parametrize('filters', [{'rating_min': 1800}, {'rating_max': 1800}, {'speeds': ['rapid']}, {'from_year': 2020}])
def test_filters_never_use_unfiltered_frequency_counts(archive, monkeypatch, filters):
    path, _ = archive
    monkeypatch.setattr(store, '_import_frequency_rows', lambda *a: pytest.fail('Filters must use full statistics'))
    result = store.explorer_data(path, chess.STARTING_FEN, allow_import_frequencies=True, **filters)
    assert result.get('results_available', True) is True
    assert result['total'] == result['white'] + result['draws'] + result['black'] + result['unknown']


def test_multiple_archives_and_study_duplicates_keep_full_deduplication(archive, tmp_path, monkeypatch):
    path, games = archive
    second = tmp_path / 'second.sqlite3'
    store.import_file(second, source(tmp_path, games[0], name='second.pgn'))
    monkeypatch.setattr(store, '_import_frequency_rows', lambda *a: pytest.fail('Deduplication must not be skipped'))
    result = store.explorer_data_many([path, second], chess.STARTING_FEN, allow_import_frequencies=True)
    assert result['total'] == 3 and result['duplicates'] == 1 and result['white'] == 1
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(2,'Study','today')")
        conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)', (2, 'Copy', games[0], 'today', 'today'))
    result = explorer_local.local_data(chess.STARTING_FEN, [1, 2])
    assert result['total'] == 3 and result['white'] == 1


def test_frequencies_reach_combiner_cache_and_completed_import_recovers_results(archive):
    path, _ = archive
    result = explorer_local.local_data(chess.STARTING_FEN, [1])
    assert result['results_available'] is False and result['complete'] is False
    missing = {'status': 'ok', 'total': 1, 'moves': [{'uci': 'c2c4', 'total': 1}]}
    moves = explorer.combine_moves(chess.Board(), result, missing)
    by_move = {row['uci']: row for row in moves}
    assert by_move['e2e4']['frequency'] == pytest.approx(200 / 3)
    assert by_move['e2e4']['results_available'] is False
    assert by_move['c2c4']['frequency'] is None
    cached = explorer_local.local_data(chess.STARTING_FEN, [1])
    assert cached['cached'] and cached['results_available'] is False
    assert 'Fréquences exactes' in cached['message']
    # An unfinished archive never writes a durable aggregate snapshot.
    cache_file = db.DB_PATH.with_name('reference-query-cache.sqlite3')
    if cache_file.exists():
        import sqlite3
        with sqlite3.connect(cache_file) as conn:
            table = conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone()
            if table:
                assert conn.execute('SELECT count(*) FROM "' + table[0] + '"').fetchone()[0] == 0
    set_status(path, 'completed')
    reference_queries.clear_cache()
    complete = explorer_local.local_data(chess.STARTING_FEN, [1])
    assert complete.get('results_available', True) is True and complete['complete']
    assert complete['total'] == 3 and complete['white'] == complete['draws'] == complete['black'] == 1


def test_small_positions_and_existing_covering_index_keep_full_results(archive, monkeypatch):
    path, _ = archive
    monkeypatch.setattr(store, 'IMPORT_FREQUENCY_THRESHOLD', 10)
    result = store.explorer_data(path, chess.STARTING_FEN, allow_import_frequencies=True)
    assert result['white'] == 1 and result.get('results_available', True)
    monkeypatch.setattr(store, 'IMPORT_FREQUENCY_THRESHOLD', 0)
    with store._connect(path) as conn:
        conn.execute('CREATE INDEX games_explorer ON games(id,outcome,white_elo,black_elo,speed,year)')
    result = store.explorer_data(path, chess.STARTING_FEN, allow_import_frequencies=True)
    assert result['black'] == 1 and result.get('results_available', True)
