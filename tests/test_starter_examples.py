"""The opt-in starter pack preserves personal content and opens real tools."""
from concurrent.futures import ThreadPoolExecutor
import json

import pytest

import db
import demo
import pgnlib
from test_integration import client, payload


def test_status_is_read_only_and_pack_is_explicit(client):
    before = payload(client.get('/api/demo'))
    assert before['installed'] is False and before['bases'] == []
    assert {item['key'] for item in before['examples']} == {'repertoire', 'guess', 'reading'}
    assert payload(client.get('/api/library')) == {'folders': [], 'bases': []}
    first = payload(client.post('/api/demo', json={}))
    assert first['installed'] and first['license'] == 'CC0-1.0'
    assert payload(client.get('/api/demo')) == first
    assert payload(client.post('/api/demo', json={})) == first
    client.cookies.clear()
    assert payload(client.get('/api/demo')) == first
    assert client.get('/api/demo', headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.post('/api/demo', json={}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert payload(client.get('/api/demo')) == first


def test_pack_opens_guess_reading_and_repertoire(client):
    pack = payload(client.post('/api/demo', json={}))
    ids = {item['key']: item['base_id'] for item in pack['examples']}
    library = payload(client.get('/api/library'))['bases']
    assert next(b for b in library if b['id'] == ids['repertoire'])['settings']['is_repertoire']
    assert next(b for b in library if b['id'] == ids['reading'])['settings']['reading_enabled']
    assert next(b for b in library if b['id'] == ids['guess'])['settings']['guess_enabled']
    entry = payload(client.get(f"/api/bases/{ids['guess']}/entries"))['entries'][0]
    started = payload(client.post('/api/guess-move/sessions', json={'entry_id': entry['id'], 'side': 'white'}))
    assert not started['completed'] and started['path'] == ''
    for base_id in pack['bases']:
        games = pgnlib.parse_games(client.get(f'/api/bases/{base_id}/export').text)
        for game in games:
            assert not game.errors and game.board().is_valid()
            assert game.headers['License'] == 'CC0-1.0'
            assert game.headers['Source'] == 'Original teaching example'
            board = game.board()
            for move in game.mainline_moves():
                assert move in board.legal_moves
                board.push(move)


def test_retry_restores_only_missing_bases_and_keeps_edits(client):
    pack = payload(client.post('/api/demo', json={}))
    kept, removed = pack['bases'][:2]
    entry = payload(client.get(f'/api/bases/{kept}/entries'))['entries'][0]
    payload(client.patch(f'/api/bases/{kept}', json={'name': 'Mon répertoire personnel'}))
    edited = payload(client.patch(f"/api/entries/{entry['id']}/node", json={
        'explicit_save': True, 'path': '', 'comment': 'Mes notes à conserver'}))
    payload(client.delete(f'/api/bases/{removed}'))
    assert not payload(client.get('/api/demo'))['installed']
    restored = payload(client.post('/api/demo', json={}))
    assert restored['installed'] and len(restored['bases']) == 3
    assert payload(client.get(f"/api/entries/{entry['id']}"))['pgn'] == edited['pgn']
    assert next(item for item in restored['examples'] if item['base_id'] == kept)['name'] == 'Mon répertoire personnel'
    assert len(payload(client.get('/api/library'))['folders']) == 1


def test_deleted_base_id_reused_by_personal_base_is_not_an_example(client):
    pack = payload(client.post('/api/demo', json={}))
    removed = max(pack['bases'])
    payload(client.delete(f'/api/bases/{removed}'))
    personal = payload(client.post('/api/bases', json={'name': 'Mes parties'}))
    assert personal['id'] == removed  # SQLite bases intentionally reuse IDs.
    assert not payload(client.get('/api/demo'))['installed']
    restored = payload(client.post('/api/demo', json={}))
    assert personal['id'] not in restored['bases']
    assert len(payload(client.get('/api/library'))['bases']) == 4


def test_old_examples_and_preferences_are_preserved(client):
    old = payload(client.post('/api/bases', json={'name': 'Ancien exemple modifié'}))
    with db.get_conn() as conn:
        conn.execute("INSERT INTO preferences(key,value) VALUES ('demo_created',?)", (json.dumps([old['id']]),))
    new = payload(client.post('/api/demo', json={}))
    assert old['id'] not in new['bases']
    assert len(payload(client.get('/api/library'))['bases']) == 4
    with db.get_conn() as conn:
        assert json.loads(conn.execute("SELECT value FROM preferences WHERE key='demo_created'").fetchone()[0]) == [old['id']]


def test_disabled_mode_stays_disabled_on_retry(client):
    pack = payload(client.post('/api/demo', json={}))
    reading = next(item for item in pack['examples'] if item['mode'] == 'reading')
    assert reading['mode_enabled']
    payload(client.patch(f"/api/bases/{reading['base_id']}", json={'settings': {'reading_enabled': False}}))
    for result in (payload(client.get('/api/demo')), payload(client.post('/api/demo', json={}))):
        saved = next(item for item in result['examples'] if item['mode'] == 'reading')
        assert saved['installed'] and not saved['mode_enabled']


def test_simultaneous_adds_commit_one_pack(client):
    with ThreadPoolExecutor(max_workers=2) as workers:
        results = list(workers.map(lambda _: demo.create_examples(), range(2)))
    assert results[0] == results[1]
    assert len(payload(client.get('/api/library'))['bases']) == 3


def test_failed_pack_rolls_back_every_base(client, monkeypatch):
    original = pgnlib.load_game
    calls = []
    def fail_second(text):
        calls.append(text)
        if len(calls) == 2:
            raise ValueError('Invalid bundled example')
        return original(text)
    monkeypatch.setattr(pgnlib, 'load_game', fail_second)
    with pytest.raises(ValueError):
        demo.create_examples()
    assert payload(client.get('/api/library')) == {'folders': [], 'bases': []}
    assert not payload(client.get('/api/demo'))['installed']
