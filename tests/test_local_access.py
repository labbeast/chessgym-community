"""The passwordless service must remain a local service, including in a browser."""
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from local_access import require_local_request


def request(*, peer='127.0.0.1', host='localhost:8765', path='/api/library', method='GET', scheme='http', headers=None):
    values = {'host': host, **(headers or {})}
    return Request({'type': 'http', 'method': method, 'path': path, 'root_path': '',
                    'scheme': scheme, 'query_string': b'',
                    'client': (peer, 56000) if peer is not None else None,
                    'server': ('127.0.0.1', 8765),
                    'headers': [(key.lower().encode(), value.encode()) for key, value in values.items()]})


@pytest.mark.parametrize('peer,host', [
    ('127.0.0.1', 'localhost:8765'), ('127.0.0.2', '127.0.0.2:8765'),
    ('::1', '[::1]:8765'), ('::ffff:127.0.0.1', '[::ffff:127.0.0.1]:8765'),
    ('127.0.0.1', 'LOCALHOST:8765'), ('127.0.0.1', 'localhost.:8765'),
])
def test_local_browser_and_direct_tools_do_not_need_credentials(peer, host):
    assert require_local_request(request(peer=peer, host=host)) is None


@pytest.mark.parametrize('peer', ['192.168.1.8', '10.0.0.1', '203.0.113.8', '::', '2001:db8::8', 'testclient', None])
def test_remote_or_unknown_peer_cannot_claim_local_access(peer):
    with pytest.raises(HTTPException) as error:
        require_local_request(request(peer=peer, headers={'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': 'localhost'}))
    assert error.value.status_code == 403


@pytest.mark.parametrize('host', [
    'rebind.example:8765', 'localhost.evil.example:8765', '192.168.1.8:8765',
    'evil@localhost:8765', 'localhost:8765/path', 'localhost:8765?x=1',
    'localhost:8765#fragment', 'localhost:invalid', 'localhost:65536',
    'localhost:0', 'localhost :8765', '[::1', '',
])
def test_only_an_actual_local_host_authority_is_accepted(host):
    with pytest.raises(HTTPException) as error:
        require_local_request(request(host=host, headers={'x-forwarded-host': 'localhost:8765'}))
    assert error.value.status_code == 403


def test_duplicate_host_headers_are_rejected_before_routing():
    value = request()
    value.scope['headers'].append((b'host', b'rebind.example:8765'))
    with pytest.raises(HTTPException) as error:
        require_local_request(value)
    assert error.value.status_code == 403


@pytest.mark.parametrize('origin', [
    'https://evil.example', 'http://localhost:8766', 'https://localhost:8765',
    'null', '', 'http://localhost:8765/path', 'http://localhost:8765?x=1',
    'http://user@localhost:8765', 'http://localhost:8765#fragment',
])
def test_other_websites_cannot_read_or_change_the_local_profile(origin):
    for method in ('GET', 'POST', 'OPTIONS'):
        with pytest.raises(HTTPException) as error:
            require_local_request(request(method=method, headers={'origin': origin, 'sec-fetch-site': 'same-origin'}))
        assert error.value.status_code == 403


@pytest.mark.parametrize('method', ['GET', 'POST', 'PATCH', 'DELETE'])
def test_same_origin_browser_requests_are_accepted(method):
    assert require_local_request(request(method=method, headers={
        'origin': 'http://localhost:8765', 'sec-fetch-site': 'same-origin'})) is None


def test_default_ports_are_compared_by_origin_semantics():
    assert require_local_request(request(host='localhost:80', headers={'origin': 'http://localhost'})) is None


@pytest.mark.parametrize('site', ['cross-site', 'same-site', 'unexpected'])
def test_fetch_metadata_rejects_external_reads_even_without_origin(site):
    with pytest.raises(HTTPException):
        require_local_request(request(headers={'sec-fetch-site': site}))
    with pytest.raises(HTTPException):
        require_local_request(request(path='/api/backup', headers={'sec-fetch-site': site, 'sec-fetch-mode': 'navigate'}))


def test_a_normal_link_can_open_the_homepage_without_exposing_api_data():
    assert require_local_request(request(path='/', headers={'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate'})) is None
    with pytest.raises(HTTPException):
        require_local_request(request(path='/', method='POST', headers={'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate'}))
