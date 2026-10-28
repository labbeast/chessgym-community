"""Probability prioritizes relevant opening cards without changing their schedules."""
import json
import chess
import pytest
import db
import training
import repertoire_coverage
from test_training import database, base, entry, update_settings, good


def key(fen):
    return ' '.join(fen.split()[:4])


def prepare(monkeypatch, settings=None):
    bid = base({'is_repertoire': True, **(settings or {})})
    entry(bid, '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. d3 *')
    cards = training.queue(bid, all=True)['cards']
    probabilities = {key(cards[0]['fen']): .1, key(cards[1]['fen']): .6, key(cards[2]['fen']): .3}
    monkeypatch.setattr(repertoire_coverage, 'cached_priorities', lambda conn, base_id: probabilities)
    return bid, cards, probabilities


def test_new_cards_sorted_by_frequency_without_daily_quota(database, monkeypatch):
    bid, cards, _ = prepare(monkeypatch, {'new_limit': 2})
    result = training.queue(bid)
    assert [c['id'] for c in result['cards']] == [cards[1]['id'], cards[2]['id'], cards[0]['id'], cards[3]['id']]
    assert [c['encounter_probability'] for c in result['cards']] == [.6, .3, .1, None]
    assert result['priority'] == 'probability' and result['probability_available']
    good(result['cards'][0])
    assert [c['id'] for c in training.queue(bid)['cards']] == [cards[2]['id'], cards[0]['id'], cards[3]['id']]


def test_due_priority_preserves_failures_old_days_and_future_cards(database, monkeypatch):
    bid, cards, _ = prepare(monkeypatch)
    with db.get_conn() as conn:
        for card, state, due in zip(cards, ['learned', 'learned', 'learning', 'learned'],
                                   ['2000-01-01T00:00:00+00:00', '2000-01-02T00:00:00+00:00',
                                    '2000-01-03T00:00:00+00:00', '2999-01-01T00:00:00+00:00']):
            conn.execute('UPDATE review_cards SET state=?,due=? WHERE id=?', (state, due, card['id']))
        before = [tuple(r) for r in conn.execute('SELECT id,due,interval_days,repetitions,lapses FROM review_cards ORDER BY id')]
    result = training.queue(bid)
    assert [c['id'] for c in result['cards']] == [cards[2]['id'], cards[0]['id'], cards[1]['id']]
    with db.get_conn() as conn:
        after = [tuple(r) for r in conn.execute('SELECT id,due,interval_days,repetitions,lapses FROM review_cards ORDER BY id')]
    assert before == after


def test_frequency_sorts_same_day_due_cards_without_treating_unknown_as_zero(database, monkeypatch):
    bid, cards, _ = prepare(monkeypatch)
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET state='learned',due='2000-01-01T00:00:00+00:00'")
    result = training.queue(bid)['cards']
    assert [c['id'] for c in result] == [cards[1]['id'], cards[2]['id'], cards[0]['id'], cards[3]['id']]
    assert result[-1]['encounter_probability'] is None


def test_manual_priority_restores_original_order(database, monkeypatch):
    bid, cards, _ = prepare(monkeypatch, {'review_priority': 'due'})
    monkeypatch.setattr(repertoire_coverage, 'cached_priorities', lambda *args: pytest.fail('No coverage read needed'))
    result = training.queue(bid)
    assert [c['id'] for c in result['cards']] == [c['id'] for c in cards]
    assert result['priority'] == 'due'


def test_missing_estimates_preserve_chronological_due_order(database, monkeypatch):
    bid, cards, _ = prepare(monkeypatch)
    monkeypatch.setattr(repertoire_coverage, 'cached_priorities', lambda *args: {})
    with db.get_conn() as conn:
        for card, state, due in zip(cards, ['learned', 'learning', 'learned', 'learned'],
                                   ['2000-01-01', '2000-01-03', '2000-01-02', '2999-01-01']):
            conn.execute('UPDATE review_cards SET state=?,due=? WHERE id=?', (state, due, card['id']))
    result = training.queue(bid)
    assert [c['id'] for c in result['cards']] == [cards[0]['id'], cards[2]['id'], cards[1]['id']]
    assert not result['probability_available']


def test_mastered_cards_remain_excluded_even_in_free_practice(database, monkeypatch):
    bid, cards, _ = prepare(monkeypatch)
    training.master_card(cards[1]['id'])
    assert cards[1]['id'] not in [c['id'] for c in training.queue(bid, all=True)['cards']]


def test_probability_priority_does_not_change_puzzle_or_play_order(database, monkeypatch):
    bid, cards, _ = prepare(monkeypatch)
    monkeypatch.setattr(repertoire_coverage, 'cached_priorities', lambda *args: pytest.fail('Only opening moves use probability'))
    for kind in ['solve', 'play']:
        update_settings(bid, type=kind)
        result = training.queue(bid)
        assert result['priority'] == 'due'
        assert all(c['encounter_probability'] is None for c in result['cards'])


def test_settings_validate_priority_independently_of_grading():
    import app
    from fastapi import HTTPException
    for mode in ['manual', 'automatic', 'hybrid']:
        assert app.checked_settings({'mode': mode, 'review_priority': 'probability'})['mode'] == mode
        assert app.checked_settings({'mode': mode, 'review_priority': 'due'})['review_priority'] == 'due'
    with pytest.raises(HTTPException):
        app.checked_settings({'review_priority': 'arbitrary'})
