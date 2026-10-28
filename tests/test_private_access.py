"""Private-device HTTP boundary, association, revocation and startup regressions."""
import asyncio
import json
import pytest
from fastapi import HTTPException, Response
from fastapi.testclient import TestClient
from starlette.requests import Request
import db
import remote_access as access
import remote_access_api

HOST = '192.168.50.10'
TAIL = '100.75.80.10'
PORT = 8765
ORIGIN = f'http://{HOST}:{PORT}'


def request(*, cookie=None, receive=None, origin=ORIGIN):
    headers = [(b'host', f'{HOST}:{PORT}'.encode()), (b'content-type', b'application/json')]
    if origin is not None:
        headers.append((b'origin', origin.encode()))
    if cookie is not None:
        headers.append((b'cookie', (access.COOKIE + '=' + cookie).encode()))
    return Request({'type': 'http', 'method': 'POST', 'path': '/api/private-access/pair', 'root_path': '',
                    'scheme': 'http', 'query_string': b'', 'headers': headers,
                    'client': ('192.168.50.22', 50000), 'server': (HOST, PORT)}, receive=receive)


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'profile.sqlite3')
    monkeypatch.setattr(access, 'detect_addresses', lambda: (HOST, TAIL, 'fd7a:115c:a1e0::10'))
    access._RUNTIME.pop(access._key(), None)
    db.init_db()
    yield
    access._RUNTIME.pop(access._key(), None)


def activate():
    access.set_enabled(True)
    access.configure_listener('0.0.0.0')
    access.start()


@pytest.fixture
def clients(store, monkeypatch):
    import app, app_updates, engine, resource_setup
    monkeypatch.setattr(app_updates, 'validation_pending', lambda: False)
    monkeypatch.setattr(app_updates, 'observe_request', lambda: None)
    monkeypatch.setattr(engine, 'status', lambda: {'available': False})
    monkeypatch.setattr(resource_setup, 'setup_required', lambda: False)
    local = TestClient(app.app, base_url=f'http://localhost:{PORT}', client=('127.0.0.1', 51000))
    phone = TestClient(app.app, base_url=ORIGIN, client=('192.168.50.22', 52000))
    yield local, phone
    local.close()
    phone.close()


def pair(client, token):
    return client.post('/api/private-access/pair', headers={'Origin': ORIGIN}, json={'token': token})


def test_mode_requires_local_enable_and_listener_restart(clients):
    local, phone = clients
    assert local.get('/api/status').status_code == 200
    assert local.get('/api/private-access').json() == {
        'enabled': False, 'active': False, 'restart_required': False, 'pairing_urls': [], 'expires_days': 30}
    assert not access._path().exists() and phone.get('/').status_code == 403
    result = local.patch('/api/private-access', json={'enabled': True})
    assert result.status_code == 200
    state = result.json()
    assert state['enabled'] and not state['active'] and state['restart_required']
    assert {item['label'] for item in state['pairing_urls']} == {'lan', 'tailscale'}
    assert phone.get('/').status_code == 403
    access.configure_listener('0.0.0.0')
    access.start()
    assert phone.get('/').status_code == 200


def test_unpaired_device_only_receives_neutral_page_and_public_pairing_assets(clients):
    _, phone = clients
    activate()
    page = phone.get('/')
    assert page.status_code == 200 and 'private-pair.js' in page.text and 'app.js' not in page.text
    assert page.headers['x-frame-options'] == 'DENY'
    assert "frame-ancestors 'none'" in page.headers['content-security-policy']
    for path in sorted(access.PUBLIC_ASSETS):
        assert phone.get(path).status_code == 200
    for path in ('/api/status', '/api/library', '/api/preferences', '/api/private-access',
                 '/static/app.js', '/static/index.html', '/docs', '/openapi.json', '/api/backup'):
        assert phone.get(path).status_code == 403
    for method in ('post', 'patch'):
        assert getattr(phone, method)('/api/preferences', json={}).status_code == 403


def test_pairing_grants_profile_access_but_never_local_administration(clients):
    local, phone = clients
    activate()
    token = access._config()['pairing_secret']
    result = pair(phone, token)
    assert result.status_code == 200 and result.json() == {'paired': True}
    cookie = result.headers['set-cookie']
    assert all(flag in cookie for flag in ('HttpOnly', 'SameSite=strict', 'Max-Age=2592000'))
    assert token not in cookie
    state = phone.get('/api/status')
    assert state.status_code == 200 and state.json()['access_mode'] == 'private'
    assert not state.json()['capabilities']['private_access_management']
    assert local.get('/api/status').json()['capabilities']['private_access_management']
    assert state.json()['username'] == local.get('/api/status').json()['username']
    assert phone.get('/static/app.js').status_code == 200
    assert phone.get('/api/private-access').status_code == 403
    assert phone.patch('/api/private-access', headers={'Origin': ORIGIN}, json={'enabled': False}).status_code == 403
    assert phone.post('/api/private-access/rotate', headers={'Origin': ORIGIN}, json={}).status_code == 403
    assert access.active()


def test_rotation_and_disable_invalidate_links_and_sessions(clients):
    local, phone = clients
    activate()
    old = access._config()['pairing_secret']
    assert pair(phone, old).status_code == 200
    assert local.post('/api/private-access/rotate', json={}).status_code == 200
    assert phone.get('/api/status').status_code == 403 and pair(phone, old).status_code == 403
    newer = access._config()['pairing_secret']
    assert newer != old and pair(phone, newer).status_code == 200
    assert local.patch('/api/private-access', json={'enabled': False}).status_code == 200
    assert phone.get('/').status_code == 403 and phone.get('/api/status').status_code == 403
    assert local.get('/api/status').status_code == 200
    local.patch('/api/private-access', json={'enabled': True})
    assert pair(phone, newer).status_code == 403


@pytest.mark.parametrize('payload', [{}, {'enabled': 1}, {'enabled': 'true'}, {'enabled': True, 'extra': True}])
def test_enable_requires_one_boolean(clients, payload):
    local, _ = clients
    assert local.patch('/api/private-access', json=payload).status_code == 400
    assert not access.enabled()


@pytest.mark.parametrize('body', ['{}', '[]', 'null', '42', '"text"', '{"token":3}', '{"token":"wrong","extra":true}', '{"token":'])
def test_invalid_pairing_payloads_do_not_set_cookies(clients, body):
    _, phone = clients
    activate()
    result = phone.post('/api/private-access/pair', headers={'Origin': ORIGIN, 'Content-Type': 'application/json'}, content=body)
    assert result.status_code == 403 and 'set-cookie' not in result.headers


def test_pair_stream_is_bounded_without_content_length_and_stops_early(store):
    activate()
    delivered = []
    chunks = [b'{"token":"' + b'x' * 800, b'y' * 800, b'never read"}']
    async def receive():
        index = len(delivered)
        delivered.append(index)
        return {'type': 'http.request', 'body': chunks[index], 'more_body': index < len(chunks) - 1}
    with pytest.raises(HTTPException) as error:
        asyncio.run(remote_access_api.pair(request(receive=receive), Response()))
    assert error.value.status_code == 413 and delivered == [0, 1]


def test_pairing_rejects_oversized_normal_and_chunked_bodies(clients):
    _, phone = clients
    activate()
    for content in (b'x' * 1025, iter([b'x' * 800, b'y' * 800])):
        response = phone.post('/api/private-access/pair', headers={'Origin': ORIGIN, 'Content-Type': 'application/json'}, content=content)
        assert response.status_code == 413 and 'set-cookie' not in response.headers


def test_pairing_rate_limit_and_recovery(store, monkeypatch):
    activate()
    clock = [1000]
    monkeypatch.setattr(access.time, 'monotonic', lambda: clock[0])
    for _ in range(10):
        with pytest.raises(HTTPException) as error:
            access.pair(request(), 'incorrect')
        assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        access.pair(request(), access._config()['pairing_secret'])
    assert error.value.status_code == 429 and error.value.headers['Retry-After'] == '300'
    clock[0] += 301
    cookie = access.pair(request(), access._config()['pairing_secret'])
    assert access.valid_device(request(cookie=cookie))


@pytest.mark.parametrize('offset', [-1, 0, 30 * 86400, 30 * 86400 + 1])
def test_cookie_lifetime_is_signed_and_bounded(store, monkeypatch, offset):
    activate()
    moment = 1_700_000_000
    monkeypatch.setattr(access.time, 'time', lambda: moment)
    cookie = access.pair(request(), access._config()['pairing_secret'])
    monkeypatch.setattr(access.time, 'time', lambda: moment + offset)
    assert access.valid_device(request(cookie=cookie)) is (0 <= offset <= access.MAX_AGE)


@pytest.mark.parametrize('cookie', ['', '1.a.b', 'a.' + '0' * 32 + '.bad', 'x' * 181, '1.' + '0' * 32 + '.é'])
def test_invalid_cookies_fail_closed(store, cookie):
    activate()
    assert not access.valid_device(request(cookie=cookie))


def test_cookie_secure_flag_follows_actual_https_listener(store):
    activate()
    body = json.dumps({'token': access._config()['pairing_secret']}).encode()
    async def receive():
        return {'type': 'http.request', 'body': body}
    value = request(receive=receive, origin=f'https://{HOST}:{PORT}')
    value.scope['scheme'] = 'https'
    response = Response()
    asyncio.run(remote_access_api.pair(value, response))
    assert '; Secure' in response.headers['set-cookie']


def test_runner_only_allows_private_network_listening_after_activation(store, monkeypatch):
    import run
    monkeypatch.delenv('CHESSGYM_HOST', raising=False)
    assert run.local_host() == '127.0.0.1'
    access.set_enabled(True)
    assert run.local_host() == '0.0.0.0'
    for host in ('127.0.0.1', '::1', 'localhost', HOST, TAIL, '0.0.0.0', '::'):
        monkeypatch.setenv('CHESSGYM_HOST', host)
        assert run.local_host() == host
    for host in ('8.8.8.8', '203.0.113.1', 'public.example', '2001:db8::1', ''):
        monkeypatch.setenv('CHESSGYM_HOST', host)
        with pytest.raises(SystemExit):
            run.local_host()
    access.set_enabled(False)
    monkeypatch.setenv('CHESSGYM_HOST', HOST)
    with pytest.raises(SystemExit):
        run.local_host()


def test_advertised_addresses_follow_listener_family_and_binding(store):
    access.set_enabled(True)
    for listener, expected in [('0.0.0.0', {HOST, TAIL}), ('::', {'fd7a:115c:a1e0::10'}), (HOST, {HOST})]:
        access.configure_listener(listener)
        access.start()
        assert set(access._runtime()['hosts']) == expected
    access.configure_listener('127.0.0.1')
    access.start()
    assert not access.active() and access.status(PORT)['restart_required']


@pytest.mark.skipif(__import__('os').name != 'nt', reason='Windows adapter ordering')
def test_detect_addresses_prioritizes_default_route_then_tailscale(monkeypatch):
    from types import SimpleNamespace
    monkeypatch.setattr(access.socket, 'getaddrinfo', lambda *args: [])
    output = 'preferred:192.168.50.10\n172.29.144.1\n100.75.80.10\n192.168.50.10\n127.0.0.1\n8.8.8.8\n'
    monkeypatch.setattr(access.subprocess, 'run', lambda *args, **kwargs: SimpleNamespace(stdout=output))
    assert access.detect_addresses() == ('192.168.50.10', '100.75.80.10', '172.29.144.1')
