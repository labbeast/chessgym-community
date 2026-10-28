"""Reading bookmarks and library progress, separate from saved PGN edits."""
from fastapi import APIRouter, Depends

import db
import entry_catalog
import reading_progress
from accounts_api import require_user
from api_common import fail
from entry_service import get_entry

router = APIRouter()


@router.get('/api/reading')
def reading_dashboard(user=Depends(require_user)):
    entry_catalog.prepare()
    with db.get_conn() as conn:
        return reading_progress.dashboard(conn)



@router.get('/api/entries/{entry_id}/reading')
def entry_reading(entry_id: int, user=Depends(require_user)):
    entry_catalog.prepare(entry_id=entry_id)
    with db.get_conn() as conn:
        conn.execute('BEGIN')
        row = get_entry(conn, entry_id)
        return reading_progress.catalog_summary(conn, row, entry_catalog.get(conn, row, persist=False), enabled=reading_progress.enabled(conn, row['base_id']))



@router.post('/api/entries/{entry_id}/reading')
def update_entry_reading(entry_id: int, payload: dict, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return reading_progress.update(conn, get_entry(conn, entry_id), payload, user_id=user['id'])



@router.post('/api/bases/{base_id}/reading')
def mark_base_reading(base_id: int, payload: dict, user=Depends(require_user)):
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        base = conn.execute('SELECT * FROM bases WHERE id=?', (base_id,)).fetchone()
        if base is None:
            fail('Cette base est introuvable.', 404)
        return reading_progress.mark_base(conn, base, payload.get('action'))

