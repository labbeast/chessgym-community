"""Exact deferred Explorer snapshots use isolated tiny completed archives."""
import threading
import time

import chess
import pytest

import db
import reference_aggregate_cache as cache
import reference_queries as queries
import reference_store as store
from test_reference_store import pgn, source


@pytest.fixture
def archive(tmp_path, monkeypatch):
    queries.close_preparations()
    queries.start_preparations()
    queries.clear_cache()
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'personal.sqlite3')
    path = tmp_path / 'reference.sqlite3'
    store.import_file(path, source(tmp_path, pgn(['e2e4'], white='A'),
        pgn(['d2d4'], white='B'), name='games.pgn'))
    monkeypatch.setattr(store, 'prepare_explorer_index', lambda path: None, raising=False)
    yield path
    queries.close_preparations()
    queries.start_preparations()
    queries.clear_cache()


def await_finished(timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        with queries._PREPARATION_LOCK:
            if not queries._PREPARATIONS:
                return
        time.sleep(.01)
    pytest.fail('Preparation did not finish')


def force_timeout():
    queries._CURRENT.get().cancel('timeout')
    queries.check()


def call(path, profile, compute, **kwargs):
    return queries.bounded([path], profile, compute, persistent=True, prepare=True, **kwargs)


def test_timeout_prepares_once_then_reuses_exact_persistent_result(archive):
    started, release = threading.Event(), threading.Event()
    calls, guards = [], []
    def compute():
        calls.append(1)
        guards.append(queries._CURRENT.get())
        if len(calls) == 1:
            force_timeout()
        started.set()
        assert release.wait(2)
        return store.explorer_data(archive, chess.STARTING_FEN)
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('start',), compute)
    assert started.wait(2)
    try:
        for _ in range(3):
            with pytest.raises(queries.QueryStopped, match='preparing'):
                call(archive, ('start',), compute)
        response = queries.unavailable('preparing')
        assert response['status'] == 'preparing' and response['retry_after'] == 3
        assert response['total'] is None and response['moves'] == []
        assert len(calls) == 2 and guards[0] is not guards[1]
    finally:
        release.set()
    await_finished()
    queries.clear_cache()
    result = call(archive, ('start',), lambda: pytest.fail('Should read prepared snapshot'))
    assert result['cached'] and result['total'] == 2
    assert sum(row['total'] for row in result['moves']) == 2


def test_completed_rejections_are_cached_without_removing_warning(archive):
    with store._connect(archive) as conn:
        state = store._get_meta(conn, 'import')
        store._set_meta(conn, 'import', {**state, 'rejected': 4})
    def compute():
        return {**store.explorer_data(archive, chess.STARTING_FEN), 'complete': False}
    result = call(archive, ('rejected',), compute, allow_incomplete=True)
    queries.clear_cache()
    cached = call(archive, ('rejected',), lambda: pytest.fail('Must remain cached'), allow_incomplete=True)
    assert result['total'] == cached['total'] == 2
    assert cached['complete'] is False and cached['invalid_entries'] == 4


def test_import_in_progress_is_never_prepared(archive):
    with store._connect(archive) as conn:
        state = store._get_meta(conn, 'import')
        store._set_meta(conn, 'import', {**state, 'status': 'running'})
    with pytest.raises(queries.QueryStopped, match='timeout'):
        call(archive, ('partial',), force_timeout, allow_incomplete=True)
    assert not queries._PREPARATIONS
    assert cache.read(cache.key([archive], ('partial',))) is None


def test_source_change_during_preparation_discards_result(archive):
    calls = []
    original_key = cache.key([archive], ('changing',))
    def compute():
        calls.append(1)
        if len(calls) == 1:
            force_timeout()
        with store._connect(archive) as conn:
            totals = store._get_meta(conn, 'totals')
            store._set_meta(conn, 'totals', {**totals, 'game_count': 3})
        return {'status': 'ok', 'total': 2}
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('changing',), compute)
    await_finished()
    assert not queries._CACHE
    assert cache.read(original_key) is None
    assert cache.read(cache.key([archive], ('changing',))) is None


def test_cached_profiles_remain_available_during_other_preparation(archive):
    call(archive, ('cached',), lambda: {'status': 'ok', 'total': 7})
    queries.clear_cache()
    started, release = threading.Event(), threading.Event()
    calls = []
    def compute():
        calls.append(1)
        if len(calls) == 1:
            force_timeout()
        started.set()
        assert release.wait(2)
        return {'status': 'ok', 'total': 2}
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('slow',), compute)
    assert started.wait(2)
    try:
        assert call(archive, ('cached',), lambda: pytest.fail('Cache was blocked'))['total'] == 7
    finally:
        release.set()
    await_finished()


def test_queue_is_bounded_and_runs_one_computation_at_a_time(archive, monkeypatch):
    monkeypatch.setattr(queries, 'MAX_PREPARATIONS', 2)
    started, release = threading.Event(), threading.Event()
    calls = []
    def compute():
        calls.append(1)
        if len(calls) == 1:
            force_timeout()
        started.set()
        assert release.wait(2)
        return {'status': 'ok', 'total': 2}
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('slow',), compute)
    assert started.wait(2)
    second_calls = []
    try:
        with pytest.raises(queries.QueryStopped, match='preparing'):
            call(archive, ('queued',), lambda: second_calls.append(1) or {'status': 'ok', 'total': 3})
        with pytest.raises(queries.QueryStopped, match='busy'):
            call(archive, ('overflow',), lambda: pytest.fail('Unbounded queue'))
        assert len(queries._PREPARATIONS) == 2 and not second_calls
    finally:
        release.set()
    await_finished()
    assert second_calls == [1]


def test_shutdown_interrupts_background_sql_and_releases_slot(archive):
    started = threading.Event()
    calls, guards = [], []
    def compute():
        calls.append(1)
        if len(calls) == 1:
            force_timeout()
        guards.append(queries._CURRENT.get())
        with store._connect(archive, readonly=True) as conn:
            started.set()
            conn.execute('''WITH RECURSIVE n(x) AS (
                VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000
                ) SELECT sum(x) FROM n''').fetchone()
        pytest.fail('SQL should have been interrupted')
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('shutdown',), compute)
    assert started.wait(2)
    queries.close_preparations()
    assert guards[0].reason == 'shutdown' and not guards[0].connections
    assert not queries._CACHE and not queries._PREPARATION_THREAD.is_alive()
    queries.start_preparations()
    assert call(archive, ('after-shutdown',), lambda: {'status': 'ok', 'total': 1})['total'] == 1


def test_preparation_errors_leave_no_partial_snapshot_and_allow_other_profiles(archive):
    calls = []
    def compute():
        calls.append(1)
        if len(calls) == 1:
            force_timeout()
        raise ValueError('Invalid retained game metadata')
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('failed',), compute)
    await_finished()
    assert cache.read(cache.key([archive], ('failed',))) is None
    with pytest.raises(queries.QueryStopped, match='cooldown'):
        call(archive, ('failed',), compute)
    assert call(archive, ('other',), lambda: {'status': 'ok', 'total': 5})['total'] == 5


def test_index_and_query_get_distinct_cancellable_budgets(archive, monkeypatch):
    observed = []
    def prepare_index(path):
        guard = queries._CURRENT.get()
        observed.append(('index', guard, guard.deadline - queries.monotonic()))
        return True
    monkeypatch.setattr(store, 'prepare_explorer_index', prepare_index)
    calls = []
    def compute():
        calls.append(1)
        if len(calls) == 1:
            force_timeout()
        guard = queries._CURRENT.get()
        observed.append(('query', guard, guard.deadline - queries.monotonic()))
        return {'status': 'ok', 'total': 2}
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('budgets',), compute)
    await_finished()
    assert [item[0] for item in observed] == ['index', 'query']
    assert observed[0][1] is not observed[1][1]
    assert queries.INDEX_PREPARATION_SECONDS - 2 < observed[0][2] <= queries.INDEX_PREPARATION_SECONDS
    assert queries.PREPARATION_SECONDS - 2 < observed[1][2] <= queries.PREPARATION_SECONDS


def test_list_preparation_reuses_existing_indexes_without_building_explorer_index(archive, monkeypatch):
    monkeypatch.setattr(store, 'prepare_explorer_index', lambda *_: pytest.fail('List must not build an index'))
    calls = []
    def compute():
        calls.append(1)
        if len(calls) == 1:
            force_timeout()
        return {'status': 'ok', **store.list_games(archive, search='A')}
    with pytest.raises(queries.QueryStopped, match='preparing'):
        call(archive, ('game-list', 'A'), compute, prepare_indexes=False)
    await_finished()
    queries.clear_cache()
    result = call(archive, ('game-list', 'A'), lambda: pytest.fail('Must reuse exact page'), prepare_indexes=False)
    assert result['cached'] and result['total'] == 1
    assert result['entries'][0]['headers']['White'] == 'A'
