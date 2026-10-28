"""Bounded, read-only access to the public Lichess opening explorer.

Official schemas (checked 2026-10-19):
https://github.com/lichess-org/api/blob/master/doc/specs/tags/openingexplorer/lichess.yaml
https://github.com/lichess-org/api/blob/master/doc/specs/tags/openingexplorer/masters.yaml
Rating buckets use both players' average, not a Chess.com rating conversion:
https://github.com/lichess-org/lila-openingexplorer/blob/master/src/model/lichess.rs

Apart from the explicitly supplied authentication token, only the position
and public aggregate filters leave this process. No PGN or local database
metadata is sent. Calls are serialized in this
single-process application, as requested by the Lichess API rate-limit policy.
"""
from collections import OrderedDict
from copy import deepcopy
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import hashlib
import math
import re
import sqlite3
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

import chess
import explorer_cache


RATING_GROUPS = (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500)
SPEEDS = ('ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence')
DEFAULT_RATINGS = (1600, 1800)
DEFAULT_SPEEDS = ('rapid',)
BASE_URL = 'https://explorer.lichess.org'
CACHE_TTL = 15 * 60
STALE_TTL = 7 * 24 * 60 * 60
MAX_CACHE_ENTRIES = 256
MAX_RESPONSE_BYTES = 1024 * 1024
REQUEST_TIMEOUT = 8
ERROR_COOLDOWN = 15
RATE_LIMIT_COOLDOWN = 60
MIN_REQUEST_INTERVAL = 1.0

# This lock also deduplicates concurrent requests for the same cache key: a
# waiter checks the result/cache again only after the first request completes.
_gate = threading.Lock()
_cache = OrderedDict()
_blocked_until = 0.0
_blocked_status = 'unavailable'
_blocked_message = ''
_auth_failures = OrderedDict()
_store_context = None
_next_request_at = 0.0


def _persistent_key(key):
    # Versioned, normalized query only; no token or credential fingerprint.
    return hashlib.sha256(json.dumps([1, *key], separators=(',', ':')).encode()).hexdigest()


def _restore_cached(record, board, now):
    """Revalidate disposable disk contents before presenting them as statistics."""
    if record is None:
        return None
    fetched_at, saved = record
    if (not isinstance(fetched_at, (int, float)) or not math.isfinite(fetched_at)
            or fetched_at < 0 or fetched_at > time.time() + 300 or not isinstance(saved, dict)):
        return None
    try:
        raw = {key: saved[key] for key in ('white', 'draws', 'black')}
        raw['moves'] = [{**row, 'averageRating': row.get('average_rating')}
                        for row in saved['moves']]
        result = _validate(json.dumps(raw, allow_nan=False).encode(), board)
        result.update(status='ok', cached=True, stale=False,
                      fetched_at=datetime.fromtimestamp(fetched_at, timezone.utc).isoformat())
        return now - max(0, time.time() - fetched_at), result
    except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
        return None


def _remember(key, cached):
    _cache[key] = cached
    _cache.move_to_end(key)
    while len(_cache) > MAX_CACHE_ENTRIES:
        _cache.popitem(last=False)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _transport(url, token):
    target = urlsplit(url)
    if target.scheme != 'https' or target.netloc != 'explorer.lichess.org' or target.path not in ('/lichess', '/masters'):
        raise ValueError('Invalid explorer endpoint')
    if not isinstance(token, str) or not re.fullmatch(r'[!-~]{8,2048}', token):
        raise ValueError('Invalid explorer credential')
    request = Request(url, headers={
        'Accept': 'application/json',
        'User-Agent': 'ChessGym/0.1 (personal opening explorer)',
        'Authorization': 'Bearer ' + token,
    })
    try:
        with build_opener(_NoRedirect()).open(request, timeout=REQUEST_TIMEOUT) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise ValueError('Explorer response is too large')
            return response.status, response.headers, payload
    except HTTPError as error:
        # Do not follow a redirect or consume/forward an untrusted error body.
        error.close()
        return error.code, error.headers, b''


def _counter(value):
    if type(value) is not int or not 0 <= value <= 2**63 - 1:
        raise ValueError('Invalid explorer counter')
    return value


def _counts(obj):
    if not isinstance(obj, dict):
        raise ValueError('Invalid explorer statistics')
    counts = {key: _counter(obj.get(key)) for key in ('white', 'draws', 'black')}
    return {**counts, 'unknown': 0, 'total': sum(counts.values())}


def _validate(payload, board):
    if not isinstance(payload, bytes) or len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError('Invalid explorer response')
    raw = json.loads(payload)
    result = _counts(raw)
    rows = raw.get('moves')
    if not isinstance(rows, list) or len(rows) > 256:
        raise ValueError('Invalid explorer moves')
    moves, seen = [], set()
    for row in rows:
        counts = _counts(row)
        uci = row.get('uci')
        if not isinstance(uci, str) or not 4 <= len(uci) <= 5:
            raise ValueError('Invalid explorer move')
        # parse_uci accepts standard and rook-square castling UCI, normalizes
        # to the standard move representation, and checks legality.
        move = board.parse_uci(uci)
        canonical = move.uci()
        if not move or canonical in seen:
            raise ValueError('Invalid or duplicate explorer move')
        seen.add(canonical)
        item = {'uci': canonical, 'san': board.san(move), **counts}
        rating = row.get('averageRating')
        if rating is not None:
            if type(rating) is not int or not 0 <= rating <= 10000:
                raise ValueError('Invalid explorer rating')
            item['average_rating'] = rating
        moves.append(item)
    # The service's total includes all moves, even if it truncates the list.
    # Never use the sum of visible rows as the frequency denominator.
    if any(sum(row[key] for row in moves) > result[key] for key in ('white', 'draws', 'black')):
        raise ValueError('Inconsistent explorer totals')
    result['moves'] = sorted(moves, key=lambda row: (-row['total'], row['san']))
    result['complete'] = sum(row['total'] for row in moves) == result['total']
    return result


def _empty(status, message):
    return {'status': status, 'white': 0, 'draws': 0, 'black': 0,
            'unknown': 0, 'total': 0, 'moves': [], 'cached': False,
            'stale': False, 'complete': False, 'fetched_at': None, 'message': message}


def _failed(status, message, cached, now):
    if cached and now - cached[0] <= STALE_TTL:
        result = deepcopy(cached[1])
        result.update(status=status, cached=True, stale=True, message=message)
        return result
    return _empty(status, message)


def _retry_delay(headers):
    value = next((v for k, v in headers.items() if k.lower() == 'retry-after'), '')
    try:
        delay = float(value)
        if not math.isfinite(delay):
            raise ValueError('Non-finite retry delay')
    except (TypeError, ValueError):
        try:
            moment = parsedate_to_datetime(value)
            if moment.tzinfo is None:
                moment = moment.replace(tzinfo=timezone.utc)
            delay = moment.timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            delay = RATE_LIMIT_COOLDOWN
    return max(RATE_LIMIT_COOLDOWN, delay)


def _filters(ratings, speeds):
    ratings = DEFAULT_RATINGS if ratings is None else ratings
    speeds = DEFAULT_SPEEDS if speeds is None else speeds
    if not isinstance(ratings, (list, tuple)) or not ratings or len(ratings) > len(RATING_GROUPS):
        raise ValueError('Choisir au moins une tranche de classement Lichess.')
    if any(type(value) is not int or value not in RATING_GROUPS for value in ratings):
        raise ValueError('Tranche de classement Lichess invalide.')
    if not isinstance(speeds, (list, tuple)) or not speeds or len(speeds) > len(SPEEDS):
        raise ValueError('Choisir au moins une cadence.')
    if any(not isinstance(value, str) or value not in SPEEDS for value in speeds):
        raise ValueError('Cadence invalide.')
    return tuple(sorted(set(ratings))), tuple(value for value in SPEEDS if value in speeds)


def remote_data(source, fen, ratings=None, speeds=None, token=None, *, cache_ttl=CACHE_TTL):
    """Return validated statistics, with explicit outage/cache state.

    Unknown caller inputs raise ValueError before any request. A token is
    required by the current API; it is sent only in the Authorization header.
    Neither the cache nor returned data stores the token. Network or
    upstream response failures return unavailable/rate_limited, never an
    apparent successful empty dataset. Stale counts retain their fetched_at.
    A background scan can accept up to seven-day-old statistics with cache_ttl;
    it shares the interactive cache and cooldown and never forces a retry.
    """
    global _blocked_until, _blocked_status, _blocked_message, _store_context, _next_request_at
    if (type(cache_ttl) not in (int, float) or not math.isfinite(cache_ttl)
            or not 0 <= cache_ttl <= STALE_TTL):
        raise ValueError('La durée du cache doit être comprise entre 0 et 7 jours.')
    if source not in ('lichess', 'masters'):
        raise ValueError('Source distante invalide.')
    if not isinstance(fen, str) or len(fen) > 200:
        raise ValueError('Position FEN invalide.')
    board = chess.Board(fen)
    if not board.is_valid():
        raise ValueError('Position FEN invalide.')
    # Counters do not affect opening statistics; retain legal en passant and
    # castling rights so only equivalent positions share a cache entry.
    canonical_fen = ' '.join(board.fen().split()[:4]) + ' 0 1'
    if source == 'lichess':
        ratings, speeds = _filters(ratings, speeds)
    else:
        ratings, speeds = (), ()
    if not token:
        return _empty('auth_required', 'Ajoute un jeton Lichess dans les réglages de l’explorateur.')
    if not isinstance(token, str) or not re.fullmatch(r'[!-~]{8,2048}', token):
        return _empty('auth_required', 'Le jeton Lichess est invalide. Remplace-le dans les réglages de l’explorateur.')
    fingerprint = hashlib.sha256(token.encode('utf-8')).hexdigest()
    key = (source, canonical_fen, ratings, speeds)
    persistent_key = _persistent_key(key)
    if not _gate.acquire(timeout=REQUEST_TIMEOUT + MIN_REQUEST_INTERVAL + 2):
        return _empty('unavailable', 'L’explorateur distant est occupé. Réessaie dans quelques instants.')
    try:
        now = time.monotonic()
        try:
            context = str(explorer_cache.cache_path().resolve())
            if context != _store_context:
                # Switching an isolated database or restarting the process must
                # neither expose another library's cached state nor lift a 429.
                until = explorer_cache.cooldown()
                if not isinstance(until, (int, float)) or not math.isfinite(until):
                    raise ValueError('Invalid stored cooldown')
                _cache.clear()
                _auth_failures.clear()
                _next_request_at = 0.0
                remaining = max(0, until - time.time())
                _blocked_until = time.monotonic() + remaining if remaining else 0.0
                _blocked_status = 'rate_limited'
                _blocked_message = 'Lichess limite temporairement les requêtes. Réessaie après le délai indiqué.'
                _store_context = context
        except (OSError, sqlite3.Error, ValueError):
            # If the durable rate-limit state cannot be read, do not risk
            # bypassing a cooldown by making a fresh network request.
            return _empty('unavailable', 'Le cache de l’explorateur est momentanément inaccessible.')
        now = time.monotonic()
        # Authentication failures belong to the specific credential, so
        # replacing it does not inherit a previous token's rejection delay.
        if now < _auth_failures.get(fingerprint, 0):
            return _empty('auth_required', 'Le jeton Lichess a été refusé ou a expiré. Remplace-le dans les réglages de l’explorateur.')
        cached = _cache.get(key)
        if cached is None:
            try:
                cached = _restore_cached(explorer_cache.load(persistent_key, time.time()), board, now)
            except (OSError, sqlite3.Error):
                return _empty('unavailable', 'Le cache de l’explorateur est momentanément inaccessible.')
            if cached is not None:
                _remember(key, cached)
        if cached:
            _cache.move_to_end(key)
            if cache_ttl > 0 and now - cached[0] <= cache_ttl:
                result = deepcopy(cached[1])
                result['cached'] = True
                return result
        if now < _blocked_until:
            result = _failed(_blocked_status, _blocked_message, cached, now)
            result['retry_after'] = math.ceil(_blocked_until - now)
            return result
        params = {'fen': canonical_fen, 'moves': 256, 'topGames': 0}
        if source == 'lichess':
            params.update(variant='standard', recentGames=0,
                          ratings=','.join(map(str, ratings)), speeds=','.join(speeds))
        try:
            delay = _next_request_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            _next_request_at = time.monotonic() + MIN_REQUEST_INTERVAL
            status, headers, payload = _transport(BASE_URL + '/' + source + '?' + urlencode(params), token)
            if status in (401, 403):
                _auth_failures[fingerprint] = time.monotonic() + RATE_LIMIT_COOLDOWN
                _auth_failures.move_to_end(fingerprint)
                while len(_auth_failures) > MAX_CACHE_ENTRIES:
                    _auth_failures.popitem(last=False)
                return _empty('auth_required', 'Le jeton Lichess a été refusé ou a expiré. Remplace-le dans les réglages de l’explorateur.')
            if status == 429:
                delay = _retry_delay(headers)
                _blocked_until = time.monotonic() + delay
                _blocked_status = 'rate_limited'
                _blocked_message = 'Lichess limite temporairement les requêtes. Réessaie après le délai indiqué.'
                try:
                    explorer_cache.set_cooldown(time.time() + delay)
                except (OSError, sqlite3.Error):
                    # The live-process guard still applies if the disk becomes
                    # unwritable while the request is in progress.
                    pass
                result = _failed(_blocked_status, _blocked_message, cached, time.monotonic())
                result['retry_after'] = math.ceil(_blocked_until - time.monotonic())
                return result
            if status != 200:
                raise ValueError('Explorer HTTP failure')
            result = _validate(payload, board)
        except (URLError, OSError, ValueError, TypeError, RecursionError):
            _blocked_until = time.monotonic() + ERROR_COOLDOWN
            _blocked_status = 'unavailable'
            _blocked_message = 'Les statistiques Lichess sont momentanément indisponibles.'
            return _failed(_blocked_status, _blocked_message, cached, time.monotonic())
        fetched_at = time.time()
        result.update(status='ok', cached=False, stale=False,
                      fetched_at=datetime.fromtimestamp(fetched_at, timezone.utc).isoformat())
        _remember(key, (time.monotonic(), deepcopy(result)))
        try:
            explorer_cache.save(persistent_key, fetched_at, result)
        except (OSError, sqlite3.Error):
            # Valid data remains usable for this session if persistence fails.
            pass
        return result
    finally:
        _gate.release()
