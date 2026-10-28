"""Incremental derivation and receipts survive real edits, rollback and concurrent clients."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from uuid import uuid4

import pytest
from fastapi import HTTPException

import db
import training


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'reviews.sqlite3')
    monkeypatch.setattr(training, 'now', lambda: datetime(2026, 10, 22, 12, tzinfo=timezone.utc))
    db.init_db()
    training.init_training()


def base(**settings):
    settings = {'review_enabled': True, 'type': 'moves', 'color': 'white', 'new_limit': 100,
                'review_priority': 'due', 'mode': 'hybrid', **settings}
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
                            ('Study', json.dumps(settings), training.stamp())).lastrowid


def entry(bid, pgn='1. e4 e5 2. Nf3 Nc6 3. Bc4 *', **values):
    with db.get_conn() as conn:
        return conn.execute('''INSERT INTO entries(base_id,title,pgn,start_path,selected,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?)''', (bid, values.get('title','Study'), pgn, values.get('path',''),
            values.get('selected',1), training.stamp(), training.stamp())).lastrowid


def cards(bid):
    return training.queue(bid, all=True)['cards']


def changes(bid, **settings):
    with db.get_conn() as conn:
        current = json.loads(conn.execute('SELECT settings FROM bases WHERE id=?',(bid,)).fetchone()[0])
        conn.execute('UPDATE bases SET settings=? WHERE id=?',(json.dumps({**current,**settings}),bid))


def trace_parsing(monkeypatch):
    parsed = []
    original = training.load_game
    def load(pgn):
        parsed.append(pgn)
        return original(pgn)
    monkeypatch.setattr(training,'load_game',load)
    return parsed


def saved(cid):
    with db.get_conn() as conn:
        return dict(conn.execute('SELECT * FROM review_cards WHERE id=?',(cid,)).fetchone())


def test_repeated_queue_stats_and_grade_do_not_parse_or_rewrite_unchanged_cards(database, monkeypatch):
    bid=base();entry(bid);parsed=trace_parsing(monkeypatch)
    original=cards(bid)
    assert len(parsed)==1
    untouched=saved(original[1]['id'])
    statements=[]
    original_conn=training.get_conn
    def connection():
        conn=original_conn()
        conn.set_trace_callback(statements.append)
        return conn
    monkeypatch.setattr(training,'get_conn',connection)
    assert cards(bid)==original
    training.reviews()
    training.grade_card(original[0]['id'],training.GradeRequest(grade=2))
    training.master_card(original[0]['id'])
    training.reviews()
    assert parsed==['1. e4 e5 2. Nf3 Nc6 3. Bc4 *']
    assert saved(original[1]['id'])==untouched
    assert not any('INSERT INTO review_cards' in sql or 'UPDATE review_cards SET active' in sql for sql in statements)
    assert not any('e.pgn' in sql or 'SELECT e.*' in sql for sql in statements)


def test_only_changed_entry_reparsed_and_merged_answers_history_preserved(database, monkeypatch):
    bid=base();first=entry(bid);second=entry(bid,'1. e4 e5 2. Nf3 Nc6 3. Bb5 *')
    before=cards(bid);third=next(c for c in before if c['path']=='0.0.0.0')
    assert set(third['answers'])=={'f1c4','f1b5'}
    training.grade_card(third['id'],training.GradeRequest(grade=2))
    parsed=trace_parsing(monkeypatch)
    # Do not update updated_at: triggers must detect the actual source change.
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. e4 e5 2. Nf3 Nc6 3. d4 *',first))
    new=next(c for c in cards(bid) if c['id']==third['id'])
    assert parsed==['1. e4 e5 2. Nf3 Nc6 3. d4 *']
    assert set(new['answers'])=={'d2d4','f1b5'} and new['state']=='learned'
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM review_history WHERE card_id=?',(third['id'],)).fetchone()[0]==1
        conn.execute('DELETE FROM entries WHERE id=?',(second,))
    parsed.clear()
    assert next(c for c in cards(bid) if c['id']==third['id'])['answers']==['d2d4']
    assert parsed==[]


def test_selection_move_duplicate_and_base_delete_invalidate_both_bases(database, monkeypatch):
    a=base();b=base();eid=entry(a);duplicate=entry(a)
    assert cards(a) and cards(b)==[]
    parsed=trace_parsing(monkeypatch)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=0 WHERE id=?',(eid,))
    assert cards(a) and parsed==[]
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET base_id=? WHERE id=?',(b,duplicate))
    assert cards(a)==[] and cards(b)
    assert len(parsed)==1
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=1 WHERE id=?',(eid,))
    assert cards(a)
    assert len(parsed)==1
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=?',(a,))
        assert conn.execute('SELECT 1 FROM review_generation WHERE base_id=?',(a,)).fetchone() is None
    assert cards(b)


def test_relevant_settings_and_start_path_invalidate_but_spacing_does_not(database, monkeypatch):
    bid=base(type='solve');eid=entry(bid)
    original=cards(bid);parsed=trace_parsing(monkeypatch)
    changes(bid,max=720,mode='automatic',new_limit=30)
    assert cards(bid)[0]['content_key']!=original[0]['content_key']
    assert parsed==[]
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET start_path=? WHERE id=?',('0.0',eid))
    assert cards(bid)[0]['path']=='0.0' and len(parsed)==1
    changes(bid,type='moves',color='black')
    assert all(' b ' in c['fen'] for c in cards(bid)) and len(parsed)==2
    changes(bid,type='moves',color='white')
    assert all(' w ' in c['fen'] for c in cards(bid)) and len(parsed)==3


def test_invalid_pgn_or_path_is_cached_and_can_recover(database, monkeypatch):
    bid=base(type='solve');eid=entry(bid,path='9.9')
    parsed=trace_parsing(monkeypatch)
    assert cards(bid)==cards(bid)==[] and len(parsed)==1
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET start_path='' WHERE id=?",(eid,))
    assert cards(bid) and len(parsed)==2


def test_rollback_never_marks_source_or_derivation_current_and_restart_reuses_cache(database, monkeypatch):
    bid=base();eid=entry(bid);original=cards(bid)
    with pytest.raises(RuntimeError):
        with db.get_conn() as conn:
            conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 d5 2. c4 *',eid))
            training._sync_base(conn,training.get_base(conn,bid))
            raise RuntimeError('rollback')
    parsed=trace_parsing(monkeypatch)
    assert cards(bid)==original and parsed==[]
    training.init_training()
    assert cards(bid)==original and parsed==[]


def test_failed_derivation_rolls_back_then_retry_builds_complete_snapshot(database, monkeypatch):
    bid=base();entry(bid);entry(bid,'1. d4 d5 2. c4 *')
    original=training._derive_entry
    count=0
    def fail(entry,*args):
        nonlocal count
        count+=1
        if count==2:
            raise RuntimeError('interrupted derivation')
        return original(entry,*args)
    monkeypatch.setattr(training,'_derive_entry',fail)
    with pytest.raises(RuntimeError):
        cards(bid)
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM review_entry_derivations').fetchone()[0]==0
        assert conn.execute('SELECT count(*) FROM review_cards').fetchone()[0]==0
    monkeypatch.setattr(training,'_derive_entry',original)
    assert len(cards(bid))==4


def test_identical_grades_are_atomic_under_concurrent_requests_and_replay_after_delete(database):
    bid=base();eid=entry(bid);card=cards(bid)[0]
    request=training.GradeRequest(grade=2,elapsed_ms=12345,request_id=uuid4(),content_key=card['content_key'])
    with ThreadPoolExecutor(max_workers=4) as pool:
        results=list(pool.map(lambda _:training.grade_card(card['id'],request),range(4)))
    assert all(result==results[0] for result in results)
    assert saved(card['id'])['repetitions']==1
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM review_history').fetchone()[0]==1
        conn.execute('DELETE FROM bases WHERE id=?',(bid,))
    assert training.grade_card(card['id'],request)==results[0]


@pytest.mark.parametrize('mutate', ['answer','settings','progress','selection'])
def test_stale_card_never_records_history(database, mutate):
    bid=base();eid=entry(bid);card=cards(bid)[0]
    if mutate=='answer':
        with db.get_conn() as conn:
            conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 d5 *',eid))
    elif mutate=='settings':
        changes(bid,mode='automatic')
    elif mutate=='progress':
        training.grade_card(card['id'],training.GradeRequest(grade=2))
    else:
        with db.get_conn() as conn:
            conn.execute('UPDATE entries SET selected=0 WHERE id=?',(eid,))
    with pytest.raises(HTTPException) as exc:
        training.grade_card(card['id'],training.GradeRequest(grade=2,request_id=uuid4(),content_key=card['content_key']))
    assert exc.value.status_code==409
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM review_history').fetchone()[0]==int(mutate=='progress')
        assert conn.execute('SELECT count(*) FROM review_grade_receipts').fetchone()[0]==0


def test_request_id_mismatch_different_card_or_payload_is_rejected(database):
    bid=base();entry(bid);first,second,*_=cards(bid)
    request=training.GradeRequest(grade=2,request_id=uuid4(),content_key=first['content_key'])
    training.grade_card(first['id'],request)
    for cid,other in [(first['id'],request.model_copy(update={'grade':3})),(second['id'],request)]:
        with pytest.raises(HTTPException) as exc:
            training.grade_card(cid,other)
        assert exc.value.status_code==409
    assert saved(first['id'])['repetitions']==1 and saved(second['id'])['repetitions']==0


def test_master_receipt_replays_even_after_delete_and_cannot_be_reused_as_grade(database):
    bid=base();entry(bid);card=cards(bid)[0]
    request=training.MasterRequest(request_id=uuid4(),content_key=card['content_key'])
    result=training.master_card(card['id'],request)
    assert training.master_card(card['id'],request)==result
    with pytest.raises(HTTPException) as exc:
        training.grade_card(card['id'],training.GradeRequest(grade=2,**request.model_dump()))
    assert exc.value.status_code==409
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=?',(bid,))
    assert training.master_card(card['id'],request)==result


def test_concurrent_first_generation_has_one_snapshot(database, monkeypatch):
    bid=base();entry(bid);parsed=trace_parsing(monkeypatch)
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses=list(pool.map(lambda _:cards(bid),range(4)))
    assert len(parsed)==1 and all(response==responses[0] for response in responses)



def test_http_contract_accepts_receipts_master_body_and_checks_owner(database, monkeypatch):
    from local_test_client import TestClient
    import app
    import jobs
    monkeypatch.setattr(jobs,'start_worker',lambda:None)
    monkeypatch.setattr(jobs,'stop_worker',lambda:None)

    with TestClient(app.app,base_url='http://localhost',client=('127.0.0.1',50000)) as client:
        assert client.get('/api/status').status_code==200
        bid=base();entry(bid)
        data=client.get(f'/api/bases/{bid}/queue?all=true').json()
        first,second,*_=data['cards']
        payload={'grade':2,'request_id':str(uuid4()),'content_key':first['content_key'],'elapsed_ms':13000}
        response=client.post(f"/api/reviews/{first['id']}/grade",json=payload)
        assert response.status_code==200
        assert client.post(f"/api/reviews/{first['id']}/grade",json=payload).json()==response.json()
        assert client.post(f"/api/reviews/{first['id']}/grade",json={**payload,'grade':3}).status_code==409
        master={'request_id':str(uuid4()),'content_key':second['content_key']}
        response=client.post(f"/api/reviews/{second['id']}/master",json=master)
        assert response.status_code==200 and response.json()['state']=='mastered'
        assert client.post(f"/api/reviews/{second['id']}/master",json=master).json()==response.json()
        client.cookies.clear()
        assert client.post(f"/api/reviews/{first['id']}/grade",json=payload, headers={'Host': 'remote.invalid'}).status_code==403


def test_unlimited_new_cards_exceeds_both_form_limit_and_old_hidden_queue_cap(database):
    import review_statistics
    import app
    bid=base(type='solve',new_limit=None)
    with db.get_conn() as conn:
        conn.executemany("INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES (?,?,?,?,?)",
                         [(bid,f'Puzzle {i}','1. e4 *',training.stamp(),training.stamp()) for i in range(1005)])
    assert len(training.queue(bid)['cards'])==1005
    assert review_statistics.review_statistics(base_id=bid)['current']['new_available_today']==1005
    for value in (None,''):
        changes(bid,new_limit=value)
        assert len(training.queue(bid)['cards'])==1005
    changes(bid,new_limit=500)
    assert len(training.queue(bid)['cards'])==1005
    assert review_statistics.review_statistics(base_id=bid)['current']['new_available_today']==1005
    changes(bid,new_limit=0)
    assert len(training.queue(bid, selection='learn')['cards'])==1005
    with db.get_conn() as conn:
        settings=json.loads(conn.execute('SELECT settings FROM bases WHERE id=?',(bid,)).fetchone()[0])
        del settings['new_limit']
        conn.execute('UPDATE bases SET settings=? WHERE id=?',(json.dumps(settings),bid))
    assert len(training.queue(bid)['cards'])==1005
    defaults=app.checked_settings({})
    assert defaults['new_limit'] is None
    assert [defaults[k] for k in ('again','hard','medium','easy')]==[10,2,5,10]
    explicit=app.checked_settings({},old={'new_limit':10,'hard':1,'medium':3,'easy':7})
    assert [explicit[k] for k in ('new_limit','hard','medium','easy')]==[10,1,3,7]
    assert app.checked_settings({'new_limit':''},old={'new_limit':10})['new_limit'] is None
    for bad in (-1,1.5,True,'500'):
        with pytest.raises(HTTPException):
            app.checked_settings({'new_limit':bad})


@pytest.mark.parametrize('interval,state',[(180,'learned'),(180.01,'mastered'),(181,'mastered')])
def test_auto_mastery_boundary_and_cap_are_applied_to_computed_interval(database,interval,state):
    calculated,due,actual=training._schedule({'interval_days':0},{'medium':interval},2)
    assert calculated==interval and actual==state
    assert (due is None)==(state=='mastered')
    calculated,due,actual=training._schedule({'interval_days':0},{'medium':interval,'max':180},2)
    assert calculated==180 and actual=='learned' and due is not None


def test_auto_mastery_grade_receipt_replays_with_no_due_and_history_is_real(database):
    bid=base(type='solve',medium=181);entry(bid)
    card=cards(bid)[0]
    request=training.GradeRequest(grade=2,request_id=uuid4(),content_key=card['content_key'])
    result=training.grade_card(card['id'],request)
    assert result=={'grade':2,'due':None,'interval_days':181,'state':'mastered'}
    assert training.grade_card(card['id'],request)==result
    assert cards(bid)==[]
    with db.get_conn() as conn:
        row=conn.execute('SELECT * FROM review_history WHERE card_id=?',(card['id'],)).fetchone()
        assert row['due']=='' and row['grade']==2 and row['interval_days']==181
        assert conn.execute('SELECT count(*) FROM review_history').fetchone()[0]==1
    summary=training.reviews()['bases'][0]
    assert summary['learned']==summary['mastered']==1


def test_auto_mastery_migration_preserves_history_and_explicit_settings(database):
    bid=base(type='solve',new_limit=10,hard=1,medium=3,easy=7)
    entry(bid);entry(bid,'1. d4 *')
    first,second=cards(bid)
    training.grade_card(first['id'],training.GradeRequest(grade=2))
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET interval_days=181,due='2000-01-01',state='learning' WHERE id=?",(first['id'],))
        conn.execute("UPDATE review_cards SET interval_days=180,due='2000-01-01',state='learned' WHERE id=?",(second['id'],))
        old_history=[tuple(row) for row in conn.execute('SELECT * FROM review_history')]
        old_settings=conn.execute('SELECT settings FROM bases WHERE id=?',(bid,)).fetchone()[0]
        conn.execute("DELETE FROM training_migrations WHERE name='auto_master_over_180_v1'")
    training.init_training()
    before=saved(first['id'])
    assert before['state']=='mastered' and before['due'] is None and before['interval_days']==181
    assert saved(second['id'])['state']=='learned'
    training.init_training()
    assert saved(first['id'])==before
    with db.get_conn() as conn:
        assert [tuple(row) for row in conn.execute('SELECT * FROM review_history')]==old_history
        assert conn.execute('SELECT settings FROM bases WHERE id=?',(bid,)).fetchone()[0]==old_settings


def preference(threshold):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO preferences(key,value) VALUES('auto_mastery_days',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     (json.dumps(threshold),))


@pytest.mark.parametrize('threshold,interval,state',[(240,240,'learned'),(240,240.01,'mastered'),(90,90,'learned'),(90,91,'mastered')])
def test_global_mastery_threshold_applies_to_new_grades(database,threshold,interval,state):
    preference(threshold)
    bid=base(type='solve',medium=interval);entry(bid)
    card=cards(bid)[0]
    result=training.grade_card(card['id'],training.GradeRequest(grade=2,content_key=card['content_key']))
    assert result['state']==state and result['interval_days']==interval
    assert (result['due'] is None)==(state=='mastered')


def test_lowering_threshold_masters_existing_cards_and_raising_preserves_them(database):
    preference(240)
    bid=base(type='solve',medium=181);entry(bid);entry(bid,'1. d4 *')
    first,second=cards(bid)
    result=training.grade_card(first['id'],training.GradeRequest(grade=2))
    assert result['state']=='learned'
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET interval_days=180,state='learning',due='2000-01-01' WHERE id=?",(second['id'],))
        before=[tuple(r) for r in conn.execute('SELECT * FROM review_history')]
    preference(180)
    summary=training.reviews()['bases'][0]
    assert summary['mastered']==1
    assert saved(first['id'])['state']=='mastered' and saved(first['id'])['due'] is None
    assert saved(second['id'])['state']=='learning'
    preference(365)
    training.init_training()
    assert saved(first['id'])['state']=='mastered'
    assert [c['id'] for c in cards(bid)]==[second['id']]
    with db.get_conn() as conn:
        assert [tuple(r) for r in conn.execute('SELECT * FROM review_history')]==before


def test_preference_change_rejects_stale_attempt_but_replays_saved_receipt(database):
    bid=base(type='solve');entry(bid);entry(bid,'1. d4 *')
    first,second=cards(bid)
    request=training.GradeRequest(grade=2,request_id=uuid4(),content_key=first['content_key'])
    result=training.grade_card(first['id'],request)
    preference(240)
    assert training.grade_card(first['id'],request)==result
    with pytest.raises(HTTPException) as error:
        training.grade_card(second['id'],training.GradeRequest(grade=2,request_id=uuid4(),content_key=second['content_key']))
    assert error.value.status_code==409
    assert saved(second['id'])['repetitions']==0


def test_startup_and_queue_apply_current_preference_not_fixed_180(database):
    preference(240)
    bid=base(type='solve');entry(bid);entry(bid,'1. d4 *')
    first,second=cards(bid)
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET interval_days=200,state='learning',due='2000-01-01' WHERE id=?",(first['id'],))
        conn.execute("UPDATE review_cards SET interval_days=241,state='learning',due='2000-01-01' WHERE id=?",(second['id'],))
    training.init_training()
    assert saved(first['id'])['state']=='learning'
    assert saved(second['id'])['state']=='mastered'
    preference(199)
    assert cards(bid)==[]
    assert saved(first['id'])['state']=='mastered'


def test_difficult_answer_is_learned_while_failure_is_not_a_new_card(database):
    bid=base(type='solve',new_limit=1);entry(bid);entry(bid,'1. d4 *')
    first,second=cards(bid)
    answer=training.grade_card(first['id'],training.GradeRequest(grade=1))
    assert answer['state']=='learned' and answer['interval_days']==2
    failure=training.grade_card(first['id'],training.GradeRequest(grade=0))
    assert failure['state']=='learning' and saved(first['id'])['repetitions']==2
    assert [card['id'] for card in training.queue(bid, selection='learn')['cards']]==[second['id']]
    assert training.queue(bid, selection='review')['cards']==[]  # The failed card waits until its due date.


def test_existing_difficult_successes_migrate_without_changing_history_or_due(database):
    bid=base(type='solve');entry(bid);entry(bid,'1. d4 *');entry(bid,'1. c4 *')
    difficult,failed,mastered=cards(bid)
    for card,grade in [(difficult,1),(failed,0),(mastered,1)]:
        training.grade_card(card['id'],training.GradeRequest(grade=grade))
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET state='learning' WHERE id=?",(difficult['id'],))
        conn.execute("UPDATE review_cards SET state='mastered',due=NULL WHERE id=?",(mastered['id'],))
        conn.execute("DELETE FROM training_migrations WHERE name='hard_grade_learned_v1'")
        before=[tuple(row) for row in conn.execute('SELECT * FROM review_history')]
    old=saved(difficult['id'])
    training.init_training()
    after=saved(difficult['id'])
    assert after['state']=='learned'
    for key in ('due','interval_days','repetitions','lapses'):assert after[key]==old[key]
    assert saved(failed['id'])['state']=='learning'
    assert saved(mastered['id'])['state']=='mastered'
    training.init_training()
    assert saved(difficult['id'])==after
    with db.get_conn() as conn:assert [tuple(row) for row in conn.execute('SELECT * FROM review_history')]==before


@pytest.mark.parametrize('grade,factor,expected',[(1,1.5,15),(2,1.8,18),(3,2.5,25)])
def test_global_interval_multipliers_change_intervals_and_queue_snapshot(database,grade,factor,expected):
    import review_preferences
    bid=base(type='solve');entry(bid)
    card=cards(bid)[0]
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET interval_days=10,state='learned',due='2000-01-01' WHERE id=?",(card['id'],))
        factors={'hard':1.5,'medium':1.8,'easy':2.5}
        conn.execute("INSERT INTO preferences(key,value) VALUES('review_multipliers',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(json.dumps(factors),))
    card=cards(bid)[0]
    assert card['settings']['multipliers']==factors
    request=training.GradeRequest(grade=grade,content_key=card['content_key'],request_id=uuid4())
    result=training.grade_card(card['id'],request)
    assert result['interval_days']==expected and result['state']=='learned'
    with db.get_conn() as conn:conn.execute("UPDATE preferences SET value=? WHERE key='review_multipliers'",(json.dumps({'hard':2,'medium':3,'easy':4}),))
    assert training.grade_card(card['id'],request)==result


def test_multiplier_change_rejects_stale_attempt_and_preserves_floor_cap_and_again(database):
    bid=base(type='solve');entry(bid)
    card=cards(bid)[0]
    with db.get_conn() as conn:conn.execute("INSERT INTO preferences(key,value) VALUES('review_multipliers',?)",(json.dumps({'hard':2,'medium':3,'easy':4}),))
    with pytest.raises(HTTPException) as error:
        training.grade_card(card['id'],training.GradeRequest(grade=2,content_key=card['content_key']))
    assert error.value.status_code==409
    custom={'multipliers':{'hard':.1,'medium':10,'easy':10},'hard':2,'max':100}
    assert training._schedule({'interval_days':10},custom,1)[0]==2
    assert training._schedule({'interval_days':50},custom,2)[0]==100
    assert training._schedule({'interval_days':50},custom,0)[0]==10/1440
