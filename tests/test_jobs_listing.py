"""Large import queues must not hide running work or recent sync outcomes."""
import json

import pytest

import db
import jobs


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'jobs-listing.sqlite3')
    db.init_db()
    jobs.init_jobs()


def insert(conn, kind, status, identifier, *, result=None):
    cursor = conn.execute('''INSERT INTO jobs(kind,status,payload,result,created_at,updated_at)
        VALUES(?,?,?,?,?,?)''', (kind, status, json.dumps({'entry_id': identifier}),
        json.dumps(result) if result is not None else None, jobs.now(), jobs.now()))
    return cursor.lastrowid


def test_running_job_and_recent_sync_remain_visible_among_501_queued_analyses(store):
    with db.get_conn() as conn:
        running_id = insert(conn, 'analyse', 'running', 1)
        queued_ids = [insert(conn, 'analyse', 'queued', i + 2) for i in range(501)]
        sync_id = insert(conn, 'sync', 'done', 1, result={'imported': 501})
    listed = jobs.list_jobs()
    assert listed['counts'] == {'running': 1, 'queued': 501, 'done': 1, 'error': 0, 'cancelled': 0}
    assert len(listed['jobs']) == 101
    assert listed['jobs'][0]['id'] == running_id
    assert [job['id'] for job in listed['jobs'][1:100]] == queued_ids[:99]
    assert listed['jobs'][-1]['id'] == sync_id
    assert listed['jobs'][-1]['result'] == {'imported': 501}
    assert len({job['id'] for job in listed['jobs']}) == len(listed['jobs'])


def test_running_then_queued_sync_priority_and_recent_history_bounded_to_120(store):
    with db.get_conn() as conn:
        running_id = insert(conn, 'analyse', 'running', 1)
        queued_ids = [insert(conn, 'analyse', 'queued', i + 2) for i in range(501)]
        queued_sync_id = insert(conn, 'sync', 'queued', 1)
        completed_ids = [insert(conn, 'analyse', 'done', 1000 + i) for i in range(25)]
        error_ids = [insert(conn, 'analyse', 'error', 2000 + i) for i in range(5)]
        cancelled_ids = [insert(conn, 'analyse', 'cancelled', 3000 + i) for i in range(3)]
        sync_done_id = insert(conn, 'sync', 'done', 1)
    listed = jobs.list_jobs()
    assert listed['counts'] == {'running': 1, 'queued': 502, 'done': 26, 'error': 5, 'cancelled': 3}
    assert len(listed['jobs']) == 120
    assert [job['id'] for job in listed['jobs'][:2]] == [running_id, queued_sync_id]
    assert [job['id'] for job in listed['jobs'][2:100]] == queued_ids[:98]
    recent_ids = sorted([*completed_ids, *error_ids, *cancelled_ids, sync_done_id], reverse=True)[:20]
    assert [job['id'] for job in listed['jobs'][100:]] == recent_ids
    assert listed['jobs'][100]['id'] == sync_done_id
    assert all(job['status'] in ('running', 'queued') for job in listed['jobs'][:100])
    assert all(job['status'] in ('done', 'error', 'cancelled') for job in listed['jobs'][100:])
    assert sum(listed['counts'].values()) == 537


def test_empty_job_counts_are_explicit(store):
    assert jobs.list_jobs() == {'jobs': [], 'counts': {'running': 0, 'queued': 0, 'done': 0, 'error': 0, 'cancelled': 0}}
