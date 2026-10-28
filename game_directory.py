"""Player/event directories built from PGN metadata, never external identities.

Reference directories use disposable disk snapshots so paging a large list does
not reaggregate its games. Original stores and study progress are never written.
"""
from datetime import date
import hashlib
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from fastapi import HTTPException

import db
import game_search
import reference_queries

VERSION = 1


def validate(kind='players', search='', offset=0, limit=50, sort='name', descending=False,
             player_key='', event_key=''):
    if kind not in ('players', 'events') or sort not in ('name', 'games', 'date'):
        raise HTTPException(422, 'Choisis la liste des joueurs ou des tournois et un tri valide.')
    if type(offset) is not int or offset < 0 or type(limit) is not int or not 1 <= limit <= 200:
        raise HTTPException(422, 'Pagination invalide.')
    if not isinstance(search, str) or len(search) > 200:
        raise HTTPException(422, 'La recherche est limitée à 200 caractères.')
    if type(descending) is not bool or not isinstance(player_key, str) or not isinstance(event_key, str) or len(player_key) > 2000 or len(event_key) > 6000:
        raise HTTPException(422, 'Sélection de joueur ou de tournoi invalide.')


def _aggregate(source, kind, player_key='', event_key=''):
    clauses, params = [], []
    if player_key:
        clauses.append('(player_key_white=? OR player_key_black=?)')
        params.extend((player_key, player_key))
    if event_key:
        clauses.append('event_key=?')
        params.append(event_key)
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    # Keep partial dates as recorded rather than inventing January 1 for years.
    raw_date = "CASE WHEN cg_date_start(json_extract(headers,'$.Date'),NULL) IS NOT NULL THEN json_extract(headers,'$.Date') ELSE json_extract(headers,'$.UTCDate') END"
    prefix = 'WITH records AS (' + source + '), population AS (SELECT *,' + raw_date + ' AS raw_date FROM records' + where + '), '
    occurrences = '''occurrences AS (
        SELECT id,player_key_white AS key,json_extract(headers,'$.White') AS name,
            white_elo AS elo,1 AS white,0 AS black,date_start,date_end,raw_date,event_key FROM population
        UNION ALL
        SELECT id,player_key_black,json_extract(headers,'$.Black'),black_elo,0,1,
            date_start,date_end,raw_date,event_key FROM population), '''
    first = "min(CASE WHEN date_start IS NOT NULL THEN printf('%08d|%s',date_start,raw_date) END)"
    last = "max(CASE WHEN date_end IS NOT NULL THEN printf('%08d|%s',date_end,raw_date) END)"
    if kind == 'players':
        query = prefix + occurrences + '''grouped AS (
            SELECT key,min(trim(name)) AS name,NULL AS site,NULL AS date,count(DISTINCT id) AS games,
                NULL AS players,sum(white) AS white_games,sum(black) AS black_games,
                min(elo) AS elo_min,max(elo) AS elo_max,''' + first + ' AS first_date,' + last + ''' AS last_date,
                max(date_end) AS date_sort FROM occurrences WHERE key NOT IN ('','?','*') GROUP BY key)
            SELECT *,cg_fold(name) AS name_key,cg_fold(name) AS search_text FROM grouped'''
    else:
        query = prefix + occurrences + '''participants AS (
            SELECT event_key,count(DISTINCT key) AS players FROM occurrences
            WHERE key NOT IN ('','?','*') GROUP BY event_key), grouped AS (
            SELECT event_key AS key,min(trim(json_extract(headers,'$.Event'))) AS name,
                min(trim(json_extract(headers,'$.Site'))) AS site,json_extract(event_key,'$[2]') AS date,
                count(*) AS games,NULL AS white_games,NULL AS black_games,NULL AS elo_min,NULL AS elo_max,
                ''' + first + ' AS first_date,' + last + ''' AS last_date,max(date_end) AS date_sort
            FROM population WHERE json_extract(event_key,'$[0]') NOT IN ('','?','*') GROUP BY event_key)
            SELECT grouped.*,coalesce(participants.players,0) AS players,cg_fold(name) AS name_key,
                cg_fold(name||' '||coalesce(site,'')||' '||coalesce(date,'')) AS search_text
            FROM grouped LEFT JOIN participants ON participants.event_key=grouped.key'''
    return query, params


def _page(conn, table, *, kind, search, offset, limit, sort, descending):
    clauses = ['instr(search_text,?)>0' for _ in game_search.fold(search).split()]
    params = game_search.fold(search).split()
    where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
    total = conn.execute('SELECT count(*) FROM ' + table + where, params).fetchone()[0]
    column = {'name': 'name_key', 'games': 'games', 'date': 'date_sort'}[sort]
    direction = 'DESC' if descending else 'ASC'
    rows = conn.execute('SELECT * FROM ' + table + where + f' ORDER BY {column} IS NULL,{column} {direction},key {direction} LIMIT ? OFFSET ?',
                        [*params, limit, offset]).fetchall()
    items = []
    for row in rows:
        item = dict(row)
        for field in ('first_date', 'last_date'):
            item[field] = item[field].split('|', 1)[1] if item[field] else None
        for field in ('name_key', 'search_text', 'date_sort'):
            item.pop(field, None)
        items.append(item)
    return dict(kind=kind, items=items, total=total, offset=offset, limit=limit, has_more=offset + len(items) < total)


def study_directory(base_id, kind='players', search='', offset=0, limit=50, sort='name', descending=False,
                    player_key='', event_key=''):
    validate(kind, search, offset, limit, sort, descending, player_key, event_key)
    import entry_catalog
    import reference_game_search
    with db.get_conn() as conn:
        if not conn.execute('SELECT 1 FROM bases WHERE id=?', (base_id,)).fetchone():
            raise HTTPException(404, 'Cette base est introuvable.')
        if conn.execute('SELECT 1 FROM reference_bases WHERE base_id=?', (base_id,)).fetchone():
            raise HTTPException(409, 'Utilise la liste de cette base de référence.')
    entry_catalog.prepare(base_ids=[base_id])
    source = '''SELECT e.id,c.headers,c.date_start,c.date_end,c.white_elo,c.black_elo,
        c.player_key_white,c.player_key_black,c.event_key FROM entries e
        JOIN entry_catalog c ON c.entry_id=e.id WHERE e.base_id=?'''
    query, params = _aggregate(source, kind, player_key, event_key)
    with db.get_conn() as conn:
        reference_game_search.install(conn)
        conn.execute('PRAGMA temp_store=FILE')
        conn.execute('BEGIN')
        if conn.execute('''SELECT 1 FROM entries e LEFT JOIN entry_catalog c ON c.entry_id=e.id
            WHERE e.base_id=? AND (c.entry_id IS NULL OR c.search_version<1) LIMIT 1''', (base_id,)).fetchone():
            raise HTTPException(503, 'La bibliothèque vient de changer. Actualise la liste.', headers={'X-ChessGym-Reason': 'catalog-changed', 'Retry-After': '1'})
        conn.execute('CREATE TEMP TABLE directory_items AS ' + query, [base_id, *params])
        return _page(conn, 'directory_items', kind=kind, search=search, offset=offset, limit=limit, sort=sort, descending=descending)


def _reference_snapshot(path, kind, player_key, event_key):
    import reference_store
    import reference_game_search
    path = Path(path).resolve()
    cache_dir = db.DATA_DIR / 'directory-cache'
    cache_dir.mkdir(parents=True, exist_ok=True)
    stat = path.stat()
    owner = hashlib.sha256(str(path).encode()).hexdigest()[:16]
    temporary = cache_dir / ('cgdir-' + owner + '-' + uuid4().hex + '.tmp')
    try:
        with reference_store._connect(path, readonly=True) as conn:
            reference_game_search.install(conn)
            conn.execute('PRAGMA temp_store=FILE')
            conn.execute('BEGIN')
            totals = reference_store._get_meta(conn, 'totals')
            identity = [VERSION, str(path), stat.st_ino, stat.st_ctime_ns, totals, kind, player_key, event_key]
            digest = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
            cached = cache_dir / ('cgdir-' + owner + '-' + digest + '.sqlite3')
            if cached.exists():
                return cached
            fields = reference_game_search.columns()
            source = 'SELECT g.id,g.headers,' + ','.join(fields[name] + ' AS ' + name for name in
                ('date_start','date_end','white_elo','black_elo','player_key_white','player_key_black','event_key')) + ' FROM games g'
            query, params = _aggregate(source, kind, player_key, event_key)
            conn.execute('ATTACH DATABASE ? AS directory_build', (str(temporary),))
            conn.execute('CREATE TABLE directory_build.items AS ' + query, params)
            conn.execute('CREATE INDEX directory_build.directory_names ON items(name_key,key)')
            conn.execute('CREATE INDEX directory_build.directory_games ON items(games,key)')
            conn.execute('CREATE INDEX directory_build.directory_dates ON items(date_sort,key)')
            reference_queries.check()
        temporary.replace(cached)
        # Only disposable, self-owned files are rotated; references never move.
        owned = sorted(cache_dir.glob('cgdir-' + owner + '-*.sqlite3'), key=lambda item: item.stat().st_mtime_ns, reverse=True)
        for obsolete in owned[12:]:
            try:
                obsolete.unlink()
            except OSError:
                pass  # An active Windows reader may still own the old snapshot.
        return cached
    finally:
        if temporary.exists():
            temporary.unlink()


def reference_directory(path, kind='players', search='', offset=0, limit=50, sort='name', descending=False,
                        player_key='', event_key=''):
    validate(kind, search, offset, limit, sort, descending, player_key, event_key)
    snapshot = _reference_snapshot(path, kind, player_key, event_key)
    conn = sqlite3.connect(snapshot.as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    guard = reference_queries.attach(conn)
    try:
        return _page(conn, 'items', kind=kind, search=search, offset=offset, limit=limit, sort=sort, descending=descending)
    finally:
        if guard:
            guard.detach(conn)
        conn.close()
