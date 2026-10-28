import csv
import io
import json
from pathlib import Path
import time
from concurrent.futures import Future, ThreadPoolExecutor
import threading

import chess
from fastapi import HTTPException
import pytest
import zstandard

import db
import puzzle_store as bank
import puzzle_training as puzzles


@pytest.fixture
def store(tmp_path,monkeypatch):
    monkeypatch.setattr(puzzles,'_storm_prefetch_enabled',False)
    monkeypatch.setattr(puzzles,'_storm_prefetch',puzzles.OrderedDict())
    monkeypatch.setattr(db,'DATA_DIR',tmp_path)
    monkeypatch.setattr(db,'DB_PATH',tmp_path/'personal.sqlite3')
    monkeypatch.delenv('CHESSGYM_PUZZLE_BANK',raising=False)
    db.init_db();puzzles.init_puzzles()
    source=tmp_path/'sample.csv.zst'
    fields=['PuzzleId','FEN','Moves','Rating','RatingDeviation','Popularity','NbPlays','Themes','GameUrl','OpeningTags']
    stream=io.StringIO();writer=csv.writer(stream);writer.writerow(fields)
    for ident,rating,sequence in [('Black1',1500,'e2e4 e7e5 g1f3 b8c6'),('White1',1500,'e7e5 g1f3 b8c6 f1b5'),('StormB',1050,'e2e4 e7e5 g1f3 b8c6'),('StormW',1050,'e7e5 g1f3 b8c6 f1b5')]:
        position=chess.Board()
        if 'W' in ident:position.push_uci('e2e4')
        writer.writerow([ident,position.fen(),sequence,rating,50,98,100,'opening fork','https://lichess.org/abcdefgh#1','Italian_Game'])
    source.write_bytes(zstandard.ZstdCompressor().compress(stream.getvalue().encode()))
    result=bank.import_bank(source,batch_size=100)
    assert result['imported']==4
    return source


def start(ident='Black1',rated=True):
    with db.get_conn() as conn:
        return puzzles._public(puzzles._new_attempt(conn,bank.get_puzzle(ident),rated=rated))


def action(a,move,request='request-01'):
    return puzzles.play_move(a['id'],puzzles.Action(request_id=request,version=a['version'],move=move))


def test_streaming_import_idempotent_and_shared_selector(store):
    assert bank.bank_stats()['count']==4
    assert bank.import_bank(store)['imported']==0
    assert bank.bank_stats()['count']==4
    matches=bank.search_puzzles({'color':'white','rating_min':1100,'themes':['fork'],'opening':'Italian','max_pieces':32,'max_initial_ply':2})
    assert [m['id'] for m in matches]==['White1']
    p=bank.prepared_puzzle(matches[0]);assert p['start_fen'].split()[1]=='w'
    assert p['solution']==['g1f3','b8c6','f1b5']


def test_first_wrong_once_idempotent_then_continue(store):
    a=start();r=action(a,'d7d5');a=r['attempt']
    assert not r['correct'] and a['failed'] and a['status']=='active'
    assert a['rating_after']<a['rating_before']
    with db.get_conn() as conn:assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==1
    replay=puzzles.play_move(a['id'],puzzles.Action(request_id='request-01',version=0,move='d7d5'))
    assert replay==r
    r=action(a,'c7c5','request-02');assert r['attempt']['rating_after']==a['rating_after']
    r=action(r['attempt'],'e7e5','request-03');assert r['correct'] and len(r['attempt']['positions'])==2
    r=action(r['attempt'],'b8c6','request-04');assert r['attempt']['status']=='completed' and r['attempt']['failed']
    detail=puzzles.attempt_detail(a['id']);assert len(detail['events'])==4 and 'd5' in detail['pgn'] and 'c5' in detail['pgn']
    with db.get_conn() as conn:assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==1


def test_success_grade_ignores_elapsed_time(store,monkeypatch):
    a=start();a=action(a,'e7e5')['attempt']
    monkeypatch.setattr(puzzles.time,'time',lambda: a_time)
    a_time=2000000000
    r=action(a,'b8c6','request-02')['attempt'];assert r['status']=='completed'
    # A fresh, uncertain rating moves rapidly even if solving took a long time.
    assert r['rating_after']-r['rating_before'] == pytest.approx(235.38162123)
    assert 45 < r['rating_deviation'] < 500 and r['provisional']


def test_stale_version_and_illegal_move_do_not_mutate(store):
    a=start()
    with pytest.raises(HTTPException) as e:action(a,'a1a8')
    assert e.value.status_code==422
    a=action(a,'e7e5')['attempt']
    with pytest.raises(HTTPException) as e:puzzles.play_move(a['id'],puzzles.Action(request_id='other-id-1',version=0,move='b8c6'))
    assert e.value.status_code==409
    assert len(puzzles.attempt_detail(a['id'])['events'])==1


def test_hint_is_single_rating_failure_and_solution_not_exposed(store):
    a=start();assert 'solution' not in a and 'pgn' not in a
    r=puzzles.get_hint(a['id'],puzzles.Action(request_id='hint-00001',version=0));a=r['attempt']
    assert r['hint']=='e5' and a['hints']==1 and a['failed']
    r=puzzles.reveal(a['id'],puzzles.Action(request_id='reveal-001',version=a['version']))
    assert r['attempt']['status']=='revealed' and r['attempt']['solution']==['e7e5','g1f3','b8c6']
    with db.get_conn() as conn:assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==1


def test_copy_failed_is_once_per_base_and_preserves_user_edits(store):
    with db.get_conn() as conn:
        base=conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)',('Failures',puzzles.stamp())).lastrowid
    puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=base))
    a=action(start(),'d7d5')['attempt'];eid=a['copied_entry_id'];assert eid
    with db.get_conn() as conn:conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 *',eid))
    b=action(start(),'c7c5')['attempt'];assert b['copied_entry_id']==eid
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(base,)).fetchone()[0]==1
        assert conn.execute('SELECT pgn FROM entries WHERE id=?',(eid,)).fetchone()[0]=='1. d4 *'


def test_saved_filters_and_replay_do_not_grade(store):
    saved=puzzles.save_set(puzzles.SetPayload(name='Forks',filters=puzzles.Filters(themes=['fork'])))
    assert saved['filters']['themes']==['fork']
    a=puzzles.start_attempt(puzzles.StartAttempt(puzzle_id='Black1'));assert not a['rated']
    a=action(a,'e7e5')['attempt'];a=action(a,'b8c6','request-02')['attempt']
    assert a['rating_after'] is None
    puzzles.delete_set(saved['id'])
    assert puzzles.overview()['sets']==[]


def test_storm_deadline_server_score_combo_and_no_classic_rating(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    monkeypatch.setattr(puzzles.time,'time',lambda:2000000000)
    r=puzzles.start_storm();a=r['attempt'];sid=r['storm']['id'];deadline=r['storm']['deadline_ms']
    with db.get_conn() as conn:conn.execute('UPDATE puzzle_storm SET combo=4 WHERE id=?',(sid,))
    r=action(a,'e7e5');assert r['storm']['combo']==5 and r['storm']['deadline_ms']==deadline+3000
    r=action(r['attempt'],'b8c6','request-02');assert r['storm']['score']==1
    with db.get_conn() as conn:assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==0
    with db.get_conn() as conn:
        conn.execute('UPDATE puzzle_storm SET deadline_ms=? WHERE id=?',(1,sid))
    status=puzzles.storm_status(sid);assert status['storm']['status']=='completed'


def test_storm_wrong_loses_ten_seconds_resets_combo(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    monkeypatch.setattr(puzzles.time,'time',lambda:2000000000)
    r=puzzles.start_storm();a=r['attempt'];deadline=r['storm']['deadline_ms']
    r=action(a,'d7d5');assert r['storm']['deadline_ms']==deadline-10000
    assert r['storm']['combo']==0 and r['storm']['mistakes']==1 and r['attempt']['status']=='revealed'
    with db.get_conn() as conn:assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==0


@pytest.mark.parametrize('previous,bonus',[(0,0),(3,0),(4,3),(5,0),(11,5),(19,7),(29,10),(38,0),(39,10),(49,10),(99,10)])
def test_storm_time_bonus_on_player_moves_is_visible_and_applied_once(store,monkeypatch,previous,bonus):
    monkeypatch.setattr(puzzles.time,'time',lambda:2000000000)
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    sid=r['storm']['id'];deadline=r['storm']['deadline_ms']
    with db.get_conn() as conn:conn.execute('UPDATE puzzle_storm SET combo=? WHERE id=?',(previous,sid))
    answer=action(r['attempt'],'e7e5','bonus-move-1')
    assert answer['attempt']['status']=='active'  # Bonus need not finish a puzzle.
    assert len(answer['attempt']['positions'])==2  # Opponent reply is not another combo move.
    assert answer['storm']['combo']==previous+1 and answer['storm']['score']==0
    assert answer['storm']['deadline_ms']==deadline+bonus*1000
    assert answer['storm']['time_delta_seconds']==bonus
    assert action(r['attempt'],'e7e5','bonus-move-1')==answer
    live=puzzles.storm_status(sid)['storm']
    assert live['deadline_ms']==deadline+bonus*1000 and live['combo']==previous+1
    assert live['combo_progress']==answer['storm']['combo_progress']
    assert 'time_delta_seconds' not in live  # Reloads do not replay a bonus notification.


def test_storm_inline_bonus_survives_next_puzzle_and_error_resets_progress(store,monkeypatch):
    monkeypatch.setattr(puzzles.time,'time',lambda:2000000000)
    add_bank_clones(['BonusB2','BonusB3'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    first=action(r['attempt'],'e7e5')['attempt'];sid=r['storm']['id']
    with db.get_conn() as conn:conn.execute('UPDATE puzzle_storm SET combo=11 WHERE id=?',(sid,))
    bonus=inline_action(first,'b8c6','bonus-inline')
    assert bonus['next_attempt']['status']=='active' and bonus['storm']['score']==1
    assert bonus['storm']['time_delta_seconds']==5
    wrong=inline_action(bonus['next_attempt'],'d7d5','bonus-mistake')
    assert wrong['storm']['time_delta_seconds']==-10 and wrong['storm']['combo']==0
    assert wrong['storm']['best_combo']==12
    assert wrong['storm']['combo_progress']=={'moves':0,'target':5,'remaining':5,'seconds':3}
    assert wrong['storm']['deadline_ms']==bonus['storm']['deadline_ms']-10000


def test_standard_storm_difficulty_advances_after_failures_and_survives_reload(store,monkeypatch):
    calls=[];original=puzzles.choose_puzzle
    def record(conn,filters,exclude_ids=()):
        calls.append(dict(filters));return original(conn,filters,exclude_ids)
    monkeypatch.setattr(puzzles,'choose_puzzle',record)
    monkeypatch.setattr('random.choice',lambda values:'black')
    add_bank_clones(['NextBand'])
    with bank.bank_connection(True) as conn:conn.execute("UPDATE puzzles SET rating=1150 WHERE id='NextBand'")
    r=puzzles.start_storm();sid=r['storm']['id']
    assert 1000<=r['attempt']['rating']<1100
    with db.get_conn() as conn:conn.execute('UPDATE puzzle_storm SET score=2,mistakes=4 WHERE id=?',(sid,))
    failed=action(r['attempt'],'d7d5')
    assert failed['storm']['score']==2 and failed['storm']['mistakes']==5
    assert puzzles.storm_status(sid)['storm']['mistakes']==5
    next_puzzle=puzzles.storm_next(sid)
    assert next_puzzle['attempt']['puzzle_id']=='NextBand'
    assert calls[-1]['rating_min']==1100 and calls[-1]['rating_max']==1199


def test_standard_storm_rating_does_not_drop_within_a_bucket(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    r=puzzles.start_storm();sid=r['storm']['id']
    add_bank_clones(['Lower','Higher'])
    with bank.bank_connection(True) as conn:
        conn.execute("UPDATE puzzles SET rating=1001 WHERE id='Lower'")
        conn.execute("UPDATE puzzles SET rating=1090 WHERE id='Higher'")
    action(r['attempt'],'d7d5')
    assert puzzles.storm_next(sid)['attempt']['puzzle_id']=='Higher'


def test_standard_storm_uses_stable_ratings_and_excludes_equality(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    add_bank_clones(['Unstable','Equality'])
    with bank.bank_connection(True) as conn:
        conn.execute("UPDATE puzzles SET rating_deviation=86 WHERE id='Unstable'")
        conn.execute("UPDATE puzzles SET themes=themes || ' equality' WHERE id='Equality'")
    r=puzzles.start_storm()
    assert r['attempt']['puzzle_id']=='StormB'
    action(r['attempt'],'d7d5')
    assert puzzles.storm_next(r['storm']['id'])['exhausted']


def test_standard_storm_ends_after_137_puzzles(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    r=puzzles.start_storm();sid=r['storm']['id']
    with db.get_conn() as conn:conn.execute('UPDATE puzzle_storm SET score=136 WHERE id=?',(sid,))
    last=inline_action(r['attempt'],'d7d5','last-puzzle')
    assert last['storm']['status']=='completed' and last['exhausted']
    assert last['next_attempt'] is None and last['storm']['mistakes']==1


def test_prepared_next_difficulty_is_reused_after_a_mistake(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    add_bank_clones(['PreparedB'])
    r=puzzles.start_storm()
    state={**r['storm'],'score':1}
    candidate=puzzles._prepare_storm_future(puzzles._storm_scope(),state)
    future=Future();future.set_result(candidate)
    puzzles._storm_prefetch[puzzles._storm_prefetch_key(state)]=future
    def unexpected(*args):pytest.fail('A mistake advances to the same prepared difficulty as a success')
    monkeypatch.setattr(puzzles,'_select_storm_puzzle',unexpected)
    result=inline_action(r['attempt'],'d7d5','prepared-failure')
    assert result['next_attempt']['puzzle_id']==candidate['id']
    assert result['storm']['score']==0 and result['storm']['mistakes']==1


def test_statistics_keep_all_attempts_and_input_moves(store):
    a=start();action(a,'d7d5')
    h=puzzles.history(0,30);assert h['total']==1 and h['attempts'][0]['failed']
    s=puzzles.statistics();assert len(s['ratings'])==1 and s['days'][0]['attempts']==1


def test_malformed_filters_rejected(store):
    with pytest.raises(HTTPException):puzzles.Filters(rating_min=2000,rating_max=1000).checked()
    with pytest.raises(HTTPException):puzzles.Filters(history='arbitrary').checked()


def test_equivalent_immediate_mate_is_accepted(store):
    fen='8/5K1k/6Q1/8/8/8/8/8 b - - 0 1'
    row={'id':'Mate1','fen':fen,'moves':['h7h8','g6g7'],'rating':1500,'color':'white','themes':['mateIn1'],'opening_tags':[],'game_url':''}
    with db.get_conn() as conn:a=puzzles._public(puzzles._new_attempt(conn,row))
    result=action(a,'g6h5')['attempt']
    assert result['status']=='completed' and not result['failed']
    assert result['solution']==['g6h5'] and 'Qh5#' in result['pgn']


def test_deleted_copy_destination_does_not_block_training(store):
    with db.get_conn() as conn:
        bid=conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)',('temporary',puzzles.stamp())).lastrowid
    puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid))
    with db.get_conn() as conn:conn.execute('DELETE FROM bases WHERE id=?',(bid,))
    a=action(start(),'d7d5')['attempt'];assert a['failed'] and a['copied_entry_id'] is None


def test_storm_start_closes_abandoned_attempt(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    old=puzzles.start_storm();puzzles.start_storm()
    assert puzzles.attempt_detail(old['attempt']['id'])['status']=='expired'


def test_invalid_import_has_explicit_error_state(store,tmp_path):
    bad=tmp_path/'wrong.csv';bad.write_text('bad,columns\n1,2\n')
    with pytest.raises(ValueError):bank.import_bank(bad)
    assert bank.bank_stats()['status']=='error'


def test_puzzle_routes_require_auth_and_reject_injected_scores(store):
    from fastapi import FastAPI
    from local_test_client import TestClient
    from accounts_api import require_user
    app=FastAPI();app.include_router(puzzles.router)
    with TestClient(app) as client:
        assert client.get('/api/puzzles/overview',headers={'Host':'remote.example'}).status_code==403
        assert client.post('/api/puzzles/attempts',json={},headers={'Host':'remote.example'}).status_code==403
        app.dependency_overrides[require_user]=lambda:{'id':1}
        response=client.post('/api/puzzles/attempts',json={'puzzle_id':'Black1','score':10})
        assert response.status_code==422
        a=client.post('/api/puzzles/attempts',json={'puzzle_id':'Black1'}).json()
        assert 'solution' not in a and 'pgn' not in a
        response=client.post('/api/puzzles/attempts/'+a['id']+'/move',json={'request_id':'request00','version':0,'move':'e7e5','correct':True,'score':10})
        assert response.status_code==422
        assert client.put('/api/puzzles/settings',json={'auto_copy_base_id':10**100}).status_code==422


def test_explicit_replay_invalid_bank_line_returns_validation_error(store):
    with bank.bank_connection(True) as conn:
        conn.execute("UPDATE puzzles SET moves='e2e4 a1a8' WHERE id='Black1'")
    with pytest.raises(HTTPException) as exc:
        puzzles.start_attempt(puzzles.StartAttempt(puzzle_id='Black1'))
    assert exc.value.status_code==422


def test_import_cache_is_connection_local_and_keeps_durability(store,monkeypatch):
    original=bank.configure_import_connection
    observed=[]
    def inspect(conn,cache_mb=256):
        original(conn,cache_mb)
        observed.append({key:conn.execute('PRAGMA '+key).fetchone()[0] for key in ('cache_size','wal_autocheckpoint','page_size','journal_mode','synchronous')})
    monkeypatch.setattr(bank,'configure_import_connection',inspect)
    bank.import_bank(store,cache_mb=128)
    assert observed[0]['cache_size']==-128*1024
    assert observed[0]['wal_autocheckpoint']*observed[0]['page_size']==64*1024*1024
    assert observed[0]['journal_mode']=='wal' and observed[0]['synchronous']==1
    with bank.bank_connection() as conn:
        assert conn.execute('PRAGMA cache_size').fetchone()[0]!=-128*1024
    with bank.bank_connection(True) as conn:
        with pytest.raises(ValueError):original(conn,2048)


def make_base(name):
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)',(name,puzzles.stamp())).lastrowid


def finish_storm(result,score=0):
    with db.get_conn() as conn:
        conn.execute('UPDATE puzzle_storm SET score=?,clock_started=1,deadline_ms=1 WHERE id=?',(score,result['storm']['id']))
    return puzzles.storm_status(result['storm']['id'])['storm']


def test_settings_apply_to_active_attempt_before_or_after_failure(store):
    bid=make_base('Failed puzzles')
    a=start();original=dict(a)
    response=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid))
    assert response['auto_copy_base_id']==bid and response['active_attempts']==[original]
    a=action(a,'d7d5')['attempt'];assert a['copied_entry_id']
    puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=None))
    b=action(start('White1'),'d2d4')['attempt'];assert b['failed'] and b['copied_entry_id'] is None
    response=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid))
    updated=next(item for item in response['active_attempts'] if item['id']==b['id'])
    assert updated['copied_entry_id']
    for field in ('fen','positions','version','status','failed','hints','elapsed_ms','rating_after'):
        assert updated[field]==b[field]
    assert 'pgn' not in updated and 'solution' not in updated
    with db.get_conn() as conn:
        assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==2
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==2


def test_settings_disable_active_copy_and_preserve_existing_copy(store):
    bid=make_base('Failed puzzles');puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid))
    a=start();puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=None))
    a=action(a,'d7d5')['attempt'];assert a['copied_entry_id'] is None
    copied=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid))['active_attempts'][0]['copied_entry_id']
    disabled=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=None))
    assert disabled['active_attempts'][0]['copied_entry_id']==copied
    a=action(a,'c7c5','second-wrong')['attempt'];assert a['copied_entry_id']==copied
    with db.get_conn() as conn:
        assert conn.execute('SELECT copy_base_id FROM puzzle_attempts WHERE id=?',(a['id'],)).fetchone()[0] is None
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==1


def test_settings_change_destination_is_idempotent_and_preserves_notes(store):
    first,second=make_base('First'),make_base('Second')
    a=action(start(),'d7d5')['attempt']
    one=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=first))['active_attempts'][0]['copied_entry_id']
    with db.get_conn() as conn:conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 {My notes} *',one))
    two=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=second))['active_attempts'][0]['copied_entry_id']
    assert one!=two
    repeated=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=second))
    assert repeated['active_attempts'][0]['copied_entry_id']==two
    back=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=first))
    assert back['active_attempts'][0]['copied_entry_id']==one
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=?',(one,)).fetchone()[0]=='1. d4 {My notes} *'
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE id IN (?,?)',(one,two)).fetchone()[0]==2
        assert conn.execute('SELECT version FROM puzzle_attempts WHERE id=?',(a['id'],)).fetchone()[0]==1


def test_settings_do_not_retrocopy_history_or_storm(store,monkeypatch):
    a=start();a=puzzles.reveal(a['id'],puzzles.Action(request_id='reveal-001',version=0))['attempt']
    monkeypatch.setattr('random.choice',lambda values:'black')
    storm=puzzles.start_storm();bid=make_base('Failed puzzles')
    result=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid))
    assert result['active_attempts']==[]
    action(storm['attempt'],'d7d5')
    assert puzzles.attempt_detail(a['id'])['copied_entry_id'] is None
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==0


def test_custom_storm_filters_same_side_exhaustion_and_no_rating(store):
    filters=puzzles.Filters(rating_min=1400,rating_max=1600,themes=['fork','opening'],opening='Italian Game',
                           color='white',solution_min=3,solution_max=3)
    result=puzzles.start_storm(puzzles.StormRequest(filters=filters,set_name='My opening'))
    s,a=result['storm'],result['attempt']
    assert s['custom'] and s['key'].startswith('custom:') and s['name']=='My opening'
    assert s['filters']==filters.checked() and s['color']==a['color']=='white'
    assert a['puzzle_id']=='White1' and 1400<=a['rating']<=1600 and not a['rated']
    done=action(action(a,'g1f3')['attempt'],'f1b5','second-move')
    assert done['storm']['score']==1
    exhausted=puzzles.storm_next(s['id'])
    assert exhausted['attempt'] is None and exhausted['exhausted'] and exhausted['storm']['status']=='completed'
    again=puzzles.storm_next(s['id']);assert again['attempt'] is None and again['storm']['status']=='completed'
    with db.get_conn() as conn:
        profile=conn.execute('SELECT * FROM puzzle_profile').fetchone()
        assert profile['rating']==1500 and profile['rated_count']==0


def test_custom_storm_empty_filter_does_not_destroy_active_session(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    old=puzzles.start_storm()
    for filters in [puzzles.Filters(themes=['nonexistent']),puzzles.Filters(opening='Sicilian'),
                    puzzles.Filters(solution_min=10),puzzles.Filters(rating_min=3000),puzzles.Filters(rating_max=0),puzzles.Filters(history='failed')]:
        with pytest.raises(HTTPException) as exc:puzzles.start_storm(puzzles.StormRequest(filters=filters))
        assert exc.value.status_code==404 and 'sélection' in exc.value.detail
        state=puzzles.storm_status(old['storm']['id'])
        assert state['storm']['status']=='active' and state['attempt']['status']=='active'
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM puzzle_storm').fetchone()[0]==1


def test_custom_storm_history_filters_and_available_color(store,monkeypatch):
    failed=action(start('White1'),'d2d4')['attempt']
    monkeypatch.setattr('random.choice',lambda values:'black')
    result=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(history='failed',opening='Italian Game',themes=['FORK'])))
    assert result['attempt']['puzzle_id']==failed['puzzle_id'] and result['storm']['color']=='white'
    finish_storm(result)
    unseen=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(history='unseen',color='white')))
    assert unseen['attempt']['puzzle_id']=='StormW'
    action(unseen['attempt'],'d2d4')
    assert puzzles.storm_next(unseen['storm']['id'])['exhausted']


def test_custom_storm_progression_and_sparse_fallback_respect_selected_bounds(store,monkeypatch):
    calls=[];original=puzzles.choose_puzzle
    def record(conn,filters,exclude_ids=()):
        calls.append((dict(filters),list(exclude_ids)))
        return original(conn,filters,exclude_ids)
    monkeypatch.setattr(puzzles,'choose_puzzle',record)
    filters=puzzles.Filters(rating_min=1100,rating_max=1600,color='black',themes=['fork'])
    result=puzzles.start_storm(puzzles.StormRequest(filters=filters))
    assert len(calls)==2 and calls[0][0]['rating_max']==1199 and calls[1][0]['rating_max']==1600
    assert all(1100<=item['rating_min']<=item['rating_max']<=1600 for item,_ in calls)
    a=result['attempt'];action(action(a,'e7e5')['attempt'],'b8c6','second-move')
    with db.get_conn() as conn:conn.execute('UPDATE puzzle_storm SET score=10 WHERE id=?',(result['storm']['id'],))
    assert puzzles.storm_next(result['storm']['id'])['exhausted']
    assert calls[-2][0]['target_rating']==1250
    assert calls[-2][0]['rating_min']==1200 and calls[-2][0]['rating_max']==1299
    assert all(item['color']=='black' and item['themes']==['fork'] for item,_ in calls)
    assert calls[-1][1]==[a['puzzle_id']]


def test_storm_configuration_records_are_separate_and_names_do_not_change_key(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    standard=puzzles.start_storm();finish_storm(standard,2)
    first=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(themes=['opening','fork','fork'],opening=' Italian '),set_name='First'))
    finish_storm(first,9)
    second=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(themes=['fork','opening'],opening='Italian'),set_name='Renamed'))
    assert first['storm']['key']==second['storm']['key'];finish_storm(second,5)
    defaults=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters()))
    assert defaults['storm']['key']!='standard';finish_storm(defaults,3)
    stats=puzzles.overview()['storm'];records={row['key']:row for row in stats['records']}
    assert stats['best']==2 and stats['sessions']==1 and stats['total_sessions']==4
    assert records['standard']['best']==2 and not records['standard']['custom']
    assert records[first['storm']['key']]['best']==9 and records[first['storm']['key']]['sessions']==2
    assert records[defaults['storm']['key']]['best']==3
    history=puzzles.statistics()['storms'];assert len(history)==4
    assert all('key' in row and 'name' in row and 'filters' in row and 'custom' in row for row in history)


def test_storm_http_compatibility_and_filter_validation(store):
    from fastapi import FastAPI
    from local_test_client import TestClient
    from accounts_api import require_user
    app=FastAPI();app.include_router(puzzles.router);app.dependency_overrides[require_user]=lambda:{'id':1}
    with TestClient(app) as client:
        for kwargs in [{},{'json':{}},{'json':{'filters':None}}]:
            response=client.post('/api/puzzles/storm',**kwargs)
            assert response.status_code==200 and response.json()['storm']['key']=='standard'
        for body in [{'score':100},{'filters':{'rating_min':2000,'rating_max':1000}},
                     {'filters':{'color':'invalid'}},{'filters':{'history':'invalid'}},{'filters':{'solution_min':5,'solution_max':2}},
                     {'filters':{'themes':['"bad']}},{'filters':{'arbitrary':True}}]:
            assert client.post('/api/puzzles/storm',json=body).status_code==422
        response=client.post('/api/puzzles/storm',json={'filters':{'rating_min':1400,'rating_max':1600},'set_name':'Custom'})
        assert response.status_code==200 and response.json()['storm']['custom']


def test_storm_existing_schema_migrates_to_standard(store):
    with db.get_conn() as conn:
        conn.execute('DROP TABLE puzzle_storm')
        conn.executescript('''CREATE TABLE puzzle_storm (
          id TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active', color TEXT NOT NULL,
          score INTEGER NOT NULL DEFAULT 0, combo INTEGER NOT NULL DEFAULT 0,
          best_combo INTEGER NOT NULL DEFAULT 0, mistakes INTEGER NOT NULL DEFAULT 0,
          solved_rating INTEGER NOT NULL DEFAULT 0, current_attempt TEXT, finished_at TEXT);''')
        conn.execute("INSERT INTO puzzle_storm(id,started_ms,deadline_ms,status,color,score) VALUES('legacy',1,2,'completed','black',12)")
    puzzles.init_puzzles();puzzles.init_puzzles()
    legacy=puzzles.storm_status('legacy')['storm']
    assert legacy['key']=='standard' and legacy['name']=='Standard' and legacy['filters'] is None
    stats=puzzles.overview()['storm'];assert stats['best']==12 and stats['sessions']==1


def test_storm_without_bank_returns_actionable_error_and_no_partial_session(store,tmp_path,monkeypatch):
    monkeypatch.setenv('CHESSGYM_PUZZLE_BANK',str(tmp_path/'not-imported.sqlite3'))
    for payload in [None,puzzles.StormRequest(filters=puzzles.Filters()),puzzles.StormRequest(filters=puzzles.Filters(history='failed'))]:
        with pytest.raises(HTTPException) as exc:puzzles.start_storm(payload)
        assert exc.value.status_code==404 and 'Importe la banque' in exc.value.detail
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM puzzle_storm').fetchone()[0]==0


def add_bank_clones(ids,template='StormB'):
    with bank.bank_connection(True) as conn:
        row=list(conn.execute('SELECT * FROM puzzles WHERE id=?',(template,)).fetchone())
        conn.executemany('INSERT INTO puzzles VALUES('+','.join('?' for _ in row)+')',[(ident,*row[1:]) for ident in ids])


@pytest.mark.parametrize('max_moves', [10,12,14,16,18,20])
def test_opening_search_respects_inclusive_ply_rating_and_exclusions(store,max_moves):
    ids=['Before','AtLimit','TooLate','TooEasy','TooHard','Excluded']
    add_bank_clones(ids,template='Black1')
    with bank.bank_connection(True) as conn:
        conn.execute('UPDATE puzzles SET initial_ply=?',(max_moves*2+1,))
        conn.executemany('UPDATE puzzles SET initial_ply=?,rating=? WHERE id=?',[
            (max_moves*2-1,1000,'Before'),(max_moves*2,2000,'AtLimit'),
            (max_moves*2,999,'TooEasy'),(max_moves*2,2001,'TooHard'),
            (max_moves*2,1500,'Excluded')])
    filters={'rating_min':1000,'rating_max':2000,'max_initial_ply':max_moves*2,'target_rating':1500}
    result=bank.search_puzzles(filters,limit=20,exclude_ids=['Excluded'],seed=1)
    assert {p['id'] for p in result}=={'Before','AtLimit'}
    assert all(p['fen'] and isinstance(p['moves'],list) for p in result)
    assert bank.search_puzzles(filters,exclude_ids=['Before','AtLimit','Excluded'])==[]


@pytest.mark.parametrize('limits', [{},{'max_initial_ply':2},{'max_pieces':32}])
def test_unseen_search_continues_after_large_excluded_prefix(store,limits):
    ids=['Seen'+str(i).zfill(5) for i in range(3001)]
    add_bank_clones(ids)
    excluded=set(ids[:-1]+['StormB'])
    result=bank.search_puzzles({'rating_min':1050,'rating_max':1050,'target_rating':1050,'color':'black',**limits},exclude_ids=excluded)
    assert [p['id'] for p in result]==[ids[-1]]
    with db.get_conn() as conn:
        conn.executemany('INSERT INTO puzzle_attempts(id,puzzle_id,mode,snapshot,fen,rated,started_at,started_ms,status) VALUES(?,?,?,?,?,?,?,?,?)',
            [(ident,ident,'classic','{}',chess.STARTING_FEN,0,puzzles.stamp(),i,'completed') for i,ident in enumerate(excluded)])
        selected=puzzles.choose_puzzle(conn,{'history':'unseen','rating_min':1050,'rating_max':1050,'target_rating':1050,'color':'black'})
        assert selected['id']==ids[-1]


def test_shared_selector_applies_lower_and_upper_visual_bounds(store):
    add_bank_clones(['Early','Target','Late'],template='Black1')
    with bank.bank_connection(True) as conn:
        conn.execute('UPDATE puzzles SET initial_ply=1,piece_count=3')
        conn.execute("UPDATE puzzles SET initial_ply=19,piece_count=15 WHERE id='Early'")
        conn.execute("UPDATE puzzles SET initial_ply=20,piece_count=16 WHERE id='Target'")
        conn.execute("UPDATE puzzles SET initial_ply=21,piece_count=17 WHERE id='Late'")
    bounds={'rating_min':1400,'rating_max':1600,'min_initial_ply':20,'max_initial_ply':20,
            'min_pieces':16,'max_pieces':16}
    assert [r['id'] for r in bank.search_puzzles(bounds)]==['Target']


def test_failed_history_filter_reaches_matches_older_than_two_thousand(store):
    ids=['Recent'+str(i).zfill(5) for i in range(2001)]
    add_bank_clones(ids)
    old=action(start(),'d7d5')['attempt']
    with db.get_conn() as conn:
        conn.execute('UPDATE puzzle_attempts SET started_ms=0 WHERE id=?',(old['id'],))
        conn.executemany('INSERT INTO puzzle_attempts(id,puzzle_id,mode,snapshot,fen,rated,started_at,started_ms,status,failed) VALUES(?,?,?,?,?,?,?,?,?,?)',
            [(ident,ident,'classic','{}',chess.STARTING_FEN,0,puzzles.stamp(),i+1,'completed',1) for i,ident in enumerate(ids)])
        filters=puzzles.Filters(history='failed',rating_min=1400,rating_max=1600,color='black',themes=['FORK'],opening='Italian Game').checked()
        selected=puzzles.choose_puzzle(conn,filters)
        assert selected['id']=='Black1'
        with pytest.raises(HTTPException) as exc:puzzles.choose_puzzle(conn,filters,exclude_ids=['Black1'])
        assert exc.value.status_code==404


def test_search_timeout_is_not_reported_as_empty_selection(store,monkeypatch):
    readings=iter([0]+[10]*100)
    monkeypatch.setattr(bank.time,'monotonic',lambda:next(readings))
    with pytest.raises(bank.PuzzleSelectionTimeout):bank.search_puzzles({'rating_min':1050,'rating_max':1050})
    readings=iter([0]+[10]*100)
    with db.get_conn() as conn:
        with pytest.raises(HTTPException) as exc:puzzles.choose_puzzle(conn,{'history':'all'})
        assert exc.value.status_code==503
    readings=iter([0]+[10]*100)
    with db.get_conn() as conn:
        with pytest.raises(HTTPException) as exc:puzzles.choose_puzzle(conn,{'history':'failed'})
        assert exc.value.status_code==503
        # The expired progress handler must not affect subsequent statements.
        assert conn.execute('WITH RECURSIVE n(v) AS (SELECT 1 UNION ALL SELECT v+1 FROM n WHERE v<20000) SELECT MAX(v) FROM n').fetchone()[0]==20000


def test_selection_timeout_keeps_storm_open_and_does_not_retry_classic(store,monkeypatch):
    result=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='white')))
    solved=action(action(result['attempt'],'g1f3')['attempt'],'f1b5','second-move')
    calls=[]
    def timeout(*args,**kwargs):
        calls.append(1);raise bank.PuzzleSelectionTimeout()
    monkeypatch.setattr(bank,'search_puzzles',timeout)
    with pytest.raises(HTTPException) as exc:puzzles.storm_next(result['storm']['id'])
    assert exc.value.status_code==503 and len(calls)==1
    state=puzzles.storm_status(result['storm']['id'])
    assert state['storm']['status']=='active' and state['attempt']['status']=='completed'
    assert state['storm']['deadline_ms']==solved['storm']['deadline_ms']
    with pytest.raises(HTTPException) as exc:puzzles.start_attempt(puzzles.StartAttempt())
    assert exc.value.status_code==503 and len(calls)==2


def test_copy_after_later_failure_keeps_initial_position_and_full_solution(store):
    bid=make_base('Failures')
    a=action(start(),'e7e5')['attempt'];a=action(a,'d7d6','second-move')['attempt']
    assert a['failed'] and a['fen']!=a['start_fen']
    copied=puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid))['active_attempts'][0]['copied_entry_id']
    with db.get_conn() as conn:pgn=conn.execute('SELECT pgn FROM entries WHERE id=?',(copied,)).fetchone()[0]
    game=chess.pgn.read_game(io.StringIO(pgn))
    assert game.board().fen()==a['start_fen']
    assert [move.uci() for move in game.mainline_moves()]==['e7e5','g1f3','b8c6']


def test_storm_copy_is_disabled_for_existing_classic_settings(store,monkeypatch):
    bid=make_base('Classic failures')
    with db.get_conn() as conn:
        conn.execute('UPDATE puzzle_profile SET settings=?',(json.dumps({'auto_copy_base_id':bid,'other_setting':'preserved'}),))
    monkeypatch.setattr('random.choice',lambda values:'black')
    result=puzzles.start_storm();failed=action(result['attempt'],'d7d5')['attempt']
    assert failed['failed'] and failed['copied_entry_id'] is None
    settings=puzzles.update_settings(puzzles.SettingsPayload())
    assert settings['auto_copy_base_id']==bid and settings['storm_auto_copy_base_id'] is None
    assert puzzles.overview()['profile']['settings']['other_setting']=='preserved'


def test_storm_copy_setting_applies_to_active_attempt_independently(store,monkeypatch):
    classic_base,storm_base=make_base('Classic'),make_base('Storm')
    puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=classic_base))
    classic=start();monkeypatch.setattr('random.choice',lambda values:'black')
    storm=puzzles.start_storm()
    settings=puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=storm_base))
    assert settings['auto_copy_base_id']==classic_base and settings['storm_auto_copy_base_id']==storm_base
    assert [a['id'] for a in settings['active_attempts']]==[storm['attempt']['id']]
    failed_storm=action(storm['attempt'],'d7d5')['attempt'];failed_classic=action(classic,'d7d5')['attempt']
    assert failed_storm['copied_entry_id'] and failed_classic['copied_entry_id']
    with db.get_conn() as conn:
        assert conn.execute('SELECT base_id FROM entries WHERE id=?',(failed_storm['copied_entry_id'],)).fetchone()[0]==storm_base
        assert conn.execute('SELECT base_id FROM entries WHERE id=?',(failed_classic['copied_entry_id'],)).fetchone()[0]==classic_base
        assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==1
    unchanged=puzzles.update_settings(puzzles.SettingsPayload())
    assert unchanged['active_attempts']==[] and unchanged['auto_copy_base_id']==classic_base and unchanged['storm_auto_copy_base_id']==storm_base


def test_disabling_storm_copy_does_not_disable_classic(store,monkeypatch):
    bid=make_base('Both')
    puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid,storm_auto_copy_base_id=bid))
    monkeypatch.setattr('random.choice',lambda values:'black')
    storm=puzzles.start_storm()
    result=puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=None))
    assert result['auto_copy_base_id']==bid and result['storm_auto_copy_base_id'] is None
    assert action(storm['attempt'],'d7d5')['attempt']['copied_entry_id'] is None
    assert action(start(),'d7d5')['attempt']['copied_entry_id']


def test_storm_and_classic_copies_deduplicate_and_preserve_notes(store):
    bid=make_base('Shared failures')
    puzzles.update_settings(puzzles.SettingsPayload(auto_copy_base_id=bid,storm_auto_copy_base_id=bid))
    classic=action(start(),'d7d5')['attempt'];eid=classic['copied_entry_id']
    with db.get_conn() as conn:conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 {My notes} *',eid))
    storm=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black',rating_min=1400,rating_max=1600)))
    assert storm['attempt']['puzzle_id']=='Black1'
    assert action(storm['attempt'],'d7d5')['attempt']['copied_entry_id']==eid
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==1
        assert conn.execute('SELECT pgn FROM entries WHERE id=?',(eid,)).fetchone()[0]=='1. d4 {My notes} *'


def test_storm_destination_change_and_deleted_destination(store,monkeypatch):
    first,second=make_base('First'),make_base('Second')
    puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=first))
    monkeypatch.setattr('random.choice',lambda values:'black')
    storm=puzzles.start_storm();puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=second))
    copied=action(storm['attempt'],'d7d5')['attempt']['copied_entry_id']
    with db.get_conn() as conn:
        assert conn.execute('SELECT base_id FROM entries WHERE id=?',(copied,)).fetchone()[0]==second
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(first,)).fetchone()[0]==0
    storm=puzzles.start_storm()
    with db.get_conn() as conn:conn.execute('DELETE FROM bases WHERE id=?',(second,))
    assert action(storm['attempt'],'d7d5')['attempt']['copied_entry_id'] is None


def test_storm_expiration_abandonment_and_historical_failure_are_not_copied(store,monkeypatch):
    monkeypatch.setattr('random.choice',lambda values:'black')
    historical=puzzles.start_storm();failed=action(historical['attempt'],'d7d5')['attempt']
    bid=make_base('Storm failures');puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=bid))
    abandoned=puzzles.start_storm();expired=puzzles.start_storm();finish_storm(expired)
    assert puzzles.attempt_detail(failed['id'])['copied_entry_id'] is None
    for a in [abandoned['attempt'],expired['attempt']]:
        detail=puzzles.attempt_detail(a['id'])
        assert detail['status']=='expired' and not detail['failed'] and detail['copied_entry_id'] is None
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==0


def test_solution_pgn_hides_active_answers_and_excludes_wrong_variations(store,tmp_path,monkeypatch):
    a=start();assert 'solution_pgn' not in a
    assert 'solution_pgn' not in puzzles.attempt_detail(a['id'])
    a=action(a,'d7d5')['attempt'];assert 'solution_pgn' not in a
    a=puzzles.reveal(a['id'],puzzles.Action(request_id='reveal-001',version=a['version']))['attempt']
    monkeypatch.setenv('CHESSGYM_PUZZLE_BANK',str(tmp_path/'missing-bank.sqlite3'))
    detail=puzzles.attempt_detail(a['id'])
    game=chess.pgn.read_game(io.StringIO(detail['solution_pgn']))
    assert [move.uci() for move in game.mainline_moves()]==['e7e5','g1f3','b8c6']
    assert game.board().fen()==a['start_fen'] and len(game.variations)==1
    assert 'd5' in detail['pgn'] and 'd5' not in detail['solution_pgn']


def test_solution_pgn_preserves_original_puzzle_after_alternative_mate(store):
    row={'id':'OriginalMate','fen':'8/5K1k/6Q1/8/8/8/8/8 b - - 0 1','moves':['h7h8','g6g7'],
         'rating':1500,'color':'white','themes':['mateIn1'],'opening_tags':[],'game_url':''}
    with db.get_conn() as conn:a=puzzles._public(puzzles._new_attempt(conn,row))
    result=action(a,'g6h5')['attempt']
    assert result['solution']==['g6h5'] and 'Qh5#' in result['pgn']
    solution=chess.pgn.read_game(io.StringIO(result['solution_pgn']))
    assert [move.uci() for move in solution.mainline_moves()]==['g6g7']
    with db.get_conn() as conn:
        snapshot=json.loads(conn.execute('SELECT snapshot FROM puzzle_attempts WHERE id=?',(a['id'],)).fetchone()[0])
        assert snapshot['original_solution']==['g6g7']
        # Simulate an older attempt: its original bank moves are still stored.
        del snapshot['original_solution'];conn.execute('UPDATE puzzle_attempts SET snapshot=? WHERE id=?',(json.dumps(snapshot),a['id']))
    old=puzzles.attempt_detail(a['id'])
    assert old['solution_pgn']==result['solution_pgn'] and old['pgn']==result['pgn']


def test_settings_http_partial_update_and_storm_destination_validation(store):
    from fastapi import FastAPI
    from local_test_client import TestClient
    from accounts_api import require_user
    app=FastAPI();app.include_router(puzzles.router);app.dependency_overrides[require_user]=lambda:{'id':1}
    first,second=make_base('Classic'),make_base('Storm')
    with TestClient(app) as client:
        assert client.put('/api/puzzles/settings',json={'auto_copy_base_id':first}).status_code==200
        both=client.put('/api/puzzles/settings',json={'storm_auto_copy_base_id':second}).json()
        assert both['auto_copy_base_id']==first and both['storm_auto_copy_base_id']==second
        same=client.put('/api/puzzles/settings',json={}).json();assert same==both
        assert client.put('/api/puzzles/settings',json={'storm_auto_copy_base_id':10**100}).status_code==422
        assert client.put('/api/puzzles/settings',json={'auto_copy_base_id':None,'storm_auto_copy_base_id':999999}).status_code==422
        assert client.put('/api/puzzles/settings',json={}).json()==both


def seed_storm_summary(session_id,count,started_ms):
    puzzle=bank.get_puzzle('StormB');attempt_ids=[]
    with db.get_conn() as conn:
        conn.execute("INSERT INTO puzzle_storm(id,started_ms,deadline_ms,status,color,score) VALUES(?,?,?,'completed','black',?)",
                     (session_id,started_ms,started_ms+180000,(count+2)//3))
        for index in range(count):
            item={**puzzle,'id':session_id+str(index)}
            attempt=puzzles._new_attempt(conn,item,mode='storm',rated=False,session_id=session_id)
            status=['completed','revealed','expired'][index%3]
            conn.execute('UPDATE puzzle_attempts SET status=?,failed=?,elapsed_ms=?,started_ms=? WHERE id=?',
                         (status,int(status=='revealed'),(index+1)*1000,started_ms+index//2,attempt['id']))
            attempt_ids.append(attempt['id'])
        if attempt_ids:conn.execute('UPDATE puzzle_storm SET current_attempt=? WHERE id=?',(attempt_ids[-1],session_id))
    return attempt_ids


def test_storm_summary_lists_all_attempts_in_stable_order_and_isolates_sessions(store,tmp_path,monkeypatch):
    bid=make_base('Storm copies');puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=bid))
    first=seed_storm_summary('first-session',36,1000)
    second=seed_storm_summary('second-session',8,2000)
    classic=start()
    with db.get_conn() as conn:
        before_profile=dict(conn.execute('SELECT * FROM puzzle_profile').fetchone())
        before_attempts=[tuple(row) for row in conn.execute('SELECT * FROM puzzle_attempts ORDER BY rowid')]
        before_entries=conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0]
    monkeypatch.setenv('CHESSGYM_PUZZLE_BANK',str(tmp_path/'missing-bank.sqlite3'))
    result=puzzles.storm_attempts('first-session')
    assert [item['id'] for item in result['attempts']]==first
    assert [item['index'] for item in result['attempts']]==list(range(1,37))
    assert result['summary']=={'total':36,'solved':12,'failed':12,'incomplete':12,'elapsed_ms':666000}
    assert result['storm']['id']=='first-session'
    for index,item in enumerate(result['attempts']):
        assert item['puzzle_id']=='first-session'+str(index) and item['rating']==1050 and item['color']=='black'
        assert item['outcome']==['solved','failed','incomplete'][index%3]
        assert not {'pgn','solution_pgn','solution','snapshot','fen'}&item.keys()
    assert not set(second+[classic['id']])&{item['id'] for item in result['attempts']}
    assert [item['id'] for item in puzzles.storm_attempts('second-session')['attempts']]==second
    assert puzzles.storm_attempts('first-session')==result
    with db.get_conn() as conn:
        assert dict(conn.execute('SELECT * FROM puzzle_profile').fetchone())==before_profile
        assert [tuple(row) for row in conn.execute('SELECT * FROM puzzle_attempts ORDER BY rowid')]==before_attempts
        assert conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0]==before_entries
        assert conn.execute('SELECT COUNT(*) FROM puzzle_copies').fetchone()[0]==0


def test_storm_summary_active_and_expired_puzzle_are_incomplete_not_failed(store,monkeypatch):
    bid=make_base('Storm copies');puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=bid))
    monkeypatch.setattr('random.choice',lambda values:'black')
    result=puzzles.start_storm();sid=result['storm']['id'];aid=result['attempt']['id']
    active=puzzles.storm_attempts(sid)
    assert active['storm']['status']=='active' and active['attempts'][0]['status']=='active'
    assert active['attempts'][0]['outcome']=='incomplete' and active['summary']['failed']==0
    with db.get_conn() as conn:conn.execute('UPDATE puzzle_storm SET clock_started=1,deadline_ms=1 WHERE id=?',(sid,))
    expired=puzzles.storm_attempts(sid)
    assert expired['storm']['status']=='completed' and expired['attempts'][0]['status']=='expired'
    assert expired['summary']=={'total':1,'solved':0,'failed':0,'incomplete':1,'elapsed_ms':0}
    assert expired['attempts'][0]['id']==aid and not expired['attempts'][0]['failed']
    with db.get_conn() as conn:
        assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==0
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==0
        assert conn.execute('SELECT COUNT(*) FROM puzzle_events').fetchone()[0]==0


def test_storm_summary_reports_existing_copy_without_creating_or_replacing_it(store,monkeypatch):
    bid=make_base('Storm copies');puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=bid))
    monkeypatch.setattr('random.choice',lambda values:'black')
    storm=puzzles.start_storm();failed=action(storm['attempt'],'d7d5')['attempt'];eid=failed['copied_entry_id']
    assert eid
    with db.get_conn() as conn:conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 {User notes} *',eid))
    finish_storm(storm)
    result=puzzles.storm_attempts(storm['storm']['id'])
    assert result['summary']['failed']==1 and result['attempts'][0]['copied_entry_id']==eid
    assert result['attempts'][0]['status']=='revealed' and result['attempts'][0]['outcome']=='failed'
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==1
        assert conn.execute('SELECT pgn FROM entries WHERE id=?',(eid,)).fetchone()[0]=='1. d4 {User notes} *'


def test_storm_summary_route_requires_auth_and_unknown_session_is_404(store):
    from fastapi import FastAPI
    from local_test_client import TestClient
    from accounts_api import require_user
    ids=seed_storm_summary('http-session',32,1000)
    app=FastAPI();app.include_router(puzzles.router)
    with TestClient(app) as client:
        assert client.get('/api/puzzles/storm/http-session/attempts',headers={'Host':'remote.example'}).status_code==403
        app.dependency_overrides[require_user]=lambda:{'id':1}
        assert client.get('/api/puzzles/storm/missing-session/attempts').status_code==404
        response=client.get('/api/puzzles/storm/http-session/attempts')
        assert response.status_code==200
        assert [item['id'] for item in response.json()['attempts']]==ids


def test_storm_waits_for_first_legal_move_and_excludes_observation_time(store,monkeypatch):
    clock={'seconds':2000000000}
    monkeypatch.setattr(puzzles.time,'time',lambda:clock['seconds'])
    result=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    sid=result['storm']['id'];a=result['attempt']
    assert result['storm']['clock_started'] is False and result['storm']['remaining_ms']==180000
    clock['seconds']+=172800
    status=puzzles.storm_status(sid)
    assert status['storm']['status']=='active' and status['storm']['clock_started'] is False
    assert status['storm']['remaining_ms']==180000 and status['attempt']['elapsed_ms']==0
    assert puzzles.storm_next(sid)['attempt']['id']==a['id']
    assert puzzles.storm_attempts(sid)['summary']['elapsed_ms']==0
    for kind,payload in [('move',puzzles.Action(request_id='illegal-move',version=0,move='a1a8')),
                         ('move',puzzles.Action(request_id='stale-version',version=1,move='e7e5')),
                         ('hint',puzzles.Action(request_id='hint-0001',version=0)),
                         ('reveal',puzzles.Action(request_id='reveal-0001',version=0))]:
        with pytest.raises(HTTPException):puzzles._act(a['id'],payload,kind)
        assert puzzles.storm_status(sid)['storm']['clock_started'] is False
    first=action(a,'e7e5','first-legal')
    assert first['storm']['clock_started'] is True and first['storm']['remaining_ms']==180000
    assert first['storm']['started_ms']==clock['seconds']*1000
    assert first['attempt']['elapsed_ms']==0
    deadline=first['storm']['deadline_ms']
    clock['seconds']+=10
    solved=action(first['attempt'],'b8c6','second-legal')
    assert solved['attempt']['elapsed_ms']==10000 and solved['storm']['deadline_ms']==deadline
    next_puzzle=puzzles.storm_next(sid)
    assert next_puzzle['attempt']['id']!=a['id'] and next_puzzle['storm']['clock_started'] is True
    clock['seconds']+=12
    later=action(next_puzzle['attempt'],'e7e5','next-puzzle')
    assert later['storm']['deadline_ms']==deadline and later['storm']['remaining_ms']==158000
    assert later['attempt']['elapsed_ms']==12000
    clock['seconds']+=159
    expired=puzzles.storm_status(sid)
    assert expired['storm']['status']=='completed' and expired['attempt']['status']=='expired'
    assert expired['attempt']['elapsed_ms']==170000


def test_storm_wrong_first_move_starts_clock_and_penalty_once(store,monkeypatch):
    clock={'seconds':2000000000}
    monkeypatch.setattr(puzzles.time,'time',lambda:clock['seconds'])
    result=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    clock['seconds']+=86400
    first=action(result['attempt'],'d7d5','first-wrong')
    assert first['storm']['clock_started'] is True and first['storm']['remaining_ms']==170000
    assert first['storm']['deadline_ms']==clock['seconds']*1000+170000
    assert first['storm']['mistakes']==1 and first['attempt']['elapsed_ms']==0
    clock['seconds']+=5
    repeated=action(result['attempt'],'d7d5','first-wrong')
    assert repeated==first
    status=puzzles.storm_status(result['storm']['id'])
    assert status['storm']['mistakes']==1 and status['storm']['remaining_ms']==165000
    assert status['storm']['deadline_ms']==first['storm']['deadline_ms']
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM puzzle_events').fetchone()[0]==1


def test_storm_first_correct_move_retries_and_stale_requests_do_not_reset_clock(store,monkeypatch):
    clock={'seconds':2000000000}
    monkeypatch.setattr(puzzles.time,'time',lambda:clock['seconds'])
    result=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    clock['seconds']+=500
    first=action(result['attempt'],'e7e5','first-correct')
    clock['seconds']+=25
    assert action(result['attempt'],'e7e5','first-correct')==first
    with pytest.raises(HTTPException) as exc:action(result['attempt'],'e7e5','different-request')
    assert exc.value.status_code==409
    status=puzzles.storm_status(result['storm']['id'])
    assert status['storm']['deadline_ms']==first['storm']['deadline_ms'] and status['storm']['remaining_ms']==155000


def test_abandoning_unstarted_storm_keeps_zero_attempt_time(store,monkeypatch):
    clock={'seconds':2000000000}
    monkeypatch.setattr(puzzles.time,'time',lambda:clock['seconds'])
    bid=make_base('Storm failures');puzzles.update_settings(puzzles.SettingsPayload(storm_auto_copy_base_id=bid))
    first=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    clock['seconds']+=7*86400
    second=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    old=puzzles.storm_attempts(first['storm']['id'])
    assert old['storm']['status']=='completed' and old['storm']['clock_started'] is False
    assert old['summary']=={'total':1,'solved':0,'failed':0,'incomplete':1,'elapsed_ms':0}
    assert old['attempts'][0]['status']=='expired' and old['attempts'][0]['copied_entry_id'] is None
    assert second['storm']['clock_started'] is False and second['storm']['remaining_ms']==180000
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?',(bid,)).fetchone()[0]==0
        assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==0


def test_storm_clock_migration_preserves_existing_active_deadline(store,monkeypatch):
    clock={'seconds':2000000000}
    monkeypatch.setattr(puzzles.time,'time',lambda:clock['seconds'])
    result=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    sid=result['storm']['id'];a=result['attempt'];deadline=clock['seconds']*1000+40000
    with db.get_conn() as conn:
        conn.execute('ALTER TABLE puzzle_storm DROP COLUMN clock_started')
        conn.execute('UPDATE puzzle_storm SET started_ms=?,deadline_ms=? WHERE id=?',(clock['seconds']*1000-140000,deadline,sid))
        conn.execute('UPDATE puzzle_attempts SET started_ms=? WHERE id=?',(clock['seconds']*1000-140000,a['id']))
    puzzles.init_puzzles();puzzles.init_puzzles()
    migrated=puzzles.storm_status(sid)
    assert migrated['storm']['clock_started'] is True and migrated['storm']['remaining_ms']==40000
    moved=action(a,'e7e5')
    assert moved['storm']['deadline_ms']==deadline and moved['attempt']['elapsed_ms']==140000
    clock['seconds']+=41
    assert puzzles.storm_status(sid)['storm']['status']=='completed'


def inline_action(a,move,request='inline-0001'):
    return puzzles.play_move(a['id'],puzzles.Action(request_id=request,version=a['version'],move=move,advance_storm=True))


def test_public_legal_state_is_exact_without_revealing_solution(store):
    a=start();board=chess.Board(a['fen'])
    assert a['legal']=={'fen':a['fen'],'moves':[m.uci() for m in board.legal_moves],'game_over':False,'result':'*'}
    assert len(a['legal']['moves'])>1 and 'solution' not in a and 'solution_pgn' not in a
    progressed=action(a,'e7e5')['attempt'];board=chess.Board(progressed['fen'])
    assert progressed['legal']['fen']==progressed['fen']
    assert set(progressed['legal']['moves'])=={m.uci() for m in board.legal_moves}


def test_inline_storm_advances_once_and_keeps_finished_result(store):
    add_bank_clones(['StormB2','StormB3'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    assert r['storm']['inline_next'] is True
    first=inline_action(r['attempt'],'e7e5')
    assert 'next_attempt' not in first and first['storm']['score']==0
    done=inline_action(first['attempt'],'b8c6','inline-0002')
    assert done['attempt']['status']=='completed' and done['storm']['score']==1
    nxt=done['next_attempt']
    assert nxt['status']=='active' and nxt['id']==done['storm']['current_attempt']
    assert nxt['puzzle_id']!=done['attempt']['puzzle_id'] and nxt['color']=='black'
    assert nxt['fen']==nxt['legal']['fen'] and 'e7e5' in nxt['legal']['moves']
    assert 'solution' not in nxt and 'pgn' not in nxt
    assert inline_action(first['attempt'],'b8c6','inline-0002')==done
    assert puzzles.storm_next(r['storm']['id'])['attempt']['id']==nxt['id']
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM puzzle_attempts').fetchone()[0]==2
        assert conn.execute('SELECT COUNT(*) FROM puzzle_events').fetchone()[0]==2
        assert conn.execute('SELECT rated_count FROM puzzle_profile').fetchone()[0]==0


def test_inline_storm_failure_penalty_once_and_exhaustion(store,monkeypatch):
    clock={'seconds':2000000000}
    monkeypatch.setattr(puzzles.time,'time',lambda:clock['seconds'])
    filters=puzzles.Filters(color='black',rating_min=1050,rating_max=1050)
    r=puzzles.start_storm(puzzles.StormRequest(filters=filters))
    clock['seconds']+=86400
    failed=inline_action(r['attempt'],'d7d5')
    assert failed['attempt']['failed'] and failed['attempt']['elapsed_ms']==0
    assert failed['next_attempt'] is None and failed['exhausted']
    assert failed['storm']['status']=='completed' and failed['storm']['mistakes']==1
    assert failed['storm']['deadline_ms']==clock['seconds']*1000+170000
    assert inline_action(r['attempt'],'d7d5')==failed
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM puzzle_attempts').fetchone()[0]==1


def test_inline_timeout_preserves_answer_and_allows_next_retry(store,monkeypatch):
    add_bank_clones(['StormB2'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    first=inline_action(r['attempt'],'e7e5')
    original=puzzles._select_storm_puzzle
    def timeout(*args):raise HTTPException(503,'Selection busy')
    monkeypatch.setattr(puzzles,'_select_storm_puzzle',timeout)
    done=inline_action(first['attempt'],'b8c6','inline-0002')
    assert done['attempt']['status']=='completed' and done['storm']['score']==1
    assert done['next_error']=={'status':503,'message':'Selection busy'} and done['next_attempt'] is None
    assert done['storm']['status']=='active'
    assert inline_action(first['attempt'],'b8c6','inline-0002')==done
    monkeypatch.setattr(puzzles,'_select_storm_puzzle',original)
    nxt=puzzles.storm_next(r['storm']['id'])
    assert nxt['attempt']['status']=='active' and nxt['storm']['score']==1
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM puzzle_attempts').fetchone()[0]==2


def test_storm_credits_only_server_selection_not_waiting_or_repeat(store,monkeypatch):
    clock={'seconds':2000000000,'mono':100}
    monkeypatch.setattr(puzzles.time,'time',lambda:clock['seconds'])
    monkeypatch.setattr(puzzles.time,'monotonic',lambda:clock['mono'])
    add_bank_clones(['StormB2'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    first=action(r['attempt'],'e7e5');done=action(first['attempt'],'b8c6','second-legal')
    deadline=done['storm']['deadline_ms'];clock['seconds']+=20
    original=puzzles._select_storm_puzzle
    def slow(conn,s):
        p=original(conn,s);clock['seconds']+=3;clock['mono']+=3;return p
    monkeypatch.setattr(puzzles,'_select_storm_puzzle',slow)
    nxt=puzzles.storm_next(r['storm']['id'])
    assert nxt['storm']['deadline_ms']==deadline+3000 and nxt['storm']['remaining_ms']==160000
    assert nxt['attempt']['elapsed_ms']==0
    clock['seconds']+=5
    repeated=puzzles.storm_next(r['storm']['id'])
    assert repeated['attempt']['id']==nxt['attempt']['id']
    assert repeated['storm']['deadline_ms']==deadline+3000 and repeated['storm']['remaining_ms']==155000
    with db.get_conn() as conn:assert conn.execute('SELECT COUNT(*) FROM puzzle_attempts').fetchone()[0]==2


def test_preparation_creates_nothing_and_ready_candidate_skips_selection(store,monkeypatch):
    add_bank_clones(['StormB2'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    state={**r['storm'],'score':1}
    p=puzzles._prepare_storm_future(puzzles._storm_scope(),state)
    assert p['id']!=r['attempt']['puzzle_id']
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM puzzle_attempts').fetchone()[0]==1
        assert conn.execute('SELECT clock_started FROM puzzle_storm').fetchone()[0]==0
    assert 'solution' not in puzzles.storm_status(state['id'])['attempt']
    future=Future();future.set_result(p);puzzles._storm_prefetch[puzzles._storm_prefetch_key(state)]=future
    first=inline_action(r['attempt'],'e7e5')
    def unexpected(*args):pytest.fail('A ready candidate should avoid another bank search')
    monkeypatch.setattr(puzzles,'_select_storm_puzzle',unexpected)
    done=inline_action(first['attempt'],'b8c6','inline-0002')
    assert done['next_attempt']['puzzle_id']==p['id'] and done['storm']['score']==1


def test_prefetched_unseen_candidate_revalidated_at_activation(store):
    add_bank_clones(['StormB2','StormB3'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black',history='unseen')))
    state={**r['storm'],'score':1}
    p=puzzles._prepare_storm_future(puzzles._storm_scope(),state)
    future=Future();future.set_result(p);puzzles._storm_prefetch[puzzles._storm_prefetch_key(state)]=future
    # Another tab can practise this puzzle while Storm is running.
    start(p['id'],rated=False)
    first=inline_action(r['attempt'],'e7e5')
    done=inline_action(first['attempt'],'b8c6','inline-0002')
    assert done['next_attempt']['puzzle_id'] not in (r['attempt']['puzzle_id'],p['id'])


def test_prefetch_work_is_bounded_and_stale_replays_do_not_displace_current(store,monkeypatch):
    class Pool:
        def __init__(self):self.jobs=[]
        def submit(self,*args):
            future=Future();self.jobs.append((future,args));return future
    pool=Pool()
    monkeypatch.setattr(puzzles,'_storm_prefetch_pool',pool)
    monkeypatch.setattr(puzzles,'_storm_prefetch_slots',threading.BoundedSemaphore(4))
    monkeypatch.setattr(puzzles,'_storm_prefetch_enabled',True)
    add_bank_clones(['StormB2','StormB3'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    assert len(pool.jobs)==1 and len(puzzles._storm_prefetch)==1
    puzzles._schedule_storm_prefetch(r);assert len(pool.jobs)==1
    first=inline_action(r['attempt'],'e7e5')
    done=inline_action(first['attempt'],'b8c6','inline-0002')
    assert len(puzzles._storm_prefetch)==1
    assert all(key[3]==done['next_attempt']['id'] for key in puzzles._storm_prefetch)
    keys=list(puzzles._storm_prefetch)
    puzzles._schedule_storm_prefetch(r)
    assert list(puzzles._storm_prefetch)==keys
    for future,args in pool.jobs:future.cancel()


def test_inline_is_opt_in_and_does_not_change_classic_mode(store):
    a=start();first=inline_action(a,'e7e5');done=inline_action(first['attempt'],'b8c6','inline-0002')
    assert done['attempt']['status']=='completed' and 'next_attempt' not in done and 'storm' not in done
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    done=action(action(r['attempt'],'e7e5')['attempt'],'b8c6','second-legal')
    assert done['attempt']['status']=='completed' and 'next_attempt' not in done
    assert done['storm']['current_attempt']==r['attempt']['id']


def test_concurrent_inline_retries_activate_only_one_next_attempt(store):
    add_bank_clones(['StormB2','StormB3'])
    r=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
    first=inline_action(r['attempt'],'e7e5')['attempt']
    gate=threading.Barrier(2)
    def retry():
        gate.wait(timeout=5)
        return inline_action(first,'b8c6','shared-request')
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending=[pool.submit(retry) for _ in range(2)]
        results=[job.result(timeout=10) for job in pending]
    assert results[0]==results[1] and results[0]['next_attempt']['status']=='active'
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM puzzle_attempts').fetchone()[0]==2
        assert conn.execute('SELECT score FROM puzzle_storm').fetchone()[0]==1
