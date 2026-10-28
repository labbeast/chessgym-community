"""Reference edits invalidate cached snapshots, including readers already running."""
from concurrent.futures import ThreadPoolExecutor
import threading

import pytest

import reference_queries as queries
import reference_store as store


@pytest.fixture
def archive(tmp_path):
    path = tmp_path / 'reference.sqlite3'
    store.init_store(path)
    queries.clear_cache()
    yield path
    queries.clear_cache()


def change_totals(path, **changes):
    with store._connect(path) as conn:
        totals = store._get_meta(conn, 'totals')
        totals.update(changes)
        store._set_meta(conn, 'totals', totals)


def test_explicit_edit_invalidates_snapshot_even_when_corpus_size_is_unchanged(archive):
    queries.bounded([archive], ('players',), lambda: {'status': 'ok', 'names': ['Original']})
    # Ordinary import progress keeps its deliberately bounded 30-second snapshot.
    change_totals(archive, game_count=1)
    cached = queries.bounded([archive], ('players',), lambda: pytest.fail('Import discarded snapshot'))
    assert cached['cached'] and cached['names'] == ['Original']
    change_totals(archive, revision=1)
    fresh = queries.bounded([archive], ('players',), lambda: {'status': 'ok', 'names': ['Edited']})
    assert fresh['names'] == ['Edited'] and not fresh.get('cached')


def test_inflight_old_snapshot_cannot_repopulate_current_generation(archive):
    started, release = threading.Event(), threading.Event()
    def read_old_snapshot():
        started.set()
        assert release.wait(3)
        return {'status': 'ok', 'total': 5}
    with ThreadPoolExecutor(max_workers=1) as pool:
        old = pool.submit(queries.bounded, [archive], ('position',), read_old_snapshot)
        assert started.wait(3)
        try:
            change_totals(archive, revision=1)
        finally:
            release.set()
        assert old.result(timeout=3)['total'] == 5
    fresh = queries.bounded([archive], ('position',), lambda: {'status': 'ok', 'total': 4})
    assert fresh['total'] == 4 and not fresh.get('cached')


def test_mutation_in_either_source_invalidates_combined_snapshot(archive, tmp_path):
    second = tmp_path / 'other.sqlite3'
    store.init_store(second)
    queries.bounded([archive, second], ('combined',), lambda: {'status': 'ok', 'total': 2})
    change_totals(second, revision=1)
    fresh = queries.bounded([archive, second], ('combined',), lambda: {'status': 'ok', 'total': 1})
    assert fresh['total'] == 1 and not fresh.get('cached')
