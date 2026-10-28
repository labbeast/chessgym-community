"""Durable computer-game history, clocks, insert-only copies and account CAS."""
import copy
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import chess
import pytest
from fastapi import FastAPI, HTTPException
from local_test_client import TestClient

import computer_api
import computer_history as history
import computer_history_api
import db
import pgnlib
from accounts_api import require_user


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'computer-history.sqlite3')
    db.init_db()
    with db.get_conn() as conn:
        history.init_schema(conn)
        conn.execute("INSERT INTO users VALUES(1,'tester','unused','2026-10-24')")
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(1,'Computer games','2026-10-24'),(2,'Other','2026-10-24'),(3,'Reference','2026-10-24')")
        conn.execute("INSERT INTO reference_bases(base_id,storage_key,source) VALUES(3,'12345678901234567890123456789012','test.pgn')")
    api = FastAPI()
    api.include_router(computer_history_api.router)
    api.include_router(computer_api.router, prefix='/api', dependencies=[])
    api.dependency_overrides[require_user] = lambda: {'id': 1}
    with TestClient(api) as result:
        yield result


def snapshot(moves=(), *, game_id='test-game', resigned=False, side='white', timeout=None, initial_fen=chess.STARTING_FEN):
    position = computer_api.position(computer_api.PositionRequest(initial_fen=initial_fen, history=list(moves)))
    return {'version': 1, 'mode': 'play', 'config': {'provider': 'stockfish'}, 'session': {
        'id': game_id, 'position': position, 'baseline': 0, 'side': side,
        'config': {'provider': 'stockfish', 'skill': 10}, 'resigned': resigned,
        'timeout': timeout, 'headers': {'White': 'Human', 'Black': 'Computer', 'Result': '*'},
        'start': {'initial_fen': initial_fen, 'history': []}}, 'displayPath': position['path'], 'pendingMove': None}


def put(client, value, revision=0, mutation_id=None):
    body = {'snapshot': value, 'expected_revision': revision}
    if mutation_id is not None:
        body['mutation_id'] = mutation_id
    return client.put('/api/computer/games/' + value['session']['id'], json=body)


def enable_copy(client, base_id=1):
    previous = client.get('/api/computer/settings').json()
    response = client.patch('/api/computer/settings', json={'auto_copy': True, 'base_id': base_id, 'expected_revision': previous['revision']})
    assert response.status_code == 200, response.text
    return response.json()


def clock(*, remaining=None, expired=None, moves=0):
    return {'version': 1, 'initial_ms': 600000, 'increment_ms': 5000,
        'remaining': remaining or {'white': 596000, 'black': 600000},
        'running': 'black' if moves % 2 else 'white', 'paused': False, 'expired': expired,
        'history': [{'ply': 0, 'remaining': {'white': 600000, 'black': 600000}}] +
            ([{'ply': 1, 'remaining': {'white': 596000, 'black': 600000}}] if moves else [])}


def test_archive_roundtrip_and_settings_default_no_library_copy(client):
    settings = client.get('/api/computer/settings').json()
    assert settings == {'auto_copy': False, 'base_id': None, 'revision': 0,
                        'bases': [{'id': 1, 'name': 'Computer games'}, {'id': 2, 'name': 'Other'}]}
    value = snapshot(['e2e4', 'c7c5'])
    saved = put(client, value).json()
    assert saved['revision'] == 1 and saved['result'] == '*'
    assert saved['finished_at'] is None and saved['copies'] == []
    assert saved['snapshot']['session']['position']['history'] == ['e2e4', 'c7c5']
    assert '1. e4 c5' in saved['pgn']
    with db.get_conn() as conn:
        history.init_schema(conn)
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 0
    assert client.get('/api/computer/games/test-game').json() == saved
    listing = client.get('/api/computer/games').json()
    assert listing['total'] == 1 and listing['items'][0]['moves'] == 1
    assert listing['items'][0]['white'] == 'Human'
    assert listing['items'][0]['finished'] is False


def test_all_sessions_remain_and_order_is_most_recent_start(client):
    a = put(client, snapshot(['e2e4'], game_id='a')).json()
    put(client, snapshot(['d2d4'], game_id='b'))
    put(client, snapshot(['e2e4', 'e7e5'], game_id='a'), a['revision'])
    listing = client.get('/api/computer/games?limit=1').json()
    assert listing['total'] == 2 and listing['items'][0]['id'] == 'b'
    assert client.get('/api/computer/games?offset=1&limit=1').json()['items'][0]['id'] == 'a'


def test_untimed_explicit_pause_roundtrips_without_inventing_time_or_moves():
    value = snapshot(['e2e4', 'c7c5'])
    value['session'].update(paused=True, activity={'version': 1, 'elapsed_ms': 2500})
    # Exercise the real archive sanitizer and serialization, independently of
    # the HTTP test client's event-loop/socket setup on Windows.
    paused = history.prepare_write('test-game', value)
    stored = json.loads(paused[2])
    assert stored['session']['paused'] is True
    assert stored['session']['activity']['elapsed_ms'] == 2500
    assert stored['session']['position']['history'] == ['e2e4', 'c7c5']
    assert stored['session']['position']['game_over'] is False
    stored['session']['paused'] = False
    resumed = history.prepare_write('test-game', stored)
    assert resumed[3] != paused[3]
    restored = json.loads(resumed[2])['session']
    assert restored['paused'] is False and restored['activity']['elapsed_ms'] == 2500


def test_cas_and_idempotent_exact_retry(client):
    value = snapshot(['e2e4'])
    saved = put(client, value, mutation_id='request-1').json()
    assert put(client, value, mutation_id='request-1').json() == saved
    changed = snapshot(['d2d4'])
    assert put(client, changed, mutation_id='request-1').status_code == 409
    assert put(client, changed).status_code == 409
    newer = put(client, changed, saved['revision'], mutation_id='request-2').json()
    assert newer['revision'] == 2
    assert put(client, value, mutation_id='request-1').status_code == 409
    assert put(client, changed, 1).json()['revision'] == 2
    assert put(client, changed, False).status_code == 422


def test_server_discards_forged_pgn_and_result(client):
    value = snapshot(['e2e4'])
    value['session']['position']['doc']['headers']['White'] = 'Forged'
    value['session']['position']['doc']['pgn'] = '1. d4 d5 1-0'
    value['session']['position']['result'] = '1-0'
    value['session']['headers']['Result'] = '1-0'
    result = put(client, value).json()
    assert result['result'] == '*'
    assert 'e4' in result['pgn'] and 'd4' not in result['pgn'] and 'Forged' not in result['pgn']


def test_finish_copies_once_and_never_rewrites_manual_library_edit(client):
    enable_copy(client)
    ongoing = put(client, snapshot(['f2f3'])).json()
    assert ongoing['copies'] == []
    value = snapshot(['f2f3', 'e7e5', 'g2g4', 'd8h4'])
    finished = put(client, value, ongoing['revision']).json()
    assert finished['reason'] == 'checkmate' and finished['result'] == '0-1'
    eid = finished['copies'][0]['entry_id']
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET pgn='1. d4 {my annotation} *' WHERE id=?", (eid,))
    value['displayPath'] = ''
    repeated = put(client, value, finished['revision']).json()
    assert repeated['copies'][0]['entry_id'] == eid
    assert client.post('/api/computer/games/test-game/copy', json={'base_id': 1}).json() == {'base_id': 1, 'entry_id': eid, 'created': False}
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 1
        assert conn.execute('SELECT pgn FROM entries WHERE id=?', (eid,)).fetchone()[0] == '1. d4 {my annotation} *'


def test_manual_copy_ongoing_to_other_base_and_deleted_copy_is_not_auto_recreated(client):
    enable_copy(client)
    value = snapshot(['e2e4'], resigned=True)
    saved = put(client, value).json()
    eid = saved['copies'][0]['entry_id']
    other = client.post('/api/computer/games/test-game/copy', json={'base_id': 2}).json()
    assert other['created'] and other['entry_id'] != eid
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?', (eid,))
    value['displayPath'] = ''
    after = put(client, value, saved['revision']).json()
    assert after['copies'][0]['entry_id'] is None
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 1
    # A later explicit Copy is an intentional new copy after the user deleted it.
    explicit = client.post('/api/computer/games/test-game/copy', json={'base_id': 1}).json()
    assert explicit['created'] and explicit['entry_id'] > eid


def test_deleted_auto_destination_keeps_history_and_returns_notice(client):
    enable_copy(client)
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=1')
    saved = put(client, snapshot(['e2e4'], resigned=True)).json()
    assert saved['result'] == '0-1' and saved['auto_copy_error']
    assert client.get('/api/computer/games').json()['items'][0]['auto_copy_error'] == saved['auto_copy_error']


def test_reference_base_or_missing_destination_rejected(client):
    for base_id in (3, 999, False, -1):
        assert client.patch('/api/computer/settings', json={'auto_copy': True, 'base_id': base_id, 'expected_revision': 0}).status_code in (404, 422)
    assert client.patch('/api/computer/settings', json={'auto_copy': True, 'base_id': None, 'expected_revision': 0}).status_code == 422
    put(client, snapshot())
    assert client.post('/api/computer/games/test-game/copy', json={'base_id': 3}).status_code == 422
    assert client.post('/api/computer/games/test-game/copy', json={'base_id': 999}).status_code == 404


def test_settings_revision_guards_other_device(client):
    prefs = enable_copy(client)
    assert client.patch('/api/computer/settings', json={'auto_copy': False, 'expected_revision': 0}).status_code == 409
    assert client.patch('/api/computer/settings', json={'auto_copy': False, 'expected_revision': prefs['revision']}).json()['auto_copy'] is False


@pytest.mark.parametrize('mutation', [
    lambda s: s.update(version=2),
    lambda s: s.update(session=None),
    lambda s: s['session'].update(id='other'),
    lambda s: s['session'].update(side='random'),
    lambda s: s['session'].update(resigned='false'),
    lambda s: s['session'].update(baseline=99),
    lambda s: s['session'].update(timeout='green'),
    lambda s: s['session'].update(clock={'version': 2}),
    lambda s: s['session']['position'].update(history=['e2e5']),
    lambda s: s['session']['position'].update(fen=chess.STARTING_FEN),
    lambda s: s['session']['headers'].update(White='Human\n[Result "1-0"]'),
    lambda s: s['session'].update(config={'provider': 'arbitrary'}),
])
def test_invalid_game_never_saved(client, mutation):
    value = snapshot(['e2e4'])
    mutation(value)
    assert client.put('/api/computer/games/test-game', json={'snapshot': value, 'expected_revision': 0}).status_code == 422
    assert client.get('/api/computer/games').json()['total'] == 0


def test_size_limit(client, monkeypatch):
    monkeypatch.setattr(history, 'MAX_SNAPSHOT_BYTES', 50)
    assert put(client, snapshot()).status_code == 413
    assert client.get('/api/computer/games').json()['total'] == 0


def test_clock_annotations_and_paused_resume_preserve_remaining_time(client):
    value = snapshot(['e2e4'])
    value['session']['clock'] = clock(moves=1)
    saved = put(client, value).json()
    assert saved['snapshot']['session']['clock'] == value['session']['clock']
    assert saved['pgn'].find('[TimeControl "600+5"]') >= 0
    game = pgnlib.load_game(saved['pgn'])
    assert next(iter(game.mainline())).clock() == 596
    assert client.get('/api/computer/games').json()['items'][0]['time_control'] == '600+5'
    value['session']['clock']['paused'] = True
    value['session']['clock']['running'] = None
    paused = put(client, value, saved['revision']).json()
    assert paused['snapshot']['session']['clock']['remaining'] == {'white': 596000, 'black': 600000}


@pytest.mark.parametrize('loser,fen,result', [
    ('white', chess.STARTING_FEN, '0-1'),
    ('black', '7k/8/6K1/8/8/8/8/R7 b - - 0 1', '1-0'),
    ('white', '7k/8/6K1/8/8/8/8/R7 w - - 0 1', '1/2-1/2'),
    ('white', '7k/5n2/6K1/8/8/8/8/R7 w - - 0 1', '0-1'),
])
def test_timeout_adjudication_and_archive(client, loser, fen, result):
    state = client.post('/api/computer/timeout', json={'initial_fen': fen, 'history': [], 'loser': loser})
    assert state.status_code == 200, state.text
    assert state.json()['result'] == result and state.json()['reason'] == 'timeout'
    assert state.json()['legal_moves'] == []
    assert pgnlib.load_game(state.json()['doc']['pgn']).headers['Result'] == result
    value = snapshot(initial_fen=fen, timeout=loser)
    value['session']['clock'] = clock(remaining={loser: 0, 'black' if loser == 'white' else 'white': 12345}, expired=loser)
    saved = put(client, value)
    assert saved.status_code == 200, saved.text
    saved = saved.json()
    assert saved['result'] == result and saved['reason'] == 'timeout'
    assert saved['snapshot']['session']['clock']['paused'] is True
    assert saved['snapshot']['session']['position']['doc']['headers']['Result'] == result
    assert '[Termination "time forfeit"]' in saved['pgn']


def test_wrong_clock_side_or_nonexpired_clock_never_adjudicated(client):
    assert client.post('/api/computer/timeout', json={'loser': 'black'}).status_code == 422
    value = snapshot(timeout='white')
    value['session']['clock'] = clock(expired='white')
    assert put(client, value).status_code == 422
    value['session']['clock']['remaining']['white'] = 0
    value['session']['clock']['expired'] = None
    assert put(client, value).status_code == 422


def test_checkmate_wins_over_later_timeout_signal(client):
    value = snapshot(['f2f3', 'e7e5', 'g2g4', 'd8h4'], timeout='white')
    response = client.post('/api/computer/timeout', json={
        'history': value['session']['position']['history'], 'loser': 'white'})
    assert response.json()['reason'] == 'checkmate'
    saved = put(client, value).json()
    assert saved['reason'] == 'checkmate' and saved['snapshot']['session']['timeout'] is None


def test_nonlocal_requests_are_rejected(client):
    client.app.dependency_overrides.clear()
    for method, url, payload in [('get', '/api/computer/games', None), ('get', '/api/computer/settings', None),
        ('get', '/api/computer/games/any', None), ('put', '/api/computer/games/test-game', {'snapshot': snapshot(), 'expected_revision': 0}),
        ('patch', '/api/computer/settings', {'auto_copy': False, 'expected_revision': 0}),
        ('post', '/api/computer/games/test-game/copy', {'base_id': 1})]:
        response = client.request(method, url, json=payload, headers={'Host': 'remote.example'})
        assert response.status_code == 403


def test_account_ownership_isolated_even_when_game_id_matches():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys=ON')
    conn.executescript('''CREATE TABLE users(id INTEGER PRIMARY KEY);
        INSERT INTO users VALUES(1),(2);
        CREATE TABLE bases(id INTEGER PRIMARY KEY,name TEXT);
        CREATE TABLE entries(id INTEGER PRIMARY KEY,base_id INTEGER,title TEXT,pgn TEXT,created_at TEXT,updated_at TEXT);
        CREATE TABLE reference_bases(base_id INTEGER PRIMARY KEY);''')
    history.init_schema(conn)
    history.write(conn, 1, 'test-game', snapshot(['e2e4']), 0)
    assert history.list_games(conn, 2)['total'] == 0
    with pytest.raises(HTTPException) as err:
        history.read(conn, 2, 'test-game')
    assert err.value.status_code == 404
    history.write(conn, 2, 'test-game', snapshot(['d2d4']), 0)
    assert history.read(conn, 1, 'test-game')['snapshot']['session']['position']['history'] == ['e2e4']
    assert history.read(conn, 2, 'test-game')['snapshot']['session']['position']['history'] == ['d2d4']
    conn.close()


def test_competing_writers_do_not_lose_a_game_update(client):
    saved = put(client, snapshot()).json()
    barrier = Barrier(2)
    def store(uci):
        barrier.wait(timeout=5)
        try:
            with db.get_conn() as conn:
                conn.execute('BEGIN IMMEDIATE')
                history.write(conn, 1, 'test-game', snapshot([uci]), saved['revision'])
            return 200
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(2) as executor:
        results = list(executor.map(store, ['e2e4', 'd2d4']))
    assert sorted(results) == [200, 409]
    assert client.get('/api/computer/games/test-game').json()['revision'] == 2


@pytest.mark.parametrize('change', [
    lambda c: c.update(initial_ms=0),
    lambda c: c.update(initial_ms=-1),
    lambda c: c.update(increment_ms=3600001),
    lambda c: c.update(running='red'),
    lambda c: c.update(paused='false'),
    lambda c: c['remaining'].update(white=True),
    lambda c: c['history'].append({'ply': 1, 'remaining': {'white': 20, 'black': 20}}),
    lambda c: c['history'].append({'ply': 2, 'remaining': {'white': 20, 'black': 20}}),
])
def test_invalid_clock_checkpoint_rejected(client, change):
    value = snapshot(['e2e4'])
    value['session']['clock'] = clock(moves=1)
    change(value['session']['clock'])
    assert put(client, value).status_code == 422


def test_clock_only_annotates_moves_played_after_analysis_start(client):
    value = snapshot(['e2e4', 'e7e5', 'g1f3'])
    value['session']['baseline'] = 2
    value['session']['clock'] = clock(moves=1)
    value['session']['clock']['history'] = [
        {'ply': 2, 'remaining': {'white': 600000, 'black': 600000}},
        {'ply': 3, 'remaining': {'white': 596000, 'black': 600000}},
    ]
    saved = put(client, value)
    assert saved.status_code == 200, saved.text
    nodes = list(pgnlib.load_game(saved.json()['pgn']).mainline())
    assert [node.clock() for node in nodes] == [None, None, 596]


def test_unknown_game_or_route_id_is_not_disclosed(client):
    assert client.get('/api/computer/games/unknown').status_code == 404
    assert client.post('/api/computer/games/unknown/copy', json={'base_id': 1}).status_code == 404
    assert client.get('/api/computer/games/bad%20id').status_code == 422
    assert client.get('/api/computer/games?limit=101').status_code == 422



def test_legacy_session_without_clock_can_be_archived_and_resumed(client):
    value = snapshot(['e2e4', 'c7c5'])
    del value['session']['timeout']
    del value['session']['config']['skill']
    result = put(client, value)
    assert result.status_code == 200, result.text
    restored = result.json()['snapshot']['session']
    assert restored['clock'] is None and restored['timeout'] is None
    assert restored['position']['history'] == ['e2e4', 'c7c5']
    assert restored['headers']['TimeControl'] == '-'


def test_replay_and_pgn_generation_happen_before_database_write_lock(client, monkeypatch):
    original = history.canonical_snapshot
    def checked(*args, **kwargs):
        # An unrelated writer can acquire the lock throughout preparation.
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            conn.execute("UPDATE bases SET name=name WHERE id=1")
        return original(*args, **kwargs)
    monkeypatch.setattr(history, 'canonical_snapshot', checked)
    assert put(client, snapshot(['e2e4'])).status_code == 200



def test_personal_backup_includes_history_clocks_settings_and_copy_links(client, tmp_path):
    import zipfile
    import backup_service
    enable_copy(client)
    value = snapshot(['e2e4'], resigned=True)
    value['session']['clock'] = clock(moves=1)
    saved = put(client, value).json()
    archive_path = tmp_path / 'computer-history-backup.zip'
    backup_service.build_archive(archive_path)
    with zipfile.ZipFile(archive_path) as archive:
        restored_path = tmp_path / 'restored-history.sqlite3'
        restored_path.write_bytes(archive.read('chessgym.sqlite3'))
    with sqlite3.connect(restored_path) as restored:
        restored.row_factory = sqlite3.Row
        actual = history.read(restored, 1, 'test-game')
        assert actual['snapshot'] == saved['snapshot']
        assert actual['pgn'] == saved['pgn'] and actual['copies'] == saved['copies']
        assert history.settings(restored, 1)['auto_copy'] is True
        assert restored.execute('PRAGMA foreign_key_check').fetchall() == []



def test_enabling_auto_copy_does_not_retroactively_copy_finished_games(client):
    value = snapshot(['e2e4'], resigned=True)
    saved = put(client, value).json()
    assert saved['copies'] == []
    enable_copy(client)
    value['displayPath'] = ''
    reread = put(client, value, saved['revision']).json()
    assert reread['copies'] == []
    # A later game still gets its own automatic copy.
    newer = put(client, snapshot(['d2d4'], game_id='next-game', resigned=True)).json()
    assert len(newer['copies']) == 1


def test_failed_auto_copy_can_be_retried_without_losing_the_game(client):
    prefs = enable_copy(client)
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=1')
    value = snapshot(['e2e4'], resigned=True)
    failed = put(client, value).json()
    assert failed['auto_copy_error'] and failed['copies'] == []
    client.patch('/api/computer/settings', json={'auto_copy': True, 'base_id': 2, 'expected_revision': prefs['revision']})
    result = put(client, value, failed['revision']).json()
    assert result['auto_copy_error'] is None and result['copies'][0]['base_id'] == 2


def test_active_play_duration_roundtrips_without_timestamps(client):
    value = snapshot(['e2e4'])
    value['session']['activity'] = {'version': 1, 'elapsed_ms': 2345.25}
    result = put(client, value)
    assert result.status_code == 200, result.text
    assert result.json()['snapshot']['session']['activity'] == {'version': 1, 'elapsed_ms': 2345.25}


@pytest.mark.parametrize('activity', [True, {}, {'version': 2, 'elapsed_ms': 0},
    {'version': True, 'elapsed_ms': 0}, {'version': 1, 'elapsed_ms': True},
    {'version': 1, 'elapsed_ms': -1}, {'version': 1, 'elapsed_ms': history.MAX_MS+1},
    {'version': 1, 'elapsed_ms': 0, 'started_at': 'fake'}])
def test_invalid_active_duration_is_rejected_without_archive(activity, client):
    value = snapshot(['e2e4'])
    value['session']['activity'] = activity
    assert put(client, value).status_code == 422
    assert client.get('/api/computer/games').json()['total'] == 0


def test_legacy_snapshot_does_not_invent_active_duration(client):
    saved = put(client, snapshot(['e2e4'])).json()
    assert 'activity' not in saved['snapshot']['session']
