"""Transactional training credits and attribution over authoritative native facts.

There is no timer here. Credit timestamps are acceptance times, not invented
intervals of attention. Native hooks never commit or run schema migrations.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta

import review_preferences
import training_programs as p


def available(conn):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_activity_credits'").fetchone() is not None


def _guard(conn, run_id):
    ready = available(conn)
    if not ready and run_id is not None:
        p.error('Le programme doit être initialisé avant ce lancement.', 409)
    return ready


def _run_row(conn, user_id, run_id):
    row = conn.execute('SELECT * FROM training_runs WHERE id=? AND user_id=?', (run_id, user_id)).fetchone()
    if row is None:
        p.error('Exécution introuvable.', 404)
    return {**dict(row), 'block': json.loads(row['block']), 'launch': json.loads(row['launch']),
            'native_ref': json.loads(row['native_ref']) if row['native_ref'] else None}


def run_document(conn, user_id, run_id):
    run = _run_row(conn, user_id, run_id)
    stats = conn.execute('''SELECT SUM(c.duration_ms) duration_ms,
        SUM(c.attempts) attempts,
        SUM(CASE WHEN c.unit!='sessions' THEN c.quantity ELSE 0 END) quantity,
        SUM(CASE WHEN c.unit='sessions' THEN c.quantity ELSE 0 END) sessions
        FROM training_activity_links a JOIN training_activity_credits c ON c.activity_id=a.id
        WHERE a.user_id=? AND a.run_id=?''', (user_id, run_id)).fetchone()
    # The toolbar projects the current native measurement on top of accepted
    # credits. Expose its included baseline so reloads never add that time twice.
    import training_native
    native_progress = []
    if training_native.ready(conn):
        native_progress = [dict(row) for row in conn.execute('''
            SELECT tool,source_id,duration_ms,finished FROM training_native_sources
            WHERE user_id=? AND run_id=? ORDER BY created_at,source_id''', (user_id, run_id))]
    return {**run, 'duration_ms': stats['duration_ms'], 'quantity': stats['quantity'] or 0, 'sessions': stats['sessions'] or 0, 'attempts': stats['attempts'],
            'native_progress': native_progress}


def validate_run(conn, user_id, run_id, activity, *, base_id=None):
    if run_id is None:
        return None
    _guard(conn, run_id)
    run = _run_row(conn, user_id, str(run_id))
    if run['state'] in ('completed', 'cancelled') or run['activity'] != activity:
        p.error('Cette exécution est terminée ou appartient à une autre activité.', 409)
    resource = run['block']['resource']
    if base_id is not None:
        current = conn.execute('SELECT generation FROM training_resource_identity WHERE base_id=?', (base_id,)).fetchone()
        generic_tool = resource.get('type') == 'tool' and resource.get('id') == activity
        if not current or (not generic_tool and (resource.get('type') != 'base' or resource.get('id') != base_id or current['generation'] != resource.get('generation'))):
            p.error('La ressource ne correspond plus à ce bloc.', 409)
    return run


def bind_native(conn, user_id, run_id, tool, source_id, *, base_id=None):
    run = validate_run(conn, user_id, run_id, tool, base_id=base_id)
    if run is None:
        return None
    reference = {'tool': tool, 'id': str(source_id)}
    if tool == 'review' and run['native_ref'] and run['native_ref'] != reference:
        p.error('Une séance est déjà attachée à cette exécution. Reprends-la.', 409)
    if run['state'] != 'active' or (tool == 'review' and run['native_ref'] != reference):
        conn.execute("UPDATE training_runs SET native_ref=?,state='active',revision=revision+1 WHERE id=?",
                     (p.encode(reference) if tool == 'review' else run['native_ref'] and p.encode(run['native_ref']), run['id']))
    return run_document(conn, user_id, run['id'])


def create_run(conn, user_id, week_id, block_id, payload):
    week = p.week_row(conn, user_id, week_id)
    if week['week_start'] != p.current_week(conn)[0]:
        p.error('Ouvre la semaine courante avant de lancer une activité.', 409)
    block = p.find_block(week, block_id)
    if block['activity'] in p.DERIVED:
        p.error('Games se met à jour automatiquement depuis My Games.')
    status = p.block_status(conn, block)
    if not status['available']:
        p.error(status['unavailable_reason'], 409)
    minutes = p.number(payload.get('minutes', block['session_minutes']), 'durée de séance', low=1, high=480, nullable=True)
    launch = {'activity': block['activity'], 'base_id': block['resource'].get('id') if block['resource']['type'] == 'base' else None, 'minutes': minutes,
              'automatic': status['automatic'], 'options': block.get('options', {})}
    if 'goal_scope' in payload:
        launch = scoped_launch(conn, user_id, week_id, block_id, payload['goal_scope'], launch)
    identity = p.uid()
    conn.execute('''INSERT INTO training_runs VALUES(?,?,?,?,?,?,?, ?,1,'preparing',NULL,?,?,NULL)''',
                 (identity, user_id, week_id, week['program_id'], block_id, p.encode(block), p.signature(block),
                  block['activity'], p.encode(launch), p.stamp()))
    return run_document(conn, user_id, identity)


def scoped_launch(conn, user_id, week_id, block_id, scope, launch, *, run=None):
    """Snapshot the additional work still needed without rewriting any credits.

    The run counters are lifetime counters. A resumed period goal starts at the
    current counters so its new remaining allowance is never consumed twice.
    """
    if launch.get('category_id'):
        import training_categories
        return training_categories.category_launch(conn, user_id, launch['category_id'], {'goal_scope': scope}, run)
    if scope not in ('today', 'week'):
        p.error('Choisis la journée ou la semaine pour cette reprise.')
    week = p.week_row(conn, user_id, week_id)
    if week['week_start'] != p.current_week(conn)[0]:
        p.error('Ouvre la semaine courante avant de reprendre cet objectif.', 409)
    current = p.find_block(week, block_id)
    if run and (run['signature'] != p.signature(current)
                or run['block'].get('options', {}) != current.get('options', {})):
        p.error('Ce bloc a changé. Reprends la séance d’origine ou lance le bloc actuel.', 409)
    summary = week_summary(conn, user_id, week_id)
    block = next(item for item in summary['blocks'] if item['id'] == block_id)
    if not block['available']:
        p.error(block['unavailable_reason'], 409)
    values = block['today'] if scope == 'today' else block['progress']
    metric = block['metric']
    unit = 'minutes' if metric == 'minutes' else 'sessions' if metric == 'sessions' else block['unit']
    realized = (values['duration_ms'] or 0) / 60000 if metric == 'minutes' else values[unit]
    target = block['target']
    if scope == 'today' and metric == 'minutes' and target > 0:
        target = block.get('session_minutes') or target
    remaining = max(0, target - realized)
    if remaining <= 0:
        p.error('L’objectif choisi est déjà atteint. Actualise le programme.', 409)
    baseline = run_document(conn, user_id, run['id']) if run else {}
    goal = {'scope': scope, 'study_date': summary['today']['date'], 'week_start': week['week_start'],
            'metric': metric, 'unit': unit, 'target': target, 'realized': realized, 'remaining': remaining,
            'baseline_duration_ms': baseline.get('duration_ms') or 0,
            'baseline_quantity': baseline.get('quantity') or 0,
            'baseline_sessions': baseline.get('sessions') or 0}
    result = {**launch, 'goal': goal,
              'minutes': remaining if metric == 'minutes' else block['session_minutes'] if metric == 'sessions' else None}
    result.pop('review_goal', None)
    if run and run['activity'] == 'review' and run['native_ref']:
        import review_sessions
        result['review_goal'] = review_sessions.retarget_training_goal(
            conn, run['id'], run['native_ref']['id'], goal)
    return result


def _resource(conn, base_id):
    row = conn.execute('SELECT b.id,b.name,i.generation FROM bases b JOIN training_resource_identity i ON i.base_id=b.id WHERE b.id=?', (base_id,)).fetchone()
    return {'type': 'base', **dict(row)} if row else None


def _native_signature(tool, resource):
    activity = 'puzzles' if tool == 'storm' else tool
    return p.signature({'activity': activity, 'resource': resource, 'unit': p.NATIVE_UNITS.get(activity, 'games')}) if resource else None


def _link(conn, *, user_id, source_key, tool, source_id, title, resource=None, run=None, history_id=None):
    old = conn.execute('SELECT * FROM training_activity_links WHERE user_id=? AND source_key=?', (user_id, source_key)).fetchone()
    if old:
        if run and old['run_id'] != run['id']:
            p.error('Cette activité appartient déjà à un autre épisode.', 409)
        return dict(old)
    identity = p.uid()
    signature = run['signature'] if run else _native_signature(tool, resource)
    conn.execute('''INSERT INTO training_activity_links
        (id,user_id,source_key,tool,source_id,title,resource,signature,run_id,program_id,block_id,origin,revision,review_history_id,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)''',
        (identity, user_id, source_key, tool, str(source_id), title, p.encode(resource) if resource else None,
         signature, run['id'] if run else None, run['program_id'] if run else None, run['block_id'] if run else None,
         'planned' if run else 'free', history_id, p.stamp()))
    return dict(conn.execute('SELECT * FROM training_activity_links WHERE id=?', (identity,)).fetchone())


def _credit(conn, link, event_key, *, duration_ms=None, duration_kind='unknown', quantity=0, unit=None, attempts=None, recorded_at=None, unit_key=None):
    old = conn.execute('SELECT id FROM training_activity_credits WHERE activity_id=? AND event_key=?', (link['id'], event_key)).fetchone()
    if old:
        return old['id']
    timestamp = recorded_at or p.stamp()
    current = datetime.fromisoformat(timestamp)
    if current.tzinfo is None:
        current = current.replace(tzinfo=p.timezone.utc)
    day = review_preferences.read(conn)['study_day']
    study_date = review_preferences.study_date(current, day)
    week_start = study_date - timedelta(days=study_date.weekday())
    if unit_key and quantity > 0 and conn.execute('''SELECT 1 FROM training_activity_credits c JOIN training_activity_links a ON a.id=c.activity_id
            WHERE a.user_id=? AND c.unit_key=? AND c.quantity>0''', (link['user_id'], unit_key)).fetchone():
        quantity = 0
    identity = p.uid()
    conn.execute('''INSERT INTO training_activity_credits
        (id,activity_id,event_key,duration_ms,duration_kind,quantity,unit,recorded_at,study_date,week_start,study_day,unit_key,attempts)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (identity, link['id'], event_key, duration_ms, duration_kind, quantity, unit, timestamp,
         study_date.isoformat(), week_start.isoformat(), p.encode(day), unit_key, attempts))
    # Native writes also prepare the week: starting from a tool must work even
    # before the owner visits the planning screen, including pending activation.
    p.ensure_current_week(conn, link['user_id'])
    import training_assistance
    training_assistance.auto_assign_link(conn, link['user_id'], link['id'])
    return identity


def record_review(conn, *, history_id, card, request_id=None, session_id=None, run_id=None, user_id=1, recorded_at=None):
    if not _guard(conn, run_id) or history_id is None:
        return None
    history = conn.execute('SELECT * FROM review_history WHERE id=?', (history_id,)).fetchone()
    if history is None or history['card_id'] != card['id']:
        p.error('La réponse de révision ne correspond pas à sa source.', 409)
    existing = conn.execute('SELECT * FROM training_activity_links WHERE review_history_id=? AND user_id=?', (history_id, user_id)).fetchone()
    if existing:
        return conn.execute('SELECT id FROM training_activity_credits WHERE activity_id=?', (existing['id'],)).fetchone()['id']
    run = validate_run(conn, user_id, run_id, 'review', base_id=card['base_id'])
    resource = _resource(conn, card['base_id'])
    source_key = 'review:' + (str(request_id) if request_id else p.uid())
    link = _link(conn, user_id=user_id, source_key=source_key, tool='review', source_id=history_id,
                 title=card['title'], resource=resource, run=run, history_id=history_id)
    group = run['id'] if run else str(session_id) if session_id else source_key
    return _credit(conn, link, 'answer', duration_ms=max(0, history['elapsed_ms']), duration_kind='elapsed',
                   quantity=1, unit='cards', attempts=1, recorded_at=recorded_at or history['reviewed_at'],
                   unit_key='review:' + group + ':' + card['id'])


def record_reading(conn, *, entry, payload, user_id=1, recorded_at=None):
    run_id = payload.get('training_run_id')
    if not _guard(conn, run_id) or payload.get('mode', 'visit') != 'visit' or not payload.get('request_id'):
        return None
    run = validate_run(conn, user_id, run_id, 'reading', base_id=entry['base_id'])
    # Only time accepted by the native updater reaches this hook. A bookmark
    # or progress-only update cannot create evidence of an effective episode.
    seconds = payload.get('active_seconds', 0)
    if seconds <= 0:
        return None
    visit_id = payload.get('visit_id') or 'receipt:' + payload['request_id']
    source_key = 'reading:' + str(entry['id']) + ':' + visit_id
    link = _link(conn, user_id=user_id, source_key=source_key, tool='reading', source_id=visit_id,
                 title=entry['title'], resource=_resource(conn, entry['base_id']), run=run)
    if run and run['state'] == 'preparing':
        conn.execute("UPDATE training_runs SET state='active',revision=revision+1 WHERE id=?", (run['id'],))
    return _credit(conn, link, str(payload['request_id']), duration_ms=round(seconds * 1000), duration_kind='active',
                   recorded_at=recorded_at, unit_key='reading-entry:' + str(entry['id']))


def _real_work(conn, user_id, run_id):
    return conn.execute('''SELECT 1 FROM training_activity_links a JOIN training_activity_credits c ON c.activity_id=a.id
        WHERE a.user_id=? AND a.run_id=? AND (c.duration_ms>0 OR c.attempts>0 OR (c.quantity>0 AND c.unit!='sessions')) LIMIT 1''', (user_id, run_id)).fetchone()


def update_run(conn, user_id, run_id, payload):
    run = _run_row(conn, user_id, run_id)
    p.revision(run, payload.get('expected_revision'))
    action = payload.get('action')
    if action not in ('pause', 'resume', 'finish', 'confirm_reading', 'cancel'):
        p.error('Action d’épisode inconnue.')
    if 'goal_scope' in payload and action != 'resume':
        p.error('Le choix de période est réservé à la reprise.')
    if run['state'] in ('completed', 'cancelled'):
        p.error('Cet épisode est déjà terminé.', 409)
    if action == 'cancel':
        if _real_work(conn, user_id, run_id) or run['native_ref'] or run['state'] == 'active':
            p.error('Seule une préparation sans séance native ni travail enregistré peut être annulée.', 409)
        conn.execute("UPDATE training_runs SET state='cancelled',finished_at=?,revision=revision+1 WHERE id=?", (p.stamp(), run_id))
    elif action in ('pause', 'resume'):
        state = 'paused' if action == 'pause' else 'active'
        if 'goal_scope' in payload:
            launch = scoped_launch(conn, user_id, run['week_id'], run['block_id'], payload['goal_scope'], run['launch'], run=run)
            conn.execute('UPDATE training_runs SET state=?,launch=?,revision=revision+1 WHERE id=?', (state, p.encode(launch), run_id))
        else:
            conn.execute('UPDATE training_runs SET state=?,revision=revision+1 WHERE id=?', (state, run_id))
    elif action == 'finish':
        import training_native
        if training_native.unfinished(conn, run_id):
            p.error('Termine la séance ou la partie native avant de terminer ce bloc.', 409)
        if not _real_work(conn, user_id, run_id):
            p.error('Enregistre une activité effective avant de terminer cet épisode.', 409)
        resource = run['block']['resource']
        link = _link(conn, user_id=user_id, source_key='episode:' + run_id, tool=run['activity'], source_id=run_id,
                     title=run['block']['title'], resource=resource, run=run)
        _credit(conn, link, 'completed', quantity=1, unit='sessions', recorded_at=p.stamp())
        conn.execute("UPDATE training_runs SET state='completed',finished_at=?,revision=revision+1 WHERE id=?", (p.stamp(), run_id))
    else:
        if run['activity'] != 'reading':
            p.error('Cette confirmation est réservée à la lecture.')
        entry_id = p.number(payload.get('entry_id'), 'partie étudiée', low=1, high=9223372036854775807, integer=True)
        # The receipt source key embeds the stable AUTOINCREMENT entry ID.
        source = conn.execute('''SELECT a.* FROM training_activity_links a JOIN training_activity_credits c ON c.activity_id=a.id
            WHERE a.user_id=? AND a.run_id=? AND a.tool='reading' AND a.source_key LIKE ? AND c.duration_ms>0 LIMIT 1''',
            (user_id, run_id, 'reading:' + str(entry_id) + ':%')).fetchone()
        if source is None:
            p.error('Cette partie doit avoir du temps de lecture enregistré dans cet épisode.', 409)
        _credit(conn, dict(source), 'studied:' + run_id + ':' + str(entry_id), quantity=1, unit='games',
                unit_key='studied:' + run_id + ':' + str(entry_id))
        conn.execute('UPDATE training_runs SET revision=revision+1 WHERE id=?', (run_id,))
    return run_document(conn, user_id, run_id)


def activity_document(conn, user_id, activity_id, *, scope_week=None):
    row = conn.execute('SELECT * FROM training_activity_links WHERE id=? AND user_id=?', (activity_id, user_id)).fetchone()
    if row is None:
        p.error('Activité introuvable.', 404)
    clause, args = (' AND week_start=?', (activity_id, scope_week)) if scope_week else ('', (activity_id,))
    credits = conn.execute('SELECT * FROM training_activity_credits WHERE activity_id=?' + clause + ' ORDER BY recorded_at,id', args).fetchall()
    known = [c['duration_ms'] for c in credits if c['duration_ms'] is not None]
    attempts = [c['attempts'] for c in credits if c['attempts'] is not None]
    kinds = sorted({c['duration_kind'] for c in credits if c['duration_ms'] is not None})
    return {**dict(row), 'scope_week': scope_week, 'resource': json.loads(row['resource']) if row['resource'] else None,
            'duration_ms': sum(known) if known else None, 'duration_kind': kinds[0] if len(kinds) == 1 else 'mixed' if kinds else 'unknown',
            'quantity': sum(c['quantity'] for c in credits), 'unit': next((c['unit'] for c in credits if c['quantity']), None),
            'attempts': sum(attempts) if attempts else None,
            'study_dates': sorted({c['study_date'] for c in credits}),
            'first_at': credits[0]['recorded_at'] if credits else row['created_at'], 'last_at': credits[-1]['recorded_at'] if credits else row['created_at'],
            'assignment': {'program_id': row['program_id'], 'block_id': row['block_id']} if row['block_id'] else None,
            'history': None if row['source_key'].startswith('episode:') or (row['tool'] == 'review' and row['review_history_id'] is None)
                       or (row['tool'] == 'reading' and not conn.execute('SELECT 1 FROM reading_visits WHERE id=? AND user_id=?', (row['source_id'], user_id)).fetchone())
                       else {'tool': row['tool'], 'identity': row['source_id']}}


def activities(conn, user_id, *, unassigned=False, limit=100):
    clause = ' AND block_id IS NULL' if unassigned else ''
    rows = conn.execute('SELECT id FROM training_activity_links WHERE user_id=?' + clause + ' ORDER BY created_at DESC,id DESC LIMIT ?', (user_id, limit)).fetchall()
    return [activity_document(conn, user_id, row['id']) for row in rows]


def compatible_block(block, activity):
    tool = 'puzzles' if activity['tool'] == 'storm' else activity['tool']
    if block['activity'] != tool or block['unit'] != p.NATIVE_UNITS.get(tool):
        return False
    resource = activity['resource']
    if isinstance(resource, str):
        resource = json.loads(resource)
    if not resource:
        return False
    target = block['resource']
    if target['type'] == 'tool':
        return target.get('id') == tool and target.get('generation') == 'tool-v1' and resource['type'] in ('base', 'tool')
    return target['type'] == 'base' and resource['type'] == 'base' and all(target.get(key) == resource.get(key) for key in ('id', 'generation'))


def assign(conn, user_id, activity_id, payload):
    activity = activity_document(conn, user_id, activity_id)
    p.revision(activity, payload.get('expected_revision'))
    week_id, block_id = payload.get('week_id'), payload.get('block_id')
    if week_id is None and block_id is None:
        conn.execute("UPDATE training_activity_links SET program_id=NULL,block_id=NULL,origin='manual-unassigned',revision=revision+1 WHERE id=?", (activity_id,))
    else:
        week = p.week_row(conn, user_id, week_id)
        block = p.find_block(week, block_id)
        if not compatible_block(block, activity):
            p.error('Ce bloc ne correspond pas à l’activité, à sa ressource ou à son unité.', 409)
        conn.execute("UPDATE training_activity_links SET program_id=?,block_id=?,signature=?,origin='assigned',revision=revision+1 WHERE id=?", (week['program_id'], block_id, p.signature(block), activity_id))
    return activity_document(conn, user_id, activity_id)


def create_episode(conn, user_id, payload):
    """Group distinct string activity IDs, validating types before any lookup."""
    identities = payload.get('activity_ids')
    if (not isinstance(identities, list) or not 1 <= len(identities) <= 200
            or any(not isinstance(identity, str) for identity in identities)
            or len(set(identities)) != len(identities)):
        p.error('Choisis de 1 à 200 activités distinctes.')
    week = p.week_row(conn, user_id, payload.get('week_id'))
    block = p.find_block(week, payload.get('block_id'))
    selected = [activity_document(conn, user_id, identity) for identity in identities]
    if any(item['run_id'] or not compatible_block(block, item) for item in selected):
        p.error('Choisis des activités libres compatibles qui ne font pas déjà partie d’un épisode.', 409)
    import training_native
    for item in selected:
        if item['source_key'].startswith('native:'):
            native = training_native.context(conn, user_id, item['tool'], item['source_id'])
            if native and not native['finished']:
                p.error('Termine cette activité native avant de confirmer un épisode.', 409)
    run = create_run(conn, user_id, week['id'], block['id'], {})
    for item in selected:
        conn.execute('UPDATE training_activity_links SET run_id=?,program_id=?,block_id=?,signature=?,revision=revision+1 WHERE id=?', (run['id'], week['program_id'], block['id'], p.signature(block), item['id']))
    return update_run(conn, user_id, run['id'], {'action': 'finish', 'expected_revision': run['revision']})


def _manual_document(row):
    item = dict(row)
    item['deleted'] = bool(item['deleted'])
    item['duration_minutes'] = item['duration_ms'] / 60000 if item['duration_ms'] is not None else None
    return item


def manual_list(conn, user_id, week_id=None):
    where, args = (' AND week_id=?', (user_id, week_id)) if week_id else ('', (user_id,))
    return [_manual_document(row) for row in conn.execute('SELECT * FROM training_manual_activities WHERE user_id=? AND deleted=0' + where + ' ORDER BY date DESC,created_at DESC', args)]


def save_manual(conn, user_id, payload, identity=None, *, delete=False):
    prior = conn.execute('SELECT * FROM training_manual_activities WHERE id=? AND user_id=?', (identity, user_id)).fetchone() if identity else None
    if identity and prior is None:
        p.error('Déclaration introuvable.', 404)
    if prior:
        p.revision(prior, payload.get('expected_revision'))
        conn.execute('INSERT INTO training_manual_history(activity_id,revision,snapshot,recorded_at) VALUES(?,?,?,?)', (identity, prior['revision'], p.encode(dict(prior)), p.stamp()))
    if delete:
        conn.execute('UPDATE training_manual_activities SET deleted=1,revision=revision+1,updated_at=? WHERE id=?', (p.stamp(), identity))
        return {'ok': True}
    data = {**(_manual_document(prior) if prior else {}), **payload}
    try:
        day = date.fromisoformat(data.get('date', ''))
    except (ValueError, TypeError):
        p.error('La date doit utiliser le format AAAA-MM-JJ.')
    import training_categories
    if data.get('activity') and (('activity' in payload and not payload.get('week_id')) or not data.get('week_id') or str(data.get('block_id', '')).startswith('category:')):
        activity = training_categories.checked_activity(data['activity'])
        week = training_categories.category_week(conn, user_id, day)
        block = training_categories.category_block(activity)
    else:
        week = p.week_row(conn, user_id, data.get('week_id'))
        # Keep a declaration editable even after its original block is removed.
        block = next((item for item in week['definition']['blocks'] if item['id'] == data.get('block_id')), None)
        if block is None and prior:
            block = {**training_categories.category_block(prior['activity'] or 'external'),
                     'id': prior['block_id'], 'unit': prior['unit'] or 'sessions', 'title': prior['title']}
        if block is None:
            p.error('Ce bloc ne fait plus partie de cette semaine.', 404)
        if prior and prior['week_id'] == week['id'] and prior['block_id'] == block['id']:
            block = {**block, 'activity': prior['activity'] or 'external', 'unit': prior['unit'] or 'sessions'}
    if block['activity'] in p.DERIVED:
        p.error('Games se met à jour automatiquement depuis My Games.')
    if not week['week_start'] <= day.isoformat() < (date.fromisoformat(week['week_start']) + timedelta(days=7)).isoformat():
        p.error('La date déclarée doit appartenir à la semaine choisie.')
    minutes = p.number(data.get('duration_minutes'), 'durée', low=0, high=1440, nullable=True)
    quantity = p.number(data.get('quantity', 0), 'quantité', low=0)
    sessions = p.number(data.get('sessions', 0), 'séances', low=0, high=100, integer=True)
    if not (minutes or quantity or sessions):
        p.error('Indique une durée, une quantité ou un nombre de séances.')
    original_signature = prior['signature'] if prior and prior['week_id'] == week['id'] and prior['block_id'] == block['id'] else p.signature(block)
    values = (week['program_id'], block['id'], original_signature, week['id'], day.isoformat(),
              round(minutes * 60000) if minutes is not None else None, quantity, sessions,
              p.text(data.get('title') or block['title'], 'activité'), p.text(data.get('note', ''), 'note', maximum=3000, empty=True),
              block['activity'], block['unit'])
    timestamp = p.stamp()
    if prior:
        conn.execute('''UPDATE training_manual_activities SET program_id=?,block_id=?,signature=?,week_id=?,date=?,duration_ms=?,quantity=?,sessions=?,title=?,note=?,activity=?,unit=?,revision=revision+1,deleted=0,updated_at=? WHERE id=?''', (*values, timestamp, identity))
    else:
        identity = p.uid()
        conn.execute('''INSERT INTO training_manual_activities
            (id,user_id,program_id,block_id,signature,week_id,date,duration_ms,quantity,sessions,title,note,activity,unit,revision,deleted,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)''', (identity, user_id, *values, timestamp, timestamp))
    return _manual_document(conn.execute('SELECT * FROM training_manual_activities WHERE id=?', (identity,)).fetchone())


def _totals():
    return {'duration_ms': None, 'duration_by_kind': {}, 'cards': 0, 'games': 0, 'positions': 0, 'sessions': 0, 'attempts': None}


def _add(total, duration, kind, quantity=0, unit=None, attempts=None):
    if duration is not None:
        total['duration_ms'] = (total['duration_ms'] or 0) + duration
        total['duration_by_kind'][kind] = total['duration_by_kind'].get(kind, 0) + duration
    if unit in ('cards', 'games', 'positions', 'sessions'):
        total[unit] += quantity
    if attempts is not None:
        total['attempts'] = (total['attempts'] or 0) + attempts


def week_summary(conn, user_id, week_id):
    week = p.week_row(conn, user_id, week_id)
    catalog = p.resource_index(conn)
    blocks = [{**block, **p.block_status(conn, block, catalog=catalog), 'planned_minutes': p.planned_minutes(block), 'progress': _totals()} for block in week['definition']['blocks']]
    mapping = {block['id']: block for block in blocks}
    today = review_preferences.study_date(p.now(), review_preferences.read(conn)['study_day']).isoformat()
    days = {(date.fromisoformat(week['week_start']) + timedelta(days=offset)).isoformat(): _totals() for offset in range(7)}
    for block in blocks:
        block['today'] = _totals() if today in days else None
    totals, activity_ids = _totals(), []
    rows = conn.execute('''SELECT c.*,a.id activity_identity,a.block_id,a.signature FROM training_activity_credits c
        JOIN training_activity_links a ON a.id=c.activity_id WHERE a.user_id=? AND a.program_id=? AND c.week_start=?''', (user_id, week['program_id'], week['week_start'])).fetchall()
    unmatched = _totals()
    for credit in rows:
        activity_ids.append(credit['activity_identity'])
        _add(totals, credit['duration_ms'], credit['duration_kind'], credit['quantity'], credit['unit'], credit['attempts'])
        block = mapping.get(credit['block_id'])
        target = block['progress'] if block and p.signature(block) == credit['signature'] else unmatched
        _add(target, credit['duration_ms'], credit['duration_kind'], credit['quantity'], credit['unit'], credit['attempts'])
        if credit['study_date'] in days:
            _add(days[credit['study_date']], credit['duration_ms'], credit['duration_kind'], credit['quantity'], credit['unit'], credit['attempts'])
        if block and target is block['progress'] and credit['study_date'] == today and block['today'] is not None:
            _add(block['today'], credit['duration_ms'], credit['duration_kind'], credit['quantity'], credit['unit'], credit['attempts'])
    manual = manual_list(conn, user_id, week_id)
    for item in manual:
        block = mapping.get(item['block_id'])
        target = block['progress'] if block and p.signature(block) == item['signature'] else unmatched
        unit = block['unit'] if block else None
        for total in (totals, target):
            _add(total, item['duration_ms'], 'declared', item['quantity'], unit)
            total['sessions'] += item['sessions']
        if item['date'] in days:
            _add(days[item['date']], item['duration_ms'], 'declared', item['quantity'], unit)
            days[item['date']]['sessions'] += item['sessions']
        if block and target is block['progress'] and item['date'] == today and block['today'] is not None:
            _add(block['today'], item['duration_ms'], 'declared', item['quantity'], unit)
            block['today']['sessions'] += item['sessions']
    # Games are a projection of the current My Games collection, not accepted
    # training receipts. Several goals can observe them; the week counts once.
    games_blocks = [block for block in blocks if block['activity'] == 'games' and block['available']]
    if games_blocks:
        import training_games
        lower = date.fromisoformat(week['week_start'])
        for fact in training_games.facts(conn, user_id, lower, lower + timedelta(days=6)):
            targets = [totals, days[fact['date']]]
            for block in games_blocks:
                targets.append(block['progress'])
                if fact['date'] == today and block['today'] is not None:
                    targets.append(block['today'])
            for target in targets:
                _add(target, fact['duration_ms'], fact['duration_kind'], fact['quantity'], fact['unit'])
                target['unknown_duration_count'] = target.get('unknown_duration_count', 0) + int(fact['unknown'])
    for block in blocks:
        progress = block['progress']
        realized = (progress['duration_ms'] or 0) / 60000 if block['metric'] == 'minutes' else progress['sessions'] if block['metric'] == 'sessions' else progress[block['unit']]
        progress.update(realized=realized, remaining=max(0, block['target'] - realized), target=block['target'], complete=block['target'] > 0 and realized >= block['target'])
    other_rows = conn.execute('''SELECT DISTINCT a.id FROM training_activity_links a
        JOIN training_activity_credits c ON c.activity_id=a.id
        WHERE a.user_id=? AND a.program_id IS NOT NULL AND a.program_id!=? AND c.week_start=?''',
        (user_id, week['program_id'], week['week_start'])).fetchall()
    other_duration = conn.execute('''SELECT SUM(c.duration_ms) FROM training_activity_links a
        JOIN training_activity_credits c ON c.activity_id=a.id
        WHERE a.user_id=? AND a.program_id IS NOT NULL AND a.program_id!=? AND c.week_start=?''',
        (user_id, week['program_id'], week['week_start'])).fetchone()[0]
    return {**week, 'week_end': (date.fromisoformat(week['week_start']) + timedelta(days=6)).isoformat(),
            'today': {'date': today, **days.get(today, _totals())},
            'days': [{'date': day, **values} for day, values in days.items()],
            'blocks': blocks, **totals, 'unmatched': unmatched, 'total_blocks': len(blocks),
            'completed_blocks': sum(b['progress']['complete'] for b in blocks),
            'planned_minutes': sum(b['planned_minutes'] or 0 for b in blocks),
            'unestimated_blocks': sum(b['planned_minutes'] is None for b in blocks),
            'activities': [activity_document(conn, user_id, identity, scope_week=week['week_start']) for identity in dict.fromkeys(activity_ids)],
            'manual_activities': manual, 'unassigned': activities(conn, user_id, unassigned=True),
            'other_activities': [activity_document(conn, user_id, row['id'], scope_week=week['week_start']) for row in other_rows],
            'other_duration_ms': other_duration,
            'active_runs': active_runs(conn, user_id)}


def active_runs(conn, user_id):
    return [run_document(conn, user_id, row['id']) for row in conn.execute("SELECT id FROM training_runs WHERE user_id=? AND state NOT IN ('completed','cancelled') ORDER BY started_at DESC", (user_id,))]


def preview(conn, user_id, week_id, minutes):
    minutes = p.number(minutes, 'temps disponible', low=1, high=480)
    week = week_summary(conn, user_id, week_id)
    candidates = [block for block in week['blocks'] if block['available'] and block['progress']['remaining'] > 0]
    priority = {'essential': 0, 'normal': 1, 'optional': 2}
    candidates.sort(key=lambda block: (priority[block['priority']], block['progress']['realized'] / block['target']))
    remaining, items = minutes, []
    for block in candidates:
        habitual = block['session_minutes'] or 15
        if block['metric'] == 'minutes':
            allocation = min(remaining, habitual, block['progress']['remaining'])
        else:
            allocation = habitual
            if allocation > remaining:
                continue
        if allocation <= 0 or len(items) >= 3:
            break
        items.append({'block_id': block['id'], 'title': block['title'], 'minutes': allocation,
                      'reason': 'Bloc essentiel encore à travailler' if block['priority'] == 'essential' else 'Objectif hebdomadaire encore à travailler',
                      'automatic': block['automatic'], 'block': {key: value for key, value in block.items() if key in week['definition']['blocks'][0]}})
        remaining -= allocation
    return {'items': items, 'requested_minutes': minutes, 'allocated_minutes': minutes - remaining, 'remaining_minutes': remaining}


def summary(conn, user_id, date_from=None, date_to=None):
    today = review_preferences.study_date(p.now(), review_preferences.read(conn)['study_day'])
    try:
        lower = date.fromisoformat(date_from) if date_from else today - timedelta(days=90)
        upper = date.fromisoformat(date_to) if date_to else today
    except (ValueError, TypeError):
        p.error('Période invalide.')
    if upper < lower or (upper - lower).days > 3660:
        p.error('La période doit être ordonnée et inférieure à dix ans.')
    ids = conn.execute('''SELECT w.id FROM training_weeks w JOIN training_programs p ON p.id=w.program_id
        WHERE w.user_id=? AND p.status!='categories' AND w.week_start<=? AND date(w.week_start,'+6 days')>=?
        ORDER BY w.week_start DESC,w.created_at DESC''', (user_id, upper.isoformat(), lower.isoformat())).fetchall()
    weeks = [week_summary(conn, user_id, row['id']) for row in ids]
    total = _totals()
    # Period total is by recording date and independent of assignment. It does
    # not sum weekly summaries (which may cover days outside the chosen range).
    for row in conn.execute('''SELECT c.* FROM training_activity_credits c JOIN training_activity_links a ON a.id=c.activity_id
        WHERE a.user_id=? AND c.study_date>=? AND c.study_date<=?''', (user_id, lower.isoformat(), upper.isoformat())):
        _add(total, row['duration_ms'], row['duration_kind'], row['quantity'], row['unit'], row['attempts'])
    for row in conn.execute('SELECT * FROM training_manual_activities WHERE user_id=? AND deleted=0 AND date>=? AND date<=?', (user_id, lower.isoformat(), upper.isoformat())):
        _add(total, row['duration_ms'], 'declared')
    import training_games
    for fact in training_games.facts(conn, user_id, lower, upper):
        _add(total, fact['duration_ms'], fact['duration_kind'], fact['quantity'], fact['unit'])
    return {'weeks': weeks, **total, 'date_from': lower.isoformat(), 'date_to': upper.isoformat(),
            'unassigned_count': conn.execute('SELECT COUNT(*) FROM training_activity_links WHERE user_id=? AND block_id IS NULL', (user_id,)).fetchone()[0]}
