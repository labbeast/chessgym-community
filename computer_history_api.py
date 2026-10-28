"""Authenticated archive and opt-in library copies of computer games."""
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field, StrictInt

import computer_history
import db
from accounts_api import require_user

router = APIRouter(prefix='/api/computer')


class SaveGame(BaseModel):
    model_config = ConfigDict(extra='forbid')
    snapshot: dict
    mutation_id: str | None = Field(default=None, min_length=1, max_length=160)
    expected_revision: StrictInt = Field(ge=0, lt=9223372036854775807)


class CopyGame(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_id: StrictInt = Field(ge=1, le=9223372036854775807)


@router.get('/settings')
def settings(user=Depends(require_user)):
    with db.get_conn() as conn:
        return computer_history.settings(conn, user['id'])


@router.patch('/settings')
def update_settings(payload: dict, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return computer_history.update_settings(conn, user['id'], payload)


@router.get('/games')
def games(offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100), user=Depends(require_user)):
    with db.get_conn() as conn:
        return computer_history.list_games(conn, user['id'], offset=offset, limit=limit)


@router.get('/games/{game_id}')
def game(game_id: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        return computer_history.read(conn, user['id'], game_id)


@router.put('/games/{game_id}')
def save_game(game_id: str, payload: SaveGame, user=Depends(require_user)):
    prepared = computer_history.prepare_write(game_id, payload.snapshot, payload.mutation_id)
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return computer_history.write(conn, user['id'], game_id, payload.snapshot, payload.expected_revision,
                                      payload.mutation_id, prepared=prepared)


@router.post('/games/{game_id}/copy')
def copy_game(game_id: str, payload: CopyGame, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return computer_history.copy_game(conn, user['id'], game_id, payload.base_id)
