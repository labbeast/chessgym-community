"""Import phases describe committed work and never change checkpoint semantics."""
import copy
import json
import time
from types import SimpleNamespace

import pytest

import db
import reference_library as library
import reference_phase as phase
import reference_store as store

PGN = '[Event "Test"]\n[White "Alice"]\n\n1. e4 e5 *\n\n'


def source(tmp_path):
    path = tmp_path / 'source.pgn'
    path.write_text(PGN + PGN.replace('Alice', 'Bob'), encoding='utf-8')
    return path


def test_phases_report_only_committed_prefix(tmp_path):
    events = []
    path = tmp_path / 'store.sqlite3'
    result = store.import_file(path, source(tmp_path), batch_size=1,
        phase=lambda name, snapshot: events.append((name, copy.deepcopy(snapshot))))
    assert result['processed'] == result['game_count'] == 2
    assert events[0] == ('preparing', None)
    committing = [snapshot for name, snapshot in events if name == 'committing']
    assert [snapshot['processed'] for snapshot in committing] == [0, 1, 2]
    assert all(snapshot['game_count'] == snapshot['processed'] for snapshot in committing)
    assert events[-1][0] == 'finalizing' and events[-1][1]['status'] == 'completed'


def test_failure_does_not_publish_uncommitted_counters(tmp_path, monkeypatch):
    real = store._insert_game
    calls = 0
    def insert(conn, parsed, raw):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError('isolated writer failure')
        return real(conn, parsed, raw)
    monkeypatch.setattr(store, '_insert_game', insert)
    events = []
    result = store.import_file(tmp_path / 'store.sqlite3', source(tmp_path), batch_size=1,
        phase=lambda name, snapshot: events.append((name, copy.deepcopy(snapshot))))
    assert result['status'] == 'failed' and result['game_count'] == 1
    assert events[-1][1]['game_count'] == events[-1][1]['processed'] == 1
    assert events[-1][1]['status'] == 'failed'


def test_diagnostic_error_cannot_break_import(tmp_path):
    def broken(*args):
        raise OSError('diagnostic unavailable')
    assert store.import_file(tmp_path / 'store.sqlite3', source(tmp_path), phase=broken)['status'] == 'completed'


def test_compressed_resume_distinguishes_replay_from_new_work(tmp_path):
    import zstandard
    raw = source(tmp_path)
    compressed = tmp_path / 'source.pgn.zst'
    compressed.write_bytes(zstandard.ZstdCompressor().compress(raw.read_bytes()))
    target = tmp_path / 'store.sqlite3'
    assert store.import_file(target, compressed, max_games=1)['processed'] == 1
    events = []
    result = store.import_file(target, compressed, phase=lambda name, snapshot: events.append(name))
    assert result['game_count'] == 2 and 'replaying' in events
    assert events.index('replaying') < len(events) - 1


def test_sidecar_is_bounded_atomic_and_run_scoped(tmp_path):
    target, src = tmp_path / 'store.sqlite3', source(tmp_path)
    started = time.time_ns()
    publisher = phase.Publisher(target, 'run-1', src)
    assert publisher.publish('committing', {'processed': 1, 'game_count': 1, 'status': 'importing', 'offset': 400, 'fingerprint': ['secret']})
    found = phase.read(target, 'run-1', src, started)
    assert found['phase'] == 'committing' and found['snapshot']['processed'] == 1
    assert 'offset' not in found['snapshot'] and 'fingerprint' not in found['snapshot']
    assert phase.read(target, 'run-2', src, started) is None
    assert phase.read(target, 'run-1', tmp_path / 'other.pgn', started) is None
    assert phase.read(target, 'run-1', src, time.time_ns() + 1_000_000) is None
    assert not list(tmp_path.glob('*.tmp'))
    phase.phase_path(target).write_text('{truncated', encoding='utf-8')
    assert phase.read(target, 'run-1', src) is None
    phase.phase_path(target).write_bytes(b'x' * (phase.MAX_BYTES + 1))
    assert phase.read(target, 'run-1', src) is None


@pytest.fixture
def running(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'personal.sqlite3')
    row = {'base_id': 17, 'storage_key': 'a' * 32, 'source': str(source(tmp_path)), 'max_games': None, 'encoding': 'utf-8-sig'}
    path = library.store_path(row['storage_key'])
    path.parent.mkdir(parents=True)
    path.touch()
    process = SimpleNamespace(_chessgym_run_id='current-run', _chessgym_started_ns=time.time_ns(), poll=lambda: None)
    key = (str(db.DB_PATH.resolve()), row['base_id'])
    monkeypatch.setitem(library._processes, key, process)
    return row, path, process


def test_live_finalization_uses_committed_sidecar_without_sqlite_read(running, monkeypatch):
    row, path, process = running
    publisher = phase.Publisher(path, process._chessgym_run_id, row['source'])
    publisher.publish('finalizing', {'status': 'completed', 'processed': 2, 'game_count': 2, 'bytes_read': 100, 'total_bytes': 100})
    def blocked(*args):
        raise AssertionError('Do not wait on SQLite during finalization')
    monkeypatch.setattr(store, 'status', blocked)
    status = library.status_for(row)
    assert status['status'] == 'running' and status['worker_active']
    assert status['phase'] == 'finalizing' and status['phase_tracked']
    assert status['bytes_read'] == status['total_bytes'] == 100
    path.with_suffix('.cancel').write_text('pause')
    assert library.status_for(row)['pause_requested'] is True
    monkeypatch.setattr(store, 'status', lambda _: {'status': 'completed', 'game_count': 2})
    process.poll = lambda: 0
    final = library.status_for(row)
    assert final['status'] == 'completed' and not final['worker_active'] and final['phase'] is None


def test_legacy_worker_and_stale_sidecar_use_honest_fallback(running, monkeypatch):
    row, path, process = running
    phase.Publisher(path, 'old-run', row['source']).publish('finalizing', {'status': 'completed', 'game_count': 999})
    monkeypatch.setattr(store, 'status', lambda _: {'status': 'importing', 'game_count': 7})
    status = library.status_for(row)
    assert status['game_count'] == 7 and status['phase'] == 'processing' and not status['phase_tracked']
    del process._chessgym_run_id
    path.with_suffix('.cancel').write_text('pause')
    status = library.status_for(row)
    assert status['phase'] == 'stopping' and status['pause_requested'] and status['status'] == 'running'


def test_uncommitted_rejection_does_not_mutate_previous_snapshot(tmp_path):
    path = source(tmp_path)
    path.write_text(PGN + PGN.replace('e4 e5', 'Z0 e5'), encoding='utf-8')
    events = []
    result = store.import_file(tmp_path / 'store.sqlite3', path, batch_size=1,
        phase=lambda name, snapshot: events.append((name, copy.deepcopy(snapshot))))
    assert result['processed'] == 2 and result['rejected'] == 1
    committing = [snapshot for name, snapshot in events if name == 'committing']
    assert committing[1]['rejected'] == 0 and committing[1]['rejections'] == []
