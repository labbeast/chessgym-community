"""Bounded CPU parsing pipeline for the single-writer reference importer.

Only trusted Python objects cross local multiprocessing pipes. Children never
receive SQLite paths or connections and cannot commit/checkpoint an import.
"""
from collections import deque
from contextlib import contextmanager
import multiprocessing
import multiprocessing.spawn
from pathlib import Path
import os
import sys
import threading

PARSE_BATCH_GAMES = 64
PARSE_BATCH_BYTES = 1024 * 1024
MAX_PENDING_BYTES = 32 * 1024 * 1024
WAIT_SECONDS = 0.1
_SPAWN_CONFIGURATION_LOCK = threading.RLock()


def guard_parent():
    """Exit even if Windows forcibly terminates the coordinating importer.

    The multiprocessing sentinel identifies the original parent process, so PID
    reuse cannot keep an orphan alive. The waiter needs no recurring CPU polls.
    """
    parent = multiprocessing.parent_process()
    if parent is None:
        return

    def watch():
        parent.join()
        os._exit(97)

    threading.Thread(target=watch, name='reference-parent-watch', daemon=True).start()


def prepare_batch(batch, encoding):
    import reference_store as store
    prepared = []
    for raw, offset, record_error, bytes_read, empty in batch:
        if empty:
            prepared.append((None, offset, None, bytes_read, True))
            continue
        try:
            if record_error:
                raise ValueError(record_error)
            parsed = store._parse_record(raw, encoding)
            game = store._prepare_game(parsed, raw, pack_positions=True)
        except (ValueError, UnicodeError, IndexError, KeyError, RecursionError) as exc:
            prepared.append((None, offset, str(exc)[:250], bytes_read, False))
        else:
            prepared.append((game, offset, None, bytes_read, False))
    return prepared


def record_batches(records, raw_stream, max_records, cancelled):
    import reference_store as store
    batch, size, count = [], 0, 0
    for raw, offset, error in records:
        if cancelled():
            raise store._ImportCancelled()
        empty = not raw.strip() and not error
        if batch and (len(batch) >= PARSE_BATCH_GAMES or size + len(raw) > PARSE_BATCH_BYTES):
            yield batch, size
            batch, size = [], 0
        batch.append((raw, offset, error, raw_stream.tell(), empty))
        size += len(raw)
        count += not empty
        if max_records is not None and count >= max_records:
            break
    if batch:
        yield batch, size


@contextmanager
def parsing_pool(workers):
    """Spawn hidden children with the real interpreter, not a venv redirector."""
    context = multiprocessing.get_context('spawn')
    # set_executable/environment are process-wide. Imports normally run in their
    # own coordinator; direct callers are serialized during this configuration.
    with _SPAWN_CONFIGURATION_LOCK:
        original_executable = multiprocessing.spawn.get_executable()
        previous_launcher = os.environ.get('__PYVENV_LAUNCHER__')
        pool = None
        try:
            if os.name == 'nt':
                executable = Path(getattr(sys, '_base_executable', sys.executable)).with_name('pythonw.exe')
                if not executable.is_file():
                    raise RuntimeError('Le processus Python sans console est absent; utilise temporairement un seul processus.')
                # The venv pythonw.exe is a redirector which exits immediately;
                # Pool would watch that short-lived PID instead of its worker.
                # Bypass it just as CPython's ordinary Windows spawn path does,
                # retaining the venv through its standard launcher environment.
                context.set_executable(str(executable))
                os.environ['__PYVENV_LAUNCHER__'] = sys.executable
            pool = context.Pool(processes=workers, initializer=guard_parent)
            try:
                yield pool
            except BaseException:
                pool.terminate()
                raise
            else:
                pool.close()
            finally:
                pool.join()
        finally:
            context.set_executable(original_executable)
            if previous_launcher is None:
                os.environ.pop('__PYVENV_LAUNCHER__', None)
            else:
                os.environ['__PYVENV_LAUNCHER__'] = previous_launcher


def ordered_records(records, raw_stream, *, encoding, workers, max_records=None, cancelled=lambda: False):
    """Yield prepared records in source order, with bounded pending work.

    At most two batches per process and 32 MiB of raw in-flight input are queued.
    One additional batch can be held while waiting for capacity; oversized but
    valid records remain bounded by the importer's 20 MiB per-game limit.
    """
    import reference_store as store
    with parsing_pool(workers) as pool:
        # Pool replaces abruptly dead workers; their unfinished AsyncResult
        # would otherwise wait forever. Keep the original process handles.
        children = tuple(pool._pool)
        pending = deque()
        batches = record_batches(records, raw_stream, max_records, cancelled)
        inflight_bytes = 0
        held = None
        exhausted = False
        try:
            while pending or not exhausted or held is not None:
                while len(pending) < workers * 2 and not exhausted:
                    if cancelled():
                        raise store._ImportCancelled()
                    if held is None:
                        try:
                            held = next(batches)
                        except StopIteration:
                            exhausted = True
                            break
                    batch, size = held
                    if pending and inflight_bytes + size > MAX_PENDING_BYTES:
                        break
                    pending.append((pool.apply_async(prepare_batch, (batch, encoding)), size))
                    inflight_bytes += size
                    held = None
                if not pending:
                    continue
                result, size = pending[0]
                while True:
                    if cancelled():
                        raise store._ImportCancelled()
                    try:
                        prepared = result.get(timeout=WAIT_SECONDS)
                        break
                    except multiprocessing.TimeoutError:
                        if any(child.exitcode is not None for child in children):
                            raise RuntimeError('Un processus de lecture PGN a été interrompu; reprends l’import au dernier lot sauvegardé.')
                pending.popleft()
                inflight_bytes -= size
                for record in prepared:
                    if cancelled():
                        raise store._ImportCancelled()
                    yield record
        finally:
            batches.close()
            records.close()
