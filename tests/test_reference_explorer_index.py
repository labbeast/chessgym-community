"""The compact explorer index must preserve exact statistics and stored PGNs."""
import sqlite3
from contextlib import closing

import chess
import pytest

import reference_queries
import reference_store as store
from test_reference_store import pgn, source, after


def test_covering_index_preserves_statistics_filters_and_original_games(tmp_path):
    path = tmp_path / 'reference.sqlite3'
    store.import_file(path, source(tmp_path,
        pgn(['e2e4', 'e7e5'], result='1-0', WhiteElo='1900', BlackElo='1850', TimeControl='600'),
        pgn(['e2e4', 'c7c5'], white='C', result='0-1', WhiteElo='1700', BlackElo='1800'),
        pgn(['d2d4'], white='D', result='1/2-1/2', WhiteElo='2100', BlackElo='2200', TimeControl='1800')))
    profiles = [{}, {'rating_min': 1800}, {'rating_max': 1900},
                {'speeds': ['unknown']}, {'speeds': ['rapid', 'classical']},
                {'from_year': 2025, 'to_year': 2026}]
    positions = [chess.STARTING_FEN, after('e2e4'), after('d2d4')]
    before = [store.explorer_data(path, fen, **filters) for fen in positions for filters in profiles]
    originals = [store.read_game(path, i)['pgn'] for i in range(1, 4)]
    assert store.prepare_explorer_index(path)
    assert store.prepare_explorer_index(path)
    assert before == [store.explorer_data(path, fen, **filters) for fen in positions for filters in profiles]
    assert originals == [store.read_game(path, i)['pgn'] for i in range(1, 4)]
    with closing(sqlite3.connect(path)) as conn:
        plan = conn.execute('''EXPLAIN QUERY PLAN SELECT p.next_move,g.outcome,
            count(*),sum(g.white_elo),count(g.white_elo)
            FROM positions p JOIN games g INDEXED BY games_explorer ON g.id=p.game_id
            WHERE p.position_key=? GROUP BY p.next_move,g.outcome''',
            (store.position_key(chess.Board()),)).fetchall()
    assert any('COVERING INDEX games_explorer' in row[-1] for row in plan)


@pytest.mark.parametrize('state', ['running', 'paused', 'failed'])
def test_index_preparation_does_not_change_unfinished_archive(tmp_path, state):
    path = tmp_path / 'reference.sqlite3'
    store.init_store(path)
    with store._connect(path) as conn:
        store._set_meta(conn, 'import', {'status': state})
    assert store.prepare_explorer_index(path) is False
    with store._connect(path, readonly=True) as conn:
        assert not store._has_explorer_index(conn)


def test_index_preparation_respects_import_lock(tmp_path):
    path = tmp_path / 'reference.sqlite3'
    store.import_file(path, source(tmp_path, pgn(['e2e4'])))
    with store._import_lock(path), pytest.raises(ValueError, match='import'):
        store.prepare_explorer_index(path)


def test_index_preparation_can_be_cancelled_without_partial_index(tmp_path):
    path = tmp_path / 'reference.sqlite3'
    store.import_file(path, source(tmp_path, pgn(['e2e4'])))
    guard = reference_queries.Guard(10)
    guard.cancel()
    with reference_queries.scope(guard), pytest.raises((sqlite3.OperationalError, reference_queries.QueryStopped)):
        store.prepare_explorer_index(path)
    with store._connect(path, readonly=True) as conn:
        assert not store._has_explorer_index(conn)


def test_cancellation_during_create_index_rolls_back_derived_index(tmp_path, monkeypatch):
    path = tmp_path / 'reference.sqlite3'
    store.import_file(path, source(tmp_path, pgn(['e2e4'])))
    # Enough metadata rows to enter SQLite's progress callback during sorting.
    with store._connect(path) as conn:
        conn.execute('''WITH RECURSIVE n(id) AS (VALUES(2) UNION ALL SELECT id+1 FROM n WHERE id<1000)
            INSERT INTO games SELECT n.id,g.identity,g.identity_payload,g.title,g.headers,g.pgn,
                g.white,g.black,g.event,g.date,g.year,g.white_elo,g.black_elo,g.speed,g.outcome,g.plies
            FROM n CROSS JOIN games g WHERE g.id=1''')
    original_attach = reference_queries.attach
    guard = reference_queries.Guard(10)
    building = []
    def attach(conn):
        attached = original_attach(conn)
        def trace(statement):
            if statement.startswith('CREATE INDEX IF NOT EXISTS games_explorer'):
                building.append(True)
                guard.cancel('shutdown')
        conn.set_trace_callback(trace)
        return attached
    monkeypatch.setattr(reference_queries, 'attach', attach)
    with reference_queries.scope(guard), pytest.raises(sqlite3.OperationalError, match='interrupted'):
        store.prepare_explorer_index(path)
    assert building and not guard.connections
    with store._connect(path, readonly=True) as conn:
        assert not store._has_explorer_index(conn)
        assert conn.execute('SELECT count(*) FROM games').fetchone()[0] == 1000
