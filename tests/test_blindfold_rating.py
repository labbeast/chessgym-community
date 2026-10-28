"""Progressive selection, solve-only ratings and secondary reconstruction stats."""
import json
import sqlite3
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pytest

import blindfold_rating as rating
import db
import pgnlib
import puzzle_store
import training_skills as skills
from test_training_skills import client, puzzle, PGN, ok, stored, _pieces, _solve_two


@pytest.fixture
def mate(monkeypatch):
    value = {'id': 'mate3', 'fen': '8/5K1k/6Q1/8/8/8/8/8 b - - 0 1',
             'moves': ['h7h8', 'g6g7'], 'rating': 900,
             'game_url': 'https://lichess.org/abcdefgh#1', 'color': 'white'}
    monkeypatch.setattr(puzzle_store, 'search_puzzles', lambda *args, **kwargs: [value])
    return value


def start(client, **extra):
    return ok(client.post('/api/skills/blindfold', json={'mode': 'positions', 'rated': True, **extra}))


def solve(client, session):
    sid = session['id']
    ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    return ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'g6g7', 'index': 0}))


def finish(client, session, pieces=None):
    sid = session['id']
    return ok(client.post(f'/api/skills/blindfold/{sid}/position',
                          json={'pieces': _pieces(stored(sid)['state']['fen']) if pieces is None else pieces}))


@pytest.mark.parametrize('level,moves,pieces', [(500,5,3),(1000,10,6),(1500,17,11),(2000,27,17),(2500,38,24),(3000,50,32)])
def test_curve_anchor_points(level,moves,pieces):
    target = rating.targets(level)
    assert (target['moves'],target['pieces']) == (moves,pieces)
    assert target['moves_min'] <= moves <= target['moves_max']
    assert 3 <= target['pieces_min'] <= pieces <= target['pieces_max'] <= 32


def test_curve_clamps_and_is_monotone():
    assert rating.targets(-10) == rating.targets(500)
    assert rating.targets(99999) == rating.targets(3000)
    values = [rating.targets(level) for level in range(500,3001)]
    assert all(a['moves'] <= b['moves'] and a['pieces'] <= b['pieces'] for a,b in zip(values,values[1:]))


def test_selection_relaxes_tactics_without_accepting_too_short_or_sparse_positions(client,monkeypatch):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO blindfold_profiles(user_id,mode,rating) VALUES(1,'opening',3000)")
        conn.execute("INSERT INTO blindfold_profiles(user_id,mode,rating) VALUES(1,'positions',3000)")
    calls=[]
    def search(filters,**kwargs):
        calls.append((dict(filters),kwargs))
        return [] if len(calls)%3 else [{'id':'eligible'}]
    monkeypatch.setattr(puzzle_store,'search_puzzles',search)
    for mode in ['opening','positions']:
        with db.get_conn() as conn:
            rows,challenge=rating.selection(conn,1,mode)
        assert rows and challenge['level']==3000 and challenge['curve']==1.4
        selected=calls[-3:]
        assert [c[0]['rating_max']-c[0]['rating_min'] for c in selected]==[400,1000,4000]
        if mode=='opening':
            assert all(c[0]['min_initial_ply']==95 and c[0]['max_initial_ply']==104 for c in selected)
        else:
            assert all(c[0]['min_pieces']==31 and c[0]['max_pieces']==32 for c in selected)


def test_exercise_difficulty_credits_actual_visual_load_and_tactics():
    low=rating.exercise({},'opening',moves=5,pieces=32,puzzle_rating=800)
    long=rating.exercise({},'opening',moves=50,pieces=10,puzzle_rating=800)
    hard=rating.exercise({},'opening',moves=50,pieces=10,puzzle_rating=2050)
    assert low['exercise_rating']==500 < long['exercise_rating'] < hard['exercise_rating']==3000
    assert rating.exercise({},'positions',moves=50,pieces=32,puzzle_rating=2050)['exercise_rating']==3000


@pytest.mark.parametrize('reconstruct_after',[False,True])
def test_rated_settings_require_hiding_but_allow_optional_reconstruction(client,mate,reconstruct_after):
    session=start(client,hide_prompt=False,reconstruct_after=reconstruct_after)
    assert session['config']['hide_prompt'] is True
    assert session['config']['reconstruct_after'] is reconstruct_after
    assert session['rated'] and session['challenge']['curve']==1.4
    answer=solve(client,session)
    if reconstruct_after:
        assert answer['phase']=='reconstruct' and not answer['finished']
        assert not any(k in answer for k in ['prompt','document','fen','target_fen','expected'])
        with db.get_conn() as conn:
            assert conn.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==0
        result=finish(client,session)['result']
        assert result['accuracy']==100 and result['reconstruction_success']
    else:
        assert answer['finished'] and answer['phase']=='finished'
        result=answer['result']
        assert 'accuracy' not in result and 'reconstruction_success' not in result
    assert result['success'] and result['solve_success'] and result['rating_success']
    assert result['points']>0 and result['rating_after']>result['rating_before']
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==1


def test_reconstruction_accuracy_does_not_change_rating_or_solve_success(client,mate,monkeypatch):
    monkeypatch.setattr(rating.time,'time',lambda:1800000000)
    outcomes=[]
    for reconstruction in ['perfect','partial','empty']:
        # Give independent attempts identical initial profiles and difficulty.
        mate['id']='mate3-'+reconstruction
        with db.get_conn() as conn:
            conn.execute('DELETE FROM blindfold_profiles')
            conn.execute("INSERT INTO blindfold_profiles(user_id,mode,rating) VALUES(1,'positions',1200)")
        session=start(client);solve(client,session)
        proposed=_pieces(stored(session['id'])['state']['fen'])
        if reconstruction=='partial':
            proposed.pop('h8')
        elif reconstruction=='empty':
            proposed={}
        result=finish(client,session,proposed)['result']
        assert result['success'] and result['solve_success'] and result['rating_success']
        assert result['reconstruction_success'] is (reconstruction=='perfect')
        if reconstruction=='perfect':
            assert result['accuracy']==100
        elif reconstruction=='partial':
            assert 0<result['accuracy']<100
        else:
            assert result['accuracy']==0
        assert result['points']>0 and result['rating_after']>result['rating_before']
        outcomes.append(tuple(result[key] for key in ['rating_before','rating_after','rating_delta','points']))
        with db.get_conn() as conn:
            profile=conn.execute('SELECT rated_count,wins FROM blindfold_profiles').fetchone()
            assert (profile['rated_count'],profile['wins'])==(1,1)
    assert outcomes[0]==outcomes[1]==outcomes[2]
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM blindfold_rating_events WHERE success=1').fetchone()[0]==3


def test_perfect_reconstruction_after_a_wrong_move_earns_no_points(client,mate):
    session=start(client);sid=session['id']
    ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    ok(client.post(f'/api/skills/blindfold/{sid}/answer',json={'move':'g6g5','index':0}))
    ok(client.post(f'/api/skills/blindfold/{sid}/answer',json={'move':'g6g7','index':1}))
    result=finish(client,session)['result']
    assert result['reconstruction_success'] and not result['solve_success']
    assert result['points']==0 and not result['rating_success']


def test_two_modes_have_separate_cotes_and_same_puzzle_is_eligible_once_per_mode(client,puzzle,monkeypatch):
    monkeypatch.setattr(skills,'_source_game',lambda url:pgnlib.load_game(PGN))
    for mode in ['positions','opening']:
        session=start(client,mode=mode);_solve_two(client,session['id'])
        result=finish(client,session,{})['result']
        assert result['points']>0 and result['rating_success']
        assert not result['reconstruction_success'] and result['accuracy']==0
        if mode == 'positions':
            first = ok(client.get('/api/skills/blindfold/overview'))['profiles']['positions']
    profiles=ok(client.get('/api/skills/blindfold/overview'))['profiles']
    assert all(profiles[m]['rated_count']==1 and profiles[m]['wins']==1 for m in rating.MODES)
    # Both first wins can hit Glicko's 700-point cap. Independence means the
    # opening result leaves the already graded positions profile unchanged.
    assert profiles['positions']['rating'] == first['rating']
    assert profiles['positions']['last_rated_at'] == first['last_rated_at']


def test_repeated_or_concurrent_final_submissions_grade_only_once(client,mate):
    session=start(client);solve(client,session)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:finish(client,session,{})['result'],range(2)))
    assert results[0]==results[1]
    assert results[0]['rating_success'] and not results[0]['reconstruction_success']
    assert finish(client,session)['result']==results[0]
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==1
        assert conn.execute('SELECT rated_count FROM blindfold_profiles').fetchone()[0]==1
    repeat=start(client);waiting=solve(client,repeat)
    assert waiting['rating_eligible'] is False
    assert 'rating_after' not in finish(client,repeat)['result']
    assert ok(client.get('/api/skills/blindfold/overview'))['profiles']['positions']['rated_count']==1


def test_abandoning_started_exercise_counts_as_failure_unstarted_does_not(client,mate):
    first=start(client)
    second=start(client)
    assert stored(first['id'])['result']['abandoned']
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==0
    ok(client.post(f'/api/skills/blindfold/{second["id"]}/ready'))
    start(client)
    result=stored(second['id'])['result']
    assert result['abandoned'] and result['points']==0 and not result['rating_success']
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==1


@pytest.mark.parametrize('action',['reveal','abandon','replace'])
@pytest.mark.parametrize('after_solving',[False,True])
def test_ending_reconstruction_preserves_solved_rating(client,mate,action,after_solving):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO blindfold_profiles(user_id,mode,rating) VALUES(1,'positions',1200)")
    session=start(client);sid=session['id']
    if after_solving:solve(client,session)
    else:ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    if action=='replace':
        start(client)
        result=stored(sid)['result']
    else:
        result=ok(client.post(f'/api/skills/blindfold/{sid}/{action}'))['result']
        assert ok(client.post(f'/api/skills/blindfold/{sid}/{action}'))['result']==result
    if action=='reveal':
        assert result['revealed']
    elif not after_solving:
        assert result['abandoned']
    if after_solving:
        assert result['reconstruction_skipped'] and not result.get('abandoned')
    assert result['rating_success'] is after_solving
    if after_solving:
        assert result['solve_success'] and not result['reconstruction_success']
        assert result['points']>0 and result['rating_after']>result['rating_before']
    else:
        assert result['points']==0 and result['rating_after']<result['rating_before']
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==1
        profile=conn.execute('SELECT rated_count,wins FROM blindfold_profiles').fetchone()
        assert (profile['rated_count'],profile['wins'])==(1,int(after_solving))


def test_free_practice_and_legacy_sessions_have_no_rating_or_seen_side_effect(client,mate):
    session=start(client,rated=False,reconstruct_after=False)
    result=solve(client,session)['result']
    assert result['success'] and 'rating_after' not in result
    with db.get_conn() as conn:
        for table in ['blindfold_profiles','blindfold_seen','blindfold_rating_events']:
            assert conn.execute('SELECT count(*) FROM '+table).fetchone()[0]==0


def test_ratings_survive_reinitialization_and_personal_backup(client,mate,tmp_path,monkeypatch):
    import backup_service
    monkeypatch.setattr(rating.time, 'time', lambda: 1800000000)
    session=start(client);solve(client,session);finish(client,session)
    before=ok(client.get('/api/skills/blindfold/overview'))['profiles']
    skills.init_training_skills()
    assert ok(client.get('/api/skills/blindfold/overview'))['profiles']==before
    archive=tmp_path/'personal.zip'
    backup_service.build_archive(archive,'personal')
    with zipfile.ZipFile(archive) as z:
        restored=tmp_path/'restored.sqlite3';restored.write_bytes(z.read('chessgym.sqlite3'))
    with sqlite3.connect(restored) as c:
        assert c.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==1
        assert c.execute('SELECT rating FROM blindfold_profiles').fetchone()[0]==before['positions']['rating']
        assert c.execute('PRAGMA foreign_key_check').fetchall()==[]


def test_overview_resumes_canonical_phase_and_rejects_client_score_injection(client,mate):
    assert client.post('/api/skills/blindfold',json={'mode':'positions','rated':True,'rating':3000}).status_code==422
    session=start(client);waiting=solve(client,session)
    assert ok(client.get('/api/skills/blindfold/overview'))['active_session']=={k:v for k,v in waiting.items() if k!='correct'}
    assert client.post(f'/api/skills/blindfold/{session["id"]}/position',json={'pieces':{},'success':True}).status_code==422


def test_explicit_abandon_is_owned_idempotent_and_does_not_reveal_board(client,mate):
    from accounts_api import require_user
    session=start(client);sid=session['id']
    ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    client.app.dependency_overrides[require_user]=lambda:{'id':2}
    assert client.post(f'/api/skills/blindfold/{sid}/abandon').status_code==404
    client.app.dependency_overrides[require_user]=lambda:{'id':1}
    first=ok(client.post(f'/api/skills/blindfold/{sid}/abandon'))
    assert first['result']['abandoned'] and first['result']['points']==0
    assert 'document' not in first
    assert ok(client.post(f'/api/skills/blindfold/{sid}/abandon'))==first
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM blindfold_rating_events').fetchone()[0]==1
