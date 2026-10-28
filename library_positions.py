"""Locate a position in saved games and every PGN variation, without editing them.

The small, bounded in-memory index is derived from PGN content. Metadata is read
fresh on every request so a move/rename/import/delete is immediately reflected.
"""
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import io
import re
import threading

from fastapi import APIRouter, HTTPException, Query, Request

import db
import json
import entry_catalog
import reference_queries
import chess
import pgnlib
from explorer_local import position_key


router = APIRouter(prefix='/api/library')
MAX_CACHE_ENTRIES = 2048
MAX_CACHE_POSITIONS = 250_000
MAX_CACHE_BYTES = 48 * 1024 * 1024
MAX_ENTRY_BYTES = 8 * 1024 * 1024
MAX_ENTRY_POSITIONS = 100_000
MAX_ENTRY_INDEX_BYTES = 48 * 1024 * 1024
MAX_PATH_PLIES = 2048
MAX_QUERY_ENTRIES = 25_000
MAX_QUERY_BYTES = 128 * 1024 * 1024
MAX_OCCURRENCES = 20
_CACHE = OrderedDict()
_CACHE_LOCK = threading.RLock()
_CACHE_SIZE = 0
_CACHE_BYTES = 0


@dataclass(slots=True)
class EntryIndex:
    signature: str
    positions: dict | None
    size: int
    memory: int
    date_key: str = ''


def clear_cache():
    global _CACHE_SIZE, _CACHE_BYTES
    with _CACHE_LOCK:
        _CACHE.clear()
        _CACHE_SIZE = _CACHE_BYTES = 0


def _parse_entry(text):
    """Keep exact editor paths while walking one board incrementally."""
    game = pgnlib.load_game(text)
    board = game.board()
    fen = board.fen(en_passant='legal')
    positions = {position_key(board): [('', fen, 'Position initiale', False)]}
    size, memory = 1, len(fen) * 2 + 256
    stack = [(iter(enumerate(game.variations)), '', False)]
    while stack:
        children, parent_path, parent_variation = stack[-1]
        try:
            index, node = next(children)
        except StopIteration:
            stack.pop()
            if stack:
                board.pop()
            continue
        if size >= MAX_ENTRY_POSITIONS or len(stack) > MAX_PATH_PLIES:
            raise ValueError('Cette partie dépasse la limite de positions indexables.')
        path = f'{parent_path}.{index}' if parent_path else str(index)
        variation = parent_variation or index != 0
        label = f'{board.fullmove_number}{"." if board.turn else "…"} {board.san(node.move)}'
        board.push(node.move)
        fen = board.fen(en_passant='legal')
        key = position_key(board)
        positions.setdefault(key, []).append((path, fen, label, variation))
        size += 1
        # Include rough object overhead, not only the serialized strings.
        memory += len(key) + len(path) + len(fen) + len(label) * 4 + 320
        if memory > MAX_ENTRY_INDEX_BYTES:
            raise ValueError('Cette partie dépasse la taille de l’index de positions.')
        stack.append((iter(enumerate(node.variations)), path, variation))
    return positions, size, memory, _date_key(game.headers)


def _date_key(headers):
    # PGN dates sort chronologically as strings. Unknown month/day stays in its
    # known year/month, ahead of precise dates in that group when descending.
    for name in ('Date', 'UTCDate'):
        value = headers.get(name, '')
        if re.match(r'^[0-9]{4}', value) and value[:4] != '0000':
            return value[:10]
    return ''


def _entry_index(database, entry_id, text):
    global _CACHE_SIZE, _CACHE_BYTES
    key = (database, entry_id)
    if not isinstance(text, str):
        return EntryIndex('', None, 0, 0)
    signature = hashlib.sha256(text.encode('utf-8')).hexdigest()
    previous = _CACHE.get(key)
    if previous is not None and previous.signature == signature:
        _CACHE.move_to_end(key)
        return previous
    if previous is not None:
        _CACHE.pop(key)
        _CACHE_SIZE -= previous.size
        _CACHE_BYTES -= previous.memory
    try:
        positions, size, memory, date_key = _parse_entry(text)
    except (ValueError, TypeError, IndexError, KeyError, RecursionError):
        positions, size, memory, date_key = None, 0, 128, ''
    result = EntryIndex(signature, positions, size, memory, date_key)
    if size <= MAX_CACHE_POSITIONS and memory <= MAX_CACHE_BYTES:
        _CACHE[key] = result
        _CACHE_SIZE += size
        _CACHE_BYTES += memory
        while (len(_CACHE) > MAX_CACHE_ENTRIES or _CACHE_SIZE > MAX_CACHE_POSITIONS
               or _CACHE_BYTES > MAX_CACHE_BYTES):
            _, removed = _CACHE.popitem(last=False)
            _CACHE_SIZE -= removed.size
            _CACHE_BYTES -= removed.memory
    return result


def _folder_path(folders, folder_id):
    names, seen = [], set()
    while folder_id is not None and folder_id not in seen:
        seen.add(folder_id)
        folder = folders.get(folder_id)
        if folder is None:
            break
        names.append(folder['name'])
        folder_id = folder['parent_id']
    return ' / '.join(reversed(names))


def search_position(fen, offset=0, limit=50, *, base_id=None, summary=False):
    """Return entry groups and paths; repetition clocks are not position identity.

    Limits produce an explicit incomplete result, never a claim that an
    unexamined game contains no match. Pagination does not affect exact totals
    over examined entries. Scanning does not mark entries seen or alter reviews.
    """
    if not isinstance(fen, str) or len(fen) > 256:
        raise ValueError('Position FEN invalide.')
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError('Pagination de la recherche invalide.')
    if base_id is not None and (type(base_id) is not int or base_id < 1):
        raise ValueError('Base de recherche invalide.')
    if type(summary) is not bool:
        raise ValueError('Mode de recherche invalide.')
    board = pgnlib.validate_board(fen)
    key = position_key(board)
    result = dict(fen=board.fen(en_passant='legal'), position_key=key,
                  total_entries=0, total_occurrences=0, offset=offset, limit=limit,
                  has_more=False, matches=[], bases=[], skipped_entries=0, complete=True,
                  base_id=base_id, summary=summary)
    entry_catalog.prepare(base_ids=[base_id] if base_id is not None else None)
    with _CACHE_LOCK, db.read_conn() as conn:
        conn.execute('BEGIN')
        database = str(db.DB_PATH.resolve())
        folders = {row['id']: dict(row) for row in conn.execute('SELECT id,name,parent_id FROM folders')}
        bases = [dict(row) for row in conn.execute('''SELECT b.id,b.name,b.folder_id,
            r.base_id IS NOT NULL AS reference FROM bases b
            LEFT JOIN reference_bases r ON r.base_id=b.id ORDER BY b.sort_order,b.id''')]
        if base_id is not None and not any(row['id'] == base_id for row in bases):
            raise HTTPException(404, 'Cette base n’existe plus.')
        groups = {row['id']: dict(base_id=row['id'], base_name=row['name'],
            folder_path=_folder_path(folders, row['folder_id']), total_entries=0,
            total_occurrences=0, complete=True, reference=bool(row['reference']))
            for row in bases if base_id is None or row['id'] == base_id}
        # Keep study/reference metadata in the same library snapshot. A base
        # created or removed during a lookup must not appear halfway through it.
        references = [dict(row) for row in conn.execute('''SELECT r.*,b.name,b.folder_id
            FROM reference_bases r JOIN bases b ON b.id=r.base_id'''
            + (' WHERE r.base_id=?' if base_id is not None else '')
            + ' ORDER BY b.sort_order,b.id', (base_id,) if base_id is not None else ())]
        # Read metadata and sizes first: oversized PGNs do not enter Python memory.
        rows = conn.execute('''SELECT e.id,e.title,e.base_id,b.name AS base_name,b.folder_id,
            coalesce(c.pgn_bytes,length(CAST(e.pgn AS BLOB))) AS pgn_bytes,c.pgn_digest,c.headers FROM entries e
            JOIN bases b ON b.id=e.base_id LEFT JOIN entry_catalog c ON c.entry_id=e.id'''
            + (' WHERE e.base_id=?' if base_id is not None else '')
            + ' ORDER BY b.sort_order,b.id,e.id', (base_id,) if base_id is not None else ()).fetchall()
        live_ids = {row['id'] for row in rows}
        if base_id is None:
            _discard_deleted(database, live_ids)
        query_bytes = 0
        matches_by_base = {row['id']: [] for row in bases}
        for index, row in enumerate(rows):
            reference_queries.check()
            size = row['pgn_bytes'] or 0
            if index >= MAX_QUERY_ENTRIES or size > MAX_ENTRY_BYTES or query_bytes + size > MAX_QUERY_BYTES:
                result['skipped_entries'] += 1
                groups[row['base_id']]['complete'] = False
                continue
            query_bytes += size
            entry = _CACHE.get((database,row['id']))
            if entry is None or entry.signature != row['pgn_digest']:
                text = conn.execute('SELECT pgn FROM entries WHERE id=?', (row['id'],)).fetchone()['pgn']
                entry = _entry_index(database, row['id'], text)
            else:
                _CACHE.move_to_end((database,row['id']))
            if entry.positions is None:
                result['skipped_entries'] += 1
                groups[row['base_id']]['complete'] = False
                continue
            occurrences = entry.positions.get(key)
            if not occurrences:
                continue
            result['total_entries'] += 1
            result['total_occurrences'] += len(occurrences)
            groups[row['base_id']]['total_entries'] += 1
            groups[row['base_id']]['total_occurrences'] += len(occurrences)
            if not summary:
                matches_by_base[row['base_id']].append((entry.date_key, row, occurrences))
        # Sort the bounded study matches before taking a page, while preserving
        # library base order. Only this page's full headers are read again.
        ordered = []
        for matches in matches_by_base.values():
            ordered.extend(sorted(matches, key=lambda item: (item[0], item[1]['id']), reverse=True))
        for _, row, occurrences in ordered[offset:offset + limit]:
            headers = json.loads(row['headers']) if row['headers'] is not None else dict(chess.pgn.read_headers(io.StringIO(conn.execute('SELECT pgn FROM entries WHERE id=?',(row['id'],)).fetchone()['pgn'])) or {})
            result['matches'].append(dict(
                entry_id=row['id'], entry_title=row['title'], base_id=row['base_id'],
                base_name=row['base_name'], folder_path=_folder_path(folders, row['folder_id']),
                headers=headers,
                occurrence_count=len(occurrences), occurrences=[
                    dict(path=path, fen=node_fen, label=label, variation=variation)
                    for path, node_fen, label, variation in occurrences[:MAX_OCCURRENCES]]))
    result['complete'] = result['skipped_entries'] == 0
    # Reference stores keep their own on-disk indexes. Only one page of matching
    # games is loaded; no corpus PGNs enter the ordinary study cache.
    import reference_library
    import reference_store
    for reference in references:
        details = reference_library.status_for(reference)
        if details['status'] == 'error' and not reference_library.store_path(reference['storage_key']).is_file():
            result['complete'] = False
            groups[reference['base_id']]['complete'] = False
            continue
        remaining = limit - len(result['matches'])
        page = reference_store.search_position(reference_library.store_path(reference['storage_key']), fen,
            offset=max(0, offset - result['total_entries']), limit=max(1, remaining), summary=summary or not remaining)
        if remaining and not summary:
            for item in page['matches'][:remaining]:
                ply = item['ply']
                initial = chess.Board(item['headers'].get('FEN', chess.STARTING_FEN))
                white = initial.turn if ply % 2 else not initial.turn
                move_number = initial.fullmove_number + (ply - 1 + int(not initial.turn)) // 2
                label = 'Position initiale' if not ply else str(move_number) + ('. ' if white else '… ') + item['san']
                result['matches'].append(dict(
                    entry_id=f"reference:{reference['base_id']}:{item['game_id']}",
                    reference_source={'base_id': reference['base_id'], 'game_id': item['game_id']},
                    entry_title=item['title'], base_id=reference['base_id'], base_name=reference['name'],
                    headers=item['headers'],
                    folder_path=_folder_path(folders, reference['folder_id']), occurrence_count=1,
                    occurrences=[dict(path='.'.join(['0'] * ply), fen=fen, label=label, variation=False)]))
        result['total_entries'] += page['total']
        result['total_occurrences'] += page['total']
        groups[reference['base_id']]['total_entries'] = page['total']
        groups[reference['base_id']]['total_occurrences'] = page['total']
        if details['status'] != 'completed' or details.get('rejected', 0):
            result['complete'] = False
            groups[reference['base_id']]['complete'] = False
    if references:
        result['reference_scope'] = 'mainline_first_occurrence'
    result['bases'] = [group for group in groups.values() if group['total_entries']]
    result['has_more'] = not summary and result['total_entries'] > offset + limit
    return result


def _discard_deleted(database, live_ids):
    global _CACHE_SIZE, _CACHE_BYTES
    for key in list(_CACHE):
        if key[0] == database and key[1] not in live_ids:
            removed = _CACHE.pop(key)
            _CACHE_SIZE -= removed.size
            _CACHE_BYTES -= removed.memory


@router.get('/position')
async def position(request: Request, fen: str = Query(..., max_length=256), offset: int = Query(0, ge=0),
             limit: int = Query(50, ge=1, le=100), base_id: int | None = Query(None, ge=1),
             summary: bool = False):
    try:
        return await reference_queries.run(request, lambda: reference_queries.exclusive(lambda: search_position(fen, offset, limit, base_id=base_id, summary=summary)))
    except reference_queries.QueryStopped as exc:
        raise HTTPException(503, reference_queries.unavailable(exc.reason)['message'],headers={'Retry-After':'2'}) from exc
