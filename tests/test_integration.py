"""Short HTTP journeys connecting auth, PGN storage, training and real UCI."""
import json

import chess
import pytest
from local_test_client import TestClient

import app
import db
import engine
import pgnlib


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Every route (including helpers imported elsewhere) uses these isolated globals.
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'integration.sqlite3')

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 51000)) as browser:
        assert browser.post('/api/demo', json={}, headers={'Host': 'remote.invalid'}).status_code == 403
        response = browser.get('/api/status')
        assert response.status_code == 200, response.text
        assert response.json()['local_mode'] is True and response.json()['setup_required'] is False
        assert browser.get('/api/library').json() == {'folders': [], 'bases': []}
        yield browser
    assert db.DB_PATH.parent == tmp_path


def payload(response):
    assert response.status_code == 200, response.text
    return response.json()


def examples(client):
    return payload(client.post('/api/demo', json={}))['bases']


def test_optional_demo_opens_three_legal_bases_and_real_review_queue(client):
    first = examples(client)
    assert len(first) == 3
    assert examples(client) == first
    library = payload(client.get('/api/library'))
    assert len(library['bases']) == 3 and len(library['folders']) == 1
    review_bases = payload(client.get('/api/reviews'))['bases']
    assert {base['base_id'] for base in review_bases} == {
        base['id'] for base in library['bases'] if base['settings']['review_enabled']}
    seen_types, queues = set(), {}
    for base in library['bases']:
        exported = client.get(f'/api/bases/{base["id"]}/export')
        assert exported.status_code == 200
        games = pgnlib.parse_games(exported.text)
        assert len(games) == 1
        assert games[0].board().is_valid()
        entries = payload(client.get(f'/api/bases/{base["id"]}/entries'))['entries']
        assert len(entries) == 1
        detail = payload(client.get(f'/api/entries/{entries[0]["id"]}'))
        assert detail['nodes'] and detail['pgn']
        if not base['settings']['review_enabled']:
            continue
        cards = payload(client.get(f'/api/bases/{base["id"]}/queue'))['cards']
        assert cards, f'No exercises generated for {base["name"]}'
        queues[base['id']] = cards
        seen_types.add(base['settings']['type'])
        summary = next(item for item in review_bases if item['base_id'] == base['id'])
        assert summary['total'] == summary['unseen'] == len(cards)
        assert summary['learning'] == summary['learned'] == summary['due'] == 0
        for card in cards:
            board = chess.Board(card['fen'])
            assert board.is_valid()
            for answer in card['answers']:
                assert chess.Move.from_uci(answer) in board.legal_moves
            if card['type'] == 'play':
                assert card['fen'] == games[0].board().fen()
                assert card['settings']['engine'] == 'stockfish'
                assert not card['answers']
    assert seen_types == {'moves'}
    # The first wrong attempt reaches both the scheduler and durable history.
    opening = next(base for base in library['bases'] if base['settings']['type'] == 'moves')
    payload(client.patch(f'/api/bases/{opening["id"]}',json={'settings':{'mode':'automatic'}}))
    card = queues[opening['id']][0]
    result = payload(client.post(f'/api/reviews/{card["id"]}/grade', json={
        'grade':3,'errors':1,'hints':0,'elapsed_ms':2300,'assisted':False}))
    assert result['grade'] == 0 and result['state'] == 'learning'
    assert result['interval_days'] == pytest.approx(10/1440)
    queue = payload(client.get(f'/api/bases/{opening["id"]}/queue'))['cards']
    assert card['id'] not in {item['id'] for item in queue}
    with db.get_conn() as connection:
        history = connection.execute('SELECT * FROM review_history WHERE card_id=?',(card['id'],)).fetchone()
        assert history['errors'] == 1 and history['elapsed_ms'] == 2300
        assert history['requested_grade'] == 3 and history['grade'] == 0
        assert connection.execute('SELECT COUNT(*) FROM entries').fetchone()[0] == 3


@pytest.mark.skipif(not engine.binary_path(), reason='Stockfish absent')
def test_http_analysis_and_play_use_real_engine_and_history(client):
    status = payload(client.get('/api/status'))
    assert status['authenticated'] and status['engine']['available']
    result = payload(client.post('/api/engine/analyse',json={
        'fen':chess.STARTING_FEN,'multipv':3,'time_ms':100}))
    assert len(result['lines']) == 3 and 'Stockfish' in result['engine']
    for line in result['lines']:
        board = chess.Board()
        for move in line['pv']:
            assert chess.Move.from_uci(move) in board.legal_moves
            board.push_uci(move)
        assert line['depth'] > 0
        assert line['cp'] is not None or line['mate'] is not None
    move = payload(client.post('/api/engine/play',json={
        'fen':chess.STARTING_FEN,'skill':0,'time_ms':100,
        'initial_fen':chess.STARTING_FEN,'history':[]}))
    board = chess.Board()
    assert chess.Move.from_uci(move['uci']) in board.legal_moves
    board.push_uci(move['uci'])
    assert move['fen'] == board.fen()
    repeated = ['g1f3','g8f6','f3g1','f6g8'] * 2
    board = chess.Board()
    for uci in repeated:
        board.push_uci(uci)
    draw = payload(client.post('/api/engine/play',json={
        'fen':board.fen(),'history':repeated,'initial_fen':chess.STARTING_FEN,
        'skill':10,'time_ms':100}))
    assert draw['game_over'] and draw['result'] == '1/2-1/2' and draw['uci'] is None


def test_http_extend_compatible_source_adds_only_new_tail(client):
    examples(client)
    library = payload(client.get('/api/library'))
    repertoire = next(base for base in library['bases'] if base['settings']['is_repertoire'])
    payload(client.patch(f'/api/bases/{repertoire["id"]}',json={'settings':{'primary':True}}))
    source_base = payload(client.post('/api/bases',json={'name':'Parties à étudier'}))
    source_pgn = '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 6. cxd4 $1 {Un centre de pions.} *'
    source = payload(client.post('/api/entries',json={
        'base_id':source_base['id'],'title':'Prolongement','pgn':source_pgn}))
    end = max(source['nodes'],key=lambda node:len(node['path'].split('.')))
    check = payload(client.get('/api/repertoires/compatibility',params={
        'entry_id':source['id'],'path':end['path']}))['white']
    assert check['base_id'] == repertoire['id'] and check['compatible'] and check['extendable']
    target = payload(client.get(f'/api/bases/{repertoire["id"]}/entries'))['entries'][0]
    request = {'entry_id':source['id'],'path':end['path']}
    assert payload(client.post(f'/api/repertoires/{repertoire["id"]}/extend',json=request))['added_moves'] == 2
    assert payload(client.post(f'/api/repertoires/{repertoire["id"]}/extend',json=request))['added_moves'] == 0
    updated = payload(client.get(f'/api/entries/{target["id"]}'))
    game = pgnlib.load_game(updated['pgn'])
    final = pgnlib.node_at(game,end['path'])
    assert final.nags == {1} and final.comment == 'Un centre de pions.'
    # The alternate black move on move 3 remains available after extending the main line.
    assert len(pgnlib.node_at(game,'0.0.0.0.0').variations) == 2
    assert payload(client.get(f'/api/entries/{source["id"]}'))['pgn'] == source['pgn']
    assert len(payload(client.get(f'/api/bases/{repertoire["id"]}/entries'))['entries']) == 1
