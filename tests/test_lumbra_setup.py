"""Owner-only Lumbra setup orchestration and explicit master-source selection."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import threading

from fastapi import FastAPI
from local_test_client import TestClient
import pytest

from accounts_api import require_user
import database_resources
import db
import explorer
import library_service
import resource_setup as service
import resource_setup_api as api
from test_resource_setup import Engines, Registry, finish


ELITE = 'lumbra-otb-elite'
COMPLETE = 'lumbra-otb-complete'


class Databases:
    def __init__(self):
        self.installed = set()
        self.calls = []
        self.before_install = None
        self.fail = False

    def catalog(self):
        return [{'id': key, 'name': key, 'available': True,
                 'installed': key in self.installed,
                 **({'installation_mode': 'browser-download', 'category': 'database'}
                    if key.startswith('lumbra-') else {})}
                for key in ('lichess-puzzles', ELITE, COMPLETE)]

    def install(self, resource_id, progress, *, source_path=None):
        self.calls.append((resource_id, source_path))
        if self.before_install:
            self.before_install()
        if self.fail:
            raise ValueError('Archive invalide')
        progress('Import miniature', 50)
        with db.get_conn() as conn:
            base_id = conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)',
                                  (resource_id, library_service.now())).lastrowid
        self.installed.add(resource_id)
        return {'base_id': base_id, 'version': 'test', 'count': 1}


@pytest.fixture
def manager(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'data' / 'personal.sqlite3')
    db.init_db()
    monkeypatch.setattr(service.ResourceSetupManager, '_analysis_active', lambda self: False)
    registry = Registry()
    result = service.ResourceSetupManager(db.DATA_DIR, engines=Engines(registry),
        databases=Databases(), registry=registry)
    yield result
    result.close()


@pytest.fixture
def archive(tmp_path):
    path = tmp_path / 'Lumbra.pgn'
    path.write_text('[Event "Fixture"]\n\n1. e4 *\n', encoding='utf-8')
    return str(path)


@pytest.fixture
def client(manager, monkeypatch):
    app = FastAPI()
    app.include_router(api.router)
    monkeypatch.setattr(service, 'manager', lambda: manager)
    with TestClient(app) as result:
        yield result


def owner(client):
    client.app.dependency_overrides[require_user] = lambda: {'id': 1, 'username': 'owner'}


def test_import_route_requires_local_owner(client, manager, archive):
    payload = {'resource_id': ELITE, 'source_path': archive}
    assert client.post('/api/setup-resources/import', json=payload, headers={'Host': 'remote.example'}).status_code == 403
    client.app.dependency_overrides[require_user] = lambda: {'id': 2, 'username': 'other'}
    assert client.post('/api/setup-resources/import', json=payload).status_code == 403
    assert not manager.databases.calls
    assert manager.state['job'] is None
    owner(client)
    assert client.post('/api/setup-resources/import', json=payload).status_code == 200
    assert finish(manager)['state'] == 'completed'


@pytest.mark.parametrize('patch', [
    {'source_path': ''}, {'source_path': '  '}, {'source_path': 'relative.pgn'},
    {'source_path': 'https://lumbrasgigabase.com/file.7z'},
    {'source_path': 'C:\\not-present-fixture.pgn'},
    {'resource_id': 'unknown'}, {'resource_id': 'lichess-puzzles'},
    {'use_as_masters': 'true'}, {'unexpected': True},
])
def test_invalid_import_requests_cannot_start_job(client, manager, archive, patch):
    owner(client)
    response = client.post('/api/setup-resources/import', json={
        'resource_id': ELITE, 'source_path': archive, **patch})
    assert response.status_code == 422
    assert not manager.databases.calls
    assert manager.state['job'] is None


def test_existing_relative_file_and_symlink_are_not_resolved_away(manager, archive, monkeypatch):
    monkeypatch.chdir(Path(archive).parent)
    with pytest.raises(ValueError):
        manager.start_import(ELITE, Path(archive).name)
    original = Path.is_symlink
    monkeypatch.setattr(Path, 'is_symlink', lambda path: str(path) == archive or original(path))
    with pytest.raises(ValueError):
        manager.start_import(ELITE, archive)
    assert manager.state['job'] is None


def test_import_route_reports_busy_without_replacing_active_job(client, manager, archive):
    owner(client)
    manager.engines.busy = True
    response = client.post('/api/setup-resources/import', json={'resource_id': ELITE, 'source_path': archive})
    assert response.status_code == 409
    assert manager.state['job'] is None


@pytest.mark.parametrize('ids', [[ELITE], [COMPLETE], ['lichess-puzzles', ELITE]])
def test_browser_resources_cannot_enter_automatic_download_batch(manager, ids):
    with pytest.raises(ValueError, match='site officiel'):
        manager.start(ids)
    assert not manager.databases.calls
    assert manager.state['job'] is None


def test_installed_browser_resources_are_excluded_from_update_and_schedule(manager):
    manager.databases.installed.update({ELITE, COMPLETE, 'lichess-puzzles'})
    manager.state['managed'].update({ELITE: {}, COMPLETE: {}})
    manager.start(updating=True)
    job = finish(manager)
    assert job['resources'] == ['lichess-puzzles']
    assert manager.databases.calls == [('lichess-puzzles', None)]
    manager.databases.calls.clear()
    manager.configure({'automatic_updates': True, 'interval_hours': 24})
    manager.state['last_attempt'] = None
    manager.tick()
    assert finish(manager)['automatic']
    assert manager.databases.calls == [('lichess-puzzles', None)]


def test_no_master_selection_without_explicit_option(manager, archive):
    before = explorer.patch_settings({'master_source': 'none', 'source': 'masters'})
    manager.start_import(ELITE, archive)
    job = finish(manager)
    assert job['state'] == 'completed'
    assert 'masters_selected' not in job['results'][0]
    assert explorer.get_settings() == before
    assert manager.databases.calls == [(ELITE, archive)]


def test_explicit_master_selection_changes_only_master_source_and_ids(client, manager, archive):
    owner(client)
    before = explorer.patch_settings({'source': 'masters', 'ratings': [2200, 2500],
                                     'master_local_filters': {'rating_min': 2400}})
    response = client.post('/api/setup-resources/import', json={
        'resource_id': ELITE, 'source_path': archive, 'use_as_masters': True})
    assert response.status_code == 200
    result = finish(manager)['results'][0]
    assert result['masters_selected']
    expected = {**before, 'master_source': 'local', 'master_base_ids': [result['base_id']]}
    assert explorer.get_settings() == expected


def test_new_user_choice_during_import_wins(manager, archive):
    explorer.patch_settings({'master_source': 'masters'})
    manager.databases.before_install = lambda: explorer.patch_settings({'master_source': 'none'})
    manager.start_import(ELITE, archive, use_as_masters=True)
    result = finish(manager)['results'][0]
    assert result['state'] == 'completed' and not result['masters_selected']
    assert explorer.get_settings()['master_source'] == 'none'


def test_other_preferences_changed_during_import_are_preserved(manager, archive):
    manager.databases.before_install = lambda: explorer.patch_settings({'source': 'masters', 'ratings': [2500]})
    manager.start_import(ELITE, archive, use_as_masters=True)
    result = finish(manager)['results'][0]
    after = explorer.get_settings()
    assert result['masters_selected']
    assert after['source'] == 'masters' and after['ratings'] == [2500]


def test_failed_import_leaves_master_preferences_and_managed_registry_unchanged(manager, archive):
    before = explorer.patch_settings({'master_source': 'none'})
    manager.databases.fail = True
    manager.start_import(ELITE, archive, use_as_masters=True)
    result = finish(manager)
    assert result['state'] == 'failed'
    assert explorer.get_settings() == before
    assert ELITE not in manager.state['managed']


def test_master_compare_and_write_hold_same_database_transaction(manager, monkeypatch):
    with db.get_conn() as conn:
        base_id = conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)',
                              ('Installed', library_service.now())).lastrowid
    previous = {'master_source': 'masters', 'master_base_ids': []}
    actual_read = explorer._read_settings
    checked = []

    def read_with_competing_writer(conn, bases):
        result = actual_read(conn, bases)
        assert conn.in_transaction
        # A separate device's update must serialize after the decision/write,
        # rather than entering the gap between a read and an unconditional patch.
        with sqlite3.connect(db.DB_PATH, timeout=.01) as competing:
            with pytest.raises(sqlite3.OperationalError, match='locked'):
                competing.execute('BEGIN IMMEDIATE')
        checked.append(True)
        return result

    monkeypatch.setattr(explorer, '_read_settings', read_with_competing_writer)
    assert manager._select_imported_masters(base_id, previous)
    assert checked == [True]


def test_database_router_preserves_source_path_and_rejects_local_lichess(monkeypatch, tmp_path):
    calls = []

    class Provider:
        def __init__(self, root):
            assert root == tmp_path
        def catalog(self):
            return [{'id': type(self).__name__}]
        def install(self, identity, progress, **kwargs):
            calls.append((type(self).__name__, identity, kwargs))
            return {'ok': True}

    class Lichess(Provider):
        pass
    class Lumbra(Provider):
        pass

    monkeypatch.setattr(database_resources, 'LichessResources', Lichess)
    monkeypatch.setattr(database_resources, 'LumbraResources', Lumbra)
    router = database_resources.DatabaseResources(tmp_path)
    assert router.catalog() == [{'id': 'Lichess'}, {'id': 'Lumbra'}]
    router.install(ELITE, lambda *args: None, source_path='local.pgn')
    router.install('lichess-puzzles', lambda *args: None)
    assert calls == [('Lumbra', ELITE, {'source_path': 'local.pgn'}), ('Lichess', 'lichess-puzzles', {})]
    with pytest.raises(ValueError):
        router.install('lichess-puzzles', lambda *args: None, source_path='local.pgn')
    assert len(calls) == 2
