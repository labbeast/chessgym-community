"""Plans change between tasks, never by killing an active engine/import."""
import threading
import json

import pytest
from fastapi import HTTPException

import db
import resource_policy as policy


@pytest.fixture
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'DATA_DIR',tmp_path);monkeypatch.setattr(db,'DB_PATH',tmp_path/'resource.sqlite3')
    monkeypatch.setattr(policy, 'hardware_snapshot', lambda: {'cpu_count': 32, 'cpu_known': True, 'memory_mb': 16384, 'memory_known': True})
    monkeypatch.setenv('CHESSGYM_IMPORT_WORKERS','12')
    monkeypatch.setattr(policy,'_CURRENT',policy.defaults());monkeypatch.setattr(policy,'_DESIRED',policy.defaults())
    monkeypatch.setattr(policy,'_ACTIVE',0);monkeypatch.setattr(policy,'_STARTING_IMPORT',0);monkeypatch.setattr(policy,'_IMPORT_ACTIVE',None)
    for key in ('_ACTIVE_THREADS', '_RESERVED_IMPORT_THREADS', '_WAITING_IMPORTS'):
        monkeypatch.setattr(policy, key, 0)
    monkeypatch.setattr(policy, '_ADJUSTED_FOR_HARDWARE', False)
    db.init_db()


def test_default_preserves_twelve_import_workers_and_two_single_thread_lanes(isolated):
    result=policy.get_settings()
    assert result['effective']==dict(engine_threads=1,engine_hash_mb=64,import_workers=12,total_threads=14,hash_mb=128)
    assert policy.import_workers(12)==12 and policy.import_workers(8)==8


def test_profile_changes_pending_during_import_then_apply_safely(isolated):
    active=[True];policy.set_import_active(lambda:active[0])
    result=policy.patch_settings({'profile':'economy'})
    assert result['pending'] and result['effective']['import_workers']==12
    assert policy.import_workers(12)==12
    active[0]=False
    current=policy.get_settings()
    assert not current['pending'] and current['effective']['import_workers']<=2
    assert current['effective']['engine_threads']*2+current['effective']['import_workers']<=current['effective']['total_threads']


def test_profile_waits_for_both_active_lanes_and_lease_release_idempotent(isolated):
    first=policy.acquire();second=policy.acquire()
    assert policy.patch_settings({'profile':'custom','total_threads':8,'import_workers':2,'hash_mb':1024})['pending']
    first.release();first.release()
    assert policy.get_settings()['pending'] and policy.get_settings()['active_searches']==1
    second.release()
    assert policy.settings()['engine_threads']==3 and policy.settings()['engine_hash_mb']==512
    assert policy.get_settings()['active_searches']==0


def test_plan_persists_loads_and_status_failure_defers(isolated):
    policy.patch_settings({'total_threads':10,'import_workers':4,'hash_mb':512})
    policy._CURRENT=dict(policy.DEFAULT);policy._DESIRED=dict(policy.DEFAULT)
    policy.load();assert policy.settings()['engine_threads']==3
    def broken():raise OSError('status unavailable')
    policy.set_import_active(broken)
    assert policy.patch_settings({'profile':'economy'})['pending']
    assert policy.settings()['engine_threads']==3


@pytest.mark.parametrize('patch',[{'total_threads':2},{'total_threads':True},{'hash_mb':31},{'import_workers':0},{'total_threads':4,'import_workers':3},{'profile':'fast'},{'surprise':1}])
def test_invalid_resource_plans_do_not_mutate_saved_settings(isolated,patch):
    before=policy.get_settings()
    with pytest.raises(HTTPException):policy.patch_settings(patch)
    assert policy.get_settings()==before
    with db.get_conn() as conn:assert conn.execute("SELECT COUNT(*) FROM preferences WHERE key='resource_settings'").fetchone()[0]==0


def test_import_startup_reservation_closes_pre_registration_race(isolated):
    active=[False];policy.set_import_active(lambda:active[0])
    with policy.import_reservation(12) as workers:
        assert workers==12
        assert policy.patch_settings({'profile':'economy'})['pending']
        active[0]=True
    assert policy.get_settings()['pending']
    active[0]=False
    assert not policy.get_settings()['pending']


def test_failed_import_start_releases_plan_without_poisoning_future_work(isolated):
    with pytest.raises(OSError):
        with policy.import_reservation(12):
            policy.patch_settings({'profile':'economy'})
            raise OSError('isolated spawn failure')
    assert not policy.get_settings()['pending']


def test_fresh_installation_defaults_are_conservative_but_explicit_operator_choice_wins(isolated,monkeypatch):
    monkeypatch.delenv('CHESSGYM_IMPORT_WORKERS')
    monkeypatch.setattr(policy.os,'cpu_count',lambda:32)
    policy.load()
    assert policy.get_settings()['import_workers']==4 and policy.get_settings()['total_threads']==6
    monkeypatch.setenv('CHESSGYM_IMPORT_WORKERS','12');policy.load()
    assert policy.get_settings()['import_workers']==12 and policy.get_settings()['total_threads']==14
    policy.patch_settings({'profile':'custom','import_workers':2,'total_threads':4})
    policy.load()
    assert policy.get_settings()['import_workers']==2 # Saved preference outranks environment.


def machine(monkeypatch, cpus, memory):
    monkeypatch.setattr(policy, 'hardware_snapshot', lambda: {
        'cpu_count': cpus, 'cpu_known': True, 'memory_mb': memory, 'memory_known': memory is not None})


def small_plan(monkeypatch, cpus=1):
    machine(monkeypatch, cpus, 4096)
    plan = policy.validate({'profile': 'custom', 'total_threads': cpus, 'import_workers': 1, 'hash_mb': 128})
    monkeypatch.setattr(policy, '_CURRENT', plan)
    monkeypatch.setattr(policy, '_DESIRED', dict(plan))


def test_response_exposes_machine_limits_and_conservative_recommendations(isolated):
    result = policy.get_settings()
    assert result['hardware']['cpu_count'] == 32
    assert result['hardware']['memory_mb'] == 16384
    assert result['limits']['total_threads'] == {'min': 1, 'max': 32}
    assert result['limits']['reserved_memory_mb'] == 3277
    assert result['limits']['hash_mb'] == {'min': 32, 'max': 13107}
    assert result['recommendations']['balanced'] == dict(profile='balanced', total_threads=8, hash_mb=1024, import_workers=2)
    assert result['recommendations']['economy']['total_threads'] == 4
    # A recommendation is not an arbitrary maximum: a larger safe cache is accepted.
    assert policy.validate({'hash_mb': 8192})['hash_mb'] == 8192


@pytest.mark.parametrize('patch', [{'total_threads': 33}, {'hash_mb': 13108}, {'import_workers': 31}])
def test_hardware_limits_are_enforced_without_writing_invalid_preferences(isolated, patch):
    before = policy.get_settings()
    with pytest.raises(HTTPException) as failure:
        policy.patch_settings(patch)
    assert failure.value.status_code == 400
    assert policy.get_settings() == before
    with db.get_conn() as conn:
        assert not conn.execute("SELECT value FROM preferences WHERE key='resource_settings'").fetchone()


@pytest.mark.parametrize('cpus', [1, 2, 3, 4, 8, 32])
def test_profiles_never_exceed_detected_cpu_capacity(isolated, monkeypatch, cpus):
    machine(monkeypatch, cpus, 8192)
    for profile in ('economy', 'balanced'):
        selected = policy.validate({'profile': profile})
        assert 1 <= selected['total_threads'] <= cpus
        assert selected['import_workers'] <= cpus
        assert selected['hash_mb'] <= 8192 - 2048
        assert policy.effective(selected)['engine_threads'] >= 1
    assert policy.defaults()['total_threads'] <= cpus
    assert policy.defaults()['import_workers'] <= cpus


def test_unknown_specs_fail_conservatively(isolated, monkeypatch):
    monkeypatch.setattr(policy, 'hardware_snapshot', lambda: {'cpu_count': 1, 'cpu_known': False, 'memory_mb': None, 'memory_known': False})
    policy.load()
    result = policy.get_settings()
    assert result['hardware']['cpu_known'] is False and result['hardware']['memory_known'] is False
    assert result['total_threads'] == 1 and result['import_workers'] == 1
    assert result['limits']['hash_mb']['max'] == 128
    with pytest.raises(HTTPException):
        policy.patch_settings({'hash_mb': 129})


def test_tiny_memory_hosts_keep_only_minimum_engine_caches(isolated, monkeypatch):
    machine(monkeypatch, 2, 512)
    plan = policy.validate({'profile': 'balanced'})
    assert plan['hash_mb'] == 2
    assert policy.effective(plan)['engine_hash_mb'] == 1
    assert policy.limits()['reserved_memory_mb'] == 510


def test_restoring_a_larger_host_plan_preserves_it_on_disk_but_fits_this_host(isolated, monkeypatch):
    saved = {'profile': 'custom', 'total_threads': 32, 'hash_mb': 32768, 'import_workers': 16}
    with db.get_conn() as conn:
        conn.execute("INSERT INTO preferences(key,value) VALUES('resource_settings',?)", (json.dumps(saved),))
    machine(monkeypatch, 2, 4096)
    policy.load()
    result = policy.get_settings()
    assert result['total_threads'] == 2 and result['import_workers'] == 1 and result['hash_mb'] == 2048
    assert result['adjusted_for_hardware'] is True
    with db.get_conn() as conn:
        assert json.loads(conn.execute("SELECT value FROM preferences WHERE key='resource_settings'").fetchone()[0]) == saved
    assert not policy.patch_settings({'hash_mb': 128})['adjusted_for_hardware']


def test_single_cpu_serializes_engine_leases_without_oversubscription(isolated, monkeypatch):
    small_plan(monkeypatch)
    first = policy.acquire()
    entered, finished = threading.Event(), threading.Event()
    errors = []
    def second():
        try:
            lease = policy.acquire(timeout=2)
            try:
                assert policy._ACTIVE_THREADS == 1
                entered.set()
            finally:
                lease.release()
        except BaseException as exc:
            errors.append(exc)
        finally:
            finished.set()
    worker = threading.Thread(target=second)
    worker.start()
    try:
        assert not entered.wait(.05)
    finally:
        first.release()
    assert finished.wait(3)
    worker.join()
    assert entered.is_set() and not errors
    assert policy._ACTIVE == policy._ACTIVE_THREADS == 0


def test_import_waits_for_cpu_then_blocks_another_engine(isolated, monkeypatch):
    small_plan(monkeypatch)
    first = policy.acquire()
    entered, finish, done = threading.Event(), threading.Event(), threading.Event()
    errors = []
    def importing():
        try:
            with policy.import_reservation(1, timeout=2) as workers:
                assert workers == 1 and policy._ACTIVE_THREADS == 0
                entered.set()
                assert finish.wait(3)
        except BaseException as exc:
            errors.append(exc)
        finally:
            done.set()
    worker = threading.Thread(target=importing)
    worker.start()
    try:
        assert not entered.wait(.05)
        first.release()
        assert entered.wait(2)
        with pytest.raises(HTTPException) as failure:
            policy.acquire(timeout=.02)
        assert failure.value.status_code == 503
    finally:
        first.release()
        finish.set()
    assert done.wait(3)
    worker.join()
    assert not errors
    assert policy._RESERVED_IMPORT_THREADS == policy._WAITING_IMPORTS == 0
    policy.acquire().release()


def test_two_cpus_share_exactly_between_import_and_engine(isolated, monkeypatch):
    small_plan(monkeypatch, 2)
    with policy.import_reservation(1):
        first = policy.acquire()
        try:
            assert policy._ACTIVE_THREADS + policy._RESERVED_IMPORT_THREADS == 2
            with pytest.raises(HTTPException):
                policy.acquire(timeout=.02)
        finally:
            first.release()


def test_waiting_cancellation_releases_no_unowned_capacity(isolated, monkeypatch):
    from engine import AnalysisCancelled
    small_plan(monkeypatch)
    first = policy.acquire()
    cancel = threading.Event()
    cancel.set()
    try:
        with pytest.raises(AnalysisCancelled):
            policy.acquire(cancel=cancel)
        with pytest.raises(AnalysisCancelled):
            with policy.import_reservation(1, cancel=cancel):
                pytest.fail('Cancelled importer started')
        assert policy._ACTIVE_THREADS == 1 and policy._ACTIVE == 1
        assert policy._WAITING_IMPORTS == policy._STARTING_IMPORT == policy._RESERVED_IMPORT_THREADS == 0
    finally:
        first.release()


def test_managed_import_can_reserve_after_its_busy_flag_is_set(isolated, monkeypatch):
    small_plan(monkeypatch)
    policy.set_import_active(lambda: True)
    with policy.import_reservation(1, timeout=.1) as workers:
        assert workers == 1
        with pytest.raises(HTTPException):
            policy.acquire(timeout=.02)
    policy.set_import_active(None)
    policy.acquire().release()


def test_zero_wait_still_grants_available_capacity(isolated, monkeypatch):
    small_plan(monkeypatch)
    first = policy.acquire(timeout=0)
    try:
        with pytest.raises(HTTPException):
            policy.acquire(timeout=0)
    finally:
        first.release()
    with policy.import_reservation(1, timeout=0) as workers:
        assert workers == 1
        with pytest.raises(HTTPException):
            with policy.import_reservation(1, timeout=0):
                pytest.fail('Busy budget accepted a second importer')
    assert policy._RESERVED_IMPORT_THREADS == policy._WAITING_IMPORTS == 0
