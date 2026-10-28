"""The background queue survives restarts and never duplicates active work."""
import threading
import time

import pytest
from local_test_client import TestClient

import app
import db
import jobs


@pytest.fixture
def storage(tmp_path, monkeypatch):
    jobs.stop_worker()
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'jobs.sqlite3')
    monkeypatch.setattr(jobs, '_HANDLERS', {})
    monkeypatch.setattr(jobs, '_SCHEDULER', None)
    db.init_db()
    jobs.init_jobs()
    yield
    jobs.stop_worker()


def wait_status(job_id, status, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        job = jobs.get_job(job_id)
        if job['status'] == status:
            return job
        time.sleep(0.01)
    pytest.fail(f"Job {job_id}: expected {status}, got {jobs.get_job(job_id)}")


def test_active_jobs_are_deduplicated_and_payloads_remain_structured(storage):
    first = jobs.enqueue('analyse', {'entry_id': 7}, dedupe_key='analyse:7')
    second = jobs.enqueue('analyse', {'entry_id': 7, 'depth': 12}, dedupe_key='analyse:7')
    assert first['id'] == second['id']
    assert second['payload'] == {'entry_id': 7}
    assert jobs.latest_for('analyse', {'entry_id': 7})['id'] == first['id']
    assert jobs.latest_for('analyse', {'entry_id': 8}) is None
    assert len(jobs.list_jobs()['jobs']) == 1


def test_worker_reports_progress_and_result_and_keeps_processing(storage):
    def handle(context, payload):
        context.progress(1, 2, 'Position 1 sur 2')
        context.progress(2, 2, 'Position 2 sur 2')
        return {'entry_id': payload['entry_id'], 'positions': 2}
    jobs.register('analyse', handle)
    first = jobs.enqueue('analyse', {'entry_id': 3})
    second = jobs.enqueue('analyse', {'entry_id': 4})
    jobs.start_worker()
    done = wait_status(first['id'], 'done')
    assert done['progress_current'] == done['progress_total'] == 2
    assert done['result'] == {'entry_id': 3, 'positions': 2}
    assert wait_status(second['id'], 'done')['result']['entry_id'] == 4


def test_cancel_queued_job_and_retry_has_new_identity(storage):
    job = jobs.enqueue('sync', {'account_id': 2}, dedupe_key='sync:2')
    cancelled = jobs.cancel_job(job['id'], {})['job']
    assert cancelled['status'] == 'cancelled'
    retried = jobs.retry_job(job['id'], {})['job']
    assert retried['id'] != job['id'] and retried['status'] == 'queued'
    assert retried['payload'] == job['payload']
    assert jobs.retry_job(job['id'], {})['job']['id'] == retried['id']


def test_cancel_running_job_signals_handler_and_does_not_complete(storage):
    entered = threading.Event()
    def handle(context, payload):
        context.progress(1, 8, 'Analyse en cours')
        entered.set()
        assert context.cancel_event.wait(3)
        context.check_cancelled()
        pytest.fail('Canceled handler continued')
    jobs.register('analyse', handle)
    job = jobs.enqueue('analyse', {'entry_id': 9})
    jobs.start_worker()
    assert entered.wait(2)
    jobs.cancel_job(job['id'], {})
    cancelled = wait_status(job['id'], 'cancelled')
    assert cancelled['result'] is None and cancelled['progress_current'] == 1


def test_server_shutdown_requeues_work_and_restart_finishes(storage):
    entered = threading.Event()
    def first(context, payload):
        context.progress(1, 2, 'Premier point sauvegardé')
        entered.set()
        assert context.cancel_event.wait(3)
        context.check_cancelled()
    jobs.register('analyse', first)
    job = jobs.enqueue('analyse', {'entry_id': 10}, dedupe_key='analyse:10')
    jobs.start_worker()
    assert entered.wait(2)
    jobs.stop_worker()
    interrupted = jobs.get_job(job['id'])
    assert interrupted['status'] == 'queued' and not interrupted['cancel_requested']
    assert interrupted['progress_current'] == 1
    jobs.register('analyse', lambda context, payload: {'resumed': True})
    jobs.start_worker()
    assert wait_status(job['id'], 'done')['result'] == {'resumed': True}


def test_startup_recovers_crashed_job_but_respects_saved_cancel(storage):
    unfinished = jobs.enqueue('analyse', {'entry_id': 11})
    cancelled = jobs.enqueue('analyse', {'entry_id': 12})
    with db.get_conn() as conn:
        conn.execute("UPDATE jobs SET status='running'")
        conn.execute('UPDATE jobs SET cancel_requested=1 WHERE id=?', (cancelled['id'],))
    visited = []
    jobs.register('analyse', lambda context, payload: visited.append(payload['entry_id']))
    jobs.start_worker()
    wait_status(unfinished['id'], 'done')
    assert jobs.get_job(cancelled['id'])['status'] == 'cancelled'
    assert visited == [11]


def test_failed_job_does_not_block_other_jobs_and_retry_works(storage):
    def handle(context, payload):
        if payload['entry_id'] == 1:
            raise ValueError('La partie a été modifiée.')
        return {'ok': True}
    jobs.register('analyse', handle)
    broken = jobs.enqueue('analyse', {'entry_id': 1})
    valid = jobs.enqueue('analyse', {'entry_id': 2})
    jobs.start_worker()
    assert wait_status(broken['id'], 'error')['error'] == 'La partie a été modifiée.'
    wait_status(valid['id'], 'done')
    jobs.register('analyse', lambda context, payload: {'fixed': True})
    retried = jobs.retry_job(broken['id'], {})['job']
    assert wait_status(retried['id'], 'done')['result'] == {'fixed': True}


def test_sync_jobs_take_priority_over_queued_analysis(storage):
    visited = []
    jobs.register('analyse', lambda context, payload: visited.append('analyse'))
    jobs.register('sync', lambda context, payload: visited.append('sync'))
    analysis = jobs.enqueue('analyse', {'entry_id': 1})
    sync = jobs.enqueue('sync', {'account_id': 1})
    jobs.start_worker()
    wait_status(analysis['id'], 'done')
    wait_status(sync['id'], 'done')
    assert visited == ['sync', 'analyse']


def test_jobs_api_is_private_and_validates_transitions(storage, monkeypatch):
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        job = jobs.enqueue('analyse', {'entry_id': 3})
        assert client.get('/api/jobs', headers={'Host': 'remote.invalid'}).status_code == 403
        assert client.post(f"/api/jobs/{job['id']}/cancel", json={}, headers={'Host': 'remote.invalid'}).status_code == 403
        assert client.get('/api/status').status_code == 200
        assert client.get('/api/jobs').json()['jobs'][0]['payload'] == {'entry_id': 3}
        assert client.post(f"/api/jobs/{job['id']}/retry", json={}).status_code == 409
        assert client.post(f"/api/jobs/{job['id']}/cancel", json={'unknown': True}).status_code == 400
        assert client.post(f"/api/jobs/{job['id']}/cancel", json={}).json()['job']['status'] == 'cancelled'
        assert client.post(f"/api/jobs/{job['id']}/retry", json={}).status_code == 200
        assert client.post('/api/jobs/9999/cancel', json={}).status_code == 404


def test_scheduler_and_maintenance_continue_while_long_analysis_runs(storage,monkeypatch):
    entered=threading.Event();release=threading.Event();ticks=[];maintenance=[]
    monkeypatch.setattr(jobs,'SCHEDULE_INITIAL_DELAY',.01)
    monkeypatch.setattr(jobs,'SCHEDULE_INTERVAL',.02)
    def handle(context,payload):
        entered.set()
        while not release.wait(.01):context.check_cancelled()
        return {'done':True}
    jobs.register('analyse',handle)
    jobs.set_scheduler(lambda:ticks.append(time.monotonic()))
    monkeypatch.setattr(jobs,'_MAINTENANCE',lambda:maintenance.append(time.monotonic()))
    job=jobs.enqueue('analyse',{'entry_id':1});jobs.start_worker()
    try:
        assert entered.wait(2)
        deadline=time.monotonic()+2
        while len(ticks)<3 and time.monotonic()<deadline:time.sleep(.01)
        assert len(ticks)>=3 and len(maintenance)>=3
        assert jobs.get_job(job['id'])['status']=='running'
    finally:release.set()
    wait_status(job['id'],'done')
    jobs.stop_worker();count=len(ticks);time.sleep(.05)
    assert len(ticks)==count


def test_broken_scheduler_does_not_suppress_maintenance(storage,monkeypatch):
    done=threading.Event()
    monkeypatch.setattr(jobs,'SCHEDULE_INITIAL_DELAY',.01)
    def broken():raise ValueError('isolated scheduler failure')
    jobs.set_scheduler(broken);monkeypatch.setattr(jobs,'_MAINTENANCE',done.set)
    jobs.start_worker();assert done.wait(2)
