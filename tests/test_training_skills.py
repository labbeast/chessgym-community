"""Score integrity, blindfold privacy, source matching and PGN preservation."""
import io
import json
import urllib.error
from types import SimpleNamespace

import chess
import pytest
from fastapi import FastAPI
from local_test_client import TestClient

import db
import pgnlib
import puzzle_store
import training_skills as skills
from accounts_api import require_user


PGN = '[Event "Course"]\n\n1. e4 {Idea} e5 2. Nf3 Nc6 (2... Nf6) 3. Bb5 a6 4. Ba4 *'


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'skills.sqlite3')
    db.init_db()
    skills.init_training_skills()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users VALUES(1,'owner','unused','today')")
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(1,'Course','today')")
        conn.execute("INSERT INTO entries(id,base_id,title,pgn,created_at,updated_at) VALUES(1,1,'Example',?,'today','today')", (PGN,))
    application = FastAPI()
    application.include_router(skills.router)
    application.dependency_overrides[require_user] = lambda: {'id': 1}
    monkeypatch.setattr(skills, '_source_next', 0)
    with TestClient(application) as client:
        yield client


def stored(sid):
    with db.get_conn() as conn:
        return skills._row(conn, sid, 1)


def test_coordinate_scoring_deadline_and_duplicate_receipts(client, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(skills.time, 'time', lambda: clock[0])
    session = ok(client.post('/api/skills/coordinates', json={'mode': 'coordinates', 'duration': 30}))
    sid, target = session['id'], session['target']['square']
    assert 'score' not in session['config']
    wrong = next(square for square in chess.SQUARE_NAMES if square != target)
    clock[0] += .3
    first = ok(client.post(f'/api/skills/coordinates/{sid}/answer', json={'index': 0, 'square': wrong}))
    assert first['score'] == 0 and first['errors'] == 1 and first['target']['square'] == target
    assert client.post(f'/api/skills/coordinates/{sid}/answer', json={'index': 0, 'square': target}).status_code == 409
    clock[0] += .5
    second = ok(client.post(f'/api/skills/coordinates/{sid}/answer', json={'index': 1, 'square': target}))
    assert second['score'] == 1 and second['target']['square'] != target
    assert client.post(f'/api/skills/coordinates/{sid}/finish').status_code == 409
    clock[0] = 1030.1
    final = ok(client.post(f'/api/skills/coordinates/{sid}/answer', json={'index': 2, 'square': second['target']['square']}))
    assert final['finished'] and final['result'] == {'score': 1, 'errors': 1, 'accuracy': 50, 'mean_ms': 800, 'duration': 30}
    assert len(stored(sid)['state']['events']) == 2
    assert ok(client.post(f'/api/skills/coordinates/{sid}/finish'))['result'] == final['result']
    assert client.post('/api/skills/coordinates', json={'score': 999}).status_code == 422


def test_coordinate_records_separate_all_training_dimensions(client, monkeypatch):
    clock = [5000.0]
    monkeypatch.setattr(skills.time, 'time', lambda: clock[0])
    for mode, color, duration, coords in [('coordinates', 'white', 30, False), ('notation', 'white', 30, False), ('notation', 'black', 30, False), ('notation', 'black', 60, False), ('notation', 'black', 60, True)]:
        session = ok(client.post('/api/skills/coordinates', json={'mode': mode, 'orientation': color, 'duration': duration, 'coordinates': coords}))
        assert session['target']['notation'] == (mode == 'notation')
        clock[0] += duration + 1
        ok(client.post(f'/api/skills/coordinates/{session["id"]}/finish'))
    history = ok(client.get('/api/skills/coordinates/history'))
    assert len(history['records']) == 5 and len(history['history']) == 5
    assert all(row['score'] == 0 for row in history['records'])
    session = ok(client.post('/api/skills/coordinates', json={'orientation': 'random'}))
    assert session['config']['orientation'] in {'white', 'black'}


def test_sessions_are_account_owned_and_abandoned_cannot_become_records(client):
    first = ok(client.post('/api/skills/coordinates', json={}))
    second = ok(client.post('/api/skills/coordinates', json={}))
    assert stored(first['id'])['result']['abandoned']
    assert not ok(client.get('/api/skills/coordinates/history'))['records']
    client.app.dependency_overrides[require_user] = lambda: {'id': 2}
    assert client.post(f'/api/skills/coordinates/{second["id"]}/finish').status_code == 404
    client.app.dependency_overrides.clear()
    assert client.get('/api/skills/coordinates/history', headers={'Host': 'remote.example'}).status_code == 403


def test_reconstruction_hides_target_and_preserves_source(client):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'reconstruct', 'entry_id': 1, 'max_moves': 2}))
    sid = session['id']
    assert [row['san'] for row in session['prompt']['moves']] == ['e4', 'e5', 'Nf3', 'Nc6']
    assert 'fen' not in json.dumps(session).lower()
    assert 'document' not in session
    assert client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': {}}).status_code == 409
    ready = ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    assert 'prompt' not in ready and 'document' not in ready
    assert 'prompt' not in ok(client.get(f'/api/skills/blindfold/{sid}'))
    board = chess.Board()
    for move in ['e2e4', 'e7e5', 'g1f3', 'b8c6']:
        board.push_uci(move)
    pieces = {chess.square_name(square): piece.symbol() for square, piece in board.piece_map().items()}
    finished = ok(client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': pieces}))
    assert finished['result']['success'] and finished['result']['accuracy'] == 100
    assert len(finished['document']['nodes']) == 5
    assert not any(node['san'] == 'Nf6' for node in finished['document']['nodes'])
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=1').fetchone()['pgn'] == PGN
    assert ok(client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': {}}))['result']['success']


def test_reconstruction_custom_start_and_whole_game(client):
    pgn = '[SetUp "1"]\n[FEN "8/8/8/8/3k4/8/8/4K2R w K - 0 23"]\n\n23. Rh4+ Kc3 24. Kd1 *'
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=1', (pgn,))
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'reconstruct', 'entry_id': 1, 'whole_game': True}))
    assert session['prompt']['initial_position']['white']
    assert len(session['prompt']['moves']) == 3
    assert session['prompt']['moves'][0]['number'] == 23


def test_reconstruction_comparison_distinguishes_wrong_missing_extra():
    target = '7k/8/8/8/8/8/4P3/K7 w - - 0 1'
    result = skills.compare_position(target, {'h8': 'k', 'a1': 'Q', 'd2': 'P'})
    assert result['correct'] == ['h8']
    assert result['missing'] == [{'square': 'e2', 'piece': 'P'}]
    assert {x['square'] for x in result['misplaced']} == {'a1', 'd2'}
    assert not result['success'] and result['accuracy'] == 33.3
    with pytest.raises(Exception):
        skills.compare_position(target, {'a9': 'P'})


@pytest.fixture
def puzzle(monkeypatch):
    board = chess.Board()
    for move in ['e2e4', 'e7e5', 'g1f3']:
        board.push_uci(move)
    value = {'id': 'abc12', 'fen': board.fen(), 'moves': ['b8c6', 'f1b5', 'a7a6', 'b5a4'],
             'rating': 1400, 'game_url': 'https://lichess.org/abcdefgh#3', 'color': 'white'}
    calls = []
    def search(filters, **kwargs):
        calls.append(filters)
        return [value]
    monkeypatch.setattr(puzzle_store, 'search_puzzles', search)
    return value, calls


def test_endgame_blind_input_errors_and_reply_notation(client, puzzle):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame', 'max_pieces': 9, 'hide_prompt': False}))
    sid = session['id']
    assert puzzle[1][-1]['max_pieces'] == 9
    assert session['prompt']['position']['turn'] == 'white'
    assert all(key not in session for key in ['solution', 'document', 'fen', 'start_fen'])
    ready = ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    assert 'prompt' in ready
    wrong = ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'a1a8', 'index': 0}))
    assert not wrong['correct'] and wrong['errors'] == 1 and 'document' not in wrong
    assert client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Fb5', 'index': 0}).status_code == 409
    right = ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Fb5', 'index': 1}))
    assert right['correct'] and [item['san'] for item in right['played']] == ['Bb5', 'a6']
    final = ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'b5a4=q', 'index': 2}))
    assert not final['finished'] and final['phase'] == 'reconstruct'
    assert final['solve_result']['errors'] == 1 and not final['solve_result']['success']
    assert 'document' not in final and 'prompt' not in final and final['played'] == []
    final = ok(client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': _pieces(stored(sid)['state']['fen'])}))
    assert final['finished'] and not final['result']['success'] and final['result']['errors'] == 1
    assert final['result']['reconstruction_success'] and not final['result']['solve_success']
    assert len(final['attempts']) == 3 and len(final['document']['nodes']) == 4
    history = ok(client.get('/api/skills/blindfold/history'))
    assert len(history['history']) == 1 and history['history'][0]['title'] == 'abc12'


def test_hidden_prompt_does_not_return_after_ready_or_wrong_answer(client, puzzle):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame', 'hide_prompt': True, 'input': 'text'}))
    sid = session['id']
    ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    wrong = ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'RANDOM', 'index': 0}))
    assert 'prompt' not in wrong and 'document' not in wrong and 'legal' not in wrong
    revealed = ok(client.post(f'/api/skills/blindfold/{sid}/reveal'))
    assert revealed['result']['revealed'] and not revealed['result']['success'] and revealed['document']


def test_opening_matches_exact_ply_and_position_not_fabricated(client, puzzle, monkeypatch):
    monkeypatch.setattr(skills, '_source_game', lambda url: pgnlib.load_game(PGN))
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'opening', 'max_moves': 4}))
    assert len(session['prompt']['moves']) == 4
    assert puzzle[1][-1]['max_initial_ply'] == 8
    monkeypatch.setattr(skills, '_source_game', lambda url: pgnlib.load_game('1. d4 d5 2. Nf3 Nc6 *'))
    response = client.post('/api/skills/blindfold', json={'mode': 'opening'})
    assert response.status_code == 503 and 'correspond' in response.json()['detail']


def test_source_fetch_uses_fixed_host_bounded_read_cache_and_cooldown(client, monkeypatch):
    calls = []
    def urlopen(request, timeout):
        calls.append(request.full_url)
        return io.BytesIO(PGN.encode())
    monkeypatch.setattr(skills.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=urlopen))
    game = skills._source_game('https://lichess.org/abcdefgh/black#4')
    assert len(list(game.mainline_moves())) == 7
    skills._source_game('https://lichess.org/abcdefgh#4')
    assert len(calls) == 1 and calls[0].startswith('https://lichess.org/game/export/abcdefgh?')
    with pytest.raises(ValueError):
        skills._source_game('https://evil.test/abcdefgh')
    with pytest.raises(ValueError):
        skills._source_game('https://lichess.org/ijklmnop')
    assert len(calls) == 1


def test_source_429_blocks_further_requests(client, monkeypatch):
    def failed(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 429, 'slow down', {}, None)
    monkeypatch.setattr(skills.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=failed))
    with pytest.raises(ValueError):
        skills._source_game('https://lichess.org/abcdefgh')
    with db.get_conn() as conn:
        cached = conn.execute('SELECT retry_after,fetched_at FROM skill_source_games').fetchone()
    assert cached['retry_after'] - cached['fetched_at'] == 60


def test_source_uses_server_token_without_redirects_and_retries_after_token_change(client, monkeypatch):
    token = [None]
    requests = []
    monkeypatch.setattr(skills.explorer_credentials, 'get_token', lambda: token[0])
    def transport(request, timeout):
        requests.append(request)
        if not request.get_header('Authorization'):
            raise urllib.error.HTTPError(request.full_url, 302, 'redirect', {'Location': 'https://lichess.org/signup'}, None)
        return io.BytesIO(PGN.encode())
    monkeypatch.setattr(skills.urllib.request, 'build_opener', lambda *args: SimpleNamespace(open=transport))
    with pytest.raises(ValueError, match='jeton'):
        skills._source_game('https://lichess.org/abcdefgh')
    token[0] = 'unit-test-token-not-a-secret'
    monkeypatch.setattr(skills, '_source_next', 0)
    assert skills._source_game('https://lichess.org/abcdefgh')
    assert requests[-1].get_header('Authorization') == 'Bearer ' + token[0]
    assert skills._NoSourceRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://evil.test') is None
    with db.get_conn() as conn:
        cached = dict(conn.execute('SELECT * FROM skill_source_games').fetchone())
    assert token[0] not in json.dumps(cached) and len(cached['credential_key']) == 64


def test_parse_french_and_english_and_promotions():
    board = chess.Board()
    assert skills.parse_answer(board, 'Cf3', 'fr').uci() == 'g1f3'
    assert skills.parse_answer(board, 'Nf3', 'en').uci() == 'g1f3'
    assert skills.parse_answer(board, 'g1f3=q').uci() == 'g1f3'
    board = chess.Board('7k/P7/8/8/8/8/8/K7 w - - 0 1')
    assert skills.parse_answer(board, 'a7a8=n').uci() == 'a7a8n'
    assert skills.parse_answer(board, 'a7a8=q').uci() == 'a7a8q'


def test_no_puzzles_gives_actionable_message(client, monkeypatch):
    monkeypatch.setattr(puzzle_store, 'search_puzzles', lambda *args, **kwargs: [])
    response = client.post('/api/skills/blindfold', json={'mode': 'endgame'})
    assert response.status_code == 404 and 'Importe' in response.json()['detail']


@pytest.mark.parametrize('fallback', [False, True])
def test_blindfold_selection_timeout_is_retryable_not_empty_bank(client, monkeypatch, fallback):
    calls = []
    def search(*args, **kwargs):
        calls.append(kwargs)
        if fallback and len(calls) == 1:
            return []
        raise puzzle_store.PuzzleSelectionTimeout()
    monkeypatch.setattr(puzzle_store, 'search_puzzles', search)
    response = client.post('/api/skills/blindfold', json={'mode': 'endgame'})
    assert response.status_code == 503
    assert response.json()['detail'] == 'La sélection de puzzles prend trop de temps. Réessaie ou précise les filtres.'
    assert len(calls) == (2 if fallback else 1)
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM skill_sessions').fetchone()[0] == 0


def test_blindfold_accepts_another_immediate_mate_without_revealing_solution(client):
    fen = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1'
    with db.get_conn() as conn:
        row = skills._new_session(conn, 1, 'blindfold', {'mode': 'endgame', 'hide_prompt': True},
                                 {'puzzle_id': 'mate', 'start_fen': fen, 'fen': fen, 'solution': ['g6g7'],
                                  'index': 0, 'errors': 0, 'attempts': [], 'played': [], 'prompt': {}})
    sid = row['id']
    assert 'solution' not in ok(client.get(f'/api/skills/blindfold/{sid}'))
    answer = ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Dh6', 'index': 0}))
    assert answer['correct'] and answer['finished'] and answer['result']['success']
    assert answer['played'][0]['san'] == 'Qh6#'


def test_canonical_sessions_allow_lost_reply_recovery(client, puzzle):
    coordinate = ok(client.post('/api/skills/coordinates', json={}))
    sid = coordinate['id']
    ok(client.post(f'/api/skills/coordinates/{sid}/answer', json={'index': 0, 'square': coordinate['target']['square']}))
    recovered = ok(client.get(f'/api/skills/coordinates/{sid}'))
    assert recovered['index'] == 1 and recovered['score'] == 1
    blind = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame'}))
    sid = blind['id']
    ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Fb5', 'index': 0}))
    recovered = ok(client.get(f'/api/skills/blindfold/{sid}'))
    assert recovered['index'] == 2 and recovered['answer_index'] == 1
    assert 'prompt' not in recovered and 'document' not in recovered
    assert client.post('/api/skills/blindfold', json={'mode': 'reconstruct', 'entry_id': 2**80}).status_code == 422



def _pieces(fen):
    return {chess.square_name(square): piece.symbol() for square, piece in chess.Board(fen).piece_map().items()}


def _solve_two(client, sid):
    ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Bb5', 'language': 'en', 'index': 0}))
    return ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Ba4', 'language': 'en', 'index': 1}))


def test_puzzle_reconstruction_defaults_on_and_keeps_target_secret_until_submitted(client, puzzle, monkeypatch):
    stamp = [1000.0]
    monkeypatch.setattr(skills.time, 'time', lambda: stamp[0])
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame', 'hide_prompt': False}))
    assert session['config']['reconstruct_after'] is True and session['phase'] == 'solve'
    sid = session['id']
    assert client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': {}}).status_code == 409
    stamp[0] = 1005
    ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    stamp[0] = 1008
    ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Fb5', 'index': 0}))
    stamp[0] = 1012
    waiting = ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Fa4', 'index': 1}))
    assert waiting['phase'] == 'reconstruct' and waiting['result'] is None and not waiting['finished']
    assert waiting['solve_result']['elapsed_ms'] == 7000 and waiting['solve_result']['preparation_ms'] == 5000
    assert waiting['preparation_ms'] == 5000 and waiting['solve_result']['total_elapsed_ms'] == 12000
    assert all(key not in waiting for key in ('document', 'fen', 'start_fen', 'target_fen', 'prompt', 'attempts', 'expected'))
    assert waiting['played'] == []
    recovered = ok(client.get(f'/api/skills/blindfold/{sid}'))
    assert recovered == {key: value for key, value in waiting.items() if key != 'correct'}
    assert ok(client.get('/api/skills/blindfold/history'))['history'] == []
    assert client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'a4b3', 'index': 2}).status_code == 409
    target = stored(sid)['state']['fen']
    stamp[0] = 1020
    final = ok(client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': _pieces(target)}))
    assert final['phase'] == 'finished' and final['finished']
    result = final['result']
    assert result['success'] and result['solve_success'] and result['reconstruction_success']
    assert result['solve_elapsed_ms'] == 7000 and result['reconstruction_elapsed_ms'] == 8000
    assert result['elapsed_ms'] == 15000 and result['accuracy'] == 100
    assert result['preparation_ms'] == final['preparation_ms'] == 5000
    assert result['total_elapsed_ms'] == 20000
    assert final['document']['nodes'][-1]['fen'] == target
    # Retrying after a lost response never regrades or alters either phase.
    retry = ok(client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': {}}))
    assert retry['result'] == result
    assert ok(client.get('/api/skills/blindfold/history'))['history'][0]['reconstruction_success']
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=1').fetchone()[0] == PGN


@pytest.mark.parametrize('mode', ['opening', 'positions', 'reconstruct'])
def test_visualization_timer_survives_reload_and_ready_is_idempotent(client, puzzle, monkeypatch, mode):
    clock = [1000.0]
    monkeypatch.setattr(skills.time, 'time', lambda: clock[0])
    monkeypatch.setattr(skills, 'opening_prefix', lambda puzzle: [{'number': 1, 'color': 'white', 'san': 'e4'}])
    config = {'mode': mode, 'entry_id': 1} if mode == 'reconstruct' else {'mode': mode}
    session = ok(client.post('/api/skills/blindfold', json=config))
    sid = session['id']
    assert session['preparation_ms'] == 0 and not session['started']
    clock[0] = 1002.25
    recovered = ok(client.get(f'/api/skills/blindfold/{sid}'))
    assert recovered['preparation_ms'] == 2250 and recovered['prompt'] == session['prompt']
    overview = ok(client.get('/api/skills/blindfold/overview'))
    assert overview['active_session']['preparation_ms'] == 2250
    clock[0] = 1005
    ready = ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    assert ready['started'] and ready['preparation_ms'] == 5000
    clock[0] = 1011
    repeated = ok(client.post(f'/api/skills/blindfold/{sid}/ready'))
    assert repeated['preparation_ms'] == 5000
    assert ok(client.get(f'/api/skills/blindfold/{sid}'))['preparation_ms'] == 5000
    assert stored(sid)['started_at'] == 1005
    clock[0] = 1020
    final = ok(client.post(f'/api/skills/blindfold/{sid}/reveal'))
    assert final['preparation_ms'] == final['result']['preparation_ms'] == 5000
    assert final['result']['elapsed_ms'] == 15000
    assert final['result']['total_elapsed_ms'] == 20000
    clock[0] = 1030
    assert ok(client.get(f'/api/skills/blindfold/{sid}')) == final
    assert ok(client.post(f'/api/skills/blindfold/{sid}/reveal')) == final


@pytest.mark.parametrize('action', ['reveal', 'abandon', 'replace'])
def test_visualization_ended_before_ready_counts_time_once(client, puzzle, monkeypatch, action):
    clock = [1000.0]
    monkeypatch.setattr(skills.time, 'time', lambda: clock[0])
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'positions'}))
    sid = session['id']
    clock[0] = 1008.5
    if action == 'replace':
        ok(client.post('/api/skills/blindfold', json={'mode': 'positions'}))
        final = ok(client.get(f'/api/skills/blindfold/{sid}'))
    else:
        final = ok(client.post(f'/api/skills/blindfold/{sid}/{action}'))
    assert final['finished'] and not final['started']
    assert final['preparation_ms'] == final['result']['preparation_ms'] == 8500
    assert final['result']['elapsed_ms'] == 0
    assert final['result']['total_elapsed_ms'] == 8500
    clock[0] = 1040
    assert ok(client.get(f'/api/skills/blindfold/{sid}')) == final


def test_legacy_finished_session_keeps_missing_visualization_time_unknown(client, puzzle):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'positions'}))
    sid = session['id']
    legacy = {'abandoned': True}
    with db.get_conn() as conn:
        conn.execute('UPDATE skill_sessions SET finished_at=created_at+10,result=? WHERE id=?', (json.dumps(legacy), sid))
    final = ok(client.get(f'/api/skills/blindfold/{sid}'))
    assert final['preparation_ms'] is None and final['result'] == legacy


def test_reconstruction_mistake_keeps_successful_solve_score_separate(client, puzzle):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame'}))
    _solve_two(client, session['id'])
    final = ok(client.post(f'/api/skills/blindfold/{session["id"]}/position', json={'pieces': {'a1': 'q'}}))
    assert final['result']['solve_success'] is True and final['result']['solve_errors'] == 0
    assert final['result']['reconstruction_success'] is False and final['result']['success'] is True
    assert final['result']['misplaced'] and final['result']['missing']
    assert final['result']['proposed'] == {'a1': 'q'}
    history = ok(client.get('/api/skills/blindfold/history'))['history'][0]
    assert history['success'] and not history['reconstruction_success']
    import training_history
    client.app.include_router(training_history.router)
    item = ok(client.get('/api/training/history?tool=blindfold'))['items'][0]
    assert item['outcome'] == 'success'
    assert item['metrics']['solve_success'] == 1 and item['metrics']['reconstruction_success'] == 0
    statistics = ok(client.get('/api/training/history/statistics?tool=blindfold'))
    assert statistics['outcomes']['success'] == 1 and statistics['outcomes']['failure'] == 0
    assert statistics['metrics']['solve_success'] == 1 and statistics['metrics']['reconstruction_success'] == 0


def test_reveal_during_reconstruction_marks_it_failed_without_changing_solve(client, puzzle):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame'}))
    _solve_two(client, session['id'])
    final = ok(client.post(f'/api/skills/blindfold/{session["id"]}/reveal'))
    assert final['phase'] == 'finished' and final['document']
    assert final['result']['revealed'] and final['result']['success']
    assert final['result']['reconstruction_skipped']
    assert final['result']['solve_success'] and not final['result']['reconstruction_success']


def test_optional_reconstruction_can_be_disabled_for_new_puzzles(client, puzzle):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame', 'reconstruct_after': False}))
    final = _solve_two(client, session['id'])
    assert final['finished'] and final['phase'] == 'finished' and final['result']['success']
    assert final['document'] and 'solve_result' not in final


def test_alternative_mate_reconstruction_uses_actual_move_and_final_board(client):
    fen = '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1'
    with db.get_conn() as conn:
        row = skills._new_session(conn, 1, 'blindfold',
            {'mode': 'endgame', 'hide_prompt': True, 'reconstruct_after': True},
            {'puzzle_id': 'mate', 'start_fen': fen, 'fen': fen, 'solution': ['g6g7'],
             'index': 0, 'errors': 0, 'attempts': [], 'played': [], 'prompt': {}})
    sid = row['id']
    waiting = ok(client.post(f'/api/skills/blindfold/{sid}/answer', json={'move': 'Dh6', 'index': 0}))
    assert waiting['phase'] == 'reconstruct' and 'document' not in waiting
    board = chess.Board(fen)
    board.push_uci('g6h6')
    final = ok(client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': _pieces(board.fen())}))
    assert final['result']['success']
    assert final['document']['nodes'][-1]['uci'] == 'g6h6'
    assert final['document']['nodes'][-1]['fen'] == board.fen()
    assert 'Qh6#' in final['document']['pgn'] and 'Qg7#' not in final['document']['pgn']


def test_reconstruction_phase_remains_account_owned_and_validates_pieces(client, puzzle):
    session = ok(client.post('/api/skills/blindfold', json={'mode': 'endgame'}))
    sid = session['id']
    _solve_two(client, sid)
    assert client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': {'z9': 'K'}}).status_code == 400
    assert client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': {'a1': 'bogus'}}).status_code == 400
    assert ok(client.get(f'/api/skills/blindfold/{sid}'))['phase'] == 'reconstruct'
    client.app.dependency_overrides[require_user] = lambda: {'id': 2}
    assert client.post(f'/api/skills/blindfold/{sid}/position', json={'pieces': {}}).status_code == 404
    assert client.post(f'/api/skills/blindfold/{sid}/reveal').status_code == 404
