"""Programs orchestrate native facts without inventing or double-counting work."""
import copy
import json
import sqlite3
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from local_test_client import TestClient
import pytest

import db
import training
import training_programs as programs
import training_activity as activity
import training_program_api as api
from accounts_api import require_user

NOW = datetime(2026, 10, 25, 16, tzinfo=timezone.utc)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'program.sqlite3')
    monkeypatch.setattr(programs, 'now', lambda: NOW)
    db.init_db()
    training.init_training()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users VALUES(1,'owner','unused','today')")
        programs.init_schema(conn)
        programs.init_schema(conn)
        conn.execute('INSERT INTO bases(id,name,settings,created_at) VALUES(1,?,?,?)',
                     ('Study', json.dumps({'review_enabled': True, 'reading_enabled': True}), 'today'))
        conn.execute("INSERT INTO entries(id,base_id,title,pgn,created_at,updated_at) VALUES(1,1,'Game','1. e4 e5 *','today','today')")
    app = FastAPI()
    app.include_router(api.router)
    app.dependency_overrides[require_user] = lambda: {'id': 1}
    with TestClient(app) as test_client:
        yield test_client


def request(client, method, path, body=None, status=200):
    if body is not None:
        body = {'mutation_id': str(uuid4()), **body}
    result = client.request(method, '/api/training' + path, json=body)
    assert result.status_code == status, result.text
    return result.json()


def block(activity='review', **patch):
    return {'id': str(uuid4()), 'title': 'My block', 'axis': 'Calcul', 'activity': activity,
            'resource': {'type': 'base', 'id': 1}, 'metric': 'minutes', 'target': 60,
            'unit': 'games' if activity == 'reading' else 'cards', 'session_minutes': 15,
            'unit_minutes': 2, 'priority': 'essential', 'notes': '', **patch}


def program(client, blocks=None):
    return request(client, 'POST', '/programs', {'name': 'Routine', 'definition': {'schema_version': 1,
        'budget_minutes': 240, 'intention': '', 'blocks': blocks if blocks is not None else [block()]}})


def activate(client, value):
    result = request(client, 'POST', f"/programs/{value['id']}/activate", {'effective': 'now', 'expected_revision': value['revision']})
    return result['week']


def run(client, week, index=0):
    return request(client, 'POST', f"/weeks/{week['id']}/blocks/{week['blocks'][index]['id']}/runs", {})


def review(conn, run_id=None, *, seconds=12, at=None, session='native', card_id='card'):
    conn.execute('''INSERT OR IGNORE INTO review_cards(id,base_id,entry_id,type,identity,path,fen,answers,title,updated_at)
        VALUES(?,1,1,'solve','key','','fen','[]','Tactic','today')''', (card_id,))
    history_id = conn.execute('''INSERT INTO review_history(card_id,reviewed_at,grade,proposed_grade,requested_grade,errors,hints,elapsed_ms,assisted,mode,interval_days,due)
        VALUES(?,?,2,2,2,0,0,?,0,'hybrid',5,'later')''', (card_id, at or programs.stamp(), seconds * 1000)).lastrowid
    card = conn.execute('SELECT * FROM review_cards WHERE id=?', (card_id,)).fetchone()
    key = str(uuid4())
    result = activity.record_review(conn, history_id=history_id, card=card, request_id=key, session_id=session, run_id=run_id)
    return result, history_id, card, key


def reading(conn, run_id=None, *, seconds=15, receipt=None, visit='visit-a', at=None, entry_id=1):
    entry = conn.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone()
    payload = {'active_seconds': seconds, 'request_id': receipt or str(uuid4()), 'visit_id': visit, 'training_run_id': run_id}
    return activity.record_reading(conn, entry=entry, payload=payload, recorded_at=at or programs.stamp())


def test_snapshot_estimate_and_idempotent_mutations(client):
    blocks = [block(target=60), block(metric='sessions', target=3), block('reading', metric='quantity', target=2, unit_minutes=20)]
    value = program(client, blocks)
    week = activate(client, value)
    assert week['planned_minutes'] == 145
    body = {'mutation_id': str(uuid4()), 'expected_revision': value['revision'], 'name': 'Changed', 'definition': value['definition']}
    result = request(client, 'PUT', '/programs/' + value['id'], body)
    retry = request(client, 'PUT', '/programs/' + value['id'], body)
    assert result == retry
    assert request(client, 'GET', '/weeks/' + week['id'])['name'] == 'Routine'
    request(client, 'PUT', '/programs/' + value['id'], {**body, 'name': 'Different'}, status=409)
    request(client, 'PUT', '/programs/' + value['id'], {**body, 'mutation_id': str(uuid4())}, status=409)


def test_week_summary_reads_resource_catalog_once_and_refreshes_between_calls(client):
    blocks = [block() for _ in range(25)]
    blocks.append(block('external', resource={'type': 'external', 'name': 'Book'}))
    week = activate(client, program(client, blocks))
    with db.get_conn() as conn:
        statements = []
        conn.set_trace_callback(statements.append)
        summary = activity.week_summary(conn, 1, week['id'])
        conn.set_trace_callback(None)
        assert len([sql for sql in statements if 'SELECT b.*,i.generation' in sql]) == 1
        assert all(item['available'] for item in summary['blocks'])
        assert summary['planned_minutes'] == 26 * 60

        conn.execute('UPDATE bases SET settings=? WHERE id=1', (json.dumps({'review_enabled': False}),))
        refreshed = activity.week_summary(conn, 1, week['id'])
        assert all(not item['available'] for item in refreshed['blocks'][:-1])
        assert refreshed['blocks'][-1]['available'] is True


def test_activation_checks_all_blocks_using_one_resource_catalog(client):
    unavailable = [block(resource={'type': 'base', 'id': 100 + index}) for index in range(25)]
    value = program(client, unavailable + [block()])
    with db.get_conn() as conn:
        statements = []
        conn.set_trace_callback(statements.append)
        week_id = programs.activate(conn, 1, value['id'], {'expected_revision': value['revision']})
        conn.set_trace_callback(None)
        assert week_id is not None
        assert len([sql for sql in statements if 'SELECT b.*,i.generation' in sql]) == 1


def test_readonly_bootstrap_and_pending_activation(client, monkeypatch):
    first = program(client)
    week = activate(client, first)
    second = program(client)
    request(client, 'POST', '/programs/' + second['id'] + '/activate', {'effective': 'next_week', 'expected_revision': 1})
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 16, tzinfo=timezone.utc))
    assert request(client, 'GET', '/state')['current_program_id'] == first['id']
    current = request(client, 'POST', '/weeks/current', {})
    assert current['active_program']['id'] == second['id']
    assert current['week']['week_start'] == '2026-10-26'
    assert request(client, 'GET', '/weeks/' + week['id'])['program_id'] == first['id']


def test_review_receipt_unique_cards_and_explicit_episode(client):
    week = activate(client, program(client, [block(metric='quantity', target=3)]))
    execution = run(client, week)
    with db.get_conn() as conn:
        credit, history_id, card, key = review(conn, execution['id'])
        assert activity.record_review(conn, history_id=history_id, card=card, request_id=key, run_id=execution['id']) == credit
        review(conn, execution['id'])
    result = request(client, 'GET', '/weeks/' + week['id'])
    progress = result['blocks'][0]['progress']
    assert progress['cards'] == 1 and progress['duration_ms'] == 24000 and progress['sessions'] == 0
    fresh = request(client, 'GET', '/runs/' + execution['id'])
    finished = request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'finish', 'expected_revision': fresh['revision']})
    assert finished['sessions'] == 1 and finished['duration_ms'] == 24000
    request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'finish', 'expected_revision': finished['revision']}, status=409)


def test_reading_multiple_visits_confirmation_and_no_empty_work(client):
    week = activate(client, program(client, [block('reading', metric='quantity', target=2)]))
    execution = run(client, week)
    request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'finish', 'expected_revision': 1}, status=409)
    with db.get_conn() as conn:
        assert reading(conn, execution['id'], seconds=0) is None
        first = reading(conn, execution['id'], receipt='receipt-0001')
        assert reading(conn, execution['id'], receipt='receipt-0001') == first
        reading(conn, execution['id'], visit='visit-b')
    fresh = request(client, 'GET', '/runs/' + execution['id'])
    assert fresh['duration_ms'] == 30000
    confirmed = request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'confirm_reading', 'entry_id': 1, 'expected_revision': fresh['revision']})
    again = request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'confirm_reading', 'entry_id': 1, 'expected_revision': confirmed['revision']})
    assert again['quantity'] == 1 and again['duration_ms'] == 30000


def test_acceptance_dates_cross_week_and_incompatible_resource(client, monkeypatch):
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences VALUES(?,?)', ('study_day', json.dumps({'timezone': 'America/Toronto', 'start_hour': 4})))
    value = program(client, [block('reading')])
    week = activate(client, value)
    execution = run(client, week)
    with db.get_conn() as conn:
        reading(conn, execution['id'], at='2026-10-26T07:59:00+00:00')
        reading(conn, execution['id'], at='2026-10-26T08:01:00+00:00')
    assert request(client, 'GET', '/weeks/' + week['id'])['duration_ms'] == 15000
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 16, tzinfo=timezone.utc))
    newer = request(client, 'POST', '/weeks/current', {})['week']
    assert newer['blocks'][0]['progress']['duration_ms'] == 15000
    changed = copy.deepcopy(newer['definition'])
    changed['blocks'][0]['resource'] = {'type': 'external', 'name': 'Paper book'}
    altered = request(client, 'PATCH', '/weeks/' + newer['id'], {'definition': changed, 'expected_revision': newer['revision']})
    assert altered['blocks'][0]['progress']['duration_ms'] is None
    assert altered['unmatched']['duration_ms'] == 15000


def test_free_assignment_moves_credit_without_changing_date(client):
    one, two = block(), block()
    week = activate(client, program(client, [one, two]))
    with db.get_conn() as conn:
        review(conn)
    free = request(client, 'GET', '/activities?unassigned=true')['items'][0]
    initial = free['first_at']
    first = request(client, 'PUT', '/activities/' + free['id'] + '/assignment', {'week_id': week['id'], 'block_id': one['id'], 'expected_revision': free['revision']})
    second = request(client, 'PUT', '/activities/' + free['id'] + '/assignment', {'week_id': week['id'], 'block_id': two['id'], 'expected_revision': first['revision']})
    assert second['first_at'] == initial
    summary = request(client, 'GET', '/weeks/' + week['id'])
    assert summary['duration_ms'] == 12000
    assert summary['blocks'][0]['progress']['duration_ms'] is None
    assert summary['blocks'][1]['progress']['duration_ms'] == 12000
    episode = request(client, 'POST', '/episodes', {'week_id': week['id'], 'block_id': two['id'], 'activity_ids': [free['id']]})
    assert episode['sessions'] == 1 and episode['duration_ms'] == 12000
    request(client, 'POST', '/episodes', {'week_id': week['id'], 'block_id': two['id'], 'activity_ids': [free['id']]}, status=409)


@pytest.mark.parametrize('invalid_identity', [{}, [], ['nested'], 1, 1.5, True, None])
def test_episode_rejects_malformed_activity_ids_without_writes(client, invalid_identity):
    week = activate(client, program(client))
    with db.get_conn() as conn:
        review(conn)
        free = activity.activities(conn, 1)[0]

    def saved_state():
        tables = ('training_runs', 'training_activity_links', 'training_activity_credits',
                  'training_mutation_receipts')
        with db.get_conn() as conn:
            return {table: [dict(row) for row in conn.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                    for table in tables}

    before = saved_state()
    request(client, 'POST', '/episodes', {'week_id': week['id'], 'block_id': week['blocks'][0]['id'],
            'activity_ids': [free['id'], invalid_identity]}, status=422)
    assert saved_state() == before


def test_manual_correction_delete_and_template_isolation(client):
    value = program(client, [block('external', resource={'type': 'external', 'name': 'Club'})])
    week = activate(client, value)
    item = request(client, 'POST', '/manual-activities', {'week_id': week['id'], 'block_id': week['blocks'][0]['id'], 'date': '2026-10-25', 'duration_minutes': 20, 'sessions': 1})
    assert item['duration_ms'] == 1200000
    changed = request(client, 'PATCH', '/manual-activities/' + item['id'], {'expected_revision': item['revision'], 'duration_minutes': 10})
    assert request(client, 'GET', '/weeks/' + week['id'])['duration_ms'] == 600000
    request(client, 'DELETE', '/manual-activities/' + item['id'], {'expected_revision': changed['revision']})
    assert request(client, 'GET', '/weeks/' + week['id'])['duration_ms'] is None
    template = request(client, 'POST', '/templates', {'name': 'My template', 'definition': value['definition']})
    request(client, 'PUT', '/templates/' + template['id'], {'name': 'Changed template', 'definition': {**value['definition'], 'blocks': []}, 'expected_revision': template['revision']})
    assert request(client, 'GET', '/programs/' + value['id'])['definition']['blocks']


def test_deleting_base_preserves_credit_and_prevents_id_reuse(client):
    value = program(client)
    week = activate(client, value)
    execution = run(client, week)
    with db.get_conn() as conn:
        review(conn, execution['id'])
        old = conn.execute('SELECT generation FROM training_resource_identity WHERE base_id=1').fetchone()[0]
        conn.execute('DELETE FROM bases WHERE id=1')
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(1,'Replacement','{}','today')")
        new = conn.execute('SELECT generation FROM training_resource_identity WHERE base_id=1').fetchone()[0]
    assert old != new
    summary = request(client, 'GET', '/weeks/' + week['id'])
    assert summary['duration_ms'] == 12000
    assert not summary['blocks'][0]['available']
    request(client, 'POST', f"/weeks/{week['id']}/blocks/{week['blocks'][0]['id']}/runs", {}, status=409)


def test_hook_rollback_and_empty_context_validation(client):
    week = activate(client, program(client, [block('reading')]))
    execution = run(client, week)
    with pytest.raises(RuntimeError):
        with db.get_conn() as conn:
            reading(conn, execution['id'])
            raise RuntimeError('force rollback')
    assert request(client, 'GET', '/runs/' + execution['id'])['duration_ms'] is None
    with db.get_conn() as conn:
        with pytest.raises(HTTPException):
            reading(conn, 'missing', seconds=0)
    cancelled = request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'cancel', 'expected_revision': execution['revision']})
    assert cancelled['state'] == 'cancelled'
    assert request(client, 'GET', '/state')['active_runs'] == []


def test_authentication_and_preview_are_readonly(client):
    week = activate(client, program(client))
    with db.get_conn() as conn:
        before = conn.total_changes
        conn.execute('PRAGMA query_only=ON')
        result = activity.preview(conn, 1, week['id'], 30)
        assert result['allocated_minutes'] == 15
        assert conn.total_changes == before
    client.app.dependency_overrides.clear()
    assert client.get('/api/training/state', headers={'Host': 'remote.example'}).status_code == 403


def test_owner_scope_backup_and_schema_rollback(client, tmp_path):
    value = program(client)
    week = activate(client, value)
    execution = run(client, week)
    with db.get_conn() as conn:
        review(conn, execution['id'])
        with pytest.raises(HTTPException) as denied:
            programs.get_program(conn, 2, value['id'])
        assert denied.value.status_code == 404
        with pytest.raises(HTTPException):
            activity.validate_run(conn, 2, execution['id'], 'review', base_id=1)
    destination = tmp_path / 'backup.sqlite3'
    with db.get_conn() as source, sqlite3.connect(destination) as target:
        source.backup(target)
    with sqlite3.connect(destination) as restored:
        assert restored.execute('SELECT COUNT(*) FROM training_programs').fetchone()[0] == 1
        assert restored.execute('SELECT SUM(duration_ms) FROM training_activity_credits').fetchone()[0] == 12000
        assert restored.execute('PRAGMA foreign_key_check').fetchall() == []
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute("INSERT INTO preferences VALUES('training-rollback','1')")
        programs.init_schema(conn)
        conn.rollback()
        assert conn.execute("SELECT 1 FROM preferences WHERE key='training-rollback'").fetchone() is None


def test_reused_history_identifier_does_not_reopen_deleted_source(client):
    week = activate(client, program(client))
    with db.get_conn() as conn:
        _, old_id, _, _ = review(conn)
        old_link = conn.execute('SELECT id FROM training_activity_links WHERE review_history_id=?', (old_id,)).fetchone()[0]
        conn.execute('DELETE FROM review_history WHERE id=?', (old_id,))
        _, new_id, _, _ = review(conn)
        assert new_id == old_id
        assert activity.activity_document(conn, 1, old_link)['history'] is None
        assert conn.execute('SELECT COUNT(*) FROM training_activity_credits').fetchone()[0] == 2


def test_late_reading_receipt_keeps_pause_and_credit_day(client):
    week = activate(client, program(client, [block('reading')]))
    execution = run(client, week)
    paused = request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'pause', 'expected_revision': execution['revision']})
    with db.get_conn() as conn:
        original = reading(conn, execution['id'], receipt='late-unique', at='2026-10-25T23:59:00+00:00')
        repeated = reading(conn, execution['id'], receipt='late-unique', at='2026-10-26T00:01:00+00:00')
        assert original == repeated
        assert conn.execute('SELECT study_date FROM training_activity_credits WHERE id=?', (original,)).fetchone()[0] == '2026-10-25'
    after = request(client, 'GET', '/runs/' + execution['id'])
    assert after['state'] == 'paused' and after['revision'] == paused['revision']


def test_definition_validation_and_current_edit_are_explicit(client):
    value = program(client)
    week = activate(client, value)
    body = {'name': 'Revised', 'definition': value['definition'], 'expected_revision': value['revision'], 'apply_to_current': 'false'}
    request(client, 'PUT', '/programs/' + value['id'], body, status=422)
    body['apply_to_current'] = True
    request(client, 'PUT', '/programs/' + value['id'], body)
    assert request(client, 'GET', '/weeks/' + week['id'])['name'] == 'Revised'
    wrong = copy.deepcopy(value['definition'])
    wrong['blocks'].append(copy.deepcopy(wrong['blocks'][0]))
    request(client, 'POST', '/programs', {'name': 'Duplicate', 'definition': wrong}, status=422)


def test_old_run_after_program_switch_remains_visible_without_filling_new_goal(client, monkeypatch):
    first = program(client, [block('reading')])
    old_week = activate(client, first)
    execution = run(client, old_week)
    with db.get_conn() as conn:
        reading(conn, execution['id'], seconds=15, at='2026-10-25T12:00:00+00:00')
    second = program(client, [block('reading')])
    request(client, 'POST', '/programs/' + second['id'] + '/activate', {'effective': 'next_week', 'expected_revision': second['revision']})
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 16, tzinfo=timezone.utc))
    current = request(client, 'POST', '/weeks/current', {})['week']
    with db.get_conn() as conn:
        reading(conn, execution['id'], seconds=30, at='2026-10-26T12:00:00+00:00')
    result = request(client, 'GET', '/weeks/' + current['id'])
    assert result['blocks'][0]['progress']['realized'] == 0
    assert result['other_duration_ms'] == 30000
    assert result['other_activities'][0]['duration_ms'] == 30000
    assert result['other_activities'][0]['scope_week'] == '2026-10-26'
    assert request(client, 'GET', '/weeks/' + old_week['id'])['activities'][0]['duration_ms'] == 15000
    assert request(client, 'GET', '/summary?date_from=2026-10-25&date_to=2026-10-26')['duration_ms'] == 45000
