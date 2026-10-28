"""Population filters remain independent across explorer sources and caches."""
from copy import deepcopy
import json
import sqlite3
from urllib.parse import parse_qs, urlsplit

import chess
import pytest
from local_test_client import TestClient

import app
import db
import explorer
import explorer_cache
import explorer_local
import explorer_remote
import reference_library
import reference_store


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'filter-tests.sqlite3')
    monkeypatch.setattr(app.jobs, 'start_worker', lambda: None)
    monkeypatch.delenv('CHESSGYM_LICHESS_TOKEN', raising=False)
    monkeypatch.setattr(explorer_remote, '_transport', lambda *a: pytest.fail('Unexpected network'))
    monkeypatch.setattr(explorer_cache, 'CACHE_PATH', tmp_path / 'remote-cache.sqlite3')
    monkeypatch.setattr(explorer_remote, 'MIN_REQUEST_INTERVAL', 0)
    monkeypatch.setattr(explorer_remote, '_store_context', None)
    monkeypatch.setattr(explorer_remote, '_next_request_at', 0)
    monkeypatch.setattr(explorer_remote, '_blocked_until', 0)
    explorer_remote._cache.clear()
    explorer_remote._auth_failures.clear()
    explorer_local.clear_cache()

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 51002)) as client:
        response = client.get('/api/status')
        assert response.status_code == 200, response.text
        yield client
    explorer_local.clear_cache()
    explorer_remote._cache.clear()


def pgn(name, moves='1. e4 e5', result='1-0', elo=1800, black_elo=None, control='600+0'):
    headers = [f'[Event "Filter fixture"]', f'[White "{name}"]', '[Black "Opponent"]',
               '[Date "2025.01.01"]', f'[Result "{result}"]']
    if elo is not None:
        headers += [f'[WhiteElo "{elo}"]', f'[BlackElo "{elo if black_elo is None else black_elo}"]']
    if control is not None:
        headers.append(f'[TimeControl "{control}"]')
    return '\n'.join(headers) + '\n\n' + moves + ' ' + result


def study(owner, *games):
    response = owner.post('/api/bases', json={'name': 'Study fixtures'})
    assert response.status_code == 200
    base_id = response.json()['id']
    for text in games:
        response = owner.post('/api/entries', json={'base_id': base_id, 'pgn': text})
        assert response.status_code == 200, response.text
    return base_id


def reference(owner, tmp_path, monkeypatch, games):
    source = tmp_path / 'reference-source.pgn'
    source.write_text('\n\n'.join(games), encoding='utf-8')

    def synchronously_import(base_id):
        row = reference_library.require_reference(base_id)
        reference_store.import_file(reference_library.store_path(row['storage_key']), row['source'])
        return reference_library.get_status(base_id)

    monkeypatch.setattr(reference_library, 'start_import', synchronously_import)
    response = owner.post('/api/reference-bases', json={'name': 'Reference fixtures', 'path': str(source)})
    assert response.status_code == 200, response.text
    return response.json()['id'], source


def query(owner, settings, fen=chess.STARTING_FEN):
    response = owner.post('/api/explorer', json={'fen': fen, 'settings': settings})
    assert response.status_code == 200, response.text
    return response.json()


def test_legacy_settings_receive_independent_new_defaults(owner):
    legacy = {'source': 'lichess', 'base_ids': [], 'ratings': [2000], 'speeds': ['blitz'],
              'master_source': 'masters', 'master_base_ids': [], 'engine_depth': 18,
              'repertoire_color': 'black', 'show_probability': False}
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences(key,value) VALUES(?,?)', (explorer.SETTINGS_KEY, json.dumps(legacy)))
    settings = owner.get('/api/explorer/settings').json()
    assert all(settings[key] == value for key, value in legacy.items())
    assert settings['local_filters'] == settings['master_local_filters'] == {
        'rating_min': None, 'rating_max': None, 'speeds': []}
    assert settings['master_ratings'] == [1600, 1800]
    assert settings['master_speeds'] == ['rapid']
    updated = owner.patch('/api/explorer/settings', json={'local_filters': {'rating_min': 1800}})
    assert updated.status_code == 200, updated.text
    assert updated.json()['local_filters']['rating_min'] == 1800
    assert updated.json()['master_local_filters']['rating_min'] is None


def test_nested_partial_patch_preserves_other_side_and_existing_bounds(owner):
    initial = {
        'local_filters': {'rating_min': 1600, 'rating_max': 2000, 'speeds': ['rapid', 'blitz']},
        'master_local_filters': {'rating_min': 2300, 'rating_max': 2800, 'speeds': ['classical']},
        'master_source': 'lichess', 'master_ratings': [2200, 2000], 'master_speeds': ['classical', 'rapid'],
    }
    response = owner.patch('/api/explorer/settings', json=initial)
    assert response.status_code == 200, response.text
    original = response.json()
    response = owner.patch('/api/explorer/settings', json={
        'local_filters': {'rating_min': 1750}, 'master_local_filters': {'rating_max': None}})
    assert response.status_code == 200, response.text
    saved = response.json()
    assert saved['local_filters'] == {'rating_min': 1750, 'rating_max': 2000, 'speeds': ['blitz', 'rapid']}
    assert saved['master_local_filters'] == {'rating_min': 2300, 'rating_max': None, 'speeds': ['classical']}
    for field in ('ratings', 'speeds', 'master_ratings', 'master_speeds', 'master_source'):
        assert saved[field] == original[field]
    assert owner.get('/api/explorer/settings').json() == saved
    cleared = owner.patch('/api/explorer/settings', json={'local_filters': {'rating_min': None, 'speeds': []}}).json()
    assert cleared['local_filters'] == {'rating_min': None, 'rating_max': 2000, 'speeds': []}
    assert cleared['master_local_filters'] == saved['master_local_filters']


@pytest.mark.parametrize('field', ['local_filters', 'master_local_filters'])
@pytest.mark.parametrize('invalid', [
    None, [], 'rapid', {'extra': 1}, {'rating_min': True}, {'rating_max': False},
    {'rating_min': -1}, {'rating_max': 4001}, {'rating_min': 1800.5}, {'rating_max': '2000'},
    {'rating_min': 2000, 'rating_max': 1800}, {'speeds': None}, {'speeds': 'rapid'},
    {'speeds': ['fast']}, {'speeds': [True]}, {'speeds': [None]},
])
def test_invalid_nested_settings_rejected_atomically(owner, field, invalid):
    before = owner.get('/api/explorer/settings').json()
    patch = {field: invalid, 'master_ratings': [2200], 'repertoire_color': 'black'}
    response = owner.patch('/api/explorer/settings', json=patch)
    assert response.status_code == 400, response.text
    assert owner.get('/api/explorer/settings').json() == before
    response = owner.post('/api/explorer', json={'fen': chess.STARTING_FEN, 'settings': patch})
    assert response.status_code == 400, response.text
    assert owner.get('/api/explorer/settings').json() == before


@pytest.mark.parametrize('patch', [
    {'master_ratings': []}, {'master_ratings': [True]}, {'master_ratings': [1700]},
    {'master_speeds': []}, {'master_speeds': ['unknown']}, {'master_speeds': [False]},
])
def test_invalid_comparison_lichess_profile_is_atomic(owner, patch):
    before = owner.get('/api/explorer/settings').json()
    response = owner.patch('/api/explorer/settings', json={**patch, 'master_source': 'lichess'})
    assert response.status_code == 400, response.text
    assert owner.get('/api/explorer/settings').json() == before


def test_local_zero_and_upper_bound_unknown_speed_and_empty_all_are_valid(owner):
    response = owner.patch('/api/explorer/settings', json={
        'local_filters': {'rating_min': 0, 'rating_max': 4000, 'speeds': ['unknown', 'rapid', 'rapid']},
        'master_local_filters': {'rating_min': None, 'rating_max': None, 'speeds': []}})
    assert response.status_code == 200, response.text
    assert response.json()['local_filters'] == {'rating_min': 0, 'rating_max': 4000, 'speeds': ['rapid', 'unknown']}
    assert response.json()['master_local_filters']['speeds'] == []


def test_same_local_base_different_profiles_get_independent_real_counts(owner, monkeypatch):
    base_id = study(owner, pgn('Low rapid'), pgn('High blitz', '1. d4 d5', result='0-1', elo=2400, control='180+0'))
    calls = []
    real = explorer_local.local_data

    def track(fen, ids, **filters):
        calls.append(deepcopy(filters))
        return real(fen, ids, **filters)

    monkeypatch.setattr(explorer_local, 'local_data', track)
    data = query(owner, {
        'source': 'local', 'base_ids': [base_id], 'master_source': 'local', 'master_base_ids': [base_id],
        'local_filters': {'rating_min': 1700, 'rating_max': 1900, 'speeds': ['rapid']},
        'master_local_filters': {'rating_min': 2300, 'rating_max': 2500, 'speeds': ['blitz']},
    })
    assert len(calls) == 2 and calls[0] != calls[1]
    assert data['primary']['total'] == data['masters']['total'] == 1
    rows = {row['uci']: row for row in data['moves']}
    assert rows['e2e4']['frequency'] == 100 and rows['e2e4']['master_frequency'] == 0
    assert rows['d2d4']['frequency'] == 0 and rows['d2d4']['master_frequency'] == 100


def test_same_effective_local_filters_reuse_one_dataset_after_normalization(owner, monkeypatch):
    base_id = study(owner, pgn('Rapid'), pgn('Blitz', '1. d4 d5', control='180+0'))
    calls = []
    real = explorer_local.local_data

    def track(fen, ids, **filters):
        calls.append(deepcopy(filters))
        return real(fen, ids, **filters)

    monkeypatch.setattr(explorer_local, 'local_data', track)
    data = query(owner, {
        'source': 'local', 'base_ids': [base_id], 'master_source': 'local', 'master_base_ids': [base_id, base_id],
        'local_filters': {'speeds': ['rapid', 'blitz']},
        'master_local_filters': {'speeds': ['blitz', 'rapid']},
        'ratings': [1600], 'master_ratings': [2500], 'speeds': ['bullet'], 'master_speeds': ['classical'],
    })
    assert len(calls) == 1
    assert data['primary']['total'] == data['masters']['total'] == 2


def test_two_lichess_profiles_use_separate_remote_queries_and_persistent_cache(owner, monkeypatch):
    monkeypatch.setattr(explorer.explorer_credentials, 'get_token', lambda: 'synthetic_filter_token')
    calls = []

    def transport(url, token):
        params = parse_qs(urlsplit(url).query)
        population = (params['ratings'][0], params['speeds'][0])
        calls.append(population)
        uci = 'e2e4' if population == ('1600,1800', 'rapid') else 'd2d4'
        return 200, {}, json.dumps({'white': 4, 'draws': 1, 'black': 5,
            'moves': [{'uci': uci, 'white': 4, 'draws': 1, 'black': 5}]}).encode()

    monkeypatch.setattr(explorer_remote, '_transport', transport)
    settings = {'source': 'lichess', 'ratings': [1800, 1600], 'speeds': ['rapid'],
                'master_source': 'lichess', 'master_ratings': [2200], 'master_speeds': ['blitz']}
    data = query(owner, settings)
    assert calls == [('1600,1800', 'rapid'), ('2200', 'blitz')]
    assert data['primary']['moves'][0]['uci'] == 'e2e4'
    assert data['masters']['moves'][0]['uci'] == 'd2d4'
    second = query(owner, settings)
    assert second['primary']['cached'] and second['masters']['cached']
    assert len(calls) == 2
    explorer_remote._cache.clear()
    third = query(owner, settings)
    assert third['primary']['cached'] and third['masters']['cached']
    assert len(calls) == 2
    with sqlite3.connect(explorer_cache.cache_path()) as conn:
        assert conn.execute('SELECT COUNT(DISTINCT query_key) FROM statistics').fetchone()[0] == 2
    equivalent = query(owner, {**settings, 'master_ratings': [1600, 1800], 'master_speeds': ['rapid']})
    assert equivalent['primary']['moves'] == equivalent['masters']['moves']
    assert len(calls) == 2


def test_actual_study_reference_mix_filters_before_duplicate_exclusion(owner, tmp_path, monkeypatch):
    original = pgn('Shared game')
    source_games = [original, pgn('Blitz', '1. d4 d5', result='0-1', control='180+0'),
                    pgn('Master', '1. c4 e5', result='1/2-1/2', elo=2400, control='1800+0'),
                    pgn('Unknown', '1. Nf3 d5', result='*', elo=None, control=None),
                    pgn('Mixed ratings', '1. b3 e5', black_elo=2200),
                    pgn('Unknown cadence', '1. g3 d5', control=None)]
    reference_id, source = reference(owner, tmp_path, monkeypatch, source_games)
    source_before = source.read_bytes()
    study_id = study(owner, original.replace('1800', '2500').replace('1. e4', '1. e4 {Personal note}'),
                     pgn('Personal rapid', '1. f4 d5', result='*'),
                     pgn('Personal bullet', '1. e3 d5', result='1/2-1/2', control='60+0'))
    settings_before = owner.get('/api/explorer/settings').json()
    with db.get_conn() as conn:
        study_before = [row['pgn'] for row in conn.execute('SELECT pgn FROM entries ORDER BY id')]
    base_settings = {'source': 'local', 'base_ids': [reference_id, study_id],
                     'master_source': 'local', 'master_base_ids': [reference_id, study_id]}
    data = query(owner, {**base_settings,
        'local_filters': {'rating_min': 1700, 'rating_max': 1900, 'speeds': ['rapid', 'blitz']},
        'master_local_filters': {'rating_min': 2300, 'rating_max': 2600, 'speeds': []}})
    assert data['primary']['total'] == 3
    assert {row['uci'] for row in data['primary']['moves']} == {'e2e4', 'd2d4', 'f2f4'}
    assert (data['primary']['white'], data['primary']['black'], data['primary']['unknown']) == (1, 1, 1)
    assert data['masters']['total'] == 2
    assert {row['uci'] for row in data['masters']['moves']} == {'e2e4', 'c2c4'}
    unknown = query(owner, {**base_settings, 'master_source': 'none', 'local_filters': {'speeds': ['unknown']}})
    assert unknown['primary']['total'] == 2
    assert {row['uci'] for row in unknown['primary']['moves']} == {'g1f3', 'g2g3'}
    unfiltered = query(owner, {**base_settings, 'master_source': 'none', 'local_filters': {'speeds': []}})
    assert unfiltered['primary']['total'] == 8
    repeated = query(owner, {**base_settings, 'master_source': 'none',
        'local_filters': {'rating_min': 1700, 'rating_max': 1900, 'speeds': ['rapid', 'blitz']}})
    assert repeated['primary']['moves'] == data['primary']['moves']
    assert source.read_bytes() == source_before
    assert owner.get('/api/explorer/settings').json() == settings_before
    with db.get_conn() as conn:
        assert [row['pgn'] for row in conn.execute('SELECT pgn FROM entries ORDER BY id')] == study_before
