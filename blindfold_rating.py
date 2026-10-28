"""Local Blindfold Puzzles scale; versioned exercise difficulty and atomic grades.

The curve defines a training progression, not an equivalence to Lichess Elo.
Tactics start around 800 and gain 0.5 Lichess points per progression point.
Exercise difficulty credits actual visual complexity plus tactical difficulty.
"""
from __future__ import annotations

import math
import time

import puzzle_rating

INITIAL = 500
MAXIMUM = 3000
CURVE = 1.4
MODES = ('opening', 'positions')


def init_schema(conn):
    conn.executescript('''
      CREATE TABLE IF NOT EXISTS blindfold_profiles (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('opening','positions')),
        rating REAL NOT NULL DEFAULT 500, rated_count INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,mode)
      );
      CREATE TABLE IF NOT EXISTS blindfold_rating_events (
        session_id TEXT PRIMARY KEY REFERENCES skill_sessions(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL, rating_before REAL NOT NULL, rating_after REAL NOT NULL,
        exercise_rating REAL NOT NULL, success INTEGER NOT NULL, created_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blindfold_seen (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode TEXT NOT NULL, puzzle_id TEXT NOT NULL,
        PRIMARY KEY(user_id,mode,puzzle_id)
      );
    ''')
    puzzle_rating.init_profile(conn, 'blindfold_profiles')


def clamp(value):
    return max(INITIAL, min(MAXIMUM, float(value)))


def targets(rating):
    x = ((clamp(rating) - INITIAL) / (MAXIMUM - INITIAL)) ** CURVE
    moves = math.floor(5 + 45 * x + .5)
    pieces = math.floor(3 + 29 * x + .5)
    return {'moves': moves, 'pieces': pieces,
            'moves_min': max(1, moves - 2), 'moves_max': moves + 2,
            'pieces_min': max(3, pieces - 1), 'pieces_max': min(32, pieces + 1)}


def profiles(conn, user_id):
    stored = {r['mode']: dict(r) for r in conn.execute(
        'SELECT * FROM blindfold_profiles WHERE user_id=?', (user_id,))}
    return {mode: {**puzzle_rating.public_profile(stored.get(mode, {'mode': mode, 'rating': INITIAL, 'rated_count': 0, 'wins': 0})),
                   'targets': targets(stored.get(mode, {}).get('rating', INITIAL))} for mode in MODES}


def selection(conn, user_id, mode, recent=()):
    import puzzle_store
    profile = profiles(conn, user_id)[mode]
    level = profile['rating']
    target = targets(level)
    tactical = round(800 + .5 * (level - INITIAL))
    visual = ({'min_initial_ply': target['moves_min'] * 2 - 1,
               'max_initial_ply': target['moves_max'] * 2} if mode == 'opening' else
              {'min_pieces': target['pieces_min'], 'max_pieces': target['pieces_max']})
    seen = {r['puzzle_id'] for r in conn.execute(
        'SELECT puzzle_id FROM blindfold_seen WHERE user_id=? AND mode=?', (user_id, mode))}
    excluded = seen | set(recent)
    # Relax tactics before visual complexity. Keep the lower visual bound: a
    # 3000-rated session must not silently become a five-move exercise.
    for width in (200, 500, 4000):
        filters = {**visual, 'rating_min': max(0, tactical - width),
                   'rating_max': min(4000, tactical + width), 'target_rating': tactical}
        rows = puzzle_store.search_puzzles(filters, limit=20, exclude_ids=excluded)
        if rows:
            break
    else:
        # Exhausted banks remain playable, but claim_attempt prevents repeat
        # puzzles from producing another rating event.
        rows = puzzle_store.search_puzzles(filters, limit=20)
    return rows, {'version': 1, 'curve': CURVE, 'level': level,
                  'tactical_target': tactical, 'tactical_min': filters['rating_min'],
                  'tactical_max': filters['rating_max'], 'targets': target}


def exercise(challenge, mode, *, moves, pieces, puzzle_rating, puzzle_deviation=45):
    complexity, start, span = (moves, 5, 45) if mode == 'opening' else (pieces, 3, 29)
    fraction = max(0, min(1, (complexity - start) / span))
    visual_level = INITIAL + (MAXIMUM - INITIAL) * fraction ** (1 / CURVE)
    # At the nominal tactical target this equals the visual progression level.
    # Stronger/weaker tactics adjust it without equating the two rating scales.
    difficulty = clamp(INITIAL + .5 * (visual_level - INITIAL) + puzzle_rating - 800)
    return {**challenge, 'moves': moves, 'pieces': pieces,
            'exercise_rating': round(difficulty, 2), 'exercise_deviation': puzzle_deviation}


def claim_attempt(conn, row):
    state, config = row['state'], row['config']
    if not config.get('rated') or 'rating_eligible' in state:
        return
    changed = conn.execute('INSERT OR IGNORE INTO blindfold_seen VALUES(?,?,?)',
                           (row['user_id'], config['mode'], state['puzzle_id'])).rowcount
    state['rating_eligible'] = bool(changed)


def grade(conn, row):
    config, state, result = row['config'], row['state'], row['result']
    if (not config.get('rated') or config['mode'] not in MODES or not state.get('rating_eligible')
            or not state.get('challenge') or row['started_at'] is None or result is None):
        return
    old = conn.execute('SELECT * FROM blindfold_rating_events WHERE session_id=?', (row['id'],)).fetchone()
    if old:
        return
    conn.execute('INSERT OR IGNORE INTO blindfold_profiles(user_id,mode) VALUES(?,?)',
                 (row['user_id'], config['mode']))
    profile = conn.execute('SELECT * FROM blindfold_profiles WHERE user_id=? AND mode=?',
                           (row['user_id'], config['mode'])).fetchone()
    # Solving the puzzle determines the rating. Reconstruction is a secondary
    # statistic, including when it is skipped or revealed after solving.
    success = config.get('hide_prompt') is True and result.get('solve_success') is True
    before = profile['rating']
    difficulty = state['challenge']['exercise_rating']
    updated = puzzle_rating.rate_puzzle(profile, difficulty, success,
        opponent_rd=state['challenge'].get('exercise_deviation', puzzle_rating.MIN_DEVIATION),
        minimum=INITIAL, maximum=MAXIMUM)
    after = updated['rating']
    conn.execute('INSERT INTO blindfold_rating_events VALUES(?,?,?,?,?,?,?,?)',
                 (row['id'], row['user_id'], config['mode'], before, after, difficulty, int(success), time.time()))
    conn.execute('''UPDATE blindfold_profiles SET rating=?,rating_deviation=?,volatility=?,last_rated_at=?,
                    rated_count=rated_count+1,wins=wins+? WHERE user_id=? AND mode=?''',
                 (*updated.values(), int(success), row['user_id'], config['mode']))
    result.update(rated=True, rating_before=round(before, 2), rating_after=round(after, 2),
                  rating_delta=round(after - before, 2), exercise_rating=difficulty,
                  points=round(max(0, after - before), 2), rating_success=success,
                  rating_deviation=updated['rating_deviation'],
                  provisional=updated['rating_deviation'] >= puzzle_rating.PROVISIONAL_DEVIATION)
