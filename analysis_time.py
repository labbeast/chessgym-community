"""Receipts for measured foreground analysis time, independent of a programme."""
from fastapi import APIRouter, Depends

from accounts_api import require_user
import training_activity as activity
import training_program_api as api
import training_programs as programs


router = APIRouter(prefix='/api/training', tags=['Training activity'])


@router.post('/analysis-time')
def record_analysis_time(payload: dict, user=Depends(require_user)):
    def record(conn):
        visit = programs.text(payload.get('visit_id'), 'visite', maximum=160)
        duration = programs.number(payload.get('duration_ms'), 'temps actif', low=1, high=90000, integer=True)
        entry_id = payload.get('entry_id')
        resource = {'type': 'tool', 'id': 'analysis'}
        title = programs.text(payload.get('title') or 'Analyse', 'titre', maximum=200)
        if entry_id is not None:
            entry_id = programs.number(entry_id, 'partie', low=1, high=9223372036854775807, integer=True)
            entry = conn.execute('SELECT base_id,title FROM entries WHERE id=?', (entry_id,)).fetchone()
            # A deleted/moved game must not discard time already measured on
            # its open board. The visit keeps its original resource once linked.
            if entry:
                resource = activity._resource(conn, entry['base_id']) or resource
                title = entry['title'] or title
        link = activity._link(conn, user_id=user['id'], source_key='analysis:' + visit,
                              tool='analysis', source_id=visit, title=title, resource=resource)
        credit = activity._credit(conn, link, payload['mutation_id'], duration_ms=duration,
                                  duration_kind='active')
        return {'credit_id': credit, 'duration_ms': duration}

    return api.mutate(user['id'], 'analysis-time', payload, record)
