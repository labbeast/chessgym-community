"""Durable account-owned review of game-report moments, separate from PGNs."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, StrictStr

from accounts_api import require_user
import db
import game_analysis

router = APIRouter(prefix='/api/game-analysis')


def init_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS game_report_moment_progress (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL, ply INTEGER NOT NULL, revision INTEGER NOT NULL,
        state TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,entry_id,fingerprint,ply))''')
    conn.execute('''CREATE TABLE IF NOT EXISTS game_report_progress_receipts (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mutation_id TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL,
        created_at TEXT NOT NULL, PRIMARY KEY(user_id,mutation_id))''')


class MomentState(BaseModel):
    model_config = ConfigDict(extra='forbid')
    outcome: Literal['reviewed', 'solved', 'revealed', 'missed', 'cancelled'] | None = None
    hint: StrictBool = False
    revealed: StrictBool = False
    attempts: StrictInt = Field(default=0, ge=0, le=100000)


class SaveProgress(BaseModel):
    model_config = ConfigDict(extra='forbid')
    fingerprint: StrictStr = Field(pattern='^[0-9a-f]{64}$')
    ply: StrictInt = Field(ge=1, le=game_analysis.MAX_PLIES)
    expected_revision: StrictInt = Field(ge=0, lt=9223372036854775807)
    mutation_id: StrictStr = Field(min_length=8, max_length=160)
    state: MomentState


def _encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def _current(conn, entry_id, fingerprint, ply=None):
    row = game_analysis._entry(conn, entry_id)
    _, moves, current = game_analysis.game_snapshot(row['pgn'])
    if current != fingerprint:
        raise HTTPException(409, 'La ligne principale a changé. Recharge le bilan avant de synchroniser son suivi.', headers={'X-ChessGym-Reason': 'report-source-changed'})
    if ply is not None and ply > len(moves):
        raise HTTPException(422, 'Ce moment ne fait pas partie de la partie.')


def _item(row):
    return {'ply': row['ply'], 'revision': row['revision'], 'state': json.loads(row['state']), 'updated_at': row['updated_at']}


@router.get('/{entry_id}/progress')
def read_progress(entry_id: int, fingerprint: str = Query(pattern='^[0-9a-f]{64}$'), user=Depends(require_user)):
    with db.read_conn() as conn:
        conn.execute('BEGIN')
        _current(conn, entry_id, fingerprint)
        items = [_item(row) for row in conn.execute('''SELECT * FROM game_report_moment_progress
            WHERE user_id=? AND entry_id=? AND fingerprint=? ORDER BY ply''', (user['id'], entry_id, fingerprint))]
    return {'entry_id': entry_id, 'fingerprint': fingerprint, 'items': items}


@router.put('/{entry_id}/progress')
def save_progress(entry_id: int, payload: SaveProgress, user=Depends(require_user)):
    body = payload.model_dump()
    digest = hashlib.sha256(_encode([entry_id, body]).encode()).hexdigest()
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        receipt = conn.execute('SELECT * FROM game_report_progress_receipts WHERE user_id=? AND mutation_id=?', (user['id'], payload.mutation_id)).fetchone()
        if receipt:
            if receipt['request_hash'] != digest:
                raise HTTPException(409, 'Cet identifiant de requête a déjà été utilisé avec un autre contenu.', headers={'X-ChessGym-Reason': 'report-receipt-conflict'})
            return json.loads(receipt['response'])
        _current(conn, entry_id, payload.fingerprint, payload.ply)
        row = conn.execute('''SELECT * FROM game_report_moment_progress
            WHERE user_id=? AND entry_id=? AND fingerprint=? AND ply=?''', (user['id'], entry_id, payload.fingerprint, payload.ply)).fetchone()
        revision = row['revision'] if row else 0
        if revision != payload.expected_revision:
            raise HTTPException(409, 'Ce moment a été modifié sur un autre appareil. Compare les deux suivis avant de choisir.', headers={'X-ChessGym-Reason': 'report-progress-conflict'})
        state = payload.state.model_dump()
        # A completed reveal/solution always implies the displayed solution was
        # available; the UI cannot persist an internally contradictory state.
        if state['outcome'] in ('revealed', 'solved'):
            state['revealed'] = True
        updated = datetime.now(timezone.utc).isoformat(timespec='microseconds')
        result = {'entry_id': entry_id, 'fingerprint': payload.fingerprint,
            'item': {'ply': payload.ply, 'revision': revision + 1, 'state': state, 'updated_at': updated}}
        conn.execute('''INSERT INTO game_report_moment_progress VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(user_id,entry_id,fingerprint,ply) DO UPDATE SET
                revision=excluded.revision,state=excluded.state,updated_at=excluded.updated_at''',
            (user['id'], entry_id, payload.fingerprint, payload.ply, revision + 1, _encode(state), updated))
        conn.execute('INSERT INTO game_report_progress_receipts VALUES(?,?,?,?,?)',
            (user['id'], payload.mutation_id, digest, _encode(result), updated))
        return result
