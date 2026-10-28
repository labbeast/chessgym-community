"""Read-only opening statistics from saved PGN mainlines.

The retained index is bounded and never writes user data. Each query fingerprints
selected bases to notice imports, deletions and even edits with unchanged clocks;
unchanged PGNs are not parsed again. An entry is a game, never a set of training
variations. Counts at a position describe its first occurrence with a next move.
"""
from collections import OrderedDict
from dataclasses import dataclass
import hashlib
import io
import re
import threading

import chess
import chess.pgn

import db
import entry_catalog
import pgnlib
import reference_store
import reference_queries
from game_metadata import RESULTS, identity_payload, rating as pgn_rating, speed as pgn_speed
from game_filters import GameFilter

# Bound retained memory by both index size and base count. Oversized bases remain
# queryable, but are not kept between requests. Mega-database indexing is separate.
MAX_CACHE_BASES = 16
MAX_CACHE_POSITIONS = 250_000
MAX_CACHE_ENTRIES = 25_000
_CACHE = OrderedDict()
_CACHE_LOCK = threading.RLock()


def position_key(board):
    """FIDE position identity: legal EP matters, move counters do not."""
    return ' '.join(board.fen(en_passant='legal').split()[:4])


@dataclass(slots=True)
class ParsedGame:
    identity: str
    outcome: str
    samples: dict
    terminal: str | None
    white_elo: int | None = None
    black_elo: int | None = None
    speed: str | None = None


@dataclass(slots=True)
class CachedEntry:
    updated_at: str
    signature: str
    game: ParsedGame | None


@dataclass(slots=True)
class BaseIndex:
    entries: dict
    positions: dict
    terminals: dict
    size: int


class MainlineVisitor(chess.pgn.BaseVisitor):
    """Use the parser's incremental board without materializing a PGN tree."""
    def begin_game(self):
        self.headers = chess.pgn.Headers()
        self.root = None
        self.terminal = None
        self.moves = []
        self.samples = {}
        self.errors = []

    def begin_headers(self):
        return self.headers

    def visit_header(self, tagname, tagvalue):
        self.headers[tagname] = re.sub(r'\\(["\\])', lambda match: match[1], tagvalue)

    def begin_variation(self):
        return chess.pgn.SKIP

    def visit_board(self, board):
        if self.root is None:
            if not board.is_valid() or board.chess960 or self.headers.get('Variant', 'Standard').lower() not in ('standard', 'chess', 'normal'):
                self.errors.append(ValueError('Position initiale ou variante non prise en charge.'))
            self.root = position_key(board)
        self.terminal = position_key(board)

    def visit_move(self, board, move):
        key = position_key(board)
        self.moves.append(move.uci())
        if key not in self.samples:
            rating = pgn_rating(self.headers.get('WhiteElo' if board.turn else 'BlackElo', ''))
            self.samples[key] = (move.uci(), board.san(move), rating)

    def visit_result(self, result):
        if self.headers.get('Result', '*') == '*':
            self.headers['Result'] = result

    def handle_error(self, error):
        # Do not log the user's full PGN for a corrupt record.
        self.errors.append(error)

    def result(self):
        if self.errors or self.root is None:
            raise ValueError('Partie invalide pour l’explorateur.')
        # Metadata distinguishes separate games with identical moves. Comments,
        # NAGs, clocks, alternate lines and result corrections do not create games.
        identity = hashlib.sha256(identity_payload(self.root, self.moves, self.headers)).hexdigest()
        outcome = RESULTS.get(self.headers.get('Result'), 'unknown')
        terminal = self.terminal if self.terminal not in self.samples else None
        return ParsedGame(identity, outcome, self.samples, terminal,
                          pgn_rating(self.headers.get('WhiteElo')),
                          pgn_rating(self.headers.get('BlackElo')),
                          pgn_speed(self.headers))


def _parse_entry(pgn):
    if not isinstance(pgn, str) or not pgn.strip() or len(pgn.encode('utf-8')) > pgnlib.MAX_PGN_BYTES:
        raise ValueError('PGN vide ou trop volumineux.')
    pgnlib._validate_lexical(pgn)
    stream = io.StringIO(pgn.lstrip('\ufeff'))
    game = chess.pgn.read_game(stream, Visitor=MainlineVisitor)
    if game is None or chess.pgn.read_game(stream, Visitor=chess.pgn.SkipVisitor) is not None:
        raise ValueError('Une entrée doit contenir exactement une partie.')
    return game


def _load_base(conn, base_id, database):
    cache_key = (database, base_id)
    previous = _CACHE.get(cache_key)
    entries = {}
    changed = previous is None
    for row in conn.execute('SELECT e.id,e.updated_at,c.pgn_digest FROM entries e LEFT JOIN entry_catalog c ON c.entry_id=e.id WHERE base_id=? ORDER BY e.id', (base_id,)):
        reference_queries.check()
        text = None
        signature = row['pgn_digest']
        if signature is None:
            text = conn.execute('SELECT pgn FROM entries WHERE id=?',(row['id'],)).fetchone()['pgn']
            signature = hashlib.sha256(text.encode('utf-8')).hexdigest()
        cached = previous.entries.get(row['id']) if previous else None
        if cached is not None and cached.signature == signature:
            # An unrelated flag/title change should not force PGN parsing.
            entry = cached if cached.updated_at == row['updated_at'] else CachedEntry(row['updated_at'], signature, cached.game)
        else:
            try:
                if text is None:
                    text = conn.execute('SELECT pgn FROM entries WHERE id=?',(row['id'],)).fetchone()['pgn']
                parsed = _parse_entry(text)
            except (ValueError, TypeError, IndexError, KeyError):
                parsed = None
            entry = CachedEntry(row['updated_at'], signature, parsed)
            changed = True
        entries[row['id']] = entry
    if previous is not None and entries.keys() != previous.entries.keys():
        changed = True
    if not changed:
        previous.entries = entries
        _CACHE.move_to_end(cache_key)
        return previous
    positions, terminals = {}, {}
    size = 0
    for entry in entries.values():
        game = entry.game
        if game is None:
            continue
        for key, sample in game.samples.items():
            positions.setdefault(key, []).append((game, sample))
        if game.terminal:
            terminals.setdefault(game.terminal, []).append(game)
        size += len(game.samples) + bool(game.terminal)
    index = BaseIndex(entries, positions, terminals, size)
    _CACHE.pop(cache_key, None)
    if size <= MAX_CACHE_POSITIONS and len(entries) <= MAX_CACHE_ENTRIES:
        _CACHE[cache_key] = index
        while (len(_CACHE) > MAX_CACHE_BASES
               or sum(item.size for item in _CACHE.values()) > MAX_CACHE_POSITIONS
               or sum(len(item.entries) for item in _CACHE.values()) > MAX_CACHE_ENTRIES):
            _CACHE.popitem(last=False)
    return index


def clear_cache():
    """Release the derived index, e.g. during isolated tests or shutdown."""
    with _CACHE_LOCK:
        _CACHE.clear()


def local_data(fen, base_ids, *, rating_min=None, rating_max=None, speeds=None):
    """Aggregate selected saved bases after inclusive two-player Elo filters.

    Caller validates access to base IDs. A game is counted once across all
    selected bases. Results '*' remain unknown. terminal_count lists games that
    stop at this position with no earlier outgoing sample and is excluded from
    total. Duplicate copies with conflicting metadata/results use the first
    selected base ID, then the lowest entry ID, deterministically. A duplicate
    excluded by the filters does not suppress an eligible copy in another base.
    Empty speeds includes unknown cadences; absent PGN TimeControl stays unknown.
    """
    board = pgnlib.validate_board(fen)
    key = position_key(board)
    population = GameFilter(rating_min, rating_max, speeds)
    speeds = population.speeds
    base_ids = sorted(set(base_ids))
    result = dict(status='ok', white=0, draws=0, black=0, unknown=0, total=0,
                  moves=[], game_count=0, terminal_count=0, duplicates=0, invalid_entries=0)
    if not base_ids:
        return result
    import reference_library
    entry_catalog.prepare(base_ids=base_ids)
    with _CACHE_LOCK, db.read_conn() as conn:
        # A snapshot prevents mixing statistics from before/after an import.
        conn.execute('BEGIN')
        database = str(db.DB_PATH.resolve())
        references = [reference_library.reference_row(conn, base_id) for base_id in base_ids]
        references = [row for row in references if row]
        reference_ids = {row['base_id'] for row in references}
        indexes = [_load_base(conn, base_id, database) for base_id in base_ids if base_id not in reference_ids]
        seen_games, matched, terminal_games = set(), set(), set()
        rows = {}
        for index in indexes:
            for entry in index.entries.values():
                if entry.game is None:
                    result['invalid_entries'] += 1
                elif not population.matches(entry.game):
                    continue
                elif entry.game.identity in seen_games:
                    result['duplicates'] += 1
                else:
                    seen_games.add(entry.game.identity)
            for game, (uci, san, rating) in index.positions.get(key, ()):
                if not population.matches(game):
                    continue
                if game.identity in matched:
                    continue
                matched.add(game.identity)
                row = rows.setdefault(uci, dict(uci=uci, san=san, white=0, draws=0, black=0, unknown=0, total=0, _rating_sum=0, _rating_count=0))
                row[game.outcome] += 1
                row['total'] += 1
                result[game.outcome] += 1
                if rating is not None:
                    row['_rating_sum'] += rating
                    row['_rating_count'] += 1
            terminal_games.update(game.identity for game in index.terminals.get(key, ())
                                  if population.matches(game))
        for row in rows.values():
            rating_count = row.pop('_rating_count')
            rating_sum = row.pop('_rating_sum')
            if references:
                row.update(rating_count=rating_count, rating_sum=rating_sum)
            if rating_count:
                row['average_rating'] = round(rating_sum / rating_count)
        result['moves'] = sorted(rows.values(), key=lambda item: (-item['total'], item['san']))
        result['total'] = len(matched)
        result['game_count'] = len(seen_games)
        result['terminal_count'] = len(terminal_games - matched)
    if references:
        paths = []
        result['complete'] = True
        all_completed = True
        for reference in references:
            path = reference_library.store_path(reference['storage_key'])
            details = reference_library.status_for(reference)
            if path.is_file():
                paths.append(path)
            if details['status'] != 'completed' or details.get('rejected', 0):
                result['complete'] = False
            if details['status'] != 'completed':
                all_completed = False
        if paths:
            # Study copies have priority when the same played game also lives
            # in a reference. Reference-to-reference duplicates are handled on
            # disk, without retaining millions of identities in Python.
            profile = (key, rating_min, rating_max, tuple(speeds or []),
                       hashlib.sha256('\n'.join(sorted(seen_games)).encode()).hexdigest())
            corpus_complete = result['complete']
            def read_reference():
                large = reference_store.explorer_data_many(
                    paths, fen, exclude_identities=seen_games, rating_min=rating_min, rating_max=rating_max, speeds=speeds,
                    allow_import_frequencies=not all_completed)
                return {**large, 'complete': corpus_complete and large.get('complete', True)}
            try:
                large = reference_queries.bounded(paths, profile, read_reference, persistent=True,
                    prepare=True, allow_incomplete=all_completed)
            except reference_queries.QueryStopped as stopped:
                return reference_queries.unavailable(stopped.reason)
            result['complete'] = result['complete'] and large.get('complete', True)
            result.update({field: large[field] for field in ('cached', 'snapshot', 'fetched_at', 'message', 'results_available') if field in large})
            for field in ('white', 'draws', 'black', 'unknown', 'total', 'terminal_count', 'game_count', 'duplicates', 'invalid_entries'):
                result[field] += large.get(field, 0)
            result['game_count_includes_duplicates'] = large.get('game_count_includes_duplicates', False)
            result['game_count_is_sum'] = large.get('game_count_is_sum', False)
            for move in large['moves']:
                if move['uci'] not in rows:
                    rows[move['uci']] = dict(move)
                else:
                    row = rows[move['uci']]
                    for field in ('white', 'draws', 'black', 'unknown', 'total', 'rating_sum', 'rating_count'):
                        row[field] = row.get(field, 0) + move.get(field, 0)
                    if row.get('rating_count'):
                        row['average_rating'] = round(row['rating_sum'] / row['rating_count'])
            result['moves'] = sorted(rows.values(), key=lambda item: (-item['total'], item['san']))
        if not result['complete']:
            if result.get('results_available') is False:
                result['message'] = 'Fréquences exactes des parties déjà importées. Les résultats de cette position très fréquente seront disponibles après la fin de l’importation.'
                return result
            elif all_completed:
                partial = 'Statistiques exactes des parties importées. Les parties rejetées pendant l’importation sont exclues.'
            else:
                partial = 'Statistiques des parties déjà importées. Une grande base est encore partielle ou contient des parties rejetées.'
            result['message'] = (result.get('message', '') + ' ' + partial).strip()
    return result
