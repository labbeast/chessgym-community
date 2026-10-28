"""Host-local catalogue isolation, explicit selection and failure safety."""
from copy import deepcopy
import json
from pathlib import Path
import threading

import chess
from fastapi import FastAPI, HTTPException
from local_test_client import TestClient
import pytest

import db
import engine
import engine_catalog as catalog
import engine_catalog_api as api
import maia_engine

REAL_PROBE = catalog.probe_native
REAL_DISCOVERY = catalog.native_discovery


@pytest.fixture
def registry(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(catalog, 'ROOT', tmp_path)
    monkeypatch.setattr(catalog, '_CACHE', None)
    for key in ('CHESSGYM_ENGINE', 'CHESSGYM_MAIA3_ROOT', 'CHESSGYM_MAIA3_MODEL'):
        monkeypatch.delenv(key, raising=False)
    native = tmp_path / 'engines' / 'stockfish' / 'stockfish.exe'
    native.parent.mkdir(parents=True)
    native.write_bytes(b'fake executable')
    monkeypatch.setattr(catalog, 'native_discovery', lambda: str(native))
    monkeypatch.setattr(catalog, 'probe_native', lambda path: {'name': 'Test UCI', 'version': 'test 1', 'capabilities': catalog._capabilities(False)})
    return tmp_path, native


def extra_engine(root, name='other.exe'):
    path = root / name
    path.write_bytes(b'other executable')
    return str(path)


def test_seed_is_lazy_and_does_not_select_downloaded_engine(registry):
    root, native = registry
    assert engine.binary_path() == str(native)
    assert not catalog.catalog_path().exists()
    state = catalog.snapshot()
    assert state['selected'] == {'analysis': 'stockfish-default', 'maia': None}
    assert state['engines'][0]['active'] == ['analysis']
    assert engine.binary_path() == str(native)


def test_selection_add_edit_and_unregister_never_delete_files(registry):
    root, native = registry
    path = extra_engine(root)
    state = catalog.add('Other', path)
    item = state['engines'][-1]
    assert engine.binary_path() == str(native)
    state = catalog.select({'analysis': item['id']})
    assert engine.binary_path() == path
    assert engine.status()['name'] == 'Other'
    assert engine.status()['capabilities']['skills'] == [20]
    with pytest.raises(HTTPException) as exc:
        catalog.unregister(item['id'])
    assert exc.value.status_code == 409
    catalog.select({'analysis': 'stockfish-default'})
    catalog.unregister(item['id'])
    assert Path(path).read_bytes() == b'other executable'
    assert len(catalog.snapshot()['engines']) == 1


def test_disabled_and_removed_never_return_through_discovery(registry):
    _, native = registry
    catalog.snapshot()
    catalog.select({'analysis': None})
    catalog.unregister('stockfish-default')
    assert native.is_file()
    assert engine.binary_path() is None
    assert not engine.status()['available']
    catalog._CACHE = None
    assert catalog.snapshot()['engines'] == []
    assert engine.binary_path() is None


def test_broken_catalog_does_not_silently_start_another_engine(registry):
    catalog.snapshot()
    catalog.catalog_path().write_text('{not json', encoding='utf-8')
    with pytest.raises(HTTPException) as exc:
        engine.binary_path()
    assert exc.value.status_code == 503
    assert catalog.catalog_path().read_text() == '{not json'


@pytest.mark.parametrize('value', ['stockfish.exe', 'C:\\not-here.exe', '', 'bad\npath', 'https://example.org/engine.exe'])
def test_bad_paths_never_probed(registry, monkeypatch, value):
    monkeypatch.setattr(catalog, 'probe_native', lambda path: pytest.fail('must not execute'))
    with pytest.raises(HTTPException) as exc:
        catalog.add('Test', value)
    assert exc.value.status_code == 422


def test_probe_failure_leaves_catalog_unchanged(registry, monkeypatch):
    root, _ = registry
    before = catalog.snapshot()
    def fail(path):
        raise HTTPException(422, 'bad executable')
    monkeypatch.setattr(catalog, 'probe_native', fail)
    with pytest.raises(HTTPException):
        catalog.add('Bad', extra_engine(root))
    assert catalog.snapshot() == before


def test_path_edit_uses_validation_and_retains_name(registry):
    root, _ = registry
    item = catalog.add('My engine', extra_engine(root))['engines'][-1]
    other = extra_engine(root, 'new.exe')
    state = catalog.edit(item['id'], {'path': other})
    changed = state['engines'][-1]
    assert changed['name'] == 'My engine' and changed['path'] == other
    assert Path(item['path']).is_file()


def test_duplicate_file_rejected(registry):
    root, _ = registry
    path = extra_engine(root)
    catalog.add('One', path)
    with pytest.raises(HTTPException) as exc:
        catalog.add('Two', path)
    assert exc.value.status_code == 409


def test_revision_prevents_stale_selection(registry):
    original = catalog.snapshot()
    catalog.edit('stockfish-default', {'name': 'Renamed'})
    with pytest.raises(HTTPException) as exc:
        catalog.select({'analysis': None}, original['revision'])
    assert exc.value.status_code == 409
    assert catalog.snapshot()['selected']['analysis'] == 'stockfish-default'


def test_validation_race_does_not_overwrite_newer_edit(registry, monkeypatch):
    root, _ = registry
    item = catalog.add('Other', extra_engine(root))['engines'][-1]
    def probe(path):
        catalog.edit(item['id'], {'name': 'Concurrent change'})
        return {'name': 'Native', 'capabilities': catalog._capabilities(False)}
    monkeypatch.setattr(catalog, 'probe_native', probe)
    with pytest.raises(HTTPException) as exc:
        catalog.edit(item['id'], {'path': extra_engine(root, 'replacement.exe')})
    assert exc.value.status_code == 409
    assert catalog.snapshot()['engines'][-1]['name'] == 'Concurrent change'


def test_fingerprint_changes_when_external_binary_changes(registry):
    root, native = registry
    before = engine.status()['identity']
    native.write_bytes(b'a different executable of different size')
    assert engine.status()['identity'] != before


def make_maia(root, model='maia3-79m'):
    package = root / 'maia-package'
    (package / 'models').mkdir(parents=True)
    (package / 'runtime').mkdir()
    (package / 'models' / f'{model}.pt').write_bytes(b'checkpoint')
    (package / 'runtime' / 'python.exe').write_bytes(b'python')
    (package / 'manifest.json').write_text(json.dumps({'python': 'runtime/python.exe', 'models': {model: {'path': f'models/{model}.pt'}}}))
    return {'id': model + '-version', 'kind': 'maia3', 'name': 'Maia 79M', 'model': model, 'path': str(package), 'version': 'version', 'managed_root': str(package)}


def test_managed_install_never_activates_and_maia_selection_uses_its_root(registry):
    root, native = registry
    record = catalog.register_managed(make_maia(root))
    assert record['kind'] == 'maia'
    assert catalog.snapshot()['selected']['maia'] is None
    catalog.select({'maia': record['id']})
    assert maia_engine.root_path() == Path(record['path'])
    assert maia_engine.selected_model() == 'maia3-79m'
    assert maia_engine.status()['name'] == 'Maia 79M'
    assert maia_engine.binary_path().endswith('python.exe')
    assert maia_engine.model_path().endswith('maia3-79m.pt')
    catalog.select({'maia': None})
    assert maia_engine.selected_model() is None
    assert not maia_engine.status()['available']
    assert engine.binary_path() == str(native)


def test_wrong_kind_cannot_be_selected_for_analysis(registry):
    root, _ = registry
    item = catalog.register_managed(make_maia(root))
    with pytest.raises(HTTPException) as exc:
        catalog.select({'analysis': item['id']})
    assert exc.value.status_code == 422


def test_managed_path_cannot_be_edited(registry):
    root, _ = registry
    item = catalog.register_managed({'id': 'managed', 'kind': 'uci', 'name': 'Managed', 'path': extra_engine(root)})
    with pytest.raises(HTTPException) as exc:
        catalog.edit(item['id'], {'path': extra_engine(root, 'new.exe')})
    assert exc.value.status_code == 422


def test_catalog_does_not_use_portable_database_preferences(registry, monkeypatch):
    monkeypatch.setattr(db, 'get_conn', lambda: pytest.fail('catalog must not write library DB'))
    catalog.snapshot()
    catalog.select({'analysis': None})
    assert catalog.catalog_path().name == 'engine-catalog.json'


class FakeInstallations:
    def catalog(self): return []
    def status(self, job_id=None): return None
    def start_job(self, catalog_id):
        if catalog_id != 'stockfish-latest': raise ValueError('unknown')
        return {'id': 'job', 'state': 'running'}
    def check_updates(self): return {'errors': [], 'stockfish': {'version': '19'}}


@pytest.fixture
def client(registry, monkeypatch):
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[api.require_user] = lambda: {'id': 1, 'username': 'owner'}
    monkeypatch.setattr(api, '_MANAGER', FakeInstallations())
    with TestClient(app) as client:
        yield client


def test_api_catalog_and_owner_protection(client):
    assert client.get('/api/engines/catalog').status_code == 200
    client.app.dependency_overrides[api.require_user] = lambda: {'id': 2, 'username': 'guest'}
    assert client.get('/api/engines/catalog').status_code == 403
    assert client.post('/api/engines', json={'name': 'X', 'path': 'x'}).status_code == 403


def test_api_schema_and_explicit_disable(client, registry):
    state = client.get('/api/engines/catalog').json()
    assert client.patch('/api/engines/selection', json={'analysis': None, 'expected_revision': state['revision']}).status_code == 200
    assert client.delete('/api/engines/stockfish-default').status_code == 200
    assert engine.binary_path() is None
    assert client.post('/api/engines', json={'name': 'X', 'path': 'x', 'args': ['bad']}).status_code == 422
    assert client.patch('/api/engines/selection', json={}).status_code == 422
    assert client.patch('/api/engines/missing', json={}).status_code == 422


def test_api_jobs_routes_precede_engine_id(client):
    assert client.post('/api/engines/install', json={'catalog_id': 'stockfish-latest'}).json()['id'] == 'job'
    assert client.post('/api/engines/install', json={'catalog_id': 'nope'}).status_code == 422
    assert client.get('/api/engines/jobs/missing').status_code == 404
    assert client.post('/api/engines/updates').status_code == 200

def test_native_probe_uses_only_executable_and_checks_legal_move(registry, monkeypatch):
    root, _ = registry
    probe = REAL_PROBE
    calls = []
    class Runtime:
        id = {'name': 'Unit UCI 1'}
        options = {'Threads': object(), 'Hash': object()}
        def configure(self, values): calls.append(('configure', values))
        def play(self, board, limit):
            calls.append(('play', limit.time))
            return type('Reply', (), {'move': chess.Move.from_uci('e2e4')})()
        def close(self): calls.append(('close',))
    def spawn(command, **kwargs):
        calls.append(('spawn', command, kwargs))
        return Runtime()
    monkeypatch.setattr(chess.engine.SimpleEngine, 'popen_uci', spawn)
    path = extra_engine(root)
    result = probe(path)
    assert calls[0][1] == [path] and 'shell' not in calls[0][2]
    assert calls[0][2]['timeout'] == 4
    assert calls[-1] == ('close',)
    assert result['capabilities']['skills'] == [20]
    monkeypatch.setattr(Runtime, 'play', lambda *args: type('Reply', (), {'move': chess.Move.from_uci('e2e5')})())
    with pytest.raises(HTTPException) as exc:
        probe(path)
    assert exc.value.status_code == 422 and calls[-1] == ('close',)


def test_discovery_keeps_bundled_version_and_ignores_new_managed_download(registry, monkeypatch):
    root, native = registry
    managed = root / 'engines' / 'managed' / 'new-version' / 'stockfish.exe'
    managed.parent.mkdir(parents=True)
    managed.write_bytes(b'new engine')
    assert REAL_DISCOVERY() == str(native)
    native.unlink()
    monkeypatch.setattr(catalog.shutil, 'which', lambda _: None)
    assert REAL_DISCOVERY() is None
