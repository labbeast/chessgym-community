"""Shared Glicko-2 puzzle ratings, using Lichess's calculator parameters.

Formula: https://www.glicko.net/glicko/glicko2.pdf (revised Illinois solver).
Lichess parameters and theme/provisional-puzzle weights:
https://github.com/lichess-org/scalachess/blob/master/rating/src/main/scala/glicko/model.scala
https://github.com/lichess-org/lila/blob/master/modules/rating/src/main/Glicko.scala
https://github.com/lichess-org/lila/blob/master/modules/puzzle/src/main/PuzzleFinisher.scala

The imported puzzle bank stays read-only. Blindfold uses its own exercise scale.
"""
from __future__ import annotations

import math
import time

SCALE = 173.7178
INITIAL_DEVIATION = 500.0
INITIAL_VOLATILITY = 0.09
MIN_DEVIATION = 45.0
MAX_VOLATILITY = 0.1
PROVISIONAL_DEVIATION = 110.0
TAU = 0.75
PERIODS_PER_DAY = 0.21436
MAX_DELTA = 700.0


def init_profile(conn, table):
    """Keep legacy ratings/history; start their newly measured uncertainty high."""
    if table not in ('puzzle_profile', 'blindfold_profiles'):
        raise ValueError('Unknown rating profile table')
    columns = {r['name'] for r in conn.execute(f'PRAGMA table_info({table})')}
    for name, definition in (
        ('rating_deviation', f'REAL NOT NULL DEFAULT {INITIAL_DEVIATION}'),
        ('volatility', f'REAL NOT NULL DEFAULT {INITIAL_VOLATILITY}'),
        ('last_rated_at', 'REAL'),
    ):
        if name not in columns:
            conn.execute(f'ALTER TABLE {table} ADD COLUMN {name} {definition}')


def live_deviation(profile, now=None):
    elapsed = max(0, (time.time() if now is None else now) - profile['last_rated_at']) if profile.get('last_rated_at') is not None else 0
    variance = profile.get('rating_deviation', INITIAL_DEVIATION) ** 2
    variance += elapsed / 86400 * PERIODS_PER_DAY * (SCALE * profile.get('volatility', INITIAL_VOLATILITY)) ** 2
    return max(MIN_DEVIATION, min(INITIAL_DEVIATION, math.sqrt(variance)))


def public_profile(profile, now=None):
    profile = dict(profile)
    deviation = live_deviation(profile, now)
    return {**profile, 'rating_deviation': deviation,
            'volatility': profile.get('volatility', INITIAL_VOLATILITY),
            'provisional': deviation >= PROVISIONAL_DEVIATION,
            'rating_system': 'glicko2'}


def calculate(rating, deviation, volatility, results, *, tau=TAU):
    """One Glicko-2 period; results contain (opponent rating, RD, score).

    Uncapped so the published numerical example can verify the actual formula.
    Application bounds and puzzle weights are applied by rate_puzzle below.
    """
    mu, phi = (rating - 1500) / SCALE, deviation / SCALE
    information = residual = 0.0
    for opponent, opponent_rd, score in results:
        g = 1 / math.sqrt(1 + 3 * (opponent_rd / SCALE) ** 2 / math.pi ** 2)
        expected = 1 / (1 + math.exp(-g * (mu - (opponent - 1500) / SCALE)))
        information += g * g * expected * (1 - expected)
        residual += g * (score - expected)
    if not information:
        return rating, math.hypot(phi, volatility) * SCALE, volatility
    variance = 1 / information
    delta = variance * residual
    a = math.log(volatility ** 2)

    def f(x):
        ex = math.exp(x)
        return ex * (delta ** 2 - phi ** 2 - variance - ex) / (2 * (phi ** 2 + variance + ex) ** 2) - (x - a) / tau ** 2

    left = a
    if delta ** 2 > phi ** 2 + variance:
        right = math.log(delta ** 2 - phi ** 2 - variance)
    else:
        for k in range(1, 1001):
            right = a - k * tau
            if f(right) >= 0:
                break
        else:
            raise ArithmeticError('Glicko-2 volatility bracket did not converge')
    f_left, f_right = f(left), f(right)
    for _ in range(1000):
        if abs(right - left) <= 0.000001:
            break
        middle = left + (left - right) * f_left / (f_right - f_left)
        f_middle = f(middle)
        if f_middle * f_right <= 0:
            left, f_left = right, f_right
        else:
            f_left /= 2
        right, f_right = middle, f_middle
    else:
        raise ArithmeticError('Glicko-2 volatility solver did not converge')
    sigma = math.exp(left / 2)
    phi_star = math.hypot(phi, sigma)
    new_phi = 1 / math.sqrt(1 / phi_star ** 2 + 1 / variance)
    return 1500 + SCALE * (mu + new_phi ** 2 * residual), SCALE * new_phi, sigma


_NON_HINTING = {'opening', 'middlegame', 'endgame', 'rookEndgame', 'bishopEndgame',
                'pawnEndgame', 'knightEndgame', 'queenEndgame', 'queenRookEndgame',
                'master', 'masterVsMaster', 'superGM'}
_OBVIOUS = {'enPassant', 'attackingF2F7', 'doubleCheck', 'castling', 'mateIn1'}


def puzzle_weight(themes, success, opponent_rd):
    # Only explicitly selected themes hint at a solution; ordinary puzzle tags
    # must never penalize a puzzle from the standard mixed selection.
    def theme_weight(theme):
        if theme == 'mix':
            return 1.0
        if theme in _OBVIOUS or theme.endswith('Mate'):
            return 0.1 if success else 0.4
        if theme in _NON_HINTING:
            return 0.7 if success else 0.8
        return 0.2 if success else 0.7
    weight = min((theme_weight(t) for t in themes), default=1.0)
    if opponent_rd >= PROVISIONAL_DEVIATION:
        weight -= 0.2 if success else 0.7
    return max(0.1, weight)


def rate_puzzle(profile, opponent_rating, success, *, opponent_rd=MIN_DEVIATION,
                themes=(), minimum=400, maximum=4000, now=None):
    profile = dict(profile)
    now = time.time() if now is None else now
    before = profile['rating']
    deviation = live_deviation(profile, now)
    volatility = profile.get('volatility', INITIAL_VOLATILITY)
    opponent_rd = max(MIN_DEVIATION, min(INITIAL_DEVIATION, opponent_rd))
    rating, rd, sigma = calculate(before, deviation, volatility,
                                  [(opponent_rating, opponent_rd, int(success))])
    rating = max(minimum, min(maximum, max(before - MAX_DELTA, min(before + MAX_DELTA, rating))))
    rd = max(MIN_DEVIATION, min(INITIAL_DEVIATION, rd))
    sigma = min(MAX_VOLATILITY, sigma)
    weight = puzzle_weight(themes, success, opponent_rd)
    return {'rating': before + weight * (rating - before),
            'rating_deviation': deviation + weight * (rd - deviation),
            'volatility': volatility + weight * (sigma - volatility), 'last_rated_at': now}
