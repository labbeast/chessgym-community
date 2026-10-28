"""Reading bookmarks track only the saved main line, independently of reviews."""
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest
from local_test_client import TestClient

import app
import db
import jobs
import reading_progress
import entry_catalog

PGN = '[Event "Cours"]\n\n1. e4 {Texte} (1. d4 d5 2. c4) e5 2. Nf3 Nc6 3. Bb5 a6 *'


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
def owner(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'reading.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        ok(client.get('/api/status'))
        yield client


def base(owner, **settings):
    return ok(owner.post('/api/bases', json={'name': 'Cours', 'settings': {'reading_enabled': True, **settings}}))['id']


def entry(owner, bid, pgn=PGN):
    return ok(owner.post('/api/entries', json={'base_id': bid, 'pgn': pgn}))


def state(owner, eid):
    return ok(owner.get(f'/api/entries/{eid}/reading'))


def visit(owner, eid, plies, **kwargs):
    return ok(owner.post(f'/api/entries/{eid}/reading', json={'path': reading_progress.path_for(plies), **kwargs}))


def dashboard(owner):
    return ok(owner.get('/api/reading'))['bases']


@pytest.mark.parametrize('chapters', [1, 20])
def test_base_summary_batches_bookmarks_and_keeps_projection_read_only(owner, chapters):
    bid = base(owner)
    items = [entry(owner, bid)['id'] for _ in range(chapters)]
    visit(owner, items[0], 6, active_seconds=40, request_id='summary-time-1')
    diagram = entry(owner, bid, '[Event "Diagramme"]\n\n*')['id']
    visit(owner, diagram, 0)
    with db.get_conn() as conn:
        # A source edit projects the bookmark onto the surviving prefix without
        # persisting that reconciliation during a dashboard read.
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. e4 e5 2. Bc4 *', items[0]))
    entry_catalog.prepare(base_ids=[bid])
    with db.get_conn() as conn:
        saved_base = conn.execute('SELECT * FROM bases WHERE id=?', (bid,)).fetchone()
        before = conn.total_changes
        statements = []
        conn.set_trace_callback(statements.append)
        summary = reading_progress.base_summary(conn, saved_base)
        conn.set_trace_callback(None)
        assert conn.total_changes == before
        assert len(statements) == 2
        assert sum('reading_progress' in sql for sql in statements) == 1
        assert summary['total_entries'] == chapters + 1
        assert summary['total_moves'] == 3 + (chapters - 1) * 6
        assert summary['read_moves'] == 2
        assert summary['read_units'] == 3
        assert summary['completed_entries'] == 1
        assert summary['active_seconds'] == 40
        saved = conn.execute('SELECT read_moves FROM reading_progress WHERE entry_id=?', (items[0],)).fetchone()
        assert saved['read_moves'] == 6


@pytest.mark.parametrize('replacement', [
    PGN.replace('{Texte}', '{Nouvelle annotation}'),
    '1. e4 e5 2. Bc4 Nc6 *',
    '1. e4 *',
    '[FEN "7k/8/8/8/8/8/8/K7 w - - 0 1"]\n[SetUp "1"]\n\n*',
])
def test_readonly_projection_matches_saved_reconciliation_after_external_edit(owner, replacement):
    eid = entry(owner, base(owner))['id']
    visit(owner, eid, 4, active_seconds=40, request_id='projection-time')
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', (replacement, eid))
    with db.get_conn() as conn:
        before = dict(conn.execute('SELECT * FROM reading_progress WHERE entry_id=?', (eid,)).fetchone())
        saved = conn.execute('SELECT * FROM entries WHERE id=?', (eid,)).fetchone()
        derived = entry_catalog.derived(saved)
        projected = reading_progress.catalog_summary(conn, saved, derived)
        assert dict(conn.execute('SELECT * FROM reading_progress WHERE entry_id=?', (eid,)).fetchone()) == before
        reconciled = reading_progress.entry_summary(conn, saved)
        assert reconciled == projected
        assert reconciled['active_seconds'] == 40


def test_opt_in_preserves_state_across_toggle_and_restart(owner):
    bid = base(owner, reading_enabled=False)
    item = entry(owner, bid)
    assert item['reading']['enabled'] is False
    assert dashboard(owner) == []
    assert owner.post(f'/api/entries/{item["id"]}/reading', json={'path': '0'}).status_code == 409
    ok(owner.patch(f'/api/bases/{bid}', json={'settings': {'reading_enabled': True}}))
    assert visit(owner, item['id'], 3)['percent'] == 50
    ok(owner.patch(f'/api/bases/{bid}', json={'settings': {'reading_enabled': False}}))
    assert dashboard(owner) == []
    db.init_db()
    ok(owner.patch(f'/api/bases/{bid}', json={'settings': {'reading_enabled': True}}))
    assert state(owner, item['id'])['read_moves'] == 3


def test_visits_never_recede_and_skip_variations(owner):
    bid = base(owner)
    eid = entry(owner, bid)['id']
    far = visit(owner, eid, 4)
    assert far['bookmark_path'] == '0.0.0.0' and far['percent'] == 66.7
    assert visit(owner, eid, 1)['read_moves'] == 4
    result = ok(owner.post(f'/api/entries/{eid}/reading', json={'path': '1.0.0', 'active_seconds': 60, 'request_id': 'variation-ignored'}))
    assert result['read_moves'] == 4 and result['active_seconds'] == 0
    assert owner.post(f'/api/entries/{eid}/reading', json={'path': '1', 'mode': 'bookmark'}).status_code == 400
    assert state(owner, eid)['read_moves'] == 4


def test_explicit_bookmark_recedes_and_retries_do_not_undo_progress(owner):
    eid = entry(owner, base(owner))['id']
    far = visit(owner, eid, 6)
    rewind = visit(owner, eid, 2, mode='bookmark', request_id='bookmark-123', revision=far['revision'])
    assert rewind['read_moves'] == 2 and rewind['completed'] is False
    assert rewind['revision'] == far['revision'] + 1
    stale = owner.post(f'/api/entries/{eid}/reading', json={'path': '0.0.0.0.0.0', 'revision': far['revision']})
    assert stale.status_code == 409
    visit(owner, eid, 4)
    assert visit(owner, eid, 2, mode='bookmark', request_id='bookmark-123')['read_moves'] == 4


def test_time_receipts_estimate_and_bulk_marking(owner):
    bid = base(owner)
    eid = entry(owner, bid)['id']
    first = visit(owner, eid, 2, active_seconds=20, request_id='reading-time-1')
    assert first['active_seconds'] == 20
    assert visit(owner, eid, 2, active_seconds=20, request_id='reading-time-1')['active_seconds'] == 20
    assert dashboard(owner)[0]['remaining_seconds'] is None
    visit(owner, eid, 3, active_seconds=10, request_id='reading-time-2')
    summary = dashboard(owner)[0]
    assert summary['active_seconds'] == 30 and summary['remaining_seconds'] == 30
    read = ok(owner.post(f'/api/bases/{bid}/reading', json={'action': 'read'}))
    assert read['percent'] == 100 and read['completed_entries'] == 1 and read['remaining_seconds'] == 0
    assert read['active_seconds'] == 30
    unread = ok(owner.post(f'/api/bases/{bid}/reading', json={'action': 'unread'}))
    assert unread['percent'] == 0 and unread['active_seconds'] == 30
    # Marking an unread book complete does not invent time/pace measurements.
    other = base(owner)
    entry(owner, other)
    ok(owner.post(f'/api/bases/{other}/reading', json={'action': 'read'}))
    reset = ok(owner.post(f'/api/bases/{other}/reading', json={'action': 'unread'}))
    assert reset['remaining_seconds'] is None and reset['active_seconds'] == 0


def test_mainline_edits_reconcile_common_prefix_and_annotations_preserve(owner):
    eid = entry(owner, base(owner))['id']
    prior = visit(owner, eid, 6)
    annotation = ok(owner.patch(f'/api/entries/{eid}/node', json={'explicit_save': True, 'path': '0', 'comment': 'Nouvelle note'}))
    assert annotation['reading']['completed'] is True
    assert annotation['reading']['revision'] == prior['revision']
    # The mainline diverges after move 2, so later read moves cannot transfer.
    changed = ok(owner.patch(f'/api/entries/{eid}', json={'explicit_save': True, 'pgn': '1. e4 e5 2. Bc4 Nc6 *'}))
    assert changed['reading']['read_moves'] == 2
    assert changed['reading']['total_moves'] == 4
    assert changed['reading']['revision'] == prior['revision'] + 1
    stale = owner.post(f'/api/entries/{eid}/reading', json={'path': '0.0', 'content_key': prior['content_key']})
    assert stale.status_code == 409
    assert owner.post(f'/api/entries/{eid}/reading', json={'path': '0', 'fen': 'wrong'}).status_code == 409
    # An unrelated starting diagram resets reading completely.
    changed = ok(owner.patch(f'/api/entries/{eid}', json={'explicit_save': True, 'pgn': '[SetUp "1"]\n[FEN "8/8/8/8/8/5k2/8/4K3 w - - 0 1"]\n\n*'}))
    assert changed['reading']['percent'] == 0 and changed['reading']['visited'] is False


def test_external_writes_are_reconciled_without_editor_hooks(owner):
    eid = entry(owner, base(owner))['id']
    visit(owner, eid, 6)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. e4 e5 2. Nf3 *', eid))
    assert state(owner, eid)['read_moves'] == 3
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. d4 d5 *', eid))
    assert dashboard(owner)[0]['read_moves'] == 0


def test_parallel_first_read_and_visit_create_one_state_without_regression(owner):
    bid = base(owner)
    for _ in range(4):
        eid = entry(owner, bid)['id']
        with db.get_conn() as conn:
            conn.execute('DELETE FROM reading_progress WHERE entry_id=?', (eid,))
        start = Barrier(3)

        def first_read():
            start.wait(timeout=5)
            return owner.get('/api/reading')

        def first_visit():
            start.wait(timeout=5)
            return owner.post(f'/api/entries/{eid}/reading', json={'path': '0.0.0'})

        with ThreadPoolExecutor(max_workers=2) as pool:
            reads, visits = pool.submit(first_read), pool.submit(first_visit)
            start.wait(timeout=5)
            ok(reads.result(timeout=10))
            assert ok(visits.result(timeout=10))['read_moves'] == 3
        assert state(owner, eid)['read_moves'] == 3
        with db.get_conn() as conn:
            assert conn.execute('SELECT count(*) FROM reading_progress WHERE entry_id=?', (eid,)).fetchone()[0] == 1


def test_stale_entry_snapshot_cannot_reconcile_new_saved_mainline_backwards(owner):
    eid = entry(owner, base(owner))['id']
    visit(owner, eid, 6)
    with db.get_conn() as conn:
        old_snapshot = dict(conn.execute('SELECT * FROM entries WHERE id=?', (eid,)).fetchone())
    edited = ok(owner.patch(f'/api/entries/{eid}', json={'explicit_save': True, 'pgn': '1. e4 e5 2. Bc4 Nc6 *'}))
    assert edited['reading']['read_moves'] == 2
    latest = visit(owner, eid, 4)
    with db.get_conn() as conn:
        summary = reading_progress.entry_summary(conn, old_snapshot)
        assert summary['read_moves'] == 4
        assert summary['content_key'] == latest['content_key']
        assert summary['revision'] == latest['revision']
    assert state(owner, eid)['completed'] is True


def test_weighted_progress_zero_move_chapters_and_continue(owner):
    bid = base(owner)
    first = entry(owner, bid)
    second = entry(owner, bid, '1. d4 d5 *')
    chapter = entry(owner, bid, '{Introduction du cours} *')
    summary = dashboard(owner)[0]
    assert summary['total_moves'] == 8 and summary['total_units'] == 9
    assert summary['continue_entry_id'] == first['id'] and summary['continue_path'] == ''
    visit(owner, first['id'], 6)
    summary = dashboard(owner)[0]
    assert summary['percent'] == 66.7
    assert summary['last_entry_id'] == first['id'] and summary['last_path'] == '0.0.0.0.0.0'
    assert summary['continue_entry_id'] == second['id']
    visit(owner, second['id'], 1)
    assert dashboard(owner)[0]['continue_path'] == '0'
    visit(owner, second['id'], 2)
    assert dashboard(owner)[0]['continue_entry_id'] == chapter['id']
    assert visit(owner, chapter['id'], 0)['completed'] is True
    summary = dashboard(owner)[0]
    assert summary['percent'] == 100 and summary['completed_entries'] == 3
    assert summary['continue_entry_id'] is None and summary['remaining_seconds'] == 0


def test_lists_include_progress_moves_preserve_duplicates_reset_deletes_cascade(owner):
    source, target = base(owner), base(owner)
    eid = entry(owner, source)['id']
    visit(owner, eid, 4, active_seconds=10, request_id='persisted-time')
    for route in (f'/api/bases/{source}/entries', '/api/entries'):
        assert ok(owner.get(route))['entries'][0]['reading']['read_moves'] == 4
    duplicate = ok(owner.post(f'/api/bases/{source}/entries/batch', json={'action': 'duplicate', 'entry_ids': [eid], 'target_base_id': target}))
    assert state(owner, duplicate['entry_ids'][0])['percent'] == 0
    ok(owner.post(f'/api/bases/{source}/entries/batch', json={'action': 'move', 'entry_ids': [eid], 'target_base_id': target}))
    assert state(owner, eid)['read_moves'] == 4 and state(owner, eid)['base_id'] == target
    assert dashboard(owner)[0]['total_entries'] == 0
    ok(owner.delete(f'/api/entries/{eid}'))
    with db.get_conn() as conn:
        assert conn.execute('SELECT * FROM reading_progress WHERE entry_id=?', (eid,)).fetchone() is None
        assert conn.execute('SELECT * FROM reading_receipts WHERE entry_id=?', (eid,)).fetchone() is None


def test_auth_validation_reference_exclusion_and_no_content_changes(owner, monkeypatch):
    bid = base(owner)
    item = entry(owner, bid)
    eid = item['id']
    for payload in ({'active_seconds': 61}, {'active_seconds': True}, {'active_seconds': 1}, {'path': '99'}, {'mode': 'invalid'}, {'request_id': 'x'}):
        assert owner.post(f'/api/entries/{eid}/reading', json=payload).status_code == 400
    assert owner.patch(f'/api/bases/{bid}', json={'settings': {'reading_enabled': 'yes'}}).status_code == 400
    assert owner.post(f'/api/entries/{eid}/reading', json={'path': '0'}, headers={'Origin': 'https://elsewhere.example'}).status_code == 403
    visit(owner, eid, 3)
    after = ok(owner.get(f'/api/entries/{eid}'))
    for key in ('pgn', 'title', 'start_path', 'selected', 'updated_at', 'created_at', 'history', 'is_new'):
        assert item[key] == after[key]
    with db.get_conn() as conn:
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source) VALUES(?,?,?)', (bid, 'never-opened', 'missing.pgn'))
    # Even corrupted/legacy enabled settings must not scan a reference store.
    assert dashboard(owner) == []
    assert state(owner, eid)['enabled'] is False
    assert owner.post(f'/api/bases/{bid}/reading', json={'action': 'read'}).status_code == 409
    owner.cookies.clear()
    for route in ('/api/reading', f'/api/entries/{eid}/reading'):
        assert owner.get(route, headers={'Host': 'remote.invalid'}).status_code == 403
    assert owner.post(f'/api/entries/{eid}/reading', json={'path': '0'}, headers={'Host': 'remote.invalid'}).status_code == 403
