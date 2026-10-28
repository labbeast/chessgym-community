"""Account-owned square-color drills with server-verified scores and deadlines."""
from __future__ import annotations

import json
import secrets
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt

import db
import training_native
from accounts_api import require_user

router = APIRouter(prefix='/api/skills/color', tags=['Color training'])
SQUARES = tuple(file + rank for rank in '12345678' for file in 'abcdefgh')
MAX_ANSWERS = 10000


def init_schema(conn):
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS color_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        duration INTEGER NOT NULL CHECK(duration IN (30,60)),
        state TEXT NOT NULL,
        created_at REAL NOT NULL,
        started_at REAL,
        finished_at REAL,
        result TEXT
      );
      CREATE INDEX IF NOT EXISTS color_history ON color_sessions(user_id,finished_at DESC);
      CREATE INDEX IF NOT EXISTS color_records ON color_sessions(user_id,duration,finished_at);
    """)


def init_color_training():
    with db.get_conn() as conn:
        init_schema(conn)


class StrictPayload(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ColorConfig(StrictPayload):
    training_run_id: str | None = Field(None, min_length=8, max_length=160)
    request_id: str | None = Field(None, min_length=8, max_length=160)
    duration: Literal[30, 60] = 30


class ColorAnswer(StrictPayload):
    index: StrictInt = Field(ge=0, le=MAX_ANSWERS)
    nonce: str = Field(min_length=8, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')
    color: Literal['white', 'black']


def _dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def square_color(square):
    # A1 is dark. A color depends on coordinates, not board orientation/theme.
    return 'white' if ((ord(square[0]) - ord('a')) + (int(square[1]) - 1)) % 2 else 'black'


def _target(previous=None):
    return {'square': secrets.choice([square for square in SQUARES if square != previous])}


def _row(conn, session_id, user_id):
    raw = conn.execute('SELECT * FROM color_sessions WHERE id=? AND user_id=?', (session_id, user_id)).fetchone()
    if raw is None:
        raise HTTPException(404, 'Séance introuvable.')
    value = dict(raw)
    value['state'] = json.loads(value['state'])
    value['result'] = json.loads(value['result']) if value['result'] else None
    value['training_run_id'] = training_native.run_id(conn, user_id, 'color', session_id)
    return value


def _save(conn, row):
    conn.execute('UPDATE color_sessions SET state=?,started_at=?,finished_at=?,result=? WHERE id=? AND user_id=?',
                 (_dump(row['state']), row['started_at'], row['finished_at'],
                  _dump(row['result']) if row['result'] is not None else None, row['id'], row['user_id']))
    training_native.color(conn, row)


def _deadline(row):
    return row['started_at'] + row['duration'] if row['started_at'] is not None else None


def _finish(row, stamp, *, completed):
    state = row['state']
    answered = state['correct'] + state['errors']
    row['finished_at'] = _deadline(row) if completed else stamp
    row['result'] = {
        'score': state['correct'], 'errors': state['errors'], 'answered': answered,
        'accuracy': round(100 * state['correct'] / answered, 1) if answered else 0,
        'mean_ms': round(sum(state['response_ms']) / len(state['response_ms'])) if state['response_ms'] else None,
        'duration': row['duration'], 'completed': completed, 'abandoned': not completed,
        # Never infer perfect accuracy from a rounded percentage.
        'record_eligible': bool(completed and answered and state['errors'] == 0),
    }


def _expire(row, stamp):
    deadline = _deadline(row)
    if row['finished_at'] is None and deadline is not None and stamp >= deadline:
        _finish(row, stamp, completed=True)
        return True
    return False


def _settle_open(conn, user_id, stamp, *, abandon=False):
    identities = conn.execute('SELECT id FROM color_sessions WHERE user_id=? AND finished_at IS NULL', (user_id,)).fetchall()
    for identity in identities:
        row = _row(conn, identity['id'], user_id)
        if _expire(row, stamp):
            _save(conn, row)
        elif abandon:
            _finish(row, stamp, completed=False)
            _save(conn, row)


def _public(row, stamp=None):
    state = row['state']
    return {
        'id': row['id'], 'training_run_id': row.get('training_run_id'), 'config': {'duration': row['duration']},
        'target': state['target'], 'index': state['index'], 'nonce': state['nonce'],
        'score': state['correct'], 'errors': state['errors'],
        'answered': state['correct'] + state['errors'],
        'started_at': row['started_at'], 'deadline': _deadline(row),
        'server_time': time.time() if stamp is None else stamp,
        'finished': row['finished_at'] is not None, 'result': row['result'],
        'last_answer': state.get('last_answer'),
    }


@router.post('')
def color_start(payload: ColorConfig, user=Depends(require_user)):
    stamp, identity = time.time(), secrets.token_urlsafe(24)
    state = {'target': _target(), 'index': 0, 'nonce': secrets.token_urlsafe(18),
             'correct': 0, 'errors': 0, 'target_at': None, 'response_ms': [],
             'events': [], 'last_answer': None, 'receipt': None}
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        _settle_open(conn, user['id'], stamp)
        active = [row['id'] for row in conn.execute('SELECT id FROM color_sessions WHERE user_id=? AND finished_at IS NULL', (user['id'],))]
        resumed = training_native.creation(conn, user['id'], 'color', payload.training_run_id, payload.request_id, active_ids=active, request_payload=payload.model_dump())
        if resumed:
            return _public(_row(conn, resumed, user['id']), stamp)
        _settle_open(conn, user['id'], stamp, abandon=True)
        conn.execute('INSERT INTO color_sessions VALUES(?,?,?,?,?,?,?,?)',
                     (identity, user['id'], payload.duration, _dump(state), stamp, None, None, None))
        training_native.register(conn, user['id'], 'color', identity, training_run_id=payload.training_run_id, request_id=payload.request_id, options={'duration': payload.duration}, request_payload=payload.model_dump())
        return _public(_row(conn, identity, user['id']), stamp)


@router.get('/history')
def color_history(user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        _settle_open(conn, user['id'], time.time())
        rows = conn.execute("""SELECT id,duration,started_at,finished_at,result FROM color_sessions
            WHERE user_id=? AND finished_at IS NOT NULL AND json_extract(result,'$.answered')>0
            ORDER BY finished_at DESC,id DESC LIMIT 30""", (user['id'],)).fetchall()
        records = []
        for duration in (30, 60):
            best = conn.execute("""SELECT id,duration,started_at,finished_at,result FROM color_sessions
                WHERE user_id=? AND duration=? AND finished_at IS NOT NULL
                  AND json_extract(result,'$.record_eligible')=1
                ORDER BY CAST(json_extract(result,'$.score') AS INTEGER) DESC,finished_at ASC,id ASC LIMIT 1""",
                (user['id'], duration)).fetchone()
            if best is not None:
                records.append(best)
    def entry(row):
        return {'id': row['id'], 'config': {'duration': row['duration']},
                'started_at': row['started_at'], 'finished_at': row['finished_at'], **json.loads(row['result'])}
    return {'history': [entry(row) for row in rows], 'records': [entry(row) for row in records]}


@router.get('/{session_id}')
def color_get(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'])
        stamp = time.time()
        if _expire(row, stamp):
            _save(conn, row)
        return _public(row, stamp)


@router.post('/{session_id}/answer')
def color_answer(session_id: str, payload: ColorAnswer, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'])
        stamp, state = time.time(), row['state']
        if row['finished_at'] is not None:
            return _public(row, stamp)
        if _expire(row, stamp):
            _save(conn, row)
            return _public(row, stamp)
        receipt = payload.model_dump()
        if state.get('receipt') == receipt:
            # A lost response may be retried, but the click counts only once.
            return _public(row, stamp)
        if payload.index != state['index'] or not secrets.compare_digest(payload.nonce, state['nonce']):
            raise HTTPException(409, 'Cette réponse a déjà été traitée. Recharge la séance.')
        if state['index'] >= MAX_ANSWERS:
            raise HTTPException(429, 'La limite de réponses de cette séance est atteinte.')
        if row['started_at'] is None:
            row['started_at'] = stamp
            state['target_at'] = stamp
        square = state['target']['square']
        correct = payload.color == square_color(square)
        state['correct' if correct else 'errors'] += 1
        state['response_ms'].append(round(1000 * max(0, stamp - state['target_at'])))
        state['last_answer'] = {'index': state['index'], 'square': square, 'color': payload.color, 'correct': correct}
        state['events'].append({**state['last_answer'], 'elapsed_ms': round(1000 * max(0, stamp - row['started_at']))})
        state['receipt'] = receipt
        state['index'] += 1
        state['target'] = _target(square)
        state['target_at'] = stamp
        state['nonce'] = secrets.token_urlsafe(18)
        _save(conn, row)
        return _public(row, stamp)


@router.post('/{session_id}/finish')
def color_finish(session_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = _row(conn, session_id, user['id'])
        stamp = time.time()
        if row['finished_at'] is None:
            if not _expire(row, stamp):
                raise HTTPException(409, 'Le chronomètre n’est pas encore terminé.')
            _save(conn, row)
        return _public(row, stamp)
