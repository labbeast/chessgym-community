"""Representation limits, not application search budgets.

Durations cross JSON/JavaScript as exact integer milliseconds; UCI depth is a
signed 32-bit integer. The selected engine decides how deep it can search.
None means no time limit, never an implicit fallback timeout.
"""
MIN_TIME_MS = 100
MAX_TIME_MS = 9_007_199_254_740_991
MIN_DEPTH = 1
MAX_DEPTH = 2_147_483_647
