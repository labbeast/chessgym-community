"""Bound costly reference reads and interrupt SQL when its viewer goes away."""
import asyncio
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import threading
from time import monotonic

from starlette.concurrency import run_in_threadpool

BUDGET_SECONDS = 6
CACHE_SECONDS = 30
COOLDOWN_SECONDS = 60
MAX_CACHE = 128
PREPARATION_SECONDS = 300
INDEX_PREPARATION_SECONDS = 1200
MAX_PREPARATIONS = 4
_CURRENT = ContextVar('reference_query_guard', default=None)
_SLOT = threading.BoundedSemaphore(1)
_PAGE_SLOT = threading.BoundedSemaphore(1)
_LOCK = threading.Lock()
_CACHE = OrderedDict()
_COOLDOWN = OrderedDict()
_PREPARATIONS = OrderedDict()
_PREPARATION_LOCK = threading.RLock()
_PREPARATION_WAKE = threading.Event()
_PREPARATION_THREAD = None
_PREPARATION_CLOSING = False
_PREPARATION_GUARD = None


class QueryStopped(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def _check_locked(exc):
    code = getattr(exc, 'sqlite_errorcode', 0) & 255
    if isinstance(exc, sqlite3.OperationalError) and code in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
        raise QueryStopped('busy') from exc


class Guard:
    def __init__(self, budget=BUDGET_SECONDS):
        self.deadline = monotonic() + budget
        self.reason = None
        self.connections = set()
        self.lock = threading.Lock()

    def check(self):
        if self.reason:
            raise QueryStopped(self.reason)
        if monotonic() >= self.deadline:
            self.cancel('timeout')
            raise QueryStopped('timeout')

    def cancel(self, reason='disconnected'):
        with self.lock:
            self.reason = self.reason or reason
            for conn in self.connections:
                try:
                    conn.interrupt()
                except Exception:
                    pass

    def progress(self):
        try:
            self.check()
            return 0
        except QueryStopped:
            return 1

    def attach(self, conn):
        self.check()
        with self.lock:
            self.connections.add(conn)
        conn.set_progress_handler(self.progress, 1000)
        conn.execute('PRAGMA busy_timeout=1000')

    def detach(self, conn):
        with self.lock:
            self.connections.discard(conn)
        conn.set_progress_handler(None, 0)


@contextmanager
def scope(guard):
    token = _CURRENT.set(guard)
    try:
        yield
    finally:
        _CURRENT.reset(token)


def attach(conn):
    guard = _CURRENT.get()
    if guard:
        try:
            guard.attach(conn)
        except Exception:
            guard.detach(conn)
            raise
    return guard


async def run(request, fn, *args, budget=None):
    """Keep the event loop responsive while a single SQL thread is monitored."""
    guard = Guard(BUDGET_SECONDS if budget is None else budget)

    def work():
        with scope(guard):
            try:
                return fn(*args)
            except QueryStopped:
                # A timeout may have handed the exact computation to the
                # background worker. Preserve that intentional preparing state.
                raise
            except Exception as exc:
                # Metadata may be read before the aggregation's bounded()
                # wrapper. Translate its interrupted SQL in the same way.
                guard.check()
                _check_locked(exc)
                raise

    task = asyncio.create_task(run_in_threadpool(work))
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=.1)
            if not task.done():
                if await request.is_disconnected():
                    guard.cancel('disconnected')
                elif monotonic() >= guard.deadline:
                    guard.cancel('timeout')
        return await task
    finally:
        if not task.done():
            guard.cancel('disconnected')
            # Do not abandon a live SQLite reader when ASGI cancels its task.
            try:
                await asyncio.shield(task)
            except (Exception, asyncio.CancelledError):
                pass


def check():
    guard = _CURRENT.get()
    if guard:
        guard.check()


def exclusive(compute, *, short_page=False):
    """Bound heavy reads; permit one separately bounded indexed table page."""
    check()
    slot = _PAGE_SLOT if short_page else _SLOT
    if not slot.acquire(blocking=False):
        raise QueryStopped('busy')
    try:
        return compute()
    finally:
        slot.release()


def clear_cache():
    with _LOCK:
        _CACHE.clear()
        _COOLDOWN.clear()


def _remember(key, result):
    with _LOCK:
        _CACHE[key] = (monotonic(), deepcopy(result), result['fetched_at'])
        _CACHE.move_to_end(key)
        _COOLDOWN.pop(key, None)
        while len(_CACHE) > MAX_CACHE:
            _CACHE.popitem(last=False)


def _cool_down(key):
    with _LOCK:
        _COOLDOWN[key] = monotonic() + COOLDOWN_SECONDS
        _COOLDOWN.move_to_end(key)
        while len(_COOLDOWN) > MAX_CACHE:
            _COOLDOWN.popitem(last=False)


def start_preparations():
    """Allow the lazy worker after startup, including repeated test lifespans."""
    global _PREPARATION_CLOSING
    with _PREPARATION_LOCK:
        if _PREPARATION_THREAD is None or not _PREPARATION_THREAD.is_alive():
            _PREPARATION_CLOSING = False


def close_preparations():
    """Cancel SQL/index construction and discard queued work on shutdown."""
    global _PREPARATION_CLOSING
    with _PREPARATION_LOCK:
        _PREPARATION_CLOSING = True
        _PREPARATIONS.clear()
        guard, thread = _PREPARATION_GUARD, _PREPARATION_THREAD
        if guard:
            guard.cancel('shutdown')
        _PREPARATION_WAKE.set()
    if thread is not None and thread is not threading.current_thread():
        thread.join(timeout=10)


def _preparing(disk_key):
    with _PREPARATION_LOCK:
        return disk_key in _PREPARATIONS


def _prepare(paths, profile, memory_key, disk_key, compute, allow_incomplete, prepare_indexes=True):
    """Queue one exact snapshot; there is no unbounded request backlog."""
    global _PREPARATION_THREAD
    with _PREPARATION_LOCK:
        if _PREPARATION_CLOSING:
            return False
        if disk_key in _PREPARATIONS:
            return True
        if len(_PREPARATIONS) >= MAX_PREPARATIONS:
            return False
        _PREPARATIONS[disk_key] = (tuple(paths), profile, memory_key, compute, allow_incomplete, prepare_indexes)
        if _PREPARATION_THREAD is None or not _PREPARATION_THREAD.is_alive():
            _PREPARATION_THREAD = threading.Thread(target=_preparation_worker,
                name='reference-preparation', daemon=True)
            _PREPARATION_THREAD.start()
        _PREPARATION_WAKE.set()
        return True


def _preparation_guard(seconds):
    global _PREPARATION_GUARD
    guard = Guard(seconds)
    with _PREPARATION_LOCK:
        _PREPARATION_GUARD = guard
        if _PREPARATION_CLOSING:
            guard.cancel('shutdown')
    return guard


def _preparation_worker():
    global _PREPARATION_GUARD
    import reference_aggregate_cache
    import reference_store
    while True:
        with _PREPARATION_LOCK:
            if _PREPARATION_CLOSING:
                return
            item = next(iter(_PREPARATIONS.items()), None)
            _PREPARATION_WAKE.clear()
        if item is None:
            _PREPARATION_WAKE.wait()
            continue
        disk_key, (paths, profile, memory_key, compute, allow_incomplete, prepare_indexes) = item
        if not _SLOT.acquire(timeout=.25):
            continue
        guard = _preparation_guard(INDEX_PREPARATION_SECONDS)
        try:
            with scope(guard):
                current_key, completed = reference_aggregate_cache.version(paths, profile)
                if not completed or current_key != disk_key:
                    continue
                # This scans compact metadata once, never reimports/reparses PGN.
                # The store helper checks completion and owns the import lock.
                if prepare_indexes:
                    for path in paths:
                        reference_store.prepare_explorer_index(path)
                        guard.check()
            # Index construction is a one-time maintenance step. Its larger
            # allowance must not consume the calculation's separate budget.
            guard = _preparation_guard(PREPARATION_SECONDS)
            with scope(guard):
                current_key, completed = reference_aggregate_cache.version(paths, profile)
                if not completed or current_key != disk_key:
                    continue
                result = compute()
                guard.check()
                current_key, completed = reference_aggregate_cache.version(paths, profile)
                if (completed and current_key == disk_key and result.get('status') == 'ok'
                        and (result.get('complete', True) or allow_incomplete)):
                    result = {**result, 'snapshot': True,
                        'fetched_at': datetime.now(timezone.utc).isoformat()}
                    reference_aggregate_cache.write(disk_key, result)
                    guard.check()
                    _remember(memory_key, result)
        except Exception:
            # Keep a failed preparation out of all result caches and avoid
            # restarting it on every poll. A later request can retry it.
            if guard.reason != 'shutdown':
                _cool_down(memory_key)
        finally:
            with _PREPARATION_LOCK:
                _PREPARATIONS.pop(disk_key, None)
                _PREPARATION_GUARD = None
            _SLOT.release()


def _mutation_revision(path, guard):
    """Read the committed edit generation without invalidating import snapshots."""
    import reference_store
    try:
        with scope(guard), reference_store._connect(path, readonly=True) as conn:
            # The bounded-reader helper also accepts small non-reference stores.
            if not conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone():
                return 0
            row = conn.execute("SELECT COALESCE(json_extract(value,'$.revision'),0) FROM meta WHERE key='totals'").fetchone()
            return row[0] if row else 0
    except Exception as exc:
        guard.check()
        _check_locked(exc)
        raise


def bounded(paths, profile, compute, *, persistent=False, prepare=False, allow_incomplete=False, prepare_indexes=True):
    """Cache complete query snapshots; never cache interrupted/partial rows."""
    guard = _CURRENT.get() or Guard()
    guard.check()
    identity = []
    for path in paths:
        file = Path(path).resolve()
        stat = file.stat()
        # Birth time identifies replacements on Windows. On Unix ctime changes
        # after writes, so use the inode instead; import commits must not reset
        # the cooldown and repeatedly restart expensive queries.
        # Explicit edits must invalidate even a query that was already running
        # when the edit committed: its result retains the old generation key.
        identity.append((str(file), stat.st_dev, stat.st_ino, getattr(stat, 'st_birthtime_ns', None),
                         _mutation_revision(file, guard)))
    key = (tuple(identity), profile)
    guard.check()
    now = monotonic()
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            _CACHE.move_to_end(key)
            return {**deepcopy(hit[1]), 'cached': True, 'snapshot': True, 'fetched_at': hit[2],
                    'message': 'Statistiques conservées pendant 30 secondes ; les dernières parties importées peuvent ne pas encore y figurer.'}
    disk_key, completed = None, False
    if persistent:
        import reference_aggregate_cache
        with scope(guard):
            disk_key, completed = reference_aggregate_cache.version(paths, profile)
            hit = reference_aggregate_cache.read(disk_key)
            if hit is not None:
                guard.check()
                return {**hit, 'cached': True, 'snapshot': True,
                    'message': 'Statistiques conservées pour cette version des bases et ces filtres.'}
    # Cached/preparing profiles remain available while another position uses
    # the single expensive-reader slot. Polls never restart the computation.
    if disk_key and _preparing(disk_key):
        raise QueryStopped('preparing')
    with _LOCK:
        if _COOLDOWN.get(key, 0) > now:
            raise QueryStopped('cooldown')
    if not _SLOT.acquire(blocking=False):
        if prepare and completed and _prepare(paths, profile, key, disk_key, compute, allow_incomplete, prepare_indexes):
            raise QueryStopped('preparing')
        raise QueryStopped('busy')
    try:
        with scope(guard):
            guard.check()
            result = compute()
            guard.check()
        if result.get('status') == 'ok':
            result = {**result, 'snapshot': True, 'fetched_at': datetime.now(timezone.utc).isoformat()}
            if persistent and completed and (result.get('complete', True) or allow_incomplete):
                with scope(guard):
                    guard.check()
                    if disk_key == reference_aggregate_cache.key(paths,profile):
                        reference_aggregate_cache.write(disk_key,result)
                    guard.check()
            _remember(key, result)
        return result
    except Exception as exc:
        try:
            guard.check()
        except QueryStopped as stopped:
            if stopped.reason == 'timeout':
                if prepare and completed and _prepare(paths, profile, key, disk_key, compute, allow_incomplete, prepare_indexes):
                    raise QueryStopped('preparing') from stopped
                _cool_down(key)
            raise
        _check_locked(exc)
        raise
    finally:
        _SLOT.release()


def unavailable(reason):
    messages = {
        'busy': 'Une recherche dans les grandes bases est déjà en cours. Réessaie dans un instant.',
        'timeout': 'Ce calcul a dépassé le délai disponible. Réessaie dans un instant ou choisis une position plus avancée.',
        'cooldown': 'Le calcul de cette position a dépassé le délai. Avance de quelques coups, ou attends une minute avant de réessayer.',
        'disconnected': 'La recherche a été interrompue après le changement de position.',
        'preparing': 'Préparation des statistiques exactes de cette position. Elles apparaîtront automatiquement dès que le calcul sera terminé.',
    }
    return dict(status='preparing' if reason == 'preparing' else 'unavailable', reason=reason,
                **({'retry_after': 3} if reason == 'preparing' else {}), complete=False, moves=[], total=None,
                white=0, draws=0, black=0, unknown=0, game_count=None, terminal_count=0,
                duplicates=0, invalid_entries=0, cached=False, stale=False,
                message=messages.get(reason, 'Recherche de référence momentanément indisponible.'))
