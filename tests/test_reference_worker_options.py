"""The application selects bounded CPU parallelism without altering PGN choices."""
import sys

import pytest

import reference_worker as worker


@pytest.mark.parametrize('cpus,expected', [(None, 1), (1, 1), (2, 1), (4, 2), (8, 4), (16, 4)])
def test_auto_workers_reserve_capacity_and_cap_memory(monkeypatch, cpus, expected):
    monkeypatch.delenv('CHESSGYM_IMPORT_WORKERS', raising=False)
    monkeypatch.setattr(worker.os, 'cpu_count', lambda: cpus)
    monkeypatch.delattr(worker.os, 'sched_getaffinity', raising=False)
    assert worker.default_import_workers() == expected


def test_auto_workers_respect_cpu_affinity(monkeypatch):
    monkeypatch.setenv('CHESSGYM_IMPORT_WORKERS', 'auto')
    monkeypatch.setattr(worker.os, 'cpu_count', lambda: 16)
    monkeypatch.setattr(worker.os, 'sched_getaffinity', lambda pid: {0, 1, 2, 3}, raising=False)
    assert worker.default_import_workers() == 2


@pytest.mark.parametrize('value,expected', [('1', 1), ('4', 4), ('16', 16), (' 6 ', 6)])
def test_worker_override_is_explicit(monkeypatch, value, expected):
    monkeypatch.setenv('CHESSGYM_IMPORT_WORKERS', value)
    assert worker.default_import_workers() == expected


@pytest.mark.parametrize('value', ['0', '-1', '17', '1.5', 'true', 'many', '٤'])
def test_invalid_worker_override_is_rejected(monkeypatch, value):
    monkeypatch.setenv('CHESSGYM_IMPORT_WORKERS', value)
    with pytest.raises(ValueError, match='CHESSGYM_IMPORT_WORKERS'):
        worker.default_import_workers()


@pytest.mark.parametrize('arguments,expected', [([], 4), (['--workers', '2'], 2)])
def test_worker_cli_passes_parallelism_and_keeps_cancellation(monkeypatch, tmp_path, arguments, expected):
    captured = {}
    marker = tmp_path / 'cancel'
    def import_file(store, source, **kwargs):
        captured.update(kwargs)
        assert not kwargs['cancelled']()
        marker.write_text('pause')
        assert kwargs['cancelled']()
        return {'status': 'paused'}
    monkeypatch.setattr(worker.reference_store, 'import_file', import_file)
    monkeypatch.setattr(worker, 'default_import_workers', lambda: 4)
    monkeypatch.setattr(sys, 'argv', ['reference_worker.py', '--store', str(tmp_path / 'store.sqlite3'),
        '--source', str(tmp_path / 'source.pgn'), '--cancel', str(marker), '--encoding', 'cp1252',
        '--max-games', '25', *arguments])
    worker.main()
    assert captured['workers'] == expected
    assert captured['encoding'] == 'cp1252'
    assert captured['max_games'] == 25
