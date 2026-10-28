"""Derived study metadata, invalidated by SQLite triggers for every PGN writer.

Cold backfills parse outside the writer transaction and install bounded batches
with a source-content check. Warm list reads never load PGNs or write bookmarks.
"""
from __future__ import annotations

import hashlib
import io
import chess
import chess.pgn
import json
import re
import unicodedata
from datetime import datetime

from fastapi import HTTPException
import db
import pgnlib
import reference_queries
import game_search
from entry_content import entry_revision as revision

BATCH_SIZE = 50
MAX_PREPARE = 2000
SEARCH_VERSION = 1
SEARCH_COLUMNS = {
    'event': 'TEXT', 'round': 'TEXT', 'opening': 'TEXT', 'eco': 'TEXT',
    'date_start': 'INTEGER', 'date_end': 'INTEGER', 'speed': 'TEXT',
    'player_key_white': 'TEXT', 'player_key_black': 'TEXT', 'event_key': 'TEXT',
    'search_version': 'INTEGER NOT NULL DEFAULT 0',
}
SCHEMA = '''
CREATE TABLE IF NOT EXISTS entry_catalog (
 entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
 pgn_digest TEXT NOT NULL, revision TEXT NOT NULL, headers TEXT NOT NULL,
 root_fen TEXT NOT NULL, moves TEXT NOT NULL, pgn_bytes INTEGER NOT NULL,
 search_text TEXT NOT NULL, game_date TEXT, played_day INTEGER, played_seconds INTEGER,
 white TEXT, black TEXT, white_elo INTEGER, black_elo INTEGER,
 result TEXT, timecontrol TEXT, site TEXT, title_key TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS catalog_date ON entry_catalog(game_date,entry_id);
CREATE INDEX IF NOT EXISTS catalog_white ON entry_catalog(white,entry_id);
CREATE INDEX IF NOT EXISTS catalog_black ON entry_catalog(black,entry_id);
CREATE TRIGGER IF NOT EXISTS catalog_content_changed AFTER UPDATE OF pgn,title,start_path ON entries
 WHEN OLD.pgn IS NOT NEW.pgn OR OLD.title IS NOT NEW.title OR OLD.start_path IS NOT NEW.start_path
 BEGIN DELETE FROM entry_catalog WHERE entry_id=NEW.id; END;
'''


def init_schema(conn):
    # execute one statement at a time: executescript would commit caller state.
    for statement in SCHEMA.split('CREATE '):
        if statement.strip():
            conn.execute('CREATE ' + statement.strip())
    existing = {row[1] for row in conn.execute('PRAGMA table_info(entry_catalog)')}
    for name, declaration in SEARCH_COLUMNS.items():
        if name not in existing:
            conn.execute('ALTER TABLE entry_catalog ADD COLUMN ' + name + ' ' + declaration)
    conn.execute('CREATE INDEX IF NOT EXISTS catalog_search_version ON entry_catalog(search_version,entry_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS catalog_player_key_white ON entry_catalog(player_key_white,entry_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS catalog_player_key_black ON entry_catalog(player_key_black,entry_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS catalog_event_key ON entry_catalog(event_key,entry_id)')


def fold(value):
    return ''.join(c for c in unicodedata.normalize('NFD', str(value or ''))
                   if not unicodedata.combining(c)).casefold()


def _search_projection(headers):
    value = game_search.project_headers(headers)
    # Preserve the existing table sort: unfinished/unknown results stay last.
    if value['result'] in ('', '?', '*', None):
        value['result'] = None
    return value


def derived(row, game=None):
    try:
        game = game or pgnlib.load_game(row['pgn'])
    except (ValueError, TypeError, IndexError, KeyError, RecursionError):
        # Keep malformed legacy records visible; derived metadata does not make
        # them legal for analysis/explorer, whose parsers still reject them.
        game = None
    headers = dict(game.headers if game is not None else chess.pgn.read_headers(io.StringIO(row['pgn'])) or {})
    day, seconds = None, -1
    for tag in ('UTCDate', 'Date'):
        try:
            day = datetime.strptime(headers.get(tag, ''), '%Y.%m.%d').date().toordinal()
            break
        except ValueError:
            pass
    for tag in ('UTCTime', 'StartTime', 'Time'):
        try:
            value = datetime.strptime(headers.get(tag, ''), '%H:%M:%S')
            seconds = value.hour * 3600 + value.minute * 60 + value.second
            break
        except ValueError:
            pass
    date = headers.get('Date', '')
    if not re.fullmatch(r'[1-9]\d{3}\.(?:\d{2}|\?\?)\.(?:\d{2}|\?\?)', date):
        date = None
    if date and (date[5:7] != '??' and not 1 <= int(date[5:7]) <= 12 or date[8:10] != '??' and not 1 <= int(date[8:10]) <= 31):
        date = None
    def text(key):
        value = headers.get(key, '')
        return fold(value) if value and value not in ('?', '*') else None
    return dict(entry_id=row['id'], pgn_digest=hashlib.sha256(row['pgn'].encode()).hexdigest(),
        revision=revision(row), headers=json.dumps(headers, ensure_ascii=False),
        root_fen=game.board().fen() if game is not None else chess.STARTING_FEN, moves=json.dumps([m.uci() for m in game.mainline_moves()] if game is not None else []),
        pgn_bytes=len(row['pgn'].encode()), search_text=fold(' '.join([row['title'], *headers.values()])),
        game_date=date, played_day=day, played_seconds=seconds,
        timecontrol=text('TimeControl'), title_key=fold(row['title']),
        **_search_projection(headers), search_version=SEARCH_VERSION)


def save(conn, value):
    fields=','.join(value)
    conn.execute('INSERT OR REPLACE INTO entry_catalog ('+fields+') VALUES ('+','.join('?' for _ in value)+')', tuple(value.values()))


def get(conn, row, game=None, *, persist=True):
    value = conn.execute('SELECT * FROM entry_catalog WHERE entry_id=?', (row['id'],)).fetchone()
    if value is None:
        value = derived(row, game)
        if persist:
            save(conn, value)
    return dict(value)


def prepare(*, base_ids=None, entry_id=None, played=False):
    """Install missing summaries only; never open a reference store."""
    _prepare_search(base_ids=base_ids, entry_id=entry_id, played=played)
    filters=['c.entry_id IS NULL', 'NOT EXISTS(SELECT 1 FROM reference_bases r WHERE r.base_id=e.base_id)']
    values=[]
    if base_ids is not None:
        ids=list(base_ids)
        if not ids: return
        filters.append('e.base_id IN ('+','.join('?' for _ in ids)+')'); values.extend(ids)
    if entry_id is not None:
        filters.append('e.id=?'); values.append(entry_id)
    if played: filters.append("json_extract(b.settings,'$.played')=1")
    processed=0
    while processed<MAX_PREPARE:
        reference_queries.check()
        with db.get_conn() as conn:
            rows=[dict(row) for row in conn.execute('SELECT e.* FROM entries e JOIN bases b ON b.id=e.base_id LEFT JOIN entry_catalog c ON c.entry_id=e.id WHERE '+' AND '.join(filters)+' ORDER BY e.id LIMIT ?', [*values,BATCH_SIZE])]
        if not rows: return
        prepared=[(row,derived(row)) for row in rows]
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            for row,value in prepared:
                current=conn.execute('SELECT pgn,title,start_path FROM entries WHERE id=?',(row['id'],)).fetchone()
                if current and all(current[key]==row[key] for key in ('pgn','title','start_path')):
                    save(conn,value)
        processed+=len(rows)
    with db.get_conn() as conn:
        pending=conn.execute('SELECT 1 FROM entries e JOIN bases b ON b.id=e.base_id LEFT JOIN entry_catalog c ON c.entry_id=e.id WHERE '+' AND '.join(filters)+' LIMIT 1',values).fetchone()
    if pending:
        raise HTTPException(503,'Préparation des résumés en cours. Réessaie dans un instant.', headers={'Retry-After':'1','X-ChessGym-Reason':'catalog-preparing'})


def _prepare_search(*, base_ids=None, entry_id=None, played=False):
    """Upgrade cached headers in bounded batches, without reparsing any PGN."""
    clauses = ['c.search_version<?']; params = [SEARCH_VERSION]
    if base_ids is not None:
        ids = list(base_ids)
        if not ids:
            return
        clauses.append('e.base_id IN (' + ','.join('?' for _ in ids) + ')'); params.extend(ids)
    if entry_id is not None:
        clauses.append('e.id=?'); params.append(entry_id)
    if played:
        clauses.append("json_extract(b.settings,'$.played')=1")
    source = ' FROM entry_catalog c JOIN entries e ON e.id=c.entry_id JOIN bases b ON b.id=e.base_id WHERE ' + ' AND '.join(clauses)
    processed = 0
    while processed < MAX_PREPARE:
        reference_queries.check()
        with db.get_conn() as conn:
            rows = conn.execute('SELECT c.entry_id,c.headers' + source + ' ORDER BY c.entry_id LIMIT ?', [*params, BATCH_SIZE]).fetchall()
        if not rows:
            return
        prepared = [(row, _search_projection(json.loads(row['headers']))) for row in rows]
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            for row, value in prepared:
                value['search_version'] = SEARCH_VERSION
                conn.execute('UPDATE entry_catalog SET ' + ','.join(key + '=?' for key in value)
                             + ' WHERE entry_id=? AND headers=? AND search_version<?',
                             [*value.values(), row['entry_id'], row['headers'], SEARCH_VERSION])
        processed += len(rows)
    with db.get_conn() as conn:
        pending = conn.execute('SELECT 1' + source + ' LIMIT 1', params).fetchone()
    if pending:
        raise HTTPException(503, 'Préparation de la recherche avancée en cours. Réessaie dans un instant.',
                            headers={'Retry-After': '1', 'X-ChessGym-Reason': 'catalog-preparing'})


def search_columns(alias='c'):
    columns = {key: alias + '.' + key for key in game_search.project_headers({})}
    columns['result'] = "coalesce(" + alias + ".result,'*')"
    return columns


def page(*, base_id=None, played=False, offset=0, limit=None, search='', inclusion='all', sort=None, descending=None, around_id=None, advanced=None):
    if type(offset) is not int or offset<0 or limit is not None and (type(limit) is not int or not 1<=limit<=200):
        raise ValueError('Pagination invalide.')
    if not isinstance(search,str) or len(search)>200 or inclusion not in ('all','included','excluded'):
        raise ValueError('Filtres de liste invalides.')
    if around_id is not None and (type(around_id) is not int or around_id<1): raise ValueError('Partie invalide.')
    if advanced is None:
        advanced = game_search.AdvancedGameSearch()
    elif not isinstance(advanced, game_search.AdvancedGameSearch):
        advanced = game_search.AdvancedGameSearch(**advanced)
    sort=sort or ('played' if played else 'added')
    descending=(played or base_id is None) if descending is None else descending
    sorts={'added':'e.created_at','updated':'e.updated_at','date':'c.game_date','title':'c.title_key',
        'white':'c.white','black':'c.black','whiteElo':'c.white_elo','blackElo':'c.black_elo',
        'result':'c.result','timecontrol':'c.timecontrol','site':'c.site','review':'e.selected','played':'c.played_day'}
    if sort not in sorts: raise ValueError('Tri inconnu.')
    prepare(base_ids=[base_id] if base_id is not None else None,played=played)
    scope=['NOT EXISTS(SELECT 1 FROM reference_bases r WHERE r.base_id=e.base_id)']; params=[]
    if base_id is not None: scope.append('e.base_id=?');params.append(base_id)
    if played: scope.append("json_extract(b.settings,'$.played')=1")
    clauses=list(scope); filtered=list(params)
    if inclusion!='all':clauses.append('e.selected=?');filtered.append(int(inclusion=='included'))
    for term in fold(search).split(): clauses.append('instr(c.search_text,?)>0');filtered.append(term)
    advanced_clauses, advanced_values = advanced.sql(search_columns())
    clauses.extend(advanced_clauses); filtered.extend(advanced_values)
    where=' WHERE '+' AND '.join(clauses)
    source=' FROM entries e JOIN bases b ON b.id=e.base_id JOIN entry_catalog c ON c.entry_id=e.id'
    direction='DESC' if descending else 'ASC'; column=sorts[sort]
    order=f'{column} IS NULL ASC,{column} {direction},'
    if sort=='played':order+=f'c.played_seconds {direction},e.created_at {direction},'
    order+=f'e.id {direction}'
    with db.get_conn() as conn:
        conn.execute('BEGIN')
        if base_id is not None and not conn.execute('SELECT 1 FROM bases WHERE id=?',(base_id,)).fetchone():raise HTTPException(404,'Cette base est introuvable.')
        if conn.execute('SELECT 1 FROM entries e JOIN bases b ON b.id=e.base_id LEFT JOIN entry_catalog c ON c.entry_id=e.id WHERE '+ ' AND '.join(scope) + ' AND c.entry_id IS NULL LIMIT 1',params).fetchone():
            raise HTTPException(503,'La bibliothèque vient de changer. Actualise la liste.',headers={'Retry-After':'1','X-ChessGym-Reason':'catalog-changed'})
        total_all,selected_total=conn.execute('SELECT count(*),coalesce(sum(e.selected),0)'+source+' WHERE '+' AND '.join(scope),params).fetchone()
        total=conn.execute('SELECT count(*)'+source+where,filtered).fetchone()[0]
        context={}
        if around_id is not None:
            around=conn.execute('SELECT * FROM (SELECT e.id,row_number() OVER (ORDER BY '+order+')-1 AS idx,lag(e.id) OVER (ORDER BY '+order+') AS previous_id,lead(e.id) OVER (ORDER BY '+order+') AS next_id'+source+where+') WHERE id=?', [*filtered,around_id]).fetchone()
            context={'around_found':around is not None,'index':around['idx'] if around else None,'previous_id':around['previous_id'] if around else None,'next_id':around['next_id'] if around else None}
            if around is not None and limit:offset=around['idx']//limit*limit
        query='SELECT e.id,e.base_id,e.title,e.selected,e.start_path,e.created_at,e.updated_at,e.seen_at,c.revision,c.headers,c.pgn_digest,c.root_fen,c.moves,b.settings AS base_settings'+source+where+' ORDER BY '+order
        rows=conn.execute(query+(' LIMIT ? OFFSET ?' if limit else ''),[*filtered,limit,offset] if limit else filtered).fetchall()
        import reading_progress
        entries=[]
        for row in rows:
            item=dict(row);settings=json.loads(item.pop('base_settings'));derived_fields={key:item.pop(key) for key in ('pgn_digest','root_fen','moves')}
            item['headers']=json.loads(item['headers']);item['selected']=bool(item['selected']);item['is_new']=item['seen_at'] is None
            item['reading']=reading_progress.catalog_summary(conn,item,derived_fields,enabled=bool(settings.get('reading_enabled')))
            entries.append(item)
    return dict(entries=entries,total=total,total_all=total_all,selected_total=selected_total,offset=offset,limit=limit,has_more=bool(limit and offset+len(entries)<total),**context)
