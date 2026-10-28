"""Puzzle Storm timing and the cadence of Lichess's rating buckets.

Sources: lichess.org/page/storm and lichess-org/lila's
modules/storm/src/main/StormSelector.scala (checked 2026-10-27).
The local bank lacks Lichess's live quality-ranked puzzle paths. Stratified
targets within each bucket approximate their sorted random sample; the bucket
bounds and puzzle counts follow the selector, rather than a fixed Elo increase.
"""

COMBO_LEVELS = ((0, 0), (5, 3), (12, 5), (20, 7), (30, 10))
# (inclusive minimum rating, exclusive maximum rating, number of puzzles)
RATING_BUCKETS = (
    (1000, 1100, 7), (1100, 1200, 7), (1270, 1340, 8),
    (1410, 1480, 9), (1550, 1620, 10), (1690, 1760, 11),
    # The 1900 selector matches paths on either side of that shared boundary.
    (1830, 2000, 13), (2000, 2100, 15), (2100, 2200, 17),
    (2200, 2350, 19), (2350, 2500, 21),
)
RUN_SIZE = sum(count for _, _, count in RATING_BUCKETS)


def combo_bonus(combo):
    return dict(COMBO_LEVELS).get(combo, 10 if combo > 30 and combo % 10 == 0 else 0)


def combo_progress(combo):
    previous = 0
    for threshold, seconds in COMBO_LEVELS[1:]:
        if combo < threshold:
            break
        previous = threshold
    else:
        previous = 30 + (combo - 30) // 10 * 10
        threshold, seconds = previous + 10, 10
    return {'moves': combo - previous, 'target': threshold - previous,
            'remaining': threshold - combo, 'seconds': seconds}


def rating_window(index, low=0, high=4000):
    """Zero-based puzzle index; both solved and failed puzzles advance it.

    Custom selections keep the cadence, shifting the starting bucket up when
    their minimum exceeds 1000 and clamping to their explicit rating bounds.
    """
    index = max(0, index)
    offset = max(0, low - RATING_BUCKETS[0][0])
    for start, end, count in RATING_BUCKETS:
        if index < count:
            break
        index -= count
    else:
        index = count - 1
    target = start + int((index + 0.5) * (end - start) / count)
    clamp = lambda value: min(high, max(low, value + offset))
    return {'rating_min': clamp(start), 'rating_max': clamp(end - 1),
            'target_rating': clamp(target)}
