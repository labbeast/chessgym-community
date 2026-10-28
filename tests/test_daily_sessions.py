"""Daily plans preserve source data, base settings, quotas and durable answers."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

import db
import training
import daily_review
import review_sessions as sessions


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'daily.sqlite3')
    current = [datetime(2026, 10, 24, 16, tzinfo=timezone.utc)]
    monkeypatch.setattr(training, 'now', lambda: current[0])
    db.init_db(); training.init_training()
    return current


def base(name, count=8, **options):
    settings = {'review_enabled': True, 'type': 'solve', 'new_limit': None, **options}
    with db.get_conn() as conn:
        bid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
                           (name, json.dumps(settings), training.stamp())).lastrowid
        for index in range(count):
            conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                (bid, f'{name} {index}', '1. e4 {Keep me} e5 2. Nf3 *', training.stamp(), training.stamp()))
    training.queue(bid)
    return bid


def daily(**options):
    return sessions.create_daily(sessions.CreateDailySession(request_id=uuid4(), **options))


def page(first, offset=0, limit=100):
    return sessions.get_session(UUID(first['session_id']), offset, limit)


def due(bid):
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET state='learned',due=?,repetitions=1 WHERE base_id=?",
                     (training.stamp(training.now()-timedelta(days=2)), bid))


def test_fair_multi_base_plan_preserves_individual_settings_and_source_pgn(database):
    a = base('Opening', 20, mode='automatic', hard=7)
    b = base('Mistakes', 4, mode='manual', hard=2)
    due(a); due(b)
    with db.get_conn() as conn:
        before = [tuple(row) for row in conn.execute('SELECT * FROM entries ORDER BY id')]
    first = daily(goal={'minutes': 20, 'cards': 6}, new_limit=0)
    assert first['mode']=='daily' and first['base_id'] is None
    assert first['total']==6
    assert [card['base_id'] for card in first['cards']]==[a,b,a,b,a,b]
    for card in first['cards']:
        assert card['settings']['mode']==('automatic' if card['base_id']==a else 'manual')
        assert card['base_name'] in ('Opening','Mistakes') and card['selection_reason']=='due'
    with db.get_conn() as conn:
        assert [tuple(row) for row in conn.execute('SELECT * FROM entries ORDER BY id')]==before
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0]==0


def test_session_goal_replaces_base_and_daily_new_quotas(database):
    a=base('Limited',20,new_limit=2);b=base('Open',20)
    first=daily(new_limit=5,goal={'cards':5})
    assert first['total']==5
    assert sum(c['base_id']==a for c in first['cards'])==3
    card=first['cards'][0]
    training.grade_card(card['id'],training.GradeRequest(grade=2,request_id=uuid4(),content_key=card['content_key'],
        session_id=UUID(first['session_id']),session_index=card['session_index']))
    second=daily(new_limit=5,goal={'cards':5})
    assert 'new_remaining' not in second['plan']
    assert second['total']==5
    assert card['id'] not in [c['id'] for c in second['cards']]


def test_preview_does_not_create_session_or_history_and_empty_selection_is_empty(database):
    a=base('A');b=base('B')
    preview=sessions.preview_daily(daily_review.DailyOptions(base_ids=[a],goal={'cards':3}))
    assert preview['total']==3 and preview['base_ids']==[a]
    assert {item['id'] for item in preview['bases']}=={a,b}
    assert 'cards' not in preview
    assert sessions.preview_daily(daily_review.DailyOptions(base_ids=[]))['total']==0
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_sessions').fetchone()[0]==0
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0]==0


def test_source_reasons_use_real_links_and_category_balance(database):
    normal=base('Not actually personal errors',5)
    errors=base('Exercises',5);puzzles=base('Copied',5)
    for bid in (normal,errors,puzzles):due(bid)
    with db.get_conn() as conn:
        conn.execute('CREATE TABLE game_analysis_exercises(exercise_entry_id INTEGER)')
        conn.execute('INSERT INTO game_analysis_exercises SELECT entry_id FROM review_cards WHERE base_id=?',(errors,))
        conn.execute('CREATE TABLE puzzle_copies(entry_id INTEGER)')
        conn.execute('INSERT INTO puzzle_copies SELECT entry_id FROM review_cards WHERE base_id=?',(puzzles,))
    first=daily(new_limit=0,goal={'cards':6})
    assert {c['selection_reason'] for c in first['cards']}=={'due','personal_error','failed_puzzle'}
    assert all(c['selection_reason']=='due' for c in first['cards'] if c['base_id']==normal)


def test_concurrent_creation_and_lost_answer_response_are_exactly_once(database):
    base('A')
    request=sessions.CreateDailySession(request_id=uuid4())
    with ThreadPoolExecutor(2) as pool:
        results=list(pool.map(lambda _:sessions.create_daily(request),range(2)))
    assert results[0]==results[1]
    first=results[0]; card=first['cards'][0]
    answer=training.GradeRequest(grade=2,elapsed_ms=1234,request_id=uuid4(),content_key=card['content_key'],
        session_id=UUID(first['session_id']),session_index=card['session_index'])
    with ThreadPoolExecutor(2) as pool:
        grades=list(pool.map(lambda _:training.grade_card(card['id'],answer),range(2)))
    assert grades[0]==grades[1] and grades[0]['session_completed']==1
    resumed=page(first)
    assert resumed['completed']==1 and resumed['elapsed_ms']==1234 and 0 in resumed['skipped']
    assert card['id'] not in [c['id'] for c in resumed['cards']]
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0]==1
    with pytest.raises(HTTPException):
        sessions.create_daily(request.model_copy(update={'new_limit':3}))


def test_membership_cannot_grade_another_card_or_reuse_completed_slot(database):
    base('A')
    first=daily();a,b=first['cards'][:2]
    bad=training.GradeRequest(grade=2,request_id=uuid4(),session_id=UUID(first['session_id']),session_index=a['session_index'])
    with pytest.raises(HTTPException):training.grade_card(b['id'],bad)
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0]==0
    training.grade_card(a['id'],bad)
    with pytest.raises(HTTPException):training.grade_card(a['id'],bad.model_copy(update={'request_id':uuid4()}))


def test_resume_skips_deleted_disabled_and_independently_answered_cards(database):
    a=base('A',4);b=base('B',4)
    first=daily();cards=first['cards']
    from_a=[c for c in cards if c['base_id']==a]
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?',(from_a[0]['entry_id'],))
        conn.execute('UPDATE bases SET settings=? WHERE id=?',(json.dumps({'review_enabled':False}),b))
    training.grade_card(from_a[1]['id'],training.GradeRequest(grade=2,request_id=uuid4()))
    resumed=page(first)
    assert all(c['base_id']==a for c in resumed['cards'])
    assert not {from_a[0]['id'],from_a[1]['id']} & {c['id'] for c in resumed['cards']}
    assert resumed['total']==first['total']
    assert [c['session_index'] for c in resumed['cards']]==[c['session_index'] for c in from_a[2:]]


def test_session_creation_retry_survives_deletion_and_migration_is_repeatable(database):
    bid=base('A'); request=sessions.CreateDailySession(request_id=uuid4())
    original=sessions.create_daily(request)
    with db.get_conn() as conn:
        before=[tuple(row) for row in conn.execute('SELECT * FROM review_session_items ORDER BY position')]
        sessions.init_schema(conn);sessions.init_schema(conn)
        assert [tuple(row) for row in conn.execute('SELECT * FROM review_session_items ORDER BY position')]==before
        conn.execute('DELETE FROM bases WHERE id=?',(bid,))
    assert sessions.create_daily(request)==original
    assert page(original)['cards']==[]


def test_rejects_disabled_reference_missing_duplicate_or_invalid_bases(database):
    a=base('A');off=base('Off',review_enabled=False)
    for selected in ([off],[999999],[a,a],[-1]):
        with pytest.raises(HTTPException):sessions.preview_daily(daily_review.DailyOptions(base_ids=selected))


def test_daily_endpoint_requires_authentication_and_validates_payload(database,monkeypatch):
    from local_test_client import TestClient
    import app,jobs
    monkeypatch.setattr(jobs,'start_worker',lambda:None)
    base('API')
    with TestClient(app.app,base_url='http://localhost',client=('127.0.0.1',50000)) as client:
        assert client.post('/api/review-sessions/daily-preview',json={}, headers={'Host': 'remote.invalid'}).status_code==403
        assert client.post('/api/review-sessions/daily',json={'request_id':str(uuid4())}, headers={'Host': 'remote.invalid'}).status_code==403
        assert client.get('/api/status').status_code==200
        assert client.get('/api/status').json()['capabilities']['daily_review_sessions']
        assert client.post('/api/review-sessions/daily-preview',json={'base_ids':[True]}).status_code==422
        assert client.post('/api/review-sessions/daily-preview',json={'new_limit':-1}).status_code==422
        assert client.post('/api/review-sessions/daily-preview',json={'goal':{'minutes':0}}).status_code==400
        response=client.post('/api/review-sessions/daily',json={'request_id':str(uuid4()),'goal':{'cards':3}})
        assert response.status_code==200 and response.json()['total']==3
