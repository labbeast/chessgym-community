"""Import cache budgets are connection-local and preserve durable checkpoints."""
import sys

import pytest

import reference_store as store
import reference_worker as worker


PGN = '''[Event "Cache one"]
[White "White"]
[Black "Black"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 1-0

[Event "Cache two"]
[White "White"]
[Black "Black"]
[Result "0-1"]

1. d4 d5 2. c4 e6 0-1
'''


def source_file(tmp_path):
    source = tmp_path / 'games.pgn'
    source.write_text(PGN, encoding='utf-8')
    return source


def observe_writer(monkeypatch):
    observed = []
    insert = store._insert_prepared

    def insert_with_cache(conn, prepared):
        observed.append(conn.execute('PRAGMA cache_size').fetchone()[0])
        return insert(conn, prepared)

    monkeypatch.setattr(store, '_insert_prepared', insert_with_cache)
    return observed


@pytest.mark.parametrize('cache_mib', [64, 128, 512, 1024, 4096])
def test_writer_budget_is_real_and_reader_budget_stays_small(tmp_path, monkeypatch, cache_mib):
    path = tmp_path / 'reference.sqlite3'
    observed = observe_writer(monkeypatch)
    result = store.import_file(path, source_file(tmp_path), cache_mib=cache_mib)
    assert result['status'] == 'completed'
    assert result['imported'] == 2
    assert result['cache_mib'] == cache_mib
    assert observed == [-cache_mib * 1024] * 2
    with store._connect(path, readonly=True) as conn:
        assert conn.execute('PRAGMA cache_size').fetchone()[0] == -16384
    assert store.read_game(path, 2)['headers']['Event'] == 'Cache two'


def test_unspecified_budget_keeps_previous_default(tmp_path, monkeypatch):
    observed = observe_writer(monkeypatch)
    result = store.import_file(tmp_path / 'reference.sqlite3', source_file(tmp_path))
    assert result['cache_mib'] == 128
    assert observed == [-128 * 1024] * 2


@pytest.mark.parametrize('cache_mib', [None, True, False, 0, 63, 4097, -128, 128.0, '1024'])
def test_invalid_budget_is_rejected_before_creating_store(tmp_path, cache_mib):
    path = tmp_path / 'reference.sqlite3'
    with pytest.raises(ValueError, match='cache'):
        store.import_file(path, tmp_path / 'absent.pgn', cache_mib=cache_mib)
    assert not path.exists()


def test_resume_can_change_cache_without_changing_checkpoint(tmp_path, monkeypatch):
    path = tmp_path / 'reference.sqlite3'
    source = source_file(tmp_path)
    observed = observe_writer(monkeypatch)
    paused = store.import_file(path, source, max_games=1, cache_mib=64)
    assert paused['status'] == 'paused'
    assert paused['processed'] == paused['imported'] == 1
    resumed = store.import_file(path, source, cache_mib=1024)
    assert resumed['status'] == 'completed'
    assert resumed['processed'] == resumed['imported'] == 2
    assert resumed['duplicates'] == resumed['rejected'] == 0
    assert resumed['cache_mib'] == 1024
    assert observed == [-64 * 1024, -1024 * 1024]
    assert [item['headers']['Event'] for item in store.list_games(path)['entries']] == ['Cache one', 'Cache two']


@pytest.mark.parametrize('value,expected', [(None, 128), ('', 128), ('  ', 128), ('64', 64),
                                            (' 1024 ', 1024), ('4096', 4096)])
def test_worker_budget_environment(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv('CHESSGYM_IMPORT_CACHE_MB', raising=False)
    else:
        monkeypatch.setenv('CHESSGYM_IMPORT_CACHE_MB', value)
    assert worker.default_import_cache_mib() == expected


@pytest.mark.parametrize('value', ['63', '4097', '-1', '128.5', 'true', 'auto', '١٢٨'])
def test_invalid_worker_budget_environment_is_rejected(monkeypatch, value):
    monkeypatch.setenv('CHESSGYM_IMPORT_CACHE_MB', value)
    with pytest.raises(ValueError, match='CHESSGYM_IMPORT_CACHE_MB'):
        worker.default_import_cache_mib()


@pytest.mark.parametrize('arguments,expected', [([], 512), (['--cache-mib', '1024'], 1024)])
def test_worker_cli_passes_cache_and_preserves_cancellation(tmp_path, monkeypatch, arguments, expected):
    captured = {}
    marker = tmp_path / 'cancel'

    def import_file(path, source, **kwargs):
        captured.update(kwargs)
        assert not kwargs['cancelled']()
        marker.write_text('pause')
        assert kwargs['cancelled']()
        return {'status': 'paused'}

    monkeypatch.setattr(worker.reference_store, 'import_file', import_file)
    monkeypatch.setenv('CHESSGYM_IMPORT_CACHE_MB', '512')
    monkeypatch.setattr(sys, 'argv', ['reference_worker.py', '--store', str(tmp_path / 'reference.sqlite3'),
        '--source', str(tmp_path / 'source.pgn'), '--cancel', str(marker), '--workers', '12', *arguments])
    worker.main()
    assert captured['cache_mib'] == expected
    assert captured['workers'] == 12


def test_explicit_cli_budget_does_not_consult_environment(tmp_path, monkeypatch):
    captured = {}
    monkeypatch.setenv('CHESSGYM_IMPORT_CACHE_MB', 'invalid')
    monkeypatch.setattr(worker.reference_store, 'import_file',
                        lambda path, source, **kwargs: captured.update(kwargs) or {'status': 'paused'})
    monkeypatch.setattr(sys, 'argv', ['reference_worker.py', '--store', str(tmp_path / 'reference.sqlite3'),
        '--source', str(tmp_path / 'source.pgn'), '--cancel', str(tmp_path / 'cancel'),
        '--workers', '1', '--cache-mib', '1024'])
    worker.main()
    assert captured['cache_mib'] == 1024
