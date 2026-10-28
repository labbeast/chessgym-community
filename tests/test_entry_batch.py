"""Atomic library batches preserve documents and their dependent review state."""
import json

import pytest
from local_test_client import TestClient

import app
import entries_api
import db
import jobs
import game_analysis
import training

PGN = '''[Event "Cours annoté"]
[White "Blanc"]
[Black "Noir"]
[WhiteElo "1700"]
[BlackElo "1800"]
[Result "*"]
[TimeControl "600+5"]

1. e4 $1 {Un plan [%clk 0:10:00] [%eval 0.25]} (1. d4 d5 {Variante})
1... e5 2. Nf3 $5 {[%clk 0:09:40]} Nc6 *
'''


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'batches.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as browser:
        yield browser


@pytest.fixture
def owner(client):
    ok(client.get('/api/status'))
    return client


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def make_base(owner, name='Cours', **settings):
    return ok(owner.post('/api/bases', json={'name': name, 'settings': {'review_enabled': True, **settings}}))['id']


def entry(owner, base, **options):
    return ok(owner.post('/api/entries', json={'base_id': base, 'pgn': PGN, 'title': 'Exercice complet', 'start_path': '0', **options}))


def batch(owner, base, action, ids, **options):
    return owner.post(f'/api/bases/{base}/entries/batch', json={'action': action, 'entry_ids': ids, **options})


def snapshot():
    with db.get_conn() as conn:
        return [dict(row) for row in conn.execute('SELECT * FROM entries ORDER BY id')]


def cards(owner, base):
    return ok(owner.get(f'/api/bases/{base}/queue?all=true'))['cards']


def grade(owner, card):
    ok(owner.post(f'/api/reviews/{card["id"]}/grade', json={'grade': 2}))


def test_batch_requires_account_and_same_origin(client, owner):
    base = make_base(owner)
    saved = entry(owner, base)
    route = f'/api/bases/{base}/entries/batch'
    payload = {'action': 'delete', 'entry_ids': [saved['id']]}
    assert owner.post(route, json=payload, headers={'Origin': 'https://other.example'}).status_code == 403
    assert owner.post(route, content='not-json', headers={'Content-Type': 'text/plain'}).status_code == 415
    owner.cookies.clear()
    assert client.post(route, json=payload, headers={'Host': 'remote.invalid'}).status_code == 403
    assert len(snapshot()) == 1


@pytest.mark.parametrize('target_other', [False, True])
def test_duplicate_preserves_complete_document_without_sharing_history(owner, target_other):
    base = make_base(owner)
    destination = make_base(owner, 'Copie') if target_other else base
    original = entry(owner, base)
    edited = ok(owner.patch(f'/api/entries/{original["id"]}/node', json={'explicit_save': True, 'path': '0', 'comment': 'Commentaire édité', 'nags': [3, 14]}))
    grade(owner, cards(owner, base)[0])
    options = {'target_base_id': destination} if target_other else {}
    response = ok(batch(owner, base, 'duplicate', [original['id']], **options))
    assert response == {'action': 'duplicate', 'count': 1, 'source_base_id': base, 'target_base_id': destination, 'entry_ids': response['entry_ids']}
    new_id = response['entry_ids'][0]
    assert new_id != original['id']
    copied = ok(owner.get(f'/api/entries/{new_id}'))
    for key in ('title', 'pgn', 'start_path', 'selected', 'headers', 'nodes'):
        assert copied[key] == edited[key]
    assert copied['base_id'] == destination
    assert copied['history'] == {'can_undo': False, 'can_redo': False}
    assert ok(owner.get(f'/api/entries/{original["id"]}'))['history']['can_undo']
    copied_card = next(card for card in cards(owner, destination) if card['entry_id'] == new_id)
    assert copied_card['state'] == 'unseen'
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM review_history WHERE card_id=?', (copied_card['id'],)).fetchone()[0] == 0


def test_duplicate_preserves_exclusion_and_request_order(owner):
    base = make_base(owner)
    first, second = entry(owner, base, title='A'), entry(owner, base, title='B')
    ok(owner.patch(f'/api/entries/{second["id"]}', json={'selected': False}))
    response = ok(batch(owner, base, 'duplicate', [second['id'], first['id']]))
    copies = [ok(owner.get(f'/api/entries/{item}')) for item in response['entry_ids']]
    assert [item['title'] for item in copies] == ['B', 'A']
    assert [item['selected'] for item in copies] == [False, True]


def test_move_preserves_identity_content_undo_analysis_and_sync_provenance(owner):
    source = make_base(owner, 'Source', type='solve')
    target = make_base(owner, 'Cible', type='play', skill=4, goal='draw')
    saved = entry(owner, source)
    saved = ok(owner.patch(f'/api/entries/{saved["id"]}/node', json={'explicit_save': True, 'path': '0', 'comment': 'Note conservée'}))
    old_card = cards(owner, source)[0]
    grade(owner, old_card)
    with db.get_conn() as conn:
        conn.execute("INSERT INTO game_analysis_reports(entry_id,fingerprint,settings,status,created_at,updated_at) VALUES(?,'fp','{}','done',?,?)", (saved['id'], app.now(), app.now()))
        conn.execute("INSERT INTO game_analysis_positions(entry_id,ply,fen,evaluation) VALUES(?,0,?,'{}')", (saved['id'], saved['nodes'][0]['fen']))
        conn.execute("INSERT INTO sync_imports(base_id,site,remote_id,entry_id,imported_at) VALUES(?,'lichess','remote-1',?,?)", (source, saved['id'], app.now()))
    response = ok(batch(owner, source, 'move', [saved['id']], target_base_id=target))
    assert response['entry_ids'] == [saved['id']] and response['target_base_id'] == target
    moved = ok(owner.get(f'/api/entries/{saved["id"]}'))
    for key in ('id', 'pgn', 'title', 'start_path', 'selected', 'created_at', 'history'):
        assert moved[key] == saved[key]
    assert moved['base_id'] == target
    assert cards(owner, source) == []
    fresh = cards(owner, target)[0]
    assert fresh['type'] == 'play' and fresh['settings']['skill'] == 4 and fresh['settings']['goal'] == 'draw'
    assert fresh['state'] == 'unseen'
    assert owner.post(f'/api/reviews/{old_card["id"]}/grade', json={'grade': 3}).status_code == 409
    with db.get_conn() as conn:
        old = conn.execute('SELECT * FROM review_cards WHERE id=?', (old_card['id'],)).fetchone()
        assert old['active'] == 0 and old['state'] == 'learned'
        assert conn.execute('SELECT count(*) FROM review_history WHERE card_id=?', (old_card['id'],)).fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM game_analysis_positions WHERE entry_id=?', (saved['id'],)).fetchone()[0] == 1
        assert conn.execute('SELECT base_id FROM sync_imports WHERE entry_id=?', (saved['id'],)).fetchone()[0] == source
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()


def test_move_detaches_old_generated_exercise_destination(owner):
    origin, source, target = [make_base(owner, label) for label in ('Parties', 'Exercices', 'Autres')]
    game, exercise = entry(owner, origin), entry(owner, source)
    with db.get_conn() as conn:
        conn.execute('INSERT INTO game_analysis_exercises(source_entry_id,source_fingerprint,ply,base_id,exercise_entry_id) VALUES(?,?,?,?,?)', (game['id'], 'source-fp', 1, source, exercise['id']))
    ok(batch(owner, source, 'move', [exercise['id']], target_base_id=target))
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM game_analysis_exercises WHERE exercise_entry_id=?', (exercise['id'],)).fetchone()[0] == 0
        assert conn.execute('SELECT pgn FROM entries WHERE id=?', (exercise['id'],)).fetchone()[0] == exercise['pgn']


def test_review_batch_preserves_history_and_reactivates_same_cards(owner):
    base = make_base(owner)
    first, second = entry(owner, base), entry(owner, base)
    old = cards(owner, base)
    grade(owner, old[0])
    response = ok(batch(owner, base, 'review', [first['id'], second['id']], selected=False))
    assert response['count'] == 2 and cards(owner, base) == []
    with db.get_conn() as conn:
        assert conn.execute('SELECT SUM(active) FROM review_cards WHERE base_id=?', (base,)).fetchone()[0] == 0
        assert conn.execute('SELECT count(*) FROM review_history').fetchone()[0] == 1
    ok(batch(owner, base, 'review', [first['id'], second['id']], selected=True))
    current = cards(owner, base)
    assert {card['id'] for card in current} == {card['id'] for card in old}
    assert next(card for card in current if card['id'] == old[0]['id'])['state'] == 'learned'


@pytest.mark.parametrize('action,options', [('delete', {}), ('review', {'selected': False})])
def test_shared_opening_card_rebinds_to_remaining_selected_entry(owner, action, options):
    base = make_base(owner, type='moves', color='white')
    first, second = entry(owner, base), entry(owner, base)
    old = cards(owner, base)[0]
    grade(owner, old)
    ok(batch(owner, base, action, [first['id']], **options))
    retained = next(card for card in cards(owner, base) if card['id'] == old['id'])
    assert retained['entry_id'] == second['id'] and retained['state'] == 'learned'


def test_delete_only_selection_cleans_foreign_keys_and_cancels_analysis(owner):
    base = make_base(owner)
    removed, retained = entry(owner, base), entry(owner, base)
    old = next(card for card in cards(owner, base) if card['entry_id'] == removed['id'])
    grade(owner, old)
    with db.get_conn() as conn:
        conn.execute("INSERT INTO sync_imports(base_id,site,remote_id,entry_id,imported_at) VALUES(?,'chesscom','one',?,?)", (base, removed['id'], app.now()))
        for status in ('queued', 'running', 'done'):
            conn.execute('INSERT INTO jobs(kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?)', ('analyse', status, json.dumps({'entry_id': removed['id']}), app.now(), app.now()))
        conn.execute('INSERT INTO jobs(kind,status,payload,created_at,updated_at) VALUES(?,?,?,?,?)', ('analyse', 'queued', json.dumps({'entry_id': retained['id']}), app.now(), app.now()))
    result = ok(batch(owner, base, 'delete', [removed['id']]))
    assert result['entry_ids'] == [removed['id']] and result['count'] == 1
    assert [row['id'] for row in snapshot()] == [retained['id']]
    assert owner.get(f'/api/entries/{removed["id"]}').status_code == 404
    assert owner.post(f'/api/reviews/{old["id"]}/grade', json={'grade': 2}).status_code == 409
    with db.get_conn() as conn:
        old_row = conn.execute('SELECT * FROM review_cards WHERE id=?', (old['id'],)).fetchone()
        assert old_row['entry_id'] is None and old_row['active'] == 0
        assert conn.execute('SELECT count(*) FROM review_history WHERE card_id=?', (old['id'],)).fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM sync_imports').fetchone()[0] == 0
        task_rows = conn.execute('SELECT status,cancel_requested FROM jobs ORDER BY id').fetchall()
        assert [tuple(row) for row in task_rows] == [('cancelled', 1), ('running', 1), ('done', 0), ('queued', 0)]
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()


@pytest.mark.parametrize('payload', [
    {'action': 'unknown', 'entry_ids': [1]},
    {'action': 'delete', 'entry_ids': []},
    {'action': 'delete', 'entry_ids': [True]},
    {'action': 'delete', 'entry_ids': [1.0]},
    {'action': 'delete', 'entry_ids': ['1']},
    {'action': 'delete', 'entry_ids': [0]},
    {'action': 'delete', 'entry_ids': [-1]},
    {'action': 'delete', 'entry_ids': [2**63]},
    {'action': 'delete', 'entry_ids': [1, 1]},
    {'action': 'delete', 'entry_ids': list(range(1, 10002))},
    {'action': 'review', 'entry_ids': [1]},
    {'action': 'review', 'entry_ids': [1], 'selected': 1},
    {'action': 'move', 'entry_ids': [1]},
    {'action': 'move', 'entry_ids': [1], 'target_base_id': True},
    {'action': 'duplicate', 'entry_ids': [1], 'target_base_id': '1'},
    {'action': 'delete', 'entry_ids': [1], 'selected': True},
    {'action': 'review', 'entry_ids': [1], 'selected': True, 'target_base_id': 1},
])
def test_invalid_batch_inputs_leave_database_unchanged(owner, payload):
    base = make_base(owner)
    entry(owner, base)
    before = snapshot()
    assert owner.post(f'/api/bases/{base}/entries/batch', json=payload).status_code == 400
    assert snapshot() == before


@pytest.mark.parametrize('action', ['duplicate', 'delete', 'move', 'review', 'metadata'])
@pytest.mark.parametrize('stale', ['deleted', 'other-base'])
def test_stale_batch_is_atomic(owner, action, stale):
    source, target = make_base(owner, 'Source'), make_base(owner, 'Cible')
    saved, other = entry(owner, source), entry(owner, target)
    options = {'target_base_id': target} if action in ('duplicate', 'move') else {'selected': False} if action == 'review' else {'headers': {'Event': 'Tournoi'}} if action == 'metadata' else {}
    missing = other['id'] if stale == 'other-base' else other['id'] + 10000
    before = snapshot()
    response = batch(owner, source, action, [saved['id'], missing], **options)
    assert response.status_code == 409
    assert snapshot() == before


def test_missing_destination_and_self_move_are_rejected(owner):
    base = make_base(owner)
    saved = entry(owner, base)
    before = snapshot()
    assert batch(owner, base, 'move', [saved['id']], target_base_id=base).status_code == 400
    assert batch(owner, base, 'move', [saved['id']], target_base_id=99999).status_code == 404
    assert batch(owner, 99999, 'delete', [saved['id']]).status_code == 404
    assert snapshot() == before


def test_review_rebuild_failure_rolls_back_entire_move(owner, monkeypatch):
    source, target = make_base(owner, 'Source'), make_base(owner, 'Cible')
    saved = entry(owner, source)
    before = snapshot()
    def fail_rebuild(*args):
        raise RuntimeError('test rebuild failure')
    monkeypatch.setattr(training, '_sync_base', fail_rebuild)
    with pytest.raises(RuntimeError, match='test rebuild failure'):
        batch(owner, source, 'move', [saved['id']], target_base_id=target)
    assert snapshot() == before


def test_batch_chunks_selection_larger_than_sqlite_variable_limit(owner):
    base = make_base(owner, review_enabled=False)
    sample = entry(owner, base)
    with db.get_conn() as conn:
        conn.executemany('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)', [(base, f'Position {i}', sample['pgn'], app.now(), app.now()) for i in range(1000)])
        ids = [row[0] for row in conn.execute('SELECT id FROM entries WHERE base_id=?', (base,))]
    result = ok(batch(owner, base, 'review', ids, selected=False))
    assert result['count'] == 1001
    assert all(row['selected'] == 0 for row in snapshot())


@pytest.mark.parametrize('count', [1, 5])
def test_metadata_batch_only_changes_selected_headers_preserves_complete_games(owner, count):
    base = make_base(owner)
    originals = []
    for i in range(count):
        pgn = PGN.replace('[White "Blanc"]', f'[White "Blanc {i}"]').replace('[WhiteElo "1700"]', f'[WhiteElo "{1700 + i}"]')
        originals.append(entry(owner, base, pgn=pgn, selected=i % 2 == 0))
    untouched = entry(owner, base, title='Hors sélection')
    ids = [item['id'] for item in reversed(originals)]
    result = ok(batch(owner, base, 'metadata', ids, headers={'Event': 'Tournoi d’automne', 'Site': 'Québec'}))
    assert result['action'] == 'metadata' and result['count'] == count
    assert result['entry_ids'] == ids and result['source_base_id'] == base
    assert [item['id'] for item in result['updated_entries']] == ids
    for summary in result['updated_entries']:
        assert 'pgn' not in summary and 'nodes' not in summary
        assert summary['history'] == {'can_undo': True, 'can_redo': False}
        assert summary['headers']['Event'] == 'Tournoi d’automne'
    for original in originals:
        current = ok(owner.get(f'/api/entries/{original["id"]}'))
        assert current['headers'] == original['headers'] | {'Event': 'Tournoi d’automne', 'Site': 'Québec'}
        assert current['nodes'] == original['nodes']
        for key in ('title', 'selected', 'start_path', 'created_at', 'base_id'):
            assert current[key] == original[key]
        # Comments, variations, NAGs and time/evaluation directives all survive.
        assert 'Un plan [%clk 0:10:00] [%eval 0.25]' in current['pgn']
        assert '$1' in current['pgn'] and '$5' in current['pgn'] and '( 1. d4 d5 { Variante } )' in current['pgn']
    assert ok(owner.get(f'/api/entries/{untouched["id"]}')) == untouched


def test_metadata_batch_updates_default_titles_keeps_custom_titles_and_refreshes_cards(owner):
    base = make_base(owner)
    natural = entry(owner, base, title='Blanc — Noir')
    custom = entry(owner, base, title='Mon exercice personnel')
    anonymous = entry(owner, base, pgn=PGN.replace('[White "Blanc"]', '[White "?"]').replace('[Black "Noir"]', '[Black "?"]'), title='Cours annoté')
    old_card = next(card for card in cards(owner, base) if card['entry_id'] == natural['id'])
    grade(owner, old_card)
    with db.get_conn() as conn:
        before = dict(conn.execute('SELECT * FROM review_cards WHERE id=?', (old_card['id'],)).fetchone())
        history = [dict(row) for row in conn.execute('SELECT * FROM review_history')]
    ok(batch(owner, base, 'metadata', [natural['id'], custom['id']], headers={'White': 'Nouvelle blanche'}))
    ok(batch(owner, base, 'metadata', [anonymous['id']], headers={'Event': 'Nouveau tournoi'}))
    assert ok(owner.get(f'/api/entries/{natural["id"]}'))['title'] == 'Nouvelle blanche — Noir'
    assert ok(owner.get(f'/api/entries/{custom["id"]}'))['title'] == 'Mon exercice personnel'
    assert ok(owner.get(f'/api/entries/{anonymous["id"]}'))['title'] == 'Nouveau tournoi'
    with db.get_conn() as conn:
        after = dict(conn.execute('SELECT * FROM review_cards WHERE id=?', (old_card['id'],)).fetchone())
        assert after['title'] == 'Nouvelle blanche — Noir'
        assert {key: value for key, value in after.items() if key not in ('title', 'updated_at')} == {key: value for key, value in before.items() if key not in ('title', 'updated_at')}
        assert [dict(row) for row in conn.execute('SELECT * FROM review_history')] == history


def test_metadata_batch_supports_explicit_clear_without_removing_other_tags(owner):
    base = make_base(owner)
    saved = entry(owner, base)
    result = ok(batch(owner, base, 'metadata', [saved['id']], headers={'Event': None, 'WhiteElo': '', 'Result': None}))
    headers = result['updated_entries'][0]['headers']
    assert headers['Event'] == '?' and headers['Result'] == '*'
    assert 'WhiteElo' not in headers
    assert headers['BlackElo'] == '1800' and headers['White'] == 'Blanc'


@pytest.mark.parametrize('headers', [
    None, [], '', 12, {}, {'Event': 12}, {'Event': True}, {'Event': []},
    {'Event': 'Tournoi\nAutre'}, {'Event': 'x' * 2001}, {'': 'value'},
    {'Event Name': 'Tournoi'}, {'x' * 81: 'value'},
    {'FEN': None}, {'fen': ''}, {'SetUp': '1'}, {'Variant': 'Chess960'},
    {'Result': 'win'}, {'WhiteElo': 'strong'}, {'Date': '20/10/2026'},
    {'Date': '2026.13.01'}, {'ECO': 'Z99'}, {'TimeControl': 'rapid'},
    {f'Tag{i}': 'value' for i in range(151)},
])
def test_invalid_metadata_patch_is_atomic(owner, headers):
    base = make_base(owner)
    saved = entry(owner, base)
    before = snapshot()
    response = batch(owner, base, 'metadata', [saved['id']], headers=headers)
    assert response.status_code == 400, response.text
    assert snapshot() == before
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entry_history').fetchone()[0] == 0


def test_metadata_payload_rejects_incompatible_options_and_requires_auth(owner):
    base = make_base(owner)
    saved = entry(owner, base)
    options = {'headers': {'Event': 'Tournoi'}}
    assert batch(owner, base, 'metadata', [saved['id']], **options, selected=False).status_code == 400
    assert batch(owner, base, 'metadata', [saved['id']], **options, target_base_id=base).status_code == 400
    assert batch(owner, base, 'metadata', [saved['id']]).status_code == 400
    assert owner.post(f'/api/bases/{base}/entries/batch', json={'action': 'metadata', 'entry_ids': [saved['id']], **options}, headers={'Origin': 'https://other.example'}).status_code == 403
    owner.cookies.clear()
    assert owner.post(f'/api/bases/{base}/entries/batch', json={'action': 'metadata', 'entry_ids': [saved['id']], **options}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_metadata_batch_preserves_analysis_and_supports_undo_per_entry(owner):
    base = make_base(owner)
    first, second = entry(owner, base), entry(owner, base)
    first = ok(owner.patch(f'/api/entries/{first["id"]}/node', json={'explicit_save': True, 'path': '0', 'comment': 'Note à conserver'}))
    fingerprint = game_analysis.game_snapshot(first['pgn'])[2]
    with db.get_conn() as conn:
        conn.execute("INSERT INTO game_analysis_reports(entry_id,fingerprint,settings,status,created_at,updated_at) VALUES(?,?,'{}','done',?,?)", (first['id'], fingerprint, app.now(), app.now()))
        conn.execute("INSERT INTO game_analysis_positions(entry_id,ply,fen,evaluation) VALUES(?,0,?,'{}')", (first['id'], first['nodes'][0]['fen']))
        report = dict(conn.execute('SELECT * FROM game_analysis_reports').fetchone())
        positions = [dict(row) for row in conn.execute('SELECT * FROM game_analysis_positions')]
    ok(batch(owner, base, 'metadata', [first['id'], second['id']], headers={'Event': 'Tournoi'}))
    changed = ok(owner.get(f'/api/entries/{first["id"]}'))
    assert game_analysis.game_snapshot(changed['pgn'])[2] == fingerprint
    with db.get_conn() as conn:
        assert dict(conn.execute('SELECT * FROM game_analysis_reports').fetchone()) == report
        assert [dict(row) for row in conn.execute('SELECT * FROM game_analysis_positions')] == positions
        assert conn.execute('SELECT count(*) FROM entry_history WHERE entry_id=?', (first['id'],)).fetchone()[0] == 2
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()
    restored = ok(owner.post(f'/api/entries/{first["id"]}/undo', json={'explicit_save': True}))['entry']
    for key in ('title', 'pgn', 'nodes', 'selected', 'start_path'):
        assert restored[key] == first[key]
    assert ok(owner.get(f'/api/entries/{second["id"]}'))['headers']['Event'] == 'Tournoi'
    redone = ok(owner.post(f'/api/entries/{first["id"]}/redo', json={'explicit_save': True}))['entry']
    assert redone['pgn'] == changed['pgn']


def test_metadata_noop_preserves_timestamp_and_redo(owner):
    base = make_base(owner)
    saved = entry(owner, base)
    ok(batch(owner, base, 'metadata', [saved['id']], headers={'Event': 'Tournoi'}))
    ok(owner.post(f'/api/entries/{saved["id"]}/undo', json={'explicit_save': True}))
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET updated_at='2020-01-01T00:00:00Z' WHERE id=?", (saved['id'],))
        before_history = [dict(row) for row in conn.execute('SELECT * FROM entry_history')]
    before = snapshot()
    result = ok(batch(owner, base, 'metadata', [saved['id']], headers={'Event': saved['headers']['Event']}))
    assert snapshot() == before
    assert result['updated_entries'][0]['history']['can_redo']
    with db.get_conn() as conn:
        assert [dict(row) for row in conn.execute('SELECT * FROM entry_history')] == before_history


def test_metadata_batch_rolls_back_earlier_documents_if_save_or_review_refresh_fails(owner, monkeypatch):
    base = make_base(owner)
    first, second = entry(owner, base), entry(owner, base)
    before = snapshot()
    real_save = entries_api.save_content
    def fail_second(conn, row, **options):
        if row['id'] == second['id']:
            raise ValueError('Échec du second document')
        return real_save(conn, row, **options)
    monkeypatch.setattr(entries_api, 'save_content', fail_second)
    assert batch(owner, base, 'metadata', [first['id'], second['id']], headers={'Event': 'Tournoi'}).status_code == 400
    assert snapshot() == before
    monkeypatch.setattr(entries_api, 'save_content', real_save)
    def fail_review(*args):
        raise ValueError('Échec révisions')
    monkeypatch.setattr(training, '_sync_base', fail_review)
    assert batch(owner, base, 'metadata', [first['id'], second['id']], headers={'Event': 'Tournoi'}).status_code == 400
    assert snapshot() == before
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entry_history').fetchone()[0] == 0



def test_metadata_result_and_time_control_update_only_their_derived_values(owner):
    base = make_base(owner)
    saved = entry(owner, base)
    ok(batch(owner, base, 'metadata', [saved['id']], headers={'Result': '1-0', 'TimeControl': '900+10'}))
    changed = ok(owner.get(f'/api/entries/{saved["id"]}'))
    assert changed['headers']['Result'] == '1-0'
    assert changed['pgn'].rstrip().endswith('1-0')
    before_first = next(node for node in saved['nodes'] if node['path'] == '0')
    after_first = next(node for node in changed['nodes'] if node['path'] == '0')
    assert before_first['clock'] == after_first['clock'] == 600
    assert before_first['elapsed'] == 5 and after_first['elapsed'] == 310
    assert [{key: value for key, value in node.items() if key != 'elapsed'} for node in changed['nodes']] == [{key: value for key, value in node.items() if key != 'elapsed'} for node in saved['nodes']]
