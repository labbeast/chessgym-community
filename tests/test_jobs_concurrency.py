"""Exercise a real SQLite cancellation/finalization interleaving."""
import threading

import db
import jobs


def test_finalization_cannot_erase_a_concurrent_cancellation(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'jobs-race.sqlite3')
    db.init_db()
    jobs.init_jobs()
    job = jobs.enqueue('analyse', {'entry_id': 1}, dedupe_key='analyse:1')
    with db.get_conn() as conn:
        conn.execute("UPDATE jobs SET status='running' WHERE id=?", (job['id'],))
    original_connect = db.get_conn
    finalizer_read = threading.Event()
    cancel_attempted = threading.Event()
    cancel_finished = threading.Event()
    errors = []

    class PausedCursor:
        def __init__(self, cursor):
            self.cursor = cursor
        def fetchone(self):
            row = self.cursor.fetchone()
            finalizer_read.set()
            assert cancel_attempted.wait(2)
            # Without the finalizer's write reservation, cancellation commits
            # here and its flag can be overwritten using the stale SELECT.
            cancel_finished.wait(.15)
            return row

    class Connection:
        def __init__(self):
            self.connection = original_connect()
        def __enter__(self):
            self.connection.__enter__()
            return self
        def __exit__(self, *args):
            return self.connection.__exit__(*args)
        def execute(self, sql, args=()):
            name = threading.current_thread().name
            if name == 'canceller' and sql == 'BEGIN IMMEDIATE':
                cancel_attempted.set()
            cursor = self.connection.execute(sql, args)
            if name == 'finalizer' and sql.startswith('SELECT cancel_requested FROM jobs'):
                return PausedCursor(cursor)
            return cursor

    monkeypatch.setattr(db, 'get_conn', Connection)
    def finalize():
        try:
            jobs.Worker().finish(job['id'], 'done', result={'ok': True})
        except BaseException as exc:
            errors.append(exc)
    def cancel():
        try:
            assert finalizer_read.wait(2)
            jobs.cancel_job(job['id'], {})
        except BaseException as exc:
            errors.append(exc)
        finally:
            cancel_finished.set()
    threads = [threading.Thread(target=finalize, name='finalizer'),
               threading.Thread(target=cancel, name='canceller')]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=3)
    assert not errors
    assert all(not thread.is_alive() for thread in threads)
    result = jobs.get_job(job['id'])
    assert (result['status'], result['cancel_requested']) in (
        ('done', False), ('cancelled', True))
