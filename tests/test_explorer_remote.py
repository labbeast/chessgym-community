"""Remote explorer contract tests use fake HTTP; no service requests."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email.utils import format_datetime
import json
import hashlib
import sqlite3
import threading
from urllib.parse import parse_qs, urlsplit
from urllib.error import URLError

import chess
import pytest

import explorer_remote as remote
import explorer_cache


START = chess.STARTING_FEN
TEST_TOKEN = 'synthetic_test_token'
ORIGINAL_TRANSPORT = remote._transport


def query(source, fen, ratings=None, speeds=None, token=TEST_TOKEN, **kwargs):
    return remote.remote_data(source, fen, ratings, speeds, token=token, **kwargs)


def payload(uci='e2e4', white=8, draws=2, black=5):
    return {'white': white, 'draws': draws, 'black': black, 'moves': [
        {'uci': uci, 'san': 'untrusted SAN', 'white': white, 'draws': draws,
         'black': black, 'averageRating': 1720}]}


@pytest.fixture(autouse=True)
def isolated_remote(monkeypatch, tmp_path):
    monkeypatch.setattr(explorer_cache, 'CACHE_PATH', tmp_path / 'explorer.sqlite3')
    monkeypatch.setattr(remote, 'MIN_REQUEST_INTERVAL', 0)
    monkeypatch.setattr(remote, '_store_context', None)
    monkeypatch.setattr(remote, '_next_request_at', 0)
    remote._cache.clear()
    remote._auth_failures.clear()
    monkeypatch.setattr(remote, '_blocked_until', 0)
    monkeypatch.setattr(remote, '_blocked_status', 'unavailable')
    monkeypatch.setattr(remote, '_blocked_message', '')
    monkeypatch.setattr(remote, '_transport', lambda url, token: pytest.fail('Unexpected remote HTTP'))


def stub(monkeypatch, data=None, status=200, headers=None):
    calls = []
    def transport(url, token):
        calls.append(url)
        return status, headers or {}, json.dumps(data if data is not None else payload()).encode()
    monkeypatch.setattr(remote, '_transport', transport)
    return calls


def test_legal_san_real_counts_and_public_filters(monkeypatch):
    calls = stub(monkeypatch)
    data = query('lichess', START, [1800, 1600, 1800], ['rapid', 'blitz'])
    assert data['status'] == 'ok'
    assert data['total'] == 15 and data['unknown'] == 0
    assert data['moves'][0] == {'uci': 'e2e4', 'san': 'e4', 'white': 8,
                                'draws': 2, 'black': 5, 'unknown': 0,
                                'total': 15, 'average_rating': 1720}
    assert not data['cached'] and not data['stale']
    assert data['complete']
    assert datetime.fromisoformat(data['fetched_at']).tzinfo is not None
    url = urlsplit(calls[0])
    assert url.scheme == 'https' and url.netloc == 'explorer.lichess.org'
    assert url.path == '/lichess'
    assert parse_qs(url.query) == {'fen': [START], 'moves': ['256'], 'topGames': ['0'],
        'variant': ['standard'], 'recentGames': ['0'], 'ratings': ['1600,1800'], 'speeds': ['blitz,rapid']}


def test_masters_has_no_population_filters(monkeypatch):
    calls = stub(monkeypatch)
    query('masters', START, [1600], ['rapid'])
    params = parse_qs(urlsplit(calls[0]).query)
    assert params == {'fen': [START], 'moves': ['256'], 'topGames': ['0']}


def test_cache_equivalent_positions_and_returned_data_are_independent(monkeypatch):
    calls = stub(monkeypatch)
    first = query('lichess', START)
    first['moves'][0]['total'] = 999
    next_fen = ' '.join(START.split()[:4]) + ' 25 40'
    second = query('lichess', next_fen)
    assert second['cached'] and second['status'] == 'ok'
    assert second['moves'][0]['total'] == 15
    assert len(calls) == 1
    query('lichess', START, [2000], ['rapid'])
    query('lichess', START, [1600, 1800], ['blitz'])
    assert len(calls) == 3


def test_empty_success_is_distinct_from_outage(monkeypatch):
    stub(monkeypatch, {'white': 0, 'draws': 0, 'black': 0, 'moves': []})
    empty = query('lichess', START)
    assert empty['status'] == 'ok' and empty['total'] == 0
    assert empty['complete']
    remote._cache.clear()
    stub(monkeypatch, status=503)
    down = query('lichess', START, [2000])
    assert down['status'] == 'unavailable' and down['fetched_at'] is None
    assert not down['stale']
    assert not down['complete']


@pytest.mark.parametrize('change', ['missing', 'negative', 'boolean', 'duplicate', 'illegal', 'null', 'inconsistent', 'list', 'huge'])
def test_malformed_service_data_is_not_presented_as_valid(monkeypatch, change):
    data = payload()
    if change == 'missing':
        del data['draws']
    elif change == 'negative':
        data['moves'][0]['white'] = -1
    elif change == 'boolean':
        data['white'] = True
    elif change == 'duplicate':
        data['moves'].append(dict(data['moves'][0]))
    elif change == 'illegal':
        data['moves'][0]['uci'] = 'e2e5'
    elif change == 'null':
        data['moves'][0]['uci'] = '0000'
    elif change == 'inconsistent':
        data['white'] = 2
    elif change == 'list':
        data = []
    elif change == 'huge':
        data['moves'] = [data['moves'][0]] * 257
    calls = stub(monkeypatch, data)
    result = query('lichess', START)
    assert result['status'] == 'unavailable' and not result['moves']
    query('masters', START)
    assert len(calls) == 1  # brief global outage backoff


def test_incomplete_move_list_keeps_original_denominator(monkeypatch):
    data = payload()
    data.update(white=80, draws=20, black=50)
    stub(monkeypatch, data)
    result = query('lichess', START)
    assert result['total'] == 150 and result['moves'][0]['total'] == 15
    assert not result['complete']


def test_castling_uci_is_normalized(monkeypatch):
    fen = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
    stub(monkeypatch, payload('e1h1'))
    move = query('masters', fen)['moves'][0]
    assert move['uci'] == 'e1g1' and move['san'] == 'O-O'


def test_stale_cache_retains_counts_timestamp_and_error_status(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(remote.time, 'monotonic', lambda: now[0])
    stub(monkeypatch)
    original = query('lichess', START)
    now[0] += remote.CACHE_TTL + 1
    calls = []
    def offline(url, token):
        calls.append(url)
        raise URLError('offline')
    monkeypatch.setattr(remote, '_transport', offline)
    stale = query('lichess', START)
    assert stale['status'] == 'unavailable' and stale['stale'] and stale['cached']
    assert stale['fetched_at'] == original['fetched_at'] and stale['total'] == 15
    query('lichess', START)
    assert len(calls) == 1
    now[0] += remote.STALE_TTL
    unavailable = query('lichess', START)
    assert unavailable['status'] == 'unavailable' and not unavailable['stale']
    assert unavailable['fetched_at'] is None


@pytest.mark.parametrize('retry', ['1', '120', 'invalid'])
def test_429_global_cooldown_respects_minimum_and_retry_after(monkeypatch, retry):
    now = [1000.0]
    monkeypatch.setattr(remote.time, 'monotonic', lambda: now[0])
    calls = stub(monkeypatch, status=429, headers={'Retry-After': retry})
    first = query('lichess', START)
    assert first['status'] == 'rate_limited'
    expected = 120 if retry == '120' else 60
    assert first['retry_after'] == expected
    now[0] += expected - 1
    assert query('masters', START)['status'] == 'rate_limited'
    assert len(calls) == 1
    now[0] += 2
    query('masters', START)
    assert len(calls) == 2


def test_retry_after_http_date(monkeypatch):
    monkeypatch.setattr(remote.time, 'time', lambda: 1000.0)
    stamp = format_datetime(datetime.fromtimestamp(1180, timezone.utc), usegmt=True)
    assert remote._retry_delay({'Retry-After': stamp}) == 180


def test_duplicate_concurrent_queries_use_one_request(monkeypatch):
    entered, release = threading.Event(), threading.Event()
    calls = []
    def transport(url, token):
        calls.append(url)
        entered.set()
        assert release.wait(2)
        return 200, {}, json.dumps(payload()).encode()
    monkeypatch.setattr(remote, '_transport', transport)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(query, 'lichess', START)
        assert entered.wait(2)
        second = executor.submit(query, 'lichess', START)
        release.set()
        one, two = first.result(), second.result()
    assert len(calls) == 1
    assert one['status'] == two['status'] == 'ok'
    assert one['cached'] is False and two['cached'] is True


def test_bounded_cache(monkeypatch):
    monkeypatch.setattr(remote, 'MAX_CACHE_ENTRIES', 2)
    calls = stub(monkeypatch)
    for rating in [1000, 1200, 1400]:
        query('lichess', START, [rating])
    assert len(remote._cache) == 2
    query('lichess', START, [1000])
    assert len(calls) == 3  # evicted RAM entries can still use the durable cache


@pytest.mark.parametrize('args', [
    ('https://evil.example', START), ('lichess', 'not a FEN'),
    ('lichess', '8/8/8/8/8/8/8/8 w - - 0 1'),
    ('lichess', START, []), ('lichess', START, [1700]),
    ('lichess', START, [1600], []), ('lichess', START, [1600], ['invalid']),
])
def test_invalid_inputs_never_request_network(args):
    with pytest.raises(ValueError):
        query(*args)


def test_redirects_are_not_followed():
    assert remote._NoRedirect().redirect_request(None, None, 302, '', {}, 'https://elsewhere.test') is None


def test_payload_byte_limit(monkeypatch):
    monkeypatch.setattr(remote, 'MAX_RESPONSE_BYTES', 50)
    stub(monkeypatch)
    assert query('lichess', START)['status'] == 'unavailable'


def test_missing_token_does_not_request_or_reveal_cached_statistics(monkeypatch):
    calls = stub(monkeypatch)
    assert query('lichess', START)['total'] == 15
    data = query('lichess', START, token=None)
    assert data['status'] == 'auth_required' and data['total'] == 0
    assert data['moves'] == [] and not data['cached'] and not data['stale']
    assert len(calls) == 1


@pytest.mark.parametrize('token', ['token\r\nInjected: value', 'space token', 'é', 'x' * 2049, 'short', 123])
def test_invalid_token_format_does_not_request_or_echo(token):
    result = query('lichess', START, token=token)
    assert result['status'] == 'auth_required'
    assert str(token) not in json.dumps(result)


def test_visible_ascii_token_punctuation_is_supported(monkeypatch):
    calls = stub(monkeypatch)
    token = 'synthetic.token-with+/padding='
    result = query('lichess', START, token=token)
    assert result['status'] == 'ok' and len(calls) == 1
    assert token not in repr(remote._cache)
    assert token not in json.dumps(result)


@pytest.mark.parametrize('status', [401, 403])
def test_rejected_token_can_be_replaced_without_inherited_cooldown(monkeypatch, status):
    calls = []
    def transport(url, token):
        calls.append(token)
        if token == 'synthetic_bad_token':
            return status, {}, b''
        return 200, {}, json.dumps(payload()).encode()
    monkeypatch.setattr(remote, '_transport', transport)
    assert query('lichess', START, token='synthetic_bad_token')['status'] == 'auth_required'
    assert query('masters', START, token='synthetic_bad_token')['status'] == 'auth_required'
    assert len(calls) == 1
    assert query('lichess', START, token='synthetic_good_token')['status'] == 'ok'
    assert len(calls) == 2
    assert 'synthetic_bad_token' not in repr(remote._auth_failures)


def test_changing_token_does_not_bypass_global_rate_limit(monkeypatch):
    calls = stub(monkeypatch, status=429)
    assert query('lichess', START, token='synthetic_first')['status'] == 'rate_limited'
    assert query('lichess', START, token='synthetic_second')['status'] == 'rate_limited'
    assert len(calls) == 1


def test_public_cache_shared_without_persisting_credentials(monkeypatch):
    calls = stub(monkeypatch)
    one = query('lichess', START, token='synthetic_first')
    two = query('lichess', START, token='synthetic_second')
    repeat = query('lichess', START, token='synthetic_first')
    assert len(calls) == 1 and not one['cached'] and two['cached'] and repeat['cached']
    saved = repr(remote._cache)
    assert 'synthetic_first' not in saved and 'synthetic_second' not in saved
    disk = explorer_cache.cache_path().read_bytes()
    for token in ('synthetic_first', 'synthetic_second'):
        assert token.encode() not in disk
        assert hashlib.sha256(token.encode()).hexdigest().encode() not in disk


def test_auth_failure_does_not_serve_old_statistics(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(remote.time, 'monotonic', lambda: now[0])
    stub(monkeypatch)
    assert query('lichess', START)['total'] == 15
    now[0] += remote.CACHE_TTL + 1
    stub(monkeypatch, status=401)
    denied = query('lichess', START)
    assert denied['status'] == 'auth_required' and denied['total'] == 0
    assert not denied['cached'] and not denied['stale']


def test_token_sent_only_in_header_to_fixed_host(monkeypatch):
    seen = []
    class Response:
        status = 200
        headers = {}
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, size):
            assert size == remote.MAX_RESPONSE_BYTES + 1
            return json.dumps(payload()).encode()
    class Opener:
        def open(self, request, timeout):
            seen.append(request)
            assert timeout == remote.REQUEST_TIMEOUT
            return Response()
    def make_opener(handler):
        assert isinstance(handler, remote._NoRedirect)
        return Opener()
    monkeypatch.setattr(remote, 'build_opener', make_opener)
    # Use actual transport, bypassing the autouse fixture's network guard.
    monkeypatch.setattr(remote, '_transport', ORIGINAL_TRANSPORT)
    result = query('lichess', START)
    assert result['status'] == 'ok'
    request = seen[0]
    assert request.get_header('Authorization') == 'Bearer ' + TEST_TOKEN
    assert TEST_TOKEN not in request.full_url and request.data is None
    assert TEST_TOKEN not in json.dumps(result)
    with pytest.raises(ValueError):
        ORIGINAL_TRANSPORT('https://elsewhere.test/lichess', TEST_TOKEN)
    with pytest.raises(ValueError):
        ORIGINAL_TRANSPORT('https://explorer.lichess.org/lichess', 'token\r\nInjected: value')
    assert len(seen) == 1


def fake_clock(monkeypatch):
    clock = {'mono': 1000.0, 'wall': 1_700_000_000.0, 'slept': []}
    def advance(seconds):
        clock['mono'] += seconds
        clock['wall'] += seconds
    def sleep(seconds):
        clock['slept'].append(seconds)
        advance(seconds)
    monkeypatch.setattr(remote.time, 'monotonic', lambda: clock['mono'])
    monkeypatch.setattr(remote.time, 'time', lambda: clock['wall'])
    monkeypatch.setattr(remote.time, 'sleep', sleep)
    return clock, advance


def restart_remote_memory(monkeypatch):
    remote._cache.clear()
    remote._auth_failures.clear()
    monkeypatch.setattr(remote, '_store_context', None)
    monkeypatch.setattr(remote, '_blocked_until', 0)
    monkeypatch.setattr(remote, '_next_request_at', 0)


def test_persistent_cache_survives_restart_preserving_original_timestamp(monkeypatch):
    clock, advance = fake_clock(monkeypatch)
    calls = stub(monkeypatch)
    first = query('lichess', START, [1800, 1600], ['rapid', 'blitz'])
    advance(30)
    restart_remote_memory(monkeypatch)
    repeated = query('lichess', ' '.join(START.split()[:4]) + ' 20 80',
                     [1600, 1800, 1600], ['blitz', 'rapid'])
    assert len(calls) == 1 and repeated['cached'] and not repeated['stale']
    assert repeated['fetched_at'] == first['fetched_at']
    assert repeated['moves'] == first['moves']
    assert repeated['moves'][0]['average_rating'] == 1720


def test_scan_ttl_reuses_week_cache_while_interactive_query_refreshes(monkeypatch):
    clock, advance = fake_clock(monkeypatch)
    calls = stub(monkeypatch)
    first = query('lichess', START)
    advance(2 * 86400)
    restart_remote_memory(monkeypatch)
    scan = query('lichess', START, cache_ttl=7 * 86400)
    assert scan['cached'] and not scan['stale'] and scan['fetched_at'] == first['fetched_at']
    assert len(calls) == 1
    fresh = query('lichess', START)
    assert len(calls) == 2 and not fresh['cached']
    assert fresh['fetched_at'] != first['fetched_at']


def test_persisted_429_survives_restart_token_change_and_zero_cache_ttl(monkeypatch):
    clock, advance = fake_clock(monkeypatch)
    calls = stub(monkeypatch, status=429, headers={'Retry-After': '120'})
    first = query('lichess', START)
    assert first['retry_after'] == 120
    advance(30)
    restart_remote_memory(monkeypatch)
    blocked = query('masters', START, token='synthetic_changed_token', cache_ttl=0)
    assert blocked['status'] == 'rate_limited' and blocked['retry_after'] == 90
    assert len(calls) == 1
    advance(91)
    query('masters', START)
    assert len(calls) == 2


def test_week_old_cache_expiry_preserves_stale_fallback_then_expires(monkeypatch):
    clock, advance = fake_clock(monkeypatch)
    stub(monkeypatch)
    first = query('lichess', START)
    advance(86400)
    restart_remote_memory(monkeypatch)
    calls = stub(monkeypatch, status=503)
    stale = query('lichess', START)
    assert stale['stale'] and stale['fetched_at'] == first['fetched_at']
    advance(remote.STALE_TTL)
    restart_remote_memory(monkeypatch)
    expired = query('lichess', START, cache_ttl=remote.STALE_TTL)
    assert expired['status'] == 'unavailable' and not expired['stale']
    assert expired['fetched_at'] is None and len(calls) == 2


def test_persistent_cache_is_bounded_and_reuses_recent_queries(monkeypatch):
    clock, advance = fake_clock(monkeypatch)
    monkeypatch.setattr(explorer_cache, 'MAX_CACHE_ENTRIES', 2)
    calls = stub(monkeypatch)
    for rating in [1000, 1200, 1400]:
        query('lichess', START, [rating])
        advance(1)
    with sqlite3.connect(explorer_cache.cache_path()) as conn:
        assert conn.execute('SELECT COUNT(*) FROM statistics').fetchone()[0] == 2
    restart_remote_memory(monkeypatch)
    assert query('lichess', START, [1400])['cached']
    assert len(calls) == 3
    assert not query('lichess', START, [1000])['cached']
    assert len(calls) == 4


def test_successful_remote_requests_are_paced_but_cache_hits_are_immediate(monkeypatch):
    clock, advance = fake_clock(monkeypatch)
    monkeypatch.setattr(remote, 'MIN_REQUEST_INTERVAL', 1.0)
    calls = []
    def transport(url, token):
        calls.append(clock['mono'])
        return 200, {}, json.dumps(payload()).encode()
    monkeypatch.setattr(remote, '_transport', transport)
    query('lichess', START)
    query('masters', START)
    assert query('lichess', START)['cached']
    query('lichess', START, [2000])
    assert calls == [1000, 1001, 1002]
    assert clock['slept'] == [1, 1]


@pytest.mark.parametrize('cache_ttl', [True, None, '60', -1, float('nan'), float('inf'), 7 * 86400 + 1])
def test_invalid_cache_ttl_never_requests_network(cache_ttl):
    with pytest.raises(ValueError):
        query('lichess', START, cache_ttl=cache_ttl)


def test_corrupt_persisted_move_is_rejected_before_refetch(monkeypatch):
    calls = stub(monkeypatch)
    query('lichess', START)
    with sqlite3.connect(explorer_cache.cache_path()) as conn:
        key, value = conn.execute('SELECT query_key,payload FROM statistics').fetchone()
        corrupted = json.loads(value)
        corrupted['moves'][0]['uci'] = 'e2e5'
        conn.execute('UPDATE statistics SET payload=? WHERE query_key=?', (json.dumps(corrupted), key))
    restart_remote_memory(monkeypatch)
    result = query('lichess', START)
    assert result['status'] == 'ok' and result['moves'][0]['uci'] == 'e2e4'
    assert not result['cached'] and len(calls) == 2


def test_unreadable_cooldown_store_does_not_risk_a_new_request(monkeypatch, tmp_path):
    monkeypatch.setattr(explorer_cache, 'CACHE_PATH', tmp_path)
    result = query('lichess', START)
    assert result['status'] == 'unavailable' and result['total'] == 0


def test_changing_application_database_isolates_disk_and_memory_cache(monkeypatch, tmp_path):
    import db
    monkeypatch.setattr(explorer_cache, 'CACHE_PATH', None)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'one.sqlite3')
    calls = stub(monkeypatch)
    query('lichess', START)
    one_path = explorer_cache.cache_path()
    assert one_path == tmp_path / 'one.explorer-cache.sqlite3'
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'two.sqlite3')
    assert not query('lichess', START)['cached']
    assert len(calls) == 2 and explorer_cache.cache_path() != one_path
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'one.sqlite3')
    assert query('lichess', START)['cached'] and len(calls) == 2


def test_rejected_credential_cannot_read_a_shared_cached_result(monkeypatch):
    calls = stub(monkeypatch, status=401)
    assert query('lichess', START, token='synthetic_bad_token')['status'] == 'auth_required'
    calls = stub(monkeypatch)
    assert query('lichess', START, token='synthetic_good_token')['status'] == 'ok'
    rejected = query('lichess', START, token='synthetic_bad_token')
    assert rejected['status'] == 'auth_required' and rejected['total'] == 0
    assert len(calls) == 1
