"""A bounded daily plan over existing review cards, without copying source PGNs.

Each card retains its base and objective. Transpositions in different repertoires
are deliberately not merged: their expected moves may differ.
"""
from __future__ import annotations

from collections import Counter, defaultdict, deque
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt

import review_preferences

PLANNER_VERSION = 2
REASONS = ('due', 'personal_error', 'failed_puzzle', 'maintenance', 'new')
DEFAULT_GOAL = {'minutes': 20, 'cards': 30}


class DailyOptions(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_ids: list[StrictInt] | None = Field(default=None, max_length=500)
    goal: dict | None = None
    selection: Literal['review', 'learn', 'both'] = 'both'
    # Accepted for older clients and stored receipts; no longer limits learning.
    new_limit: int | None = Field(default=None, ge=0, le=1000, strict=True)


def _sources(conn):
    """Only proven source links affect priorities; titles/tags are not evidence."""
    tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    errors, puzzles = set(), set()
    if 'game_analysis_exercises' in tables:
        errors = {row[0] for row in conn.execute('SELECT exercise_entry_id FROM game_analysis_exercises')}
    if 'puzzle_copies' in tables:
        puzzles = {row[0] for row in conn.execute('SELECT entry_id FROM puzzle_copies')}
    return errors, puzzles


def _interleave(candidates, *, maximum):
    """Balance review categories and bases, then introduce new cards."""
    grouped = {reason: defaultdict(deque) for reason in REASONS}
    for card in candidates:
        grouped[card['selection_reason']][card['base_id']].append(card)
    rotations = {reason: deque(groups) for reason, groups in grouped.items()}
    chosen = []
    for cycle in (('due', 'personal_error', 'due', 'failed_puzzle', 'maintenance'), ('new',)):
        while any(rotations[reason] for reason in cycle):
            for reason in cycle:
                if maximum is not None and len(chosen) >= maximum:
                    return chosen
                turns = rotations[reason]
                if not turns:
                    continue
                base_id = turns.popleft()
                cards = grouped[reason][base_id]
                chosen.append(cards.popleft())
                if cards:
                    turns.append(base_id)
    return chosen


def plan(conn, options):
    import training
    import review_maintenance

    requested = options.base_ids
    if requested is not None and (any(value <= 0 for value in requested) or len(set(requested)) != len(requested)):
        raise HTTPException(422, 'Choisis chaque base une seule fois avec un identifiant valide.')
    all_bases = conn.execute('''SELECT b.* FROM bases b
        WHERE NOT EXISTS (SELECT 1 FROM reference_bases r WHERE r.base_id=b.id)
        ORDER BY b.sort_order,b.name,b.id''').fetchall()
    eligible = [base for base in all_bases if training.settings_of(base).get('review_enabled', False)]
    eligible_ids = {base['id'] for base in eligible}
    if requested is not None and set(requested) - eligible_ids:
        raise HTTPException(409, 'Une base choisie est indisponible ou ses révisions sont désactivées.')
    selected = [base for base in eligible if requested is None or base['id'] in requested]
    settings_by_base = {base['id']: training._sync_base(conn, base) for base in selected}
    training.apply_auto_mastery(conn)
    maintenance_ids = review_maintenance.due_card_ids(conn, training.now(), base_ids=[base['id'] for base in selected])
    errors, puzzles = _sources(conn)
    candidates, summaries = [], []
    for base in eligible:
        bid = base['id']
        summary = {'id': bid, 'name': base['name'], 'selected': bid in settings_by_base,
                   'type': training.settings_of(base).get('type', 'solve'), 'count': 0}
        summaries.append(summary)
        if bid not in settings_by_base:
            continue
        settings = settings_by_base[bid]
        ordered, probabilities, probability_order = training._ordered_cards(conn, bid, settings, selection=options.selection)
        repetitions = {row['id']: row['repetitions'] for row in conn.execute(
            'SELECT id,repetitions FROM review_cards WHERE base_id=? AND active=1', (bid,))}
        for value in ordered:
            card = dict(value)
            if card['state'] == 'unseen':
                reason = 'new'
            elif card['state'] == 'mastered':
                if card['id'] not in maintenance_ids:
                    continue
                reason = 'maintenance'
            elif card['entry_id'] in errors:
                reason = 'personal_error'
            elif card['entry_id'] in puzzles:
                reason = 'failed_puzzle'
            else:
                reason = 'due'
            card.update(base_id=bid, selection_reason=reason,
                        probability=probabilities.get(card['identity']),
                        probability_order=probability_order,
                        planned_repetitions=repetitions.get(card['id'], 0))
            candidates.append(card)
            summary['count'] += 1
    goal = review_preferences.checked_session_defaults(options.goal or {}, DEFAULT_GOAL)
    chosen = _interleave(candidates, maximum=goal['cards'])
    counts = {reason: 0 for reason in REASONS}
    counts.update(Counter(card['selection_reason'] for card in candidates))
    counts['total'] = len(candidates)
    selected_counts = {reason: 0 for reason in REASONS}
    selected_counts.update(Counter(card['selection_reason'] for card in chosen))
    selected_counts['total'] = len(chosen)
    selected_by_base = Counter(card['base_id'] for card in chosen)
    for base in summaries:
        base['selected_count'] = selected_by_base[base['id']]
    maintenance = review_preferences.read(conn)['review_maintenance']
    return {'base_ids': [base['id'] for base in selected], 'bases': summaries,
            'counts': counts, 'selected_counts': selected_counts, 'total': len(chosen),
            'goal': goal, 'selection': options.selection, 'maintenance_limit': maintenance['daily_limit'],
            'planner_version': PLANNER_VERSION, 'cards': chosen}


def public_plan(value):
    return {key: item for key, item in value.items() if key != 'cards'}
