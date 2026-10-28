"""Authenticated draft persistence with explicit compare-and-swap transactions."""
from fastapi import APIRouter, Depends

import db
import workspace_state
from accounts_api import require_user

router = APIRouter()


@router.get('/api/workspace')
def list_workspace(user=Depends(require_user)):
    with db.get_conn() as conn:
        return workspace_state.list_items(conn, user['id'])



@router.get('/api/workspace/{key}')
def read_workspace(key: str, user=Depends(require_user)):
    with db.get_conn() as conn:
        return workspace_state.read(conn, user['id'], key)



@router.put('/api/workspace/{key}')
def write_workspace(key: str, payload: dict, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return workspace_state.write(conn, user['id'], key, payload)



@router.delete('/api/workspace/{key}')
def delete_workspace(key: str, expected_revision: int, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return workspace_state.delete(conn, user['id'], key, expected_revision)

