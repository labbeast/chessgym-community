import pytest
from local_test_client import TestClient

import app
import db
import jobs
import sync


@pytest.fixture
def client(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'DATA_DIR',tmp_path)
    monkeypatch.setattr(db,'DB_PATH',tmp_path/'sync-api.sqlite3')
    monkeypatch.setattr(jobs,'start_worker',lambda:None)
    monkeypatch.setattr(jobs,'stop_worker',lambda:None)

    with TestClient(app.app,base_url='http://localhost',client=('127.0.0.1',50000)) as client:
        yield client


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code==200
    return client


def test_sync_api_requires_owner_for_every_action(client):
    calls=[('get','/api/sync',None),('post','/api/sync/accounts',{}),
           ('patch','/api/sync/accounts/1',{}),('delete','/api/sync/accounts/1',None),
           ('post','/api/sync/accounts/1/run',{}),('post','/api/sync/run',{})]
    for method,url,payload in calls:
        assert client.request(method,url,**({'json':payload} if payload is not None else {}), headers={'Host': 'remote.invalid'}).status_code==403


def test_account_and_queue_api_contract(owner):
    base=owner.post('/api/bases',json={'name':'My games'}).json()['id']
    account=owner.post('/api/sync/accounts',json={'site':'chesscom','username':'TestPlayer','base_id':base}).json()
    assert account['username']=='testplayer' and account['auto_analyse'] is True
    listed=owner.get('/api/sync').json()
    assert listed['accounts']==[account]
    updated=owner.patch(f"/api/sync/accounts/{account['id']}",json={'auto_sync':True,'max_games':250}).json()
    assert updated['max_games']==250 and updated['auto_sync'] is True
    job=owner.post(f"/api/sync/accounts/{account['id']}/run",json={}).json()['job']
    assert job['kind']=='sync' and job['status']=='queued' and job['payload']=={'account_id':account['id']}
    assert owner.post('/api/sync/run',json={}).json()['jobs'][0]['id']==job['id']
    assert owner.delete(f"/api/sync/accounts/{account['id']}").json()=={'deleted':True}
    assert owner.get('/api/sync').json()=={'accounts':[]}
    assert owner.post(f"/api/sync/accounts/{account['id']}/run",json={}).status_code==404


def test_cross_origin_sync_mutation_is_rejected(owner):
    response=owner.post('/api/sync/accounts',headers={'Origin':'https://evil.example'},json={'site':'lichess','username':'example','base_id':1})
    assert response.status_code==403


def test_invalid_patch_does_not_change_account(owner):
    base=owner.post('/api/bases',json={'name':'Games'}).json()['id']
    saved=owner.post('/api/sync/accounts',json={'site':'lichess','username':'example','base_id':base}).json()
    assert owner.patch(f"/api/sync/accounts/{saved['id']}",json={'auto_sync':'false','max_games':200}).status_code==400
    assert owner.get('/api/sync').json()['accounts']==[saved]
    assert owner.post('/api/sync/run',json={'unrecognized':True}).status_code==400
