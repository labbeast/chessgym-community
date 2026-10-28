"""Ordered, resumable parallel imports use only temporary databases/files."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import time

import chess
import chess.pgn
import pytest

import pgnlib
import reference_parallel
import reference_store as store


def game(number):
    parsed = chess.pgn.Game()
    parsed.headers.update(Event='Parallel test', White=f'Player {number:03}', Black='Opponent',
                          Date='2026.10.21', Result='1-0', WhiteElo='1800', BlackElo='1850', TimeControl='600')
    node = parsed
    board = parsed.board()
    for uci in ('e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1b5'):
        move = chess.Move.from_uci(uci)
        node = node.add_variation(move)
        board.push(move)
    node.comment = 'Commentaire conservé [%clk 0:09:48]'
    return pgnlib.export_game(parsed)


def source(tmp_path, count=160, *, compressed=False, exceptional=False):
    games = [game(i) for i in range(count)]
    if exceptional:
        games.insert(3, '[Event "Illegal"]\n\n1. e4 e5 2. Bh6 *')
        games.insert(70, games[2].replace('1-0', '0-1'))
    content = ('\n\n'.join(games) + '\n\n').encode('utf-8')
    path = tmp_path / ('games.pgn.zst' if compressed else 'games.pgn')
    if compressed:
        zstandard = pytest.importorskip('zstandard')
        content = zstandard.ZstdCompressor().compress(content)
    path.write_bytes(content)
    return path


def snapshot(path):
    with closing(sqlite3.connect(path)) as conn:
        return {
            'games': conn.execute('SELECT * FROM games ORDER BY id').fetchall(),
            'positions': conn.execute('SELECT * FROM positions ORDER BY position_key,game_id').fetchall(),
            'checkpoint': json.loads(conn.execute("SELECT value FROM meta WHERE key='import'").fetchone()[0])['offset'],
        }


@pytest.mark.parametrize('compressed', [False, True])
def test_parallel_and_serial_produce_identical_rows_and_order(tmp_path, compressed):
    path = source(tmp_path, compressed=compressed, exceptional=True)
    serial, parallel = tmp_path / 'serial.sqlite3', tmp_path / 'parallel.sqlite3'
    first = store.import_file(serial, path, workers=1, batch_size=23)
    second = store.import_file(parallel, path, workers=2, batch_size=23)
    assert second['status'] == first['status'] == 'completed'
    for key in ('processed', 'imported', 'duplicates', 'rejected', 'indexed_positions', 'rejections'):
        assert second[key] == first[key]
    assert second['processed'] == 162 and second['imported'] == 160
    assert second['rejected'] == second['duplicates'] == 1
    assert second['workers'] == 2
    assert snapshot(parallel) == snapshot(serial)
    assert store.explorer_data(parallel, chess.STARTING_FEN) == store.explorer_data(serial, chess.STARTING_FEN)


@pytest.mark.parametrize('compressed', [False, True])
@pytest.mark.parametrize('before,after', [(1, 2), (2, 1)])
def test_limit_and_resume_can_change_worker_count_without_skipping_records(tmp_path, compressed, before, after):
    path = source(tmp_path, count=137, compressed=compressed)
    full, resumed = tmp_path / 'full.sqlite3', tmp_path / 'resumed.sqlite3'
    store.import_file(full, path, workers=1)
    first = store.import_file(resumed, path, workers=before, max_games=65, batch_size=20)
    assert first['status'] == 'paused' and first['limit_reached']
    assert first['processed'] == first['game_count'] == 65
    assert store.read_game(resumed, 65)['headers']['White'] == 'Player 064'
    second = store.import_file(resumed, path, workers=after)
    assert second['status'] == 'completed' and second['processed'] == 137
    assert second['duplicates'] == 0 and second['workers'] == after
    assert snapshot(resumed) == snapshot(full)


def test_parallel_writer_failure_rewinds_to_last_atomic_checkpoint(tmp_path, monkeypatch):
    path = source(tmp_path, count=85)
    db = tmp_path / 'reference.sqlite3'
    original = store._insert_prepared
    calls = 0

    def fail_after_committed_batch(conn, prepared):
        nonlocal calls
        calls += 1
        if calls == 30:
            raise sqlite3.OperationalError('simulated full disk')
        return original(conn, prepared)

    monkeypatch.setattr(store, '_insert_prepared', fail_after_committed_batch)
    failed = store.import_file(db, path, workers=2, batch_size=20)
    assert failed['status'] == 'failed'
    assert failed['processed'] == failed['game_count'] == 20
    assert store.list_games(db)['total'] == 20
    monkeypatch.setattr(store, '_insert_prepared', original)
    resumed = store.import_file(db, path, workers=2, batch_size=20)
    assert resumed['status'] == 'completed'
    assert resumed['game_count'] == resumed['processed'] == 85 and resumed['duplicates'] == 0
    expected = tmp_path / 'expected.sqlite3'
    store.import_file(expected, path)
    assert snapshot(db) == snapshot(expected)


def _slow_batch(batch, encoding):
    Path(os.environ['CHESSGYM_PARALLEL_TEST_MARKER']).write_text(str(os.getpid()), encoding='ascii')
    time.sleep(20)
    return reference_parallel.prepare_batch(batch, encoding)


def _crashing_batch(batch, encoding):
    os._exit(42)


def _out_of_order_batch(batch, encoding):
    if b'Player 000' in batch[0][0]:
        time.sleep(0.7)
    return reference_parallel.prepare_batch(batch, encoding)


def test_later_batch_finishes_first_but_game_ids_keep_source_order(tmp_path, monkeypatch):
    path = source(tmp_path, count=150)
    serial, parallel = tmp_path / 'serial.sqlite3', tmp_path / 'parallel.sqlite3'
    store.import_file(serial, path, workers=1)
    monkeypatch.setattr(reference_parallel, 'prepare_batch', _out_of_order_batch)
    report = store.import_file(parallel, path, workers=2, batch_size=17)
    assert report['status'] == 'completed'
    assert snapshot(parallel) == snapshot(serial)


def test_cancel_mid_batch_keeps_written_prefix_and_replays_prefetch(tmp_path, monkeypatch):
    path = source(tmp_path, count=150)
    db = tmp_path / 'reference.sqlite3'
    original = store._insert_prepared
    inserted = 0

    def write(conn, prepared):
        nonlocal inserted
        result = original(conn, prepared)
        inserted += 1
        return result

    monkeypatch.setattr(store, '_insert_prepared', write)
    paused = store.import_file(db, path, workers=2, batch_size=20, cancelled=lambda: inserted >= 29)
    assert paused['status'] == 'paused' and paused['processed'] == paused['game_count'] == 29
    assert store.read_game(db, 29)['headers']['White'] == 'Player 028'
    monkeypatch.setattr(store, '_insert_prepared', original)
    resumed = store.import_file(db, path, workers=2)
    assert resumed['processed'] == resumed['game_count'] == 150 and resumed['duplicates'] == 0
    full = tmp_path / 'full.sqlite3'
    store.import_file(full, path, workers=1)
    assert snapshot(db) == snapshot(full)


def test_cancel_interrupts_wait_for_a_busy_parser_without_advancing_checkpoint(tmp_path, monkeypatch):
    path = source(tmp_path, count=40)
    marker = tmp_path / 'parser-started.txt'
    monkeypatch.setenv('CHESSGYM_PARALLEL_TEST_MARKER', str(marker))
    monkeypatch.setattr(reference_parallel, 'prepare_batch', _slow_batch)
    started = time.monotonic()
    report = store.import_file(tmp_path / 'reference.sqlite3', path, workers=2, cancelled=marker.exists)
    assert marker.exists()
    assert time.monotonic() - started < 10
    assert report['status'] == 'paused' and report['processed'] == report['game_count'] == 0
    assert not report['limit_reached']
    assert snapshot(tmp_path / 'reference.sqlite3')['checkpoint'] == 0


def test_abrupt_parser_death_fails_cleanly_instead_of_waiting_forever(tmp_path, monkeypatch):
    path = source(tmp_path, count=40)
    monkeypatch.setattr(reference_parallel, 'prepare_batch', _crashing_batch)
    started = time.monotonic()
    db = tmp_path / 'reference.sqlite3'
    report = store.import_file(db, path, workers=2)
    assert time.monotonic() - started < 10
    assert report['status'] == 'failed' and 'interrompu' in report['error']
    assert report['processed'] == report['game_count'] == 0
    assert store.import_file(db, path, workers=1)['game_count'] == 40


def test_legacy_encoding_is_prepared_consistently_in_child_processes(tmp_path):
    path = tmp_path / 'legacy.pgn'
    path.write_bytes((game(0).replace('Player 000', 'André') + '\n\n').encode('cp1252'))
    db = tmp_path / 'reference.sqlite3'
    result = store.import_file(db, path, workers=2, encoding='cp1252')
    assert result['status'] == 'completed' and result['imported'] == 1
    assert store.read_game(db, 1)['headers']['White'] == 'André'
    assert 'Commentaire conservé' in store.read_game(db, 1)['pgn']


@pytest.mark.parametrize('workers', [0, -1, 17, True, '4', None])
def test_invalid_worker_counts_are_rejected_before_creating_a_store(tmp_path, workers):
    path = source(tmp_path, count=1)
    db = tmp_path / 'invalid.sqlite3'
    with pytest.raises(ValueError, match='processus'):
        store.import_file(db, path, workers=workers)
    assert not db.exists()
