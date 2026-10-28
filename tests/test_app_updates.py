"""Guarded application releases and offline rollback, with isolated fixtures."""
from contextlib import closing
import io
from pathlib import Path
import sqlite3
import tarfile
import threading

from fastapi import FastAPI
from local_test_client import TestClient
import pytest

import app_updates as service
import app_updates_api as api
import app_update_worker as worker
import backup_service
import engine_catalog_api


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr(worker, 'installation', lambda root: {'supported': True, 'reason': None, 'commit': 'a' * 40})
    monkeypatch.setenv('CHESSGYM_SUPERVISED', '1')
    monkeypatch.setattr(service, '_RESTART', lambda: None)
    monkeypatch.setattr(service, 'background_busy', lambda: False)
    value = service.AppUpdateManager(tmp_path / 'source', tmp_path / 'data')
    yield value
    value.close()


def finish(manager):
    manager.thread.join(5)
    assert not manager.thread.is_alive()
    return manager.snapshot()


def test_defaults_never_check_network(manager, monkeypatch):
    monkeypatch.setattr(worker, 'latest_release', lambda *args: pytest.fail('network'))
    assert manager.snapshot()['settings']['automatic_updates'] is False
    manager.tick()
    assert not manager.path.exists()


def test_check_is_async_and_detects_release_without_install(manager, monkeypatch):
    entered, release = threading.Event(), threading.Event()
    def check(*args):
        entered.set()
        assert release.wait(3)
        return {'tag': 'v1.0.0', 'version': '1.0.0'}
    monkeypatch.setattr(worker, 'latest_release', check)
    monkeypatch.setattr(worker, 'prepare', lambda *args: pytest.fail('installation'))
    manager.start()
    assert entered.wait(1)
    assert manager.snapshot()['job']['state'] == 'checking'
    with pytest.raises(RuntimeError):
        manager.start()
    release.set()
    state = finish(manager)
    assert state['available']['version'] == '1.0.0'
    assert state['job']['state'] == 'completed'
    assert not state['restart_required']


def test_install_stages_and_verifies_backup_before_restart(manager, monkeypatch):
    plan = {'id': 'b' * 32, 'version': '1.0.0', 'previous_commit': 'a' * 40}
    monkeypatch.setattr(worker, 'latest_release', lambda *args: {'version': '1.0.0'})
    monkeypatch.setattr(worker, 'prepare', lambda *args: plan)
    calls = []
    monkeypatch.setattr(backup_service, 'build_archive', lambda path: calls.append(('build', path)))
    monkeypatch.setattr(backup_service, 'verify_archive', lambda path: calls.append(('verify', path)))
    manager.start(install=True)
    state = finish(manager)
    assert state['job']['state'] == 'ready'
    assert state['restart_required']
    assert [kind for kind, _ in calls] == ['build', 'verify']
    assert worker.read_json(manager.path.parent / 'pending.json') == plan


def test_failed_backup_never_publishes_restart_plan(manager, monkeypatch):
    monkeypatch.setattr(worker, 'latest_release', lambda *args: {'version': '1.0.0'})
    monkeypatch.setattr(worker, 'prepare', lambda *args: {'id': 'b' * 32})
    monkeypatch.setattr(backup_service, 'build_archive', lambda path: None)
    monkeypatch.setattr(backup_service, 'verify_archive', lambda path: (_ for _ in ()).throw(ValueError('bad backup')))
    manager.start(install=True)
    assert finish(manager)['job']['state'] == 'failed'
    assert not manager.state['restart_required']
    assert not (manager.path.parent / 'pending.json').exists()


def test_dirty_installation_is_explained_without_network(manager, monkeypatch):
    monkeypatch.setattr(worker, 'installation', lambda root: {'supported': False, 'reason': 'Local changes'})
    assert manager.snapshot()['reason'] == 'Local changes'
    with pytest.raises(ValueError, match='Local changes'):
        manager.start(install=True)
    assert manager.thread is None


def test_schedule_persists_opt_in_and_interval(manager, monkeypatch):
    monkeypatch.setattr(worker, 'latest_release', lambda *args: None)
    monkeypatch.setattr(service.time, 'time', lambda: 1000000)
    manager.configure({'automatic_updates': True, 'interval_hours': 24})
    manager.tick()
    finish(manager)
    restored = service.AppUpdateManager(manager.root, manager.data_root)
    restored.tick()
    assert restored.thread is None
    assert restored.state['last_checked'] == 1000000
    monkeypatch.setattr(service.time, 'time', lambda: 1000000 + 24 * 3600)
    restored.tick()
    assert finish(restored)['job']['state'] == 'completed'
    restored.close()


def ready(manager, monkeypatch):
    manager.state.update(restart_required=True, job={'id': 'job', 'state': 'ready'})
    manager._save()
    monkeypatch.setattr(worker, '_plan', lambda path: {'previous_commit': 'a' * 40})
    monkeypatch.setattr(worker, 'require_installation', lambda *args: 'a' * 40)


def test_auto_restart_waits_for_idle_and_background_jobs(manager, monkeypatch):
    ready(manager, monkeypatch)
    calls = []
    monkeypatch.setattr(service, '_RESTART', lambda: calls.append('restart'))
    monkeypatch.setattr(service.time, 'monotonic', lambda: 1000)
    monkeypatch.setattr(service, '_LAST_ACTIVITY', 900)
    manager.restart(automatic=True)
    assert not calls
    monkeypatch.setattr(service, '_LAST_ACTIVITY', 0)
    monkeypatch.setattr(service, 'background_busy', lambda: True)
    with pytest.raises(RuntimeError):
        manager.restart(automatic=True)
    assert not calls
    monkeypatch.setattr(service, 'background_busy', lambda: False)
    assert manager.restart(automatic=True)['job']['state'] == 'restarting'
    assert calls == ['restart']


def test_manual_restart_needs_managed_launcher(manager, monkeypatch):
    ready(manager, monkeypatch)
    monkeypatch.setattr(service, '_RESTART', None)
    assert not manager.snapshot()['supported']
    with pytest.raises(ValueError):
        manager.restart()


def test_restart_marks_interrupted_download_retryable(manager):
    manager.state['job'] = {'id': 'job', 'state': 'running'}
    manager._save()
    restored = service.AppUpdateManager(manager.root, manager.data_root)
    assert restored.state['job']['state'] == 'failed'
    restored.close()


@pytest.mark.parametrize('value', ['latest', '../main', 'v1.2.3;danger', '1.2', None])
def test_release_versions_reject_arbitrary_refs(value):
    with pytest.raises(ValueError):
        worker.version_key(value)


def test_release_order_and_stable_channel(monkeypatch, tmp_path):
    monkeypatch.setattr(worker, 'require_installation', lambda root: 'a' * 40)
    monkeypatch.setattr(worker, '_origin', lambda root: worker.REPOSITORY)
    monkeypatch.setattr(worker, 'git', lambda *args, **kwargs: '\n'.join(
        'a' * 40 + '\trefs/tags/' + tag for tag in ('v1.1.0', 'v2.0.0-beta.1', 'v1.2.0', 'v0.9.0', 'junk')))
    assert worker.latest_release(tmp_path, '1.0.0')['tag'] == 'v1.2.0'
    assert worker.latest_release(tmp_path, '1.0.0-alpha.1')['tag'] == 'v2.0.0-beta.1'
    assert worker.latest_release(tmp_path, '2.0.0') is None


@pytest.mark.parametrize('name', ['../outside', '/absolute', 'data/chessgym.sqlite3', '.venv/bin/python',
                                 'engines/stockfish', '.ENV.password', 'a\\bad', 'C:/drive'])
def test_archive_cannot_overwrite_resources(tmp_path, name):
    archive = tmp_path / 'source.tar'
    with tarfile.open(archive, 'w') as bundle:
        member = tarfile.TarInfo(name)
        member.size = 4
        bundle.addfile(member, io.BytesIO(b'data'))
    with pytest.raises(ValueError):
        worker._extract_archive(archive, tmp_path / 'sources')
    assert not (tmp_path / 'sources').exists()


def test_archive_rejects_links_before_writing(tmp_path):
    archive = tmp_path / 'source.tar'
    with tarfile.open(archive, 'w') as bundle:
        good = tarfile.TarInfo('version.py')
        good.size = 4
        bundle.addfile(good, io.BytesIO(b'data'))
        bad = tarfile.TarInfo('link')
        bad.type = tarfile.SYMTYPE
        bad.linkname = '../outside'
        bundle.addfile(bad)
    with pytest.raises(ValueError):
        worker._extract_archive(archive, tmp_path / 'sources')
    assert not (tmp_path / 'sources').exists()


def test_dependencies_disallow_unpinned_or_external_inputs(tmp_path):
    (tmp_path / 'requirements.txt').write_text('-c requirements.lock.txt\nfastapi==1.2.3\n')
    (tmp_path / 'requirements.lock.txt').write_text('fastapi==1.2.3\n')
    worker._validate_requirements(tmp_path)
    for line in ('fastapi', '-r ../../private.txt', '--index-url https://example.test', 'pkg @ https://example.test/pkg'):
        (tmp_path / 'requirements.txt').write_text(line)
        with pytest.raises(ValueError):
            worker._validate_requirements(tmp_path)


def test_runtime_pointer_is_confined(tmp_path):
    path = tmp_path / 'app-updates' / 'runtime.json'
    worker.write_json(path, {'id': 'b' * 32, 'python': str(tmp_path / 'untrusted.exe')})
    with pytest.raises(ValueError):
        worker.selected_python(tmp_path, 'fallback')
    worker.write_json(path, None)
    assert worker.selected_python(tmp_path, 'fallback') == 'fallback'


@pytest.fixture
def client(manager, monkeypatch):
    application = FastAPI()
    application.include_router(api.router)
    application.dependency_overrides[engine_catalog_api.require_user] = lambda: {'id': 1}
    monkeypatch.setattr(service, 'manager', lambda: manager)
    with TestClient(application) as value:
        yield value


@pytest.mark.parametrize('method,path,body', [('get', '', None), ('post', '/check', {}), ('post', '/install', {}),
                                           ('post', '/restart', {}), ('patch', '/settings', {'automatic_updates': True})])
def test_only_owner_can_manage_application(client, method, path, body):
    client.app.dependency_overrides[engine_catalog_api.require_user] = lambda: {'id': 2}
    assert client.request(method, '/api/app-updates' + path, json=body).status_code == 403


@pytest.mark.parametrize('patch', [{}, {'automatic_updates': None}, {'automatic_updates': 'yes'},
                                  {'interval_hours': 1}, {'interval_hours': True}, {'unknown': 1}])
def test_bad_settings_leave_choices_intact(client, manager, patch):
    assert client.patch('/api/app-updates/settings', json=patch).status_code == 422
    assert not manager.state['settings']['automatic_updates']


def test_owner_can_check_and_opt_in(client, manager, monkeypatch):
    monkeypatch.setattr(worker, 'latest_release', lambda *args: None)
    assert client.get('/api/app-updates').status_code == 200
    assert client.patch('/api/app-updates/settings', json={'automatic_updates': True}).status_code == 200
    assert client.post('/api/app-updates/check', json={}).status_code == 200
    assert finish(manager)['job']['state'] == 'completed'


@pytest.fixture
def repository(tmp_path, monkeypatch):
    root = tmp_path / 'checkout'
    root.mkdir()
    worker.git(root, 'init', '-b', 'main')
    worker.git(root, 'config', 'user.email', 'fixture@example.invalid')
    worker.git(root, 'config', 'user.name', 'Isolated updater test')
    worker.git(root, 'remote', 'add', 'origin', worker.REPOSITORY)
    (root / '.gitignore').write_text('data/\nengines/\n')
    (root / 'app.py').write_text('old code\n')
    worker.git(root, 'add', '.')
    worker.git(root, 'commit', '-m', 'old release')
    previous = worker.git(root, 'rev-parse', 'HEAD')
    (root / 'app.py').write_text('new code\n')
    worker.git(root, 'commit', '-am', 'new release')
    target = worker.git(root, 'rev-parse', 'HEAD')
    worker.git(root, 'reset', '--keep', previous)
    data = root / 'data'
    data.mkdir()
    monkeypatch.setattr(backup_service.db, 'DATA_DIR', data)
    monkeypatch.setattr(backup_service.db, 'DB_PATH', data / 'chessgym.sqlite3')
    with closing(sqlite3.connect(data / 'chessgym.sqlite3')) as conn:
        conn.execute('CREATE TABLE personal(value TEXT)')
        conn.execute("INSERT INTO personal VALUES('original')")
        conn.commit()
    (root / 'engines').mkdir()
    (root / 'engines' / 'keep.txt').write_text('installed engine')
    identity = 'c' * 32
    interpreter = worker.python_path(data / 'app-updates' / 'runtimes' / identity)
    interpreter.parent.mkdir(parents=True)
    interpreter.write_text('fake runtime, never executed')
    plan = {'id': identity, 'version': '1.0.0', 'commit': target, 'previous_commit': previous,
            'python': str(interpreter), 'phase': 'prepared'}
    worker.write_json(data / 'app-updates' / 'pending.json', plan)
    return root, data, plan


def personal(path):
    with closing(sqlite3.connect(path)) as conn:
        return conn.execute('SELECT value FROM personal').fetchone()[0]


def test_offline_switch_and_rollback_keep_data_and_engine_files(repository):
    root, data, pending = repository
    applied = worker.apply_pending(root, data)
    assert (root / 'app.py').read_text() == 'new code\n'
    assert personal(data / 'chessgym.sqlite3') == 'original'
    assert personal(Path(applied['database_backup'])) == 'original'
    assert worker.selected_python(data, 'old') == pending['python']
    with closing(sqlite3.connect(data / 'chessgym.sqlite3')) as conn:
        conn.execute("UPDATE personal SET value='migration'")
        conn.commit()
    worker.rollback(root, data, applied)
    assert (root / 'app.py').read_text() == 'old code\n'
    assert worker.git(root, 'rev-parse', 'HEAD') == pending['previous_commit']
    assert personal(data / 'chessgym.sqlite3') == 'original'
    assert (root / 'engines' / 'keep.txt').read_text() == 'installed engine'
    assert worker.selected_python(data, 'old') == 'old'


def test_offline_switch_refuses_last_minute_source_edits(repository):
    root, data, _ = repository
    (root / 'app.py').write_text('my local edits')
    with pytest.raises(ValueError, match='modifiés'):
        worker.apply_pending(root, data)
    assert (root / 'app.py').read_text() == 'my local edits'
    assert personal(data / 'chessgym.sqlite3') == 'original'


def test_partial_runtime_switch_rolls_code_back_before_relaunch(repository, monkeypatch):
    root, data, pending = repository
    original = worker.write_json
    failed = False
    def failing(path, value):
        nonlocal failed
        if Path(path).name == 'runtime.json' and not failed:
            failed = True
            raise OSError('simulated unavailable disk')
        return original(path, value)
    monkeypatch.setattr(worker, 'write_json', failing)
    with pytest.raises(OSError):
        worker.apply_pending(root, data)
    assert worker.git(root, 'rev-parse', 'HEAD') == pending['previous_commit']
    assert (root / 'app.py').read_text() == 'old code\n'
    assert worker.selected_python(data, 'old') == 'old'


def test_resume_after_supervisor_crash_keeps_original_snapshot(repository):
    root, data, pending = repository
    applied = worker.apply_pending(root, data)
    with closing(sqlite3.connect(data / 'chessgym.sqlite3')) as conn:
        conn.execute("UPDATE personal SET value='migration'")
        conn.commit()
    resumed = worker.apply_pending(root, data)
    assert resumed['database_backup'] == applied['database_backup']
    assert personal(Path(resumed['database_backup'])) == 'original'
    assert personal(data / 'chessgym.sqlite3') == 'migration'


def test_supervisor_rolls_back_failed_new_server_and_relaunches_old(repository, monkeypatch):
    root, data, pending = repository
    monkeypatch.setenv('CHESSGYM_DATA_DIR', str(data))
    worker.write_json(data / 'app-updates' / 'settings.json',
                      {'schema': 1, 'restart_required': True, 'settings': dict(service.DEFAULTS),
                       'job': {'id': 'test', 'state': 'ready'}})
    calls = []
    class Child:
        def wait(self, timeout=None):
            return 0
        def poll(self):
            return None
    original_popen = worker.subprocess.Popen
    def launch(arguments, **kwargs):
        if arguments[-1] != '--serve':
            return original_popen(arguments, **kwargs)
        calls.append(arguments[0])
        return Child()
    monkeypatch.setattr(worker.subprocess, 'Popen', launch)
    monkeypatch.setattr(worker, '_wait_healthy', lambda *args: False)
    monkeypatch.setattr(worker, 'stop_child', lambda child: None)
    assert worker.supervise(root) == 0
    assert len(calls) == 2 and calls[0] == pending['python']
    assert calls[1] != calls[0]
    assert (root / 'app.py').read_text() == 'old code\n'
    assert personal(data / 'chessgym.sqlite3') == 'original'
    state = worker.read_json(data / 'app-updates' / 'settings.json')
    assert state['job']['state'] == 'failed'
    assert not state['restart_required']
    assert not (data / 'app-updates' / 'pending.json').exists()


def test_validation_gate_blocks_until_supervisor_accepts_update(tmp_path, monkeypatch):
    monkeypatch.setattr(service.db, 'DATA_DIR', tmp_path)
    monkeypatch.setenv('CHESSGYM_UPDATE_VALIDATING', 'nonce')
    pending = tmp_path / 'app-updates' / 'pending.json'
    worker.write_json(pending, {})
    assert service.validation_pending()
    pending.unlink()
    assert not service.validation_pending()


def test_real_managed_launcher_serves_owner_api_and_stops_its_tree(tmp_path):
    import http.cookiejar
    import json
    import os
    import socket
    import subprocess
    import sys
    import time
    import urllib.request

    root = Path(worker.__file__).resolve().parent
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    data = tmp_path / 'isolated-server'
    env = dict(os.environ, CHESSGYM_DATA_DIR=str(data), CHESSGYM_HOST='127.0.0.1',
               CHESSGYM_PORT=str(port), CHESSGYM_ENGINE=str(tmp_path / 'no-engine'),
               CHESSGYM_MAIA3_ROOT=str(tmp_path / 'no-maia'))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                         urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    base = f'http://127.0.0.1:{port}'
    with (tmp_path / 'server.log').open('wb') as log:
        child = subprocess.Popen([sys.executable, str(root / 'run.py')], cwd=root, env=env,
                                 stdout=log, stderr=log,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        try:
            deadline = time.monotonic() + 25
            while True:
                try:
                    with opener.open(base + '/api/status', timeout=1) as response:
                        assert json.load(response)['setup_required'] is False
                    break
                except OSError:
                    if time.monotonic() >= deadline or child.poll() is not None:
                        pytest.fail('Managed server did not start: ' + (tmp_path / 'server.log').read_text(errors='replace'))
                    time.sleep(.1)
            with opener.open(base + '/api/app-updates', timeout=5) as response:
                snapshot = json.load(response)
            assert snapshot['restart_supported'] is True
            assert snapshot['current_version'] == service.VERSION
            assert snapshot['settings']['automatic_updates'] is False
        finally:
            worker.stop_child(child)
    with pytest.raises(OSError):
        opener.open(base + '/api/status', timeout=1)





@pytest.mark.parametrize('remote', [
    'https://github.com/labbeast/chessgym-community.git',
    'https://github.com/labbeast/chessgym-community',
    'git@github.com:labbeast/chessgym-community.git',
])
def test_public_repository_is_an_allowed_update_origin(tmp_path, monkeypatch, remote):
    monkeypatch.setattr(worker, 'git', lambda *args, **kwargs: remote)
    assert worker._origin(tmp_path) == remote


@pytest.mark.parametrize('remote', [
    'https://github.com/vincentinogec/chess-gym.git',
    'https://github.com/another-owner/chessgym-community.git',
    'https://github.com/labbeast/chessgym-community.git/extra',
])
def test_other_repositories_cannot_supply_application_updates(tmp_path, monkeypatch, remote):
    monkeypatch.setattr(worker, 'git', lambda *args, **kwargs: remote)
    with pytest.raises(ValueError, match='dépôt officiel'):
        worker._origin(tmp_path)
