"""Consultation status is durable, explicit, and independent of review progress."""
import json

import pytest
from local_test_client import TestClient

import app
import entries_api
import db
import jobs
import training

PGN = '[Event "Cours"]\n\n1. e4 {Commentaire} e5 (1... c5) 2. Nf3 *'


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'seen.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)


@pytest.fixture
def owner(database):

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        ok(client.get('/api/status'))
        yield client


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def base(owner, name='Cours', **settings):
    return ok(owner.post('/api/bases', json={'name': name, 'settings': {
        'review_enabled': True, 'type': 'solve', **settings}}))['id']


def entry(owner, bid):
    return ok(owner.post('/api/entries', json={'base_id': bid, 'pgn': PGN}))


def saved(owner, eid):
    return ok(owner.get(f'/api/entries/{eid}'))


def queue(owner, bid):
    return ok(owner.get(f'/api/bases/{bid}/queue?all=true'))['cards']


def rows(table):
    with db.get_conn() as conn:
        return [dict(row) for row in conn.execute(f'SELECT * FROM {table}')]


def assert_new(value):
    assert value['is_new'] is True
    assert value['seen_at'] is None


def test_reads_lists_export_queue_and_background_analysis_do_not_mark(owner):
    bid = base(owner, played=True)
    item = entry(owner, bid)
    eid = item['id']
    assert_new(item)
    assert_new(saved(owner, eid))
    for route in (f'/api/bases/{bid}/entries', '/api/entries', '/api/entries?played=true'):
        assert_new(ok(owner.get(route))['entries'][0])
    assert owner.get(f'/api/bases/{bid}/export').status_code == 200
    assert queue(owner, bid)
    ok(owner.get('/api/reviews'))
    ok(owner.get(f'/api/game-analysis/{eid}'))
    ok(owner.post(f'/api/game-analysis/{eid}', json={}))
    assert_new(saved(owner, eid))


def test_mark_is_idempotent_persistent_and_does_not_edit_content_or_progress(owner, monkeypatch):
    bid = base(owner)
    item = entry(owner, bid)
    eid = item['id']
    queue(owner, bid)
    unchanged = {table: rows(table) for table in ('entry_history', 'review_cards', 'review_history')}
    monkeypatch.setattr(entries_api, 'now', lambda: '2026-10-21T12:00:00+00:00')
    result = ok(owner.post(f'/api/entries/{eid}/seen', json={}))
    assert result == {'seen_at': '2026-10-21T12:00:00+00:00', 'is_new': False}
    monkeypatch.setattr(entries_api, 'now', lambda: '2026-10-22T12:00:00+00:00')
    assert ok(owner.post(f'/api/entries/{eid}/seen', json={})) == result
    db.init_db()
    after = saved(owner, eid)
    for key in ('pgn', 'title', 'start_path', 'selected', 'updated_at', 'created_at', 'history'):
        assert after[key] == item[key]
    assert after['seen_at'] == result['seen_at'] and after['is_new'] is False
    assert {table: rows(table) for table in unchanged} == unchanged
    assert ok(owner.get(f'/api/bases/{bid}/entries'))['entries'][0]['is_new'] is False


def test_mark_requires_account_same_origin_and_existing_entry(owner):
    item = entry(owner, base(owner))
    route = f'/api/entries/{item["id"]}/seen'
    assert owner.post(route, json={}, headers={'Origin': 'https://other.example'}).status_code == 403
    assert owner.post('/api/entries/999999/seen', json={}).status_code == 404
    assert_new(saved(owner, item['id']))
    owner.cookies.clear()
    assert owner.post(route, json={}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert rows('entries')[0]['seen_at'] is None


@pytest.mark.parametrize('operation', ['grade', 'master'])
@pytest.mark.parametrize('kind', ['solve', 'moves', 'play'])
def test_successful_review_or_mastery_marks_only_source_entry(owner, operation, kind):
    bid = base(owner, type=kind)
    first = entry(owner, bid)
    other = entry(owner, bid)
    card = next(card for card in queue(owner, bid) if card['entry_id'] == first['id'])
    # A failed answer still means the person reviewed the card.
    ok(owner.post(f'/api/reviews/{card["id"]}/{operation}', json={'grade': 0} if operation == 'grade' else {}))
    assert saved(owner, first['id'])['is_new'] is False
    assert_new(saved(owner, other['id']))
    assert len(rows('review_history')) == (1 if operation == 'grade' else 0)


@pytest.mark.parametrize('operation', ['grade', 'master'])
def test_rejected_review_does_not_mark(owner, operation):
    bid = base(owner)
    item = entry(owner, bid)
    card = queue(owner, bid)[0]
    ok(owner.patch(f'/api/entries/{item["id"]}', json={'selected': False}))
    result = owner.post(f'/api/reviews/{card["id"]}/{operation}', json={'grade': 2} if operation == 'grade' else {})
    assert result.status_code == 409
    assert_new(saved(owner, item['id']))
    assert rows('review_history') == []


def test_invalid_grade_does_not_mark(owner):
    bid = base(owner)
    item = entry(owner, bid)
    card = queue(owner, bid)[0]
    assert owner.post(f'/api/reviews/{card["id"]}/grade', json={'grade': 99}).status_code == 422
    assert_new(saved(owner, item['id']))


def test_move_edit_undo_redo_preserve_seen_but_duplicate_and_import_start_new(owner):
    source, target = base(owner), base(owner, 'Destination')
    item = entry(owner, source)
    eid = item['id']
    seen = ok(owner.post(f'/api/entries/{eid}/seen', json={}))['seen_at']
    edited = ok(owner.patch(f'/api/entries/{eid}/node', json={'explicit_save': True, 'path': '0', 'comment': 'Note éditée'}))
    assert edited['seen_at'] == seen
    for action in ('undo', 'redo'):
        result = ok(owner.post(f'/api/entries/{eid}/{action}', json={'explicit_save': True}))
        assert result['entry']['seen_at'] == seen
    ok(owner.post(f'/api/bases/{source}/entries/batch', json={
        'action': 'move', 'entry_ids': [eid], 'target_base_id': target}))
    assert saved(owner, eid)['seen_at'] == seen
    duplicated = ok(owner.post(f'/api/bases/{target}/entries/batch', json={
        'action': 'duplicate', 'entry_ids': [eid]}))
    assert_new(saved(owner, duplicated['entry_ids'][0]))
    ok(owner.post(f'/api/bases/{source}/import', json={'pgn': PGN}))
    assert_new(ok(owner.get(f'/api/bases/{source}/entries'))['entries'][0])


@pytest.mark.parametrize('stable_ids', [False, True])
def test_legacy_migration_recovers_review_evidence_once_without_content_changes(database, stable_ids):
    auto = ' AUTOINCREMENT' if stable_ids else ''
    with db.get_conn() as conn:
        conn.executescript(f'''
        CREATE TABLE bases (id INTEGER PRIMARY KEY, name TEXT NOT NULL, folder_id INTEGER,
            tags TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{{}}', created_at TEXT NOT NULL);
        CREATE TABLE entries (id INTEGER PRIMARY KEY{auto}, base_id INTEGER NOT NULL REFERENCES bases(id),
            title TEXT NOT NULL, pgn TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1,
            start_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        ''')
        settings = json.dumps({'review_enabled': True, 'type': 'solve'})
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(7,'Cours',?,'2026-10-01')", (settings,))
        for eid in (41, 42, 43, 44):
            conn.execute('INSERT INTO entries(id,base_id,title,pgn,created_at,updated_at) VALUES(?,7,?,?,?,?)',
                         (eid, f'Partie {eid}', PGN, '2026-10-01', '2026-10-02'))
    training.init_training()
    with db.get_conn() as conn:
        training._sync_base(conn, conn.execute('SELECT * FROM bases WHERE id=7').fetchone())
        conn.execute("UPDATE review_cards SET state='learned',repetitions=2,updated_at='2026-10-20' WHERE entry_id=41")
        conn.execute("UPDATE review_cards SET state='mastered',updated_at='2026-10-12' WHERE entry_id=42")
        # No evidence for a historical analysis opening; the bare state is not proof.
        conn.execute("UPDATE review_cards SET state='learning' WHERE entry_id=44")
        card_id = conn.execute('SELECT id FROM review_cards WHERE entry_id=41').fetchone()[0]
        for day in ('2026-10-15', '2026-10-11'):
            conn.execute('''INSERT INTO review_history(card_id,reviewed_at,grade,proposed_grade,requested_grade,
                errors,hints,elapsed_ms,assisted,mode,interval_days,due)
                VALUES(?,?,2,2,2,0,0,5000,0,'hybrid',3,'2026-10-24')''', (card_id, day))
    before = {table: rows(table) for table in ('entries', 'review_cards', 'review_history')}
    db.init_db()
    db.init_db()
    after = rows('entries')
    assert {row['id']: row['seen_at'] for row in after} == {41: '2026-10-11', 42: '2026-10-12', 43: None, 44: None}
    assert [{key: value for key, value in row.items() if key != 'seen_at'} for row in after] == before['entries']
    assert rows('review_cards') == before['review_cards']
    assert rows('review_history') == before['review_history']
    with db.get_conn() as conn:
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
        conn.execute("UPDATE review_cards SET state='mastered' WHERE entry_id=43")
    db.init_db()
    assert next(row for row in rows('entries') if row['id'] == 43)['seen_at'] is None
