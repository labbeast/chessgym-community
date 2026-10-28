"""Pure review grading and scheduling rules, with an explicit clock.

Persistence, request retries and mastery migration are handled by training.
Intervals use days except the Again preference, which is stored in minutes.
"""
from datetime import timedelta

from review_preferences import DEFAULT_REVIEW_MULTIPLIERS, DEFAULT_REVIEW_SETTINGS

GRADE_KEYS = ('again', 'hard', 'medium', 'easy')
AUTOMATIC_MODES = ('auto', 'automatic', 'probability')


def resolve_grade(card_type, mode, requested, *, errors=0, hints=0, assisted=False):
    """Return the effective grade and the objective suggestion kept in history.

    Conversion/defence exercises require the person's assessment: centipawns
    cannot prove that the requested objective was actually achieved.
    """
    proposed = 0 if errors else (1 if hints or assisted else 2)
    automatic = mode in AUTOMATIC_MODES and card_type != 'play'
    return (proposed if automatic else requested), proposed


def schedule(card, settings, grade, mastery_days, *, current):
    """Return interval days, next timestamp and state without reading or writing."""
    maximum = max(1, min(3650, float(settings.get('max', 720))))
    key = GRADE_KEYS[grade]
    configured = float(settings.get(key, DEFAULT_REVIEW_SETTINGS[key]))
    if grade == 0:
        interval = max(1, min(1440, configured)) / 1440
    else:
        configured = max(1 / 1440, configured)
        if card['interval_days'] >= 1:
            factors = settings.get('multipliers', DEFAULT_REVIEW_MULTIPLIERS)
            factor = factors.get(key, DEFAULT_REVIEW_MULTIPLIERS[key])
            configured = max(configured, card['interval_days'] * factor)
        interval = min(maximum, configured)
    if interval > mastery_days:
        return interval, None, 'mastered'
    due = (current + timedelta(days=interval)).isoformat(timespec='seconds')
    return interval, due, ('learned' if grade >= 1 else 'learning')
