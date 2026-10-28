import pytest
from local_test_client import TestClient
import app
import db
import training


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'sound.sqlite3')
    db.init_db();training.init_training();
    client = TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000))
    assert client.get('/api/status').status_code == 200
    yield client
    client.close()


def test_sound_preferences_persist_partial_updates_without_touching_review_defaults(client):
    initial = client.get('/api/preferences').json()
    assert initial['sound']['navigation'] is False
    changed = client.patch('/api/preferences', json={'sound': {'enabled': False, 'volume': .2}}).json()
    assert changed['sound'] == {**initial['sound'], 'enabled': False, 'volume': .2}
    assert changed['review_defaults'] == initial['review_defaults']
    changed = client.patch('/api/preferences', json={'sound': {'navigation': True}}).json()
    assert changed['sound']['navigation'] is True and changed['sound']['enabled'] is False
    assert client.get('/api/preferences').json()['sound'] == changed['sound']


@pytest.mark.parametrize('patch', [{'volume': -1}, {'volume': 101}, {'volume': True}, {'moves': 'false'}, {'enabled': None}, {'unknown': True}, []])
def test_invalid_sound_patch_is_atomic(client, patch):
    initial = client.get('/api/preferences').json()
    assert client.patch('/api/preferences', json={'language': 'en', 'sound': patch}).status_code == 400
    assert client.get('/api/preferences').json() == initial


def test_sound_changes_require_login(client):
    client.cookies.clear()
    assert client.patch('/api/preferences', json={'sound': {'enabled': True}}, headers={'Host': 'remote.invalid'}).status_code == 403
