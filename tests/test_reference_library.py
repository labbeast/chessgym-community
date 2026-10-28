"""Large references integrate without becoming study entries or review cards."""
import io
import json
import sqlite3
import time
import zipfile
import threading
from concurrent.futures import ThreadPoolExecutor

import chess
import pytest
from local_test_client import TestClient

import app
import db
import reference_library as library
import reference_store as store


PGN = '''[Event "Test référence"]
[White "Alice"]
[Black "Bob"]
[WhiteElo "1800"]
[BlackElo "1850"]
[Date "2025.04.01"]
[TimeControl "600+5"]
[Result "1-0"]

1. e4 {Plan [%clk 0:10:00]} (1. d4 d5) e5 2. Nf3 Nc6 1-0
'''


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'study.sqlite3')
    monkeypatch.setattr(app.jobs, 'start_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 51000)) as client:
        yield client


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


@pytest.fixture
def synchronous(monkeypatch):
    def start(base_id):
        row = library.require_reference(base_id)
        store.import_file(library.store_path(row['storage_key']), row['source'], max_games=row['max_games'], encoding=row['encoding'])
        return library.get_status(base_id)
    monkeypatch.setattr(library, 'start_import', start)


def create(owner, tmp_path, text=PGN, **options):
    source = tmp_path / ('source-' + str(time.time_ns()) + '.pgn')
    source.write_text(text, encoding='utf-8')
    response = owner.post('/api/reference-bases', json={'name': 'Référence', 'path': str(source), **options})
    assert response.status_code == 200, response.text
    return response.json()


def test_authentication_required(client):
    for method, path in [('post', '/api/reference-bases'), ('get', '/api/reference-bases/1/games'),
                         ('get', '/api/reference-bases/1/status'), ('post', '/api/reference-bases/1/resume'),
                         ('get', '/api/reference-bases/1/export')]:
        assert getattr(client, method)(path, **({'json': {}} if method == 'post' else {}), headers={'Host': 'remote.invalid'}).status_code == 403


def test_bad_sources_do_not_create_library_objects(owner, tmp_path):
    secret = tmp_path / 'secrets.txt'
    secret.write_text('not a pgn')
    for path in [str(secret), str(tmp_path / 'missing.pgn'), 'relative.pgn']:
        assert owner.post('/api/reference-bases', json={'name': 'Bad', 'path': path}).status_code == 400
    pgn = tmp_path / 'valid.pgn'
    pgn.write_text(PGN, encoding='utf-8')
    for maximum in [0, -1, True, '10', 1.5]:
        assert owner.post('/api/reference-bases', json={'name': 'Bad', 'path': str(pgn), 'max_games': maximum}).status_code == 400
    assert owner.get('/api/library').json()['bases'] == []


def test_reference_pagination_filters_and_detached_analysis(owner, tmp_path, synchronous):
    second = PGN.replace('Alice', 'Zoe').replace('1800', '2100').replace('1850', '2150').replace('600+5', '60+0')
    base = create(owner, tmp_path, PGN + '\n' + second)
    assert base['reference'] and base['entry_count'] == 2
    bid = base['id']
    page = owner.get(f'/api/reference-bases/{bid}/games', params={'limit': 1, 'sort': 'white', 'descending': True}).json()
    assert page['total'] == 2 and page['has_more'] and page['entries'][0]['headers']['White'] == 'Zoe'
    filtered = owner.get(f'/api/reference-bases/{bid}/games', params={'rating_min': 1750, 'rating_max': 1900, 'speed': 'rapid'}).json()
    assert filtered['total'] == 1
    gid = filtered['entries'][0]['id']
    doc = owner.get(f'/api/reference-bases/{bid}/games/{gid}').json()
    assert 'id' not in doc and doc['reference_source'] == {'base_id': bid, 'game_id': gid}
    assert 'Plan' in doc['pgn'] and any(node['path'] == '1.0' for node in doc['nodes'])
    assert owner.post('/api/entries', json={'base_id': bid, 'pgn': doc['pgn']}).status_code == 400
    study = owner.post('/api/bases', json={'name': 'Études'}).json()['id']
    assert owner.post('/api/entries', json={'base_id': study, 'pgn': doc['pgn']}).status_code == 200
    assert owner.get('/api/entries?played=true').json()['entries'] == []
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM review_cards').fetchone()[0] == 0


def test_reference_cannot_become_review_or_sync_target(owner, tmp_path, synchronous):
    bid = create(owner, tmp_path)['id']
    for setting in ['review_enabled', 'is_repertoire', 'played']:
        assert owner.patch(f'/api/bases/{bid}', json={'settings': {setting: True}}).status_code == 400
    assert owner.patch(f'/api/bases/{bid}', json={'name': 'Nouvelle étiquette'}).status_code == 200
    assert owner.post(f'/api/bases/{bid}/import', json={'pgn': PGN}).status_code == 400
    response = owner.post('/api/sync/accounts', json={'site': 'lichess', 'username': 'alice', 'base_id': bid})
    assert response.status_code == 400, response.text


def test_position_search_spans_studies_and_index_and_reopens_exact_move(owner, tmp_path, synchronous):
    bid = create(owner, tmp_path)['id']
    study = owner.post('/api/bases', json={'name': 'Études'}).json()['id']
    owner.post('/api/entries', json={'base_id': study, 'pgn': PGN})
    board = chess.Board()
    board.push_san('e4')
    board.push_san('e5')
    result = owner.get('/api/library/position', params={'fen': board.fen(), 'offset': 1, 'limit': 1}).json()
    assert result['total_entries'] == 2 and not result['has_more']
    match = result['matches'][0]
    assert match['entry_id'].startswith('reference:')
    assert match['occurrences'][0]['path'] == '0.0'
    doc = owner.get(f'/api/reference-bases/{bid}/games/{match["reference_source"]["game_id"]}').json()
    node = next(node for node in doc['nodes'] if node['path'] == '0.0')
    assert node['fen'].split()[:4] == board.fen().split()[:4]
    assert result['reference_scope'] == 'mainline_first_occurrence'


def test_explorer_reads_index_and_deduplicates_study_copy(owner, tmp_path, synchronous):
    bid = create(owner, tmp_path)['id']
    study = owner.post('/api/bases', json={'name': 'Études'}).json()['id']
    owner.post('/api/entries', json={'base_id': study, 'pgn': PGN})
    response = owner.post('/api/explorer', json={'fen': chess.STARTING_FEN,
        'settings': {'source': 'local', 'base_ids': [bid, study], 'master_source': 'none'}})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data['primary']['total'] == 1
    assert data['moves'][0]['san'] == 'e4'


def test_complete_backup_restores_reference_and_streaming_export(owner, tmp_path, synchronous):
    bid = create(owner, tmp_path)['id']
    exported = owner.get(f'/api/bases/{bid}/export')
    assert exported.status_code == 200 and 'Alice' in exported.text and 'Plan' in exported.text
    response = owner.get('/api/backup?mode=full')
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read('metadata.json'))
        relative = 'references/' + manifest['reference_bases'][0]['storage_key'] + '.sqlite3'
        assert relative in archive.namelist()
        archive.extract(relative, tmp_path / 'restored')
        restored = tmp_path / 'restored' / relative
        assert store.list_games(restored)['total'] == 1
        assert 'Plan' in store.read_game(restored, 1)['pgn']
        with sqlite3.connect(restored) as conn:
            assert conn.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not list(tmp_path.glob('backup-*'))


def test_limited_import_continues_and_keeps_original(owner, tmp_path, synchronous):
    bid = create(owner, tmp_path, PGN + '\n' + PGN.replace('Alice', 'Carol'), max_games=1)['id']
    assert owner.get(f'/api/reference-bases/{bid}/status').json()['status'] == 'limited'
    owner.post(f'/api/reference-bases/{bid}/resume', json={})
    assert owner.get(f'/api/reference-bases/{bid}/games').json()['total'] == 2
    owner.post(f'/api/reference-bases/{bid}/resume', json={})
    assert owner.get(f'/api/reference-bases/{bid}/status').json()['status'] == 'completed'


def test_actual_subprocess_import_survives_api_navigation(owner, tmp_path):
    bid = create(owner, tmp_path)['id']
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        details = owner.get(f'/api/reference-bases/{bid}/status').json()
        assert owner.get('/api/library').status_code == 200
        if details['status'] in ('completed', 'error'):
            break
        time.sleep(.05)
    assert details['status'] == 'completed', details
    assert details['game_count'] == 1


def test_status_does_not_wait_for_worker_lock(owner, tmp_path, synchronous):
    bid = create(owner, tmp_path)['id']
    held, release = threading.Event(), threading.Event()
    def hold_worker_lock():
        with library._lock:
            held.set()
            release.wait(5)
    with ThreadPoolExecutor(max_workers=2) as pool:
        holder = pool.submit(hold_worker_lock)
        assert held.wait(2)
        try:
            result = pool.submit(library.get_status, bid).result(timeout=2)
            assert result['status'] == 'completed'
        finally:
            release.set()
        holder.result(timeout=2)


def test_active_reference_cannot_be_deleted_and_deleted_reference_cannot_restart(owner, tmp_path, synchronous):
    bid = create(owner, tmp_path)['id']
    class Active:
        def poll(self):
            return None
    key = (str(db.DB_PATH.resolve()), bid)
    library._processes[key] = Active()
    try:
        assert owner.delete(f'/api/bases/{bid}').status_code == 409
    finally:
        library._processes.pop(key)
    assert owner.delete(f'/api/bases/{bid}').status_code == 200
    assert owner.post(f'/api/reference-bases/{bid}/resume', json={}).status_code == 404


def test_worker_parent_guard_and_legacy_encoding(owner, tmp_path, synchronous):
    import os
    from reference_worker import parent_exit_check
    with parent_exit_check(os.getpid()) as exited:
        # On Windows the guard owns a live handle; Linux uses the worker's PPID.
        if os.name == 'nt':
            assert not exited()
    source = tmp_path / 'windows.pgn'
    source.write_bytes(PGN.replace('Alice', 'José').encode('cp1252'))
    response = owner.post('/api/reference-bases', json={'name': 'Windows', 'path': str(source), 'encoding': 'cp1252'})
    assert response.status_code == 200
    bid = response.json()['id']
    assert owner.get(f'/api/reference-bases/{bid}/games').json()['entries'][0]['headers']['White'] == 'José'
