"""Opening statistics and saved source choices for ChessGym's analysis board.

Public queries send a position and filters to the Lichess opening explorer.
Private PGNs, game headers, and account information stay in the local database.
"""
from copy import deepcopy
import json
from analysis_limits import MIN_DEPTH, MAX_DEPTH
from time import monotonic

import chess

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

import db
import pgnlib
import explorer_local
import explorer_remote
import explorer_credentials
import reference_queries


router = APIRouter(prefix='/api/explorer')
RATINGS = (0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500)
SPEEDS = ('ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence')
LOCAL_SPEEDS = (*SPEEDS, 'unknown')
DEFAULT_SETTINGS = {
    'source': 'lichess', 'base_ids': [], 'speeds': ['rapid'],
    'ratings': [1600, 1800], 'master_source': 'masters', 'master_base_ids': [],
    'engine_depth': None, 'repertoire_color': 'white', 'show_probability': True,
    'local_filters': {'rating_min': None, 'rating_max': None, 'speeds': []},
    'master_local_filters': {'rating_min': None, 'rating_max': None, 'speeds': []},
    'master_ratings': [1600, 1800], 'master_speeds': ['rapid'],
}
SETTINGS_KEY = 'explorer_settings'
MAX_PROBABILITY_PLIES = 120
PROBABILITY_TIME_BUDGET = 15


def _bases(conn):
    return {row['id']: row['name'] for row in conn.execute('SELECT id,name FROM bases')}


def _read_settings(conn, bases):
    row = conn.execute('SELECT value FROM preferences WHERE key=?', (SETTINGS_KEY,)).fetchone()
    settings = deepcopy(DEFAULT_SETTINGS)
    if row:
        settings.update(json.loads(row['value']))
    # Deleting a source must not silently select a different collection.
    for field in ('base_ids', 'master_base_ids'):
        settings[field] = [base for base in settings[field] if base in bases]
    return settings


def validate_settings(patch, current, bases):
    if not isinstance(patch, dict) or set(patch) - set(DEFAULT_SETTINGS):
        raise ValueError('Réglage d’explorer inconnu.')
    settings = {**deepcopy(DEFAULT_SETTINGS), **deepcopy(current), **patch}
    if settings['source'] not in ('lichess', 'local', 'masters'):
        raise ValueError('Choisis une source de parties valide.')
    if settings['master_source'] not in ('masters', 'lichess', 'local', 'none'):
        raise ValueError('Choisis une référence de comparaison valide.')
    if settings['repertoire_color'] not in ('white', 'black'):
        raise ValueError('Choisis les blancs ou les noirs pour le répertoire.')
    if type(settings['show_probability']) is not bool:
        raise ValueError('Le choix d’afficher la probabilité doit être vrai ou faux.')
    depth = settings['engine_depth']
    if depth is not None and (type(depth) is not int or not MIN_DEPTH <= depth <= MAX_DEPTH):
        raise ValueError('Choisis le mode rapide ou une profondeur Stockfish entière positive.')
    for key in ('base_ids', 'master_base_ids'):
        ids = settings[key]
        if not isinstance(ids, list) or len(ids) > 100 or any(type(i) is not int or i not in bases for i in ids):
            raise ValueError('Une base sélectionnée n’existe plus. Actualise les réglages de l’explorer.')
        settings[key] = sorted(set(ids))
    for key, choices in (('ratings', RATINGS), ('speeds', SPEEDS),
                         ('master_ratings', RATINGS), ('master_speeds', SPEEDS)):
        values = settings[key]
        expected_type = int if key.endswith('ratings') else str
        if (not isinstance(values, list) or not values or len(values) > len(choices)
                or any(type(value) is not expected_type or value not in choices for value in values)):
            raise ValueError('Sélectionne au moins une tranche de classement Lichess et une cadence valides.')
        settings[key] = [value for value in choices if value in values]
    for key in ('local_filters', 'master_local_filters'):
        values = patch.get(key, current.get(key, DEFAULT_SETTINGS[key]))
        if not isinstance(values, dict) or set(values) - set(DEFAULT_SETTINGS[key]):
            raise ValueError('Filtres de base locale invalides.')
        filters = {**DEFAULT_SETTINGS[key], **current.get(key, {}), **values}
        for bound in ('rating_min', 'rating_max'):
            value = filters[bound]
            if value is not None and (type(value) is not int or not 0 <= value <= 4000):
                raise ValueError('Indique un classement entier de 0 à 4 000, ou laisse la borne vide.')
        low, high = filters['rating_min'], filters['rating_max']
        if low is not None and high is not None and low > high:
            raise ValueError('Le classement minimum doit être inférieur ou égal au maximum.')
        speeds = filters['speeds']
        if (not isinstance(speeds, list) or len(speeds) > len(LOCAL_SPEEDS)
                or any(type(value) is not str or value not in LOCAL_SPEEDS for value in speeds)):
            raise ValueError('Choisis des cadences locales valides.')
        filters['speeds'] = [value for value in LOCAL_SPEEDS if value in speeds]
        settings[key] = filters
    return settings


@router.get('/settings')
def get_settings():
    with db.get_conn() as conn:
        return _read_settings(conn, _bases(conn))


@router.patch('/settings')
def patch_settings(payload: dict):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        bases = _bases(conn)
        settings = validate_settings(payload, _read_settings(conn, bases), bases)
        conn.execute('INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                     (SETTINGS_KEY, json.dumps(settings)))
    return settings


def _dataset(source, fen, ids, settings, bases):
    if source == 'none':
        return {'source': 'none', 'label': 'Aucune référence', 'status': 'disabled',
                'total': 0, 'white': 0, 'draws': 0, 'black': 0, 'unknown': 0,
                'moves': [], 'cached': False, 'stale': False}
    if source == 'local':
        result = explorer_local.local_data(fen, ids, **settings['local_filters'])
        label = ' · '.join(bases[i] for i in ids) if ids else 'Aucune base sélectionnée'
        result = {**result, 'label': label}
        if not ids:
            result['message'] = 'Choisis une ou plusieurs bases dans les réglages de l’explorer.'
    else:
        result = explorer_remote.remote_data(source, fen, ratings=settings['ratings'], speeds=settings['speeds'], token=explorer_credentials.get_token())
        result = {**result, 'label': 'Maîtres Lichess' if source == 'masters' else 'Joueurs Lichess'}
    return {'cached': False, 'stale': False, **result, 'source': source}


def _usable(dataset):
    return dataset['status'] == 'ok' or dataset.get('stale', False)


def _comparison_settings(settings):
    """Adapt the independent comparison profile to the shared dataset reader."""
    return {**settings, 'ratings': settings['master_ratings'],
            'speeds': settings['master_speeds'],
            'local_filters': settings['master_local_filters']}


def _same_dataset(settings, comparison):
    source = settings['source']
    if source != settings['master_source']:
        return False
    if source == 'local':
        return (settings['base_ids'] == settings['master_base_ids']
                and settings['local_filters'] == comparison['local_filters'])
    if source == 'lichess':
        return (settings['ratings'] == comparison['ratings']
                and settings['speeds'] == comparison['speeds'])
    # The remote masters endpoint has no cadence/rating filters.
    return source == 'masters'


def combine_moves(board, primary, masters):
    """Join by legal UCI, never by notation or the current board orientation."""
    peer_moves = {move['uci']: move for move in primary['moves']} if _usable(primary) else {}
    master_moves = {move['uci']: move for move in masters['moves']} if _usable(masters) else {}
    legal = {move.uci(): move for move in board.legal_moves}
    rows = []
    for uci in peer_moves.keys() | master_moves.keys():
        if uci not in legal:
            continue
        peer, master = peer_moves.get(uci, {}), master_moves.get(uci, {})
        peer_total = peer.get('total', 0)
        peer_known = _usable(primary) and (uci in peer_moves or primary.get('complete', True))
        master_known = _usable(masters) and (uci in master_moves or masters.get('complete', True))
        master_total = master.get('total', 0) if master_known else None
        row = {'uci': uci, 'san': board.san(legal[uci]), 'total': peer_total,
               **{key: peer.get(key, 0) for key in ('white', 'draws', 'black', 'unknown')},
               'frequency': 100 * peer_total / primary['total'] if peer_known and primary['total'] else None,
               'master_total': master_total,
               'master_frequency': 100 * master_total / masters['total'] if master_total is not None and masters['total'] else None}
        if peer.get('results_available') is False:
            row['results_available'] = False
        if peer.get('average_rating') is not None:
            row['average_rating'] = peer['average_rating']
        rows.append(row)
    return sorted(rows, key=lambda row: (-row['total'], -(row['master_total'] or 0), row['san']))


@router.post('')
async def query(payload: dict, request: Request):
    if set(payload) - {'fen', 'settings'}:
        raise ValueError('L’explorer attend une position FEN et ses réglages.')
    raw_fen = payload.get('fen')
    if not isinstance(raw_fen, str) or not 1 <= len(raw_fen) <= 256:
        raise ValueError('Indique une position FEN valide.')
    board = pgnlib.validate_board(raw_fen)
    fen = board.fen()
    settings, bases = await run_in_threadpool(_probability_settings, payload.get('settings', {}))
    # Do not keep a SQLite transaction open while waiting for public statistics.
    primary = await _requested_dataset(request, settings['source'], fen, settings['base_ids'], settings, bases)
    comparison = _comparison_settings(settings)
    if _same_dataset(settings, comparison):
        masters = deepcopy(primary)
    else:
        masters = await _requested_dataset(request, settings['master_source'], fen, settings['master_base_ids'], comparison, bases)
    return {'fen': fen, 'settings': settings, 'primary': primary, 'masters': masters,
            'moves': combine_moves(board, primary, masters)}


async def _requested_dataset(request, source, fen, ids, settings, bases):
    if source != 'local':
        return await run_in_threadpool(_dataset, source, fen, ids, settings, bases)
    try:
        return await reference_queries.run(request, _dataset, source, fen, ids, settings, bases)
    except reference_queries.QueryStopped as stopped:
        return {**reference_queries.unavailable(stopped.reason), 'source': source,
                'label': ' · '.join(bases[i] for i in ids)}


def _probability_settings(patch):
    with db.get_conn() as conn:
        bases = _bases(conn)
        return validate_settings(patch, _read_settings(conn, bases), bases), bases


def _probability_unavailable(result, reason, message):
    return {**result, 'status': 'unavailable', 'probability': None,
            'reason': reason, 'message': message}


@router.post('/probability')
async def probability(payload: dict, request: Request):
    """Estimate a specific path assuming the chosen side always plays its moves.

    Each opposing move uses its position's primary-source count / total. This is
    an estimate along the selected path, not a sum over transpositions or an
    empirical probability of all games arriving at the final position. A custom
    FEN starts a conditional estimate at that position. Unknown counts never
    become zero; zero is reserved for a sampled, complete position's absent move.
    """
    if set(payload) - {'fen', 'start_fen', 'moves', 'settings'}:
        raise ValueError('La probabilité attend les positions, la ligne et ses réglages.')
    for field in ('fen', 'start_fen'):
        if not isinstance(payload.get(field), str) or not 1 <= len(payload[field]) <= 256:
            raise ValueError('Indique une position FEN valide.')
    target = pgnlib.validate_board(payload['fen'])
    board = pgnlib.validate_board(payload['start_fen'])
    moves = payload.get('moves')
    if not isinstance(moves, list):
        raise ValueError('Indique la ligne de coups UCI depuis la position initiale.')
    settings, bases = await run_in_threadpool(_probability_settings, payload.get('settings', {}))
    own_turn = settings['repertoire_color'] == 'white'
    opponent_moves = len(moves) // 2 + int(len(moves) % 2 and board.turn != own_turn)
    result = {
        'fen': target.fen(), 'start_fen': board.fen(),
        'repertoire_color': settings['repertoire_color'],
        'status': 'ok', 'probability': 1.0, 'opponent_moves': opponent_moves,
        'evaluated_opponent_moves': 0, 'stale': False, 'sample_min': None,
        'conditional_root': explorer_local.position_key(board) != explorer_local.position_key(chess.Board()),
    }
    if len(moves) > MAX_PROBABILITY_PLIES:
        return _probability_unavailable(result, 'path_too_long',
            'La probabilité est disponible pour les lignes de 120 demi-coups au maximum.')
    # Validate the entire path before any dataset lookup, including our own moves
    # and the suffix after a potential zero or unavailable opposing move.
    factors = []
    for ply, uci in enumerate(moves, start=1):
        if not isinstance(uci, str) or not 4 <= len(uci) <= 5:
            raise ValueError('Un coup de la ligne UCI est invalide.')
        try:
            move = board.parse_uci(uci)
        except ValueError as exc:
            raise ValueError('Un coup de la ligne est illégal depuis cette position.') from exc
        if not move:
            raise ValueError('Les coups nuls ne font pas partie d’une ligne de répertoire.')
        if board.turn != own_turn:
            factors.append((ply, board.fen(), move.uci()))
        board.push(move)
    if board.fen() != target.fen():
        raise ValueError('La ligne ne mène pas à la position demandée.')

    deadline = monotonic() + PROBABILITY_TIME_BUDGET
    for ply, fen, uci in factors:
        # Abort old navigation work between bounded dataset calls. In particular,
        # a disconnected browser must not leave a long remote crawl running.
        if await request.is_disconnected():
            return _probability_unavailable(result, 'disconnected', 'Le calcul a été interrompu.')
        if monotonic() >= deadline:
            return _probability_unavailable(result, 'deadline',
                'Le calcul prend trop de temps. Réessaie pour utiliser les données déjà en mémoire.')
        dataset = await _requested_dataset(request, settings['source'], fen,
                                           settings['base_ids'], settings, bases)
        result['stale'] = result['stale'] or dataset.get('stale', False)
        if not _usable(dataset):
            return _probability_unavailable(result, dataset['status'],
                dataset.get('message') or 'Les statistiques de la ligne sont indisponibles.')
        total = dataset['total']
        if total <= 0:
            return _probability_unavailable(result, 'no_samples',
                'Pas assez de parties à cette étape pour estimer la fréquence de la ligne.')
        sample = next((row for row in dataset['moves'] if row['uci'] == uci), None)
        if sample is None and not dataset.get('complete', True):
            return _probability_unavailable(result, 'incomplete_sample',
                'La liste des réponses est incomplète : la fréquence de ce coup est inconnue.')
        count = sample['total'] if sample is not None else 0
        result['sample_min'] = total if result['sample_min'] is None else min(result['sample_min'], total)
        result['evaluated_opponent_moves'] += 1
        product = result['probability'] * (count / total)
        if count > 0 and product == 0:
            return _probability_unavailable(result, 'underflow',
                'Cette ligne est trop rare pour afficher une estimation numérique fiable.')
        result['probability'] = product
        if count == 0:
            # No need to query descendants of a known-zero sampled factor.
            return result
    return result
