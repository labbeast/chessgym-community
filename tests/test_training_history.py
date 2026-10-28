"""Unified history is faithful, read-only, scoped and server-paginated."""
import json
import sqlite3
import time
from datetime import datetime, timezone

from fastapi import FastAPI
from local_test_client import TestClient
import pytest

import db
import training
import puzzle_training
import guess_move
import training_skills
import color_training
import training_history as history
from accounts_api import require_user

STAMP = '2026-10-24T12:00:00+00:00'
EPOCH = datetime.fromisoformat(STAMP).timestamp()


def insert(conn, table, **values):
    columns = ','.join(values)
    conn.execute(f"INSERT INTO {table} ({columns}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'history.sqlite3')
    db.init_db()
    training.init_training()
    puzzle_training.init_puzzles()
    guess_move.init_guess_move()
    training_skills.init_training_skills()
    color_training.init_color_training()
    with db.get_conn() as conn:
        conn.execute("PRAGMA ignore_check_constraints=ON")
        conn.execute("INSERT INTO users VALUES(1,'owner','unused','today'),(2,'other','unused','today')")
        conn.execute("PRAGMA ignore_check_constraints=OFF")
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(1,'Tactics 100%','today')")
        conn.execute("INSERT INTO entries(id,base_id,title,pgn,created_at,updated_at) VALUES(1,1,'King attack','*','today','today')")
        conn.execute("""CREATE TABLE IF NOT EXISTS reading_visits(id TEXT PRIMARY KEY,user_id INTEGER DEFAULT 1,
          entry_id INTEGER,base_id INTEGER,title TEXT,base_name TEXT,started_at TEXT,updated_at TEXT,
          finished_at TEXT,active_seconds REAL,first_path TEXT,last_path TEXT,read_moves INTEGER,total_moves INTEGER)""")
    app = FastAPI()
    app.include_router(history.router)
    app.dependency_overrides[require_user] = lambda: {'id': 1}
    with TestClient(app) as result:
        yield result


def response(client, query=''):
    value = client.get('/api/training/history' + query)
    assert value.status_code == 200, value.text
    return value.json()


def detail(client, tool, identity, query=''):
    value = client.get(f'/api/training/history/{tool}/{identity}' + query)
    assert value.status_code == 200, value.text
    return value.json()


def seed_review(conn):
    insert(conn, 'review_cards', id='card', base_id=1, entry_id=1, type='puzzle', identity='key',path='',fen='fen',answers='[]',solutions='[]',title='King attack',updated_at=STAMP)
    insert(conn, 'review_history', id=1,card_id='card',reviewed_at=STAMP,grade=2,proposed_grade=2,requested_grade=2,errors=0,hints=0,elapsed_ms=12000,assisted=0,mode='hybrid',interval_days=5,due=STAMP)


def seed_puzzle(conn, identity='puzzle-a', mode='classic', session_id=None, **overrides):
    values = dict(id=identity,puzzle_id='abcd',mode=mode,session_id=session_id,snapshot=json.dumps({'rating':1723}),fen='fen',next_index=3,version=3,status='completed',failed=0,hints=0,rated=1,rating_before=1600,rating_after=1610,started_at=STAMP,started_ms=int(EPOCH*1000),finished_at='2026-10-24T12:00:05+00:00',elapsed_ms=5000)
    values.update(overrides)
    insert(conn,'puzzle_attempts',**values)


def seed_skill(conn, tool, identity=None, user_id=1, *, abandoned=False, active=False):
    state = {'correct':2,'errors':1,'events':[
        {'square':'a1','target':{'square':'a1'},'correct':True,'elapsed_ms':1000},
        {'square':'b2','target':{'square':'a2','piece':'N'},'correct':False,'elapsed_ms':3000},
        {'square':'a2','target':{'square':'a2','piece':'N'},'correct':True,'elapsed_ms':4000}],
        'title':'Blind puzzle','attempts':[{'move':'Nf3','correct':True,'elapsed_ms':1500}]}
    result = {'abandoned':True} if abandoned else ({'score':2,'errors':1,'accuracy':66.7,'duration':30} if tool=='coordinates' else
        {'success':False,'solve_success':True,'reconstruction_success':False,'errors':0,'elapsed_ms':6000,'reconstruction_elapsed_ms':4500,'expected':{'a1':'K'},'proposed':{'b1':'K'},'accuracy':0})
    insert(conn,'skill_sessions',id=identity or tool,user_id=user_id,kind=tool,config=json.dumps({'duration':30,'mode':'mixed' if tool=='coordinates' else 'opening','orientation':'black'}),state=json.dumps(state),created_at=EPOCH-2,started_at=EPOCH,finished_at=None if active else EPOCH+30,result=None if active else json.dumps(result))


def seed_color(conn, identity='color', user_id=1, *, abandoned=False, active=False, errors=0):
    state = {'correct':2,'errors':errors,'events':[{'square':'a1','color':'black','correct':True,'elapsed_ms':0},{'square':'b1','color':'white','correct':True,'elapsed_ms':1500}]}
    result = {'score':2,'errors':errors,'accuracy':100 if not errors else 66.7,'record_eligible':not abandoned and not errors,'completed':not abandoned,'abandoned':abandoned}
    insert(conn,'color_sessions',id=identity,user_id=user_id,duration=30,state=json.dumps(state),created_at=EPOCH-100,started_at=EPOCH,finished_at=None if active else EPOCH+(8 if abandoned else 30),result=None if active else json.dumps(result))


def seed_guess(conn, identity='guess', user_id=1, *, active=False):
    insert(conn,'guess_sessions',id=identity,user_id=user_id,entry_id=1,title='Fischer — Spassky',source_pgn='*',start_path='',current_path='' if active else None,side='white',created_at=STAMP,updated_at='2026-10-24T12:00:06+00:00')
    for i,(score,ms) in enumerate(((10,1500),(5,2500))):
        insert(conn,'guess_attempts',session_id=identity,path=str(i),uci='e2e4',elapsed_ms=ms,score=score,exact=i==0,result=json.dumps({'san':'e4'}),created_at=STAMP)


def seed_computer(conn, identity='computer', user_id=1, *, timed=True, result='1-0', side='white', baseline=0):
    clock = {'initial_ms':60000,'increment_ms':2000,'remaining':{'white':59000,'black':58000},'history':[{'ply':baseline,'remaining':{'white':60000,'black':60000}},{'ply':baseline+1,'remaining':{'white':59000,'black':60000}},{'ply':baseline+2,'remaining':{'white':59000,'black':58000}}]} if timed else None
    nodes=[{'san':None}]+[{'san':'setup'}]*baseline+[{'san':'e4'},{'san':'e5'}]
    snapshot={'session':{'baseline':baseline,'clock':clock,'position':{'history':['x']*(baseline+2),'doc':{'nodes':nodes}}}}
    insert(conn,'computer_games',user_id=user_id,id=identity,revision=1,snapshot=json.dumps(snapshot),pgn='*',white='Human',black='Stockfish',side=side,provider='stockfish',result=result,reason='checkmate' if result!='*' else None,ply_count=baseline+2,time_control='60+2' if timed else '-',created_at=STAMP,updated_at=STAMP,finished_at=None if result=='*' else STAMP)


def seed_reading(conn, identity='reading', user_id=1):
    insert(conn,'reading_visits',id=identity,user_id=user_id,entry_id=1,base_id=1,title='Logical Chess',base_name='Chernev',started_at=STAMP,updated_at=STAMP,finished_at=STAMP,active_seconds=15.25,first_path='',last_path='0.0',read_moves=2,total_moves=50)


def seed_all(conn):
    seed_review(conn)
    seed_puzzle(conn)
    insert(conn,'puzzle_storm',id='storm',started_ms=int(EPOCH*1000),deadline_ms=int((EPOCH+190)*1000),status='completed',color='white',score=1,mistakes=1,best_combo=1,solved_rating=1000,finished_at='2026-10-24T12:03:10+00:00')
    seed_puzzle(conn,identity='storm-solved',mode='storm',session_id='storm')
    seed_puzzle(conn,identity='storm-failed',mode='storm',session_id='storm',failed=1,status='revealed')
    seed_guess(conn)
    seed_skill(conn,'coordinates')
    seed_skill(conn,'blindfold')
    seed_color(conn)
    seed_computer(conn)
    seed_reading(conn)


def test_history_sorts_the_full_filtered_population_and_paginates_stably(client):
    descending = client.get('/api/training/history?sort=duration&descending=true&limit=100').json()['items']
    known = [item['duration_ms'] for item in descending if item['duration_ms'] is not None]
    assert known == sorted(known, reverse=True)
    ascending = client.get('/api/training/history?sort=duration&descending=false&limit=100').json()['items']
    known = [item['duration_ms'] for item in ascending if item['duration_ms'] is not None]
    assert known == sorted(known)
    full = client.get('/api/training/history?sort=activity&descending=false&limit=100').json()['items']
    pages = [client.get(f'/api/training/history?sort=activity&descending=false&limit=3&offset={offset}').json()['items']
             for offset in range(0, len(full), 3)]
    assert [item['key'] for page in pages for item in page] == [item['key'] for item in full]
    assert client.get('/api/training/history?sort=unknown').status_code == 422


def test_all_tools_normalized_without_duplicate_storm_attempts(client):
    with db.get_conn() as conn:
        seed_all(conn)
    data=response(client)
    assert data['total']==9
    by_tool={row['tool']:row for row in data['items']}
    assert set(by_tool)==set(history.TOOLS)
    assert by_tool['review']['unit']=='answer' and by_tool['puzzles']['unit']=='attempt'
    assert by_tool['computer']['unit']=='game' and by_tool['storm']['unit']=='session'
    assert by_tool['review']['duration_ms']==12000
    assert by_tool['puzzles']['duration_ms']==5000
    assert by_tool['storm']['duration_ms']==190000
    assert by_tool['guess']['duration_ms']==4000
    assert by_tool['guess']['score']==15 and by_tool['guess']['maximum']==20
    assert by_tool['coordinates']['duration_ms']==30000 and by_tool['coordinates']['outcome']=='mixed'
    assert by_tool['blindfold']['outcome']=='failure' and by_tool['blindfold']['metrics']['solve_success']==1
    assert by_tool['color']['metrics']['record_eligible']==1
    assert by_tool['computer']['duration_ms']==7000
    assert by_tool['reading']['duration_ms']==15250 and by_tool['reading']['outcome']=='unknown'
    assert all(row['key']==row['tool']+':'+row['id'] for row in data['items'])


def test_unknown_unlimited_computer_time_is_not_wall_time(client):
    with db.get_conn() as conn:
        seed_computer(conn,timed=False)
    item=response(client,'?tool=computer')['items'][0]
    assert item['duration_ms'] is None and item['duration_kind']=='unknown'


@pytest.mark.parametrize('timing,started,expected', [
    ({'preparation_ms': 2000, 'elapsed_ms': 6000, 'total_elapsed_ms': 8000}, EPOCH, 8000),
    ({'preparation_ms': 2000, 'elapsed_ms': 6000}, EPOCH, 8000),
    ({'preparation_ms': 8500, 'elapsed_ms': 0, 'total_elapsed_ms': 8500}, None, 8500),
    ({'preparation_ms': 8500, 'elapsed_ms': 8500}, None, 8500),
    ({'elapsed_ms': 6000}, EPOCH, 6000),
    ({}, EPOCH, None),
])
def test_blindfold_history_and_statistics_include_recorded_visualization_once(client, timing, started, expected):
    with db.get_conn() as conn:
        seed_skill(conn, 'blindfold')
        conn.execute('UPDATE skill_sessions SET started_at=?,result=? WHERE id=?',
                     (started, json.dumps({'success': True, **timing}), 'blindfold'))
    item = response(client, '?tool=blindfold')['items'][0]
    assert item['duration_ms'] == expected
    assert item['metrics']['preparation_ms'] == timing.get('preparation_ms')
    assert datetime.fromisoformat(item['started_at']).timestamp() == EPOCH - 2
    stats = response(client, '/statistics?tool=blindfold')
    assert stats['duration'] == {'total_ms': expected, 'known_count': int(expected is not None),
                                'unknown_count': int(expected is None)}
    assert detail(client, 'blindfold', 'blindfold')['details'].get('preparation_ms') == timing.get('preparation_ms')


def test_computer_duration_excludes_source_prefix_and_increment(client):
    with db.get_conn() as conn:
        seed_computer(conn,baseline=10)
    result=detail(client,'computer','computer')
    assert result['item']['duration_ms']==7000
    assert [event['action'] for event in result['events']]==['e4','e5']
    assert [event['duration_ms'] for event in result['events']]==[3000,4000]
    assert result['event_count']==2


@pytest.mark.parametrize('result,side,outcome',[('1-0','white','success'),('1-0','black','failure'),('0-1','black','success'),('1/2-1/2','white','draw'),('*','white','unknown')])
def test_computer_result_is_from_human_perspective(client,result,side,outcome):
    with db.get_conn() as conn:
        seed_computer(conn,result=result,side=side)
    assert response(client,'?tool=computer')['items'][0]['outcome']==outcome


def test_filters_status_outcome_text_and_deterministic_pagination(client):
    with db.get_conn() as conn:
        seed_all(conn)
        seed_color(conn,'active',active=True)
        seed_color(conn,'interrupted',abandoned=True)
    assert response(client,'?status=active')['total']==1
    assert response(client,'?status=interrupted')['total']==1
    assert response(client,'?tool=color&outcome=success')['total']==1
    assert response(client,'?q=100%25')['total']==1
    assert response(client,'?q=Spassky')['items'][0]['tool']=='guess'
    full=response(client)['items']
    first=response(client,'?limit=4')['items']
    second=response(client,'?offset=4&limit=4')['items']
    assert first+second==full[:8]
    assert response(client,'?offset=100')['items']==[]


@pytest.mark.parametrize('query',['?tool=nope','?status=nope','?outcome=nope','?date_from=tomorrow','?date_from=2026-10-25&date_to=2026-10-24','?time_zone=No/Zone','?limit=101','?offset=-1'])
def test_invalid_filters_are_rejected(client,query):
    assert client.get('/api/training/history'+query).status_code==422


def test_date_filter_uses_local_calendar_day_and_dst(client):
    with db.get_conn() as conn:
        for identity,stamp in [('before','2026-11-01T03:59:59+00:00'),('first','2026-11-01T04:00:00+00:00'),('last','2026-11-02T04:59:59+00:00'),('after','2026-11-02T05:00:00+00:00')]:
            seed_computer(conn,identity=identity)
            conn.execute('UPDATE computer_games SET created_at=? WHERE id=?',(stamp,identity))
    rows=response(client,'?tool=computer&date_from=2026-11-01&date_to=2026-11-01&time_zone=America/Toronto')['items']
    assert [row['id'] for row in rows]==['last','first']


def test_account_isolation_and_owner_only_legacy_data(client):
    with db.get_conn() as conn:
        seed_all(conn)
        seed_guess(conn,'other-guess',2)
        seed_skill(conn,'blindfold','other-blindfold',2)
        seed_color(conn,'other-color',2)
        seed_computer(conn,'other-computer',2)
        seed_reading(conn,'other-reading',2)
    owner=response(client)
    assert owner['total']==9
    client.app.dependency_overrides[require_user]=lambda:{'id':2}
    other=response(client)
    assert other['total']==5 and all(row['id'].startswith('other-') for row in other['items'])
    assert client.get('/api/training/history/review/1').status_code==404
    assert client.get('/api/training/history/computer/computer').status_code==404
    client.app.dependency_overrides.clear()
    assert client.get('/api/training/history',headers={'Host':'remote.example'}).status_code==403


def test_details_retain_moves_answers_and_reconstruction(client):
    with db.get_conn() as conn:
        seed_all(conn)
        for index,(san,correct,elapsed) in enumerate([('Nf3',0,1000),('Bc4',1,3000)]):
            insert(conn,'puzzle_events',attempt_id='puzzle-a',request_id=str(index),ordinal=index,move='g1f3',san=san,correct=correct,hint=0,fen='fen',elapsed_ms=elapsed,response='{}')
    review=detail(client,'review','1')
    assert review['details']['grade']==2 and review['events'][0]['duration_ms']==12000
    puzzles=detail(client,'puzzles','puzzle-a')
    assert [event['action'] for event in puzzles['events']]==['Nf3','Bc4']
    assert [event['duration_ms'] for event in puzzles['events']]==[1000,2000]
    storm=detail(client,'storm','storm')
    assert storm['event_count']==2
    assert {event['result'] for event in storm['events']}=={'success','failure'}
    guess=detail(client,'guess','guess')
    assert [event['details']['score'] for event in guess['events']]==[10,5]
    coordinates=detail(client,'coordinates','coordinates')
    assert [event['action'] for event in coordinates['events']]==['a1','Na2','Na2']
    assert coordinates['events'][1]['details']['answer']=='b2'
    color=detail(client,'color','color')
    assert color['events'][0]['details']['answer']=='black'
    blind=detail(client,'blindfold','blindfold')
    assert blind['event_count']==2 and blind['events'][-1]['result']=='failure'
    assert blind['events'][-1]['details']['proposed']=={'b1':'K'}
    assert detail(client,'reading','reading')['details']['last_path']=='0.0'


@pytest.mark.parametrize('tool,identity',[('coordinates','coordinates'),('color','color'),('guess','guess'),('storm','storm'),('computer','computer'),('puzzles','puzzle-a'),('blindfold','blindfold'),('review','1')])
def test_event_pagination_matches_full_detail(client,tool,identity):
    with db.get_conn() as conn:
        seed_all(conn)
        for index in range(3):
            insert(conn,'puzzle_events',attempt_id='puzzle-a',request_id=str(index),ordinal=index,move='g1f3',san='Nf3',correct=1,hint=0,fen='fen',elapsed_ms=1000*(index+1),response='{}')
    full=detail(client,tool,identity)
    gathered=[]
    for offset in range(full['event_count']):
        part=detail(client,tool,identity,f'?events_offset={offset}&events_limit=1')
        gathered+=part['events']
        assert part['next_events_offset']==(offset+1 if offset+1<full['event_count'] else None)
    assert gathered==full['events']
    assert detail(client,tool,identity,'?events_offset=100')['events']==[]


def test_history_reads_never_finalize_expired_sessions_or_modify_sources(client):
    with db.get_conn() as conn:
        seed_color(conn,active=True)
        seed_skill(conn,'coordinates',active=True)
        before=conn.execute('SELECT result,finished_at,state FROM color_sessions').fetchone()
    response(client)
    detail(client,'color','color')
    with db.get_conn() as conn:
        after=conn.execute('SELECT result,finished_at,state FROM color_sessions').fetchone()
        assert tuple(before)==tuple(after)
        assert conn.execute('SELECT finished_at FROM skill_sessions').fetchone()[0] is None


def test_no_source_tables_is_supported_without_migration(client,monkeypatch,tmp_path):
    empty=tmp_path/'empty.sqlite3'
    sqlite3.connect(empty).close()
    monkeypatch.setattr(db,'DB_PATH',empty)
    assert response(client)['items']==[]


def test_ten_thousand_visits_and_drills_are_filtered_in_sql(client):
    with db.get_conn() as conn:
        values=[(f'visit-{i:05}',1,None,None,'Logical Chess','Book',STAMP,STAMP,STAMP,3.5,'','0',1,100) for i in range(10000)]
        conn.executemany('INSERT INTO reading_visits(id,user_id,entry_id,base_id,title,base_name,started_at,updated_at,finished_at,active_seconds,first_path,last_path,read_moves,total_moves) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',values)
        conn.executemany('INSERT INTO color_sessions(id,user_id,duration,state,created_at,started_at,finished_at,result) VALUES(?,?,?,?,?,?,?,?)',[(f'color-{i:05}',1,30,'{"correct":1,"errors":0}',EPOCH,EPOCH,EPOCH+30,'{"score":1,"errors":0}') for i in range(10000)])
    began=time.monotonic()
    data=response(client,'?tool=reading&offset=9950&limit=25')
    assert data['total']==10000 and len(data['items'])==25
    assert response(client,'?tool=color&outcome=success&limit=10')['total']==10000
    # This is a small-account-history query, not a scan/parse of PGN libraries.
    assert time.monotonic()-began<8


def test_large_event_history_remains_fully_accessible(client):
    with db.get_conn() as conn:
        seed_color(conn)
        events=[{'square':'a1','color':'black','correct':True,'elapsed_ms':100*i} for i in range(600)]
        conn.execute('UPDATE color_sessions SET state=?',(json.dumps({'correct':600,'errors':0,'events':events}),))
    first=detail(client,'color','color')
    assert first['event_count']==600 and len(first['events'])==100
    assert first['next_events_offset']==100
    last=detail(client,'color','color','?events_offset=500&events_limit=100')
    assert len(last['events'])==100 and last['next_events_offset'] is None
    assert last['events'][0]['duration_ms']==100


def test_reading_volume_is_not_confused_with_cumulative_progress(client):
    with db.get_conn() as conn:
        seed_reading(conn)
    row=response(client,'?tool=reading')['items'][0]
    assert row['completed_count'] is None and row['total_count'] is None
    assert row['metrics']['read_moves']==2 and row['metrics']['progress']==4


def test_computer_keeps_captured_start_date_when_uploaded_later(client):
    with db.get_conn() as conn:
        seed_computer(conn)
        row=conn.execute('SELECT snapshot FROM computer_games').fetchone()
        snapshot=json.loads(row['snapshot'])
        snapshot['session']['started_at']='2026-10-23T19:00:00+00:00'
        conn.execute('UPDATE computer_games SET snapshot=?',(json.dumps(snapshot),))
    assert response(client,'?tool=computer')['items'][0]['started_at'].startswith('2026-10-23T19:00:00')


def test_new_computer_active_time_takes_precedence_over_clock(client):
    with db.get_conn() as conn:
        seed_computer(conn,timed=True)
        snapshot=json.loads(conn.execute('SELECT snapshot FROM computer_games').fetchone()[0])
        snapshot['session']['activity']={'version':1,'elapsed_ms':12345.7}
        conn.execute('UPDATE computer_games SET snapshot=?',(json.dumps(snapshot),))
    row=response(client,'?tool=computer')['items'][0]
    assert row['duration_ms']==12346 and row['duration_kind']=='active'


def test_review_start_uses_recorded_answer_duration(client):
    with db.get_conn() as conn:
        seed_review(conn)
    row=response(client,'?tool=review')['items'][0]
    start=datetime.fromisoformat(row['started_at']);end=datetime.fromisoformat(row['finished_at'])
    assert (end-start).total_seconds()==12 and row['duration_kind']=='elapsed'
