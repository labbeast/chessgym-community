"""Public, read-only game downloads; no account credentials are necessary.

Official API contracts checked 2026-10-19:
https://www.chess.com/news/view/published-data-api
https://github.com/lichess-org/api/blob/master/doc/specs/tags/games/api-games-user-username.yaml

Only fixed HTTPS API hosts are contacted. URLs in downloaded PGNs/JSON are
identifiers, never fetch targets. Requests are serialized per provider.
"""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import math
import re
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


MAX_RESPONSE_BYTES = 16 * 1024 * 1024
REQUEST_TIMEOUT = 15
USERNAME = re.compile(r'[A-Za-z0-9_-]{2,50}')
_gates = {'chesscom': threading.Lock(), 'lichess': threading.Lock()}
_blocked_until = {'chesscom': 0.0, 'lichess': 0.0}


class RemoteError(ValueError):
    def __init__(self, message, *, retry_after=None, status=None):
        super().__init__(message)
        self.retry_after = retry_after
        self.status = status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_identity(site, username):
    if site not in ('chesscom', 'lichess'):
        raise ValueError('Choisis Chess.com ou Lichess.')
    if not isinstance(username, str) or not USERNAME.fullmatch(username.strip()):
        raise ValueError('Le pseudonyme doit contenir 2 à 50 lettres, chiffres, tirets ou traits de soulignement.')
    return username.strip().lower()


def game_id(site, url):
    """Canonical identity only. Never follow a game URL (including fragments)."""
    if not isinstance(url, str) or len(url) > 500:
        return None
    try:
        parts = urlsplit(url)
    except ValueError:
        return None
    if parts.scheme not in ('http', 'https') or parts.username or parts.password:
        return None
    if site == 'chesscom' and parts.netloc.lower() in ('chess.com', 'www.chess.com'):
        match = re.fullmatch(r'/(?:game/(live|daily)|live/game|daily/game)/(\d{1,24})/?', parts.path)
        if match:
            kind = match[1] or ('daily' if parts.path.startswith('/daily/') else 'live')
            return kind + ':' + match[2]
    if site == 'lichess' and parts.netloc.lower() in ('lichess.org', 'www.lichess.org'):
        match = re.fullmatch(r'/([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?(?:/(?:white|black))?/?', parts.path)
        if match:
            return match[1]
    return None


def canonical_url(site, remote_id):
    if site == 'lichess':
        return 'https://lichess.org/' + remote_id
    kind, identifier = remote_id.split(':', 1)
    return f'https://www.chess.com/game/{kind}/{identifier}'


def _transport(url, accept, check_cancelled):
    parts = urlsplit(url)
    valid = (parts.netloc == 'api.chess.com' and re.fullmatch(r'/pub/player/[a-z0-9_-]{2,50}/games/(?:archives|\d{4}/\d{2})', parts.path)) or (parts.netloc == 'lichess.org' and re.fullmatch(r'/api/games/user/[a-z0-9_-]{2,50}', parts.path))
    if parts.scheme != 'https' or not valid or parts.fragment:
        raise ValueError('Adresse de synchronisation invalide.')
    request = Request(url, headers={'Accept': accept, 'User-Agent': 'ChessGym/0.1 (personal game archive)', 'Accept-Encoding': 'identity'})
    try:
        with build_opener(_NoRedirect()).open(request, timeout=REQUEST_TIMEOUT) as response:
            chunks, total, deadline = [], 0, time.monotonic() + 40
            while True:
                check_cancelled()
                if time.monotonic() > deadline:
                    raise RemoteError('Le téléchargement prend trop de temps. Réessaie plus tard.')
                # read1 yields each available network chunk, so a slowly streamed
                # export cannot postpone cancellation until 64 KiB accumulate.
                reader = getattr(response, 'read1', response.read)
                chunk = reader(min(65536, MAX_RESPONSE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > MAX_RESPONSE_BYTES:
                    raise RemoteError('Cette archive dépasse 16 Mo. Réduis la période de synchronisation.')
            return response.status, dict(response.headers), b''.join(chunks)
    except HTTPError as error:
        error.close()
        return error.code, dict(error.headers), b''


def _retry_after(headers):
    value = next((v for k, v in headers.items() if k.lower() == 'retry-after'), '')
    try:
        delay = float(value)
        if not math.isfinite(delay):
            raise ValueError()
    except (TypeError, ValueError):
        try:
            stamp = parsedate_to_datetime(value)
            delay = stamp.replace(tzinfo=stamp.tzinfo or timezone.utc).timestamp() - time.time()
        except (TypeError, ValueError, OverflowError):
            delay = 60
    return min(86400, max(60, math.ceil(delay)))


def _request(site, url, accept, check_cancelled):
    gate = _gates[site]
    while not gate.acquire(timeout=.2):
        check_cancelled()
    try:
        check_cancelled()
        remaining = math.ceil(_blocked_until[site] - time.monotonic())
        if remaining > 0:
            raise RemoteError(f'Le site limite temporairement les requêtes. Réessaie dans {remaining} secondes.', retry_after=remaining)
        try:
            status, headers, payload = _transport(url, accept, check_cancelled)
        except (URLError, TimeoutError, OSError) as exc:
            raise RemoteError('Le site est temporairement inaccessible. Réessaie plus tard.') from exc
        if status == 429:
            delay = _retry_after(headers)
            _blocked_until[site] = time.monotonic() + delay
            raise RemoteError(f'Le site limite les requêtes. Réessaie dans {delay} secondes.', retry_after=delay)
        if status == 404:
            raise RemoteError('Ce compte ou cette archive est introuvable. Vérifie le pseudonyme.', status=404)
        if status in (401, 403):
            raise RemoteError('Le site refuse l’accès à ces parties publiques. Réessaie plus tard.')
        if status != 200:
            raise RemoteError('Le site n’a pas fourni les parties. Réessaie plus tard.')
        if not isinstance(payload, bytes) or len(payload) > MAX_RESPONSE_BYTES:
            raise RemoteError('La réponse du site dépasse la taille autorisée.')
        return payload
    finally:
        gate.release()


def _json(payload):
    try:
        return json.loads(payload)
    except (ValueError, UnicodeError) as exc:
        raise RemoteError('Le site a retourné une réponse illisible.') from exc


def download_games(site, username, *, since, max_games, check_cancelled=lambda: None):
    """Return at most max_games candidate records, newest first.

    Records carry PGNs unchanged, so clock comments survive the strict importer.
    Limit reached is reported honestly: the requested window may contain more.
    """
    username = validate_identity(site, username)
    if type(since) not in (int, float) or not math.isfinite(since) or since < 0 or type(max_games) is not int or not 1 <= max_games <= 500:
        raise ValueError('Limites de synchronisation invalides.')
    if site == 'lichess':
        query = urlencode({'since': int(since * 1000), 'max': max_games, 'moves': 'true', 'pgnInJson': 'true', 'tags': 'true', 'clocks': 'true', 'opening': 'true', 'evals': 'false', 'ongoing': 'false', 'finished': 'true', 'sort': 'dateDesc', 'perfType': 'ultraBullet,bullet,blitz,rapid,classical,correspondence'})
        raw = _request(site, f'https://lichess.org/api/games/user/{username}?{query}', 'application/x-ndjson', check_cancelled)
        records = []
        for line in raw.splitlines():
            check_cancelled()
            if not line.strip():
                continue
            if len(records) >= max_games:
                break
            obj = _json(line)
            if not isinstance(obj, dict):
                raise RemoteError('Le site a retourné une partie illisible.')
            identifier = obj.get('id')
            if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9]{8}', identifier):
                identifier = None
            variant = obj.get('variant', 'standard')
            if isinstance(variant, dict):
                variant = variant.get('key')
            records.append({'remote_id': identifier, 'pgn': obj.get('pgn'), 'standard': variant == 'standard', 'finished': obj.get('status') not in (None, 'created', 'started', 'aborted', 'noStart'), 'ended_at': obj.get('lastMoveAt', obj.get('createdAt', 0))})
        return {'games': records, 'limit_reached': len(records) >= max_games}

    base = f'https://api.chess.com/pub/player/{username}/games/'
    archive = _json(_request(site, base + 'archives', 'application/json', check_cancelled))
    urls = archive.get('archives') if isinstance(archive, dict) else None
    if not isinstance(urls, list) or len(urls) > 2400:
        raise RemoteError('Le site a retourné une liste d’archives illisible.')
    cutoff = datetime.fromtimestamp(since, timezone.utc)
    current = datetime.now(timezone.utc)
    months = set()
    for url in urls:
        # Rebuild from validated year/month; never follow remote URLs directly.
        if not isinstance(url, str):
            continue
        match = re.fullmatch(re.escape(base) + r'(\d{4})/(\d{2})', url)
        if not match:
            continue
        year, month = int(match[1]), int(match[2])
        if 1 <= month <= 12 and (cutoff.year, cutoff.month) <= (year, month) <= (current.year, current.month):
            months.add((year, month))
    records = []
    unavailable_months = []

    def result(limit_reached):
        return {'games': records, 'limit_reached': limit_reached,
                'partial': bool(unavailable_months), 'unavailable_months': unavailable_months}

    for year, month in sorted(months, reverse=True):
        check_cancelled()
        try:
            obj = _json(_request(site, f'{base}{year:04d}/{month:02d}', 'application/json', check_cancelled))
        except RemoteError as exc:
            # Chess.com can list a monthly archive before making it available.
            # A missing month is not a missing account: retain the other months
            # and report the gap so the next synchronization will retry it.
            if exc.status != 404:
                raise
            unavailable_months.append(f'{year:04d}-{month:02d}')
            continue
        games = obj.get('games') if isinstance(obj, dict) else None
        if not isinstance(games, list) or len(games) > 100000:
            raise RemoteError('Le site a retourné une archive illisible.')
        games = [g for g in games if isinstance(g, dict) and type(g.get('end_time')) in (int, float) and math.isfinite(g['end_time']) and g['end_time'] >= since]
        for game in sorted(games, key=lambda g: g['end_time'], reverse=True):
            check_cancelled()
            records.append({'remote_id': game_id(site, game.get('url')), 'pgn': game.get('pgn'), 'standard': game.get('rules') == 'chess', 'finished': True, 'ended_at': game['end_time']})
            if len(records) >= max_games:
                return result(True)
    return result(False)
