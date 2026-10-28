"""Computer play is legal, history-aware and independent of the library."""
import chess
import pytest
from fastapi import FastAPI
from local_test_client import TestClient

import computer_api
import db
import engine
import maia_engine


@pytest.fixture
def client(monkeypatch):
    isolated = FastAPI()
    isolated.include_router(computer_api.router, prefix='/api')
    monkeypatch.setattr(db, 'get_conn', lambda: pytest.fail('Computer play must not open the library'))
    monkeypatch.setattr(engine, 'status', lambda: {'available': True, 'name': 'Stockfish Test'})
    monkeypatch.setattr(maia_engine, 'status', lambda: {
        'available': True, 'name': 'Maia 3', 'levels': list(maia_engine.LEVELS)})
    with TestClient(isolated) as value:
        yield value


def engine_reply(fen, uci):
    board = chess.Board(fen)
    move = chess.Move.from_uci(uci)
    san = board.san(move)
    board.push(move)
    return {'uci': uci, 'san': san, 'fen': board.fen(), 'game_over': False, 'result': '*'}


def test_new_position_contains_usable_document_and_legal_state(client):
    response = client.post('/api/computer/position', json={})
    assert response.status_code == 200
    state = response.json()
    assert state['fen'] == state['initial_fen'] == chess.STARTING_FEN
    assert state['history'] == [] and state['path'] == ''
    assert state['turn'] == 'white' and state['result'] == '*'
    assert state['game_over'] is False and state['reason'] is None
    assert state['last_move'] is None and state['uci'] is None
    assert len(state['legal_moves']) == 20
    assert state['legalState'] == {'fen': state['fen'], 'moves': state['legal_moves'],
                                   'game_over': False, 'result': '*'}
    assert state['doc']['nodes'][0]['fen'] == chess.STARTING_FEN
    assert state['claimable_draws'] == {'threefold_repetition': False, 'fifty_moves': False}


def test_human_move_replays_history_and_keeps_source_immutable(client):
    source = {'initial_fen': chess.STARTING_FEN, 'history': ['e2e4', 'c7c5']}
    state = client.post('/api/computer/position', json={**source, 'move': 'g1f3'}).json()
    expected = chess.Board()
    for uci in ['e2e4', 'c7c5', 'g1f3']:
        expected.push_uci(uci)
    assert state['fen'] == expected.fen()
    assert state['history'] == ['e2e4', 'c7c5', 'g1f3']
    assert state['san'] == 'Nf3' and state['uci'] == state['last_move'] == 'g1f3'
    assert state['path'] == '0.0.0' and state['turn'] == 'black'
    assert [node['san'] for node in state['doc']['nodes'][1:]] == ['e4', 'c5', 'Nf3']
    assert source['history'] == ['e2e4', 'c7c5']
    assert 'id' not in state['doc'] and 'base_id' not in state['doc']
    # Re-reading the source is unchanged; no session or save is implicit.
    assert client.post('/api/computer/position', json=source).json()['history'] == source['history']


@pytest.mark.parametrize('payload', [
    {'initial_fen': 'bad'},
    {'initial_fen': '8/8/8/8/8/8/8/8 w - - 0 1'},
    {'initial_fen': '4k3/8/8/8/8/8/8/4K3 w KQ - 0 1'},
    {'history': ['e2e5']}, {'history': ['e2e4', 'd2d4']},
    {'history': ['0000']}, {'history': ['e2e4q']}, {'history': ['E2E4']},
    {'history': ['e2e4'] * 2001}, {'history': None},
    {'move': 'e7e5'}, {'move': '0000'}, {'move': 'e2e4\ngo infinite'},
    {'history': ['e2e4'], 'fen': chess.STARTING_FEN}, {'fen': 'bad'},
    {'initial_fen': 'x' * 257}, {'save': True},
])
def test_bad_state_and_illegal_moves_are_rejected(client, payload):
    assert client.post('/api/computer/position', json=payload).status_code == 422


@pytest.mark.parametrize('fen,history,move,expected_piece', [
    ('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', [], 'e1g1', ('f1', 'R')),
    (chess.STARTING_FEN, ['e2e4', 'a7a6', 'e4e5', 'd7d5'], 'e5d6', ('d6', 'P')),
    ('7k/P7/8/8/8/8/8/7K w - - 0 1', [], 'a7a8q', ('a8', 'Q')),
])
def test_castling_en_passant_and_promotion(client, fen, history, move, expected_piece):
    response = client.post('/api/computer/position', json={
        'initial_fen': fen, 'history': history, 'move': move})
    assert response.status_code == 200, response.text
    state = response.json()
    board = chess.Board(state['fen'])
    square, piece = expected_piece
    assert board.piece_at(chess.parse_square(square)).symbol() == piece
    assert state['doc']['nodes'][-1]['fen'] == state['fen']
    if move == 'e5d6':
        assert board.piece_at(chess.D5) is None


@pytest.mark.parametrize('fen,history,reason,result', [
    (chess.STARTING_FEN, ['f2f3', 'e7e5', 'g2g4', 'd8h4'], 'checkmate', '0-1'),
    ('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', [], 'stalemate', '1/2-1/2'),
    ('7k/8/6K1/8/8/8/8/8 w - - 0 1', [], 'insufficient_material', '1/2-1/2'),
    ('7k/8/6K1/8/8/8/8/R7 w - - 100 51', [], 'fifty_moves', '1/2-1/2'),
    ('7k/8/6K1/8/8/8/8/R7 w - - 150 76', [], 'seventyfive_moves', '1/2-1/2'),
    (chess.STARTING_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 2, 'threefold_repetition', '1/2-1/2'),
    (chess.STARTING_FEN, ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 4, 'fivefold_repetition', '1/2-1/2'),
])
def test_terminal_position_is_returned_without_engine_work(client, monkeypatch, fen, history, reason, result):
    monkeypatch.setattr(engine, 'play', lambda *a, **kw: pytest.fail('No search after game over'))
    monkeypatch.setattr(maia_engine, 'play', lambda *a, **kw: pytest.fail('No search after game over'))
    source = {'initial_fen': fen, 'history': history}
    for endpoint in ('position', 'move'):
        response = client.post('/api/computer/' + endpoint, json=source)
        assert response.status_code == 200, response.text
        state = response.json()
        assert state['game_over'] is True and state['result'] == result
        assert state['reason'] == reason and state['legal_moves'] == []
        assert state['doc']['headers']['Result'] == result
    assert client.post('/api/computer/position', json={**source, 'move': 'a1a2'}).status_code == 409


def test_cannot_replay_after_an_automatic_draw(client):
    history = ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 4 + ['g1f3']
    assert client.post('/api/computer/position', json={'history': history}).status_code == 422


def test_fifty_move_clock_is_preserved_after_human_move(client):
    response = client.post('/api/computer/position', json={
        'initial_fen': '7k/8/6K1/8/8/8/8/R7 w - - 98 50', 'move': 'a1a2'})
    assert response.status_code == 200
    state = response.json()
    # A draw can already be claimed if the next legal move reaches 100 plies.
    assert state['reason'] == 'fifty_moves'
    assert state['claimable_draws']['fifty_moves'] is True
    assert state['fen'].endswith('99 50')


def test_stockfish_receives_full_history_and_limits(client, monkeypatch):
    calls = []
    def play(fen, **options):
        calls.append((fen, options))
        return engine_reply(fen, 'b8c6')
    monkeypatch.setattr(engine, 'play', play)
    source = {'history': ['e2e4', 'e7e5', 'g1f3'], 'skill': 4, 'time_ms': 100}
    response = client.post('/api/computer/move', json=source)
    assert response.status_code == 200, response.text
    assert calls[0][1] == {'skill': 4, 'time_ms': 100, 'history': source['history'],
                           'initial_fen': chess.STARTING_FEN}
    state = response.json()
    assert state['history'] == [*source['history'], 'b8c6']
    assert state['uci'] == 'b8c6' and state['san'] == 'Nc6'


def test_maia_dispatches_actual_level_with_custom_start(client, monkeypatch):
    calls = []
    def play(fen, **options):
        calls.append((fen, options))
        return engine_reply(fen, 'h8g8')
    monkeypatch.setattr(maia_engine, 'play', play)
    fen = '7k/8/6K1/8/8/8/8/R7 b - - 0 32'
    response = client.post('/api/computer/move', json={
        'initial_fen': fen, 'provider': 'maia', 'level': 1900})
    assert response.status_code == 200, response.text
    assert calls == [(fen, {'level': 1900, 'history': [], 'initial_fen': fen})]
    assert response.json()['history'] == ['h8g8']


@pytest.mark.parametrize('options', [
    {'provider': 'unknown'}, {'skill': -1}, {'skill': 21}, {'skill': True},
    {'skill': '10'}, {'skill': 2.5}, {'time_ms': 99}, {'time_ms': 2001},
    {'time_ms': False}, {'time_ms': '500'}, {'level': 500}, {'level': 2700},
    {'level': True}, {'level': '1500'}, {'provider': 'maia', 'level': 1501},
    {'move': 'e2e4'},
])
def test_engine_options_are_strict_and_bounded(client, monkeypatch, options):
    monkeypatch.setattr(engine, 'play', lambda *a, **kw: pytest.fail('Invalid request must not run an engine'))
    monkeypatch.setattr(maia_engine, 'play', lambda *a, **kw: pytest.fail('Invalid request must not run an engine'))
    assert client.post('/api/computer/move', json=options).status_code == 422


def test_unavailable_opponent_is_explicit(client, monkeypatch):
    monkeypatch.setattr(maia_engine, 'status', lambda: {
        'available': False, 'levels': [], 'message': 'Maia doit être installé.'})
    monkeypatch.setattr(maia_engine, 'play', lambda *a, **kw: pytest.fail('Unavailable engine must not start'))
    response = client.get('/api/computer/opponents')
    assert response.status_code == 200
    stockfish, maia = response.json()['engines']
    assert stockfish['id'] == 'stockfish' and stockfish['skills'] == list(range(21))
    assert maia['id'] == 'maia' and maia['available'] is False
    assert maia['message'] == 'Maia doit être installé.'
    assert client.post('/api/computer/move', json={'provider': 'maia'}).status_code == 503


def test_maia3_keeps_provider_id_and_exposes_extended_ratings(client):
    response = client.get('/api/computer/opponents')
    maia = response.json()['engines'][1]
    assert maia['id'] == 'maia' and maia['name'] == 'Maia 3'
    assert maia['levels'] == list(range(600, 2700, 100))
    assert maia['default_level'] == 1500


@pytest.mark.parametrize('level', [600, 1000, 1100, 1900, 2000, 2600])
def test_maia3_new_and_persisted_legacy_levels_are_playable(client, monkeypatch, level):
    calls = []
    def play(fen, **options):
        calls.append(options)
        return engine_reply(fen, 'e7e5')
    monkeypatch.setattr(maia_engine, 'play', play)
    source = {'provider': 'maia', 'level': level, 'history': ['e2e4']}
    response = client.post('/api/computer/move', json=source)
    assert response.status_code == 200, response.text
    assert calls == [{'level': level, 'history': ['e2e4'], 'initial_fen': chess.STARTING_FEN}]
    assert response.json()['history'] == ['e2e4', 'e7e5']


@pytest.mark.parametrize('reply', [
    None, {}, {'uci': None}, {'uci': 'e2e5'}, {'uci': '0000'},
    {'uci': 'e2e4', 'fen': chess.STARTING_FEN},
])
def test_invalid_engine_output_cannot_change_the_position(client, monkeypatch, reply):
    monkeypatch.setattr(engine, 'play', lambda *a, **kw: reply)
    assert client.post('/api/computer/move', json={}).status_code == 503
    assert client.post('/api/computer/position', json={}).json()['fen'] == chess.STARTING_FEN


def test_authenticated_route_in_application(tmp_path, monkeypatch):
    # Separate from the isolated rule tests: exercise real authentication and
    # same-origin protection, always against a fresh temporary personal DB.
    import app
    import interactive_engine
    import jobs
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'computer-auth.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)
    monkeypatch.setattr(interactive_engine, 'close', lambda: None)
    monkeypatch.setattr(engine, 'shutdown', lambda: None)
    monkeypatch.setattr(maia_engine, 'shutdown', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 51017)) as value:
        assert value.get('/api/computer/opponents', headers={'Host': 'remote.invalid'}).status_code == 403
        assert value.post('/api/computer/position', json={}, headers={'Host': 'remote.invalid'}).status_code == 403
        assert value.post('/api/computer/move', json={}, headers={'Host': 'remote.invalid'}).status_code == 403
        assert value.get('/api/status').status_code == 200
        with db.get_conn() as conn:
            before = list(conn.iterdump())
        assert value.post('/api/computer/position', json={'move': 'e2e4'}).status_code == 200
        with db.get_conn() as conn:
            assert list(conn.iterdump()) == before
        assert value.post('/api/computer/position', json={},
                          headers={'Origin': 'https://foreign.example'}).status_code == 403
