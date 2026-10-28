"""Server-authoritative puzzle attempts, personal rating, filters and Storm."""
from __future__ import annotations
from datetime import datetime, timezone
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
import json
import hashlib
import math
import sqlite3
from pathlib import Path
import threading
import time
import uuid

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict

import db
import training_native
import puzzle_store
import puzzle_rating
import storm_rules
from accounts_api import require_user

router = APIRouter(prefix='/api/puzzles', dependencies=[Depends(require_user)])
_import_lock = threading.Lock()
COPY_SETTINGS={'classic':'auto_copy_base_id','storm':'storm_auto_copy_base_id'}
_storm_prefetch_enabled=True
_storm_prefetch_pool=ThreadPoolExecutor(max_workers=2,thread_name_prefix='storm-prefetch')
_storm_prefetch_slots=threading.BoundedSemaphore(4)
_storm_prefetch_lock=threading.Lock()
_storm_prefetch=OrderedDict()


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def init_puzzles():
    with db.get_conn() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS puzzle_profile (
          id INTEGER PRIMARY KEY CHECK(id=1), rating REAL NOT NULL DEFAULT 1500,
          rated_count INTEGER NOT NULL DEFAULT 0, settings TEXT NOT NULL DEFAULT '{}');
        INSERT OR IGNORE INTO puzzle_profile(id) VALUES(1);
        CREATE TABLE IF NOT EXISTS puzzle_sets (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,filters TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS puzzle_attempts (
          id TEXT PRIMARY KEY, puzzle_id TEXT NOT NULL, mode TEXT NOT NULL, session_id TEXT,
          snapshot TEXT NOT NULL, fen TEXT NOT NULL, next_index INTEGER NOT NULL DEFAULT 0,
          version INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
          failed INTEGER NOT NULL DEFAULT 0, hints INTEGER NOT NULL DEFAULT 0,
          rated INTEGER NOT NULL, rating_before REAL, rating_after REAL,
          started_at TEXT NOT NULL, started_ms INTEGER NOT NULL, finished_at TEXT,
          elapsed_ms INTEGER NOT NULL DEFAULT 0, copy_base_id INTEGER REFERENCES bases(id) ON DELETE SET NULL,
          copied_entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL);
        CREATE INDEX IF NOT EXISTS puzzle_attempts_history ON puzzle_attempts(started_ms DESC,id);
        CREATE INDEX IF NOT EXISTS puzzle_attempts_by_puzzle ON puzzle_attempts(puzzle_id,failed);
        CREATE TABLE IF NOT EXISTS puzzle_events (
          attempt_id TEXT NOT NULL REFERENCES puzzle_attempts(id) ON DELETE CASCADE,
          request_id TEXT NOT NULL, ordinal INTEGER NOT NULL, move TEXT, san TEXT,
          correct INTEGER, hint INTEGER NOT NULL DEFAULT 0, fen TEXT NOT NULL,
          elapsed_ms INTEGER NOT NULL, response TEXT NOT NULL,
          PRIMARY KEY(attempt_id,request_id));
        CREATE TABLE IF NOT EXISTS puzzle_copies (
          puzzle_id TEXT NOT NULL, base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
          entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
          PRIMARY KEY(puzzle_id,base_id));
        CREATE TABLE IF NOT EXISTS puzzle_storm (
          id TEXT PRIMARY KEY, started_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active', color TEXT NOT NULL,
          score INTEGER NOT NULL DEFAULT 0, combo INTEGER NOT NULL DEFAULT 0,
          best_combo INTEGER NOT NULL DEFAULT 0, mistakes INTEGER NOT NULL DEFAULT 0,
          solved_rating INTEGER NOT NULL DEFAULT 0, current_attempt TEXT,
          finished_at TEXT);
        ''')
        puzzle_rating.init_profile(conn, 'puzzle_profile')
        attempt_columns={row['name'] for row in conn.execute('PRAGMA table_info(puzzle_attempts)')}
        if 'rating_deviation_after' not in attempt_columns:
            conn.execute('ALTER TABLE puzzle_attempts ADD COLUMN rating_deviation_after REAL')
        columns={row['name'] for row in conn.execute('PRAGMA table_info(puzzle_storm)')}
        for name,definition in [('configuration_key',"TEXT NOT NULL DEFAULT 'standard'"),
                                ('configuration_name',"TEXT NOT NULL DEFAULT 'Standard'"),
                                ('filters','TEXT'),
                                ('clock_started','INTEGER NOT NULL DEFAULT 1')]:
            if name not in columns:
                conn.execute('ALTER TABLE puzzle_storm ADD COLUMN '+name+' '+definition)
        conn.execute('CREATE INDEX IF NOT EXISTS puzzle_storm_configuration ON puzzle_storm(configuration_key,status,started_ms)')


class Filters(BaseModel):
    model_config = ConfigDict(extra='forbid')
    rating_min: int = Field(0,ge=0,le=4000)
    rating_max: int = Field(4000,ge=0,le=4000)
    themes: list[str] = Field(default_factory=list,max_length=12)
    opening: str = Field('',max_length=120)
    color: str = 'any'
    solution_min: int = Field(1,ge=1,le=100)
    solution_max: int = Field(100,ge=1,le=100)
    history: str = 'all'

    def checked(self):
        if self.rating_min > self.rating_max or self.solution_min > self.solution_max or self.color not in ('any','white','black') or self.history not in ('all','unseen','failed'):
            raise HTTPException(422,'Les filtres de puzzles ne sont pas valides.')
        if any(len(theme)>60 or not theme.replace('_','').isalnum() for theme in self.themes):
            raise HTTPException(422,'Les thèmes de puzzles ne sont pas valides.')
        result=self.model_dump()
        result['themes']=sorted(set(result['themes']))
        result['opening']=result['opening'].strip()
        return result


class StartAttempt(BaseModel):
    training_run_id: str | None = Field(None, min_length=8, max_length=160)
    request_id: str | None = Field(None, min_length=8, max_length=160)
    model_config=ConfigDict(extra='forbid')
    filters: Filters = Field(default_factory=Filters)
    rated: bool = True
    puzzle_id: str | None = Field(None,max_length=20)


class StormRequest(BaseModel):
    training_run_id: str | None = Field(None, min_length=8, max_length=160)
    request_id: str | None = Field(None, min_length=8, max_length=160)
    model_config=ConfigDict(extra='forbid')
    filters: Filters | None = None
    set_name: str | None = Field(None,max_length=100)


def _storm_configuration(payload=None):
    if payload is None or payload.filters is None:
        return {'key':'standard','name':'Standard','filters':None}
    filters=payload.filters.checked()
    canonical=json.dumps(filters,sort_keys=True,separators=(',',':'),ensure_ascii=False)
    key='custom:'+hashlib.sha256(canonical.encode('utf-8')).hexdigest()[:24]
    return {'key':key,'name':(payload.set_name or '').strip() or 'Personnalisée','filters':filters}


def _storm_description(row):
    key=row['configuration_key']
    raw=row['filters']
    return {'key':key,'name':row['configuration_name'] or ('Standard' if key=='standard' else 'Personnalisée'),
            'filters':json.loads(raw) if isinstance(raw,str) else raw,'custom':key!='standard'}


def _storm_records(conn):
    result=dict(conn.execute("SELECT COALESCE(MAX(score),0) best,COUNT(*) sessions FROM puzzle_storm WHERE status='completed' AND configuration_key='standard'").fetchone())
    result['total_sessions']=conn.execute("SELECT COUNT(*) FROM puzzle_storm WHERE status='completed'").fetchone()[0]
    records=[]
    for aggregate in conn.execute("SELECT configuration_key,MAX(score) best,COUNT(*) sessions FROM puzzle_storm WHERE status='completed' GROUP BY configuration_key ORDER BY MAX(started_ms) DESC").fetchall():
        latest=conn.execute("SELECT configuration_key,configuration_name,filters FROM puzzle_storm WHERE configuration_key=? AND status='completed' ORDER BY started_ms DESC,id DESC LIMIT 1",(aggregate['configuration_key'],)).fetchone()
        records.append({**_storm_description(latest),'best':aggregate['best'],'sessions':aggregate['sessions']})
    if not any(record['key']=='standard' for record in records):
        records.append({'key':'standard','name':'Standard','filters':None,'custom':False,'best':0,'sessions':0})
    result['records']=records
    return result


class Action(BaseModel):
    model_config=ConfigDict(extra='forbid')
    request_id: str = Field(min_length=8,max_length=80)
    version: int = Field(ge=0)
    move: str | None = Field(None,max_length=12)
    advance_storm: bool = False


def _attempt(conn, attempt_id):
    row=conn.execute('SELECT * FROM puzzle_attempts WHERE id=?',(attempt_id,)).fetchone()
    if row is None:
        raise HTTPException(404,'Tentative introuvable.')
    value = dict(row)
    value['training_run_id'] = training_native.run_id(conn, 1, 'storm' if value['mode'] == 'storm' else 'puzzles', value['session_id'] if value['mode'] == 'storm' else value['id'])
    return value


def _puzzle(attempt):
    return json.loads(attempt['snapshot'])


def _positions(puzzle, count):
    board=chess.Board(puzzle['start_fen']); positions=[]
    for uci in puzzle['solution'][:count]:
        move=chess.Move.from_uci(uci); san=board.san(move);board.push(move)
        positions.append({'uci':uci,'san':san,'fen':board.fen()})
    return positions


def _public(attempt, *, include_solution=False):
    p=_puzzle(attempt)
    result={key:attempt[key] for key in ('id','puzzle_id','mode','session_id','fen','version','status','failed','hints','rated','rating_before','rating_after','started_at','elapsed_ms','copied_entry_id')}
    result['training_run_id'] = attempt.get('training_run_id')
    if attempt.get('rating_deviation_after') is not None:
        result['rating_deviation'] = attempt['rating_deviation_after']
        result['provisional'] = attempt['rating_deviation_after'] >= puzzle_rating.PROVISIONAL_DEVIATION
    result.update(start_fen=p['start_fen'],color=p['color'],positions=_positions(p,attempt['next_index']),
        rating=p['rating'],themes=p['themes'],opening_tags=p['opening_tags'],game_url=p['game_url'])
    board=chess.Board(attempt['fen'])
    result['legal']={'fen':attempt['fen'],'moves':[move.uci() for move in board.legal_moves],
                     'game_over':board.is_game_over(),'result':board.result()}
    if include_solution or attempt['status']!='active':
        result['solution']=p['solution'];result['solution_pgn']=_solution_pgn(p)
        result['pgn']=_pgn(p,attempt)
    return result


def _pgn(puzzle, attempt=None, conn=None):
    board=chess.Board(puzzle['start_fen'])
    game=chess.pgn.Game();game.setup(board)
    game.headers.update(Event='Lichess puzzle '+puzzle['id'],Site='https://lichess.org/training/'+puzzle['id'],PuzzleId=puzzle['id'],PuzzleRating=str(puzzle['rating']),Result='*')
    game.comment=' '.join(puzzle['themes'])
    node=game; nodes={board.fen():game}
    for uci in puzzle['solution']:
        node=node.add_variation(chess.Move.from_uci(uci));nodes[node.board().fen()]=node
    if conn is not None and attempt:
        for event in conn.execute('SELECT * FROM puzzle_events WHERE attempt_id=? ORDER BY ordinal',(attempt['id'],)):
            if event['correct']==0 and event['move'] and event['fen'] in nodes:
                parent=nodes[event['fen']];move=chess.Move.from_uci(event['move'])
                if move in parent.board().legal_moves:
                    alternate=parent.add_variation(move);alternate.nags.add(chess.pgn.NAG_MISTAKE);alternate.comment='Puzzle attempt'
    return str(game)


def _solution_pgn(puzzle):
    # The saved bank sequence remains available in old snapshots too. Keep the
    # source solution separate from an equivalent mate accepted during play.
    original=puzzle.get('original_solution')
    if original is None:
        moves=puzzle.get('moves',[])
        if isinstance(moves,str):moves=moves.split()
        original=moves[1:] if len(moves)>=2 else puzzle['solution']
    return _pgn({**puzzle,'solution':original})


def _validate_base(conn,base_id):
    if base_id is None:return
    if conn.execute('SELECT 1 FROM bases WHERE id=?',(base_id,)).fetchone() is None or conn.execute('SELECT 1 FROM reference_bases WHERE base_id=?',(base_id,)).fetchone():
        raise HTTPException(422,'Choisis une base d’étude pour les puzzles échoués.')


def _copy_failed(conn,a):
    if not a.get('copy_base_id') or not a['failed']:return
    p=_puzzle(a);base_id=a['copy_base_id']
    found=conn.execute('SELECT entry_id FROM puzzle_copies WHERE puzzle_id=? AND base_id=?',(p['id'],base_id)).fetchone()
    if found:
        entry_id=found['entry_id']
    else:
        stamp_value=stamp()
        result=conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
            (base_id,'Lichess '+p['id']+' · '+str(p['rating']),_solution_pgn(p),stamp_value,stamp_value))
        entry_id=result.lastrowid
        conn.execute('INSERT INTO puzzle_copies VALUES(?,?,?)',(p['id'],base_id,entry_id))
    a['copied_entry_id']=entry_id
    conn.execute('UPDATE puzzle_attempts SET copied_entry_id=? WHERE id=?',(entry_id,a['id']))


def _grade(conn,a,success):
    if not a['rated'] or a['mode']!='classic' or a['rating_after'] is not None:return
    profile=conn.execute('SELECT * FROM puzzle_profile WHERE id=1').fetchone()
    rating=profile['rating'];p=_puzzle(a)
    updated=puzzle_rating.rate_puzzle(profile,p['rating'],success,
        opponent_rd=p.get('rating_deviation',puzzle_rating.MIN_DEVIATION),themes=p.get('rating_themes',()),minimum=100)
    a['rating_before']=rating;a['rating_after']=updated['rating']
    a['rating_deviation_after']=updated['rating_deviation']
    conn.execute('''UPDATE puzzle_profile SET rating=?,rating_deviation=?,volatility=?,last_rated_at=?,
                    rated_count=rated_count+1 WHERE id=1''',tuple(updated.values()))
    conn.execute('UPDATE puzzle_attempts SET rating_before=?,rating_after=?,rating_deviation_after=? WHERE id=?',
                 (a['rating_before'],a['rating_after'],a['rating_deviation_after'],a['id']))


def _save(conn,a):
    fields=('fen','next_index','version','status','failed','hints','finished_at','elapsed_ms','copied_entry_id')
    conn.execute('UPDATE puzzle_attempts SET '+','.join(k+'=?' for k in fields)+' WHERE id=?',[*[a.get(k) for k in fields],a['id']])
    training_native.puzzle(conn, a)


def _finish(conn,a,success=True):
    a['status']='completed' if success else 'revealed';a['finished_at']=stamp()
    a['elapsed_ms']=max(0,int(time.time()*1000)-a['started_ms'])
    _grade(conn,a,success and not a['failed'] and not a['hints'])
    _copy_failed(conn,a)


def _new_attempt(conn,puzzle,mode='classic',rated=True,session_id=None,rating_themes=()):
    try:
        p=puzzle_store.prepared_puzzle(puzzle)
    except (ValueError,AssertionError) as exc:
        raise HTTPException(422,'La solution de ce puzzle est invalide. Choisis un autre puzzle.') from exc
    p['rating_themes']=list(rating_themes)
    settings=json.loads(conn.execute('SELECT settings FROM puzzle_profile WHERE id=1').fetchone()[0])
    copy_id=settings.get(COPY_SETTINGS.get(mode))
    if copy_id is not None and (conn.execute('SELECT 1 FROM bases WHERE id=?',(copy_id,)).fetchone() is None or conn.execute('SELECT 1 FROM reference_bases WHERE base_id=?',(copy_id,)).fetchone()):
        copy_id=None
    a={'id':uuid.uuid4().hex,'puzzle_id':p['id'],'mode':mode,'session_id':session_id,'snapshot':json.dumps(p),'fen':p['start_fen'],
       'rated':int(rated),'started_at':stamp(),'started_ms':int(time.time()*1000),'copy_base_id':copy_id}
    keys=list(a)
    conn.execute('INSERT INTO puzzle_attempts('+','.join(keys)+') VALUES('+','.join('?' for _ in keys)+')',list(a.values()))
    return _attempt(conn,a['id'])


def _failed_candidates(conn,filters,exclude):
    deadline=time.monotonic()+4
    interrupted=lambda:int(time.monotonic()>deadline)
    conn.set_progress_handler(interrupted,10000)
    try:
        # Iterate the entire personal history in bounded batches. Applying a
        # fixed history LIMIT before bank filters hides older matching puzzles.
        cursor=conn.execute('SELECT puzzle_id FROM puzzle_attempts WHERE failed=1 GROUP BY puzzle_id ORDER BY MAX(started_ms) DESC,puzzle_id')
        with puzzle_store.bank_connection() as bank_conn:
            if bank_conn is None:return []
            bank_conn.set_progress_handler(interrupted,10000)
            try:
                while True:
                    if time.monotonic()>deadline:raise puzzle_store.PuzzleSelectionTimeout()
                    rows=cursor.fetchmany(400)
                    if not rows:break
                    ids=[row[0] for row in rows if row[0] not in exclude]
                    candidates={p['id']:p for p in puzzle_store.filter_puzzle_ids(bank_conn,ids,filters)}
                    for puzzle_id in ids:
                        p=candidates.get(puzzle_id)
                        if p is None:continue
                        try:return [puzzle_store.prepared_puzzle(p)]
                        except (ValueError,AssertionError):continue
            finally:
                bank_conn.set_progress_handler(None,0)
                cursor.close()
    except sqlite3.OperationalError as exc:
        if 'interrupted' not in str(exc):raise
        raise puzzle_store.PuzzleSelectionTimeout() from exc
    finally:
        conn.set_progress_handler(None,0)
    return []


def choose_puzzle(conn, filters, exclude_ids=()):
    exclude=set(exclude_ids)
    if filters.get('history')=='unseen':
        exclude.update(r[0] for r in conn.execute('SELECT DISTINCT puzzle_id FROM puzzle_attempts'))
    try:
        candidates=_failed_candidates(conn,filters,exclude) if filters.get('history')=='failed' else puzzle_store.search_puzzles(filters,limit=50,exclude_ids=exclude)
    except puzzle_store.PuzzleSelectionTimeout as exc:
        raise HTTPException(503,'La sélection de puzzles prend trop de temps. Réessaie ou précise les filtres.') from exc
    for p in candidates:
        if not filters.get('rating_min',0)<=p['rating']<=filters.get('rating_max',4000):continue
        try:return puzzle_store.prepared_puzzle(p)
        except (ValueError,AssertionError):continue
    raise HTTPException(404,'Aucun puzzle disponible pour cette sélection. Importe la banque ou élargis les filtres.')


@router.get('/overview')
def overview():
    with db.get_conn() as conn:
        profile=puzzle_rating.public_profile(conn.execute('SELECT * FROM puzzle_profile WHERE id=1').fetchone());profile['settings']=json.loads(profile['settings'])
        stats=dict(conn.execute("SELECT COUNT(*) attempts, SUM(CASE WHEN status='completed' AND failed=0 AND hints=0 THEN 1 ELSE 0 END) solved,SUM(failed) failed, SUM(elapsed_ms) elapsed_ms FROM puzzle_attempts WHERE mode='classic'").fetchone())
        sets=[{**dict(row),'filters':json.loads(row['filters'])} for row in conn.execute('SELECT * FROM puzzle_sets ORDER BY name')]
        active=conn.execute("SELECT * FROM puzzle_attempts WHERE mode='classic' AND status='active' ORDER BY started_ms DESC LIMIT 1").fetchone()
        active = _attempt(conn, active['id']) if active else None
        storm=_storm_records(conn)
    return {'bank':puzzle_store.bank_stats(),'profile':profile,'statistics':stats,'sets':sets,'storm':storm,'active':_public(active) if active else None}


@router.post('/attempts')
def start_attempt(payload:StartAttempt):
    filters=payload.filters.checked()
    with db.get_conn() as conn:
        rating=conn.execute('SELECT rating FROM puzzle_profile WHERE id=1').fetchone()[0]
        # An explicit replay never changes a rating; otherwise avoid the last puzzle.
        if payload.puzzle_id:
            p=puzzle_store.get_puzzle(payload.puzzle_id)
            if p is None:raise HTTPException(404,'Puzzle introuvable.')
            rated=False
        else:
            filters['target_rating']=rating
            recent=[r[0] for r in conn.execute('SELECT puzzle_id FROM puzzle_attempts ORDER BY started_ms DESC LIMIT 30')]
            try:p=choose_puzzle(conn,filters,recent)
            except HTTPException as exc:
                if exc.status_code!=404:raise
                p=choose_puzzle(conn,filters)
            rated=payload.rated
        conn.execute('BEGIN IMMEDIATE')
        active = [row['id'] for row in conn.execute("SELECT id FROM puzzle_attempts WHERE mode='classic' AND status='active'")]
        resumed = training_native.creation(conn, 1, 'puzzles', payload.training_run_id, payload.request_id, active_ids=active, request_payload=payload.model_dump())
        if resumed:
            return _public(_attempt(conn, resumed))
        # Leaving an unfinished rated attempt is recorded as a failed attempt.
        for row in conn.execute("SELECT * FROM puzzle_attempts WHERE mode='classic' AND status='active'").fetchall():
            old=dict(row);old['failed']=1;_finish(conn,old,False);_save(conn,old)
        attempt = _new_attempt(conn,p,rated=rated,rating_themes=filters['themes'])
        options = {'mode': 'classic', 'rated': bool(attempt['rated']), 'filters': payload.filters.checked(), 'selection': 'standard'}
        if payload.filters.checked() != Filters().checked():
            options['selection'] = 'custom'
        training_native.register(conn, 1, 'puzzles', attempt['id'], training_run_id=payload.training_run_id, request_id=payload.request_id, options=options, request_payload=payload.model_dump())
        return _public(_attempt(conn, attempt['id']))


def _storm_state(conn,session_id,expire=True):
    row=conn.execute('SELECT * FROM puzzle_storm WHERE id=?',(session_id,)).fetchone()
    if row is None:raise HTTPException(404,'Séance introuvable.')
    s=dict(row)
    s.update(_storm_description(row))
    del s['configuration_key'];del s['configuration_name']
    s['clock_started']=bool(s['clock_started'])
    s['inline_next']=True
    s['combo_progress']=storm_rules.combo_progress(s['combo'])
    s['training_run_id'] = training_native.run_id(conn, 1, 'storm', session_id)
    if expire and s['clock_started'] and s['status']=='active' and int(time.time()*1000)>=s['deadline_ms']:
        conn.execute("UPDATE puzzle_storm SET status='completed',finished_at=? WHERE id=?",(stamp(),s['id']))
        s['status']='completed'
        if s['current_attempt']:
            a=_attempt(conn,s['current_attempt'])
            if a['status']=='active':
                a['status']='expired';a['finished_at']=stamp();a['elapsed_ms']=max(0,s['deadline_ms']-a['started_ms']);_save(conn,a)
    s['remaining_ms']=(max(0,s['deadline_ms']-int(time.time()*1000)) if s['clock_started'] else 180000) if s['status']=='active' else 0
    training_native.storm(conn, s)
    return s


def _start_storm_clock(conn,attempt):
    """Start once, inside the transaction accepting the first legal move."""
    now_ms=int(time.time()*1000)
    changed=conn.execute("UPDATE puzzle_storm SET clock_started=1,started_ms=?,deadline_ms=? WHERE id=? AND clock_started=0 AND status='active'",
                         (now_ms,now_ms+180000,attempt['session_id'])).rowcount
    if changed:
        attempt['started_ms']=now_ms;attempt['started_at']=stamp();attempt['elapsed_ms']=0
        conn.execute('UPDATE puzzle_attempts SET started_ms=?,started_at=?,elapsed_ms=0 WHERE id=?',
                     (now_ms,attempt['started_at'],attempt['id']))


def _select_storm_puzzle(conn,s):
    exclusions=[r[0] for r in conn.execute('SELECT puzzle_id FROM puzzle_attempts WHERE session_id=?',(s['id'],))]
    custom=s.get('filters')
    index=s['score']+s['mistakes']
    if custom is None:
        if index>=storm_rules.RUN_SIZE:
            raise HTTPException(404,'La série de puzzles Storm est terminée.')
        filters={**storm_rules.rating_window(index),'color':s['color'],
                 'max_rating_deviation':85,'exclude_themes':['equality']}
        # Lichess presents the sampled set sorted by rating. Keep the local
        # sequence ordered too, including after a failed puzzle or a reload.
        if s.get('current_attempt'):
            previous=conn.execute('SELECT snapshot FROM puzzle_attempts WHERE id=?',(s['current_attempt'],)).fetchone()
            if previous:
                filters['rating_min']=min(filters['rating_max'],max(filters['rating_min'],json.loads(previous['snapshot'])['rating']))
        p=choose_puzzle(conn,filters,exclusions)
    else:
        filters=dict(custom)
        low,high=filters['rating_min'],filters['rating_max']
        filters.update(storm_rules.rating_window(index,low,high),color=s['color'])
        try:
            p=choose_puzzle(conn,filters,exclusions)
        except HTTPException as exc:
            if exc.status_code!=404:raise
            # Sparse sets may have no next puzzle in the progressive window.
            # Widen only inside the explicitly selected rating bounds.
            filters.update(rating_min=low,rating_max=high)
            p=choose_puzzle(conn,filters,exclusions)
    return p


def _storm_scope():
    return (str(Path(db.DB_PATH).resolve()),str(puzzle_store.bank_path().resolve()))


def _storm_prefetch_key(s):
    return (*_storm_scope(),s['id'],s['current_attempt'],s['score']+s['mistakes'])


def _prepare_storm_future(scope,s):
    # Background preparation is read-only. No attempt, timer or score exists
    # for this candidate until the ordinary move/next transaction activates it.
    if scope!=_storm_scope():return None
    conn=sqlite3.connect(Path(scope[0]).as_uri()+'?mode=ro',uri=True,timeout=2)
    conn.row_factory=sqlite3.Row
    try:
        conn.execute('PRAGMA query_only=ON')
        row=conn.execute('SELECT status,current_attempt FROM puzzle_storm WHERE id=?',(s['id'],)).fetchone()
        if row is None or row['status']!='active' or row['current_attempt']!=s['current_attempt']:return None
        puzzle=_select_storm_puzzle(conn,s)
        return puzzle if scope==_storm_scope() else None
    finally:conn.close()


def _schedule_storm_prefetch(result):
    if not _storm_prefetch_enabled:return
    s=result.get('storm')
    if not s or s['status']!='active':return
    a=result.get('next_attempt') or result.get('attempt')
    if not a or a['status']!='active' or a['id']!=s['current_attempt']:return
    scope=_storm_scope()
    # An idempotent replay may contain an older (now completed) next attempt.
    # It must not displace useful preparation for the actual current puzzle.
    try:
        with db.get_conn() as conn:
            live=conn.execute('SELECT status,current_attempt,score,mistakes FROM puzzle_storm WHERE id=?',(s['id'],)).fetchone()
        if live is None or live['status']!='active' or live['current_attempt']!=a['id'] or live['score']+live['mistakes']!=s['score']+s['mistakes']:return
    except sqlite3.Error:return
    with _storm_prefetch_lock:
        # Discard completed sessions/previous positions and bound both queued
        # work and retained results, even across a rapid sequence of restarts.
        for key in list(_storm_prefetch):
            if key[:2]!=scope or key[2]!=s['id'] or key[3]!=s['current_attempt']:
                _storm_prefetch.pop(key).cancel()
        # A success and a mistake both advance to the same next difficulty.
        candidate={**s,'score':s['score']+1}
        key=_storm_prefetch_key(candidate)
        if key not in _storm_prefetch and _storm_prefetch_slots.acquire(blocking=False):
            try:future=_storm_prefetch_pool.submit(_prepare_storm_future,scope,candidate)
            except RuntimeError:
                _storm_prefetch_slots.release()
            else:
                future.add_done_callback(lambda _future:_storm_prefetch_slots.release())
                _storm_prefetch[key]=future
        while len(_storm_prefetch)>16:
            _,future=_storm_prefetch.popitem(last=False);future.cancel()


def _take_storm_prefetch(conn,s):
    key=_storm_prefetch_key(s)
    with _storm_prefetch_lock:future=_storm_prefetch.pop(key,None)
    if future is None:return None
    if not future.done():
        future.cancel();return None
    try:p=future.result()
    except Exception:
        # This cache is only an optimization. A cancelled/failed background
        # job must never invalidate the player's accepted answer.
        return None
    if p is None:return None
    if conn.execute('SELECT 1 FROM puzzle_attempts WHERE session_id=? AND puzzle_id=? LIMIT 1',(s['id'],p['id'])).fetchone():return None
    history=(s.get('filters') or {}).get('history')
    if history=='unseen' and conn.execute('SELECT 1 FROM puzzle_attempts WHERE puzzle_id=? LIMIT 1',(p['id'],)).fetchone():return None
    if history=='failed' and not conn.execute('SELECT 1 FROM puzzle_attempts WHERE puzzle_id=? AND failed=1 LIMIT 1',(p['id'],)).fetchone():return None
    return p


def _storm_next(conn,s):
    start=time.monotonic();wall_start=int(time.time()*1000)
    try:
        p=_take_storm_prefetch(conn,s) or _select_storm_puzzle(conn,s)
        a=_new_attempt(conn,p,mode='storm',rated=False,session_id=s['id'])
        conn.execute('UPDATE puzzle_storm SET current_attempt=? WHERE id=?',(a['id'],s['id']))
        return a
    finally:
        # Charge thinking/user/network delays normally. Only computation in
        # this request is credited; repeated next calls never enter here.
        spent=max(0,min(int((time.monotonic()-start)*1000),int(time.time()*1000)-wall_start))
        if s['clock_started'] and spent:
            conn.execute("UPDATE puzzle_storm SET deadline_ms=deadline_ms+? WHERE id=? AND status='active'",(spent,s['id']))


def _advance_storm(conn,s):
    try:a=_storm_next(conn,s)
    except HTTPException as exc:
        if exc.status_code==404:
            conn.execute("UPDATE puzzle_storm SET status='completed',finished_at=? WHERE id=?",(stamp(),s['id']))
            return {'storm':_storm_state(conn,s['id']),'attempt':None,'exhausted':True}
        raise
    return {'storm':_storm_state(conn,s['id']),'attempt':_public(a)}


def _storm_update(conn,a,correct):
    s=_storm_state(conn,a['session_id'])
    if s['status']!='active':return s
    if correct:
        combo=s['combo']+1
        bonus=storm_rules.combo_bonus(combo)
        solved=int(a['status']=='completed')
        conn.execute('UPDATE puzzle_storm SET combo=?,best_combo=MAX(best_combo,?),deadline_ms=deadline_ms+?,score=score+?,solved_rating=MAX(solved_rating,?) WHERE id=?',
                     (combo,combo,bonus*1000,solved,_puzzle(a)['rating'] if solved else 0,s['id']))
    else:
        conn.execute('UPDATE puzzle_storm SET combo=0,mistakes=mistakes+1,deadline_ms=deadline_ms-10000 WHERE id=?',(s['id'],))
    result=_storm_state(conn,s['id'])
    result['time_delta_seconds']=bonus if correct else -10
    return result


def _act(attempt_id,payload,kind):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        a=_attempt(conn,attempt_id)
        previous=conn.execute('SELECT response FROM puzzle_events WHERE attempt_id=? AND request_id=?',(a['id'],payload.request_id)).fetchone()
        if previous:return json.loads(previous[0])
        if a['session_id'] and _storm_state(conn,a['session_id'])['status']!='active':
            return {'attempt':_public(_attempt(conn,a['id'])),'storm':_storm_state(conn,a['session_id']),'expired':True}
        if a['status']!='active':raise HTTPException(409,'Cette tentative est terminée.')
        if payload.version!=a['version']:raise HTTPException(409,'La position a changé. Recharge la tentative.')
        p=_puzzle(a);board=chess.Board(a['fen']);fen=board.fen();correct=None;san=None;uci=None
        a['elapsed_ms']=max(0,int(time.time()*1000)-a['started_ms'])
        if kind!='move':
            if a['mode']=='storm':raise HTTPException(422,'Les aides sont désactivées pendant Storm.')
            a['hints']+=1;a['failed']=1;_grade(conn,a,False);_copy_failed(conn,a)
            hint=board.san(chess.Move.from_uci(p['solution'][a['next_index']]))
            if kind=='reveal':_finish(conn,a,False)
        else:
            try:
                move=board.parse_uci(payload.move or '')
                san=board.san(move);uci=move.uci()
            except ValueError:raise HTTPException(422,'Ce coup est illégal dans la position actuelle.')
            if a['mode']=='storm':_start_storm_clock(conn,a)
            expected=p['solution'][a['next_index']]
            # Any immediate checkmate is a fully correct equivalent answer.
            alternate=board.copy();alternate.push(move)
            correct=uci==expected or alternate.is_checkmate()
            if correct:
                if uci!=expected:
                    p.setdefault('original_solution',list(p['solution']))
                    p['solution']=p['solution'][:a['next_index']]+[uci]
                    a['snapshot']=json.dumps(p)
                    conn.execute('UPDATE puzzle_attempts SET snapshot=? WHERE id=?',(a['snapshot'],a['id']))
                board.push(move);a['next_index']+=1
                if a['next_index']<len(p['solution']):
                    board.push_uci(p['solution'][a['next_index']]);a['next_index']+=1
                a['fen']=board.fen()
                if a['next_index']>=len(p['solution']):_finish(conn,a)
            else:
                a['failed']=1;_grade(conn,a,False);_copy_failed(conn,a)
                if a['mode']=='storm':_finish(conn,a,False)
        a['version']+=1;_save(conn,a)
        result={'attempt':_public(a),'correct':correct}
        if kind=='hint':result['hint']=hint
        if a['mode']=='storm':
            result['storm']=_storm_update(conn,a,correct)
            if payload.advance_storm and a['status']!='active':
                result['next_attempt']=None
                if result['storm']['status']=='active':
                    try:
                        advanced=_advance_storm(conn,result['storm'])
                        advanced['storm']['time_delta_seconds']=result['storm']['time_delta_seconds']
                        result['storm']=advanced['storm'];result['next_attempt']=advanced['attempt']
                        if advanced.get('exhausted'):result['exhausted']=True
                    except HTTPException as exc:
                        if exc.status_code!=503:raise
                        # Preserve the accepted answer and its request_id even
                        # if the optional next selection is temporarily busy.
                        result['next_error']={'status':exc.status_code,'message':exc.detail}
                        delta=result['storm']['time_delta_seconds']
                        result['storm']=_storm_state(conn,a['session_id'])
                        result['storm']['time_delta_seconds']=delta
        conn.execute('INSERT INTO puzzle_events VALUES(?,?,?,?,?,?,?,?,?,?)',
                     (a['id'],payload.request_id,a['version'],uci,san,correct,int(kind!='move'),fen,a['elapsed_ms'],json.dumps(result)))
        return result


@router.get('/attempts/{attempt_id}')
def attempt_detail(attempt_id:str):
    with db.get_conn() as conn:
        a=_attempt(conn,attempt_id);result=_public(a)
        result['events']=[dict(row) for row in conn.execute('SELECT ordinal,move,san,correct,hint,fen,elapsed_ms FROM puzzle_events WHERE attempt_id=? ORDER BY ordinal',(attempt_id,))]
        if a['status']!='active':result['pgn']=_pgn(_puzzle(a),a,conn)
        return result


@router.post('/attempts/{attempt_id}/move')
def play_move(attempt_id:str,payload:Action):
    result=_act(attempt_id,payload,'move')
    _schedule_storm_prefetch(result)
    return result
@router.post('/attempts/{attempt_id}/hint')
def get_hint(attempt_id:str,payload:Action):return _act(attempt_id,payload,'hint')
@router.post('/attempts/{attempt_id}/reveal')
def reveal(attempt_id:str,payload:Action):return _act(attempt_id,payload,'reveal')


@router.get('/history')
def history(offset:int=Query(0,ge=0),limit:int=Query(30,ge=1,le=100)):
    with db.get_conn() as conn:
        rows=[{**{k:row[k] for k in ('id','puzzle_id','mode','status','failed','hints','started_at','elapsed_ms','rating_before','rating_after')},'rating':json.loads(row['snapshot'])['rating']} for row in conn.execute('SELECT * FROM puzzle_attempts ORDER BY started_ms DESC LIMIT ? OFFSET ?',(limit,offset))]
        total=conn.execute('SELECT COUNT(*) FROM puzzle_attempts').fetchone()[0]
    return {'attempts':rows,'total':total}


@router.get('/statistics')
def statistics():
    with db.get_conn() as conn:
        ratings=[dict(r) for r in conn.execute('SELECT started_at,rating_after FROM puzzle_attempts WHERE rating_after IS NOT NULL ORDER BY started_ms DESC LIMIT 500')][::-1]
        days=[dict(r) for r in conn.execute("SELECT substr(started_at,1,10) day,COUNT(*) attempts,SUM(CASE WHEN status='completed' AND failed=0 AND hints=0 THEN 1 ELSE 0 END) solved,SUM(elapsed_ms) elapsed_ms FROM puzzle_attempts WHERE mode='classic' GROUP BY day ORDER BY day DESC LIMIT 90")]
        themes={}
        for row in conn.execute("SELECT snapshot,failed,status,hints FROM puzzle_attempts WHERE mode='classic' AND status!='active'"):
            for theme in json.loads(row['snapshot'])['themes']:
                item=themes.setdefault(theme,{'theme':theme,'attempts':0,'solved':0});item['attempts']+=1;item['solved']+=int(row['status']=='completed' and not row['failed'] and not row['hints'])
        storms=[]
        for row in conn.execute("SELECT id,score,best_combo,mistakes,solved_rating,finished_at,configuration_key,configuration_name,filters FROM puzzle_storm WHERE status='completed' ORDER BY started_ms DESC LIMIT 50"):
            item=dict(row);item.update(_storm_description(row));del item['configuration_key'];del item['configuration_name'];storms.append(item)
    return {'ratings':ratings,'days':days,'themes':list(themes.values()),'storms':storms}


class SetPayload(BaseModel):
    name:str=Field(min_length=1,max_length=100)
    filters:Filters
@router.post('/sets')
def save_set(payload:SetPayload):
    filters=payload.filters.checked()
    with db.get_conn() as conn:
        if conn.execute('SELECT COUNT(*) FROM puzzle_sets').fetchone()[0]>=100:raise HTTPException(422,'La limite de sélections enregistrées est atteinte.')
        cur=conn.execute('INSERT INTO puzzle_sets(name,filters) VALUES(?,?)',(payload.name,json.dumps(filters)))
    return {'id':cur.lastrowid,'name':payload.name,'filters':filters}
@router.delete('/sets/{set_id}')
def delete_set(set_id:int):
    with db.get_conn() as conn:conn.execute('DELETE FROM puzzle_sets WHERE id=?',(set_id,))
    return {'ok':True}

class SettingsPayload(BaseModel):
    model_config=ConfigDict(extra='forbid')
    auto_copy_base_id:int|None=Field(None,gt=0,le=9223372036854775807)
    storm_auto_copy_base_id:int|None=Field(None,gt=0,le=9223372036854775807)
@router.put('/settings')
def update_settings(payload:SettingsPayload):
    changes=payload.model_dump(exclude_unset=True)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        for destination in changes.values():_validate_base(conn,destination)
        settings=json.loads(conn.execute('SELECT settings FROM puzzle_profile WHERE id=1').fetchone()[0])
        settings.update(changes)
        conn.execute('UPDATE puzzle_profile SET settings=? WHERE id=1',(json.dumps(settings),))
        active=[]
        for mode,field in COPY_SETTINGS.items():
            if field not in changes:continue
            for row in conn.execute("SELECT * FROM puzzle_attempts WHERE mode=? AND status='active' ORDER BY started_ms DESC",(mode,)).fetchall():
                a=dict(row);a['copy_base_id']=changes[field]
                conn.execute('UPDATE puzzle_attempts SET copy_base_id=? WHERE id=?',(a['copy_base_id'],a['id']))
                if a['copy_base_id'] is not None and a['failed']:
                    _copy_failed(conn,a)
                active.append(_public(a))
    return {**{field:settings.get(field) for field in COPY_SETTINGS.values()},'active_attempts':active}


@router.post('/storm')
def start_storm(payload:StormRequest|None=None):
    import random
    configuration=_storm_configuration(payload)
    requested_color=(configuration['filters'] or {}).get('color','any')
    color=requested_color if requested_color in ('white','black') else random.choice(['white','black'])
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        for previous in conn.execute("SELECT id FROM puzzle_storm WHERE status='active'").fetchall():
            _storm_state(conn, previous['id'])
        active = [row['id'] for row in conn.execute("SELECT id FROM puzzle_storm WHERE status='active'")]
        resumed = training_native.creation(conn, 1, 'storm', payload.training_run_id if payload else None, payload.request_id if payload else None, active_ids=active, request_payload=payload.model_dump() if payload else None)
        if resumed:
            old = _storm_state(conn, resumed)
            return {'storm': old, 'attempt': _public(_attempt(conn, old['current_attempt'])) if old['current_attempt'] else None}
        for previous in conn.execute("SELECT current_attempt,clock_started FROM puzzle_storm WHERE status='active' AND current_attempt IS NOT NULL").fetchall():
            a=_attempt(conn,previous['current_attempt'])
            if a['status']=='active':
                a['status']='expired';a['finished_at']=stamp();a['elapsed_ms']=max(0,int(time.time()*1000)-a['started_ms']) if previous['clock_started'] else 0;_save(conn,a)
        conn.execute("UPDATE puzzle_storm SET status='completed',finished_at=? WHERE status='active'",(stamp(),))
        for previous_id in active:
            _storm_state(conn, previous_id)
        sid=uuid.uuid4().hex;now_ms=int(time.time()*1000)
        conn.execute('INSERT INTO puzzle_storm(id,started_ms,deadline_ms,color,configuration_key,configuration_name,filters,clock_started) VALUES(?,?,?,?,?,?,?,0)',
            (sid,now_ms,now_ms+180000,color,configuration['key'],configuration['name'],json.dumps(configuration['filters']) if configuration['filters'] is not None else None))
        options = {'mode': 'storm', 'rated': False, 'selection': 'standard'}
        if configuration['filters']:
            options.update(filters=configuration['filters'], selection='custom')
        training_native.register(conn, 1, 'storm', sid, training_run_id=payload.training_run_id if payload else None, request_id=payload.request_id if payload else None, options=options, request_payload=payload.model_dump() if payload else None)
        s=_storm_state(conn,sid)
        try:
            a=_storm_next(conn,s)
        except HTTPException as exc:
            if exc.status_code!=404 or requested_color!='any':raise
            # Choose an available side once; it remains fixed thereafter.
            color='white' if color=='black' else 'black'
            conn.execute('UPDATE puzzle_storm SET color=? WHERE id=?',(color,sid));s['color']=color
            a=_storm_next(conn,s)
        ready_ms=int(time.time()*1000)
        conn.execute('UPDATE puzzle_storm SET started_ms=?,deadline_ms=? WHERE id=?',(ready_ms,ready_ms+180000,sid))
        result={'storm':_storm_state(conn,sid),'attempt':_public(a)}
    _schedule_storm_prefetch(result)
    return result


@router.get('/storm/{session_id}')
def storm_status(session_id:str):
    with db.get_conn() as conn:
        s=_storm_state(conn,session_id)
        a=_attempt(conn,s['current_attempt']) if s['current_attempt'] else None
        return {'storm':s,'attempt':_public(a) if a else None}


@router.get('/storm/{session_id}/attempts')
def storm_attempts(session_id:str):
    with db.get_conn() as conn:
        s=_storm_state(conn,session_id)
        attempts=[]
        summary={'total':0,'solved':0,'failed':0,'incomplete':0,'elapsed_ms':0}
        rows=conn.execute("SELECT id,puzzle_id,snapshot,status,failed,hints,elapsed_ms,copied_entry_id FROM puzzle_attempts WHERE session_id=? AND mode='storm' ORDER BY started_ms,rowid",(session_id,))
        for index,row in enumerate(rows,1):
            item={key:row[key] for key in ('id','puzzle_id','status','failed','hints','elapsed_ms','copied_entry_id')}
            puzzle=json.loads(row['snapshot'])
            outcome='failed' if row['failed'] else 'solved' if row['status']=='completed' else 'incomplete'
            item.update(index=index,rating=puzzle['rating'],color=puzzle['color'],outcome=outcome)
            attempts.append(item)
            summary['total']+=1;summary[outcome]+=1;summary['elapsed_ms']+=row['elapsed_ms']
    return {'storm':s,'attempts':attempts,'summary':summary}


@router.post('/storm/{session_id}/next')
def storm_next(session_id:str):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE');s=_storm_state(conn,session_id)
        if s['status']!='active':return {'storm':s,'attempt':None}
        current=_attempt(conn,s['current_attempt'])
        result={'storm':s,'attempt':_public(current)} if current['status']=='active' else _advance_storm(conn,s)
    _schedule_storm_prefetch(result)
    return result


class ImportPayload(BaseModel):
    source:str=Field(min_length=1,max_length=2000)
@router.post('/import',status_code=202)
def start_import(payload:ImportPayload):
    path=Path(payload.source).expanduser()
    if not path.is_absolute() or not path.is_file() or path.suffix.lower() not in ('.csv','.zst','.gz'):
        raise HTTPException(422,'Sélectionne un fichier CSV, CSV.ZST ou CSV.GZ de puzzles Lichess.')
    if not _import_lock.acquire(False):raise HTTPException(409,'Une importation de puzzles est déjà en cours.')
    def run():
        try:puzzle_store.import_bank(path)
        except Exception:
            with puzzle_store.bank_connection(True) as conn:
                puzzle_store.init_bank(conn)
                conn.execute('INSERT OR REPLACE INTO bank_meta VALUES(?,?)',('status',json.dumps('error')))
        finally:_import_lock.release()
    threading.Thread(target=run,daemon=True,name='puzzle-bank-import').start()
    return {'status':'importing'}
