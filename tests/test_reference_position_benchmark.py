from contextlib import closing
from copy import deepcopy
import json
import sqlite3

import pytest

from scripts import benchmark_reference_position_order as bench


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    output = tmp_path / 'isolated'
    output.mkdir()
    monkeypatch.setattr(bench, 'OUTPUT', output)
    return output


def test_outputs_cannot_target_live_data_or_escape_directory(isolated):
    assert bench.bounded(isolated / 'test.sqlite3') == isolated / 'test.sqlite3'
    with pytest.raises(ValueError):
        bench.bounded(isolated / '..' / 'data' / 'reference.sqlite3')


def test_backup_preserves_all_rows_without_changing_seed(isolated):
    source, copied = isolated / 'source.sqlite3', isolated / 'copy.sqlite3'
    with closing(sqlite3.connect(source)) as conn, conn:
        conn.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY, value BLOB)')
        conn.execute('INSERT INTO sample VALUES(1,?)', (b'original',))
    before = source.read_bytes()
    bench.clone_seed(source, copied)
    assert source.read_bytes() == before
    with closing(sqlite3.connect(copied)) as conn:
        assert conn.execute('SELECT * FROM sample').fetchall() == [(1, b'original')]
    with pytest.raises(ValueError):
        bench.clone_seed(source, copied)


def result():
    return {'verification': {'games': {'rows': 2, 'sha256': 'games'},
                             'positions': {'rows': 5, 'sha256': 'positions'}},
            'metadata': {'import': {key: 4 for key in bench.COUNTERS},
                         'totals': {'game_count': 2, 'indexed_positions': 5}}}


def test_all_contents_and_semantic_counters_must_match():
    first, second = result(), result()
    second['metadata']['import']['updated_at'] = 'timestamp may differ'
    second['metadata']['import']['sort_positions'] = True
    bench.assert_equal_runs(first, second)
    second['verification']['positions']['sha256'] = 'changed'
    with pytest.raises(AssertionError, match='positions'):
        bench.assert_equal_runs(first, second)
    second = result()
    second['metadata']['import']['offset'] += 1
    with pytest.raises(AssertionError, match='offset'):
        bench.assert_equal_runs(first, second)
    second = result()
    second['metadata']['totals']['game_count'] += 1
    with pytest.raises(AssertionError, match='totals'):
        bench.assert_equal_runs(first, second)


def test_summary_compares_both_ends_of_abba():
    report = {'runs': [{'sorted': False, 'import_and_checkpoint_seconds': 10},
                       {'sorted': True, 'import_and_checkpoint_seconds': 8},
                       {'sorted': True, 'import_and_checkpoint_seconds': 6},
                       {'sorted': False, 'import_and_checkpoint_seconds': 12}]}
    summary = bench.summary(report)
    assert summary['source_order_median_seconds'] == 11
    assert summary['sorted_median_seconds'] == 7
    assert summary['median_speedup'] == pytest.approx(11 / 7)
    assert summary['median_time_reduction_percent'] == pytest.approx(100 * 4 / 11)


def test_small_seed_does_not_claim_cache_pressure(isolated):
    source = isolated / 'small.sqlite3'
    with closing(sqlite3.connect(source)) as conn, conn:
        conn.execute('CREATE TABLE meta(key,value)')
        conn.execute('INSERT INTO meta VALUES(?,?)', ('totals', json.dumps({'indexed_positions': 1})))
        conn.execute('CREATE TABLE positions(position_key BLOB)')
        conn.execute('INSERT INTO positions VALUES(?)', (b'key',))
    with pytest.raises(ValueError, match='exceed'):
        bench.seed_description(source, 64)
