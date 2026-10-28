"""Read-only comparison of a saved game's main line with an opening repertoire.

Exact move paths establish coverage. Known positions only describe a later
transposition; they never erase an earlier deviation from the repertoire.
"""
from __future__ import annotations

import json
from typing import Annotated, Literal

import chess
from fastapi import APIRouter, HTTPException, Query

import db
import game_analysis
import pgnlib


router = APIRouter(prefix='/api/game-analysis')
MAX_REPERTOIRE_ENTRIES = 2000
MAX_REPERTOIRE_BYTES = pgnlib.MAX_PGN_BYTES
MAX_GRAPH_NODES = 20000


def _settings(row):
    try:
        settings = json.loads(row['settings'])
    except (ValueError, TypeError):
        return {}
    return settings if isinstance(settings, dict) else {}


def _position(board):
    return ' '.join(board.fen(en_passant='legal').split()[:4])


def _unavailable(result, reason, message):
    return {**result, 'status': 'unavailable', 'reason': reason, 'message': message}


def _read_source(entry_id, color, base_id):
    """Capture a consistent, bounded input; parsing runs after releasing SQLite."""
    with db.read_conn() as conn:
        conn.execute('BEGIN')
        source = conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()
        if source is None:
            raise HTTPException(404, 'Partie introuvable.')
        rows = conn.execute('''SELECT b.id,b.name,b.settings FROM bases b
            WHERE NOT EXISTS(SELECT 1 FROM reference_bases r WHERE r.base_id=b.id)
            ORDER BY b.name COLLATE NOCASE,b.id''').fetchall()
        choices = []
        for row in rows:
            settings = _settings(row)
            if settings.get('is_repertoire') and settings.get('color', 'white') == color:
                choices.append({'id': row['id'], 'name': row['name'],
                                'primary': bool(settings.get('primary'))})
        if base_id is not None:
            selected = next((choice for choice in choices if choice['id'] == base_id), None)
            if selected is None:
                exists = conn.execute('SELECT 1 FROM bases WHERE id=?', (base_id,)).fetchone()
                if exists is None:
                    raise HTTPException(404, 'Répertoire introuvable.')
                raise HTTPException(422, 'Choisis un répertoire personnel du camp sélectionné.')
        else:
            primary = [choice for choice in choices if choice['primary']]
            selected = primary[0] if len(primary) == 1 else None
        entries, limited = [], False
        if selected:
            size = conn.execute('''SELECT COUNT(*) AS count,
                COALESCE(SUM(length(CAST(pgn AS BLOB))),0) AS bytes
                FROM entries WHERE base_id=?''', (selected['id'],)).fetchone()
            limited = size['count'] > MAX_REPERTOIRE_ENTRIES or size['bytes'] > MAX_REPERTOIRE_BYTES
            if not limited:
                entries = [dict(row) for row in conn.execute(
                    'SELECT id,pgn FROM entries WHERE base_id=? ORDER BY id', (selected['id'],))]
        return source['pgn'], choices, selected, entries, limited


def _repertoire_tree(entries):
    """Build an exact-prefix trie plus a position set, including all variations."""
    tree, positions = {}, set()
    visited = playable = partial = 0
    initial = _position(chess.Board())
    for entry in entries:
        try:
            game = pgnlib.load_game(entry['pgn'])
        except (ValueError, RecursionError) as error:
            raise ValueError('invalid_repertoire') from error
        board = game.board()
        if _position(board) != initial:
            partial += 1
            continue
        if not any(child.move for child in game.variations):
            continue
        playable += 1
        stack = [(game, board, tree)]
        while stack:
            node, board, branch = stack.pop()
            visited += 1
            if visited > MAX_GRAPH_NODES:
                raise ValueError('repertoire_limit')
            positions.add(_position(board))
            # Null moves are hypothetical annotations, not playable opening lines.
            for child in node.variations:
                if not child.move:
                    continue
                following = board.copy(stack=False)
                following.push(child.move)
                stack.append((child, following, branch.setdefault(child.move.uci(), {})))
    return tree, positions, playable, partial


@router.get('/{entry_id}/repertoire')
def get_repertoire_comparison(
    entry_id: int,
    color: Literal['white', 'black'],
    base_id: Annotated[int | None, Query(gt=0)] = None,
):
    if type(entry_id) is not int or entry_id <= 0:
        raise HTTPException(422, 'Identifiant de partie invalide.')
    if color not in ('white', 'black'):
        raise HTTPException(422, 'Choisis les blancs ou les noirs.')
    if base_id is not None and (type(base_id) is not int or base_id <= 0):
        raise HTTPException(422, 'Identifiant de répertoire invalide.')
    pgn, choices, selected, entries, limited = _read_source(entry_id, color, base_id)
    result = {'status': 'no_repertoire', 'base_id': selected['id'] if selected else None,
              'name': selected['name'] if selected else None, 'color': color,
              'choices': choices, 'source_fingerprint': None, 'first_exit': None,
              'covered_plies': 0, 'total_plies': 0, 'message': '', 'reason': None}
    try:
        source, moves, fingerprint = game_analysis.game_snapshot(pgn)
    except (HTTPException, ValueError, RecursionError):
        return _unavailable(result, 'invalid_source', 'Le PGN enregistré ne permet pas cette comparaison.')
    result.update(source_fingerprint=fingerprint, total_plies=len(moves))
    if _position(source.board()) != _position(chess.Board()):
        return _unavailable(result, 'partial_source',
            'Cette partie commence par une position FEN. Le parcours depuis la position initiale est nécessaire pour vérifier la sortie du répertoire.')
    if any(not move for move in moves):
        return _unavailable(result, 'null_move',
            'La ligne principale contient un coup nul d’analyse et ne représente pas une partie jouée.')
    if selected is None:
        return {**result, 'reason': 'no_primary' if choices else 'no_repertoire',
                'message': 'Choisis un répertoire pour ce camp.' if choices else 'Aucun répertoire n’est défini pour ce camp.'}
    if limited:
        return _unavailable(result, 'repertoire_limit',
            'Ce répertoire dépasse la limite de comparaison. Choisis un répertoire plus petit.')
    try:
        branch, known_positions, playable, partial = _repertoire_tree(entries)
    except ValueError as error:
        if str(error) == 'repertoire_limit':
            return _unavailable(result, 'repertoire_limit',
                'Ce répertoire dépasse la limite de comparaison. Choisis un répertoire plus petit.')
        return _unavailable(result, 'invalid_repertoire',
            'Une partie du répertoire contient un PGN invalide. Corrige-la avant de comparer cette ligne.')
    result['ignored_partial_entries'] = partial
    if not playable:
        return _unavailable(result, 'partial_repertoire' if partial else 'empty_repertoire',
            'Le répertoire ne contient pas de ligne jouable depuis la position initiale.')
    board, first_exit = source.board(), None
    own_turn = chess.WHITE if color == 'white' else chess.BLACK
    for ply, move in enumerate(moves, 1):
        before_fen, san = board.fen(), board.san(move)
        path = '.'.join(['0'] * ply)
        if first_exit is None:
            uci = move.uci()
            if uci in branch:
                branch = branch[uci]
                result['covered_plies'] += 1
            else:
                kind = 'line_end' if not branch else 'own_deviation' if board.turn == own_turn else 'opponent_gap'
                first_exit = {'kind': kind, 'ply': ply, 'before_path': '.'.join(['0'] * (ply - 1)),
                              'path': path, 'fen': before_fen, 'after_fen': None,
                              'san': san, 'uci': uci,
                              'expected': [{'uci': expected, 'san': board.san(chess.Move.from_uci(expected))}
                                           for expected in branch],
                              'known_until_ply': result['covered_plies'],
                              'transposition': False, 'rejoins_at_ply': None}
        board.push(move)
        if first_exit:
            if first_exit['ply'] == ply:
                first_exit['after_fen'] = board.fen()
            if first_exit['rejoins_at_ply'] is None and _position(board) in known_positions:
                first_exit['transposition'] = True
                first_exit['rejoins_at_ply'] = ply
    if first_exit is None:
        return {**result, 'status': 'inside', 'message': 'Toute la ligne principale jouée appartient au répertoire.'}
    messages = {
        'own_deviation': 'Ton coup sort de la ligne prévue dans le répertoire.',
        'opponent_gap': 'La réponse adverse n’est pas couverte dans cette ligne du répertoire.',
        'line_end': 'La partie prolonge une ligne arrivée à la fin du répertoire.',
    }
    message = messages[first_exit['kind']]
    if first_exit['transposition']:
        message += ' Une position connue est ensuite rejointe par transposition; le parcours conserve cette sortie.'
    return {**result, 'status': 'exit', 'first_exit': first_exit, 'message': message}
