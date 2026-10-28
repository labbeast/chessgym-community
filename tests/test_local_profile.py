"""Preserve the former owner and saved workspace while removing login prompts."""
from concurrent.futures import ThreadPoolExecutor
import json

import pytest
from fastapi import HTTPException
from starlette.requests import Request

import accounts_api
import db


def local_request(*, host='localhost:8765', peer='127.0.0.1', cookie=None):
    headers = [(b'host', host.encode())]
    if cookie is not None:
        headers.append((b'cookie', ('chessgym_session=' + cookie).encode()))
    return Request({'type': 'http', 'method': 'GET', 'path': '/api/status', 'root_path': '',
                    'scheme': 'http', 'query_string': b'', 'headers': headers,
                    'client': (peer, 56000), 'server': ('127.0.0.1', 8765)})


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'local-profile.sqlite3')
    db.init_db()


def test_first_local_access_creates_one_profile_without_password_or_session(database):
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0
    assert accounts_api.require_user(local_request()) == {'id': 1, 'username': 'local'}
    assert accounts_api.require_user(local_request(cookie='ignored-old-cookie')) == {'id': 1, 'username': 'local'}
    with db.get_conn() as conn:
        users = [dict(row) for row in conn.execute('SELECT * FROM users')]
        assert len(users) == 1 and users[0]['password_hash'] == ''
        assert conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0


def test_concurrent_first_requests_keep_a_single_stable_profile(database):
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: db.ensure_local_owner(), range(8)))
    assert results == [{'id': 1, 'username': 'local'}] * 8
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1


def test_existing_owner_sessions_preferences_and_library_are_not_rewritten(database, monkeypatch):
    import engine
    import resource_setup
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users VALUES(1,'existing-owner','historical-hash','2024-01-01')")
        conn.execute("INSERT INTO sessions VALUES('historical-session',1,1)")
        conn.execute("INSERT INTO preferences VALUES('workspace_epoch',?)", (json.dumps('restored-workspace-42'),))
        conn.execute("INSERT INTO preferences VALUES('theme',?)", (json.dumps('forest'),))
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(9,'Existing repertoire','2024-01-01')")
        snapshot = {table: [tuple(row) for row in conn.execute('SELECT * FROM ' + table)]
                    for table in ('users', 'sessions', 'preferences', 'bases')}
    monkeypatch.setattr(engine, 'status', lambda: {'available': False})
    monkeypatch.setattr(resource_setup, 'setup_required', lambda: False)
    payload = accounts_api.status(local_request())
    assert payload['authenticated'] is True
    assert payload['setup_required'] is False and payload['local_mode'] is True
    assert payload['username'] == 'existing-owner'
    assert payload['workspace_epoch'] == 'restored-workspace-42'
    assert payload['resources_setup_required'] is False
    db.init_db()
    with db.get_conn() as conn:
        assert snapshot == {table: [tuple(row) for row in conn.execute('SELECT * FROM ' + table)]
                            for table in snapshot}


def test_new_status_goes_directly_to_resource_onboarding(database, monkeypatch):
    import engine
    import resource_setup
    monkeypatch.setattr(engine, 'status', lambda: {'available': False})
    monkeypatch.setattr(resource_setup, 'setup_required', lambda: True)
    payload = accounts_api.status(local_request())
    assert payload['username'] == 'local'
    assert payload['setup_required'] is False and payload['authenticated'] is True
    assert payload['resources_setup_required'] is True
    assert payload['capabilities']['setup_resources'] is True
    assert len(payload['workspace_epoch']) == 32
    assert accounts_api.status(local_request())['workspace_epoch'] == payload['workspace_epoch']


def test_new_installations_have_distinct_browser_workspaces(database, tmp_path, monkeypatch):
    import engine
    import resource_setup
    monkeypatch.setattr(engine, 'status', lambda: {'available': False})
    monkeypatch.setattr(resource_setup, 'setup_required', lambda: True)
    first = accounts_api.status(local_request())
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'another-local-installation.sqlite3')
    db.init_db()
    second = accounts_api.status(local_request())
    assert first['username'] == second['username'] == 'local'
    assert first['workspace_epoch'] != second['workspace_epoch']


def test_old_owner_without_epoch_keeps_the_original_browser_namespace(database, monkeypatch):
    import engine
    import resource_setup
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users VALUES(1,'historical-owner','old-hash','2024-01-01')")
    monkeypatch.setattr(engine, 'status', lambda: {'available': False})
    monkeypatch.setattr(resource_setup, 'setup_required', lambda: False)
    assert accounts_api.status(local_request())['workspace_epoch'] == 'initial'
    with db.get_conn() as conn:
        assert conn.execute("SELECT value FROM preferences WHERE key='workspace_epoch'").fetchone() is None


def test_existing_workspace_epoch_is_kept_when_a_missing_profile_is_created(database):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO preferences VALUES('workspace_epoch',?)", (json.dumps('existing-namespace'),))
    db.ensure_local_owner()
    with db.get_conn() as conn:
        assert json.loads(conn.execute("SELECT value FROM preferences WHERE key='workspace_epoch'").fetchone()[0]) == 'existing-namespace'


def test_rejected_access_cannot_create_a_profile(database):
    for request in (local_request(host='rebind.example:8765'), local_request(peer='192.168.1.5')):
        with pytest.raises(HTTPException) as error:
            accounts_api.require_user(request)
        assert error.value.status_code == 403
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 0


def test_login_setup_and_logout_are_no_longer_routes():
    assert {route.path for route in accounts_api.router.routes} == {'/api/status'}
    assert not hasattr(accounts_api, 'password_hash')
    assert not hasattr(accounts_api, 'set_session')
