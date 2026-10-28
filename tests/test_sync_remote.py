from datetime import datetime, timezone
import json
from urllib.parse import parse_qs, urlsplit
from urllib.error import URLError

import pytest

import sync_remote as remote


@pytest.fixture(autouse=True)
def reset_cooldown(monkeypatch):
    monkeypatch.setattr(remote, '_blocked_until', {'lichess':0.0,'chesscom':0.0})


def transport(monkeypatch, value, status=200, headers=None):
    calls=[]
    def run(url, accept, check):
        calls.append((url,accept))
        check()
        return status,headers or {},value if isinstance(value,bytes) else json.dumps(value).encode()
    monkeypatch.setattr(remote, '_transport', run)
    return calls


@pytest.mark.parametrize('site,url,expected',[
    ('lichess','https://lichess.org/abcdefgh','abcdefgh'),
    ('lichess','https://lichess.org/abcdefghABCD/black#9','abcdefgh'),
    ('chesscom','https://www.chess.com/game/live/123?x=1','live:123'),
    ('chesscom','https://www.chess.com/live/game/123','live:123'),
    ('chesscom','https://chess.com/game/daily/123','daily:123'),
    ('chesscom','https://www.chess.com/daily/game/123','daily:123'),
    ('lichess','https://lichess.org.evil/abcdefgh',None),
    ('lichess','https://lichess.org@evil/abcdefgh',None),
    ('lichess','https://evil@lichess.org/abcdefgh',None),
    ('lichess','file://lichess.org/abcdefgh',None),
    ('lichess','https://lichess.org:444/abcdefgh',None),
    ('lichess','https://lichess.org/study/abcdefgh',None),
    ('chesscom','https://www.chess.com/member/123',None),
    ('lichess','abcdefgh',None),
])
def test_remote_identifiers(site,url,expected):
    assert remote.game_id(site,url)==expected


def test_lichess_uses_public_bounded_finished_standard_clocks_query(monkeypatch):
    game={'id':'abcdefgh','variant':'standard','status':'mate','pgn':'1. e4 { [%clk 0:09:58] } 1-0','lastMoveAt':1700000}
    calls=transport(monkeypatch,(json.dumps(game)+'\n\n').encode())
    data=remote.download_games('lichess','Example',since=1700000000,max_games=100)
    assert len(data['games'])==1 and not data['limit_reached']
    assert data['games'][0]['pgn']==game['pgn']
    parts=urlsplit(calls[0][0]);query=parse_qs(parts.query)
    assert parts.netloc=='lichess.org' and parts.path=='/api/games/user/example'
    assert query['since']==['1700000000000'] and query['max']==['100']
    assert query['clocks']==['true'] and query['pgnInJson']==['true']
    assert query['ongoing']==['false'] and query['finished']==['true']
    assert calls[0][1]=='application/x-ndjson'


def test_lichess_candidate_filters_and_response_limit(monkeypatch):
    raw=[{'id':'abcdefgh','variant':'chess960','status':'mate'}, {'id':'ijklmnop','variant':{'key':'standard'},'status':'started'}, {'id':'bad/url','variant':'standard','status':'draw'}, {'id':'qrstuvwx','variant':'standard','status':'mate'}]
    transport(monkeypatch,'\n'.join(map(json.dumps,raw)).encode())
    result=remote.download_games('lichess','Example',since=0,max_games=3)
    assert len(result['games'])==3 and result['limit_reached']
    assert not result['games'][0]['standard'] and not result['games'][1]['finished']
    assert result['games'][2]['remote_id'] is None


def test_chesscom_archive_urls_are_not_trusted_and_newest_games_first(monkeypatch):
    now=datetime.now(timezone.utc)
    month=f'{now.year:04d}/{now.month:02d}'
    base='https://api.chess.com/pub/player/example/games/'
    calls=[]
    def run(url,accept,check):
        calls.append(url)
        if url.endswith('archives'):
            payload={'archives':[base+month,'https://evil.com/2026/10',base+'9999/12',base+'2025/13',base+'1900/01']}
        else:
            assert url==base+month
            payload={'games':[
                {'url':'https://www.chess.com/game/live/1','end_time':now.timestamp()-10,'rules':'chess','pgn':'older'},
                {'url':'https://www.chess.com/game/live/2','end_time':now.timestamp()-1,'rules':'chess','pgn':'newer'},
                {'url':'https://www.chess.com/game/live/3','end_time':1,'rules':'chess','pgn':'too old'},
                {'url':'https://www.chess.com/game/live/4','end_time':True,'rules':'chess','pgn':'bad'},
            ]}
        return 200,{},json.dumps(payload).encode()
    monkeypatch.setattr(remote,'_transport',run)
    result=remote.download_games('chesscom','Example',since=now.timestamp()-86400,max_games=2)
    assert [r['remote_id'] for r in result['games']]==['live:2','live:1']
    assert result['limit_reached'] and len(calls)==2


@pytest.mark.parametrize('missing', ['newest', 'older', 'all'])
def test_chesscom_missing_month_keeps_accessible_archives_and_reports_gap(monkeypatch, missing):
    base = 'https://api.chess.com/pub/player/example/games/'
    months = ['2024/01', '2024/02']
    absent = {'2024/02'} if missing == 'newest' else {'2024/01'} if missing == 'older' else set(months)
    calls = []
    def run(url, accept, check):
        calls.append(url)
        if url.endswith('archives'):
            return 200, {}, json.dumps({'archives': [base + month for month in months]}).encode()
        month = url.removeprefix(base)
        if month in absent:
            return 404, {}, b''
        return 200, {}, json.dumps({'games': [{'url': 'https://www.chess.com/game/live/' + month[-2:],
            'end_time': datetime(2024, int(month[-2:]), 15, tzinfo=timezone.utc).timestamp(),
            'rules': 'chess', 'pgn': 'kept'}]}).encode()
    monkeypatch.setattr(remote, '_transport', run)
    data = remote.download_games('chesscom', 'example', since=1704067200, max_games=100)
    assert len(data['games']) == len(months) - len(absent)
    assert data['partial'] and not data['limit_reached']
    assert data['unavailable_months'] == sorted((m.replace('/', '-') for m in absent), reverse=True)
    assert calls == [base + 'archives', base + '2024/02', base + '2024/01']


def test_chesscom_missing_account_index_remains_an_error(monkeypatch):
    transport(monkeypatch, b'', status=404)
    with pytest.raises(remote.RemoteError) as error:
        remote.download_games('chesscom', 'example', since=0, max_games=100)
    assert error.value.status == 404


@pytest.mark.parametrize('status', [401, 403, 429, 500])
def test_chesscom_month_errors_other_than_missing_are_not_silenced(monkeypatch, status):
    base = 'https://api.chess.com/pub/player/example/games/'
    def run(url, accept, check):
        return (200, {}, json.dumps({'archives': [base + '2024/01']}).encode()) if url.endswith('archives') else (status, {}, b'')
    monkeypatch.setattr(remote, '_transport', run)
    with pytest.raises(remote.RemoteError):
        remote.download_games('chesscom', 'example', since=0, max_games=100)


def test_chesscom_missing_month_is_retried_and_limit_preserves_warning(monkeypatch):
    base = 'https://api.chess.com/pub/player/example/games/'
    missing = True
    def run(url, accept, check):
        if url.endswith('archives'):
            return 200, {}, json.dumps({'archives': [base + '2024/01', base + '2024/02']}).encode()
        if missing and url.endswith('2024/02'):
            return 404, {}, b''
        return 200, {}, json.dumps({'games': [{'url': 'https://www.chess.com/game/live/1',
            'end_time': 1708000000, 'rules': 'chess', 'pgn': 'kept'}]}).encode()
    monkeypatch.setattr(remote, '_transport', run)
    first = remote.download_games('chesscom', 'example', since=0, max_games=1)
    assert first['limit_reached'] and first['partial'] and len(first['games']) == 1
    missing = False
    second = remote.download_games('chesscom', 'example', since=0, max_games=1)
    assert second['limit_reached'] and not second['partial'] and second['unavailable_months'] == []


@pytest.mark.parametrize('url',[
    'http://lichess.org/api/games/user/example',
    'https://evil.com/api/games/user/example',
    'https://lichess.org/api/games/user/../../admin',
    'https://lichess.org:443/api/games/user/example',
    'https://lichess.org/api/games/user/example#bad',
    'https://api.chess.com/pub/player/example/games',
    'https://api.chess.com/pub/player/example/games/2026/10/../../x',
])
def test_transport_rejects_non_allowlisted_targets_before_network(url):
    with pytest.raises(ValueError):
        remote._transport(url,'application/json',lambda:None)


@pytest.mark.parametrize('status,needle',[(301,'fourni'),(404,'introuvable'),(401,'refuse'),(403,'refuse'),(500,'fourni')])
def test_remote_errors_do_not_expose_remote_bodies(monkeypatch,status,needle):
    transport(monkeypatch,b'<script>private token</script>',status=status)
    with pytest.raises(remote.RemoteError) as error:
        remote.download_games('lichess','example',since=0,max_games=5)
    assert needle in str(error.value) and 'private' not in str(error.value)


def test_rate_limit_respects_retry_after_without_automatic_retry(monkeypatch):
    calls=transport(monkeypatch,b'',status=429,headers={'Retry-After':'125'})
    with pytest.raises(remote.RemoteError) as error:
        remote.download_games('lichess','example',since=0,max_games=5)
    assert error.value.retry_after==125
    with pytest.raises(remote.RemoteError):
        remote.download_games('lichess','example',since=0,max_games=5)
    assert len(calls)==1


@pytest.mark.parametrize('value',[b'not json',b'[]',b'null',b'"a"'])
def test_corrupt_lichess_response_is_clear_error(monkeypatch,value):
    transport(monkeypatch,value)
    with pytest.raises(remote.RemoteError):
        remote.download_games('lichess','example',since=0,max_games=5)


def test_network_error_and_oversized_payload(monkeypatch):
    def failure(*args):
        raise URLError('socket local secret')
    monkeypatch.setattr(remote,'_transport',failure)
    with pytest.raises(remote.RemoteError,match='inaccessible'):
        remote.download_games('lichess','example',since=0,max_games=5)
    transport(monkeypatch,b' '*(remote.MAX_RESPONSE_BYTES+1))
    with pytest.raises(remote.RemoteError,match='taille'):
        remote.download_games('lichess','example',since=0,max_games=5)


def test_cancel_before_network_does_not_request(monkeypatch):
    calls=transport(monkeypatch,b'')
    def check():
        raise InterruptedError('cancelled')
    with pytest.raises(InterruptedError):
        remote.download_games('lichess','example',since=0,max_games=5,check_cancelled=check)
    assert calls==[]


def test_transport_streaming_checks_cancellation_between_available_chunks(monkeypatch):
    reads=[]
    class Response:
        status=200
        headers={}
        def __enter__(self): return self
        def __exit__(self,*args): pass
        def read(self,size):
            raise AssertionError('Blocking full-buffer read must not be used')
        def read1(self,size):
            reads.append(size)
            return b'partial streaming bytes'
    class Opener:
        def open(self,request,timeout): return Response()
    monkeypatch.setattr(remote,'build_opener',lambda *_:Opener())
    def check():
        if reads:
            raise InterruptedError('cancel after first chunk')
    with pytest.raises(InterruptedError):
        remote._transport('https://lichess.org/api/games/user/example','application/x-ndjson',check)
    assert len(reads)==1


def test_remote_calls_are_serialized_per_provider(monkeypatch):
    import threading
    import time
    guard=threading.Lock()
    state={'active':0,'max':0}
    def slow(*args):
        with guard:
            state['active']+=1
            state['max']=max(state['max'],state['active'])
        time.sleep(.03)
        with guard:
            state['active']-=1
        return 200,{},b''
    monkeypatch.setattr(remote,'_transport',slow)
    threads=[threading.Thread(target=lambda:remote.download_games('lichess','example',since=0,max_games=1)) for _ in range(3)]
    for thread in threads: thread.start()
    for thread in threads: thread.join(timeout=2)
    assert state['max']==1 and all(not thread.is_alive() for thread in threads)
