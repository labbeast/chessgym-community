"""Free analysis and saved PGNs extend precisely the reviewed repertoire snapshot."""
import json
import threading

import chess
import pytest
from fastapi import HTTPException
from local_test_client import TestClient

import app
import db
import jobs
import pgnlib
import training


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'repertoire-sources.sqlite3')
    db.init_db()
    training.init_training()
    with db.get_conn() as conn:
        settings = {'is_repertoire': True, 'primary': True, 'color': 'white', 'type': 'moves', 'review_enabled': True}
        conn.execute('INSERT INTO bases(id,name,settings,created_at) VALUES(1,?,?,?)', ('Répertoire blanc', json.dumps(settings), training.stamp()))
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(2,'Sources','{}',?)", (training.stamp(),))


def add(pgn, base=1):
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                            (base, 'Une ligne', pgn, training.stamp(), training.stamp())).lastrowid


def content(entry_id):
    with db.get_conn() as conn:
        return conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0]


def check(pgn, path, entry_id=None):
    return training.check_repertoire(training.RepertoireSource(pgn=pgn, path=path, entry_id=entry_id))


def extend_request(pgn, path, checked, entry_id=None):
    return training.ExtendRequest(pgn=pgn, path=path, entry_id=entry_id,
        source_fingerprint=checked['source_fingerprint'], repertoire_fingerprint=checked['white']['repertoire_fingerprint'])


def test_free_analysis_extends_known_leaf_without_saving_source(store):
    target = add('1. e4 e5 *')
    pgn = '1. e4 e5 2. Nf3 {Le développement.} Nc6! *'
    checked = check(pgn, '0.0.0.0')
    assert checked['white']['compatible'] and checked['white']['extendable']
    assert len(checked['source_fingerprint']) == 64
    result = training.extend(1, extend_request(pgn, '0.0.0.0', checked))
    assert result == {'added_moves': 2, 'entry_id': target, 'base_id': 1}
    game = pgnlib.load_game(content(target))
    assert [move.uci() for move in game.mainline_moves()] == ['e2e4', 'e7e5', 'g1f3', 'b8c6']
    assert game.variations[0].variations[0].variations[0].comment == 'Le développement.'
    assert game.end().nags == {1}
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0] == 1
    assert not check(pgn, '0.0.0.0')['white']['extendable']


def test_empty_repertoire_from_free_analysis_creates_one_line(store):
    pgn = '1. d4 d5 2. c4 *'
    checked = check(pgn, '0.0.0')
    result = training.extend(1, extend_request(pgn, '0.0.0', checked))
    assert result['added_moves'] == 3
    assert pgnlib.load_game(content(result['entry_id'])).end().san() == 'c4'


def test_saved_pgn_snapshot_accepts_formatting_differences(store):
    add('1. e4 e5 *')
    pgn = '1. e4! {Une note} e5 2. Nf3 *'
    source_id = add(pgn, base=2)
    formatted = pgnlib.export_game(pgnlib.load_game(pgn))
    checked = check(formatted, '0.0.0', source_id)
    result = training.extend(1, extend_request(formatted, '0.0.0', checked, source_id))
    assert result['added_moves'] == 1
    assert content(source_id) == pgn


def test_actual_browser_serializer_matches_saved_snapshot_with_nested_annotations(store):
    from test_frontend_pgn import _serialize, ANNOTATED
    add('1. e4 e5 *')
    source_id = add(ANNOTATED, base=2)
    serialized = _serialize(pgnlib.game_payload(pgnlib.load_game(ANNOTATED)))
    original = check(ANNOTATED, '0.0.0.0.0.0', source_id)
    browser = check(serialized, '0.0.0.0.0.0', source_id)
    assert browser['source_fingerprint'] == original['source_fingerprint']
    assert browser['white']['compatible'] and browser['white']['extendable']
    result = training.extend(1, extend_request(serialized, '0.0.0.0.0.0', browser, source_id))
    assert result['added_moves'] == 4
    assert content(source_id) == ANNOTATED


def test_source_fingerprint_includes_selected_branch_path_and_annotations(store):
    add('1. e4 e5 *')
    pgn = '1. e4 e5 2. Nf3 (2. Bc4) Nc6 *'
    checked = check(pgn, '0.0.0.0')
    wrong_path = extend_request(pgn, '0.0.1', checked)
    with pytest.raises(HTTPException) as error:
        training.extend(1, wrong_path)
    assert error.value.status_code == 409
    changed = pgn.replace('Nf3', 'Nf3! {Changed}')
    with pytest.raises(HTTPException) as error:
        training.extend(1, extend_request(changed, '0.0.0.0', checked))
    assert error.value.status_code == 409


def test_saved_source_changed_after_check_is_rejected_atomically(store):
    target = add('1. e4 e5 *')
    pgn = '1. e4 e5 2. Nf3 *'
    source = add(pgn, base=2)
    checked = check(pgn, '0.0.0', source)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. e4 e5 2. Bc4 *', source))
    for action in (lambda: check(pgn, '0.0.0', source),
                   lambda: training.extend(1, extend_request(pgn, '0.0.0', checked, source))):
        with pytest.raises(HTTPException) as error:
            action()
        assert error.value.status_code == 409
    assert content(target) == '1. e4 e5 *'


@pytest.mark.parametrize('replacement', ['1. e4! {Nouvelle note} e5 *', '1. e4 e5 2. Bc4 *'])
def test_repertoire_change_after_check_is_rejected_without_overwrite(store, replacement):
    target = add('1. e4 e5 *')
    pgn = '1. e4 e5 2. Nf3 *'
    checked = check(pgn, '0.0.0')
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', (replacement, target))
    with pytest.raises(HTTPException) as error:
        training.extend(1, extend_request(pgn, '0.0.0', checked))
    assert error.value.status_code == 409
    assert content(target) == replacement


def test_transposition_is_informational_and_does_not_authorize_a_deviation(store):
    target = add('1. Nf3 d5 2. d4 Nf6 *')
    pgn = '1. d4 d5 2. Nf3 Nf6 *'
    checked = check(pgn, '0.0.0.0')
    item = checked['white']
    assert item['transposition'] and not item['compatible'] and not item['extendable']
    assert 'transposition' in item['reason']
    with pytest.raises(HTTPException) as error:
        training.extend(1, extend_request(pgn, '0.0.0.0', checked))
    assert error.value.status_code == 409
    assert content(target) == '1. Nf3 d5 2. d4 Nf6 *'


def test_isolated_position_and_actual_opponent_deviation_remain_rejected(store):
    add('1. e4 e5 2. Nf3 *')
    isolated = chess.pgn.Game()
    board = chess.Board()
    board.push_uci('e2e4')
    isolated.setup(board)
    diagram = check(pgnlib.export_game(isolated), '')['white']
    assert not diagram['compatible'] and not diagram['transposition']
    sicilian = check('1. e4 c5 *', '0.0')['white']
    assert not sicilian['compatible'] and not sicilian['transposition']


def test_existing_escaped_headers_comments_nags_and_siblings_survive_extension(store):
    game = pgnlib.load_game('1. e4! {Original [%clk 0:10:00]} e5 (1... c5) *')
    game.headers['Event'] = 'Cours "Italienne" \\ dossier'
    game.comment = 'Note générale.'
    old_pgn = pgnlib.export_game(game)
    target = add(old_pgn)
    source_game = pgnlib.load_game('1. e4 e5 2. Bc4 (2. Nf3! {Ajout [%eval 0.30]} Nc6) *')
    source_game.variations[0].variations[0].variations[1].starting_comment = 'Avant le coup.'
    source_pgn = pgnlib.export_game(source_game)
    checked = check(source_pgn, '0.0.1.0')
    training.extend(1, extend_request(source_pgn, '0.0.1.0', checked))
    updated = pgnlib.load_game(content(target))
    assert updated.headers == game.headers
    assert updated.comment == 'Note générale.'
    assert updated.variations[0].comment == 'Original [%clk 0:10:00]'
    assert updated.variations[0].nags == {1}
    assert len(updated.variations[0].variations) == 2
    assert updated.variations[0].variations[1].move.uci() == 'c7c5'
    appended = updated.variations[0].variations[0].variations[0]
    assert appended.comment == 'Ajout [%eval 0.30]' and appended.nags == {1}
    # A variation-start comment becomes a parent comment when that variation
    # becomes a new main line, as required by PGN syntax; its text must survive.
    assert appended.parent.comment == 'Avant le coup.'


def test_extension_holds_write_reservation_before_reading_and_preserves_later_annotation(store, monkeypatch):
    target = add('1. e4 e5 *')
    pgn = '1. e4 e5 2. Nf3 *'
    checked = check(pgn, '0.0.0')
    began, finished = threading.Event(), threading.Event()
    errors = []
    def annotate():
        try:
            with db.get_conn() as conn:
                began.set()
                conn.execute('BEGIN IMMEDIATE')
                game = pgnlib.load_game(conn.execute('SELECT pgn FROM entries WHERE id=?', (target,)).fetchone()[0])
                game.variations[0].comment = 'Annotation concurrente.'
                conn.execute('UPDATE entries SET pgn=? WHERE id=?', (pgnlib.export_game(game), target))
        except Exception as exc:
            errors.append(exc)
        finally:
            finished.set()
    writer = threading.Thread(target=annotate)
    original = training._compatibility
    def interleaved(*args):
        writer.start()
        assert began.wait(2)
        assert not finished.wait(.05), 'The concurrent writer must wait for the extension transaction.'
        return original(*args)
    monkeypatch.setattr(training, '_compatibility', interleaved)
    training.extend(1, extend_request(pgn, '0.0.0', checked))
    writer.join(3)
    assert finished.is_set() and not errors
    updated = pgnlib.load_game(content(target))
    assert updated.end().san() == 'Nf3'
    assert updated.variations[0].comment == 'Annotation concurrente.'


@pytest.fixture
def client(store, monkeypatch):
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        yield client


def test_new_endpoint_requires_owner(client):
    assert client.post('/api/repertoires/compatibility', json={'pgn': '1. e4 *', 'path': '0'}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_legacy_get_validation_remains_client_error(client):
    assert client.get('/api/status').status_code == 200
    assert client.get('/api/repertoires/compatibility?entry_id=0').status_code == 422
    assert client.get('/api/repertoires/compatibility', params={'entry_id': 1, 'path': '0.' * 1001}).status_code == 422


def test_api_free_snapshot_and_extension_and_primary_selection(client):
    assert client.get('/api/status').status_code == 200
    added = client.post('/api/bases', json={'name': 'Autre blanc', 'settings': {'is_repertoire': True, 'primary': True, 'color': 'white'}})
    assert added.status_code == 200
    white_id = added.json()['id']
    black = client.post('/api/bases', json={'name': 'Noir principal', 'settings': {'is_repertoire': True, 'primary': True, 'color': 'black'}})
    assert black.status_code == 200
    black_id = black.json()['id']
    pgn, path = '1. d4 d5 *', '0.0'
    checked = client.post('/api/repertoires/compatibility', json={'pgn': pgn, 'path': path})
    assert checked.status_code == 200, checked.text
    result = checked.json()
    assert result['white']['base_id'] == white_id and result['black']['base_id'] == black_id
    made = client.post(f'/api/repertoires/{white_id}/extend', json={'pgn': pgn, 'path': path,
        'source_fingerprint': result['source_fingerprint'], 'repertoire_fingerprint': result['white']['repertoire_fingerprint']})
    assert made.status_code == 200, made.text
    assert made.json()['added_moves'] == 2
    with db.get_conn() as conn:
        assert not json.loads(conn.execute('SELECT settings FROM bases WHERE id=1').fetchone()[0])['primary']
        assert conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0] == 1


@pytest.mark.parametrize('payload', [
    {}, {'entry_id': True}, {'pgn': 25}, {'pgn': '1. e4 *', 'path': True},
    {'pgn': 'garbage'}, {'pgn': '1. e4 *', 'path': '0.0'}, {'pgn': '1. e4 *', 'extra': 1},
])
def test_invalid_api_sources_cannot_modify_content(client, payload):
    assert client.get('/api/status').status_code == 200
    response = client.post('/api/repertoires/compatibility', json=payload)
    assert response.status_code == 422, response.text
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0] == 0
