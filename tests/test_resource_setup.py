"""Resource onboarding batches, opt-in scheduling and owner-only API."""
from contextlib import contextmanager
from copy import deepcopy
import json
import threading

from fastapi import FastAPI, HTTPException
from local_test_client import TestClient
import pytest

import engine_catalog_api
import resource_setup as service
import resource_setup_api as api


class Registry:
    def __init__(self):
        self.value = {'revision': 0, 'engines': [], 'selected': {'analysis': None, 'maia': None}}
        self.selections = []
        self.reject_selection = False

    def snapshot(self):
        return deepcopy(self.value)

    def register(self, record):
        self.value['engines'] = [item for item in self.value['engines'] if item['id'] != record['id']]
        self.value['engines'].append(deepcopy(record))
        self.value['revision'] += 1

    def select(self, patch, revision):
        if revision != self.value['revision'] or self.reject_selection:
            raise HTTPException(409, 'Selection changed')
        self.value['selected'].update(patch)
        self.value['revision'] += 1
        self.selections.append(patch)


class Engines:
    def __init__(self, registry):
        self.registry = registry
        self.calls = []
        self.busy = False
        self.failures = set()
        self.after_install = None
        self.job = None

    def catalog(self):
        return [{'id': key, 'name': key, 'available': True} for key in
                ('stockfish-latest', 'maia3-79m', 'maia3-5m')]

    def start_job(self, resource_id):
        self.calls.append(resource_id)
        if resource_id in self.failures:
            self.job = {'id': 'engine-job', 'state': 'failed', 'error': 'Download failed'}
        else:
            maia = resource_id.startswith('maia3-')
            record = {'id': resource_id + '-new', 'kind': 'maia' if maia else 'uci',
                      'name': resource_id, 'version': 'new', 'managed': True, 'available': True}
            if maia:
                record['model'] = resource_id
            self.registry.register(record)
            if self.after_install:
                self.after_install()
            self.job = {'id': 'engine-job', 'state': 'completed', 'engine': record}
        return deepcopy(self.job)

    def status(self, job_id):
        assert job_id == self.job['id']
        return deepcopy(self.job)


class Databases:
    def __init__(self):
        self.calls = []
        self.installed = set()
        self.failures = set()
        self.before_install = None

    def catalog(self):
        return [{'id': key, 'name': key, 'available': True, 'installed': key in self.installed,
                 'managed': key in self.installed} for key in ('lichess-puzzles', 'lichess-games')]

    def install(self, resource_id, progress):
        self.calls.append(resource_id)
        if self.before_install:
            self.before_install()
        progress('Import', 50)
        if resource_id in self.failures:
            raise ValueError('Import failed')
        self.installed.add(resource_id)
        return {'version': '2026-10'}


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr(service.ResourceSetupManager, '_analysis_active', lambda self: False)
    registry = Registry()
    engines = Engines(registry)
    databases = Databases()
    result = service.ResourceSetupManager(tmp_path, engines=engines, databases=databases, registry=registry)
    yield result
    result.close()


def finish(manager):
    manager.thread.join(timeout=5)
    assert not manager.thread.is_alive(), 'Resource job did not terminate'
    return manager.snapshot()['job']


def reopen(manager):
    return service.ResourceSetupManager(manager.path.parent, engines=manager.engines,
                                        databases=manager.databases, registry=manager.registry)


def scheduler_database(monkeypatch, *, analysing=False):
    monkeypatch.setattr(service.ResourceSetupManager, '_analysis_active', lambda self: analysing)
    class Connection:
        def execute(self, sql):
            assert "kind='analyse'" in sql
            return self
        def fetchone(self):
            return (1,) if analysing else None
    @contextmanager
    def connect():
        yield Connection()
    monkeypatch.setattr(service.db, 'get_conn', connect)


def test_defaults_and_status_do_not_install_or_schedule_network(manager, monkeypatch):
    monkeypatch.setattr(service.db, 'get_conn', lambda: pytest.fail('Disabled scheduler queried database'))
    snapshot = manager.snapshot()
    assert snapshot['settings'] == {'automatic_updates': False, 'interval_hours': 168}
    assert snapshot['setup_complete'] is False
    assert snapshot['job'] is None
    assert len(snapshot['resources']) == 5
    manager.tick()
    assert not manager.engines.calls and not manager.databases.calls
    assert not manager.path.exists()


def test_install_configures_roles_and_preserves_successful_siblings(manager):
    manager.databases.failures.add('lichess-puzzles')
    manager.start(['stockfish-latest', 'lichess-puzzles', 'maia3-79m'])
    job = finish(manager)
    assert job['state'] == 'failed'
    assert [(item['id'], item['state']) for item in job['results']] == [
        ('stockfish-latest', 'completed'), ('lichess-puzzles', 'failed'), ('maia3-79m', 'completed')]
    assert manager.registry.value['selected'] == {'analysis': 'stockfish-latest-new', 'maia': 'maia3-79m-new'}
    assert set(manager.state['managed']) == {'stockfish-latest', 'maia3-79m'}
    manager.databases.failures.clear()
    manager.start(['lichess-puzzles'])
    assert finish(manager)['state'] == 'completed'
    assert set(manager.state['managed']) == {'stockfish-latest', 'maia3-79m', 'lichess-puzzles'}


def test_failed_engine_install_does_not_change_selection(manager):
    manager.registry.value['selected']['analysis'] = 'previous'
    manager.engines.failures.add('stockfish-latest')
    manager.start(['stockfish-latest'])
    assert finish(manager)['state'] == 'failed'
    assert manager.registry.value['selected']['analysis'] == 'previous'
    assert not manager.state['managed']


def test_updates_do_not_reinstall_resources_removed_by_owner(manager):
    manager.start(['stockfish-latest', 'lichess-games'])
    assert finish(manager)['state'] == 'completed'
    manager.registry.value.update(engines=[], selected={'analysis': None, 'maia': None})
    manager.databases.installed.clear()
    manager.start(updating=True)
    assert finish(manager)['resources'] == []
    assert manager.engines.calls == ['stockfish-latest']
    assert manager.databases.calls == ['lichess-games']


def test_user_selection_during_download_wins(manager):
    def choose_other():
        manager.registry.select({'analysis': 'user-choice'}, manager.registry.value['revision'])
    manager.engines.after_install = choose_other
    manager.start(['stockfish-latest'])
    result = finish(manager)['results'][0]
    assert result['state'] == 'completed' and result['activated'] is False
    assert manager.registry.value['selected']['analysis'] == 'user-choice'


def test_selection_revision_conflict_keeps_install_available(manager):
    manager.registry.reject_selection = True
    manager.start(['stockfish-latest'])
    result = finish(manager)['results'][0]
    assert result['state'] == 'completed' and result['activated'] is False
    assert manager.registry.value['selected']['analysis'] is None
    assert manager.state['managed']['stockfish-latest']['engine_id'] == 'stockfish-latest-new'


def test_update_does_not_enable_a_disabled_role(manager):
    manager.start(['stockfish-latest'])
    finish(manager)
    manager.registry.select({'analysis': None}, manager.registry.value['revision'])
    manager.start(updating=True)
    result = finish(manager)['results'][0]
    assert result['activated'] is False
    assert manager.registry.value['selected']['analysis'] is None


@pytest.mark.parametrize('resources', [None, [], ['unknown'], [42], ['stockfish-latest', 'stockfish-latest'],
                                       ['maia3-5m', 'maia3-79m'], ['https://example.org/engine']])
def test_invalid_selection_cannot_start_a_job(manager, resources):
    with pytest.raises(ValueError):
        manager.start(resources)
    assert not manager.engines.calls and not manager.databases.calls
    assert manager.state['job'] is None


def test_busy_engine_installer_rejects_batch(manager):
    manager.engines.busy = True
    with pytest.raises(RuntimeError):
        manager.start(['lichess-puzzles'])
    assert manager.state['job'] is None


def test_completion_and_preferences_survive_restart(manager):
    manager.configure({'automatic_updates': True, 'interval_hours': 48})
    manager.complete()
    restored = reopen(manager)
    assert restored.state['setup_complete'] is True
    assert restored.state['settings'] == {'automatic_updates': True, 'interval_hours': 48}


def test_interrupted_job_is_persistently_retryable(manager):
    manager.state['job'] = {'id': 'interrupted', 'state': 'running', 'results': []}
    manager._save()
    restored = reopen(manager)
    assert restored.state['job']['state'] == 'failed'
    assert 'redémarré' in restored.state['job']['error']
    assert json.loads(manager.path.read_text(encoding='utf8'))['job']['state'] == 'failed'
    restored.start(['lichess-puzzles'])
    assert finish(restored)['state'] == 'completed'
    restored.close()


def test_due_schedule_persists_and_does_not_repeat_on_restart(manager, monkeypatch):
    scheduler_database(monkeypatch)
    monkeypatch.setattr(service.time, 'time', lambda: 1_000_000)
    manager.databases.installed.add('lichess-puzzles')
    manager.configure({'automatic_updates': True, 'interval_hours': 24})
    manager.tick()
    assert finish(manager)['automatic'] is True
    assert manager.databases.calls == ['lichess-puzzles']
    restored = reopen(manager)
    restored.tick()
    assert restored.thread is None
    monkeypatch.setattr(service.time, 'time', lambda: 1_000_000 + 24 * 3600)
    restored.tick()
    finish(restored)
    assert manager.databases.calls == ['lichess-puzzles', 'lichess-puzzles']
    restored.close()


def test_failed_automatic_attempt_does_not_retry_on_every_tick(manager, monkeypatch):
    scheduler_database(monkeypatch)
    manager.databases.installed.add('lichess-puzzles')
    manager.databases.failures.add('lichess-puzzles')
    manager.configure({'automatic_updates': True})
    manager.tick()
    assert finish(manager)['state'] == 'failed'
    manager.tick()
    assert manager.databases.calls == ['lichess-puzzles']


def test_scheduler_defers_while_game_report_is_queued_or_running(manager, monkeypatch):
    scheduler_database(monkeypatch, analysing=True)
    manager.configure({'automatic_updates': True})
    manager.tick()
    assert manager.thread is None
    assert manager.state['last_attempt'] is None


def test_scheduler_does_not_wait_for_download_and_rejects_overlap(manager, monkeypatch):
    scheduler_database(monkeypatch)
    manager.databases.installed.add('lichess-puzzles')
    entered, release = threading.Event(), threading.Event()
    def pause():
        entered.set()
        assert release.wait(timeout=5)
    manager.databases.before_install = pause
    manager.configure({'automatic_updates': True})
    try:
        manager.tick()
        assert entered.wait(timeout=2)
        assert manager.thread.is_alive()
        with pytest.raises(RuntimeError):
            manager.start(['stockfish-latest'])
        manager.tick()
        assert manager.databases.calls == ['lichess-puzzles']
    finally:
        release.set()
    assert finish(manager)['state'] == 'completed'


def test_shutdown_prevents_more_work(manager):
    manager.close()
    with pytest.raises(RuntimeError):
        manager.start(['stockfish-latest'])
    manager.tick()
    assert manager.thread is None


def test_activation_waits_for_report_and_survives_restart(manager, monkeypatch):
    old = {'id': 'stockfish-old', 'kind': 'uci', 'name': 'Stockfish', 'managed': True, 'available': True}
    manager.registry.register(old)
    manager.registry.select({'analysis': old['id']}, manager.registry.value['revision'])
    monkeypatch.setattr(service.ResourceSetupManager, '_analysis_active', lambda self: True)
    manager.start(updating=True)
    result = finish(manager)['results'][0]
    assert result['activation_pending'] is True
    assert manager.registry.value['selected']['analysis'] == 'stockfish-old'
    restored = reopen(manager)
    restored.tick()
    assert restored.state['pending_activation']['analysis']['id'] == 'stockfish-latest-new'
    monkeypatch.setattr(service.ResourceSetupManager, '_analysis_active', lambda self: False)
    restored.tick()
    assert manager.registry.value['selected']['analysis'] == 'stockfish-latest-new'
    assert not restored.state['pending_activation']
    restored.close()


def test_pending_activation_does_not_overwrite_later_user_selection(manager, monkeypatch):
    manager.state['pending_activation'] = {'analysis': {'previous': 'stockfish-old', 'id': 'stockfish-new'}}
    manager.registry.value['selected']['analysis'] = 'user-choice'
    manager.tick()
    assert manager.registry.value['selected']['analysis'] == 'user-choice'
    assert not manager.state['pending_activation']


def test_changed_selection_does_not_claim_pending_activation(manager, monkeypatch):
    old = {'id': 'stockfish-old', 'kind': 'uci', 'name': 'Stockfish', 'managed': True, 'available': True}
    manager.registry.register(old)
    manager.registry.select({'analysis': old['id']}, manager.registry.value['revision'])
    manager.engines.after_install = lambda: manager.registry.select(
        {'analysis': None}, manager.registry.value['revision'])
    monkeypatch.setattr(service.ResourceSetupManager, '_analysis_active', lambda self: True)
    manager.start(updating=True)
    result = finish(manager)['results'][0]
    assert result['activation_pending'] is False
    assert not manager.state.get('pending_activation')


@pytest.fixture
def client(manager, monkeypatch):
    application = FastAPI()
    application.include_router(api.router)
    application.dependency_overrides[engine_catalog_api.require_user] = lambda: {'id': 1}
    monkeypatch.setattr(service, 'manager', lambda: manager)
    with TestClient(application) as result:
        yield result


def test_owner_can_configure_complete_and_start_install(client, manager):
    assert client.get('/api/setup-resources').status_code == 200
    reply = client.patch('/api/setup-resources/settings', json={'automatic_updates': True, 'interval_hours': 24})
    assert reply.status_code == 200 and reply.json()['settings']['automatic_updates'] is True
    assert client.post('/api/setup-resources/complete', json={}).json()['setup_complete'] is True
    assert client.post('/api/setup-resources/install', json={'resources': ['lichess-puzzles']}).status_code == 200
    assert finish(manager)['state'] == 'completed'
    assert client.post('/api/setup-resources/update', json={}).status_code == 200
    finish(manager)


@pytest.mark.parametrize('payload', [{}, {'automatic_updates': None}, {'automatic_updates': 'yes'},
                                      {'interval_hours': True}, {'interval_hours': 23},
                                      {'interval_hours': 721}, {'unknown': True}])
def test_api_invalid_preferences_leave_state_unchanged(client, manager, payload):
    before = manager.snapshot()['settings']
    assert client.patch('/api/setup-resources/settings', json=payload).status_code == 422
    assert manager.state['settings'] == before


@pytest.mark.parametrize('method,path,payload', [
    ('get', '', None), ('patch', '/settings', {'automatic_updates': True}),
    ('post', '/install', {'resources': ['stockfish-latest']}), ('post', '/update', {}),
    ('post', '/complete', {})])
def test_guest_cannot_read_or_mutate_host_configuration(client, manager, method, path, payload):
    client.app.dependency_overrides[engine_catalog_api.require_user] = lambda: {'id': 2}
    response = client.request(method, '/api/setup-resources' + path, json=payload)
    assert response.status_code == 403
    assert manager.state['setup_complete'] is False
    assert manager.thread is None


def test_api_unknown_resource_and_busy_job_are_distinct(client, manager):
    assert client.post('/api/setup-resources/install', json={'resources': ['unknown']}).status_code == 422
    manager.engines.busy = True
    assert client.post('/api/setup-resources/install', json={'resources': ['lichess-puzzles']}).status_code == 409
