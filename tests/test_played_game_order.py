import pytest
from local_test_client import TestClient

import app
import entries_api
import db
import jobs


def test_my_games_sort_descending_by_play_date_while_bases_sort_ascending(tmp_path, monkeypatch):
    monkeypatch.setattr(db,'DATA_DIR',tmp_path)
    monkeypatch.setattr(db,'DB_PATH',tmp_path/'played-order.sqlite3')
    monkeypatch.setattr(jobs,'start_worker',lambda:None)
    monkeypatch.setattr(jobs,'stop_worker',lambda:None)

    with TestClient(app.app,base_url='http://localhost',client=('127.0.0.1',50000)) as client:
        assert client.get('/api/status').status_code==200
        base=client.post('/api/bases',json={'name':'Games','settings':{'played':True}}).json()['id']
        examples=[
            ('utc_recent',{'Date':'2026.10.18','UTCDate':'2026.10.19','UTCTime':'00:30:00'}),
            ('local_late',{'Date':'2026.10.18','StartTime':'23:55:00'}),
            ('local_early',{'Date':'2026.10.18','StartTime':'08:10:00'}),
            ('older',{'Date':'2026.10.17','UTCTime':'20:00:00'}),
            ('unknown',{'Date':'????.??.??'}),
            ('bad_utc_fallback',{'UTCDate':'2026.02.31','Date':'2026.10.18','UTCTime':'11:00:00'}),
        ]
        ids={}
        for title,headers in examples:
            tags={'Event':title,'White':'Example','Black':'Opponent','Result':'*',**headers}
            pgn='\n'.join(f'[{key} "{value}"]' for key,value in tags.items())+'\n\n1. e4 e5 *'
            response=client.post('/api/entries',json={'base_id':base,'title':title,'pgn':pgn})
            assert response.status_code==200,response.text
            ids[title]=response.json()['id']
        expected=[ids[key] for key in ('utc_recent','local_late','bad_utc_fallback','local_early','older','unknown')]
        assert [item['id'] for item in client.get('/api/entries?played=true').json()['entries']]==expected
        assert [item['id'] for item in client.get('/api/entries?played=true').json()['entries']]==expected
        insertion=list(reversed(list(ids.values())))
        assert [item['id'] for item in client.get('/api/entries').json()['entries']]==insertion
        assert [item['id'] for item in client.get(f'/api/bases/{base}/entries').json()['entries']]==list(ids.values())


def test_base_preserves_pgn_order_across_imports_and_same_second_timestamps(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'import-order.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        assert client.get('/api/status').status_code == 200
        base = client.post('/api/bases', json={'name': 'Cours'}).json()['id']

        def chapters(*numbers):
            return '\n\n'.join(f'[Event "Chapitre {number}"]\n[Result "*"]\n\n1. e4 e5 *' for number in numbers)

        def import_chapters(*numbers):
            response = client.post(f'/api/bases/{base}/import', json={'pgn': chapters(*numbers)})
            assert response.status_code == 200, response.text
            return response.json()

        monkeypatch.setattr(entries_api, 'now', lambda: '2026-10-21T10:00:00+00:00')
        assert import_chapters(1, 2)['imported'] == 2
        result = import_chapters(2, 3)
        assert result['imported'] == 1 and result['duplicates'] == 1
        monkeypatch.setattr(entries_api, 'now', lambda: '2026-10-21T11:00:00+00:00')
        assert import_chapters(4, 5)['imported'] == 2
        games = client.get(f'/api/bases/{base}/entries').json()['entries']
        assert [game['headers']['Event'] for game in games] == [f'Chapitre {number}' for number in range(1, 6)]
        assert [game['id'] for game in games] == sorted(game['id'] for game in games)


def test_ties_and_unknown_dates_have_deterministic_order():
    common={'headers':{'Date':'2026.10.18','StartTime':'10:30:00'},'created_at':'2026-10-19T12:00:00+00:00'}
    first={**common,'id':1}
    second={**common,'id':2}
    unknown={'headers':{'Date':'????.??.??'},'created_at':'2099-01-01','id':10}
    assert [x['id'] for x in sorted([first,unknown,second],key=app.played_game_order,reverse=True)]==[2,1,10]


@pytest.mark.parametrize('headers,day_known,seconds',[
    ({'UTCDate':'bad','Date':'2026.10.18','UTCTime':'99:00:00','StartTime':'02:03:04'},True,7384),
    ({'Date':'2026.02.31','StartTime':'10:00:00'},False,36000),
    ({'UTCDate':'2026.10.18','UTCTime':'00:00:00'},True,0),
    ({'Date':'2026.10.18','Time':'12:34:56'},True,45296),
    ({'Date':'2026.10.18','UTCTime':'??:??:??'},True,-1),
])
def test_pgn_time_fallbacks(headers,day_known,seconds):
    result=app.played_game_order({'headers':headers})
    assert result[0] is day_known and result[2]==seconds
