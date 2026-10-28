"""Guess-the-move sessions: immutable source, first-answer scoring and original continuation."""
from __future__ import annotations

import json
import math
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

import chess
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, ConfigDict

import db
import training_native
import engine
import pgnlib
from accounts_api import require_user

router = APIRouter(prefix='/api/guess-move')
_EVALUATIONS = set()
_EVALUATIONS_LOCK = threading.Lock()


@contextmanager
def _evaluation_guard(session_id, path):
    key = (session_id, path)
    with _EVALUATIONS_LOCK:
        if key in _EVALUATIONS:
            raise HTTPException(409, 'Une évaluation de cet essai est déjà en cours. Réessaie dans un instant.')
        _EVALUATIONS.add(key)
    try:
        yield
    finally:
        with _EVALUATIONS_LOCK:
            _EVALUATIONS.discard(key)


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def init_guess_move():
    with db.get_conn() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS guess_sessions (
          id TEXT PRIMARY KEY, user_id INTEGER NOT NULL,
          entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
          title TEXT NOT NULL, source_pgn TEXT NOT NULL, start_path TEXT NOT NULL,
          current_path TEXT, side TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS guess_sessions_user_date ON guess_sessions(user_id,updated_at DESC);
        CREATE TABLE IF NOT EXISTS guess_attempts (
          id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES guess_sessions(id) ON DELETE CASCADE,
          path TEXT NOT NULL, uci TEXT NOT NULL, elapsed_ms INTEGER NOT NULL,
          score INTEGER, exact INTEGER NOT NULL, result TEXT,
          created_at TEXT NOT NULL, UNIQUE(session_id,path)
        );
        ''')


class StartRequest(BaseModel):
    training_run_id: str | None = Field(None, min_length=8, max_length=160)
    request_id: str | None = Field(None, min_length=8, max_length=160)
    source_base_id: int | None = Field(None, ge=1, le=9_223_372_036_854_775_807)
    model_config = ConfigDict(extra='forbid')
    entry_id: int | None = Field(default=None, ge=1, le=9_223_372_036_854_775_807)
    pgn: str | None = Field(default=None, max_length=2_000_000)
    path: str = Field(default='', max_length=10000, pattern=r'^(?:\d+(?:\.\d+)*)?$')
    side: Literal['white', 'black', 'both'] = 'white'


class AttemptRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(max_length=10000)
    uci: str = Field(pattern=r'^[a-h][1-8][a-h][1-8][qrbn]?$')
    elapsed_ms: int = Field(default=0, ge=0, le=86_400_000)


class ContinueRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    path: str = Field(max_length=10000)


def _load(conn, session_id, user_id):
    row = conn.execute('SELECT * FROM guess_sessions WHERE id=? AND user_id=?', (session_id, user_id)).fetchone()
    if row is None:
        raise HTTPException(404, 'Cette séance est introuvable.')
    return dict(row)


def _game(text):
    try:
        return pgnlib.load_game(text)
    except (ValueError, TypeError) as exc:
        raise HTTPException(422, 'Le PGN ne peut pas être lu.') from exc


def _next(node, side, *, advance=False):
    if advance:
        node = node.variations[0] if node.variations else None
    while node is not None and node.variations:
        if not node.variations[0].move:
            return None
        if side == 'both' or node.board().turn == (side == 'white'):
            return pgnlib.path_of(node)
        node = node.variations[0]
    return None


def _node(game, path):
    try:
        return pgnlib.node_at(game, path)
    except (ValueError, IndexError, KeyError) as exc:
        raise HTTPException(422, 'La position choisie n’existe plus dans ce PGN.') from exc


def _public(conn, session):
    game = _game(session['source_pgn'])
    path = session['current_path']
    attempts = [dict(row) for row in conn.execute('SELECT id,path,uci,elapsed_ms,score,exact,result,created_at FROM guess_attempts WHERE session_id=? ORDER BY id', (session['id'],))]
    for attempt in attempts:
        attempt['result'] = json.loads(attempt['result']) if attempt['result'] else None
    current = next((a for a in attempts if a['path'] == path), None)
    ready = bool(current and current['score'] is not None)
    # Construct only the played prefix. Never send concealed descendants or PGN.
    target = _node(game, path) if path is not None else _node(game, session['start_path']).end()
    chain = []
    while target is not None:
        chain.append(target)
        target = target.parent
    chain.reverse()
    nodes = []
    for index, node in enumerate(chain):
        key = pgnlib.path_of(node)
        nodes.append({'path': key, 'parent': pgnlib.path_of(node.parent) if node.parent else None,
                      'fen': node.board().fen(), 'san': node.san() if node.parent else None,
                      'uci': node.move.uci() if node.parent else None, 'comment': '', 'nags': [],
                      'clock': node.clock(),
                      'children': [pgnlib.path_of(chain[index+1])] if index+1<len(chain) else []})
    scored = [a for a in attempts if a['score'] is not None]
    return {'id': session['id'], 'training_run_id': training_native.run_id(conn, session['user_id'], 'guess', session['id']), 'entry_id': session['entry_id'], 'title': session['title'],
            'side': session['side'], 'path': path, 'start_path': session['start_path'],
            'completed': path is None, 'awaiting_continue': ready, 'pending': bool(current and not ready),
            'doc': {'headers': dict(game.headers), 'nodes': nodes},
            'score': sum(a['score'] for a in scored), 'maximum': len(scored)*10,
            'exact_count': sum(a['exact'] for a in scored), 'attempts': attempts,
            'result': current['result'] if current else None}


@router.post('/sessions')
def start_session(payload: StartRequest, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if payload.entry_id is not None:
            row = conn.execute('SELECT title,pgn,base_id FROM entries WHERE id=?', (payload.entry_id,)).fetchone()
            if row is None:
                raise HTTPException(404, 'Cette partie est introuvable.')
            source, title = row['pgn'], row['title']
        elif payload.pgn:
            source, title = payload.pgn, 'Deviner le coup'
        else:
            raise HTTPException(422, 'Choisis une partie pour commencer.')
        game = _game(source)
        if payload.entry_id is None:
            names=[game.headers.get('White','?'),game.headers.get('Black','?')]
            title=' — '.join(names) if any(name!='?' for name in names) else game.headers.get('Event','Deviner le coup')
            if title=='?': title='Deviner le coup'
        node = _node(game, payload.path)
        path = _next(node, payload.side)
        if path is None:
            raise HTTPException(422, 'Il ne reste aucun coup à deviner pour ce camp.')
        base_id = row['base_id'] if payload.entry_id is not None else payload.source_base_id
        resumed = training_native.creation(conn, user['id'], 'guess', payload.training_run_id, payload.request_id, base_id=base_id, request_payload=payload.model_dump())
        if resumed:
            if str(resumed).startswith('mix-'):
                raise HTTPException(409, 'Ce bloc appartient à une séance expérimentale archivée. Annule le bloc puis relance une partie classique.')
            return _public(conn, _load(conn, resumed, user['id']))
        session_id = str(uuid4())
        conn.execute('INSERT INTO guess_sessions VALUES(?,?,?,?,?,?,?,?,?,?)',
                     (session_id,user['id'],payload.entry_id,title,pgnlib.export_game(game),payload.path,path,payload.side,stamp(),stamp()))
        training_native.register(conn, user['id'], 'guess', session_id, training_run_id=payload.training_run_id, request_id=payload.request_id, base_id=base_id, title=title, options={'side': payload.side}, request_payload=payload.model_dump())
        return _public(conn, _load(conn, session_id, user['id']))


@router.get('/sessions')
def history(limit: int = Query(50, ge=1, le=200), user=Depends(require_user)):
    with db.get_conn() as conn:
        rows = conn.execute('''SELECT s.id,s.title,s.side,s.created_at,s.updated_at,s.current_path IS NULL AS completed,
            COUNT(a.score) AS answered,COALESCE(SUM(a.score),0) AS score,COALESCE(SUM(CASE WHEN a.score IS NOT NULL THEN a.exact ELSE 0 END),0) AS exact_count
            FROM guess_sessions s LEFT JOIN guess_attempts a ON a.session_id=s.id
            WHERE s.user_id=? GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?''', (user['id'],limit)).fetchall()
        return {'sessions': [dict(row) for row in rows]}


@router.get('/sessions/{session_id}')
def read_session(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        return _public(conn, _load(conn, session_id, user['id']))


def _value(line, turn):
    # All engine scores are white-relative. Equal winning/losing mates receive
    # the same strength; predicting a shorter forced mate is not the objective.
    sign = 1 if turn == chess.WHITE else -1
    if line.get('mate') is not None:
        return 100000 if line['mate']*sign > 0 else -100000
    if line.get('cp') is None:
        raise HTTPException(503, 'Le moteur n’a pas fourni d’évaluation exploitable.')
    return line['cp']*sign


def score_move(best, proposed, *, turn):
    loss = max(0, _value(best, turn)-_value(proposed, turn))
    # At most 0.20 pawn behind is equivalent; each additional half-pawn loses
    # one point, with bounded 0–10 output. The threshold is identical by color.
    return max(0, 10-math.ceil(max(0, loss-20)/50))


def _evaluate(board, proposed, original):
    best = engine._run(board, 1000, multipv=1)['lines'][0]
    def line_for(move):
        if best['uci'] == move.uci():
            return best
        return engine._run(board, 1000, multipv=1, root_moves=[move])['lines'][0]
    proposal = line_for(proposed)
    source = proposal if proposed == original else line_for(original)
    return {'best': best, 'proposal': proposal, 'original': source}


@router.post('/sessions/{session_id}/attempt')
def attempt(session_id: str, payload: AttemptRequest, user=Depends(require_user)):
    # Persist the first legal proposal before running Stockfish. Engine failures
    # leave that exact proposal retryable; they cannot grant a second attempt.
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        session = _load(conn, session_id, user['id'])
        if session['current_path'] != payload.path:
            raise HTTPException(409, 'La séance a avancé. Recharge la position actuelle.')
        game = _game(session['source_pgn']); node = _node(game, payload.path); board = node.board()
        move = chess.Move.from_uci(payload.uci)
        if move not in board.legal_moves:
            raise HTTPException(422, 'Ce coup est illégal.')
        original = node.variations[0]
        existing = conn.execute('SELECT * FROM guess_attempts WHERE session_id=? AND path=?', (session_id,payload.path)).fetchone()
        if existing:
            if existing['score'] is not None:
                return _public(conn, session)
            if existing['uci'] != payload.uci:
                raise HTTPException(409, 'Le premier essai a déjà été enregistré. Relance son évaluation.')
        else:
            conn.execute('INSERT INTO guess_attempts(session_id,path,uci,elapsed_ms,exact,created_at) VALUES(?,?,?,?,?,?)',
                         (session_id,payload.path,payload.uci,payload.elapsed_ms,int(move==original.move),stamp()))
            training_native.guess(conn, session)
    with _evaluation_guard(session_id, payload.path):
        # A contender may reach the lock just after the previous evaluation
        # finished. Recheck its receipt before spending more engine time.
        with db.get_conn() as conn:
            current = conn.execute('SELECT score FROM guess_attempts WHERE session_id=? AND path=?',
                                   (session_id,payload.path)).fetchone()
            if current and current['score'] is not None:
                return _public(conn, _load(conn,session_id,user['id']))
        evaluation = _evaluate(board, move, original.move)
        score = score_move(evaluation['best'],evaluation['proposal'],turn=board.turn)
        result = {'score':score,'exact':move==original.move,'proposal_san':board.san(move),
                  'original_san':board.san(original.move),'original_uci':original.move.uci(),
                  'original_fen':original.board().fen(),'comment':pgnlib.human_comment(original.comment),
                  'nags':sorted(original.nags), **evaluation}
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            session = _load(conn,session_id,user['id'])
            conn.execute('UPDATE guess_attempts SET score=?,result=? WHERE session_id=? AND path=? AND score IS NULL',
                         (score,json.dumps(result,ensure_ascii=False),session_id,payload.path))
            conn.execute('UPDATE guess_sessions SET updated_at=? WHERE id=?', (stamp(),session_id))
            return _public(conn,session)


@router.post('/sessions/{session_id}/continue')
def continue_session(session_id: str, payload: ContinueRequest, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE');session=_load(conn,session_id,user['id'])
        if session['current_path'] != payload.path:
            # Safe double-click/retry: never advance a second position.
            return _public(conn,session)
        row=conn.execute('SELECT score FROM guess_attempts WHERE session_id=? AND path=?',(session_id,payload.path)).fetchone()
        if not row or row['score'] is None:
            raise HTTPException(409, 'Propose un coup et attends son évaluation avant de continuer.')
        game=_game(session['source_pgn']);node=_node(game,payload.path)
        next_path=_next(node,session['side'],advance=True)
        conn.execute('UPDATE guess_sessions SET current_path=?,updated_at=? WHERE id=?',(next_path,stamp(),session_id))
        session['current_path']=next_path
        training_native.guess(conn, session)
        return _public(conn,session)


@router.get('/sessions/{session_id}/source')
def source_document(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        session=_load(conn,session_id,user['id'])
        if session['current_path'] is not None:
            raise HTTPException(409, 'Termine la séance pour ouvrir la partie complète.')
        return pgnlib.game_payload(_game(session['source_pgn']))
