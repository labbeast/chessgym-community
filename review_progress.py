"""Disjoint progress segments, independent of the overlapping legacy counters."""
from __future__ import annotations

from datetime import datetime, timezone


SEGMENTS = ('mastered', 'learned', 'due', 'unlearned')


def empty_counts():
    return dict.fromkeys(SEGMENTS, 0)


def _timestamp(value):
    if not value:
        return None
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value)
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (ValueError, TypeError):
        return None


def progress_counts(cards, current):
    """Count each supplied active card once; elapsed learned cards belong to due."""
    current = _timestamp(current)
    if current is None:
        raise ValueError('A valid current timestamp is required.')
    result = empty_counts()
    for card in cards:
        state = card['state']
        if state in ('mastered', 'unseen'):
            segment = 'mastered' if state == 'mastered' else 'unlearned'
        else:
            due = _timestamp(card['due'])
            segment = 'due' if due is not None and due <= current else ('learned' if state == 'learned' else 'unlearned')
        result[segment] += 1
    return result


def sum_counts(groups):
    result = empty_counts()
    for group in groups:
        for segment in SEGMENTS:
            result[segment] += group[segment]
    return result


def counts_for_base(conn, base_id, current):
    """One bounded-result SQL aggregate: no full card payloads loaded for the list."""
    parsed = _timestamp(current)
    if parsed is None:
        raise ValueError('A valid current timestamp is required.')
    at = parsed.isoformat(timespec='seconds')
    row = conn.execute("""WITH cards AS (
        SELECT state, due, CASE
            WHEN state='mastered' THEN 'mastered'
            WHEN state='unseen' THEN 'unlearned'
            WHEN julianday(due)<=julianday(:at) THEN 'due'
            WHEN state='learned' THEN 'learned'
            ELSE 'unlearned' END AS segment
        FROM review_cards WHERE base_id=:base_id AND active=1
    ) SELECT COUNT(*) total,
        COALESCE(SUM(state='unseen'),0) unseen,
        COALESCE(SUM(state='learning'),0) learning,
        COALESCE(SUM(state IN ('learned','mastered')),0) learned,
        COALESCE(SUM(state='mastered'),0) mastered,
        COALESCE(SUM(state IN ('learning','learned') AND julianday(due)<=julianday(:at)),0) due,
        COALESCE(SUM(segment='mastered'),0) progress_mastered,
        COALESCE(SUM(segment='learned'),0) progress_learned,
        COALESCE(SUM(segment='due'),0) progress_due,
        COALESCE(SUM(segment='unlearned'),0) progress_unlearned
        FROM cards""", {'at': at, 'base_id': base_id}).fetchone()
    result = dict(row)
    result['progress_counts'] = {key: result.pop('progress_' + key) for key in SEGMENTS}
    return result
