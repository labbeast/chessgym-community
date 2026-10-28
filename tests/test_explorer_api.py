from copy import deepcopy
import json

import chess
import pytest
from local_test_client import TestClient

import app
import db
import explorer


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'explorer-api.sqlite3')
    monkeypatch.delenv('CHESSGYM_LICHESS_TOKEN', raising=False)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        yield client


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


def make_base(owner, name, pgn=None):
    base = owner.post('/api/bases', json={'name': name}).json()['id']
    if pgn:
        response = owner.post('/api/entries', json={'base_id': base, 'pgn': pgn})
        assert response.status_code == 200, response.text
    return base


def dataset(rows=(), status='ok', stale=False):
    moves = [{'uci': uci, 'san': 'UNTRUSTED', 'white': w, 'draws': d, 'black': b,
              'unknown': u, 'total': w + d + b + u} for uci, w, d, b, u in rows]
    result = {key: sum(row[key] for row in moves) for key in ('white', 'draws', 'black', 'unknown', 'total')}
    return {**result, 'moves': moves, 'status': status, 'cached': stale, 'stale': stale,
            'fetched_at': '2026-10-19T20:00:00+00:00'}


def query(owner, settings, fen=chess.STARTING_FEN):
    response = owner.post('/api/explorer', json={'fen': fen, 'settings': settings})
    assert response.status_code == 200, response.text
    return response.json()


def test_explorer_requires_owner(client):
    assert client.get('/api/explorer/settings', headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.patch('/api/explorer/settings', json={'source': 'local'}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.post('/api/explorer', json={'fen': chess.STARTING_FEN}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_preferences_are_saved_and_deleted_sources_are_not_replaced(owner):
    first, second = make_base(owner, 'A'), make_base(owner, 'B')
    before = owner.get('/api/preferences').json()
    assert owner.get('/api/explorer/settings').json() == explorer.DEFAULT_SETTINGS
    saved = owner.patch('/api/explorer/settings', json={
        'source': 'local', 'base_ids': [second, first, first],
        'master_source': 'local', 'master_base_ids': [second],
        'speeds': ['rapid', 'blitz'], 'ratings': [1800, 1600],
    })
    assert saved.status_code == 200, saved.text
    assert saved.json()['base_ids'] == [first, second]
    assert owner.get('/api/explorer/settings').json() == saved.json()
    assert owner.get('/api/preferences').json()['piece_set'] == before['piece_set']
    assert owner.delete(f'/api/bases/{second}').status_code == 200
    cleaned = owner.get('/api/explorer/settings').json()
    assert cleaned['source'] == 'local' and cleaned['base_ids'] == [first]
    assert cleaned['master_source'] == 'local' and cleaned['master_base_ids'] == []


@pytest.mark.parametrize('patch', [
    {'source': 'https://localhost/'}, {'master_source': False}, {'other': 1},
    {'ratings': []}, {'ratings': [1700]}, {'ratings': [True]}, {'speeds': []},
    {'speeds': ['fast']}, {'base_ids': [True]}, {'base_ids': [999999]},
    {'base_ids': '1'}, {'master_base_ids': [999999]},
    {'engine_depth': True}, {'engine_depth': False}, {'engine_depth': 0},
    {'engine_depth': 2**31}, {'engine_depth': 18.5}, {'engine_depth': '18'},
    {'engine_depth': []}, {'engine_depth': {}},
])
def test_invalid_settings_are_atomic(owner, patch):
    before = owner.get('/api/explorer/settings').json()
    assert owner.patch('/api/explorer/settings', json=patch).status_code == 400
    assert owner.get('/api/explorer/settings').json() == before


def test_query_validation_precedes_any_network(owner, monkeypatch):
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', lambda *a, **kw: pytest.fail('No network for invalid request'))
    for payload in ({'fen': 'broken'}, {'fen': 123}, {'fen': {}}, {'fen': None}, {'fen': 'x' * 257}, {'fen': chess.STARTING_FEN, 'url': 'https://example.com'},
                    {'fen': chess.STARTING_FEN, 'settings': {'ratings': [1700]}},
                    {'fen': chess.STARTING_FEN, 'settings': {'engine_depth': 0}}):
        assert owner.post('/api/explorer', json=payload).status_code == 400


def test_depth_settings_upgrade_and_persist_without_changing_sources(owner):
    legacy = {key: value for key, value in explorer.DEFAULT_SETTINGS.items() if key != 'engine_depth'}
    legacy.update(source='masters', speeds=['blitz'], ratings=[2000])
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences(key,value) VALUES(?,?)',
                     (explorer.SETTINGS_KEY, json.dumps(legacy)))
    assert owner.get('/api/explorer/settings').json() == {**legacy, 'engine_depth': None}
    for depth in (1, 7, 18, 31, 64, None):
        response = owner.patch('/api/explorer/settings', json={'engine_depth': depth})
        assert response.status_code == 200, response.text
        assert response.json() == {**legacy, 'engine_depth': depth}
        assert owner.get('/api/explorer/settings').json() == response.json()


def test_depth_is_local_and_never_changes_public_statistics(owner, monkeypatch):
    calls = []
    def remote(source, fen, **filters):
        calls.append(filters)
        return dataset([('e2e4', 2, 1, 1, 0)])
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', remote)
    quick = query(owner, {'engine_depth': None})
    deep = query(owner, {'engine_depth': 24})
    assert quick['moves'] == deep['moves']
    assert deep['settings']['engine_depth'] == 24
    assert all(filters == {'ratings': [1600, 1800], 'speeds': ['rapid'], 'token': None} for filters in calls)


def test_public_and_master_stats_are_joined_per_legal_move(owner, monkeypatch):
    peers = dataset([('e2e4', 30, 10, 20, 0), ('d2d4', 10, 10, 20, 0)])
    masters = dataset([('e2e4', 4, 4, 2, 0), ('d2d4', 30, 30, 20, 0), ('g1f3', 5, 3, 2, 0)])
    calls = []
    def remote(source, fen, **filters):
        calls.append((source, fen, filters))
        return deepcopy(peers if source == 'lichess' else masters)
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', remote)
    result = query(owner, {})
    e4, d4, nf3 = result['moves']
    assert (e4['san'], e4['frequency'], e4['master_frequency']) == ('e4', 60, 10)
    assert (d4['san'], d4['frequency'], d4['master_frequency']) == ('d4', 40, 80)
    assert nf3['frequency'] == 0 and nf3['master_frequency'] == 10
    assert e4['white'] == 30 and e4['draws'] == 10 and e4['black'] == 20
    assert [call[0] for call in calls] == ['lichess', 'masters']
    assert all(call[1:] == (chess.STARTING_FEN, {'ratings': [1600, 1800], 'speeds': ['rapid'], 'token': None}) for call in calls)


def test_outage_and_empty_reference_are_not_zero_percent(owner, monkeypatch):
    peers = dataset([('e2e4', 2, 0, 1, 0)])
    def remote(source, fen, **filters):
        return deepcopy(peers if source == 'lichess' else dataset(status='rate_limited'))
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', remote)
    result = query(owner, {})
    assert result['moves'][0]['frequency'] == 100
    assert result['moves'][0]['master_frequency'] is None
    assert result['moves'][0]['master_total'] is None
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', lambda source, *a, **kw: deepcopy(peers if source == 'lichess' else dataset()))
    empty = query(owner, {})
    assert empty['masters']['status'] == 'ok'
    assert empty['moves'][0]['master_frequency'] is None
    assert empty['moves'][0]['master_total'] == 0


def test_stale_values_keep_their_status_and_primary_outage_keeps_reference(owner, monkeypatch):
    masters = dataset([('d2d4', 2, 2, 1, 0)], status='unavailable', stale=True)
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', lambda source, *a, **kw: deepcopy(dataset(status='unavailable') if source == 'lichess' else masters))
    result = query(owner, {})
    assert result['masters']['stale'] is True and result['masters']['status'] == 'unavailable'
    assert result['moves'][0]['frequency'] is None
    assert result['moves'][0]['master_frequency'] == 100


def test_same_master_source_is_queried_once_and_none_never_fetches(owner, monkeypatch):
    calls = []
    def remote(source, *args, **kwargs):
        calls.append(source)
        return dataset([('e2e4', 1, 1, 1, 0)])
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', remote)
    result = query(owner, {'source': 'masters'})
    assert calls == ['masters']
    assert result['moves'][0]['frequency'] == result['moves'][0]['master_frequency'] == 100
    query(owner, {'source': 'local', 'master_source': 'none'})
    assert calls == ['masters']


def test_real_local_bases_and_reference_preserve_unknown_results(owner):
    a = make_base(owner, 'Mes parties', '[White "A"]\n[Result "1-0"]\n\n1. e4 (1. c4) e5 1-0')
    b = make_base(owner, 'Cours', '[White "B"]\n[Result "*"]\n\n1. d4 d5 *')
    ref = make_base(owner, 'Ma sélection de maîtres', '[White "C"]\n[Result "1/2-1/2"]\n\n1. d4 Nf6 1/2-1/2')
    result = query(owner, {'source': 'local', 'base_ids': [a, b], 'master_source': 'local', 'master_base_ids': [ref]})
    assert result['primary']['total'] == 2
    assert result['masters']['total'] == 1
    assert {row['uci'] for row in result['moves']} == {'e2e4', 'd2d4'}
    d4 = next(row for row in result['moves'] if row['uci'] == 'd2d4')
    assert d4['unknown'] == 1 and d4['draws'] == 0
    assert d4['frequency'] == 50 and d4['master_frequency'] == 100
    board = chess.Board(); board.push_uci('e2e4')
    after = query(owner, {'source': 'local', 'base_ids': [a], 'master_source': 'none'}, board.fen())
    assert after['moves'][0]['san'] == 'e5'
    assert after['moves'][0]['white'] == 1 and after['moves'][0]['black'] == 0
    assert after['moves'][0]['master_frequency'] is None


def test_truncated_responses_do_not_invent_zero_percent(owner, monkeypatch):
    peers = dataset([('e2e4', 2, 0, 0, 0)])
    peers.update(total=5, white=5, complete=False)
    masters = dataset([('d2d4', 1, 0, 0, 0)])
    masters.update(total=10, white=10, complete=False)
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', lambda source, *a, **kw: deepcopy(peers if source == 'lichess' else masters))
    result = query(owner, {})
    e4, d4 = result['moves']
    assert e4['frequency'] == 40 and e4['master_frequency'] is None and e4['master_total'] is None
    assert d4['frequency'] is None and d4['master_frequency'] == 10


def test_missing_connection_never_calls_network_and_keeps_local_stats(owner, monkeypatch):
    monkeypatch.setattr(explorer.explorer_remote, '_transport', lambda *a, **kw: pytest.fail('Missing token must not issue a request'))
    missing = query(owner, {})
    assert missing['primary']['status'] == missing['masters']['status'] == 'auth_required'
    assert missing['moves'] == []
    base = make_base(owner, 'Local', '[White "Local"]\n\n1. e4 *')
    local = query(owner, {'source': 'local', 'base_ids': [base]})
    assert local['primary']['status'] == 'ok' and local['masters']['status'] == 'auth_required'
    assert local['moves'][0]['san'] == 'e4'
    assert local['moves'][0]['frequency'] == 100
    assert local['moves'][0]['master_frequency'] is None
