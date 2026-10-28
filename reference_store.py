"""Disk-backed reference games, separate from editable study/progress data.

Imports retain each original UTF-8 PGN (compressed), validate all branches, and
index only played mainline positions. A position is stored once per game: the
first outgoing occurrence, or its terminal occurrence when it was not seen
earlier. Queries use persistent indexes and never reparse the corpus.
"""
from contextlib import contextmanager, closing
from collections import OrderedDict
from array import array
from datetime import datetime, timezone
from dataclasses import dataclass
import hashlib
import io
import json
import os
import pickle
from pathlib import Path
import re
import sqlite3
import struct
import sys
import threading
import zlib

import chess
import chess.pgn

import pgnlib
import reference_queries
from game_metadata import IDENTITY_HEADERS, RESULTS, SPEEDS, identity_payload
from game_metadata import rating as _rating, speed as _speed
from game_filters import normalize_speeds, sql_filters as _filters

SCHEMA_VERSION = 1
ENCODINGS = ('utf-8-sig', 'utf-8', 'cp1252', 'latin-1')
MAX_FILTER_COUNTS = 128
_FILTER_COUNTS = OrderedDict()
_FILTER_COUNTS_LOCK = threading.RLock()
MAX_SEARCH_MATCH_IDS = 50_000
MAX_SEARCH_MATCH_CACHE_IDS = 200_000
MAX_SEARCH_MATCH_PROFILES = 8
_SEARCH_MATCHES = OrderedDict()
_SEARCH_MATCHES_LOCK = threading.RLock()
MAX_GAME_BYTES = 20 * 1024 * 1024
MAX_PLIES = 100_000
MAX_REJECTIONS = 20
MAX_IMPORT_WORKERS = 16
IMPORT_CACHE_KIB = 128 * 1024
MAX_SORTED_POSITION_ROWS = 50_000
MAX_SORTED_POSITION_BYTES = 16 * 1024 * 1024
POSITION_INSERT_SQL = 'INSERT INTO positions(position_key,game_id,ply,next_move,san) VALUES(?,?,?,?,?)'
SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS games (
 id INTEGER PRIMARY KEY,
 identity BLOB NOT NULL, identity_payload BLOB NOT NULL,
 title TEXT NOT NULL, headers TEXT NOT NULL, pgn BLOB NOT NULL,
 white TEXT NOT NULL, black TEXT NOT NULL, event TEXT NOT NULL,
 date TEXT NOT NULL, year INTEGER, white_elo INTEGER, black_elo INTEGER,
 speed TEXT, outcome TEXT NOT NULL, plies INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_identity ON games(identity);
CREATE INDEX IF NOT EXISTS games_page_id ON games(id);
CREATE INDEX IF NOT EXISTS games_date ON games(date, id);
CREATE INDEX IF NOT EXISTS games_white ON games(white COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS games_black ON games(black COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS games_event ON games(event COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS games_speed_rating ON games(speed, white_elo, black_elo);
CREATE INDEX IF NOT EXISTS games_white_elo ON games(white_elo, id);
CREATE INDEX IF NOT EXISTS games_black_elo ON games(black_elo, id);
CREATE TABLE IF NOT EXISTS positions (
 position_key BLOB NOT NULL, game_id INTEGER NOT NULL,
 ply INTEGER NOT NULL, next_move INTEGER, san TEXT NOT NULL,
 PRIMARY KEY(position_key, game_id)
) WITHOUT ROWID;
"""


def _now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def _connect(path, *, readonly=False):
    path = Path(path).resolve()
    conn = sqlite3.connect(path.as_uri() + '?mode=ro' if readonly else str(path),
                           uri=readonly, timeout=30)
    conn.row_factory = sqlite3.Row
    guard = None
    try:
        if readonly:
            guard = reference_queries.attach(conn)
        if not guard:
            conn.execute('PRAGMA busy_timeout=30000')
        conn.execute('PRAGMA cache_size=-16384')
        if not readonly:
            conn.execute('PRAGMA synchronous=NORMAL')
        with conn:
            yield conn
    finally:
        if guard:
            guard.detach(conn)
        conn.close()


def _get_meta(conn, key, default=None):
    row = conn.execute('SELECT value FROM meta WHERE key=?', (key,)).fetchone()
    return json.loads(row[0]) if row else default


def _set_meta(conn, key, value):
    conn.execute('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                 (key, json.dumps(value, ensure_ascii=False, separators=(',', ':'))))


def init_store(path):
    """Create an empty store. Never opens or changes the study database."""
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with _connect(path) as conn:
        if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").fetchone():
            version = _get_meta(conn, 'schema_version')
            if version is not None and version != SCHEMA_VERSION:
                raise ValueError('Version de base de référence non prise en charge.')
        conn.execute('PRAGMA journal_mode=WAL')
        conn.executescript(SCHEMA)
        _set_meta(conn, 'schema_version', SCHEMA_VERSION)
        if _get_meta(conn, 'totals') is None:
            _set_meta(conn, 'totals', {'game_count': 0, 'indexed_positions': 0})
        if _get_meta(conn, 'utc_date_fallback') != 1:
            # Early Lichess archives omit Date but provide UTCDate. Repair only
            # derived search metadata; original headers/PGNs stay untouched.
            conn.execute('''UPDATE games SET date=json_extract(headers,'$.UTCDate'),
                year=CAST(substr(json_extract(headers,'$.UTCDate'),1,4) AS INTEGER)
                WHERE year IS NULL
                AND json_extract(headers,'$.UTCDate') GLOB '[0-9][0-9][0-9][0-9].*'
                AND CAST(substr(json_extract(headers,'$.UTCDate'),1,4) AS INTEGER)>0''')
            _set_meta(conn, 'utc_date_fallback', 1)
    return status(path)


def status(path):
    with _connect(path, readonly=True) as conn:
        result = dict(status='idle', imported=0, processed=0, duplicates=0,
                      rejected=0, source=None, bytes_read=0, total_bytes=0,
                      error=None, limit_reached=False, rejections=[])
        result.update(_get_meta(conn, 'import', {}))
        result.update(_get_meta(conn, 'totals', {'game_count': 0, 'indexed_positions': 0}))
        # Internal fingerprints and decompressed offsets are not part of the UI.
        result.pop('fingerprint', None)
        result.pop('offset', None)
        return result


@contextmanager
def _import_lock(path):
    """OS lock releases automatically if the importing process exits/crashes."""
    lock_path = str(path) + '.import.lock'
    with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600), 'r+b') as lock:
        if os.fstat(lock.fileno()).st_size == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError) as exc:
            raise ValueError('Un import est déjà en cours dans cette base.') from exc
        try:
            yield
        finally:
            lock.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def position_key(board):
    """Exact binary encoding of canonical FEN's first four fields, not a hash.

    Six piece-type bitboards plus white occupancy fully describe all pieces.
    The last two bytes encode side, orthodox castling rights and *legal* EP.
    Move counters deliberately do not affect identity. There are no collisions.
    """
    rights = board.clean_castling_rights()
    flags = int(board.turn) | (bool(rights & chess.BB_H1) << 1) | (bool(rights & chess.BB_A1) << 2)
    flags |= (bool(rights & chess.BB_H8) << 3) | (bool(rights & chess.BB_A8) << 4)
    ep = board.ep_square + 1 if board.ep_square is not None and board.has_legal_en_passant() else 0
    return struct.pack('>7QBB', board.pawns, board.knights, board.bishops,
                       board.rooks, board.queens, board.kings,
                       board.occupied_co[chess.WHITE], flags, ep)


def _has_explorer_index(conn):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='index' AND name='games_explorer'").fetchone() is not None


def prepare_explorer_index(path):
    """Build a compact, covering lookup once, outside interactive requests.

    Opening positions can match millions of games. Reading outcomes and ratings
    from this index avoids fetching the much wider rows containing the PGNs.
    The import lock excludes concurrent import; CREATE INDEX is atomic and uses
    the preparation's cancellation/deadline guard. Never rebuild positions.
    """
    with _connect(path, readonly=True) as conn:
        if _has_explorer_index(conn):
            return True
        if _get_meta(conn, 'import', {}).get('status') != 'completed':
            return False
    with _import_lock(path), _connect(path) as conn:
        guard = reference_queries.attach(conn)
        try:
            if _get_meta(conn, 'import', {}).get('status') != 'completed':
                return False
            conn.execute('''CREATE INDEX IF NOT EXISTS games_explorer
                ON games(id, outcome, white_elo, black_elo, speed, year)''')
        finally:
            if guard:
                guard.detach(conn)
    return True


def _move_code(move):
    return move.from_square | (move.to_square << 6) | ((move.promotion or 0) << 12)


def _decode_move(code):
    return chess.Move(code & 63, (code >> 6) & 63, promotion=(code >> 12) or None)


class _Visitor(chess.pgn.BaseVisitor):
    def begin_game(self):
        self.headers = chess.pgn.Headers()
        self.explicit_headers = set()
        self.root = None
        self.moves = []
        self.positions = {}
        self.last_key = None
        self.last_san = ''
        self.branch = 0
        self.move_count = 0
        self.errors = []
        self.movetext_result = None

    def begin_headers(self):
        return self.headers

    def visit_header(self, tagname, tagvalue):
        if tagname in self.explicit_headers:
            self.errors.append(ValueError('En-tête PGN en double : ' + tagname))
        if len(self.explicit_headers) >= 150 or len(tagvalue) > 2000:
            self.errors.append(ValueError('En-tête PGN trop volumineux.'))
        self.explicit_headers.add(tagname)
        self.headers[tagname] = re.sub(r'\\(["\\])', lambda match: match[1], tagvalue)

    def begin_variation(self):
        self.branch += 1

    def end_variation(self):
        self.branch -= 1

    def visit_board(self, board):
        if self.root is None:
            if (not board.is_valid() or board.chess960
                    or self.headers.get('Variant', 'Standard').lower() not in ('standard', 'chess', 'normal')):
                self.errors.append(ValueError('Position initiale ou variante non classique invalide.'))
            self.root = ' '.join(board.fen(en_passant='legal').split()[:4])
        if not self.branch:
            self.last_key = position_key(board)

    def visit_move(self, board, move):
        self.move_count += 1
        if self.move_count > MAX_PLIES:
            raise ValueError('Trop de coups dans cette partie.')
        if not move and (not self.branch or board.is_check()):
            self.errors.append(ValueError('Coup nul interdit dans la ligne principale ou en échec.'))
        if not self.branch:
            key = self.last_key if self.last_key is not None else position_key(board)
            san = board.san(move)
            self.positions.setdefault(key, (len(self.moves), _move_code(move), self.last_san))
            self.moves.append(move.uci())
            self.last_san = san

    def visit_result(self, result):
        if self.movetext_result is not None:
            self.errors.append(ValueError('Plusieurs résultats dans la ligne principale.'))
        self.movetext_result = result

    def handle_error(self, error):
        if len(self.errors) < 5:
            self.errors.append(error)

    def result(self):
        result = self.headers.get('Result', '*')
        if result not in RESULTS:
            self.errors.append(ValueError('Résultat PGN non reconnu.'))
        if self.movetext_result is not None:
            if 'Result' in self.explicit_headers and result != self.movetext_result:
                self.errors.append(ValueError('Résultat des en-têtes et des coups contradictoire.'))
            else:
                self.headers['Result'] = self.movetext_result
        if self.errors:
            raise ValueError(str(self.errors[0]))
        if self.root is None or self.last_key is None:
            raise ValueError('Aucune position PGN reconnue.')
        self.positions.setdefault(self.last_key, (len(self.moves), None, self.last_san))
        self.identity_payload = identity_payload(self.root, self.moves, self.headers)
        self.identity = hashlib.sha256(self.identity_payload).digest()
        return self


def _parse_record(raw, encoding='utf-8-sig'):
    text = raw.decode(encoding, errors='strict')
    if encoding not in ('utf-8', 'utf-8-sig') and len(text.encode('utf-8')) > MAX_GAME_BYTES:
        raise ValueError('Cette partie dépasse 20 Mo après conversion du texte en UTF-8.')
    expected = pgnlib._validate_lexical(text)
    stream = io.StringIO(text)
    parsed = chess.pgn.read_game(stream, Visitor=_Visitor)
    if parsed is None or chess.pgn.read_game(stream, Visitor=chess.pgn.SkipVisitor) is not None:
        raise ValueError('Une entrée doit contenir exactement une partie.')
    if parsed.move_count != expected:
        raise ValueError('Le PGN contient des coups ignorés par le lecteur.')
    parsed.encoding = encoding
    return parsed


class _ImportCancelled(Exception):
    pass


def _record_stream(stream, start=0, cancelled=lambda: False):
    """Yield raw PGNs with restartable decompressed byte offsets.

    This mirrors PGN's blank-line record delimiter, respecting multiline brace
    comments, and also accepts a new header directly after movetext. Buffers are
    bounded even for a malformed file with a huge line or an unclosed comment.
    """
    buf = bytearray()
    offset = start
    body = False
    in_comment = False
    oversized = False
    line_continuation = False
    while True:
        if (oversized or len(buf) > 1024 * 1024) and cancelled():
            raise _ImportCancelled()
        line = stream.readline(MAX_GAME_BYTES + 1)
        if not line:
            if buf or oversized:
                yield bytes(buf), offset, 'Partie supérieure à 20 Mo.' if oversized else None
            return
        line_start = offset
        offset += len(line)
        at_start = not line_continuation
        line_continuation = not line.endswith(b'\n') and len(line) >= MAX_GAME_BYTES + 1
        stripped = line.lstrip(b'\xef\xbb\xbf \t\r\n')
        header = at_start and stripped.startswith(b'[')
        # Recover at a clear next-game header after an oversized corrupt record.
        if header and ((body and not in_comment) or (oversized and stripped.startswith(b'[Event '))):
            yield bytes(buf), line_start, 'Partie supérieure à 20 Mo.' if oversized else None
            buf.clear()
            body = in_comment = oversized = False
        if len(buf) + len(line) <= MAX_GAME_BYTES and not oversized:
            buf.extend(line)
        else:
            oversized = True
            buf.clear()
        if header and not in_comment:
            continue
        if not stripped and not in_comment and body:
            yield bytes(buf), offset, 'Partie supérieure à 20 Mo.' if oversized else None
            buf.clear()
            body = oversized = False
            continue
        if at_start and stripped.startswith((b'%', b';')) and not in_comment:
            continue
        if stripped:
            body = True
        # Only braces and semicolon comments affect record boundaries.
        pos = 0
        while pos < len(line):
            if in_comment:
                close = line.find(b'}', pos)
                if close < 0:
                    break
                in_comment = False
                pos = close + 1
            else:
                brace = line.find(b'{', pos)
                semi = line.find(b';', pos)
                if semi >= 0 and (brace < 0 or semi < brace):
                    break
                if brace < 0:
                    break
                in_comment = True
                pos = brace + 1


@contextmanager
def _source_stream(source, offset, cancelled):
    with open(source, 'rb') as raw:
        if str(source).lower().endswith('.zst'):
            try:
                import zstandard
            except ImportError as exc:
                raise ValueError('La lecture .zst nécessite le module zstandard.') from exc
            with zstandard.ZstdDecompressor().stream_reader(raw) as reader:
                with io.BufferedReader(reader, buffer_size=256 * 1024) as stream:
                    left = offset
                    while left:
                        if cancelled():
                            yield None, raw
                            return
                        chunk = stream.read(min(left, 1024 * 1024))
                        if not chunk:
                            raise ValueError('Le fichier ne contient plus le point de reprise enregistré.')
                        left -= len(chunk)
                    yield stream, raw
        else:
            raw.seek(offset)
            yield raw, raw


@dataclass(slots=True)
class PreparedGame:
    values: tuple
    positions: tuple | bytes
    position_count: int
    packed_positions: bool = False


def _prepare_game(parsed, raw, *, pack_positions=False):
    """CPU work, safe to run in a parsing child without any SQLite connection."""
    if parsed.encoding not in ('utf-8', 'utf-8-sig'):
        # Preserve the original text/layout while using a single storage/export
        # encoding. Never guess a legacy codepage after a UTF-8 decoding error.
        raw = raw.decode(parsed.encoding, errors='strict').encode('utf-8')
    headers = dict(parsed.headers)
    white, black = headers.get('White', '?'), headers.get('Black', '?')
    date = headers.get('Date', '????.??.??')
    if not re.match(r'^\d{4}', date) or date[:4] == '0000':
        utc_date = headers.get('UTCDate', '')
        if re.match(r'^\d{4}', utc_date) and utc_date[:4] != '0000':
            date = utc_date
    year = int(date[:4]) if re.match(r'^\d{4}', date) and date[:4] != '0000' else None
    values = (
        parsed.identity, zlib.compress(parsed.identity_payload), f'{white} – {black}',
        json.dumps(headers, ensure_ascii=False, separators=(',', ':')), zlib.compress(raw),
        white, black, headers.get('Event', '?'), date, year,
        _rating(headers.get('WhiteElo')), _rating(headers.get('BlackElo')),
        _speed(headers), RESULTS[headers.get('Result', '*')], len(parsed.moves),
    )
    positions = tuple((key, *sample) for key, sample in parsed.positions.items())
    if pack_positions:
        # This is trusted, ephemeral IPC produced by our own parser processes,
        # never pickle read from a PGN, a database or an external application.
        positions = zlib.compress(pickle.dumps(positions, protocol=5), level=1)
    return PreparedGame(values, positions, len(parsed.positions), pack_positions)


class _SortedPositionBuffer:
    """Bounded, transaction-local writes; this object never commits anything.

    Game IDs remain assigned in source order. A full buffer may be written in
    the middle of a game, but that game's checkpoint only advances after all its
    rows are prepared, and the caller commits positions and metadata together.
    """
    def __init__(self, conn):
        self.conn = conn
        self.rows = []
        self.byte_size = 0

    def add(self, game_id, positions):
        for key, ply, move, san in positions:
            row = (key, game_id, ply, move, san)
            # Conservative shallow accounting includes shared values each time,
            # list storage and scratch pointers for the in-place sort. The
            # parser's current game remains under its existing independent cap.
            size = sys.getsizeof(row) + sum(map(sys.getsizeof, row)) + 32
            if self.rows and (len(self.rows) >= MAX_SORTED_POSITION_ROWS
                              or self.byte_size + size > MAX_SORTED_POSITION_BYTES):
                self.flush()
            self.rows.append(row)
            self.byte_size += size

    def flush(self):
        if not self.rows:
            return
        # Each exact position key occurs once per game, so the first two fields
        # uniquely determine this order without allocating a second key array.
        self.rows.sort()
        self.conn.executemany(POSITION_INSERT_SQL, self.rows)
        self.clear()

    def clear(self):
        self.rows.clear()
        self.byte_size = 0


def _insert_prepared(conn, prepared, *, position_buffer=None):
    identity, compressed_identity = prepared.values[:2]
    for row in conn.execute('SELECT identity_payload FROM games WHERE identity=?', (identity,)):
        if row[0] == compressed_identity or zlib.decompress(row[0]) == zlib.decompress(compressed_identity):
            return False
    game_id = conn.execute('''INSERT INTO games(id,identity,identity_payload,title,headers,pgn,
        white,black,event,date,year,white_elo,black_elo,speed,outcome,plies)
        SELECT max(COALESCE((SELECT max(id) FROM games),0),
                   COALESCE((SELECT CAST(value AS INTEGER) FROM meta WHERE key='game_id_high_water'),0)) + 1,
               ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?''', prepared.values).lastrowid
    positions = pickle.loads(zlib.decompress(prepared.positions)) if prepared.packed_positions else prepared.positions
    if position_buffer is None:
        conn.executemany(POSITION_INSERT_SQL,
                         ((key, game_id, ply, move, san) for key, ply, move, san in positions))
    else:
        position_buffer.add(game_id, positions)
    return True


def _insert_game(conn, parsed, raw):
    # Keep the serial entry point stable for existing callers and diagnostics.
    return _insert_prepared(conn, _prepare_game(parsed, raw))


def import_file(path, source, *, max_games=None, batch_size=250, cancelled=lambda: False,
                progress=None, encoding='utf-8-sig', workers=1, cache_mib=IMPORT_CACHE_KIB // 1024,
                sort_positions=False, phase=None):
    """Stream/import a source, resuming its last atomically committed checkpoint.

    ``max_games`` limits records processed during this call, including duplicates
    and rejected records. It pauses rather than pretending to reach EOF. A .zst
    restart decompresses/discards its prefix without reparsing/reinserting it.
    A different source (or a changed source fingerprint) starts a new import job;
    semantic deduplication continues across every source already in the store.
    Multiple parsing processes prepare bounded batches; one ordered writer owns
    SQLite and advances only the checkpoint of the fully written prefix.
    ``sort_positions`` is opt-in: position writes are sorted in bounded chunks
    within each existing transaction. Game order, IDs and checkpoints stay the
    same; this does not sort or rebuild positions already stored.
    """
    if max_games is not None and (isinstance(max_games, bool) or not isinstance(max_games, int) or max_games < 1):
        raise ValueError('Le nombre maximal de parties doit être positif.')
    if not isinstance(batch_size, int) or not 1 <= batch_size <= 5000:
        raise ValueError('La taille des lots doit être comprise entre 1 et 5 000.')
    if encoding not in ENCODINGS:
        raise ValueError('Encodage non pris en charge. Choisis UTF-8, Windows-1252 ou Latin-1.')
    if type(workers) is not int or not 1 <= workers <= MAX_IMPORT_WORKERS:
        raise ValueError(f'Le nombre de processus doit être compris entre 1 et {MAX_IMPORT_WORKERS}.')
    if type(cache_mib) is not int or not 64 <= cache_mib <= 4096:
        raise ValueError('Le cache d’import doit être un entier compris entre 64 et 4 096 Mio.')
    if type(sort_positions) is not bool:
        raise ValueError('Le tri des positions doit être activé ou désactivé.')
    source = Path(source).resolve(strict=True)
    if not source.is_file() or not str(source).lower().endswith(('.pgn', '.pgn.zst')):
        raise ValueError('Choisis un fichier .pgn ou .pgn.zst.')
    def report_phase(name, snapshot=None):
        if phase is not None:
            try:
                phase(name, snapshot)
            except Exception:
                # Diagnostics are independent of durable import correctness.
                pass

    report_phase('preparing')
    init_store(path)
    with _import_lock(path), _connect(path) as conn:
        # Only the isolated importer needs a larger B-tree working set. Read
        # queries keep their 16 MiB budget, independent of parsing parallelism.
        conn.execute(f'PRAGMA cache_size=-{cache_mib * 1024}')
        stat = source.stat()
        fingerprint = [str(source), stat.st_size, stat.st_mtime_ns]
        state = _get_meta(conn, 'import', {})
        same_source = state.get('fingerprint') == fingerprint
        if same_source and state.get('encoding', 'utf-8-sig') != encoding:
            # Replay from the beginning under the explicitly selected encoding;
            # semantic deduplication prevents duplicate rows. A byte checkpoint
            # must never silently continue with a different decoding policy.
            same_source = False
        if not same_source:
            state = dict(status='idle', imported=0, processed=0, duplicates=0,
                         rejected=0, source=str(source), bytes_read=0,
                         total_bytes=stat.st_size, offset=0, fingerprint=fingerprint,
                         encoding=encoding, error=None, rejections=[], started_at=_now())
        elif state.get('status') == 'completed':
            result = status(path)
            report_phase('finalizing', result)
            return result
        totals = _get_meta(conn, 'totals')
        state.update(status='importing', error=None, limit_reached=False, workers=workers,
                     cache_mib=cache_mib, sort_positions=sort_positions, updated_at=_now())
        _set_meta(conn, 'import', state)
        conn.commit()
        durable = {**state, **totals, 'rejections': list(state.get('rejections', []))}
        report_phase('processing', durable)
        started_processed = state['processed']
        position_buffer = _SortedPositionBuffer(conn) if sort_positions else None

        def commit():
            nonlocal durable
            # Only the previous committed snapshot may be exposed while this
            # transaction is being flushed/checkpointed.
            report_phase('committing', durable)
            if position_buffer is not None:
                position_buffer.flush()
            state['updated_at'] = _now()
            _set_meta(conn, 'import', state)
            _set_meta(conn, 'totals', totals)
            conn.commit()
            durable = {**state, **totals, 'rejections': list(state.get('rejections', []))}
            report_phase('processing' if state['status'] == 'importing' else 'finalizing', durable)
            if progress is not None:
                progress(status(path))

        def fail(exc):
            nonlocal state, durable
            # The buffer can contain rows from an executemany that partially
            # succeeded. Roll back the whole current batch and never retry those
            # in-memory rows: resume reconstructs the committed source prefix.
            conn.rollback()
            if position_buffer is not None:
                position_buffer.clear()
            state = _get_meta(conn, 'import')
            state.update(status='failed', error=str(exc)[:500], updated_at=_now())
            _set_meta(conn, 'import', state)
            conn.commit()
            durable = {**state, **_get_meta(conn, 'totals'), 'rejections': list(state.get('rejections', []))}
            report_phase('finalizing', durable)
            if progress is not None:
                progress(status(path))

        try:
            if state['offset'] and source.name.lower().endswith('.zst'):
                report_phase('replaying', durable)
            with _source_stream(source, state['offset'], cancelled) as (stream, raw_stream):
                report_phase('processing', durable)
                if stream is None:
                    state['status'] = 'paused'
                else:
                    records = _record_stream(stream, state['offset'], cancelled)
                    if workers > 1:
                        from reference_parallel import ordered_records
                        records = ordered_records(records, raw_stream, encoding=encoding,
                                                  workers=workers, max_records=max_games,
                                                  cancelled=cancelled)
                    with closing(records):
                        for record in records:
                            if cancelled():
                                state['status'] = 'paused'
                                break
                            if workers == 1:
                                raw_pgn, offset, record_error = record
                                bytes_read = raw_stream.tell()
                                empty = not raw_pgn.strip() and not record_error
                            else:
                                prepared, offset, record_error, bytes_read, empty = record
                            if empty:
                                state['offset'] = offset
                                continue
                            state['processed'] += 1
                            try:
                                if record_error:
                                    raise ValueError(record_error)
                                if workers == 1:
                                    parsed = _parse_record(raw_pgn, encoding)
                            except (ValueError, UnicodeError, IndexError, KeyError, RecursionError) as exc:
                                state['rejected'] += 1
                                state['rejections'].append({'record': state['processed'],
                                                            'offset': state['offset'],
                                                            'reason': str(exc)[:250]})
                                state['rejections'] = state['rejections'][-MAX_REJECTIONS:]
                            else:
                                if workers == 1:
                                    if position_buffer is None:
                                        inserted = _insert_game(conn, parsed, raw_pgn)
                                    else:
                                        inserted = _insert_prepared(conn, _prepare_game(parsed, raw_pgn),
                                                                    position_buffer=position_buffer)
                                    position_count = len(parsed.positions)
                                else:
                                    if position_buffer is None:
                                        inserted = _insert_prepared(conn, prepared)
                                    else:
                                        inserted = _insert_prepared(conn, prepared, position_buffer=position_buffer)
                                    position_count = prepared.position_count
                                if inserted:
                                    state['imported'] += 1
                                    totals['game_count'] += 1
                                    totals['indexed_positions'] += position_count
                                else:
                                    state['duplicates'] += 1
                            state['offset'] = offset
                            state['bytes_read'] = min(bytes_read, stat.st_size)
                            if (state['processed'] - started_processed) % batch_size == 0:
                                commit()
                            if max_games is not None and state['processed'] - started_processed >= max_games:
                                state.update(status='paused', limit_reached=True)
                                break
                        else:
                            state.update(status='completed', bytes_read=stat.st_size)
                commit()
        except _ImportCancelled:
            state['status'] = 'paused'
            try:
                commit()
            except Exception as exc:
                fail(exc)
        except Exception as exc:
            fail(exc)
        result = status(path)
        # Closing the last SQLite connection can consolidate a large WAL long
        # after the final source byte and transaction have been processed.
        report_phase('finalizing', result)
        return result


def _pagination(offset, limit):
    if not isinstance(offset, int) or offset < 0:
        raise ValueError('Décalage de page invalide.')
    if not isinstance(limit, int) or not 1 <= limit <= 250:
        raise ValueError('Une page contient entre 1 et 250 parties.')
    return offset, limit


def _filtered_game_count(conn, path, totals, clauses, params, *, schema='main'):
    """Cache scalar corpus counts by immutable corpus size and filter profile.

    Appended games and counters commit together. Each query reads one snapshot;
    cache misses inspect only the existing compact cadence/Elo index, not PGNs.
    The cache is bounded even while an import commits thousands of batches.
    """
    if not clauses:
        return totals['game_count']
    file = Path(path).resolve()
    stat = file.stat()
    key = (str(file), stat.st_ino, stat.st_ctime_ns, totals['game_count'], totals.get('revision', 0), tuple(clauses), tuple(params))
    with _FILTER_COUNTS_LOCK:
        if key in _FILTER_COUNTS:
            _FILTER_COUNTS.move_to_end(key)
            return _FILTER_COUNTS[key]
    # The index already exists in all stores: no migration or writes are needed.
    covered = all(set(re.findall(r'\bg\.([a-z_]+)', clause)) <= {'white_elo','black_elo','speed'} for clause in clauses)
    index = ' INDEXED BY games_speed_rating' if covered else ''
    count = conn.execute(f'SELECT count(*) FROM {schema}.games g' + index
                         + ' WHERE ' + ' AND '.join(clauses), params).fetchone()[0]
    with _FILTER_COUNTS_LOCK:
        _FILTER_COUNTS[key] = count
        _FILTER_COUNTS.move_to_end(key)
        while len(_FILTER_COUNTS) > MAX_FILTER_COUNTS:
            _FILTER_COUNTS.popitem(last=False)
    return count


def _position_count(conn, path, key):
    totals = _get_meta(conn,'totals')
    file = Path(path).resolve()
    stat = file.stat()
    cache_key = (str(file),stat.st_ino,stat.st_ctime_ns,totals['game_count'],totals.get('revision', 0),('position',),(key,))
    with _FILTER_COUNTS_LOCK:
        if cache_key in _FILTER_COUNTS:
            _FILTER_COUNTS.move_to_end(cache_key)
            return _FILTER_COUNTS[cache_key]
    count = conn.execute('SELECT count(*) FROM positions WHERE position_key=?',(key,)).fetchone()[0]
    with _FILTER_COUNTS_LOCK:
        _FILTER_COUNTS[cache_key] = count
        _FILTER_COUNTS.move_to_end(cache_key)
        while len(_FILTER_COUNTS)>MAX_FILTER_COUNTS:
            _FILTER_COUNTS.popitem(last=False)
    return count


def _entry(row):
    return {'id': row['id'], 'title': row['title'], 'headers': json.loads(row['headers'])}


def _search_match_key(conn, path, search):
    # Counts commit with appended games. The key belongs to this reader's exact
    # snapshot, so a resumed import cannot reuse older candidate IDs.
    file = Path(path).resolve()
    stat = file.stat()
    return (str(file), stat.st_ino, stat.st_ctime_ns,
            _get_meta(conn, 'totals')['game_count'], _get_meta(conn, 'totals').get('revision', 0), search)


def _restore_search_matches(conn, key):
    with _SEARCH_MATCHES_LOCK:
        ids = _SEARCH_MATCHES.get(key)
        if ids is None:
            return False
        _SEARCH_MATCHES.move_to_end(key)
    conn.executemany('INSERT INTO matched_games(id) VALUES(?)', ((value,) for value in ids))
    return True


def _remember_search_matches(conn, key):
    # Cache IDs only, never PGN/header payloads. Broad searches remain disk-backed
    # instead of allocating millions of Python objects or an unbounded cache.
    rows = conn.execute('SELECT id FROM matched_games LIMIT ?', (MAX_SEARCH_MATCH_IDS + 1,)).fetchall()
    if len(rows) > MAX_SEARCH_MATCH_IDS:
        return
    reference_queries.check()
    ids = array('q', (row[0] for row in rows))
    with _SEARCH_MATCHES_LOCK:
        _SEARCH_MATCHES[key] = ids
        _SEARCH_MATCHES.move_to_end(key)
        while (len(_SEARCH_MATCHES) > MAX_SEARCH_MATCH_PROFILES
               or sum(len(value) for value in _SEARCH_MATCHES.values()) > MAX_SEARCH_MATCH_CACHE_IDS):
            _SEARCH_MATCHES.popitem(last=False)


GAME_LIST_SORTS = {'id': 'g.id', 'date': 'g.date', 'white': 'g.white COLLATE NOCASE',
    'black': 'g.black COLLATE NOCASE', 'event': 'g.event COLLATE NOCASE',
    'white_elo': 'g.white_elo', 'black_elo': 'g.black_elo',
    'result': 'g.outcome', 'title': 'g.title COLLATE NOCASE'}


def validate_list_query(*, search='', sort='id', rating_min=None, rating_max=None, speed=None, speeds=None, advanced=None):
    if sort not in GAME_LIST_SORTS:
        raise ValueError('Tri inconnu.')
    if search and (not isinstance(search, str) or len(search) > 200):
        raise ValueError('Recherche trop longue.')
    clauses, params = _filters(rating_min=rating_min, rating_max=rating_max, speed=speed, speeds=speeds)
    if advanced is not None:
        from game_search import AdvancedGameSearch
        from reference_game_search import columns
        advanced = advanced if isinstance(advanced, AdvancedGameSearch) else AdvancedGameSearch(**advanced)
        extra, values = advanced.sql(columns())
        clauses.extend(extra)
        params.extend(values)
    return clauses, params


def list_games(path, *, offset=0, limit=50, search='', sort='id', descending=False,
               rating_min=None, rating_max=None, speed=None, speeds=None, advanced=None):
    offset, limit = _pagination(offset, limit)
    sorts = GAME_LIST_SORTS
    clauses, params = validate_list_query(search=search, sort=sort, rating_min=rating_min,
        rating_max=rating_max, speed=speed, speeds=speeds, advanced=advanced)
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    direction = 'DESC' if descending else 'ASC'
    with _connect(path, readonly=True) as conn:
        if advanced is not None or search:
            from reference_game_search import install
            install(conn)
        # Names/events have narrow covering indexes. An OR over three infix
        # LIKEs otherwise scans every wide game row (including stored PGNs).
        # Materialize matching IDs once in a connection-local, disk-backed temp
        # table: counting and paging reuse it, without growing Python memory.
        conn.execute('PRAGMA temp_store=FILE')
        conn.execute('BEGIN')
        if search:
            from game_search import fold
            # Scan only narrow covering metadata indexes, with the same
            # accent/case folding as advanced search and personal collections.
            # Literal substring terms retain punctuation without LIKE wildcards.
            terms = fold(search).split()
            conn.execute('CREATE TEMP TABLE matched_games(id INTEGER PRIMARY KEY)')
            fields = ('white', 'black', 'event')
            candidates = ' UNION '.join(
                f'SELECT id FROM games INDEXED BY games_{field} WHERE instr(cg_fold({field}),?)>0'
                for field in fields)
            match_key = _search_match_key(conn, path, ('folded-v1', tuple(terms)))
            if not _restore_search_matches(conn, match_key):
                if terms:
                    conn.execute('INSERT INTO matched_games ' + candidates, [terms[0]] * 3)
                    for term in terms[1:]:
                        conn.execute('DELETE FROM matched_games WHERE id NOT IN (' + candidates + ')', [term] * 3)
                else:
                    conn.execute('INSERT INTO matched_games SELECT id FROM games INDEXED BY games_page_id')
                _remember_search_matches(conn, match_key)
            if clauses:
                lookup = ' INDEXED BY games_explorer' if _has_explorer_index(conn) else ''
                # Candidate-first lookups keep rare names selective, including
                # combined Elo/cadence filters, instead of scanning the corpus.
                conn.execute('DELETE FROM matched_games WHERE id NOT IN ('
                    + 'SELECT g.id FROM matched_games m CROSS JOIN games g' + lookup
                    + ' ON g.id=m.id' + where + ')', params)
            total = conn.execute('SELECT count(*) FROM matched_games').fetchone()[0]
            if sort == 'id':
                page = f'SELECT id FROM matched_games ORDER BY id {direction} LIMIT ? OFFSET ?'
            else:
                page = ('SELECT g.id FROM matched_games m CROSS JOIN games g ON g.id=m.id'
                        + f' ORDER BY {sorts[sort]} {direction}, g.id {direction} LIMIT ? OFFSET ?')
            page_params = [limit, offset]
        else:
            total = _filtered_game_count(conn,path,_get_meta(conn,'totals'),clauses,params)
            indexed = ' INDEXED BY games_page_id' if sort == 'id' and not clauses else ''
            page = 'SELECT g.id FROM games g' + indexed + where + f' ORDER BY {sorts[sort]} {direction}, g.id {direction} LIMIT ? OFFSET ?'
            page_params = [*params, limit, offset]
        order = f' ORDER BY {sorts[sort]} {direction}, g.id {direction}'
        rows = conn.execute('SELECT g.id,g.title,g.headers FROM (' + page + ') page'
                            + ' JOIN games g ON g.id=page.id' + order, page_params).fetchall()
    return {'entries': [_entry(row) for row in rows], 'total': total,
            'offset': offset, 'limit': limit, 'has_more': offset + len(rows) < total}


def read_game(path, game_id):
    with _connect(path, readonly=True) as conn:
        row = conn.execute('SELECT id,title,headers,pgn FROM games WHERE id=?', (game_id,)).fetchone()
        if row is None:
            raise ValueError('Cette partie de référence n’existe pas.')
        return {**_entry(row), 'pgn': zlib.decompress(row['pgn']).decode('utf-8-sig')}


def iter_pgn(path):
    """Yield complete original game texts from one read snapshot, one at a time.

    The caller streams these chunks with blank separators to the response/file;
    no corpus-sized string or repeated OFFSET pagination is constructed.
    """
    with _connect(path, readonly=True) as conn:
        conn.execute('BEGIN')
        for row in conn.execute('SELECT pgn FROM games ORDER BY id'):
            yield zlib.decompress(row[0]).decode('utf-8-sig')


IMPORT_FREQUENCY_THRESHOLD = 50000


def _import_frequency_rows(conn, board, key, totals, state):
    """Count the compact position index without reading large PGN rows.

    These are exact frequencies for this read snapshot, not a sample. Outcomes
    are explicitly unavailable rather than being misclassified as unknown.
    Only an unfinished, unfiltered single reference may use this path.
    """
    rows = conn.execute('''SELECT next_move,count(*) AS n FROM positions
        WHERE position_key=? GROUP BY next_move''', (key,)).fetchall()
    moves, total, terminal = [], 0, 0
    for row in rows:
        if row['next_move'] is None:
            terminal += row['n']
            continue
        move = _decode_move(row['next_move'])
        total += row['n']
        moves.append(dict(uci=move.uci(), san=board.san(move), total=row['n'],
                          white=0, draws=0, black=0, unknown=0, results_available=False))
    return dict(status='ok', white=0, draws=0, black=0, unknown=0, total=total,
                moves=sorted(moves, key=lambda row: (-row['total'], row['san'])),
                game_count=totals.get('game_count', 0), terminal_count=terminal,
                duplicates=state.get('duplicates', 0), invalid_entries=state.get('rejected', 0),
                results_available=False, complete=False,
                message='Fréquences exactes des parties déjà importées. Les résultats de cette position très fréquente seront disponibles après la fin de l’importation.')


def explorer_data(path, fen, *, rating_min=None, rating_max=None, speed=None, speeds=None, from_year=None, to_year=None,
                  allow_import_frequencies=False):
    board = pgnlib.validate_board(fen)
    key = position_key(board)
    clauses, params = _filters(rating_min=rating_min, rating_max=rating_max,
                               speed=speed, speeds=speeds, from_year=from_year, to_year=to_year)
    extra = ' AND ' + ' AND '.join(clauses) if clauses else ''
    rating = 'g.white_elo' if board.turn else 'g.black_elo'
    with _connect(path, readonly=True) as conn:
        conn.execute('BEGIN')
        totals = _get_meta(conn, 'totals')
        state = _get_meta(conn, 'import', {})
        has_explorer_index = _has_explorer_index(conn)
        if (allow_import_frequencies and not clauses and not has_explorer_index
                and state.get('status') != 'completed'
                and conn.execute('''SELECT 1 FROM positions WHERE position_key=?
                    LIMIT 1 OFFSET ?''', (key, IMPORT_FREQUENCY_THRESHOLD)).fetchone()):
            return _import_frequency_rows(conn, board, key, totals, state)
        lookup = ' INDEXED BY games_explorer' if has_explorer_index else ''
        rows = conn.execute(f'''SELECT p.next_move, g.outcome, count(*) AS n,
                sum({rating}) AS rating_sum, count({rating}) AS rating_count
            FROM positions p JOIN games g{lookup} ON g.id=p.game_id
            WHERE p.position_key=?{extra} GROUP BY p.next_move,g.outcome''', [key, *params]).fetchall()
        game_count = _filtered_game_count(conn, path, totals, clauses, params)
    result = dict(status='ok', white=0, draws=0, black=0, unknown=0, total=0,
                  moves=[], game_count=game_count, terminal_count=0,
                  duplicates=state.get('duplicates', 0), invalid_entries=state.get('rejected', 0))
    return _aggregate_moves(board, rows, result)


def _aggregate_moves(board, rows, result):
    moves = {}
    for sample in rows:
        if sample['next_move'] is None:
            result['terminal_count'] += sample['n']
            continue
        move = _decode_move(sample['next_move'])
        row = moves.setdefault(sample['next_move'], dict(uci=move.uci(), san=board.san(move),
            white=0, draws=0, black=0, unknown=0, total=0, _rating_sum=0, _rating_count=0))
        row[sample['outcome']] += sample['n']
        row['total'] += sample['n']
        row['_rating_sum'] += sample['rating_sum'] or 0
        row['_rating_count'] += sample['rating_count']
        result[sample['outcome']] += sample['n']
        result['total'] += sample['n']
    for row in moves.values():
        n = row.pop('_rating_count')
        rating_sum = row.pop('_rating_sum')
        row['rating_sum'] = rating_sum
        row['rating_count'] = n
        if n:
            row['average_rating'] = round(rating_sum / n)
    result['moves'] = sorted(moves.values(), key=lambda item: (-item['total'], item['san']))
    return result


def explorer_data_many(paths, fen, *, rating_min=None, rating_max=None, speed=None, speeds=None,
                       from_year=None, to_year=None, exclude_identities=(), allow_import_frequencies=False):
    """Aggregate matching games across stores, deduplicating *before* counting.

    Only matching position rows are read. SQL TEMP tables spill to disk rather
    than materializing hundreds of thousands of game identities in Python.
    ``exclude_identities`` accepts SHA-256 hex IDs from the study explorer.
    game_count sums filtered corpus sizes (explicitly flagged); dedup of
    unrelated games would require a full index scan and is unnecessary here.
    duplicates counts repeated matching games across stores, not import rejects.
    """
    paths = list(dict.fromkeys(str(Path(path).resolve()) for path in paths))
    exclude_identities = list(exclude_identities)
    if len(paths) == 1 and not exclude_identities:
        return explorer_data(paths[0], fen, rating_min=rating_min, rating_max=rating_max,
                             speed=speed, speeds=speeds, from_year=from_year, to_year=to_year,
                             allow_import_frequencies=allow_import_frequencies)
    board = pgnlib.validate_board(fen)
    key = position_key(board)
    clauses, params = _filters(rating_min=rating_min, rating_max=rating_max,
                               speed=speed, speeds=speeds, from_year=from_year, to_year=to_year)
    extra = ' AND ' + ' AND '.join(clauses) if clauses else ''
    rating = 'g.white_elo' if board.turn else 'g.black_elo'
    result = dict(status='ok', white=0, draws=0, black=0, unknown=0, total=0,
                  moves=[], game_count=0, terminal_count=0, duplicates=0,
                  invalid_entries=0, game_count_includes_duplicates=True, game_count_is_sum=True)
    conn = sqlite3.connect(':memory:', uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    guard = None
    try:
        guard = reference_queries.attach(conn)
        conn.execute('PRAGMA temp_store=FILE')
        conn.execute('PRAGMA temp.cache_size=-8192')
        conn.execute('''CREATE TEMP TABLE matched(
            identity BLOB NOT NULL, payload BLOB NOT NULL, next_move INTEGER,
            outcome TEXT NOT NULL, rating INTEGER,
            PRIMARY KEY(identity,payload)) WITHOUT ROWID''')
        conn.execute('CREATE TEMP TABLE excluded(identity BLOB PRIMARY KEY) WITHOUT ROWID')
        for identity in exclude_identities:
            try:
                identity = bytes.fromhex(identity) if isinstance(identity, str) else bytes(identity)
            except (TypeError, ValueError) as exc:
                raise ValueError('Identité de partie invalide.') from exc
            if len(identity) != 32:
                raise ValueError('Identité de partie invalide.')
            conn.execute('INSERT OR IGNORE INTO excluded VALUES(?)', (identity,))
        conn.commit()
        matched_total = 0
        for path in paths:
            conn.execute('ATTACH DATABASE ? AS corpus', (Path(path).as_uri() + '?mode=ro',))
            try:
                conn.execute('BEGIN')
                totals = conn.execute("SELECT value FROM corpus.meta WHERE key='totals'").fetchone()
                state = conn.execute("SELECT value FROM corpus.meta WHERE key='import'").fetchone()
                result['game_count'] += _filtered_game_count(conn, path, json.loads(totals[0]),
                                                            clauses, params, schema='corpus')
                result['invalid_entries'] += json.loads(state[0]).get('rejected', 0) if state else 0
                matched_total += conn.execute(f'''SELECT count(*) FROM corpus.positions p
                    JOIN corpus.games g ON g.id=p.game_id
                    WHERE p.position_key=?{extra}
                    AND NOT EXISTS(SELECT 1 FROM excluded e WHERE e.identity=g.identity)''',
                    [key, *params]).fetchone()[0]
                conn.execute(f'''INSERT OR IGNORE INTO matched(identity,payload,next_move,outcome,rating)
                    SELECT g.identity,g.identity_payload,p.next_move,g.outcome,{rating}
                    FROM corpus.positions p JOIN corpus.games g ON g.id=p.game_id
                    WHERE p.position_key=?{extra}
                    AND NOT EXISTS(SELECT 1 FROM excluded e WHERE e.identity=g.identity)
                    ORDER BY g.id''', [key, *params])
                conn.commit()
            finally:
                if conn.in_transaction:
                    conn.rollback()
                conn.execute('DETACH DATABASE corpus')
        unique = conn.execute('SELECT count(*) FROM matched').fetchone()[0]
        result['duplicates'] = matched_total - unique
        rows = conn.execute('''SELECT next_move,outcome,count(*) AS n,
            sum(rating) AS rating_sum,count(rating) AS rating_count
            FROM matched GROUP BY next_move,outcome''').fetchall()
        return _aggregate_moves(board, rows, result)
    finally:
        if guard:
            guard.detach(conn)
        conn.close()


def search_position(path, fen, *, offset=0, limit=50, summary=False):
    """Match each game once at its first mainline occurrence of this position."""
    offset, limit = _pagination(offset, limit)
    key = position_key(pgnlib.validate_board(fen))
    with _connect(path, readonly=True) as conn:
        conn.execute('BEGIN')
        total = _position_count(conn,path,key)
        rows = []
        if not summary and total:
            # Date already includes the UTCDate fallback prepared at import.
            # Keep partial dates inside their known year/month, but put wholly
            # unknown years last. No schema change is needed during an import.
            known = "g.date >= '0001' AND g.date < ':' AND substr(g.date,1,4) GLOB '[0-9][0-9][0-9][0-9]'"
            game_count = _get_meta(conn, 'totals')['game_count']
            frequent = total >= 10_000 and total * 4 >= game_count
            if frequent:
                # The date index drives common positions (notably the initial
                # board). Stop at this page instead of sorting millions of hits.
                table = 'games g INDEXED BY games_date CROSS JOIN positions p'
            else:
                table = 'positions p JOIN games g ON g.id=p.game_id'
            page = f'''SELECT g.id,p.ply,p.san FROM {table}
                WHERE p.position_key=? AND p.game_id=g.id AND {known}
                ORDER BY g.date DESC,g.id DESC LIMIT ? OFFSET ?'''
            rows = conn.execute('SELECT g.id,g.title,g.headers,page.ply,page.san FROM (' + page + ') page'
                + ' JOIN games g ON g.id=page.id ORDER BY g.date DESC,g.id DESC', (key, limit, offset)).fetchall()
            if len(rows) < limit:
                unknown_offset = 0
                if offset and not rows:
                    known_count = conn.execute('SELECT count(*) FROM positions p JOIN games g ON g.id=p.game_id'
                        + f' WHERE p.position_key=? AND {known}', (key,)).fetchone()[0]
                    unknown_offset = max(0, offset - known_count)
                page = f'''SELECT p.game_id AS id,p.ply,p.san FROM positions p JOIN games g ON g.id=p.game_id
                    WHERE p.position_key=? AND NOT ({known}) ORDER BY p.game_id DESC LIMIT ? OFFSET ?'''
                rows += conn.execute('SELECT g.id,g.title,g.headers,page.ply,page.san FROM (' + page + ') page'
                    + ' JOIN games g ON g.id=page.id ORDER BY g.id DESC', (key, limit - len(rows), unknown_offset)).fetchall()
    return {'matches': [{'game_id': row['id'], 'title': row['title'],
                         'headers': json.loads(row['headers']), 'ply': row['ply'], 'san': row['san']} for row in rows],
            'total': total, 'offset': offset, 'limit': limit, 'has_more': offset + len(rows) < total,
            'occurrences': 'first_mainline'}
