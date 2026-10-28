"""Position/table requests share bounded cancellable SQL; no live archives."""
import chess
import time
import pytest
import reference_queries as queries
import reference_store
import library_positions
from test_reference_library import client, owner, synchronous, create

@pytest.mark.parametrize('route',['table','position'])
def test_timeout_is_explicit_and_reader_slot_is_released(owner,tmp_path,synchronous,monkeypatch,route):
    base=create(owner,tmp_path);seen=[]
    def stopped(*args,**kwargs):
        guard=queries._CURRENT.get();seen.append(guard)
        assert guard is not None
        guard.cancel('timeout');guard.check()
    monkeypatch.setattr(reference_store,'list_games' if route=='table' else 'search_position',stopped)
    url=f"/api/reference-bases/{base['id']}/games" if route=='table' else '/api/library/position'
    response=owner.get(url,params={} if route=='table' else {'fen':chess.STARTING_FEN})
    assert response.status_code==503
    assert 'dépassé le délai' in response.json()['detail']
    assert seen[0].connections==set()
    assert queries.exclusive(lambda:123)==123


def test_warm_study_position_uses_catalog_without_reading_or_parsing_pgn(owner,monkeypatch):
    import db
    base=owner.post('/api/bases',json={'name':'Étude'}).json()['id']
    owner.post(f'/api/bases/{base}/import',json={'pgn':'1. e4 e5 *'})
    library_positions.clear_cache();library_positions.search_position(chess.STARTING_FEN)
    traces=[];real=db.get_conn
    def traced():
        conn=real();conn.set_trace_callback(traces.append);return conn
    monkeypatch.setattr(db,'get_conn',traced)
    monkeypatch.setattr(library_positions,'_parse_entry',lambda *_:pytest.fail('Warm position reparsed'))
    result=owner.get('/api/library/position',params={'fen':chess.STARTING_FEN})
    assert result.status_code==200 and result.json()['total_entries']==1
    assert not any(sql.startswith('SELECT pgn FROM entries') for sql in traces)


@pytest.mark.parametrize('params', [{}, {'sort':'date','descending':True}, {'offset':500}])
def test_short_indexed_pages_remain_available_during_heavy_preparation(owner,tmp_path,synchronous,params):
    base=create(owner,tmp_path)
    assert queries._SLOT.acquire(blocking=False)
    try:
        response=owner.get(f"/api/reference-bases/{base['id']}/games",params=params)
        assert response.status_code==200
        assert response.json()['total']==1
    finally:
        queries._SLOT.release()


@pytest.mark.parametrize('params', [
    {'offset':501}, {'search':'Alice'}, {'rating_min':1700},
    {'rating_max':2000}, {'speed':'rapid'}, {'sort':'title'}, {'sort':'result'},
])
def test_expensive_pages_queue_without_bypassing_heavy_reader_slot(owner,tmp_path,synchronous,params):
    base=create(owner,tmp_path)
    assert queries._SLOT.acquire(blocking=False)
    try:
        response=owner.get(f"/api/reference-bases/{base['id']}/games",params=params)
        assert response.status_code==202
        assert response.json()['status']=='preparing'
        assert response.json()['total'] is None
        assert response.json()['entries']==[]
    finally:
        queries._SLOT.release()


    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        response=owner.get(f"/api/reference-bases/{base['id']}/games",params=params)
        if response.status_code==200:
            break
        assert response.status_code==202
        time.sleep(.01)
    assert response.status_code==200


def test_short_page_lane_itself_is_limited_to_one_reader(owner,tmp_path,synchronous):
    base=create(owner,tmp_path)
    assert queries._PAGE_SLOT.acquire(blocking=False)
    try:
        response=owner.get(f"/api/reference-bases/{base['id']}/games")
        assert response.status_code==503
    finally:
        queries._PAGE_SLOT.release()
    assert owner.get(f"/api/reference-bases/{base['id']}/games").status_code==200


@pytest.mark.parametrize('params', [{'sort':'bad'}, {'speed':'bad'}, {'rating_min':2000,'rating_max':1000}])
def test_invalid_list_filters_are_rejected_before_queueing(owner,tmp_path,synchronous,params):
    base=create(owner,tmp_path)
    assert queries._SLOT.acquire(blocking=False)
    try:
        response=owner.get(f"/api/reference-bases/{base['id']}/games",params=params)
        assert response.status_code==400
        assert not queries._PREPARATIONS
    finally:
        queries._SLOT.release()
