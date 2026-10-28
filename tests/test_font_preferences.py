"""Global text size persists independently and rejects malformed settings."""
import json

import pytest
from local_test_client import TestClient

import app
import db
import training


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'font-preferences.sqlite3')
    db.init_db()
    training.init_training()

    client = TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000))
    response = client.get('/api/status')
    assert response.status_code == 200, response.text
    yield client
    client.close()


def test_font_size_default_allowed_values_and_persistence(owner):
    initial = owner.get('/api/preferences').json()
    assert initial['font_scale'] == 100
    for scale in (110, 125, 150, 100):
        response = owner.patch('/api/preferences', json={'font_scale': scale})
        assert response.status_code == 200, response.text
        assert response.json() == {**initial, 'font_scale': scale}
        with db.get_conn() as conn:
            stored = conn.execute("SELECT value FROM preferences WHERE key='font_scale'").fetchone()[0]
        assert json.loads(stored) == scale

    assert owner.patch('/api/preferences', json={'font_scale': 125}).status_code == 200
    assert owner.patch('/api/preferences', json={'theme': 'sage'}).status_code == 200
    db.init_db()
    assert owner.get('/api/preferences').json() == {**initial, 'font_scale': 125, 'theme': 'sage'}


def test_font_size_invalid_values_are_atomic(owner):
    assert owner.patch('/api/preferences', json={'font_scale': 125}).status_code == 200
    before = owner.get('/api/preferences').json()
    for scale in (None, True, False, '150', 150.0, 125.5, [], {}, 0, 99, 101, 200):
        response = owner.patch('/api/preferences', json={'theme': 'sage', 'font_scale': scale})
        assert response.status_code == 400, response.text
        assert owner.get('/api/preferences').json() == before

    # Other invalid fields cannot save a valid font size either.
    response = owner.patch('/api/preferences', json={'font_scale': 150, 'sound': {'volume': -1}})
    assert response.status_code == 400, response.text
    assert owner.get('/api/preferences').json() == before


def test_malformed_stored_font_size_falls_back_without_changing_other_preferences(owner):
    assert owner.patch('/api/preferences', json={'theme': 'sage'}).status_code == 200
    for stored in ('broken-json', 'null', 'true', 'false', '"125"', '125.0', '[]', '{}', '0', '200'):
        with db.get_conn() as conn:
            conn.execute('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', ('font_scale', stored))
        response = owner.get('/api/preferences')
        assert response.status_code == 200, response.text
        assert response.json()['font_scale'] == 100
        assert response.json()['theme'] == 'sage'


def test_font_size_changes_require_login(owner):
    owner.cookies.clear()
    assert owner.patch('/api/preferences', json={'font_scale': 150}, headers={'Host': 'remote.invalid'}).status_code == 403
