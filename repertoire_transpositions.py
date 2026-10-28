"""Read-only, bounded navigation between repertoire move orders.

Position identity includes side to move, castling and legal en-passant rights.
Matches are exact saved tree paths, never permission to merge or extend a PGN.
"""
from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

import db
from entry_content import entry_revision
import pgnlib

router = APIRouter(prefix='/api/repertoires')
MAX_ENTRIES = 2000
MAX_NODES = 20000
MAX_TOTAL_BYTES = 16 * 1024 * 1024
MAX_ENTRY_BYTES = 2 * 1024 * 1024
MAX_MATCHES = 500


class TranspositionRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    pgn: StrictStr = Field(max_length=pgnlib.MAX_PGN_BYTES)
    path: StrictStr = Field(default='', max_length=2000)
    entry_id: StrictInt | None = Field(default=None, gt=0)
    base_id: StrictInt | None = Field(default=None, gt=0)
    different_only: StrictBool = True
    offset: StrictInt = Field(default=0, ge=0, le=MAX_MATCHES)
    limit: StrictInt = Field(default=20, ge=1, le=50)


def position_key(board):
    return ' '.join(board.fen(en_passant='legal').split()[:4])


def _game(text):
    try:
        return pgnlib.load_game(text)
    except (ValueError, RecursionError) as exc:
        raise HTTPException(422, 'Le PGN de la position est invalide.') from exc


def _source(request):
    game = _game(request.pgn)
    try:
        node = pgnlib.node_at(game, request.path)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    moves = []
    current = node
    while current.parent is not None:
        if not current.move:
            raise HTTPException(422, 'Les transpositions ne sont pas disponibles après un coup nul pédagogique.')
        moves.append(current.move.uci())
        current = current.parent
    return game, node, tuple(reversed(moves))


def _settings(row):
    try:
        value = json.loads(row['settings'])
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _walk(game):
    """Depth-first legal paths with one board, excluding null-move subtrees."""
    board = game.board()
    indices, moves, tokens = [], [], []
    yield game, board, '', moves, tokens
    stack = [iter(enumerate(game.variations))]
    while stack:
        try:
            index, child = next(stack[-1])
        except StopIteration:
            stack.pop()
            if stack:
                board.pop()
                indices.pop()
                moves.pop()
                tokens.pop()
            continue
        if not child.move:
            continue
        san = board.san(child.move)
        token = (str(board.fullmove_number) + ('. ' if board.turn else '… ') + san)
        indices.append(str(index))
        moves.append(child.move.uci())
        tokens.append(token)
        board.push(child.move)
        yield child, board, '.'.join(indices), moves, tokens
        stack.append(iter(enumerate(child.variations)))


def _match(entry, base, node, board, path, tokens, same_order):
    continuations = []
    for index, child in enumerate(node.variations):
        if child.move and len(continuations) < 12:
            continuations.append({'uci': child.move.uci(), 'san': board.san(child.move),
                'path': path + '.' + str(index) if path else str(index)})
    return {'entry_id': entry['id'], 'base_id': base['id'], 'base_name': base['name'],
        'title': entry['title'], 'color': _settings(base).get('color', 'white'),
        'path': path, 'fen': board.fen(), 'position_key': position_key(board),
        'revision': entry_revision(entry), 'ply': len(tokens),
        'move_order': ' '.join(tokens), 'same_move_order': same_order,
        'comment': node.comment[:1000], 'continuations': continuations,
        'continuation_count': sum(bool(child.move) for child in node.variations)}


@router.post('/transpositions')
def transpositions(request: TranspositionRequest):
    source, selected, source_moves = _source(request)
    source_board = selected.board()
    target_key, source_root = position_key(source_board), position_key(source.board())
    matches, limits = [], set()
    entries_scanned = nodes_scanned = invalid_entries = total_bytes = 0
    with db.get_conn() as conn:
        conn.execute('PRAGMA query_only=ON')
        conn.execute('BEGIN')
        bases = {row['id']: dict(row) for row in conn.execute('SELECT id,name,settings FROM bases ORDER BY id')
                 if _settings(row).get('is_repertoire') and not _settings(row).get('reference')}
        if request.base_id is not None:
            if request.base_id not in bases:
                raise HTTPException(404, 'Répertoire introuvable.')
            bases = {request.base_id: bases[request.base_id]}
        # The iterator keeps PGNs out of memory until needed. Stable ID/path order
        # makes pagination independent of names, timestamps or navigation state.
        if bases:
            ids = tuple(bases)
            rows = conn.execute('SELECT id,base_id,title,pgn,start_path FROM entries WHERE base_id IN ('
                + ','.join('?' for _ in ids) + ') ORDER BY base_id,id', ids)
            for entry in rows:
                if entries_scanned >= MAX_ENTRIES:
                    limits.add('entries')
                    break
                size = len(entry['pgn'].encode('utf-8'))
                if total_bytes + size > MAX_TOTAL_BYTES:
                    limits.add('bytes')
                    break
                entries_scanned += 1
                total_bytes += size
                if size > MAX_ENTRY_BYTES:
                    limits.add('large_entry')
                    continue
                try:
                    game = pgnlib.load_game(entry['pgn'])
                except (ValueError, RecursionError):
                    invalid_entries += 1
                    continue
                root_key = position_key(game.board())
                for node, board, path, moves, tokens in _walk(game):
                    if nodes_scanned >= MAX_NODES:
                        limits.add('nodes')
                        break
                    nodes_scanned += 1
                    if position_key(board) != target_key:
                        continue
                    if entry['id'] == request.entry_id and path == request.path:
                        continue
                    same_order = root_key == source_root and tuple(moves) == source_moves
                    if same_order and request.different_only:
                        continue
                    if len(matches) >= MAX_MATCHES:
                        limits.add('matches')
                        break
                    matches.append(_match(entry, bases[entry['base_id']], node, board, path, tokens, same_order))
                if limits & {'nodes', 'matches'}:
                    break
    end = request.offset + request.limit
    partial = bool(limits or invalid_entries)
    return {'position_key': target_key, 'fen': source_board.fen(),
        'source_fingerprint': hashlib.sha256((request.pgn + '\0' + request.path).encode()).hexdigest(),
        'matches': matches[request.offset:end], 'total': len(matches),
        'offset': request.offset, 'limit': request.limit,
        'next_offset': end if end < len(matches) else None,
        'partial': partial, 'limit_reasons': sorted(limits), 'invalid_entries': invalid_entries,
        'entries_scanned': entries_scanned, 'positions_scanned': nodes_scanned,
        'message': ('Recherche partielle : choisis un répertoire plus précis ou répartis les grandes lignes pour examiner la suite.'
                    if partial else 'Toutes les lignes des répertoires sélectionnés ont été examinées.')}
