"""Read-only training facts from the games currently present in My Games.

Dates describe when a game was played, never when its PGN was imported. This
projection follows edits/deletions without creating durable training credits.
"""
from __future__ import annotations

import io
import hashlib
import json
import math
import re
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo

import chess.pgn

import pgnlib
import review_preferences
import sync_remote
import training_activity


MAX_SECONDS = 86400
SIMPLE_CONTROL = re.compile(r'(\d+)(?:\+(\d+))?\Z')
QUALITY = {'elapsed': 3, 'calculated': 2, 'estimated': 1, 'unknown': 0}


def _date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}\.\d{2}\.\d{2}', value):
        return None
    try:
        return date.fromisoformat(value.replace('.', '-'))
    except ValueError:
        return None


def _time(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{2}:\d{2}:\d{2}(?:\.\d+)?', value):
        return None
    try:
        return time.fromisoformat(value)
    except ValueError:
        return None


def _played_day(headers, settings):
    utc_day = _date(headers.get('UTCDate'))
    if utc_day:
        clock = _time(headers.get('UTCTime'))
        # An hour in a different convention must not be paired with a UTC date.
        return (review_preferences.study_date(datetime.combine(utc_day, clock, timezone.utc), settings)
                if clock is not None else utc_day)
    local_day = _date(headers.get('Date'))
    if local_day is None:
        return None
    clock = next((parsed for name in ('StartTime', 'Time')
                  if (parsed := _time(headers.get(name))) is not None), None)
    return (review_preferences.study_date(datetime.combine(local_day, clock, ZoneInfo(settings['timezone'])), settings)
            if clock is not None else local_day)


def _milliseconds(seconds):
    return round(seconds * 1000) if 0 <= seconds <= MAX_SECONDS and math.isfinite(seconds) else None


def _explicit_duration(value):
    """Duration is accepted as seconds or H:MM:SS, not guessed from free text."""
    if not isinstance(value, str):
        return None
    if re.fullmatch(r'\d+(?:\.\d+)?', value):
        return _milliseconds(float(value))
    match = re.fullmatch(r'(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)', value)
    if match:
        return _milliseconds(int(match[1]) * 3600 + int(match[2]) * 60 + float(match[3]))
    return None


def _interval_duration(headers):
    # Only use matching time conventions and explicit next-day dates. A clock
    # wrapping backwards does not by itself prove a game crossed midnight.
    pairs = (('UTCDate', 'UTCTime', 'UTCEndDate', 'UTCEndTime'),
             ('Date', 'StartTime', 'EndDate', 'EndTime'),
             ('Date', 'Time', 'EndDate', 'EndTime'))
    for date_tag, time_tag, end_date_tag, end_time_tag in pairs:
        start_day, start_clock = _date(headers.get(date_tag)), _time(headers.get(time_tag))
        end_clock = _time(headers.get(end_time_tag))
        end_day = _date(headers.get(end_date_tag)) if end_date_tag in headers else start_day
        if start_day and end_day and start_clock is not None and end_clock is not None:
            seconds = (datetime.combine(end_day, end_clock) - datetime.combine(start_day, start_clock)).total_seconds()
            duration = _milliseconds(seconds)
            if duration is not None:
                return duration
    return None


def _duration(game):
    headers = game.headers
    duration = _explicit_duration(headers.get('Duration'))
    if duration is not None:
        return duration, 'elapsed'
    control = headers.get('TimeControl', '')
    # A correspondence game's calendar interval does not measure training time.
    if not control.startswith('1/'):
        duration = _interval_duration(headers)
        if duration is not None:
            return duration, 'elapsed'
    moves = list(game.mainline())
    elapsed = [pgnlib._elapsed(node, game) for node in moves]
    if elapsed and all(value is not None and math.isfinite(value) and value >= 0 for value in elapsed):
        duration = _milliseconds(sum(elapsed))
        if duration is not None:
            return duration, 'calculated'
    match = SIMPLE_CONTROL.fullmatch(control)
    if match:
        duration = _milliseconds(2 * int(match[1]) + int(match[2] or 0) * len(moves))
        if duration:
            return duration, 'estimated'
    return None, 'unknown'


def _identity(game, entry_id, imported=None):
    # Never collapse two same-player games solely because their moves match.
    # Platform game ids survive annotation changes and duplicate imports.
    headers = game.headers
    if imported is not None:
        try:
            url = sync_remote.canonical_url(imported['site'], imported['remote_id'])
            if sync_remote.game_id(imported['site'], url) == imported['remote_id']:
                return imported['site'], imported['remote_id']
        except (ValueError, TypeError):
            pass
    for name in ('Link', 'Site'):
        for site in ('lichess', 'chesscom'):
            remote_id = sync_remote.game_id(site, headers.get(name))
            if remote_id:
                return site, remote_id
    identified = lambda value: isinstance(value, str) and value.strip() not in ('', '?', '-', '*')
    names = [headers.get(tag) for tag in ('White', 'Black', 'Event')]
    if all(identified(value) for value in names):
        utc_day, local_day = _date(headers.get('UTCDate')), _date(headers.get('Date'))
        utc_clock = _time(headers.get('UTCTime'))
        local_clock = _time(headers.get('StartTime')) or _time(headers.get('Time'))
        moment = None
        if utc_day is not None and utc_clock is not None:
            moment = ('utc', utc_day.isoformat(), utc_clock.isoformat())
        elif local_day is not None and local_clock is not None:
            moment = ('local', local_day.isoformat(), local_clock.isoformat())
        elif (utc_day or local_day) and identified(headers.get('Round')):
            moment = ('round', (utc_day or local_day).isoformat(), headers['Round'].strip().casefold())
        if moment:
            payload = [moment, [value.strip().casefold() for value in names],
                       game.board().fen(), [move.uci() for move in game.mainline_moves()]]
            return 'pgn', hashlib.sha256(json.dumps(payload, ensure_ascii=False).encode()).hexdigest()
    return 'entry', entry_id


def facts(conn, user_id, lower, upper):
    """Return one fact per played game, bounded by inclusive study dates.

    Personal library tables are owned by account 1 (the users schema enforces
    that invariant), like the other legacy sources in training_history.
    """
    if user_id != 1:
        return []
    settings = review_preferences.read(conn)['study_day']
    has_imports = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_imports'").fetchone() is not None
    lo, hi = max(1, lower.toordinal() - 2), min(date.max.toordinal(), upper.toordinal() + 2)
    query = '''SELECT e.id,e.base_id,c.headers,
        CASE WHEN c.entry_id IS NULL THEN e.pgn END uncached_pgn
        FROM entries e JOIN bases b ON b.id=e.base_id
        LEFT JOIN entry_catalog c ON c.entry_id=e.id
        WHERE json_extract(b.settings,'$.played')=1
          AND NOT EXISTS(SELECT 1 FROM reference_bases r WHERE r.base_id=e.base_id)
          AND NOT EXISTS(SELECT 1 FROM computer_game_copies g WHERE g.entry_id=e.id)
          AND (c.entry_id IS NULL OR c.played_day BETWEEN ? AND ?)
        ORDER BY e.id'''
    selected = {}
    for row in conn.execute(query, (lo, hi)):
        try:
            headers = (json.loads(row['headers']) if row['headers'] is not None else
                       dict(chess.pgn.read_headers(io.StringIO(row['uncached_pgn'])) or {}))
        except (ValueError, TypeError, IndexError, KeyError, RecursionError):
            continue
        if not isinstance(headers, dict):
            continue
        if 'SourceEntry' in headers or 'SourcePly' in headers:
            continue
        day = _played_day(headers, settings)
        if day is None or not lower <= day <= upper:
            continue
        text = row['uncached_pgn']
        if text is None:
            text = conn.execute('SELECT pgn FROM entries WHERE id=?', (row['id'],)).fetchone()['pgn']
        try:
            game = pgnlib.load_game(text)
            if not game.variations:
                continue
            duration, kind = _duration(game)
        except (ValueError, TypeError, IndexError, KeyError, RecursionError, OverflowError):
            continue
        imported = (conn.execute('SELECT site,remote_id FROM sync_imports WHERE entry_id=? ORDER BY site,remote_id LIMIT 1',
                                 (row['id'],)).fetchone() if has_imports else None)
        key = _identity(game, row['id'], imported)
        previous = selected.get(key)
        # Prefer a measured copy over an estimate; stable entry order resolves
        # equal-quality copies without changing attribution on every refresh.
        if previous is not None and QUALITY[previous['duration_kind']] >= QUALITY[kind]:
            continue
        selected[key] = {'activity': 'games', 'date': day.isoformat(),
                         'duration_ms': duration, 'duration_kind': kind,
                         'quantity': 1, 'unit': 'games', 'attempts': None, 'sessions': 0,
                         'resource': training_activity._resource(conn, row['base_id']),
                         'unknown': duration is None}
    return list(selected.values())
