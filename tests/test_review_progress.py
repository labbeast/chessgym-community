"""Progress bars are exhaustive and disjoint while legacy totals remain compatible."""
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

import db
import review_progress
import review_statistics
import training


CURRENT = datetime(2026, 10, 22, 16, tzinfo=timezone.utc)
PAST = (CURRENT - timedelta(days=1)).isoformat()
FUTURE = (CURRENT + timedelta(days=1)).isoformat()


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'progress.sqlite3')
    monkeypatch.setattr(training, 'now', lambda: CURRENT)
    monkeypatch.setattr(review_statistics, 'now', lambda: CURRENT)
    db.init_db()
    training.init_training()


def populate(name, states):
    with db.get_conn() as conn:
        base_id = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
            (name, json.dumps({'review_enabled': True, 'type': 'solve'}), CURRENT.isoformat())).lastrowid
        for index in range(len(states)):
            conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES (?,?,?,?,?)',
                (base_id, str(index), '1. e4 e5 *', CURRENT.isoformat(), CURRENT.isoformat()))
    cards = training.queue(base_id, all=True)['cards']
    with db.get_conn() as conn:
        for card, (state, due) in zip(cards, states):
            conn.execute('UPDATE review_cards SET state=?,due=? WHERE id=?', (state, due, card['id']))
    return base_id, cards


def test_segments_exclusive_due_priority_and_legacy_totals(database):
    base_id, _ = populate('Progression', [
        ('mastered', PAST), ('unseen', PAST), ('learned', PAST), ('learning', PAST),
        ('learned', FUTURE), ('learning', FUTURE), ('learned', None), ('learning', None),
    ])
    listing = next(item for item in training.reviews()['bases'] if item['base_id'] == base_id)
    expected = {'mastered': 1, 'learned': 2, 'due': 2, 'unlearned': 3}
    assert listing['progress_counts'] == expected
    assert sum(expected.values()) == listing['total'] == 8
    assert {key: listing[key] for key in ('learned', 'learning', 'due', 'mastered', 'unseen')} == {
        'learned': 4, 'learning': 3, 'due': 2, 'mastered': 1, 'unseen': 1}
    stats = review_statistics.review_statistics()
    assert stats['current']['progress_counts'] == expected
    assert stats['by_base'][0]['current']['progress_counts'] == expected
    assert stats['current']['learned'] == 4 and stats['current']['due_now'] == 2


def test_global_and_per_base_counts_exclude_inactive_and_disabled(database):
    first, cards = populate('A', [('mastered', None), ('learned', FUTURE), ('unseen', None)])
    second, _ = populate('B', [('learning', PAST), ('unseen', None)])
    disabled, _ = populate('C', [('learned', PAST)])
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=0 WHERE id=?', (cards[-1]['entry_id'],))
        conn.execute('UPDATE bases SET settings=? WHERE id=?',
            (json.dumps({'review_enabled': False, 'type': 'solve'}), disabled))
    listed = training.reviews()['bases']
    assert {item['base_id'] for item in listed} == {first, second}
    assert all(sum(item['progress_counts'].values()) == item['total'] for item in listed)
    stats = review_statistics.review_statistics()
    assert stats['current']['progress_counts'] == {'mastered': 1, 'learned': 1, 'due': 1, 'unlearned': 1}
    assert stats['current']['total'] == 4
    assert stats['current']['progress_counts'] == review_progress.sum_counts(item['progress_counts'] for item in listed)
    filtered = review_statistics.review_statistics(base_id=second)
    assert filtered['current']['progress_counts'] == {'mastered': 0, 'learned': 0, 'due': 1, 'unlearned': 1}
    disabled_stats = review_statistics.review_statistics(base_id=disabled)
    assert disabled_stats['current']['progress_counts'] == review_progress.empty_counts()


def test_empty_segments_remain_present(database):
    base_id, _ = populate('Vide', [])
    assert training.reviews()['bases'][0]['progress_counts'] == review_progress.empty_counts()
    assert review_statistics.review_statistics(base_id=base_id)['current']['progress_counts'] == review_progress.empty_counts()
    assert review_progress.progress_counts([], CURRENT) == review_progress.empty_counts()


@pytest.mark.parametrize('state', ['mastered', 'unseen', 'learned', 'learning', 'legacy_unknown'])
@pytest.mark.parametrize('due', [None, '', 'invalid', PAST, FUTURE,
    '2026-10-22T12:00:00-04:00', '2026-10-22T18:00:01+02:00', '2026-10-22T16:00:00'])
def test_sql_and_memory_share_boundaries_and_unknown_dates(state, due):
    with sqlite3.connect(':memory:') as conn:
        conn.row_factory = sqlite3.Row
        conn.execute('CREATE TABLE review_cards(base_id INTEGER, active INTEGER, state TEXT, due TEXT)')
        conn.execute('INSERT INTO review_cards VALUES (1,1,?,?)', (state, due))
        conn.execute("INSERT INTO review_cards VALUES (1,0,'unseen',NULL)")
        conn.execute("INSERT INTO review_cards VALUES (2,1,'unseen',NULL)")
        sql = review_progress.counts_for_base(conn, 1, CURRENT)['progress_counts']
    memory = review_progress.progress_counts([{'state': state, 'due': due}], CURRENT)
    assert sql == memory
    assert sum(sql.values()) == 1
    if state in ('mastered', 'unseen'):
        assert sql['mastered' if state == 'mastered' else 'unlearned'] == 1


def test_no_cards_or_invalid_now_never_invent_totals():
    assert review_progress.sum_counts([]) == review_progress.empty_counts()
    with pytest.raises(ValueError):
        review_progress.progress_counts([], 'invalid')
