"""Review and Learn use disjoint card states and have no daily new-card quota."""
from uuid import UUID, uuid4
import json

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import db
import training
import daily_review
import review_sessions as sessions
from test_daily_sessions import database, base, daily, page, due


def test_review_and_learn_are_disjoint_and_exclude_future_cards(database):
    bid = base('Cards', 5, new_limit=0)
    cards = training.queue(bid, selection='learn')['cards']
    training.grade_card(cards[0]['id'], training.GradeRequest(grade=2))
    training.grade_card(cards[1]['id'], training.GradeRequest(grade=0))
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET due='2000-01-01T00:00:00+00:00' WHERE id=?", (cards[1]['id'],))
    assert [c['id'] for c in training.queue(bid, selection='review')['cards']] == [cards[1]['id']]
    assert {c['id'] for c in training.queue(bid, selection='learn')['cards']} == {c['id'] for c in cards[2:]}
    mixed = training.queue(bid, selection='both')['cards']
    assert mixed[0]['id'] == cards[1]['id'] and len(mixed) == 4


@pytest.mark.parametrize('selection,expected', [('review', 0), ('learn', 7), ('both', 7)])
def test_daily_selection_ignores_all_legacy_zero_quotas(database, selection, expected):
    bid = base('Legacy zero', 7, new_limit=0)
    first = daily(base_ids=[bid], selection=selection, new_limit=0, goal={'cards': 20})
    assert first['total'] == expected and first['selection'] == selection
    assert 'new_remaining' not in first['plan']


def test_mixed_plan_finishes_reviews_across_all_bases_before_learning(database):
    first, second = base('First', 3), base('Second', 4)
    due(first)
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET state='learning',due='2000-01-01T00:00:00+00:00',repetitions=1 WHERE id=(SELECT id FROM review_cards WHERE base_id=? LIMIT 1)", (second,))
    session = daily(goal={'cards': 6}, selection='both')
    assert [card['state'] == 'unseen' for card in session['cards']] == [False]*4 + [True]*2
    assert daily(goal={'cards': 3}, selection='both')['plan']['selected_counts']['new'] == 0


def test_new_personal_errors_still_belong_only_to_learn(database):
    bid = base('Personal', 2)
    with db.get_conn() as conn:
        conn.execute('CREATE TABLE game_analysis_exercises(exercise_entry_id INTEGER)')
        conn.execute('INSERT INTO game_analysis_exercises SELECT entry_id FROM review_cards WHERE base_id=?', (bid,))
    assert daily(selection='review')['total'] == 0
    learned = daily(selection='learn')
    assert learned['total'] == 2 and all(c['selection_reason'] == 'new' for c in learned['cards'])


def test_learn_session_resume_keeps_selection_and_skips_independent_answers(database):
    bid = base('Resume', 4, new_limit=0)
    session = sessions.create_session(sessions.CreateSession(base_id=bid, selection='learn', request_id=uuid4()))
    card, other = session['cards'][:2]
    answer = training.GradeRequest(grade=2, request_id=uuid4(), session_id=UUID(session['session_id']), session_index=card['session_index'])
    training.grade_card(card['id'], answer)
    training.grade_card(other['id'], training.GradeRequest(grade=2))
    resumed = page(session)
    assert resumed['selection'] == 'learn' and resumed['completed'] == 1
    assert resumed['skipped_completed'] == [0, 1]
    assert len(resumed['cards']) == 2 and all(c['state'] == 'unseen' for c in resumed['cards'])
    with pytest.raises(HTTPException):
        training.grade_card(other['id'], answer.model_copy(update={'request_id': uuid4(), 'session_index': 1}))


@pytest.mark.parametrize('selection', ['free', '', True, ['review']])
def test_selection_is_validated(selection):
    with pytest.raises(ValidationError):
        daily_review.DailyOptions(selection=selection)


def test_learn_excludes_mastered_maintenance_even_if_due(database):
    bid = base('Maintenance', 2)
    card = training.queue(bid, selection='learn')['cards'][0]
    training.master_card(card['id'])
    with db.get_conn() as conn:
        conn.execute("UPDATE review_maintenance SET due='2000-01-01T00:00:00+00:00' WHERE card_id=?", (card['id'],))
    assert len(training.queue(bid, selection='learn')['cards']) == 1
    reviews = training.queue(bid, selection='review')['cards']
    assert len(reviews) == 1 and reviews[0]['maintenance']


def test_old_pending_daily_creation_recovers_its_original_receipt(database):
    base('Pending', 3)
    request = sessions.CreateDailySession(request_id=uuid4(), new_limit=10)
    original = sessions.create_daily(request)
    with db.get_conn() as conn:
        row = conn.execute('SELECT request_json FROM review_sessions WHERE id=?', (original['session_id'],)).fetchone()
        encoded = json.loads(row['request_json'])
        del encoded['selection']  # Previous clients did not know this field.
        conn.execute('UPDATE review_sessions SET request_json=? WHERE id=?', (json.dumps(encoded), original['session_id']))
    assert sessions.create_daily(request) == original


@pytest.mark.parametrize('selection', ['review', 'learn'])
def test_all_enabled_bases_have_no_default_session_limit(database, selection):
    first, second = base('First', 31, new_limit=0), base('Second', 34, new_limit=0)
    base('Disabled', 3, review_enabled=False)
    if selection == 'review':
        due(first); due(second)
    session = daily(selection=selection, goal={'minutes': None, 'cards': None})
    assert set(session['base_ids']) == {first, second} and session['total'] == 65
    assert session['goal'] == {'minutes': None, 'cards': None}
    assert session['base']['name'] == ('Tout réviser' if selection == 'review' else 'Tout apprendre')
    assert all((card['state'] == 'unseen') == (selection == 'learn') for card in page(session)['cards'])
