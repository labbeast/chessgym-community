"""Deleted source memberships cannot revive when SQLite reuses a base ID."""
from uuid import UUID, uuid4

import pytest
from fastapi import HTTPException

import db
import training
import review_sessions as sessions
from test_daily_sessions import database, base, daily, page


def repertoire(name):
    return base(name, 1, type='moves', color='white', review_priority='pgn')


def replace(bid):
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=?', (bid,))
    replacement = repertoire('Replacement repertoire')
    assert replacement == bid  # The numeric base and position-card IDs recur.
    return training.queue(replacement)['cards']


def test_deleted_daily_repertoire_cannot_reappear_as_replacement(database):
    bid = repertoire('Original repertoire')
    first = daily()
    original_ids = {card['id'] for card in first['cards']}
    replacement = replace(bid)
    assert {card['id'] for card in replacement} == original_ids
    resumed = page(first)
    assert resumed['cards'] == []
    assert resumed['skipped_unavailable'] == list(range(first['total']))
    assert resumed['skipped_completed'] == []
    assert resumed['total'] == first['total']
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_session_items').fetchone()[0] == first['total']
        assert all(row[0] == -1 for row in conn.execute('SELECT base_id FROM review_session_items'))
    card = first['cards'][0]
    request = training.GradeRequest(grade=2, request_id=uuid4(),
        session_id=UUID(first['session_id']), session_index=card['session_index'])
    with pytest.raises(HTTPException) as error:
        training.grade_card(card['id'], request)
    assert error.value.status_code == 409
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 0


def test_legacy_null_membership_is_retired_and_paging_still_advances(database):
    bid = repertoire('Legacy repertoire')
    first = sessions.create_session(sessions.CreateSession(base_id=bid, request_id=uuid4()))
    with db.get_conn() as conn:
        conn.execute('UPDATE review_session_items SET base_id=NULL')
    replace(bid)
    first_page = page(first, 0, 1)
    assert first_page['cards'] == [] and first_page['skipped_unavailable'] == [0]
    assert first_page['next_offset'] == 1
    second_page = page(first, 1, 1)
    assert second_page['cards'] == [] and second_page['skipped_unavailable'] == [1]
    assert second_page['next_offset'] is None


def test_schema_migration_keeps_callers_changes_uncommitted(database):
    bid = repertoire('Original name')
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        conn.execute("UPDATE bases SET name='Uncommitted name' WHERE id=?", (bid,))
        sessions.init_schema(conn)
        assert conn.in_transaction
        conn.rollback()
        assert conn.execute('SELECT name FROM bases WHERE id=?', (bid,)).fetchone()[0] == 'Original name'
