"""Backend draft CAS, saved-document concurrency and personal-backup regression."""
import io
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import zipfile

import pytest
from fastapi import HTTPException
from local_test_client import TestClient

import app
import db
import reference_library
import training
import workspace_state


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'workspace.sqlite3')
    db.init_db()
    training.init_training()

    client = TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000))
    assert client.get('/api/status').status_code == 200
    yield client
    client.close()


def put(owner, key, data, revision=0):
    return owner.put('/api/workspace/' + key, json={'expected_revision': revision, 'data': data})


def entry(owner):
    base = owner.post('/api/bases', json={'name': 'Course'}).json()
    assert owner.post('/api/bases/' + str(base['id']) + '/import', json={'pgn': '1. e4 e5 2. Nf3 *'}).status_code == 200
    return base, owner.get('/api/bases/' + str(base['id']) + '/entries').json()['entries'][0]


def test_draft_persistence_cas_delete_recreate_and_local_access(owner):
    assert owner.get('/api/workspace/analysis').json()['revision'] == 0
    first = put(owner, 'analysis', {'pgn': '1. e4 *', 'comment': 'À conserver'}).json()
    assert first['revision'] > 0
    db.init_db()
    assert owner.get('/api/workspace/analysis').json() == first
    assert put(owner, 'analysis', {'pgn': 'lost'}, 0).status_code == 409
    assert owner.delete('/api/workspace/analysis?expected_revision=0').status_code == 409
    assert owner.get('/api/workspace/analysis').json() == first
    assert owner.delete('/api/workspace/analysis?expected_revision=' + str(first['revision'])).status_code == 200
    recreated = put(owner, 'analysis', {'pgn': '1. d4 *'}).json()
    assert recreated['revision'] > first['revision']
    assert put(owner, 'analysis', {'pgn': 'stale'}, first['revision']).status_code == 409
    assert owner.get('/api/workspace').json()['items'] == [recreated]
    owner.cookies.clear()
    assert owner.get('/api/workspace').json()['items'] == [recreated]
    assert owner.get('/api/workspace', headers={'Host': 'remote.invalid'}).status_code == 403
    assert owner.put('/api/workspace/analysis', json={'expected_revision': recreated['revision'], 'data': {}}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert owner.get('/api/workspace').json()['items'] == [recreated]


@pytest.mark.parametrize('payload', [{}, {'data': []}, {'data': {}, 'expected_revision': True},
    {'data': {}, 'expected_revision': -1}, {'data': {}, 'expected_revision': '0'},
    {'data': {}, 'expected_revision': 0, 'unknown': 1}])
def test_invalid_workspace_payload_never_writes(owner, payload):
    assert owner.put('/api/workspace/analysis', json=payload).status_code == 400
    assert owner.get('/api/workspace').json()['items'] == []


def test_workspace_size_and_count_limits_do_not_evict(owner, monkeypatch):
    monkeypatch.setattr(workspace_state, 'MAX_ITEM_BYTES', 60)
    monkeypatch.setattr(workspace_state, 'MAX_ACCOUNT_BYTES', 90)
    monkeypatch.setattr(workspace_state, 'MAX_ITEMS', 2)
    first = put(owner, 'a', {'text': 'x' * 25}).json()
    assert put(owner, 'big', {'text': 'x' * 61}).status_code == 413
    assert put(owner, 'b', {'text': 'x' * 45}).status_code == 413
    assert put(owner, 'b', {'text': 'x'}).status_code == 200
    assert put(owner, 'c', {}).status_code == 413
    assert owner.get('/api/workspace/a').json() == first
    assert len(owner.get('/api/workspace').json()['items']) == 2


def test_workspace_account_keys_are_independent():
    conn = sqlite3.connect(':memory:')
    conn.row_factory = sqlite3.Row
    conn.execute('CREATE TABLE users(id INTEGER PRIMARY KEY)')
    conn.executemany('INSERT INTO users VALUES (?)', [(1,), (2,)])
    workspace_state.init_schema(conn)
    workspace_state.write(conn, 1, 'analysis', {'data': {'owner': 1}, 'expected_revision': 0})
    workspace_state.write(conn, 2, 'analysis', {'data': {'owner': 2}, 'expected_revision': 0})
    assert workspace_state.read(conn, 1, 'analysis')['data'] == {'owner': 1}
    assert workspace_state.read(conn, 2, 'analysis')['data'] == {'owner': 2}
    conn.close()


def test_concurrent_workspace_writers_accept_only_one_expected_version(owner):
    revision = put(owner, 'analysis', {'text': 'initial'}).json()['revision']
    barrier = Barrier(2)
    def write(text):
        barrier.wait(timeout=5)
        try:
            with db.get_conn() as conn:
                conn.execute('BEGIN IMMEDIATE')
                workspace_state.write(conn, 1, 'analysis', {'data': {'text': text}, 'expected_revision': revision})
            return 200
        except HTTPException as error:
            return error.status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, ['first', 'second']))
    assert sorted(results) == [200, 409]
    assert owner.get('/api/workspace/analysis').json()['data']['text'] in ('first', 'second')


@pytest.mark.parametrize('method,suffix,payload', [
    ('PATCH', '', {'title': 'Stale title'}),
    ('PATCH', '/node', {'path': '0', 'comment': 'Stale annotation'}),
    ('POST', '/move', {'path': '', 'uci': 'd2d4'}),
    ('POST', '/line', {'path': '', 'moves': ['d2d4', 'd7d5']}),
    ('POST', '/tree', {'path': '0', 'action': 'delete'}),
    ('POST', '/undo', {}), ('POST', '/redo', {}),
])
def test_stale_saved_document_mutations_preserve_content_history_and_draft(owner, method, suffix, payload):
    _, original = entry(owner)
    url = '/api/entries/' + str(original['id'])
    draft = put(owner, 'annotation:entry:' + str(original['id']), {'comment': 'Private draft'}).json()
    latest = owner.patch(url, json={'title': 'Changed on another device', 'expected_revision': original['revision']})
    assert latest.status_code == 200
    with db.get_conn() as conn:
        history_before = [dict(row) for row in conn.execute('SELECT * FROM entry_history')]
    response = owner.request(method, url + suffix, json={**payload, 'expected_revision': original['revision']})
    assert response.status_code == 409, response.text
    assert owner.get(url).json()['revision'] == latest.json()['revision']
    assert owner.get('/api/workspace/' + draft['key']).json() == draft
    with db.get_conn() as conn:
        assert [dict(row) for row in conn.execute('SELECT * FROM entry_history')] == history_before


def test_legacy_saves_still_work_invalid_revision_rejected_and_delete_guarded(owner):
    _, original = entry(owner)
    url = '/api/entries/' + str(original['id'])
    assert owner.patch(url, json={'title': 'Legacy save'}).status_code == 200
    assert owner.patch(url, json={'title': 'Bad revision', 'expected_revision': 'invalid'}).status_code == 400
    assert owner.delete(url + '?expected_revision=' + original['revision']).status_code == 409
    fresh = owner.get(url).json()
    assert fresh['title'] == 'Legacy save'
    assert owner.delete(url + '?expected_revision=' + fresh['revision']).status_code == 200


def test_batch_revision_conflict_is_atomic(owner):
    base, original = entry(owner)
    response = owner.post('/api/bases/' + str(base['id']) + '/import', json={'pgn': '1. d4 d5 *'})
    assert response.status_code == 200
    entries = owner.get('/api/bases/' + str(base['id']) + '/entries').json()['entries']
    assert len(entries) == 2
    owner.patch('/api/entries/' + str(original['id']), json={'title': 'Other device'})
    response = owner.post('/api/bases/' + str(base['id']) + '/entries/batch', json={
        'action': 'review', 'entry_ids': [item['id'] for item in entries], 'selected': False,
        'expected_revisions': {str(item['id']): item['revision'] for item in entries}})
    assert response.status_code == 409, response.text
    assert all(item['selected'] for item in owner.get('/api/bases/' + str(base['id']) + '/entries').json()['entries'])


def test_personal_backup_keeps_drafts_and_progress_without_opening_references(owner, monkeypatch, tmp_path):
    base, _ = entry(owner)
    put(owner, 'analysis', {'pgn': '1. d4 *'})
    owner.patch('/api/preferences', json={'language': 'en'})
    with db.get_conn() as conn:
        reference_id = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)', ('Archive', '{}', app.now())).lastrowid
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source) VALUES (?,?,?)', (reference_id, 'a' * 32, '/private/archive.pgn'))
    def forbidden(*args):
        raise AssertionError('Personal backup must not inspect a reference store')
    monkeypatch.setattr(reference_library, 'store_path', forbidden)
    response = owner.get('/api/backup')
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        assert not any(name.startswith('references/') for name in archive.namelist())
        manifest = json.loads(archive.read('metadata.json'))
        assert manifest['backup']['mode'] == 'personal'
        assert manifest['backup']['reference_stores_included'] is False
        assert manifest['backup']['omitted_reference_stores'][0]['base_id'] == reference_id
        assert 'pgn/base-' + str(base['id']) + '.pgn' in archive.namelist()
        restored_path = tmp_path / 'restored.sqlite3'
        restored_path.write_bytes(archive.read('chessgym.sqlite3'))
    with sqlite3.connect(restored_path) as restored:
        assert restored.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert json.loads(restored.execute('SELECT data FROM user_workspaces').fetchone()[0]) == {'pgn': '1. d4 *'}
        assert restored.execute('SELECT COUNT(*) FROM reference_bases').fetchone()[0] == 1
        assert json.loads(restored.execute("SELECT value FROM preferences WHERE key='language'").fetchone()[0]) == 'en'
    assert owner.get('/api/backup?mode=unsupported').status_code == 400
