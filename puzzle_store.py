"""Shared, disk-backed Lichess puzzle bank. Never load the archive into memory."""
from __future__ import annotations
import csv
import gzip
import io
import json
import os
from pathlib import Path
import random
import sqlite3
import time
from contextlib import contextmanager

import chess
import zstandard
import db


def bank_path():
    return Path(os.environ.get('CHESSGYM_PUZZLE_BANK', db.DATA_DIR / 'puzzles' / 'bank.sqlite3'))


@contextmanager
def bank_connection(write=False):
    path = bank_path()
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
    if not write and not path.exists():
        yield None
        return
    conn = sqlite3.connect(path if write else path.as_uri() + '?mode=ro', uri=not write, timeout=15)
    conn.row_factory = sqlite3.Row
    try:
        if write:
            conn.execute('PRAGMA journal_mode=WAL')
            conn.execute('PRAGMA synchronous=NORMAL')
        yield conn
        if write:
            conn.commit()
    finally:
        conn.close()


def init_bank(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS puzzles (
      id TEXT PRIMARY KEY, fen TEXT NOT NULL, moves TEXT NOT NULL,
      rating INTEGER NOT NULL, rating_deviation INTEGER NOT NULL,
      popularity INTEGER NOT NULL, nb_plays INTEGER NOT NULL,
      themes TEXT NOT NULL, game_url TEXT NOT NULL, opening_tags TEXT NOT NULL,
      color TEXT NOT NULL, solution_plies INTEGER NOT NULL,
      initial_ply INTEGER NOT NULL, piece_count INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS puzzles_rating ON puzzles(rating,id);
    CREATE INDEX IF NOT EXISTS puzzles_color_rating ON puzzles(color,rating,id);
    CREATE INDEX IF NOT EXISTS puzzles_pieces_rating ON puzzles(piece_count,rating,id);
    CREATE INDEX IF NOT EXISTS puzzles_initial_rating ON puzzles(initial_ply,rating,id);
    CREATE TABLE IF NOT EXISTS bank_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    ''')
    # External-content FTS indexes themes and opening names without duplicating PGNs.
    conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS puzzle_search USING fts5(themes,opening_tags,content='puzzles',content_rowid='rowid')")
    conn.execute("CREATE TRIGGER IF NOT EXISTS puzzles_search_insert AFTER INSERT ON puzzles BEGIN INSERT INTO puzzle_search(rowid,themes,opening_tags) VALUES(new.rowid,new.themes,new.opening_tags); END")
    if conn.execute("SELECT 1 FROM bank_meta WHERE key='search_version'").fetchone() is None:
        conn.execute("INSERT INTO puzzle_search(puzzle_search) VALUES('rebuild')")
        conn.execute("INSERT INTO bank_meta VALUES('search_version','1')")


def unpack(row):
    if row is None:
        return None
    value = dict(row)
    for key in ('moves', 'themes', 'opening_tags'):
        value[key] = value[key].split()
    return value


def get_puzzle(puzzle_id):
    with bank_connection() as conn:
        return unpack(conn.execute('SELECT * FROM puzzles WHERE id=?', (puzzle_id,)).fetchone()) if conn else None


def prepared_puzzle(row):
    """Validate the stored sequence and expose the position the solver receives."""
    value = dict(row)
    moves = value['moves'].split() if isinstance(value['moves'], str) else list(value['moves'])
    board = chess.Board(value['fen'])
    if len(moves) < 2 or not board.is_valid():
        raise ValueError('Puzzle invalide.')
    board.push_uci(moves[0])
    start = board.fen()
    start_ply = board.ply()
    for move in moves[1:]:
        board.push_uci(move)
    value.update(start_fen=start, start_ply=start_ply, solution=moves[1:])
    return value


def bank_stats():
    with bank_connection() as conn:
        if conn is None:
            return {'count': 0, 'status': 'empty', 'source': 'Lichess', 'license': 'CC0'}
        meta = {r['key']: json.loads(r['value']) for r in conn.execute('SELECT * FROM bank_meta')}
        return {'count': meta.get('count', 0), 'status': meta.get('status', 'ready'),
                'imported_at': meta.get('imported_at'), 'processed': meta.get('processed', 0),
                'rejected': meta.get('rejected', 0), 'source': 'Lichess', 'license': 'CC0'}


class PuzzleSelectionTimeout(TimeoutError):
    """A bounded search was interrupted; this does not imply an empty set."""


def _puzzle_filter_sql(filters, *, selected_ids=False):
    low=max(0,int(filters.get('rating_min') if filters.get('rating_min') is not None else 0))
    high=min(4000,int(filters.get('rating_max') if filters.get('rating_max') is not None else 4000))
    where = ['rating BETWEEN ? AND ?']
    params = [low, high]
    if filters.get('color') in ('white', 'black'):
        where.append('color=?'); params.append(filters['color'])
    if filters.get('max_rating_deviation') is not None:
        where.append('rating_deviation<=?'); params.append(int(filters['max_rating_deviation']))
    for theme in filters.get('exclude_themes',[]):
        where.append("instr(' ' || themes || ' ', ?)=0"); params.append(' '+theme+' ')
    for field, name, op in [('initial_ply', 'max_initial_ply', ' BETWEEN 0 AND '), ('piece_count', 'max_pieces', '<='),
                             ('initial_ply', 'min_initial_ply', '>='), ('piece_count', 'min_pieces', '>='),
                             ('solution_plies', 'solution_min', '>='), ('solution_plies', 'solution_max', '<=')]:
        if filters.get(name) is not None:
            where.append(f'{field}{op}?'); params.append(int(filters[name]))
    search=[]
    for theme in filters.get('themes', [])[:12]:
        search.append('themes : "'+str(theme).replace('"','""')+'"')
    if filters.get('opening'):
        tokens=str(filters['opening'])[:120].replace('_',' ').split()[:12]
        if tokens:
            search.append('opening_tags : ('+' AND '.join('"'+word.replace('"','""')+'"*' for word in tokens)+')')
    if search:
        if selected_ids:
            # Failed-history batches contain at most 400 IDs. Test FTS against
            # those rows instead of materializing a potentially huge theme set.
            where.append('EXISTS (SELECT 1 FROM puzzle_search WHERE puzzle_search.rowid=puzzles.rowid AND puzzle_search MATCH ?)')
        else:
            where.append('rowid IN (SELECT rowid FROM puzzle_search WHERE puzzle_search MATCH ?)')
        params.append(' AND '.join(search))
    return where,params


def filter_puzzle_ids(conn, ids, filters):
    """Apply exactly the same bank filters to one bounded history batch."""
    if not ids:return []
    if len(ids)>400:raise ValueError('Puzzle ID batches must contain at most 400 IDs.')
    where,params=_puzzle_filter_sql(filters,selected_ids=True)
    where.append('id IN ('+','.join('?' for _ in ids)+')');params.extend(ids)
    return [unpack(row) for row in conn.execute('SELECT * FROM puzzles WHERE '+' AND '.join(where),params)]


def search_puzzles(filters=None, limit=50, exclude_ids=(), *, seed=None):
    """Bounded indexed candidates, then sample; no ORDER BY RANDOM over millions."""
    filters = filters or {}
    rng = random.Random(seed)
    where,params=_puzzle_filter_sql(filters)
    low,high=params[:2]
    if low>high:return []
    requested_target=filters.get('target_rating')
    target=min(high,max(low,int(requested_target if requested_target is not None else rng.randint(low,high))))
    excluded = set(exclude_ids)
    # Adaptive rating batches avoid a bias toward the start of the whole bank.
    candidate_ids = []
    candidate_limit = min(5000, max(500, int(limit) * 30 + min(len(excluded), 1500)))
    # Opening/endgame limits are often sparse within a rating range. Read their
    # compact covering index first, then fetch only the selected full records.
    # Otherwise SQLite favours rating order and loads thousands of ineligible
    # positions from disk before finding enough early-game puzzles.
    index = ('puzzles_initial_rating' if filters.get('max_initial_ply') is not None else
             'puzzles_pieces_rating' if filters.get('max_pieces') is not None else None)
    source = 'puzzles' + (' INDEXED BY ' + index if index else '')
    with bank_connection() as conn:
        if conn is None:
            return []
        # Protect interactive clients from rare sparse filters scanning the full bank.
        deadline = time.monotonic() + 4
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10000)
        try:
            for comparison, order in [('>=', 'ASC'), ('<', 'DESC')]:
                # Reserve room for every excluded ID so the SQL limit cannot
                # hide unseen puzzles after a large prefix of seen rows.
                query = 'SELECT id FROM ' + source + ' WHERE ' + ' AND '.join(where) + f' AND rating {comparison} ? ORDER BY rating {order},id LIMIT ?'
                cursor=conn.execute(query,[*params,target,candidate_limit+len(excluded)]);accepted=0
                for row in cursor:
                    if time.monotonic()>deadline:raise PuzzleSelectionTimeout()
                    if row['id'] in excluded:continue
                    candidate_ids.append(row['id']);accepted+=1
                    if accepted>=candidate_limit:break
                cursor.close()
            rng.shuffle(candidate_ids)
            candidate_ids = candidate_ids[:max(1, min(500, int(limit)))]
            selected = {}
            for start in range(0, len(candidate_ids), 400):
                if time.monotonic()>deadline:raise PuzzleSelectionTimeout()
                batch = candidate_ids[start:start+400]
                query = 'SELECT * FROM puzzles WHERE id IN (' + ','.join('?' for _ in batch) + ')'
                for row in conn.execute(query, batch):
                    if time.monotonic()>deadline:raise PuzzleSelectionTimeout()
                    selected[row['id']] = unpack(row)
        except sqlite3.OperationalError as exc:
            if 'interrupted' not in str(exc):
                raise
            raise PuzzleSelectionTimeout() from exc
        finally:
            conn.set_progress_handler(None, 0)
    results = [selected[ident] for ident in candidate_ids]
    return results


def configure_import_connection(conn, cache_mb=256):
    """Connection-local bulk-import tuning; readers retain their small cache."""
    if type(cache_mb) is not int or not 16 <= cache_mb <= 1024:
        raise ValueError('Le cache d’import doit être compris entre 16 et 1024 Mio.')
    # A negative cache_size is KiB, independent of the database page size.
    # Keep WAL + NORMAL durability and bounded batches. Only checkpoint cadence
    # changes: 64 MiB avoids repeatedly flushing the same random-index pages.
    conn.execute('PRAGMA cache_size=' + str(-cache_mb * 1024))
    page_size = conn.execute('PRAGMA page_size').fetchone()[0]
    conn.execute('PRAGMA wal_autocheckpoint=' + str(max(1, 64 * 1024 * 1024 // page_size)))


def import_bank(source, batch_size=5000, max_puzzles=None, progress=None, *, cache_mb=256):
    """Streaming, repeatable import. Existing IDs referenced by history stay intact."""
    path = Path(source).resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in ('.csv', '.zst', '.gz'):
        raise ValueError('Sélectionne un fichier CSV, CSV.ZST ou CSV.GZ de puzzles Lichess.')
    batch_size = max(100, min(20000, int(batch_size)))
    processed = accepted = rejected = 0
    started = time.time()
    raw = path.open('rb')
    decoder = zstandard.ZstdDecompressor().stream_reader(raw) if path.suffix.lower() == '.zst' else gzip.GzipFile(fileobj=raw) if path.suffix.lower() == '.gz' else raw
    try:
        with io.TextIOWrapper(decoder, encoding='utf-8-sig', newline='') as stream, bank_connection(True) as conn:
            configure_import_connection(conn, cache_mb)
            init_bank(conn)
            def save_meta(status):
                values = {'status': status, 'processed': processed, 'rejected': rejected,
                          'count': conn.execute('SELECT COUNT(*) FROM puzzles').fetchone()[0] if status == 'ready' else base_count + accepted,
                          'imported_at': time.time(), 'source_name': path.name}
                conn.executemany('INSERT OR REPLACE INTO bank_meta VALUES (?,?)', [(k, json.dumps(v)) for k,v in values.items()])
                conn.commit()
                if progress:
                    progress({**values, 'elapsed_seconds': round(time.time() - started, 1)})
            base_count = conn.execute('SELECT COUNT(*) FROM puzzles').fetchone()[0]
            save_meta('importing')
            reader = csv.DictReader(stream)
            required = {'PuzzleId', 'FEN', 'Moves', 'Rating', 'Themes', 'GameUrl'}
            if not required.issubset(reader.fieldnames or []):
                raise ValueError('Les colonnes du fichier ne correspondent pas à la banque Lichess.')
            batch = []
            for item in reader:
                if max_puzzles is not None and processed >= max_puzzles:
                    break
                processed += 1
                try:
                    puzzle_id = item['PuzzleId']
                    if not puzzle_id.isalnum() or not 1 <= len(puzzle_id) <= 20:
                        raise ValueError('id')
                    moves = item['Moves'].split()
                    board = chess.Board(item['FEN'])
                    if not board.is_valid() or not 2 <= len(moves) <= 100:
                        raise ValueError('position')
                    board.push_uci(moves[0])
                    color = 'white' if board.turn else 'black'
                    batch.append((puzzle_id,item['FEN'],' '.join(moves),int(item['Rating']),int(item.get('RatingDeviation') or 0),
                        int(item.get('Popularity') or 0),int(item.get('NbPlays') or 0),item['Themes'],item['GameUrl'],item.get('OpeningTags') or '',
                        color,len(moves)-1,board.ply(),len(board.piece_map())))
                except (ValueError, KeyError, TypeError, OverflowError):
                    rejected += 1
                if len(batch) >= batch_size:
                    accepted += conn.executemany('INSERT OR IGNORE INTO puzzles VALUES (' + ','.join('?'*14) + ')',batch).rowcount
                    batch.clear(); save_meta('importing')
            if batch:
                accepted += conn.executemany('INSERT OR IGNORE INTO puzzles VALUES (' + ','.join('?'*14) + ')',batch).rowcount
            save_meta('ready')
            conn.execute('PRAGMA optimize')
    except Exception:
        with bank_connection(True) as conn:
            init_bank(conn)
            conn.execute('INSERT OR REPLACE INTO bank_meta VALUES(?,?)',('status',json.dumps('error')))
        raise
    finally:
        raw.close()
    return {'processed': processed, 'imported': accepted, 'rejected': rejected, 'elapsed_seconds': round(time.time()-started,1)}
