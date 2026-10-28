"""Sorted position writes retain the original PGN order and atomic checkpoints."""
from contextlib import closing
import json
import sqlite3
import sys

import chess
import pytest

import reference_store as store
import reference_worker as worker


def game(number):
    return f'''[Event "Sorted test {number}"]
[White "Player {number:03}"]
[Black "Opponent"]
[Date "2026.10.22"]
[Result "1-0"]
[WhiteElo "1800"]
[BlackElo "1900"]
[TimeControl "600"]

1. e4 {{Note conservée [%clk 0:09:59]}} (1. d4 d5 2. c4) e5 2. Nf3 $1 Nc6 3. Bb5 a6 1-0
'''


def source(tmp_path, count=12, *, compressed=False, exceptional=False):
    games = [game(i) for i in range(count)]
    if exceptional:
        # Same semantic game, including a duplicate within the first batch.
        games.insert(1, games[0].replace('1-0', '0-1'))
        games.insert(4, '[Event "Illegal"]\n\n1. e4 e5 2. Bh6 *')
    content = ('\n'.join(games) + '\n').encode('utf-8')
    path = tmp_path / ('source.pgn.zst' if compressed else 'source.pgn')
    if compressed:
        content = pytest.importorskip('zstandard').ZstdCompressor().compress(content)
    path.write_bytes(content)
    return path


def snapshot(path):
    with closing(sqlite3.connect(path)) as conn:
        state = json.loads(conn.execute("SELECT value FROM meta WHERE key='import'").fetchone()[0])
        return {
            'games': conn.execute('SELECT * FROM games ORDER BY id').fetchall(),
            'positions': conn.execute('SELECT * FROM positions ORDER BY position_key,game_id').fetchall(),
            'totals': json.loads(conn.execute("SELECT value FROM meta WHERE key='totals'").fetchone()[0]),
            'offset': state['offset'],
        }


@pytest.mark.parametrize('workers,compressed', [(1, False), (2, False), (2, True)])
def test_sorted_and_original_modes_have_identical_rows(tmp_path, workers, compressed):
    path = source(tmp_path, compressed=compressed, exceptional=True)
    original, sorted_db = tmp_path / 'original.sqlite3', tmp_path / 'sorted.sqlite3'
    expected = store.import_file(original, path, batch_size=5)
    result = store.import_file(sorted_db, path, batch_size=5, workers=workers, sort_positions=True)
    assert expected['status'] == result['status'] == 'completed'
    for field in ('processed', 'imported', 'duplicates', 'rejected', 'indexed_positions', 'rejections'):
        assert result[field] == expected[field]
    assert result['imported'] == 12 and result['duplicates'] == result['rejected'] == 1
    assert result['sort_positions'] is True and expected['sort_positions'] is False
    assert snapshot(sorted_db) == snapshot(original)
    assert store.explorer_data(sorted_db, chess.STARTING_FEN) == store.explorer_data(original, chess.STARTING_FEN)
    assert 'Note conservée' in store.read_game(sorted_db, 1)['pgn']
    assert '(1. d4 d5 2. c4)' in store.read_game(sorted_db, 1)['pgn']


@pytest.mark.parametrize('before,after,compressed', [(False, True, False), (True, False, False),
                                                   (False, True, True), (True, False, True)])
def test_limited_partial_batch_can_resume_in_other_mode(tmp_path, before, after, compressed):
    path = source(tmp_path, compressed=compressed, exceptional=True)
    actual, expected = tmp_path / 'actual.sqlite3', tmp_path / 'expected.sqlite3'
    store.import_file(expected, path)
    paused = store.import_file(actual, path, sort_positions=before, max_games=7, batch_size=5)
    assert paused['status'] == 'paused' and paused['limit_reached'] and paused['processed'] == 7
    assert paused['game_count'] == 5 and paused['duplicates'] == paused['rejected'] == 1
    resumed = store.import_file(actual, path, sort_positions=after, workers=2, batch_size=5)
    assert resumed['status'] == 'completed' and resumed['processed'] == 14
    assert resumed['sort_positions'] is after
    assert snapshot(actual) == snapshot(expected)


def test_cancel_commits_all_buffered_positions_for_the_exact_prefix(tmp_path, monkeypatch):
    path = source(tmp_path)
    actual, expected = tmp_path / 'actual.sqlite3', tmp_path / 'expected.sqlite3'
    original = store._insert_prepared
    inserted = 0

    def insert(conn, prepared, **kwargs):
        nonlocal inserted
        result = original(conn, prepared, **kwargs)
        inserted += int(result)
        return result

    monkeypatch.setattr(store, '_insert_prepared', insert)
    paused = store.import_file(actual, path, sort_positions=True, workers=2, batch_size=5,
                               cancelled=lambda: inserted >= 7)
    assert paused['status'] == 'paused' and paused['processed'] == paused['imported'] == 7
    state = snapshot(actual)
    assert len(state['games']) == 7 and len(state['positions']) == paused['indexed_positions'] == 49
    monkeypatch.setattr(store, '_insert_prepared', original)
    resumed = store.import_file(actual, path, sort_positions=False)
    assert resumed['status'] == 'completed' and resumed['duplicates'] == 0
    store.import_file(expected, path)
    assert snapshot(actual) == snapshot(expected)


def test_partial_executemany_failure_rolls_back_entire_batch_and_clears_buffer(tmp_path, monkeypatch):
    path = source(tmp_path, count=8)
    actual, expected = tmp_path / 'actual.sqlite3', tmp_path / 'expected.sqlite3'
    original = store._SortedPositionBuffer.flush
    flushes, failed_buffer = 0, None

    def fail_second_flush(self):
        nonlocal flushes, failed_buffer
        if self.rows:
            flushes += 1
            if flushes == 2:
                self.rows.sort()
                self.conn.executemany(store.POSITION_INSERT_SQL, self.rows[:3])
                failed_buffer = self
                raise sqlite3.OperationalError('simulated partial position write')
        return original(self)

    monkeypatch.setattr(store._SortedPositionBuffer, 'flush', fail_second_flush)
    failed = store.import_file(actual, path, batch_size=2, sort_positions=True)
    assert failed['status'] == 'failed' and 'partial position write' in failed['error']
    assert failed['processed'] == failed['imported'] == failed['game_count'] == 2
    assert len(snapshot(actual)['positions']) == failed['indexed_positions'] == 14
    assert failed_buffer.rows == [] and failed_buffer.byte_size == 0
    monkeypatch.setattr(store._SortedPositionBuffer, 'flush', original)
    resumed = store.import_file(actual, path, sort_positions=True)
    assert resumed['status'] == 'completed' and resumed['duplicates'] == 0
    store.import_file(expected, path)
    assert snapshot(actual) == snapshot(expected)


@pytest.mark.parametrize('bound', ['rows', 'bytes'])
def test_buffer_bounds_apply_within_one_game_and_all_plies_survive(tmp_path, monkeypatch, bound):
    path = source(tmp_path, count=3)
    actual, expected = tmp_path / 'actual.sqlite3', tmp_path / 'expected.sqlite3'
    if bound == 'rows':
        monkeypatch.setattr(store, 'MAX_SORTED_POSITION_ROWS', 3)
    else:
        monkeypatch.setattr(store, 'MAX_SORTED_POSITION_BYTES', 900)
    original = store._SortedPositionBuffer.flush
    observed = []

    def observe(self):
        if self.rows:
            observed.append((len(self.rows), self.byte_size))
            assert len(self.rows) <= store.MAX_SORTED_POSITION_ROWS
            assert self.byte_size <= store.MAX_SORTED_POSITION_BYTES
        return original(self)

    monkeypatch.setattr(store._SortedPositionBuffer, 'flush', observe)
    result = store.import_file(actual, path, sort_positions=True, batch_size=250)
    assert result['status'] == 'completed' and result['indexed_positions'] == 21
    assert len(observed) >= 7, 'Even a single game must split into bounded sorted chunks.'
    store.import_file(expected, path)
    assert snapshot(actual) == snapshot(expected)


def test_buffer_flushes_in_exact_primary_key_order():
    class Connection:
        def executemany(self, sql, rows):
            self.rows = list(rows)
            assert sql == store.POSITION_INSERT_SQL
    conn = Connection()
    buffer = store._SortedPositionBuffer(conn)
    buffer.add(1, [(b'z', 0, 3, 'c4'), (b'a', 1, 2, 'e5')])
    buffer.add(2, [(b'a', 0, 1, 'e4'), (b'm', 1, None, '')])
    buffer.flush()
    assert [(row[0], row[1]) for row in conn.rows] == [(b'a', 1), (b'a', 2), (b'm', 2), (b'z', 1)]
    assert buffer.rows == [] and buffer.byte_size == 0


def test_flush_error_during_cancel_reader_cleanup_is_failed_not_partially_paused(tmp_path, monkeypatch):
    path = source(tmp_path, count=3)
    original_records = store._record_stream
    original_flush = store._SortedPositionBuffer.flush
    actual = tmp_path / 'actual.sqlite3'

    def interrupted(*args, **kwargs):
        records = original_records(*args, **kwargs)
        yield next(records)
        raise store._ImportCancelled()

    def broken(self):
        if self.rows:
            self.conn.executemany(store.POSITION_INSERT_SQL, self.rows[:1])
            raise sqlite3.OperationalError('cancel flush failed')
        return original_flush(self)

    monkeypatch.setattr(store, '_record_stream', interrupted)
    monkeypatch.setattr(store._SortedPositionBuffer, 'flush', broken)
    result = store.import_file(actual, path, sort_positions=True)
    assert result['status'] == 'failed' and result['processed'] == result['imported'] == 0
    assert snapshot(actual)['games'] == snapshot(actual)['positions'] == []
    monkeypatch.setattr(store, '_record_stream', original_records)
    monkeypatch.setattr(store._SortedPositionBuffer, 'flush', original_flush)
    resumed = store.import_file(actual, path, sort_positions=True)
    assert resumed['status'] == 'completed' and resumed['imported'] == 3


@pytest.mark.parametrize('value', [None, 0, 1, 'true', []])
def test_invalid_sort_flag_does_not_create_store(tmp_path, value):
    with pytest.raises(ValueError, match='tri'):
        store.import_file(tmp_path / 'absent.sqlite3', tmp_path / 'absent.pgn', sort_positions=value)
    assert not (tmp_path / 'absent.sqlite3').exists()


@pytest.mark.parametrize('value,expected', [(None, False), ('', False), ('0', False), ('1', True), (' 1 ', True)])
def test_worker_sort_environment_defaults_off(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv('CHESSGYM_IMPORT_SORT_POSITIONS', raising=False)
    else:
        monkeypatch.setenv('CHESSGYM_IMPORT_SORT_POSITIONS', value)
    assert worker.default_sort_positions() is expected


@pytest.mark.parametrize('value', ['yes', 'true', '2', '١'])
def test_worker_rejects_invalid_sort_environment(monkeypatch, value):
    monkeypatch.setenv('CHESSGYM_IMPORT_SORT_POSITIONS', value)
    with pytest.raises(ValueError, match='CHESSGYM_IMPORT_SORT_POSITIONS'):
        worker.default_sort_positions()


@pytest.mark.parametrize('env,arguments,expected', [('0', [], False), ('1', [], True),
    ('0', ['--sort-positions'], True), ('1', ['--no-sort-positions'], False)])
def test_worker_cli_forwards_explicit_sort_mode(tmp_path, monkeypatch, env, arguments, expected):
    captured = {}
    monkeypatch.setenv('CHESSGYM_IMPORT_SORT_POSITIONS', env)
    monkeypatch.setattr(worker.reference_store, 'import_file',
        lambda *args, **kwargs: captured.update(kwargs) or {'status': 'paused'})
    monkeypatch.setattr(sys, 'argv', ['reference_worker.py', '--store', str(tmp_path / 'reference.sqlite3'),
        '--source', str(tmp_path / 'source.pgn'), '--cancel', str(tmp_path / 'cancel'), '--workers', '1', *arguments])
    worker.main()
    assert captured['sort_positions'] is expected
