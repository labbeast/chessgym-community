"""Bounded, explicit repertoire scans and cached opening-review priorities.

Scores are probabilities of the most frequent known path, never a sum across
our alternative choices or transpositions. Scanning never changes any PGN.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import heapq
import itertools
import json
import math
import sqlite3
import threading
import time

import chess
import chess.pgn
from fastapi import APIRouter, HTTPException, Request

import db
import explorer_credentials
import explorer_remote
import pgnlib

router = APIRouter(prefix='/api/repertoires')
CACHE_SECONDS = 7 * 24 * 60 * 60
TIME_BUDGET = 15
MAX_REQUESTS = 40
MAX_GRAPH_NODES = 20000
MAX_VISITS = 5000
MAX_GAPS = 200
DEFAULT_FILTERS = {'ratings': [1600, 1800], 'speeds': ['rapid']}
DEFAULT_OPTIONS = {'min_probability': .01, 'max_ply': 20}
_locks = {}
_locks_guard = threading.Lock()


def init_coverage():
    with db.get_conn() as conn:
        conn.execute('''CREATE TABLE IF NOT EXISTS repertoire_coverage (
            base_id INTEGER PRIMARY KEY REFERENCES bases(id) ON DELETE CASCADE,
            fingerprint TEXT NOT NULL, filters TEXT NOT NULL, options TEXT NOT NULL,
            samples TEXT NOT NULL, report TEXT NOT NULL, updated_at TEXT NOT NULL
        )''')


def _key(board):
    return ' '.join(board.fen(en_passant='legal').split()[:4])


def _settings(base):
    try:
        value = json.loads(base['settings'])
    except (ValueError, TypeError):
        value = {}
    return value if isinstance(value, dict) else {}


def _source(conn, base_id):
    base = conn.execute('SELECT * FROM bases WHERE id=?', (base_id,)).fetchone()
    if base is None:
        raise HTTPException(404, 'Base introuvable.')
    settings = _settings(base)
    if not settings.get('is_repertoire'):
        raise HTTPException(422, 'Cette base n’est pas un répertoire d’ouvertures.')
    entries = [dict(row) for row in conn.execute(
        'SELECT id,pgn,selected FROM entries WHERE base_id=? ORDER BY id', (base_id,))]
    # Scheduling, titles and view settings must not invalidate a content scan.
    identity = {'color': settings.get('color', 'white'), 'is_repertoire': True,
                'entries': [[e['id'], e['pgn'], e['selected']] for e in entries]}
    fingerprint = hashlib.sha256(json.dumps(identity, ensure_ascii=False,
        sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return dict(base), entries, fingerprint


def _saved(conn, base_id):
    try:
        row = conn.execute('SELECT * FROM repertoire_coverage WHERE base_id=?', (base_id,)).fetchone()
    except sqlite3.OperationalError as exc:
        if 'no such table' in str(exc):
            return None
        raise
    if not row:
        return None
    try:
        value = {**dict(row), **{key: json.loads(row[key]) for key in ('filters', 'options', 'samples', 'report')}}
        return value if all(isinstance(value[key], dict) for key in ('filters', 'options', 'samples', 'report')) else None
    except (ValueError, TypeError):
        return None


def _snapshot(base_id):
    with db.get_conn() as conn:
        conn.execute('BEGIN')
        base, entries, fingerprint = _source(conn, base_id)
        return base, entries, fingerprint, _saved(conn, base_id)


def _fresh(timestamp):
    try:
        age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(timestamp).timestamp()
        return 0 <= age <= CACHE_SECONDS
    except (TypeError, ValueError, OverflowError):
        return False


def _report_fresh(saved):
    # Re-running a scan from cached counts must not restart those counts' TTL.
    report = saved['report']
    used = report.get('sample_keys')
    try:
        valid = datetime.fromisoformat(report['valid_until']) > datetime.now(timezone.utc)
    except (KeyError, TypeError, ValueError):
        return False
    return (valid and _fresh(saved['updated_at']) and isinstance(used, list)
            and all(isinstance(saved['samples'].get(key), dict)
            and _fresh(saved['samples'][key].get('fetched_at')) for key in used))


def cached_priorities(conn, base_id):
    """No network, DDL, commit or transaction changes: safe during card sync."""
    saved = _saved(conn, base_id)
    if not saved or not _report_fresh(saved):
        return {}
    try:
        _, _, fingerprint = _source(conn, base_id)
    except HTTPException:
        return {}
    if fingerprint != saved['fingerprint']:
        return {}
    report = saved['report']
    if (report.get('filters') != saved['filters'] or report.get('options') != saved['options']
            or not isinstance(report.get('priorities'), dict)):
        return {}
    return {key: value for key, value in report['priorities'].items()
            if isinstance(key, str) and type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1}


def _empty(base, saved=None, changed=False):
    return {'base_id': base['id'], 'color': _settings(base).get('color', 'white'),
            'status': 'not_scanned', 'updated_at': None,
            'filters': deepcopy(saved['filters'] if saved else DEFAULT_FILTERS),
            'options': deepcopy(saved['options'] if saved else DEFAULT_OPTIONS),
            'conditional_root': False, 'mixed_roots': False, 'positions_scanned': 0,
            'request_count': 0, 'prepared_count': 0, 'gaps': [], 'best_gap': None, 'priorities': {},
            'unknown_count': 0, 'truncated': False, 'stale': bool(changed),
            'limit_reasons': [], 'needs_narrowing': False, 'resumable': False,
            'message': ('Le répertoire ou les statistiques ont changé : actualise cet examen.'
                        if changed else 'Lance un examen pour repérer les réponses les plus fréquentes à préparer.')}


@router.get('/{base_id}/coverage')
def get_coverage(base_id: int):
    base, _, fingerprint, saved = _snapshot(base_id)
    if saved and saved['fingerprint'] == fingerprint and _report_fresh(saved):
        return saved['report']
    return _empty(base, saved, changed=saved is not None)


def _options(payload, saved):
    if not isinstance(payload, dict) or set(payload) - {'ratings', 'speeds', 'min_probability', 'max_ply', 'reset'}:
        raise HTTPException(422, 'Réglage d’examen inconnu.')
    filters = deepcopy(saved['filters'] if saved else DEFAULT_FILTERS)
    options = deepcopy(saved['options'] if saved else DEFAULT_OPTIONS)
    for key in filters:
        if key in payload:
            filters[key] = payload[key]
    for key in options:
        if key in payload:
            options[key] = payload[key]
    try:
        ratings, speeds = explorer_remote._filters(filters['ratings'], filters['speeds'])
    except (ValueError, TypeError):
        raise HTTPException(422, 'Choisis des tranches de classement et des cadences Lichess valides.')
    filters = {'ratings': list(ratings), 'speeds': list(speeds)}
    value = options['min_probability']
    if type(value) not in (int, float) or not math.isfinite(value) or not .0001 <= value <= 1:
        raise HTTPException(422, 'Choisis un seuil de probabilité entre 0,01 % et 100 %.')
    if type(options['max_ply']) is not int or not 1 <= options['max_ply'] <= 60:
        raise HTTPException(422, 'Choisis un horizon de 1 à 60 demi-coups.')
    if type(payload.get('reset', False)) is not bool:
        raise HTTPException(422, 'Le choix de recommencer doit être vrai ou faux.')
    return filters, options


def _graph(entries):
    positions, roots = {}, {}
    visited, invalid, limited = 0, 0, False
    for entry in entries:
        try:
            game = pgnlib.load_game(entry['pgn'])
        except (ValueError, RecursionError, HTTPException):
            invalid += 1
            continue
        root = game.board()
        # Ignore introductory chapters made solely of prose/null moves.
        if not any(child.move for child in game.variations) and _key(root) == _key(chess.Board()):
            continue
        roots.setdefault(_key(root), root.fen())
        stack = [(game, root, '')]
        while stack:
            node, board, path = stack.pop()
            visited += 1
            if visited > MAX_GRAPH_NODES:
                limited = True
                break
            position = positions.setdefault(_key(board), {'fen': board.fen(), 'entry_id': entry['id'], 'path': path, 'edges': {}})
            for index, child in reversed(list(enumerate(node.variations))):
                if not child.move:
                    continue
                target = board.copy(stack=False)
                target.push(child.move)
                position['edges'][child.move.uci()] = _key(target)
                stack.append((child, target, f'{path}.{index}' if path else str(index)))
        if limited:
            break
    return positions, roots, invalid, limited


def _line(root_fen, moves):
    game = chess.pgn.Game()
    board = chess.Board(root_fen)
    game.setup(board)
    game.headers['Event'] = 'Ligne à compléter'
    node = game
    for uci in moves:
        move = board.parse_uci(uci)
        node = node.add_variation(move)
        board.push(move)
    text = str(game.accept(chess.pgn.StringExporter(headers=False, variations=False, comments=False)))
    return text.removesuffix(' *').strip(), pgnlib.export_game(game)


def _gap(kind, board, probability, root_fen, moves, origin, *, uci=None, san=None, frequency=None):
    line, pgn = _line(root_fen, moves)
    return {'key': _key(board), 'kind': kind, 'fen': board.fen(),
            'probability': probability, 'frequency': frequency, 'uci': uci, 'san': san,
            'entry_id': origin.get('entry_id'), 'path': origin.get('path', ''),
            'root_fen': root_fen, 'moves': list(moves), 'san_line': line, 'pgn': pgn,
            'conditional_root': _key(chess.Board(root_fen)) != _key(chess.Board())}


def _store(base_id, fingerprint, filters, options, samples, report):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        _, _, current = _source(conn, base_id)
        if current != fingerprint:
            raise HTTPException(409, 'Le répertoire a changé pendant l’examen. Relance-le.')
        encode = lambda value: json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':'))
        conn.execute('''INSERT INTO repertoire_coverage
            (base_id,fingerprint,filters,options,samples,report,updated_at) VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(base_id) DO UPDATE SET fingerprint=excluded.fingerprint,
                filters=excluded.filters,options=excluded.options,samples=excluded.samples,
                report=excluded.report,updated_at=excluded.updated_at''',
            (base_id, fingerprint, encode(filters), encode(options), encode(samples), encode(report), report['updated_at']))


@router.post('/{base_id}/coverage')
async def scan_coverage(base_id: int, payload: dict, request: Request):
    lock_key = (str(db.DB_PATH.resolve()), base_id)
    with _locks_guard:
        lock = _locks.setdefault(lock_key, threading.Lock())
    if not lock.acquire(blocking=False):
        raise HTTPException(409, 'Un examen de ce répertoire est déjà en cours.')
    try:
        return await _scan(base_id, payload, request)
    finally:
        lock.release()


async def _scan(base_id, payload, request):
    started = time.monotonic()
    base, entries, fingerprint, saved = await asyncio.to_thread(_snapshot, base_id)
    filters, options = _options(payload, saved)
    samples = deepcopy(saved['samples']) if saved and saved['filters'] == filters and not payload.get('reset') else {}
    samples = {key: value for key, value in samples.items() if isinstance(value, dict) and _fresh(value.get('fetched_at'))}
    positions, roots, invalid, graph_limited = await asyncio.to_thread(_graph, entries)
    own = _settings(base).get('color', 'white') != 'black'
    token = await asyncio.to_thread(explorer_credentials.get_token)
    heap, sequence = [], itertools.count()
    for root_key, root_fen in roots.items():
        heapq.heappush(heap, (-1., 0, next(sequence), root_fen, [], frozenset()))
    best, priorities, gaps, unknown, used_samples = {}, {}, {}, set(), set()
    best_gap = None
    limit_reasons = {'source_size'} if graph_limited else set()
    requests, visits, truncated, stale = 0, 0, graph_limited, False
    message, network_stopped = '', False
    for index in range(invalid):
        unknown.add(f'invalid:{index}')

    def add_gap(gap):
        nonlocal best_gap
        rank = lambda value: (-value['probability'], len(value['moves']), value['key'])
        if best_gap is None or rank(gap) < rank(best_gap):
            best_gap = gap
        # The list keeps its configured threshold. Only one additional result
        # is retained for the Largest gap shortcut, even below that threshold.
        if gap['probability'] < options['min_probability']:
            return
        previous = gaps.get(gap['key'])
        if previous is None or gap['probability'] > previous['probability']:
            gaps[gap['key']] = gap

    def push(board, chance, root_fen, moves, ancestors):
        if (chance > 0 and _key(board) not in ancestors
                and (chance >= options['min_probability']
                     or best_gap is None or chance > best_gap['probability'])):
            heapq.heappush(heap, (-chance, len(moves), next(sequence), root_fen, moves, ancestors))

    while heap:
        # Opponent replies can only reduce a path's probability. Once the best
        # remaining below-threshold path cannot beat a known gap, no additional
        # network crawl is needed. Above-threshold list exploration is unchanged.
        if (best_gap is not None and -heap[0][0] < options['min_probability']
                and -heap[0][0] <= best_gap['probability']):
            break
        if visits >= MAX_VISITS or time.monotonic() - started >= TIME_BUDGET:
            truncated = True
            limit_reasons.add('position_limit' if visits >= MAX_VISITS else 'time_limit')
            break
        if request is not None and await request.is_disconnected():
            truncated = True
            limit_reasons.add('disconnected')
            message = 'Examen interrompu; les statistiques déjà obtenues sont conservées.'
            break
        negative, ply, _, root_fen, moves, ancestors = heapq.heappop(heap)
        chance = -negative
        board = chess.Board(root_fen)
        for uci in moves:
            board.push_uci(uci)
        key = _key(board)
        route_key = (_key(chess.Board(root_fen)), key)
        # Separate depth frontiers: an equally likely shorter route may explore
        # farther, while repeated positions within one route are never expanded.
        previous = best.get(route_key)
        if previous and previous[0] >= chance and previous[1] <= ply:
            continue
        best[route_key] = (chance, ply)
        visits += 1
        if board.is_game_over():
            continue
        position = positions.get(key)
        if position is None:
            unknown.add(key)
            continue
        ancestors = ancestors | {key}
        if board.turn == own:
            if position['edges']:
                if chance >= options['min_probability']:
                    priorities[key] = max(priorities.get(key, 0), chance)
                if ply < options['max_ply']:
                    for uci in position['edges']:
                        child = board.copy(stack=False)
                        child.push_uci(uci)
                        push(child, chance, root_fen, moves + [uci], ancestors)
            elif ply < options['max_ply']:
                add_gap(_gap('own_reply', board, chance, root_fen, moves, position))
            continue
        if ply >= options['max_ply']:
            continue
        cached = samples.get(key)
        dataset = cached.get('data') if cached else None
        if dataset is None:
            if network_stopped:
                unknown.add(key)
                continue
            if requests >= MAX_REQUESTS:
                unknown.add(key)
                truncated = True
                limit_reasons.add('request_limit')
                continue
            remaining = TIME_BUDGET - (time.monotonic() - started)
            if remaining <= .05:
                truncated = True
                limit_reasons.add('time_limit')
                break
            requests += 1
            try:
                dataset = await asyncio.wait_for(asyncio.to_thread(
                    explorer_remote.remote_data, 'lichess', board.fen(),
                    ratings=filters['ratings'], speeds=filters['speeds'], token=token,
                    cache_ttl=CACHE_SECONDS), timeout=remaining)
            except asyncio.TimeoutError:
                unknown.add(key)
                truncated = True
                limit_reasons.add('time_limit')
                message = 'Examen partiel : la limite de temps a été atteinte. Continue pour compléter les statistiques.'
                break
            if dataset.get('status') != 'ok' and not dataset.get('stale'):
                unknown.add(key)
                network_stopped = True
                message = dataset.get('message') or 'Statistiques indisponibles pour certaines positions.'
                continue
            fetched = dataset.get('fetched_at') or datetime.now(timezone.utc).isoformat()
            samples[key] = {'fetched_at': fetched, 'data': dataset}
        used_samples.add(key)
        stale = stale or bool(dataset.get('stale'))
        total = dataset.get('total', 0)
        if type(total) is not int or total <= 0:
            unknown.add(key)
            continue
        if not dataset.get('complete', True):
            unknown.add(key)
        for row in dataset.get('moves', []):
            if time.monotonic() - started >= TIME_BUDGET:
                truncated = True
                limit_reasons.add('time_limit')
                break
            count = row.get('total')
            if type(count) is not int or not 0 <= count <= total:
                unknown.add(key)
                continue
            probability = chance * count / total
            if probability <= 0:
                continue
            try:
                move = board.parse_uci(row['uci'])
                if not move:
                    raise ValueError('null move')
            except (KeyError, ValueError, TypeError):
                unknown.add(key)
                continue
            child = board.copy(stack=False)
            child.push(move)
            child_key = _key(child)
            target = positions.get(child_key)
            child_moves = moves + [move.uci()]
            # A missing move order that transposes into a prepared answer is
            # already covered by that position, not an artificial new hole.
            if move.uci() not in position['edges'] and not (target and target['edges']):
                if not child.is_game_over():
                    add_gap(_gap('opponent_reply', child, probability, root_fen,
                        child_moves, position, uci=move.uci(), san=board.san(move), frequency=count / total))
            else:
                push(child, probability, root_fen, child_moves, ancestors)

    ordered = sorted(gaps.values(), key=lambda gap: (-gap['probability'], len(gap['moves']), gap['key']))
    if len(ordered) > MAX_GAPS:
        truncated = True
        limit_reasons.add('result_limit')
    conditional = any(key != _key(chess.Board()) for key in roots)
    partial = bool(truncated or unknown)
    needs_narrowing = bool(limit_reasons & {'source_size', 'position_limit', 'result_limit'})
    if 'source_size' in limit_reasons:
        message = 'La limite de taille du répertoire est atteinte. Répartis ses lignes dans des bases plus petites pour examiner la suite.'
    elif needs_narrowing:
        message = 'La limite de positions ou de résultats est atteinte. Augmente le seuil de probabilité ou réduis l’horizon, puis recalcule.'
    elif not message:
        message = ('Examen partiel : continue pour examiner les positions restantes.' if truncated else
                   'Certaines statistiques sont absentes ou incomplètes. Change les filtres ou actualise plus tard; les fréquences inconnues ne valent pas zéro.' if unknown else
                   'Chemins examinés au seuil et à l’horizon choisis. Les probabilités des transpositions ne sont pas additionnées.')
    if not roots:
        message = 'Aucune ligne jouable dans ce répertoire. Ajoute une ligne pour commencer.'
    updated = datetime.now(timezone.utc)
    expiry = updated.timestamp() + CACHE_SECONDS
    for key in used_samples:
        try:
            expiry = min(expiry, datetime.fromisoformat(samples[key]['fetched_at']).timestamp() + CACHE_SECONDS)
        except (TypeError, ValueError):
            expiry = updated.timestamp()
    report = {'base_id': base_id, 'color': 'white' if own else 'black',
        'status': 'partial' if partial else 'complete', 'updated_at': updated.isoformat(),
        'valid_until': datetime.fromtimestamp(expiry, timezone.utc).isoformat(), 'sample_keys': sorted(used_samples),
        'filters': filters, 'options': options, 'conditional_root': conditional,
        'mixed_roots': len(roots) > 1, 'positions_scanned': visits, 'request_count': requests,
        'prepared_count': len(priorities), 'priorities': priorities, 'gaps': ordered[:MAX_GAPS],
        'best_gap': best_gap,
        'unknown_count': len(unknown), 'truncated': truncated, 'stale': stale,
        'limit_reasons': sorted(limit_reasons), 'needs_narrowing': needs_narrowing,
        'resumable': bool(limit_reasons) and not needs_narrowing,
        'message': message, 'probability_method': 'maximum_path'}
    await asyncio.to_thread(_store, base_id, fingerprint, filters, options, samples, report)
    return report
