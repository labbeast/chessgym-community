"""Reading visits log only newly observed activity and deduplicate its time."""
import pytest
import db
import reading_progress
from test_reading_progress import owner,base,entry,ok,visit,state

def rows():
    with db.get_conn() as conn:return [dict(row) for row in conn.execute('SELECT * FROM reading_visits ORDER BY started_at,id')]

def test_old_cumulative_progress_is_not_invented_as_visits(owner):
    bid=base(owner);doc=entry(owner,bid)
    visit(owner,doc['id'],2,active_seconds=12,request_id='old-reading-1')
    assert rows()==[]
    assert state(owner,doc['id'])['active_seconds']==12

def test_visit_tracks_active_time_and_deduplicates_retries(owner):
    bid=base(owner);doc=entry(owner,bid);eid=doc['id']
    payload={'path':'0','visit_id':'visit-session-1','visit_sequence':1,'active_seconds':7,'request_id':'receipt-visit-1'}
    ok(owner.post(f'/api/entries/{eid}/reading',json=payload))
    ok(owner.post(f'/api/entries/{eid}/reading',json=payload))
    ok(owner.post(f'/api/entries/{eid}/reading',json={**payload,'path':'0.0','visit_sequence':2,'active_seconds':3,'request_id':'receipt-visit-2','visit_end':True}))
    row=rows()[0]
    assert row['active_seconds']==10 and row['finished_at']
    assert row['entry_id']==eid and row['base_id']==bid and row['title']==doc['title']
    assert row['first_path']=='0' and row['last_path']=='0.0' and row['read_moves']==2
    assert state(owner,eid)['active_seconds']==10

def test_old_failed_heartbeat_does_not_rewind_closed_visit(owner):
    bid=base(owner);doc=entry(owner,bid);eid=doc['id']
    visit(owner,eid,3,visit_id='visit-session-1',visit_sequence=3,visit_end=True,active_seconds=8,request_id='receipt-visit-3')
    visit(owner,eid,1,visit_id='visit-session-1',visit_sequence=1,active_seconds=2,request_id='receipt-visit-1')
    assert rows()[0]['last_path']=='0.0.0' and rows()[0]['active_seconds']==10

def test_visit_identity_cannot_cross_entries_or_rewrite_time_on_conflict(owner):
    bid=base(owner);one=entry(owner,bid);two=entry(owner,bid)
    visit(owner,one['id'],1,visit_id='visit-session-1',request_id='receipt-visit-1',active_seconds=3)
    response=owner.post(f"/api/entries/{two['id']}/reading",json={'path':'0','visit_id':'visit-session-1','request_id':'receipt-visit-2','active_seconds':9})
    assert response.status_code==409
    assert rows()[0]['active_seconds']==3 and state(owner,two['id'])['active_seconds']==0

@pytest.mark.parametrize('extra',[{'visit_id':'x'},{'visit_id':'visit-id-123','visit_sequence':True},{'visit_id':'visit-id-123','visit_end':'yes'}])
def test_malformed_visits_are_rejected_without_progress_mutation(owner,extra):
    bid=base(owner);doc=entry(owner,bid)
    response=owner.post(f"/api/entries/{doc['id']}/reading",json={'path':'0','request_id':'receipt-visit-1',**extra})
    assert response.status_code==400 and rows()==[]


def test_last_viewed_position_is_separate_from_furthest_bookmark(owner):
    bid=base(owner);doc=entry(owner,bid);eid=doc['id']
    visit(owner,eid,3,visit_id='visit-session-1',visit_sequence=1,visit_path='0',request_id='receipt-visit-1')
    visit(owner,eid,3,visit_id='visit-session-1',visit_sequence=2,visit_path='0.0',active_seconds=4,request_id='receipt-visit-2',visit_end=True)
    row=rows()[0]
    assert row['first_path']=='0' and row['last_path']=='0.0'
    assert state(owner,eid)['read_moves']==3 and row['read_moves']==3
    assert row['active_seconds']==4


@pytest.mark.parametrize('extra',[{'visit_path':None},{'visit_path':'1'},{'visit_path':[]},{'visit_path':'0','visit_fen':'bad-fen'},{'visit_path':'0.0.0.0.0.0.0'}])
def test_invalid_viewed_position_cannot_mutate_progress(owner,extra):
    bid=base(owner);doc=entry(owner,bid)
    result=owner.post(f"/api/entries/{doc['id']}/reading",json={'path':'0','visit_id':'visit-session-1','request_id':'receipt-visit-1','active_seconds':3,**extra})
    assert result.status_code in (400,409,422),result.text
    assert rows()==[] and state(owner,doc['id'])['active_seconds']==0


def test_visit_cannot_be_reused_by_a_different_account(owner):
    bid=base(owner);doc=entry(owner,bid);eid=doc['id']
    visit(owner,eid,1,visit_id='visit-session-1',request_id='receipt-visit-1')
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        with db.get_conn() as conn:
            row=conn.execute('SELECT * FROM entries WHERE id=?',(eid,)).fetchone()
            reading_progress.update(conn,row,{'path':'0','visit_id':'visit-session-1','request_id':'receipt-visit-2','active_seconds':9},user_id=2)
    assert exc.value.status_code==409
    assert rows()[0]['active_seconds']==0 and state(owner,eid)['active_seconds']==0
