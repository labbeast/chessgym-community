"""Prepared sessions share durable answers without daily learning quotas."""
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID, uuid4

from fastapi import HTTPException

import db
import training
import review_sessions as sessions
from test_daily_sessions import database, base, daily, page, due


def answer(session, card):
    try:
        return training.grade_card(card['id'], training.GradeRequest(
            grade=2, request_id=uuid4(), content_key=card['content_key'],
            session_id=UUID(session['session_id']), session_index=card['session_index']))
    except HTTPException as exc:
        return exc


def test_simultaneous_sessions_can_learn_beyond_retired_common_quota(database):
    a, b = base('A', 2), base('B', 2)
    first, second = daily(base_ids=[a], new_limit=1, goal={'cards':1}), daily(base_ids=[b], new_limit=1, goal={'cards':1})
    with ThreadPoolExecutor(2) as pool:
        results = list(pool.map(lambda s: answer(s, s['cards'][0]), (first, second)))
    assert all(not isinstance(result, HTTPException) for result in results)
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 2
    assert page(first)['cards'] == page(second)['cards'] == []


def test_another_session_introduction_does_not_block_new_or_due_cards(database):
    a, b = base('New', 3, new_limit=1), base('Due', 3)
    due(b)
    first = daily(new_limit=10)
    pending = next(card for card in first['cards'] if card['base_id'] == a)
    # A separate single-base session spends the base's remaining allowance.
    other = next(card for card in training.queue(a)['cards'] if card['id'] == pending['id'])
    with db.get_conn() as conn:
        unseen = conn.execute('SELECT id FROM review_cards WHERE base_id=? AND id<>?',
                              (a, other['id'])).fetchone()[0]
    training.grade_card(unseen, training.GradeRequest(grade=2, request_id=uuid4()))
    accepted = answer(first, pending)
    assert not isinstance(accepted, HTTPException)
    resumed = page(first)
    assert pending['session_index'] in resumed['skipped_completed']
    assert len(resumed['cards']) == 4
    assert sum(card['base_id'] == b for card in resumed['cards']) == 3
    assert not isinstance(answer(first, resumed['cards'][0]), HTTPException)
