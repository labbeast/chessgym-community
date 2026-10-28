"""Metadata and full-line editing must preserve saved study content atomically."""
import json

import chess
import pytest
from local_test_client import TestClient

import app
import db
import pgnlib

ANNOTATED = r'''[Event "Cours"]
[Site "Local"]
[Date "2026.10.19"]
[Round "?"]
[White "Alice"]
[Black "Bob"]
[Result "*"]
[TimeControl "600+5"]
[Source "Collection personnelle"]

{Note initiale}
1. e4 $1 $22 {Idée [%clk 0:09:59] [%eval 0.24,18]}
({Départ alternatif} 1. d4 d5 (1... Nf6 $5))
1... e5 {[%clk 0:09:58]} 2. Nf3 $6 {[%emt 0:00:12]} *
'''


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'metadata.sqlite3')

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        result = client.get('/api/status')
        assert result.status_code == 200, result.text
        yield client


def saved(owner, title=None, pgn=ANNOTATED):
    base_id = owner.post('/api/bases', json={'name': 'Metadata test'}).json()['id']
    payload = {'base_id': base_id, 'pgn': pgn, 'start_path': '0'}
    if title is not None:
        payload['title'] = title
    result = owner.post('/api/entries', json=payload)
    assert result.status_code == 200, result.text
    return result.json()


def test_metadata_patch_preserves_complete_tree_and_custom_headers(owner):
    old = saved(owner)
    patch = {'White': 'Renée "La Tour"', 'WhiteElo': '1720', 'BlackElo': '1690', 'Opening': 'Italienne', 'ECO': 'C50', 'Source-File': r'C:\PGN\"Mes cours"', 'Result': '1-0'}
    response = owner.patch('/api/entries/'+str(old['id']), json={'headers': patch})
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated['nodes'] == old['nodes']
    assert updated['start_path'] == '0'
    assert updated['headers'] == {**old['headers'], **patch}
    assert updated['title'] == 'Renée "La Tour" — Bob'
    assert updated['pgn'].endswith('1-0')
    # Read through another DB connection and repeat parse/export: escaping must
    # not accumulate on repeated visits or lose either quotes or backslashes.
    with db.get_conn() as conn:
        persisted = conn.execute('SELECT pgn FROM entries WHERE id=?', (old['id'],)).fetchone()[0]
    for _ in range(4):
        parsed = pgnlib.load_game(persisted)
        assert dict(parsed.headers) == updated['headers']
        persisted = pgnlib.export_game(parsed)
    assert owner.get('/api/entries/'+str(old['id'])).json()['nodes'] == old['nodes']


def test_custom_title_and_unknown_headers_remain_untouched(owner):
    old = saved(owner, title='Mon exercice')
    response = owner.patch('/api/entries/'+str(old['id']), json={'headers': {'Black': 'Claire', 'Source': None, 'WhiteElo': '1733'}})
    assert response.status_code == 200, response.text
    updated = response.json()
    assert updated['title'] == 'Mon exercice'
    assert 'Source' not in updated['headers']
    assert updated['headers']['Event'] == 'Cours'
    cleared = owner.patch('/api/entries/'+str(old['id']), json={'headers': {'White': None, 'Result': ''}}).json()
    assert cleared['headers']['White'] == '?'
    assert cleared['headers']['Result'] == '*'


@pytest.mark.parametrize('patch', [
    {'White': 'New', 'FEN': chess.STARTING_FEN}, {'SetUp': '0'}, {'Variant': 'Chess960'},
    {'White': 'New', 'Event': 'Injected\n[Result "1-0"]'}, {'WhiteElo': 'not-a-rating'},
    {'Date': '2026.19.01'}, {'Date': '2026-10-19'}, {'Result': 'White wins'},
    {'ECO': 'Z00'}, {'TimeControl': '10 minutes'}, {'Bad Tag': 'text'}, {'Site': 42},
])
def test_invalid_metadata_is_atomic(owner, patch):
    old = saved(owner)
    response = owner.patch('/api/entries/'+str(old['id']), json={'title': 'Should not be saved', 'headers': patch})
    assert response.status_code == 400, response.text
    assert owner.get('/api/entries/'+str(old['id'])).json() == old


def test_free_analysis_headers_same_validation_and_preservation(owner):
    original = owner.post('/api/board', json={'pgn': ANNOTATED}).json()
    result = owner.post('/api/board', json={'pgn': ANNOTATED, 'headers': {'Event': 'Étude "B"', 'Date': '????.10.??', 'TimeControl': '40/7200:3600'}})
    assert result.status_code == 200, result.text
    assert result.json()['headers']['Event'] == 'Étude "B"'
    # TimeControl can change elapsed estimates. Explicit time/comment stays exact.
    original_nodes = original['nodes']
    changed_nodes = result.json()['nodes']
    for old, new in zip(original_nodes, changed_nodes):
        assert {k:v for k,v in old.items() if k!='elapsed'} == {k:v for k,v in new.items() if k!='elapsed'}
    assert owner.post('/api/board', json={'pgn': ANNOTATED, 'headers': {'FEN': chess.STARTING_FEN}}).status_code == 400


def test_preview_line_is_legal_complete_and_does_not_modify_entries(owner):
    entry = saved(owner)
    result = owner.post('/api/line', json={'fen': chess.STARTING_FEN, 'moves': ['e2e4','e7e5','g1f3']})
    assert result.status_code == 200, result.text
    positions = result.json()['positions']
    assert [x['san'] for x in positions] == ['e4','e5','Nf3']
    board = chess.Board()
    for position in positions:
        board.push_uci(position['uci'])
        assert position['fen'] == board.fen()
        assert position['game_over'] is False
    assert owner.get('/api/entries/'+str(entry['id'])).json() == entry
    for moves in (['e2e4','e7e4'], [], ['a'] * 201, 'e2e4'):
        assert owner.post('/api/line', json={'fen': chess.STARTING_FEN, 'moves': moves}).status_code == 400


def test_saved_line_reuses_prefix_and_appends_variation_atomically(owner):
    old = saved(owner)
    url = '/api/entries/'+str(old['id'])+'/line'
    result = owner.post(url, json={'explicit_save': True, 'path':'', 'moves':['e2e4','e7e5','b1c3','g8f6']})
    assert result.status_code == 200, result.text
    entry = result.json()['entry']
    assert result.json()['path'] == '0.0.1.0'
    assert entry['start_path'] == old['start_path']
    updated_nodes = {n['path']: n for n in entry['nodes']}
    for node in old['nodes']:
        assert {k:v for k,v in updated_nodes[node['path']].items() if k!='children'} == {k:v for k,v in node.items() if k!='children'}
    assert updated_nodes['0.0']['children'] == ['0.0.0','0.0.1']
    assert owner.post(url, json={'explicit_save': True, 'path':'', 'moves':['e2e4','e7e5','b1c3','g8f6']}).json()['entry']['nodes'] == entry['nodes']
    before = owner.get('/api/entries/'+str(old['id'])).json()
    assert owner.post(url, json={'explicit_save': True, 'path':'0', 'moves':['c7c5','e2e5']}).status_code == 400
    assert owner.get('/api/entries/'+str(old['id'])).json() == before


def test_appearance_defaults_partial_updates_and_atomic_validation(owner):
    workspace_epoch = owner.get('/api/status').json()['workspace_epoch']
    assert isinstance(workspace_epoch, str) and len(workspace_epoch) == 32
    expected = {
        'workspace_epoch': workspace_epoch,
        'theme': 'copper', 'piece_set': 'cburnett', 'board_theme': 'brown',
        'language': 'fr', 'font_scale': 100, 'auto_mastery_days': 180,
        'review_defaults': {'again': 10, 'hard': 2, 'medium': 5, 'easy': 10, 'new_limit': None},
        'review_multipliers': {'hard': 1.2, 'medium': 2, 'easy': 3},
        'review_maintenance': {'enabled': True, 'interval_days': 30, 'daily_limit': 5},
            'review_session_defaults': {'minutes': None, 'cards': None},
            'study_day': {'timezone': 'UTC', 'start_hour': 0},
        'sound': {'enabled': True, 'volume': .35, 'moves': True, 'feedback': True, 'navigation': False},
    }
    assert owner.get('/api/preferences').json() == expected
    for key, value in [('theme','midnight'), ('piece_set','merida'), ('board_theme','blue'), ('piece_set','chessnut')]:
        expected[key] = value
        result = owner.patch('/api/preferences', json={key:value})
        assert result.status_code == 200, result.text
        assert result.json() == expected
    assert owner.patch('/api/preferences', json={'theme':'sage','piece_set':'invented'}).status_code == 400
    assert owner.get('/api/preferences').json() == expected
    with db.get_conn() as conn:
        persisted = {r['key']: json.loads(r['value']) for r in conn.execute('SELECT * FROM preferences')}
    # Untouched appearance defaults are not stored; the local workspace identity
    # created on first access survives every appearance update unchanged.
    assert persisted == {key: expected[key] for key in ('theme', 'piece_set', 'board_theme', 'workspace_epoch')}


def test_browser_serializer_roundtrip_for_escaped_header_values():
    from test_frontend_pgn import _serialize
    game = pgnlib.load_game(ANNOTATED)
    pgnlib.patch_headers(game, {'White': 'Renée "La Tour"', 'Source-File': r'C:\PGN\"Cours"'})
    original = pgnlib.game_payload(game)
    for _ in range(3):
        restored = pgnlib.game_payload(pgnlib.load_game(_serialize(original)))
        assert restored['headers'] == original['headers']
        assert restored['nodes'] == original['nodes']
        original = restored
