"""Appearance choices persist independently of other account settings."""
import io
import json
import sqlite3
import zipfile

import pytest
from local_test_client import TestClient

import app
import db
import training


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'appearance.sqlite3')
    db.init_db()
    training.init_training()

    client = TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000))
    response = client.get('/api/status')
    assert response.status_code == 200, response.text
    yield client
    client.close()


@pytest.mark.parametrize('key,choices', [
    ('theme', ('copper', 'sage', 'midnight', 'plum', 'forest', 'pearl', 'sand', 'contrast')),
    ('piece_set', ('cburnett', 'merida', 'chessnut', 'celtic', 'fantasy', 'shapes', 'pirouetti', 'spatial')),
    ('board_theme', ('brown', 'blue', 'green', 'slate', 'walnut', 'sand', 'olive', 'ocean', 'lavender', 'rose', 'ice', 'graphite')),
])
def test_all_appearance_choices_persist_without_changing_other_settings(owner, key, choices):
    expected = owner.get('/api/preferences').json()
    for choice in choices:
        expected[key] = choice
        response = owner.patch('/api/preferences', json={key: choice})
        assert response.status_code == 200, response.text
        assert response.json() == expected
        assert owner.get('/api/preferences').json() == expected
        with db.get_conn() as conn:
            stored = conn.execute('SELECT value FROM preferences WHERE key=?', (key,)).fetchone()[0]
        assert json.loads(stored) == choice
    db.init_db()
    assert owner.get('/api/preferences').json() == expected


@pytest.mark.parametrize('key', ['theme', 'piece_set', 'board_theme'])
@pytest.mark.parametrize('invalid', ['invented', '', '../cburnett', None, True, 1, [], {}])
def test_invalid_appearance_update_rejects_entire_patch(owner, key, invalid):
    selected = {'theme': 'plum', 'piece_set': 'spatial', 'board_theme': 'lavender'}
    assert owner.patch('/api/preferences', json=selected).status_code == 200
    expected = owner.get('/api/preferences').json()
    response = owner.patch('/api/preferences', json={'language': 'en', 'sound': {'enabled': False}, key: invalid})
    assert response.status_code == 400, response.text
    assert owner.get('/api/preferences').json() == expected


def test_new_appearance_choices_preserved_in_portable_backup(owner):
    selected = {'theme': 'contrast', 'piece_set': 'fantasy', 'board_theme': 'ice'}
    assert owner.patch('/api/preferences', json=selected).status_code == 200
    response = owner.get('/api/backup')
    assert response.status_code == 200, response.text
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        snapshot = sqlite3.connect(':memory:')
        try:
            snapshot.deserialize(archive.read('chessgym.sqlite3'))
            stored = {key: json.loads(value) for key, value in snapshot.execute('SELECT key,value FROM preferences')}
        finally:
            snapshot.close()
    assert all(stored[key] == value for key, value in selected.items())
