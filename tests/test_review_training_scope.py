"""Period choices rebase review limits without replacing native progress."""
import json
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

import db
import review_sessions as sessions
from test_training_programs import client, request, block, program, activate, review


def prepare(client, *, metric='minutes', target=20, scoped=True, scope='today', allowance=None):
    with db.get_conn() as conn:
        conn.executemany('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(1,?,?,?,?)',
                         ((f'Extra {i}', '1. e4 e5 *', 'today', 'today') for i in range(7)))
    week = activate(client, program(client, [block(metric=metric, target=target)]))
    run = request(client, 'POST', f"/weeks/{week['id']}/blocks/{week['blocks'][0]['id']}/runs",
                  {'goal_scope': scope} if scoped else {})
    native = sessions.create_daily(sessions.CreateDailySession(
        base_ids=[1], selection='both', goal={'minutes': None, 'cards': allowance},
        request_id=uuid4(), training_run_id=UUID(run['id'])))
    return request(client, 'GET', '/runs/' + run['id']), native


def answer_native(run, native, *, seconds=180):
    with db.get_conn() as conn:
        card = native['cards'][0]
        review(conn, run['id'], seconds=seconds, session=native['session_id'], card_id=card['id'])
        conn.execute('UPDATE review_session_items SET completed_at=?,elapsed_ms=? WHERE session_id=? AND position=?',
                     ('2026-10-25T16:00:00Z', seconds * 1000, native['session_id'], card['session_index']))


def choose(client, run, scope):
    current = request(client, 'GET', '/runs/' + run['id'])
    return request(client, 'PATCH', '/runs/' + run['id'],
                   {'action': 'resume', 'goal_scope': scope, 'expected_revision': current['revision']})


def test_new_scoped_review_uses_exact_server_limit_without_truncating_queue(client):
    # The weekly target can be fractional; the independent daily target is the
    # block's 15-minute session duration.
    run, native = prepare(client, target=.25, scope='week')
    assert native['goal'] == {'minutes': .25, 'cards': None}
    assert native['total'] == 8
    assert run['launch']['review_goal'] == native['goal']
    assert run['native_ref']['id'] == native['session_id']


def test_week_retarget_preserves_native_elapsed_and_only_rebases_threshold(client):
    run, native = prepare(client)
    answer_native(run, native)
    before = request(client, 'GET', '/runs/' + run['id'])
    updated = choose(client, run, 'week')
    assert updated['native_ref'] == run['native_ref']
    assert updated['duration_ms'] == before['duration_ms'] == 180000
    assert updated['quantity'] == before['quantity'] == 1
    assert updated['launch']['goal']['remaining'] == 17
    assert updated['launch']['review_goal'] == {'minutes': 20, 'cards': None}
    restored = sessions.get_session(UUID(native['session_id']), 0, 100)
    assert restored['goal'] == updated['launch']['review_goal']
    assert restored['completed'] == 1 and restored['elapsed_ms'] == 180000


def test_legacy_card_limited_session_extends_without_repeating_or_reordering_members(client):
    run, native = prepare(client, metric='quantity', target=4, scoped=False, allowance=2)
    assert native['total'] == 2
    answer_native(run, native)
    with db.get_conn() as conn:
        original = [tuple(row) for row in conn.execute(
            'SELECT position,card_id,completed_at,elapsed_ms FROM review_session_items WHERE session_id=? ORDER BY position', (native['session_id'],))]
        credit_count = conn.execute('SELECT COUNT(*) FROM training_activity_credits').fetchone()[0]
    updated = choose(client, run, 'today')
    assert updated['native_ref']['id'] == native['session_id']
    assert updated['launch']['goal']['remaining'] == 3
    assert updated['launch']['review_goal'] == {'minutes': None, 'cards': 4}
    with db.get_conn() as conn:
        members = [tuple(row) for row in conn.execute(
            'SELECT position,card_id,completed_at,elapsed_ms FROM review_session_items WHERE session_id=? ORDER BY position', (native['session_id'],))]
        assert members[:2] == original
        assert len(members) == len({row[1] for row in members}) == 8
        assert conn.execute('SELECT COUNT(*) FROM training_activity_credits').fetchone()[0] == credit_count
    # Re-selecting a period preserves every appended ordinal too.
    choose(client, updated, 'week')
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_session_items WHERE session_id=?', (native['session_id'],)).fetchone()[0] == 8


def test_retarget_rejects_a_native_session_owned_by_another_run(client):
    run, native = prepare(client)
    with db.get_conn() as conn:
        with pytest.raises(HTTPException) as error:
            sessions.retarget_training_goal(conn, str(uuid4()), native['session_id'],
                {'metric': 'minutes', 'unit': 'cards', 'remaining': 2})
        assert error.value.status_code == 409
        assert json.loads(conn.execute('SELECT goal FROM review_sessions WHERE id=?', (native['session_id'],)).fetchone()['goal']) == native['goal']
