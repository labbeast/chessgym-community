import pytest
from local_test_client import TestClient

import app
import db
import explorer_credentials as credentials


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'explorer-credentials.sqlite3')
    monkeypatch.delenv(credentials.ENVIRONMENT_KEY, raising=False)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        yield client


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


def saved_token():
    with db.get_conn() as conn:
        row = conn.execute('SELECT token FROM service_credentials WHERE service=?', (credentials.SERVICE,)).fetchone()
    return row['token'] if row else None


def test_owner_is_required_to_read_or_change_connection(client):
    assert client.get('/api/explorer/connection', headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.patch('/api/explorer/connection', json={'token': 'fake-test-token'}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert saved_token() is None


def test_save_replace_remove_and_no_secret_in_readable_settings(owner):
    assert owner.get('/api/explorer/connection').json() == {'configured': False, 'source': None}
    token = 'local-test-secret-do-not-return'
    response = owner.patch('/api/explorer/connection', json={'token': token})
    assert response.status_code == 200, response.text
    assert response.json() == {'configured': True, 'source': 'local'}
    assert token not in response.text
    assert saved_token() == credentials.get_token() == token
    for url in ('/api/explorer/connection', '/api/explorer/settings', '/api/preferences'):
        response = owner.get(url)
        assert response.status_code == 200
        assert token not in response.text
        assert response.headers.get('cache-control') == 'no-store'
    with db.get_conn() as conn:
        assert token not in repr([dict(row) for row in conn.execute('SELECT * FROM preferences')])
        assert conn.execute('SELECT updated_at FROM service_credentials').fetchone()[0]
    replacement = 'replacement-test-token'
    assert owner.patch('/api/explorer/connection', json={'token': replacement}).json() == {'configured': True, 'source': 'local'}
    assert saved_token() == credentials.get_token() == replacement
    assert owner.patch('/api/explorer/connection', json={'token': ''}).json() == {'configured': False, 'source': None}
    assert saved_token() is None and credentials.get_token() is None
    assert owner.patch('/api/explorer/connection', json={'token': ''}).status_code == 200


def test_connection_change_is_protected_by_same_origin_and_json(owner):
    assert owner.patch('/api/explorer/connection', json={'token': 'fake-test-token'}, headers={'Origin': 'https://malicious.example'}).status_code == 403
    assert owner.patch('/api/explorer/connection', content='token=fake-test-token', headers={'content-type': 'application/x-www-form-urlencoded'}).status_code == 415
    assert saved_token() is None
    response = owner.patch('/api/explorer/connection', json={'token': 'fake-test-token'}, headers={'Origin': 'http://localhost'})
    assert response.status_code == 200


@pytest.mark.parametrize('payload', [
    {}, {'token': 'fake-test-token', 'unexpected': 1}, {'token': None},
    {'token': True}, {'token': 123456789}, {'token': ['fake-test-token']},
    {'token': {'value': 'fake-test-token'}}, {'token': 'short'},
    {'token': 'x' * 2049}, {'token': ' leading-space'}, {'token': 'trailing-space '},
    {'token': 'internal space'}, {'token': 'newline\nvalue'}, {'token': 'return\rvalue'},
    {'token': 'tab\tvalue'}, {'token': 'null\x00value'}, {'token': 'delete\x7fvalue'},
    {'token': 'unicodeé-value'},
])
def test_invalid_settings_never_replace_existing_secret(owner, payload):
    token = 'unchanged-test-secret'
    owner.patch('/api/explorer/connection', json={'token': token})
    response = owner.patch('/api/explorer/connection', json=payload)
    assert response.status_code == 400, response.text
    assert token not in response.text
    if isinstance(payload.get('token'), str) and len(payload['token']) >= 8:
        assert payload['token'] not in response.text
    assert saved_token() == token


def test_environment_wins_and_rejects_hidden_local_edits(owner, monkeypatch):
    local = 'local-test-token'
    environment = 'environment-test-token'
    owner.patch('/api/explorer/connection', json={'token': local})
    monkeypatch.setenv(credentials.ENVIRONMENT_KEY, environment)
    assert credentials.get_token() == environment
    response = owner.get('/api/explorer/connection')
    assert response.json() == {'configured': True, 'source': 'environment'}
    assert environment not in response.text and local not in response.text
    for value in ('replacement-test-token', ''):
        response = owner.patch('/api/explorer/connection', json={'token': value})
        assert response.status_code == 409
        assert environment not in response.text and local not in response.text
        assert saved_token() == local
    monkeypatch.delenv(credentials.ENVIRONMENT_KEY)
    assert credentials.get_token() == local
    assert owner.get('/api/explorer/connection').json() == {'configured': True, 'source': 'local'}


def test_empty_environment_allows_local_and_invalid_environment_never_becomes_header(owner, monkeypatch):
    monkeypatch.setenv(credentials.ENVIRONMENT_KEY, '')
    assert owner.patch('/api/explorer/connection', json={'token': 'local-test-token'}).status_code == 200
    assert credentials.get_token() == 'local-test-token'
    monkeypatch.setenv(credentials.ENVIRONMENT_KEY, 'unsafe-token\nheader')
    assert credentials.get_token() is None
    response = owner.get('/api/explorer/connection')
    assert response.json() == {'configured': False, 'source': 'environment'}
    assert 'unsafe-token' not in response.text
    assert owner.patch('/api/explorer/connection', json={'token': ''}).status_code == 409


def test_schema_initialization_is_repeatable_and_preserves_token(owner):
    owner.patch('/api/explorer/connection', json={'token': 'durable-test-token'})
    db.init_db()
    db.init_db()
    assert credentials.get_token() == 'durable-test-token'
