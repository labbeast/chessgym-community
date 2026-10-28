"""Stable paged sessions, global study days, read-only fast paths and existing quotas."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

import db
import training
import review_sessions as sessions
import review_preferences as prefs
import review_statistics as stats


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'sessions.sqlite3')
    current = [datetime(2026, 10, 22, 12, tzinfo=timezone.utc)]
    monkeypatch.setattr(training, 'now', lambda: current[0])
    monkeypatch.setattr(stats, 'now', lambda: current[0])
    db.init_db(); training.init_training()
    return current


def make_base(count=45, **settings):
    settings = {'review_enabled':True, 'type':'solve', 'new_limit':None, **settings}
    with db.get_conn() as conn:
        bid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
                           ('Review',json.dumps(settings),training.stamp())).lastrowid
        conn.executemany('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES (?,?,?,?,?)',
                        ((bid,f'Puzzle {n}','1. e4 e5 2. Nf3 *',training.stamp(),training.stamp()) for n in range(count)))
    return bid


def create(bid, **values):
    return sessions.create_session(sessions.CreateSession(base_id=bid, request_id=uuid4(), **values))


def page(first, offset=0, limit=20):
    return sessions.get_session(UUID(first['session_id']), offset, limit)


def save_pref(key, value):
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key,json.dumps(value)))


def test_paged_session_has_no_hidden_limit_and_stable_midpage_resume(database):
    bid=make_base(1005)
    first=create(bid)
    assert first['total']==1005 and len(first['cards'])==20 and first['next_offset']==20
    middle=page(first,7,20)
    assert middle['cards'][0]['id']==first['cards'][7]['id']
    assert [c['session_index'] for c in middle['cards']]==list(range(7,27))
    found=[]; offset=0
    while offset is not None:
        batch=page(first,offset,100)
        found.extend(c['id'] for c in batch['cards']);offset=batch['next_offset']
    assert len(found)==len(set(found))==1005
    assert page(first,1005)['cards']==[] and page(first,1005)['next_offset'] is None


def test_creation_uuid_is_exact_replay_and_rejects_changed_goal_after_base_deletion(database):
    bid=make_base(5); request=sessions.CreateSession(base_id=bid, request_id=uuid4())
    original=sessions.create_session(request)
    save_pref('review_session_defaults',{'cards':1,'minutes':5})
    with db.get_conn() as conn: conn.execute('DELETE FROM bases WHERE id=?',(bid,))
    assert sessions.create_session(request)==original
    changed=request.model_copy(update={'goal':{'cards':2}})
    with pytest.raises(HTTPException) as error: sessions.create_session(changed)
    assert error.value.status_code==409
    missing=page(original)
    assert missing['cards']==[] and missing['skipped']==list(range(5))


def test_parallel_identical_creation_returns_one_session(database):
    bid=make_base(3);request=sessions.CreateSession(base_id=bid,request_id=uuid4())
    with ThreadPoolExecutor(2) as pool: results=list(pool.map(lambda _:sessions.create_session(request),range(2)))
    assert results[0]==results[1]
    with db.get_conn() as conn: assert conn.execute('SELECT COUNT(*) FROM review_sessions').fetchone()[0]==1


def test_stable_order_ignores_new_entries_and_skips_deleted_mastered_without_shifting(database):
    bid=make_base(25);first=create(bid); original=page(first,0,100)['cards']
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?',(original[20]['entry_id'],))
        conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES (?,?,?,?,?)',
                     (bid,'Added','1. d4 *',training.stamp(),training.stamp()))
    training.master_card(original[22]['id'])
    later=page(first,20,20)
    assert later['skipped']==[20,22] and later['total']==25 and later['next_offset'] is None
    assert [c['session_index'] for c in later['cards']]==[21,23,24]
    assert [c['id'] for c in later['cards']]==[original[n]['id'] for n in (21,23,24)]


def test_new_order_random_persists_and_pgn_order_is_numeric(database,monkeypatch):
    class Reverse:
        def shuffle(self,values): values.reverse()
    monkeypatch.setattr(training.random,'SystemRandom',Reverse)
    ordered=create(make_base(12,new_order='pgn'))
    mixed=create(make_base(12,new_order='random'))
    assert [c['title'] for c in ordered['cards']]==[f'Puzzle {n}' for n in range(12)]
    assert [c['title'] for c in mixed['cards']]==[f'Puzzle {n}' for n in reversed(range(12))]
    assert page(mixed)['cards']==mixed['cards']


def test_opening_probability_priority_precedes_random(database,monkeypatch):
    import repertoire_coverage
    bid=make_base(1,type='moves',new_order='random',review_priority='probability')
    initial=training.queue(bid)['cards']
    with db.get_conn() as conn:
        keys={row['id']:row['identity'] for row in conn.execute('SELECT id,identity FROM review_cards WHERE base_id=?',(bid,))}
    monkeypatch.setattr(repertoire_coverage,'cached_priorities',lambda conn,base:{keys[initial[1]['id']]:.8,keys[initial[0]['id']]:.2})
    first=create(bid)
    assert first['priority']=='probability' and first['probability_available']
    assert first['cards'][0]['id']==initial[1]['id']
    assert [c['encounter_probability'] for c in first['cards']]==[.8,.2]


def test_session_goal_defaults_and_explicit_unlimited_ignore_legacy_daily_quota(database):
    bid=make_base(8,new_limit=5)
    save_pref('review_session_defaults',{'minutes':15,'cards':3})
    first=create(bid)
    assert first['total']==8 and first['goal']=={'minutes':15,'cards':3}
    second=create(bid,goal={'cards':None,'minutes':None})
    assert second['total']==8 and second['goal']=={'minutes':None,'cards':None}
    card=first['cards'][0]
    training.grade_card(card['id'],training.GradeRequest(grade=2,content_key=card['content_key'],request_id=uuid4()))
    assert create(bid,goal={'cards':None})['total']==7


def test_study_day_stats_change_without_resetting_new_card_availability(database):
    day={'timezone':'America/Toronto','start_hour':4};save_pref('study_day',day)
    bid=make_base(3,new_limit=1)
    database[0]=datetime(2026,10,22,7,59,tzinfo=timezone.utc) # 03:59 local, previous study date
    card=create(bid)['cards'][0]
    training.grade_card(card['id'],training.GradeRequest(grade=2,content_key=card['content_key']))
    before=stats.review_statistics(base_id=bid,tz='Europe/Paris')
    assert before['today']=='2026-10-21' and before['time_zone']=='America/Toronto'
    assert before['summary']['today']['reviewed']==1 and before['current']['new_available_today']==2
    assert before['current']['quota_resets_at']=='2026-10-22T08:00:00+00:00'
    assert create(bid)['total']==2
    database[0]+=timedelta(minutes=1)
    after=stats.review_statistics(base_id=bid)
    assert after['today']=='2026-10-22' and after['summary']['today']['reviewed']==0
    assert after['current']['new_available_today']==2 and create(bid)['total']==2


@pytest.mark.parametrize('at,expected_hours', [('2026-03-08T12:00:00+00:00',23),('2026-11-01T12:00:00+00:00',25)])
def test_study_boundaries_respect_daylight_saving(at,expected_hours):
    _,start,end=prefs.day_bounds(datetime.fromisoformat(at),{'timezone':'America/Toronto','start_hour':0})
    assert (end-start).total_seconds()==expected_hours*3600


@pytest.mark.parametrize('patch',[{'timezone':'Invalid/Nowhere'},{'start_hour':24},{'start_hour':True}])
def test_study_settings_reject_invalid_values(patch):
    with pytest.raises(HTTPException):prefs.checked_study_day(patch)


def test_unchanged_dashboard_queue_and_statistics_do_not_open_write_transaction(database,monkeypatch):
    bid=make_base(3);training.queue(bid)
    statements=[]; original=training.get_conn
    def traced():
        connection=original();connection.set_trace_callback(statements.append);return connection
    monkeypatch.setattr(training,'get_conn',traced);monkeypatch.setattr(stats,'get_conn',traced)
    training.reviews();training.queue(bid);stats.review_statistics(base_id=bid)
    assert not any('BEGIN IMMEDIATE' in sql or sql.startswith(('UPDATE ','INSERT ','DELETE ')) for sql in statements)


def test_statistics_projection_avoids_solutions_and_applies_mastery(database,monkeypatch):
    bid=make_base(1);card=training.queue(bid)['cards'][0]
    with db.get_conn() as conn:conn.execute("UPDATE review_cards SET interval_days=200,state='learned' WHERE id=?",(card['id'],))
    statements=[];original=stats.get_conn
    def traced():
        connection=original();connection.set_trace_callback(statements.append);return connection
    monkeypatch.setattr(stats,'get_conn',traced)
    result=stats.review_statistics(base_id=bid)
    assert result['current']['mastered']==1
    assert not any('SELECT * FROM review_cards' in sql or 'SELECT h.*' in sql for sql in statements)


def test_sessions_and_resources_api_are_private_and_validate_global_preferences(database,monkeypatch):
    import app,jobs,resource_policy
    from local_test_client import TestClient
    monkeypatch.setattr(jobs,'start_worker',lambda:None)
    monkeypatch.setattr(resource_policy,'_CURRENT',resource_policy.defaults())
    monkeypatch.setattr(resource_policy,'_DESIRED',resource_policy.defaults())

    bid=make_base(24)
    with TestClient(app.app,base_url='http://localhost',client=('127.0.0.1',50000)) as client:
        request={'base_id':bid,'request_id':str(uuid4())}
        assert client.post('/api/review-sessions',json=request, headers={'Host': 'remote.invalid'}).status_code==403
        assert client.get('/api/resource-settings', headers={'Host': 'remote.invalid'}).status_code==403
        assert client.get('/api/status').status_code==200
        assert client.patch('/api/preferences',json={'study_day':{'timezone':'America/Toronto','start_hour':4},'review_session_defaults':{'minutes':20,'cards':7}}).status_code==200
        first=client.post('/api/review-sessions',json=request)
        assert first.status_code==200
        value=first.json();assert value['goal']=={'minutes':20,'cards':7} and value['total']==24
        assert len(value['cards'])==20
        assert client.post('/api/review-sessions',json=request).json()==value
        second=client.get('/api/review-sessions/'+value['session_id']+'?offset=20&limit=20').json()
        assert len(second['cards'])==4 and second['cards'][0]['session_index']==20
        assert client.get('/api/review-sessions/'+value['session_id']+'?limit=1001').status_code==422
        assert client.patch('/api/preferences',json={'study_day':{'start_hour':True}}).status_code==400
        assert client.patch('/api/resource-settings',json={'profile':'custom','total_threads':8,'hash_mb':256,'import_workers':2}).json()['effective']['engine_threads']==3
