import io
import json
import sqlite3
import zipfile

import chess
import pytest
from local_test_client import TestClient

import app
import db
import pgnlib

PGN = '''[Event "Cours annoté"]
[Site "Local"]
[Date "2026.10.19"]
[White "Blanc"]
[Black "Noir"]
[Result "*"]
[TimeControl "600+5"]

1. e4 $1 {Un plan [%clk 0:10:00] [%eval 0.25]} (1. d4 d5 {Variante})
1... e5 {[%clk 0:09:58]} 2. Nf3 $5 {[%clk 0:09:40]} Nc6 {[%emt 0:00:12]} *
'''


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'chessgym.sqlite3')

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        yield client


@pytest.fixture
def owner(client):
    result = client.get('/api/status')
    assert result.status_code == 200, result.text
    return client


def make_base(owner, **settings):
    result = owner.post('/api/bases', json={'name': 'Cours', 'settings': settings})
    assert result.status_code == 200, result.text
    return result.json()['id']


def import_entry(owner, base, pgn=PGN):
    result = owner.post(f'/api/bases/{base}/import', json={'pgn': pgn})
    assert result.status_code == 200, result.text
    return owner.get(f'/api/bases/{base}/entries').json()['entries'][0]['id']


def test_local_profile_opens_without_credentials_or_session_cookie(client):
    response = client.get('/api/status')
    assert response.status_code == 200
    status = response.json()
    assert status['setup_required'] is False
    assert status['authenticated'] is True and status['local_mode'] is True
    assert status['username'] == 'local'
    assert 'set-cookie' not in response.headers
    assert client.get('/api/library').json() == {'folders': [], 'bases': []}
    client.cookies.clear()
    assert client.get('/api/library').status_code == 200
    with db.get_conn() as conn:
        assert [tuple(row) for row in conn.execute('SELECT id,username,password_hash FROM users')] == [(1, 'local', '')]
        assert conn.execute('SELECT COUNT(*) FROM sessions').fetchone()[0] == 0
    for route in ('setup', 'login', 'logout'):
        assert client.post('/api/' + route, json={'username': 'unused', 'password': 'UnusedPassword42'}).status_code == 404


def test_existing_owner_identity_and_migration_data_are_preserved(client):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users(id,username,password_hash,created_at) VALUES(1,'joueur','legacy-unread-hash','2026-01-01')")
        conn.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('historical-session',1,1)")
    assert client.get('/api/status').json()['username'] == 'joueur'
    assert client.get('/api/library').status_code == 200
    with db.get_conn() as conn:
        assert tuple(conn.execute('SELECT id,username,password_hash FROM users').fetchone()) == (1, 'joueur', 'legacy-unread-hash')
        assert conn.execute('SELECT token_hash FROM sessions').fetchone()[0] == 'historical-session'


def test_local_profile_rejects_remote_peer_and_host(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'remote.sqlite3')
    with TestClient(app.app, base_url='http://localhost', client=('192.0.2.4', 50000)) as remote:
        assert remote.get('/api/status').status_code == 403
        assert remote.get('/api/library').status_code == 403
    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as local:
        assert local.get('/api/status', headers={'Host': 'remote.invalid'}).status_code == 403
        assert local.get('/api/library', headers={'Host': 'remote.invalid'}).status_code == 403
        assert local.get('/api/status').json()['authenticated'] is True


def test_same_origin_and_json_protection(owner):
    assert owner.post('/api/bases', json={'name': 'No'}, headers={'Origin': 'https://malicious.example'}).status_code == 403
    assert owner.post('/api/bases', content='name=No', headers={'content-type': 'application/x-www-form-urlencoded'}).status_code == 415
    assert owner.post('/api/bases', json={'name': 'Yes'}, headers={'Origin': 'http://localhost'}).status_code == 200


def test_import_round_trip_preserves_tree_nags_clocks(owner):
    base = make_base(owner)
    entry_id = import_entry(owner, base)
    result = owner.get(f'/api/entries/{entry_id}').json()
    nodes = {node['path']: node for node in result['nodes']}
    assert nodes['']['children'] == ['0', '1']
    assert nodes['0']['nags'] == [1]
    assert nodes['0']['clock'] == 600
    assert nodes['0']['elapsed'] == 5
    assert nodes['0.0.0']['elapsed'] == 25
    assert nodes['0.0.0.0']['elapsed'] == 12
    assert nodes['1.0']['comment'] == 'Variante'
    exported = owner.get(f'/api/bases/{base}/export').text
    game = pgnlib.load_game(exported)
    assert game.headers['TimeControl'] == '600+5'
    assert '[%eval 0.25]' in game.variations[0].comment
    assert game.variations[1].move.uci() == 'd2d4'
    assert game.variations[0].nags == {1}


def test_duplicate_import_and_all_or_nothing(owner):
    base = make_base(owner)
    import_entry(owner, base)
    assert owner.post(f'/api/bases/{base}/import', json={'pgn': PGN}).json() == {'imported': 0, 'duplicates': 1, 'warnings': []}
    valid = '[Event "New"]\n\n1. d4 d5 *\n\n'
    invalid = '[Event "Broken"]\n\n1. e4 e5 2. Bh6 *'
    result = owner.post(f'/api/bases/{base}/import', json={'pgn': valid + invalid})
    assert result.status_code == 400
    assert len(owner.get(f'/api/bases/{base}/entries').json()['entries']) == 1
    assert owner.post(f'/api/bases/{base}/import', json={'pgn': '1. e4 garbage e5 *'}).status_code == 400
    assert owner.post(f'/api/bases/{base}/import', json={'pgn': '1. e4 (1. d4 d5 *'}).status_code == 400


def test_course_text_chapter_import_export_edit_and_duplicate(owner):
    base = make_base(owner)
    chapter = '[White "Introduction"]\n[PlyCount "1"]\n\n1. Z0 {Course introduction} *'
    source = chapter + '\n\n' + PGN
    response = owner.post(f'/api/bases/{base}/import', json={'pgn': source})
    assert response.status_code == 200, response.text
    assert response.json() == {'imported': 2, 'duplicates': 0, 'warnings': []}
    entries = owner.get(f'/api/bases/{base}/entries').json()['entries']
    introduction = next(entry for entry in entries if entry['headers']['White'] == 'Introduction')
    saved = owner.get(f"/api/entries/{introduction['id']}").json()
    root, = saved['nodes']
    assert root['path'] == '' and root['children'] == []
    assert root['comment'] == 'Course introduction'
    assert root['fen'] == chess.STARTING_FEN
    exported = owner.get(f'/api/bases/{base}/export').text
    games = pgnlib.parse_games(exported)
    assert len(games) == 2
    assert pgnlib.game_payload(games[1]) == pgnlib.game_payload(pgnlib.load_game(PGN))
    for repeated in (source, exported):
        assert owner.post(f'/api/bases/{base}/import', json={'pgn': repeated}).json() == {
            'imported': 0, 'duplicates': 2, 'warnings': [],
        }
    edited = owner.patch(f"/api/entries/{introduction['id']}/node", json={'explicit_save': True,
        'path': '', 'comment': 'My introduction notes',
    })
    assert edited.status_code == 200, edited.text
    assert edited.json()['nodes'][0]['comment'] == 'My introduction notes'
    assert pgnlib.load_game(edited.json()['pgn']).comment == 'My introduction notes'


def test_text_chapter_before_invalid_game_does_not_partially_import(owner):
    base = make_base(owner)
    source = '1. Z0 {Introduction} *\n\n[Event "Invalid"]\n\n1. e4 e5 2. Bh6 *'
    response = owner.post(f'/api/bases/{base}/import', json={'pgn': source})
    assert response.status_code == 400
    assert owner.get(f'/api/bases/{base}/entries').json()['entries'] == []


def test_comment_edit_preserves_machine_tags_and_variations(owner):
    base = make_base(owner)
    entry_id = import_entry(owner, base)
    result = owner.patch(f'/api/entries/{entry_id}/node', json={'explicit_save': True, 'path': '0', 'comment': 'Centre et espace', 'nags': [3, 14]})
    assert result.status_code == 200
    game = pgnlib.load_game(result.json()['pgn'])
    node = game.variations[0]
    assert node.comment == 'Centre et espace [%clk 0:10:00] [%eval 0.25]'
    assert node.nags == {3, 14}
    assert len(game.variations) == 2
    assert owner.patch(f'/api/entries/{entry_id}/node', json={'explicit_save': True, 'path': '0', 'comment': 'bad } injected'}).status_code == 400


@pytest.mark.parametrize(('path', 'tag', 'depth', 'cp', 'mate'), [
    ('', '[%eval 0.37,18]', 18, 37, None),
    ('0', '[%eval -0.62,24]', 24, -62, None),
    ('1.0', '[%eval #3,20]', 20, None, 3),
    ('1', '[%eval #-2,23]', 23, None, -2),
])
def test_position_evaluation_save_reload_and_annotation_without_game_report(owner, path, tag, depth, cp, mate):
    base = make_base(owner)
    entry_id = import_entry(owner, base, '''[Event "Position analysis"]

{Introduction} 1. e4 {Plan [%clk 0:10:00] [%cal Ge2e4]}
(1. d4 d5 {Variante}) 1... e5 *
''')
    original = owner.get(f'/api/entries/{entry_id}').json()
    game = pgnlib.load_game(original['pgn'])
    target = pgnlib.node_at(game, path)
    target.comment = ' '.join(value for value in (target.comment, tag) if value)
    expected_comment = target.comment
    response = owner.patch(f'/api/entries/{entry_id}', json={
        'explicit_save': True, 'expected_revision': original['revision'],
        'pgn': pgnlib.export_game(game), 'view_path': path,
    })
    assert response.status_code == 200, response.text

    # An isolated position result belongs to the PGN, independently of reports.
    reloaded = owner.get(f'/api/entries/{entry_id}').json()
    nodes = {node['path']: node for node in reloaded['nodes']}
    assert nodes[path]['comment'] == expected_comment
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone()[0] == 0
        saved = pgnlib.load_game(conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0])
    evaluation = pgnlib.node_at(saved, path)
    assert evaluation.eval_depth() == depth
    assert evaluation.eval().white().score() == cp
    assert evaluation.eval().white().mate() == mate

    # Later prose edits retain the evaluation and any unrelated machine tags.
    edited = owner.patch(f'/api/entries/{entry_id}/node', json={
        'explicit_save': True, 'expected_revision': reloaded['revision'],
        'path': path, 'comment': 'Nouvelle note',
    })
    assert edited.status_code == 200, edited.text
    fresh = owner.get(f'/api/entries/{entry_id}').json()
    expected_tags = pgnlib.MACHINE_TAG.findall(expected_comment)
    fresh_node = pgnlib.node_at(pgnlib.load_game(fresh['pgn']), path)
    assert fresh_node.comment == ' '.join(['Nouvelle note', *expected_tags])
    assert fresh_node.eval_depth() == depth
    assert fresh_node.eval().white().score() == cp
    assert fresh_node.eval().white().mate() == mate
    assert len(pgnlib.load_game(fresh['pgn']).variations) == 2


def test_add_move_appends_without_overwriting_and_save_is_durable(owner):
    base = make_base(owner)
    entry_id = import_entry(owner, base)
    result = owner.post(f'/api/entries/{entry_id}/move', json={'explicit_save': True, 'path': '0', 'uci': 'c7c5'})
    assert result.status_code == 200
    assert result.json()['path'] == '0.1'
    game = pgnlib.load_game(result.json()['entry']['pgn'])
    assert [n.move.uci() for n in game.variations[0].variations] == ['e7e5', 'c7c5']
    # Adding an existing variation selects it rather than duplicating content.
    owner.post(f'/api/entries/{entry_id}/move', json={'explicit_save': True, 'path': '0', 'uci': 'c7c5'})
    with db.get_conn() as fresh:
        saved = pgnlib.load_game(fresh.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0])
        assert len(saved.variations[0].variations) == 2
    assert owner.post(f'/api/entries/{entry_id}/move', json={'explicit_save': True, 'path': '0', 'uci': 'e7e4'}).status_code == 400


def test_folder_tags_settings_and_primary_exclusivity(owner):
    folder = owner.post('/api/folders', json={'name': 'Personnel'}).json()['id']
    base = owner.post('/api/bases', json={'name': 'Italienne', 'folder_id': folder, 'tags': ['Ouvertures', 'Blancs'], 'settings': {'is_repertoire': True, 'primary': True}}).json()['id']
    second = make_base(owner, is_repertoire=True, primary=True)
    black = make_base(owner, is_repertoire=True, primary=True, color='black')
    bases = {b['id']: b for b in owner.get('/api/library').json()['bases']}
    assert bases[base]['settings']['primary'] is False
    assert bases[second]['settings']['primary'] is True
    assert bases[black]['settings']['primary'] is True
    assert bases[base]['folder_id'] == folder
    assert owner.patch(f'/api/bases/{base}', json={'settings': {'skill': 21}}).status_code == 400
    assert owner.patch(f'/api/bases/{base}', json={'settings': {'engine': 'invented'}}).status_code == 400
    assert owner.patch(f'/api/bases/{base}', json={'settings': {'mode': 'probability'}}).status_code == 400


def test_position_save_paths_and_illegal_fen(owner):
    base = make_base(owner)
    fen = '4k3/8/8/8/8/8/R7/4K3 w - - 0 1'
    response = owner.post('/api/entries', json={'base_id': base, 'fen': fen, 'title': 'Tour'})
    assert response.status_code == 200, response.text
    entry = response.json()
    assert entry['headers']['SetUp'] == '1'
    assert entry['nodes'][0]['fen'] == fen
    assert owner.patch('/api/entries/' + str(entry['id']), json={'start_path': '0'}).status_code == 400
    assert owner.post('/api/board', json={'fen': '8/8/8/8/8/8/8/8 w - - 0 1'}).status_code == 400
    assert owner.post('/api/move', json={'fen': chess.STARTING_FEN, 'uci': 'e2e5'}).status_code == 400
    legal = owner.post('/api/move', json={'fen': chess.STARTING_FEN, 'uci': 'e2e4'})
    assert legal.json()['san'] == 'e4'
    assert 'e7e5' in legal.json()['legal_moves']


def test_elapsed_never_fabricated_for_missing_or_complex_clocks():
    for control in ('?', '40/7200:3600', '600+5'):
        game = pgnlib.load_game('[TimeControl "' + control + '"]\n\n1. e4 e5 2. Nf3 {[%clk 0:09:30]} *')
        assert pgnlib.game_payload(game)['nodes'][3]['elapsed'] is None
    game = pgnlib.load_game('[TimeControl "600"]\n\n1. e4 {[%emt 0:00:03.5]} *')
    assert pgnlib.game_payload(game)['nodes'][1]['elapsed'] == 3.5


def test_backup_contains_consistent_database_pgn_and_preferences(owner, tmp_path):
    base = make_base(owner, played=True)
    entry_id = import_entry(owner, base)
    owner.patch('/api/preferences', json={'theme': 'midnight'})
    response = owner.get('/api/backup')
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert f'pgn/base-{base}.pgn' in archive.namelist()
        assert len(pgnlib.parse_games(archive.read(f'pgn/base-{base}.pgn').decode())) == 1
        restored = sqlite3.connect(':memory:')
        restored.deserialize(archive.read('chessgym.sqlite3'))
        assert restored.execute('SELECT id FROM entries').fetchone()[0] == entry_id
        assert json.loads(restored.execute("SELECT value FROM preferences WHERE key='theme'").fetchone()[0]) == 'midnight'
        restored.close()
        archive.extract('chessgym.sqlite3', tmp_path / 'restored')
        disk = sqlite3.connect(tmp_path / 'restored' / 'chessgym.sqlite3')
        assert disk.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert disk.execute('SELECT id FROM entries').fetchone()[0] == entry_id
        assert disk.execute('SELECT count(*) FROM users').fetchone()[0] == 1
        disk.close()
    assert len(owner.get('/api/entries?played=true').json()['entries']) == 1
    owner.delete(f'/api/bases/{base}')
    assert owner.get('/api/entries').json()['entries'] == []


@pytest.mark.parametrize('bad', ['1. e4 {unfinished', '1. e4 e5 * trailing', '1. e4 ) *', '[Event "unterminated]\n1. e4 *'])
def test_strict_pgn_rejects_malformed_content(bad):
    with pytest.raises(ValueError):
        pgnlib.parse_games(bad)


def test_folder_rename_preserves_hierarchy_and_contents(owner):
    parent = owner.post('/api/folders', json={'name': 'Étude'}).json()['id']
    folder = owner.post('/api/folders', json={'name': 'Personnel', 'parent_id': parent}).json()['id']
    child = owner.post('/api/folders', json={'name': 'Archives', 'parent_id': folder}).json()
    base = owner.post('/api/bases', json={'name': 'Mes parties', 'folder_id': folder}).json()['id']
    entry = import_entry(owner, base)
    with db.get_conn() as conn:
        original_entry = dict(conn.execute('SELECT * FROM entries WHERE id=?', (entry,)).fetchone())
        original_base = dict(conn.execute('SELECT * FROM bases WHERE id=?', (base,)).fetchone())
    response = owner.patch(f'/api/folders/{folder}', json={'name': '  Parties et cours  '})
    assert response.status_code == 200, response.text
    assert response.json() == {'id': folder, 'name': 'Parties et cours', 'parent_id': parent}
    library = owner.get('/api/library').json()
    folders = {item['id']: item for item in library['folders']}
    assert folders[folder] == response.json()
    assert folders[child['id']] == child
    with db.get_conn() as conn:
        assert dict(conn.execute('SELECT * FROM entries WHERE id=?', (entry,)).fetchone()) == original_entry
        assert dict(conn.execute('SELECT * FROM bases WHERE id=?', (base,)).fetchone()) == original_base
    # A root folder keeps its root status as well.
    assert owner.patch(f'/api/folders/{parent}', json={'name': 'Bibliothèque'}).json()['parent_id'] is None


def test_folder_rename_is_private_and_unknown_folder_is_not_created(owner):
    assert owner.patch('/api/folders/999999', json={'name': 'Absent'}).status_code == 404
    assert owner.get('/api/library').json()['folders'] == []
    folder = owner.post('/api/folders', json={'name': 'Personnel'}).json()['id']
    owner.cookies.clear()
    assert owner.patch(f'/api/folders/{folder}', json={'name': 'Autre'}, headers={'Host': 'remote.invalid'}).status_code == 403
    with db.get_conn() as conn:
        assert conn.execute('SELECT name FROM folders WHERE id=?', (folder,)).fetchone()[0] == 'Personnel'


@pytest.mark.parametrize('payload', [{}, {'name': ''}, {'name': '  '}, {'name': None}, {'name': 12}, {'name': 'x' * 201}, {'name': 'Autre', 'parent_id': None}])
def test_folder_rename_rejects_invalid_name_or_other_changes(owner, payload):
    folder = owner.post('/api/folders', json={'name': 'Personnel'}).json()
    assert owner.patch(f"/api/folders/{folder['id']}", json=payload).status_code == 400
    assert owner.get('/api/library').json()['folders'] == [folder]
