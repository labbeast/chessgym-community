"""Bounded reads use tiny isolated databases, never the user's archives."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
import threading
import time

import pytest

import reference_queries as queries
import reference_store


HEAVY_SQL = '''WITH RECURSIVE n(x) AS (
 VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000
) SELECT sum(x) FROM n'''


@pytest.fixture(autouse=True)
def empty_cache():
    queries.clear_cache()
    yield
    queries.clear_cache()


@pytest.fixture
def archive(tmp_path):
    path = tmp_path / 'reference.sqlite3'
    with closing(sqlite3.connect(path)) as conn:
        conn.execute('CREATE TABLE sample(value INTEGER)')
    return path


def heavy(path, guards):
    guards.append(queries._CURRENT.get())
    with reference_store._connect(path, readonly=True) as conn:
        conn.execute(HEAVY_SQL).fetchone()
    return {'status': 'ok', 'total': 1}


def assert_available(path):
    result = queries.bounded([path], ('other',), lambda: {'status': 'ok', 'total': 2})
    assert result['total'] == 2


def test_sql_timeout_stops_reader_releases_slot_and_cools_same_profile(archive):
    guards = []
    before = time.monotonic()
    with queries.scope(queries.Guard(.025)), pytest.raises(queries.QueryStopped, match='timeout'):
        queries.bounded([archive], ('root',), lambda: heavy(archive, guards))
    assert time.monotonic() - before < 2
    assert guards[0].connections == set()
    assert not queries._CACHE
    # Import-like writes must not invalidate the cooldown.
    with closing(sqlite3.connect(archive)) as conn, conn:
        conn.execute('INSERT INTO sample VALUES(1)')
    with pytest.raises(queries.QueryStopped, match='cooldown'):
        queries.bounded([archive], ('root',), lambda: pytest.fail('Query restarted during cooldown'))
    assert_available(archive)


def test_client_disconnect_interrupts_sql_and_context_reaches_thread(archive):
    class Request:
        async def is_disconnected(self):
            return True

    guards = []
    async def scenario():
        with pytest.raises(queries.QueryStopped, match='disconnected'):
            await queries.run(Request(), lambda: queries.bounded(
                [archive], ('root',), lambda: heavy(archive, guards)), budget=5)
    before = time.monotonic()
    asyncio.run(scenario())
    assert time.monotonic() - before < 2
    assert guards and isinstance(guards[0], queries.Guard)
    assert guards[0].connections == set()
    assert not queries._CACHE and not queries._COOLDOWN
    assert_available(archive)


def test_asgi_task_cancellation_waits_for_sql_cleanup(archive):
    class Request:
        async def is_disconnected(self):
            return False

    guards = []
    started = threading.Event()
    def work():
        started.set()
        return heavy(archive, guards)

    async def scenario():
        task = asyncio.create_task(queries.run(Request(), lambda: queries.bounded([archive], ('root',), work)))
        while not started.is_set():
            await asyncio.sleep(.005)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert guards[0].connections == set()
    asyncio.run(scenario())
    assert_available(archive)


def test_sql_interrupted_before_aggregation_is_normalized(archive):
    class Request:
        async def is_disconnected(self):
            return True
    guards = []
    async def scenario():
        with pytest.raises(queries.QueryStopped, match='disconnected'):
            # Direct store read, e.g. metadata before bounded() is entered.
            await queries.run(Request(), heavy, archive, guards)
    asyncio.run(scenario())
    assert guards[0].connections == set()


def test_only_one_heavy_reference_query_runs_no_waiting_queue(archive):
    started, release = threading.Event(), threading.Event()
    def compute():
        started.set()
        assert release.wait(2)
        return {'status': 'ok', 'total': 1}
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(queries.bounded, [archive], ('one',), compute)
        assert started.wait(2)
        try:
            with pytest.raises(queries.QueryStopped, match='busy'):
                queries.bounded([archive], ('two',), lambda: pytest.fail('Concurrent heavy scan'))
        finally:
            release.set()
        assert future.result(timeout=2)['total'] == 1
    assert_available(archive)


def test_success_snapshot_cache_is_bounded_copied_and_expires(archive, monkeypatch):
    monkeypatch.setattr(queries, 'MAX_CACHE', 2)
    clock = [100.0]
    monkeypatch.setattr(queries, 'monotonic', lambda: clock[0])
    calls = []
    def compute():
        calls.append(1)
        return {'status': 'ok', 'total': 4, 'moves': [{'uci': 'e2e4'}], 'complete': False}
    first = queries.bounded([archive], ('root',), compute)
    first['moves'][0]['uci'] = 'changed'
    cached = queries.bounded([archive], ('root',), compute)
    assert cached['moves'] == [{'uci': 'e2e4'}]
    assert cached['snapshot'] and cached['cached'] and cached['fetched_at']
    assert cached['complete'] is False and '30 secondes' in cached['message']
    assert len(calls) == 1
    clock[0] += queries.CACHE_SECONDS + 1
    queries.bounded([archive], ('root',), compute)
    assert len(calls) == 2
    queries.bounded([archive], ('second',), compute)
    queries.bounded([archive], ('third',), compute)
    assert len(queries._CACHE) == 2


def test_unavailable_or_failed_partial_results_are_never_cached(archive):
    for _ in range(2):
        result = queries.bounded([archive], ('failed',), lambda: queries.unavailable('busy'))
        assert result['total'] is None and result['complete'] is False
    assert not queries._CACHE
    def partial_then_error():
        rows = [1, 2]
        raise RuntimeError('Reader failed after some rows')
    with pytest.raises(RuntimeError):
        queries.bounded([archive], ('partial',), partial_then_error)
    assert not queries._CACHE
    assert_available(archive)


def test_short_sql_busy_timeout_is_installed_before_other_pragmas(archive):
    with queries.scope(queries.Guard(1)):
        with reference_store._connect(archive, readonly=True) as conn:
            assert conn.execute('PRAGMA busy_timeout').fetchone()[0] == 1000


def test_archive_replacement_invalidates_cached_result(archive):
    queries.bounded([archive], ('root',), lambda: {'status': 'ok', 'total': 1})
    replacement = archive.with_name('replacement.sqlite3')
    with closing(sqlite3.connect(replacement)) as conn:
        conn.execute('CREATE TABLE replacement(value)')
    replacement.replace(archive)
    result = queries.bounded([archive], ('root',), lambda: {'status': 'ok', 'total': 2})
    assert result['total'] == 2 and not result.get('cached')


@pytest.mark.parametrize('through_request', [False, True])
def test_sql_busy_is_unavailable_before_full_budget_expires(archive, monkeypatch, through_request):
    original = queries.Guard.attach
    def fast_lock(self, conn):
        original(self, conn)
        conn.execute('PRAGMA busy_timeout=1')
    monkeypatch.setattr(queries.Guard, 'attach', fast_lock)
    class Request:
        async def is_disconnected(self):
            return False
    def read():
        with reference_store._connect(archive, readonly=True) as conn:
            conn.execute('SELECT * FROM sample').fetchall()
        pytest.fail('Exclusive lock should prevent the read')
    async def requested():
        await queries.run(Request(), read)
    with closing(sqlite3.connect(archive)) as locker:
        locker.execute('BEGIN EXCLUSIVE')
        with pytest.raises(queries.QueryStopped, match='busy'):
            if through_request:
                asyncio.run(requested())
            else:
                queries.bounded([archive], ('locked',), read)
    assert not queries._CACHE and not queries._COOLDOWN
    assert_available(archive)


def test_other_sql_errors_keep_their_original_diagnostic(archive):
    def bad_query():
        with reference_store._connect(archive, readonly=True) as conn:
            conn.execute('SELECT * FROM missing_table')
    with pytest.raises(sqlite3.OperationalError, match='no such table'):
        queries.bounded([archive], ('bad',), bad_query)
    assert_available(archive)
