"""Independent boundary checks for paired access, including confused proxies."""
import pytest
from fastapi import HTTPException
from starlette.requests import Request

import db
import remote_access
from local_access import require_local_request


HOST = '192.168.50.10:8765'


def request(*, peer='192.168.50.20', host=HOST, method='GET', path='/api/library',
            cookie=None, origin=None, headers=()):
    values = [('host', host), *headers]
    if cookie is not None:
        values.append(('cookie', remote_access.COOKIE + '=' + cookie))
    if origin is not None:
        values.append(('origin', origin))
    return Request({'type': 'http', 'method': method, 'path': path, 'root_path': '',
                    'scheme': 'http', 'query_string': b'',
                    'client': (peer, 54000) if peer is not None else None,
                    'server': ('0.0.0.0', 8765),
                    'headers': [(key.encode(), value.encode()) for key, value in values]})


@pytest.fixture
def paired(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(remote_access, '_RUNTIME', {})
    monkeypatch.setattr(remote_access, 'detect_addresses', lambda: ('192.168.50.10', '100.74.145.24'))
    remote_access.set_enabled(True)
    remote_access.configure_listener('0.0.0.0')
    remote_access.start()
    pairing = request(method='POST', path='/api/private-access/pair', origin='http://' + HOST)
    return remote_access.pair(pairing, remote_access._config()['pairing_secret'])


@pytest.mark.parametrize('peer,host', [
    ('127.0.0.1', HOST),                 # A local reverse proxy is not a remote device.
    ('192.168.50.20', 'localhost:8765'), # A remote client cannot claim local administration.
    ('192.168.50.20', '127.0.0.1:8765'),
    ('203.0.113.20', HOST),
    ('2001:db8::20', HOST),
    ('169.254.1.20', HOST),
    ('192.168.50.20', 'example.ts.net:8765'),
    ('192.168.50.20', '192.168.50.11:8765'),
    ('192.168.50.20', '192.168.50.10:8766'),
    ('192.168.50.20', '192.168.50.10'),
    ('192.168.50.20', 'user@192.168.50.10:8765'),
    (None, HOST),
])
def test_a_cookie_cannot_widen_peer_host_or_port_scope(paired, peer, host):
    value = request(peer=peer, host=host, cookie=paired, headers=[
        ('forwarded', 'for=127.0.0.1;host=localhost:8765;proto=http'),
        ('x-forwarded-for', '192.168.50.20'), ('x-forwarded-host', HOST),
    ])
    with pytest.raises(HTTPException) as failure:
        remote_access.require_authenticated_request(value)
    assert failure.value.status_code == 403


def test_pairing_never_grants_local_management(paired):
    value = request(cookie=paired)
    remote_access.require_authenticated_request(value)
    with pytest.raises(HTTPException):
        require_local_request(value)


@pytest.mark.parametrize('origin', [
    'http://192.168.50.10:8766', 'https://' + HOST, 'http://192.168.50.11:8765',
    'http://localhost:8765', 'https://example.com', 'null',
    'http://user@' + HOST, 'http://' + HOST + '/other',
])
def test_a_cookie_does_not_disable_same_origin_protection(paired, origin):
    with pytest.raises(HTTPException):
        remote_access.require_authenticated_request(request(cookie=paired, method='POST', origin=origin))


def test_cross_site_navigation_is_limited_to_the_neutral_root(paired):
    headers = [('sec-fetch-site', 'cross-site'), ('sec-fetch-mode', 'navigate')]
    remote_access.require_private_request(request(path='/', headers=headers))
    with pytest.raises(HTTPException):
        remote_access.require_authenticated_request(request(cookie=paired, path='/api/backup', headers=headers))


def test_duplicate_authorities_are_rejected_with_a_valid_cookie(paired):
    with pytest.raises(HTTPException):
        remote_access.require_authenticated_request(request(cookie=paired, headers=[('host', 'localhost:8765')]))


def test_disable_and_reenable_cannot_resurrect_old_pairings(paired):
    value = request(cookie=paired)
    remote_access.require_authenticated_request(value)
    remote_access.set_enabled(False)
    with pytest.raises(HTTPException):
        remote_access.require_authenticated_request(value)
    remote_access.set_enabled(True)
    with pytest.raises(HTTPException):
        remote_access.require_authenticated_request(value)


def test_corrupt_configuration_fails_closed_while_listener_is_running(paired):
    remote_access._path().write_text('{"enabled":true}', encoding='utf-8')
    with pytest.raises(HTTPException):
        remote_access.require_authenticated_request(request(cookie=paired))
    assert remote_access.active() is False


@pytest.mark.parametrize('token', ['\ud800', '\udfff' * 64, 'é' * 64, '\x00' * 64],
                         ids=['lone-high-surrogate', 'lone-low-surrogates', 'non-ascii', 'nul-bytes'])
def test_untrusted_json_unicode_is_rejected_without_a_server_exception(paired, token):
    value = request(method='POST', path='/api/private-access/pair', origin='http://' + HOST)
    with pytest.raises(HTTPException) as failure:
        remote_access.pair(value, token)
    assert failure.value.status_code == 403
