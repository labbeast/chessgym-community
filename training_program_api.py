"""Authenticated transport for personal programs, weeks and accepted activity."""
from __future__ import annotations

import hashlib
import json
from fastapi import APIRouter, Depends, Query

import db
from accounts_api import require_user
import training_programs as p
import training_activity as a
import training_categories as categories

router = APIRouter(prefix='/api/training', tags=['Training program'])


@router.get('/overview')
def overview(user=Depends(require_user)):
    with db.read_conn() as conn:
        return categories.overview(conn, user['id'])


@router.get('/statistics')
def statistics(date_from: str | None = None, date_to: str | None = None, user=Depends(require_user)):
    with db.read_conn() as conn:
        return categories.statistics(conn, user['id'], date_from, date_to)


@router.patch('/category-goals/{activity}')
def category_goal(activity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'category:goal:' + activity, payload,
                  lambda conn: categories.save_goal(conn, user['id'], activity, payload))


@router.post('/categories/{activity}/runs')
def category_run(activity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'category:run:' + activity, payload,
                  lambda conn: categories.create_run(conn, user['id'], activity, payload))


def mutate(user_id, operation, payload, callback):
    if not isinstance(payload, dict):
        p.error('Un objet JSON est nécessaire.')
    mutation = p.text(payload.get('mutation_id'), 'identifiant de requête', maximum=160)
    if len(mutation) < 8:
        p.error('Identifiant de requête trop court.')
    digest = hashlib.sha256(p.encode([operation, payload]).encode()).hexdigest()
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        previous = conn.execute('SELECT * FROM training_mutation_receipts WHERE user_id=? AND mutation_id=?', (user_id, mutation)).fetchone()
        if previous:
            if previous['request_hash'] != digest:
                p.error('Cet identifiant de requête a déjà été utilisé avec un autre contenu.', 409)
            return json.loads(previous['response'])
        result = callback(conn)
        conn.execute('INSERT INTO training_mutation_receipts VALUES(?,?,?,?,?)', (user_id, mutation, digest, p.encode(result), p.stamp()))
        return result


def _state(conn, user_id):
    import training_assistance
    active = p.active_program(conn, user_id)
    return {'programs': p.list_programs(conn, user_id), 'templates': p.templates(conn, user_id),
            'resources': p.resource_catalog(conn), 'current_program_id': active['id'] if active else None,
            'pending_activation': p.pending_activation(conn, user_id), 'active_runs': a.active_runs(conn, user_id),
            'study_day': p.review_preferences.read(conn)['study_day'],
            'assignment_settings': training_assistance.settings(conn, user_id)}


@router.get('/state')
def state(user=Depends(require_user)):
    with db.read_conn() as conn:
        return _state(conn, user['id'])


@router.get('/programs')
def programs(user=Depends(require_user)):
    with db.read_conn() as conn:
        return {'items': p.list_programs(conn, user['id'])}


@router.post('/programs')
def create_program(payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'program:create', payload, lambda conn: p.save_program(conn, user['id'], payload))


@router.get('/programs/{identity}')
def program(identity: str, user=Depends(require_user)):
    with db.read_conn() as conn:
        return p.get_program(conn, user['id'], identity)


@router.put('/programs/{identity}')
def update_program(identity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'program:update:' + identity, payload, lambda conn: p.save_program(conn, user['id'], payload, identity))


@router.delete('/programs/{identity}')
def archive_program(identity: str, payload: dict, user=Depends(require_user)):
    def change(conn):
        program = p.get_program(conn, user['id'], identity)
        p.revision(program, payload.get('expected_revision'))
        conn.execute("UPDATE training_programs SET status='archived',revision=revision+1,updated_at=? WHERE id=?", (p.stamp(), identity))
        conn.execute('DELETE FROM training_pending_activation WHERE user_id=? AND program_id=?', (user['id'], identity))
        return p.get_program(conn, user['id'], identity)
    return mutate(user['id'], 'program:archive:' + identity, payload, change)


@router.post('/programs/{identity}/activate')
def activate_program(identity: str, payload: dict, user=Depends(require_user)):
    def change(conn):
        week_id = p.activate(conn, user['id'], identity, payload)
        return {'active_program': p.active_program(conn, user['id']), 'pending_activation': p.pending_activation(conn, user['id']),
                'week': a.week_summary(conn, user['id'], week_id) if week_id else None}
    return mutate(user['id'], 'program:activate:' + identity, payload, change)


@router.post('/activation/cancel')
def cancel_activation(payload: dict, user=Depends(require_user)):
    def change(conn):
        conn.execute('DELETE FROM training_pending_activation WHERE user_id=?', (user['id'],))
        return {'pending_activation': None}
    return mutate(user['id'], 'activation:cancel', payload, change)


def _current(conn, user_id, program_id=None):
    week_id = p.ensure_current_week(conn, user_id)
    active = p.active_program(conn, user_id)
    if program_id and (active is None or active['id'] != program_id):
        p.error('Ce programme n’est pas actif.', 409)
    return {'week': a.week_summary(conn, user_id, week_id) if week_id else None, 'active_program': active}


@router.post('/weeks/current')
def current_week(payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'week:current', payload, lambda conn: _current(conn, user['id']))


@router.post('/programs/{identity}/weeks')
def ensure_week(identity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'week:ensure:' + identity, payload, lambda conn: _current(conn, user['id'], identity))


@router.get('/weeks/{identity}')
def week(identity: str, user=Depends(require_user)):
    with db.read_conn() as conn:
        return a.week_summary(conn, user['id'], identity)


@router.patch('/weeks/{identity}')
def update_week(identity: str, payload: dict, user=Depends(require_user)):
    def change(conn):
        p.update_week(conn, user['id'], identity, payload)
        return a.week_summary(conn, user['id'], identity)
    return mutate(user['id'], 'week:update:' + identity, payload, change)


@router.post('/weeks/{identity}/preview')
def preview(identity: str, payload: dict, user=Depends(require_user)):
    with db.read_conn() as conn:
        return a.preview(conn, user['id'], identity, payload.get('minutes', 30))


@router.post('/weeks/{week_id}/blocks/{block_id}/runs')
def create_run(week_id: str, block_id: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'run:create:' + week_id + ':' + block_id, payload,
                  lambda conn: a.create_run(conn, user['id'], week_id, block_id, payload))


@router.get('/runs/{identity}')
def run(identity: str, user=Depends(require_user)):
    with db.read_conn() as conn:
        return a.run_document(conn, user['id'], identity)


@router.patch('/runs/{identity}')
def update_run(identity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'run:update:' + identity, payload, lambda conn: a.update_run(conn, user['id'], identity, payload))


@router.get('/activities')
def activities(unassigned: bool = False, limit: int = Query(100, ge=1, le=500), user=Depends(require_user)):
    with db.read_conn() as conn:
        return {'items': a.activities(conn, user['id'], unassigned=unassigned, limit=limit)}


@router.put('/activities/{identity}/assignment')
def assign(identity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'activity:assign:' + identity, payload, lambda conn: a.assign(conn, user['id'], identity, payload))


@router.post('/episodes')
def create_episode(payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'episode:create', payload, lambda conn: a.create_episode(conn, user['id'], payload))


@router.get('/manual-activities')
def manual_activities(week_id: str | None = None, user=Depends(require_user)):
    with db.read_conn() as conn:
        if week_id:
            p.week_row(conn, user['id'], week_id)
        return {'items': a.manual_list(conn, user['id'], week_id)}


@router.post('/manual-activities')
def create_manual(payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'manual:create', payload, lambda conn: a.save_manual(conn, user['id'], payload))


@router.patch('/manual-activities/{identity}')
def update_manual(identity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'manual:update:' + identity, payload, lambda conn: a.save_manual(conn, user['id'], payload, identity))


@router.delete('/manual-activities/{identity}')
def delete_manual(identity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'manual:delete:' + identity, payload, lambda conn: a.save_manual(conn, user['id'], payload, identity, delete=True))


@router.get('/templates')
def templates(user=Depends(require_user)):
    with db.read_conn() as conn:
        return {'items': p.templates(conn, user['id'])}


@router.post('/templates')
def create_template(payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'template:create', payload, lambda conn: p.save_template(conn, user['id'], payload))


@router.put('/templates/{identity}')
def update_template(identity: str, payload: dict, user=Depends(require_user)):
    return mutate(user['id'], 'template:update:' + identity, payload, lambda conn: p.save_template(conn, user['id'], payload, identity))


@router.delete('/templates/{identity}')
def delete_template(identity: str, payload: dict, user=Depends(require_user)):
    def change(conn):
        row = conn.execute('SELECT * FROM training_templates WHERE id=? AND user_id=?', (identity, user['id'])).fetchone()
        if row is None:
            p.error('Modèle personnel introuvable.', 404)
        p.revision(row, payload.get('expected_revision'))
        conn.execute('DELETE FROM training_templates WHERE id=?', (identity,))
        return {'ok': True}
    return mutate(user['id'], 'template:delete:' + identity, payload, change)


@router.get('/summary')
def summary(date_from: str | None = None, date_to: str | None = None, user=Depends(require_user)):
    with db.read_conn() as conn:
        return a.summary(conn, user['id'], date_from, date_to)


@router.get('/assistance')
def assistance(user=Depends(require_user)):
    import training_assistance as helper
    with db.read_conn() as conn:
        return helper.overview(conn, user['id'])


@router.patch('/assistance/settings')
def assistance_settings(payload: dict, user=Depends(require_user)):
    import training_assistance as helper
    return mutate(user['id'], 'assistance:settings', payload, lambda conn: helper.update_settings(conn, user['id'], payload))


@router.post('/assistance/assign')
def assistance_assign(payload: dict, user=Depends(require_user)):
    import training_assistance as helper
    return mutate(user['id'], 'assistance:assign', payload, lambda conn: helper.assign_unique(conn, user['id']))


@router.post('/assistance/apply')
def assistance_apply(payload: dict, user=Depends(require_user)):
    import training_assistance as helper
    return mutate(user['id'], 'assistance:apply', payload, lambda conn: helper.apply_suggestion(conn, user['id'], payload))


@router.post('/weeks/{identity}/duplicate')
def duplicate_week(identity: str, payload: dict, user=Depends(require_user)):
    import training_assistance as helper
    return mutate(user['id'], 'week:duplicate:' + identity, payload, lambda conn: helper.duplicate_week(conn, user['id'], identity, payload))
