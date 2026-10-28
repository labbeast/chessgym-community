"""Real PGN and isolated SQLite tests; only expensive engine calls are mocked."""
import json

import chess
import pytest
from fastapi import HTTPException

import db
import guess_move as gm
import training
from test_training import base, entry


@pytest.fixture()
def database(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'DATA_DIR',tmp_path)
    monkeypatch.setattr(db,'DB_PATH',tmp_path/'test.sqlite3')
    db.init_db();training.init_training();gm.init_guess_move()


@pytest.fixture()
def library_client(database):
    from fastapi import FastAPI
    from local_test_client import TestClient
    from accounts_api import require_user
    import library_api
    app = FastAPI()
    app.include_router(library_api.router)
    app.include_router(gm.router)
    app.dependency_overrides[require_user] = lambda: {'id': 1}
    with TestClient(app) as client:
        yield client


def begin(pgn='1. e4 {secret e5} e5 2. Nf3 Nc6 3. Bb5 *',side='both',path=''):
    bid=base({'type':'game'});eid=entry(bid,pgn)
    return gm.start_session(gm.StartRequest(entry_id=eid,side=side,path=path),user={'id':1}),eid


def line(board,uci,cp):
    move=chess.Move.from_uci(uci);san=board.san(move);board=board.copy();board.push(move)
    return {'uci':uci,'san':[san],'cp':cp,'mate':None,'depth':16,'pv':[uci],
            'positions':[{'uci':uci,'san':san,'fen':board.fen()}]}


def evaluator(board,proposed,original):
    best=next(iter(board.legal_moves))
    return {'best':line(board,best.uci(),50),'proposal':line(board,proposed.uci(),45),
            'original':line(board,original.uci(),-200)}


def answer(session,uci):
    return gm.attempt(session['id'],gm.AttemptRequest(path=session['path'],uci=uci,elapsed_ms=1234),user={'id':1})


def advance(session,path=None):
    return gm.continue_session(session['id'],gm.ContinueRequest(path=session['path'] if path is None else path),user={'id':1})


def test_whole_game_one_card_both_sides_mainline_and_ignores_start_path(database):
    bid=base({'type':'game'});eid=entry(bid,'1. e4 (1. d4 d5) e5 2. Nf3 Nc6 *',start_path='0.0')
    cards=training.queue(bid)['cards']
    assert len(cards)==1 and cards[0]['type']=='game' and cards[0]['path']==''
    assert cards[0]['fen']==chess.STARTING_FEN
    assert cards[0]['answers']==['e2e4']
    assert cards[0]['solutions']==[['e2e4','e7e5','g1f3','b8c6']]
    training.grade_card(cards[0]['id'],training.GradeRequest(grade=2))
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0]==1
    assert training.queue(bid)['cards']==[]


def test_whole_game_preserves_fen_root_and_more_than_100_plies(database):
    board=chess.Board();game=chess.pgn.Game();node=game
    for _ in range(30):
        for san in ('Nf3','Nf6','Ng1','Ng8'):
            move=board.parse_san(san);node=node.add_variation(move);board.push(move)
    bid=base({'type':'game'});entry(bid,str(game))
    assert len(training.queue(bid)['cards'][0]['solutions'][0])==120
    bid2=base({'type':'game'});entry(bid2,'[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 1"]\n\n1... Kf7 2. e4 *')
    card=training.queue(bid2)['cards'][0]
    assert card['fen'].split()[1]=='b' and card['solutions']==[['e8f7','e2e4']]


def test_source_consultation_never_changes_schedule_source_or_seen(database):
    bid=base();eid=entry(bid,'1. e4 {idea} e5 (1... c5) 2. Nf3 *')
    card=training.queue(bid)['cards'][0]
    with db.get_conn() as conn:
        before=dict(conn.execute('SELECT * FROM entries WHERE id=?',(eid,)).fetchone())
        beforecard=dict(conn.execute('SELECT * FROM review_cards WHERE id=?',(card['id'],)).fetchone())
    source=training.review_source(card['id'])
    assert len(source['nodes'])==5
    with db.get_conn() as conn:
        assert before==dict(conn.execute('SELECT * FROM entries WHERE id=?',(eid,)).fetchone())
        assert beforecard==dict(conn.execute('SELECT * FROM review_cards WHERE id=?',(card['id'],)).fetchone())
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0]==0


def test_conceals_descendants_comments_and_uses_selected_color(database):
    s,_=begin(side='black')
    assert s['path']=='0' and len(s['doc']['nodes'])==2
    assert all(n['comment']=='' and not n['nags'] for n in s['doc']['nodes'])
    assert 'pgn' not in s['doc'] and 'secret' not in json.dumps(s)
    assert s['doc']['nodes'][-1]['children']==[]


def test_metadata_and_clocks_follow_only_revealed_original_moves(database,monkeypatch):
    pgn='''[White "Alice"]
[Black "Bob"]
[WhiteElo "2430"]
[BlackElo "2380"]
[Event "City Open"]
[Date "2024.05.18"]
[TimeControl "600+5"]

1. e4 {[%clk 0:09:59.8]} (1. d4 {[%clk 0:09:40]} d5)
e5 {[%clk 0:09:58]} 2. Nf3 Nc6 {hidden idea [%clk 0:00:00]} *'''
    session,_=begin(pgn=pgn)
    monkeypatch.setattr(gm,'_evaluate',evaluator)
    assert {key:session['doc']['headers'][key] for key in
            ('White','Black','WhiteElo','BlackElo','Event','Date','TimeControl')} == {
        'White':'Alice','Black':'Bob','WhiteElo':'2430','BlackElo':'2380',
        'Event':'City Open','Date':'2024.05.18','TimeControl':'600+5'}
    assert [node['clock'] for node in session['doc']['nodes']]==[None]
    assert 'hidden idea' not in json.dumps(session)
    for uci,expected in [('d2d4',[None,599.8]),('e7e5',[None,599.8,598.0]),
                         ('g1f3',[None,599.8,598.0,None]),
                         ('b8c6',[None,599.8,598.0,None,0.0])]:
        before=session['doc']
        answered=answer(session,uci)
        assert answered['doc']==before, 'answering must not expose the next original clock'
        session=advance(answered)
        assert [node['clock'] for node in session['doc']['nodes']]==expected
        assert all(node['comment']=='' and node['nags']==[] for node in session['doc']['nodes'])
        assert session['doc']['nodes'][-1]['children']==[]
        assert 'pgn' not in session['doc']
        assert all(node['uci']!='d2d4' for node in session['doc']['nodes'])
    assert session['completed']


def test_midgame_clocks_resume_from_saved_source(database,monkeypatch):
    pgn='''[TimeControl "600+5"]

1. e4 {[%clk 0:09:59.8]} e5 {[%clk 0:09:58]} 2. Nf3 Nc6 {[%clk 0:09:50]} *'''
    session,eid=begin(pgn=pgn,side='white',path='0.0')
    assert [node['clock'] for node in session['doc']['nodes']]==[None,599.8,598.0]
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 {[%clk 0:00:01]} *',eid))
    gm.init_guess_move()
    resumed=gm.read_session(session['id'],user={'id':1})
    assert resumed['doc']==session['doc']
    monkeypatch.setattr(gm,'_evaluate',evaluator)
    done=advance(answer(resumed,'g1f3'))
    assert done['completed']
    assert [node['clock'] for node in done['doc']['nodes']]==[None,599.8,598.0,None,590.0]
    assert gm.read_session(done['id'],user={'id':1})['doc']==done['doc']


@pytest.mark.parametrize('side,uci', [('white','e2e4'), ('black','e7e5')])
@pytest.mark.parametrize('loss,expected_score', [(5,10), (250,5), (1000,0)])
def test_original_move_uses_engine_score_no_source_mutation(database,monkeypatch,side,uci,loss,expected_score):
    s,eid=begin(pgn='1. e4 {white comment} e5 {black comment} 2. Nf3 *',side=side)
    def evaluate(board,proposed,original):
        assert proposed == original
        sign=1 if board.turn==chess.WHITE else -1
        proposal=line(board,proposed.uci(),(50-loss)*sign)
        return {'best':line(board,next(iter(board.legal_moves)).uci(),50*sign),
                'proposal':proposal,'original':proposal}
    monkeypatch.setattr(gm,'_evaluate',evaluate)
    with db.get_conn() as conn:
        original=dict(conn.execute('SELECT * FROM entries WHERE id=?',(eid,)).fetchone())
    result=answer(s,uci)
    assert result['score']==result['result']['score']==expected_score
    assert result['result']['exact'] and result['exact_count']==1
    assert result['result']['comment']==side+' comment'
    repeated=answer(s,'d2d4' if side=='white' else 'd7d5')
    assert repeated['attempts']==result['attempts'] and repeated['score']==expected_score
    assert gm.read_session(s['id'],user={'id':1})['score']==expected_score
    assert gm.history(limit=20,user={'id':1})['sessions'][0]['score']==expected_score
    with db.get_conn() as conn:
        assert original==dict(conn.execute('SELECT * FROM entries WHERE id=?',(eid,)).fetchone())


def test_equal_alternative_ten_and_continue_original_not_proposal(database,monkeypatch):
    s,_=begin();monkeypatch.setattr(gm,'_evaluate',evaluator)
    result=answer(s,'d2d4');assert result['score']==10 and not result['result']['exact']
    next_session=advance(result)
    assert next_session['path']=='0'
    assert next_session['doc']['nodes'][-1]['uci']=='e2e4'
    assert advance(next_session,path='')['path']=='0'


def test_engine_failure_locks_first_legal_move_and_can_resume(database,monkeypatch):
    s,_=begin()
    def unavailable(*args):raise HTTPException(503,'unavailable')
    monkeypatch.setattr(gm,'_evaluate',unavailable)
    with pytest.raises(HTTPException):answer(s,'d2d4')
    resumed=gm.read_session(s['id'],user={'id':1})
    assert resumed['pending'] and resumed['attempts'][0]['uci']=='d2d4'
    with pytest.raises(HTTPException) as caught:answer(s,'e2e4')
    assert caught.value.status_code==409
    monkeypatch.setattr(gm,'_evaluate',evaluator)
    assert answer(s,'d2d4')['score']==10
    assert len(gm.read_session(s['id'],user={'id':1})['attempts'])==1


def test_score_color_symmetry_mates_and_bounds():
    def cp(value):return {'cp':value,'mate':None}
    assert gm.score_move(cp(50),cp(30),turn=True)==10
    assert gm.score_move(cp(50),cp(29),turn=True)==9
    assert gm.score_move(cp(-50),cp(-29),turn=False)==9
    assert gm.score_move(cp(1000),cp(-1000),turn=True)==0
    assert gm.score_move({'mate':3},{'mate':7},turn=True)==10
    assert gm.score_move({'mate':3},{'mate':-3},turn=True)==0


def test_illegal_moves_not_counted_cross_user_hidden_and_continue_guard(database):
    s,_=begin()
    with pytest.raises(HTTPException) as caught:answer(s,'e2e5')
    assert caught.value.status_code==422
    with pytest.raises(HTTPException):advance(s)
    with pytest.raises(HTTPException) as caught:gm.read_session(s['id'],user={'id':2})
    assert caught.value.status_code==404
    assert gm.read_session(s['id'],user={'id':1})['attempts']==[]


def test_completion_source_history_and_start_current_snapshot(database,monkeypatch):
    s,eid=begin(pgn='1. e4 e5 2. Nf3 Nc6 *',side='white',path='0.0')
    monkeypatch.setattr(gm,'_evaluate',evaluator)
    with pytest.raises(HTTPException):gm.source_document(s['id'],user={'id':1})
    with db.get_conn() as conn:conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 *',eid))
    done=advance(answer(s,'g1f3'))
    assert done['completed'] and done['score']==10 and done['maximum']==10
    assert done['doc']['nodes'][-1]['uci']=='b8c6'
    assert 'Nc6' in gm.source_document(s['id'],user={'id':1})['pgn']
    history=gm.history(limit=20,user={'id':1})['sessions']
    assert history[0]['completed'] and history[0]['answered']==1


def test_http_auth_validation_and_type_settings(database):
    from fastapi import FastAPI
    from local_test_client import TestClient
    from accounts_api import require_user
    from library_service import checked_settings
    app=FastAPI();app.include_router(gm.router)
    client=TestClient(app)
    assert client.get('/api/guess-move/sessions',headers={'Host':'remote.example'}).status_code==403
    app.dependency_overrides[require_user]=lambda:{'id':1}
    assert client.post('/api/guess-move/sessions',json={'pgn':'1. e4 e5 *','side':'both'}).status_code==200
    assert client.post('/api/guess-move/sessions',json={'pgn':'1. e4 *','side':'purple'}).status_code==422
    assert client.post('/api/guess-move/sessions',json={'pgn':'not a game'}).status_code==422
    assert checked_settings({'type':'game'})['type']=='game'
    response=client.post('/api/guess-move/sessions',json={'pgn':'1. e4 e5 *','side':'both'}).json()
    assert client.post('/api/guess-move/sessions/'+response['id']+'/attempt',json={'path':'','uci':'e2e4','score':10}).status_code==422


def test_user_side_skips_only_original_opponent_moves_and_starts_from_fen(database,monkeypatch):
    s,_=begin(side='black');monkeypatch.setattr(gm,'_evaluate',evaluator)
    s=advance(answer(s,'e7e5'))
    assert s['path']=='0.0.0' and s['doc']['nodes'][-1]['uci']=='g1f3'
    pgn='[SetUp "1"]\n[FEN "4k3/8/8/8/8/8/4P3/4K3 b - - 0 1"]\n\n1... Kf7 2. e4 *'
    s=gm.start_session(gm.StartRequest(pgn=pgn,side='both'),user={'id':1})
    assert s['doc']['nodes'][0]['fen'].split()[1]=='b'
    s=advance(answer(s,'e8f7'))
    assert s['path']=='0' and s['doc']['nodes'][-1]['uci']=='e8f7'


@pytest.mark.parametrize('entry_id',[0,-1,9_223_372_036_854_775_808,10**100])
def test_entry_id_bounds_reject_before_sqlite(entry_id):
    from pydantic import ValidationError
    with pytest.raises(ValidationError):
        gm.StartRequest(entry_id=entry_id)


def test_concurrent_retry_evaluates_once_and_releases_lock(database,monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    s,_=begin()
    entered,release=threading.Event(),threading.Event()
    calls=[]
    def blocked_evaluator(*args):
        calls.append(1);entered.set()
        assert release.wait(5)
        return evaluator(*args)
    monkeypatch.setattr(gm,'_evaluate',blocked_evaluator)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future=executor.submit(answer,s,'e2e4')
        try:
            assert entered.wait(5)
            with pytest.raises(HTTPException) as caught:
                answer(s,'e2e4')
            assert caught.value.status_code==409
            assert len(calls)==1
        finally:
            release.set()
        assert future.result(timeout=5)['score']==10
    assert answer(s,'e2e4')['score']==10
    assert len(calls)==1
    assert (s['id'],'') not in gm._EVALUATIONS


def test_engine_failure_releases_evaluation_guard(database,monkeypatch):
    s,_=begin()
    def unavailable(*args):raise HTTPException(503,'offline')
    monkeypatch.setattr(gm,'_evaluate',unavailable)
    with pytest.raises(HTTPException):answer(s,'e2e4')
    assert (s['id'],'') not in gm._EVALUATIONS
    monkeypatch.setattr(gm,'_evaluate',evaluator)
    assert answer(s,'e2e4')['score']==10


def test_guess_base_association_defaults_and_persists_across_restart(library_client):
    client = library_client
    legacy_id = base()
    with db.get_conn() as conn:
        legacy_settings = conn.execute('SELECT settings FROM bases WHERE id=?', (legacy_id,)).fetchone()[0]
    assert 'guess_enabled' not in json.loads(legacy_settings)
    assert client.get('/api/library').json()['bases'][0]['settings']['guess_enabled'] is False
    with db.get_conn() as conn:
        assert conn.execute('SELECT settings FROM bases WHERE id=?', (legacy_id,)).fetchone()[0] == legacy_settings
    created = client.post('/api/bases', json={'name': 'Guess collection', 'settings': {'guess_enabled': True}})
    assert created.status_code == 200, created.text
    bid = created.json()['id']
    assert created.json()['settings']['guess_enabled'] is True
    enabled = client.patch(f'/api/bases/{legacy_id}', json={'settings': {'guess_enabled': True}})
    assert enabled.status_code == 200, enabled.text
    # A fresh startup and connection must retain the association; unrelated
    # settings updates must not discard it on either old or newly made bases.
    db.init_db();training.init_training();gm.init_guess_move()
    for base_id in (legacy_id, bid):
        changed = client.patch(f'/api/bases/{base_id}', json={'name': f'Renamed {base_id}', 'settings': {'reading_enabled': True}})
        assert changed.status_code == 200, changed.text
        assert changed.json()['settings']['guess_enabled'] is True
    listed = {row['id']: row for row in client.get('/api/library').json()['bases']}
    assert all(listed[base_id]['settings']['guess_enabled'] is True for base_id in (legacy_id, bid))
    disabled = client.patch(f'/api/bases/{bid}', json={'settings': {'guess_enabled': False}})
    assert disabled.status_code == 200, disabled.text
    assert disabled.json()['settings']['guess_enabled'] is False
    assert disabled.json()['settings']['reading_enabled'] is True


@pytest.mark.parametrize('value', ['true', 'false', 'yes', 0, 1, None, [], {}])
def test_guess_base_association_rejects_non_boolean_without_writes(library_client, value):
    client = library_client
    bid = base({'guess_enabled': True})
    with db.get_conn() as conn:
        before = dict(conn.execute('SELECT * FROM bases WHERE id=?', (bid,)).fetchone())
    for method, url in [('post', '/api/bases'), ('patch', f'/api/bases/{bid}')]:
        response = getattr(client, method)(url, json={'name': 'Must not be saved', 'settings': {'guess_enabled': value}})
        assert response.status_code == 400, response.text
    with db.get_conn() as conn:
        assert dict(conn.execute('SELECT * FROM bases WHERE id=?', (bid,)).fetchone()) == before
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 1


def test_guess_base_association_preserves_documents_histories_and_direct_launch(library_client, monkeypatch):
    client = library_client
    monkeypatch.setattr(gm, '_evaluate', evaluator)
    session, eid = begin(pgn='1. e4 {Idea} e5 *', side='white')
    completed = advance(answer(session, 'e2e4'))
    assert completed['completed']
    with db.get_conn() as conn:
        bid = conn.execute('SELECT base_id FROM entries WHERE id=?', (eid,)).fetchone()[0]
    card = training.queue(bid)['cards'][0]
    training.grade_card(card['id'], training.GradeRequest(grade=2))
    tables = ('entries', 'entry_history', 'review_cards', 'review_history', 'guess_sessions', 'guess_attempts')
    with db.get_conn() as conn:
        before = {table: [dict(row) for row in conn.execute(f'SELECT * FROM {table} ORDER BY rowid')] for table in tables}
    for enabled in (True, False, True, False):
        response = client.patch(f'/api/bases/{bid}', json={'settings': {'guess_enabled': enabled}})
        assert response.status_code == 200, response.text
        with db.get_conn() as conn:
            assert {table: [dict(row) for row in conn.execute(f'SELECT * FROM {table} ORDER BY rowid')] for table in tables} == before
        assert client.get(f"/api/guess-move/sessions/{session['id']}").json()['score'] == 10
    # Association organizes selection; it never revokes access to a game's
    # direct launch from the analysis board or an existing training programme.
    launched = client.post('/api/guess-move/sessions', json={'entry_id': eid, 'side': 'both'})
    assert launched.status_code == 200, launched.text
    assert launched.json()['entry_id'] == eid


def test_guess_base_association_allows_readonly_reference_sources(library_client):
    client = library_client
    created = client.post('/api/bases', json={'name': 'Reference collection'})
    assert created.status_code == 200, created.text
    bid = created.json()['id']
    with db.get_conn() as conn:
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source) VALUES(?,?,?)', (bid, 'a' * 32, 'original.pgn'))
        before = dict(conn.execute('SELECT * FROM reference_bases WHERE base_id=?', (bid,)).fetchone())
    for enabled in (True, False):
        response = client.patch(f'/api/bases/{bid}', json={'settings': {'guess_enabled': enabled}})
        assert response.status_code == 200, response.text
        assert response.json()['reference'] is True
        assert response.json()['settings']['guess_enabled'] is enabled
        with db.get_conn() as conn:
            assert dict(conn.execute('SELECT * FROM reference_bases WHERE base_id=?', (bid,)).fetchone()) == before
            assert conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0] == 0
    assert client.patch(f'/api/bases/{bid}', json={'settings': {'reading_enabled': True}}).status_code == 400
