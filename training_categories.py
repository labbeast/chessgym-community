"""Permanent activity categories over measured facts, independent of planning.

Credits keep their accepted study date. Older native facts are projected only
for the portion absent from that ledger; this read model never rewrites history.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import review_preferences
import training_activity as a
import training_programs as p

TITLES = {'review': 'Review', 'reading': 'Reading', 'puzzles': 'Puzzles & Storm',
          'guess': 'Guess the move', 'computer': 'Play computer', 'games': 'Games', 'analysis': 'Analysis',
          'external': 'Personal study', 'blindfold': 'Blindfold', 'coordinates': 'Coordinates', 'color': 'Color'}


def checked_activity(activity):
    if activity not in p.ACTIVITIES:
        p.error('Catégorie inconnue.')
    return activity


def init_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS training_category_goals (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        activity TEXT NOT NULL,target_minutes REAL NOT NULL,daily_target_minutes REAL NOT NULL,
        revision INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(user_id,activity))''')
    conn.execute('CREATE INDEX IF NOT EXISTS training_credit_date ON training_activity_credits(study_date,activity_id)')
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(training_manual_activities)')}
    for name in ('activity', 'unit'):
        if name not in columns:
            conn.execute('ALTER TABLE training_manual_activities ADD COLUMN ' + name + ' TEXT')
    # Recover only an exact historical signature. An edited/deleted block must
    # never silently reclassify a past declaration into its replacement.
    for row in conn.execute('''SELECT m.*,w.definition FROM training_manual_activities m
            JOIN training_weeks w ON w.id=m.week_id WHERE m.activity IS NULL OR m.unit IS NULL''').fetchall():
        block = next((b for b in json.loads(row['definition'])['blocks']
                      if b['id'] == row['block_id'] and p.signature(b) == row['signature']), None)
        conn.execute('UPDATE training_manual_activities SET activity=?,unit=? WHERE id=?',
                     (block['activity'] if block else 'external', block['unit'] if block else 'sessions', row['id']))


def category_block(activity, resource=None):
    return {'id': 'category:' + activity, 'title': TITLES[activity], 'activity': activity,
            'resource': resource or {'type': 'tool', 'id': activity, 'name': TITLES[activity], 'generation': 'tool-v1'},
            'axis': '', 'metric': 'minutes', 'target': 0, 'unit': p.NATIVE_UNITS.get(activity, 'sessions'),
            'session_minutes': None, 'unit_minutes': None, 'priority': 'normal', 'notes': '', 'options': {}}


def category_week(conn, user_id, day=None):
    """Internal FK container, never an active or user-editable programme."""
    day = day or review_preferences.study_date(p.now(), review_preferences.read(conn)['study_day'])
    start = (day - timedelta(days=day.weekday())).isoformat()
    program_id = 'categories:' + str(user_id)
    definition = {'schema_version': 1, 'budget_minutes': None, 'intention': '',
                  'blocks': [category_block(activity) for activity in p.ACTIVITIES]}
    timestamp = p.stamp()
    conn.execute('''INSERT OR IGNORE INTO training_programs
        (id,user_id,name,status,revision,definition,created_at,updated_at) VALUES(?,?,?,'categories',1,?,?,?)''',
                 (program_id, user_id, 'Activities', p.encode(definition), timestamp, timestamp))
    identity = program_id + ':' + start
    conn.execute('''INSERT OR IGNORE INTO training_weeks
        (id,user_id,program_id,name,week_start,revision,program_revision,definition,study_day,created_at,updated_at)
        VALUES(?,?,?,?,?,1,1,?,?,?,?)''', (identity, user_id, program_id, 'Activities', start,
             p.encode(definition), p.encode(review_preferences.read(conn)['study_day']), timestamp, timestamp))
    return p.week_row(conn, user_id, identity)


def _active_week(conn, user_id):
    program = p.active_program(conn, user_id)
    if not program:
        return None, None
    start, _ = p.current_week(conn)
    row = conn.execute('SELECT id FROM training_weeks WHERE user_id=? AND program_id=? AND week_start=?',
                       (user_id, program['id'], start)).fetchone()
    return program, a.week_summary(conn, user_id, row['id']) if row else None


def _goals(conn, user_id, blocks):
    saved = {row['activity']: dict(row) for row in conn.execute('SELECT * FROM training_category_goals WHERE user_id=?', (user_id,))}
    result = {}
    for activity in p.ACTIVITIES:
        relevant = [b for b in blocks if b['activity'] == activity and b['metric'] == 'minutes']
        weekly = sum(b['target'] for b in relevant)
        daily = sum((b.get('session_minutes') or b['target']) for b in relevant if b['target'] > 0)
        row = saved.get(activity)
        result[activity] = {'target_minutes': row['target_minutes'] if row else weekly,
                            'daily_target_minutes': row['daily_target_minutes'] if row else daily,
                            'goal_revision': row['revision'] if row else 0,
                            'goal_source': 'custom' if row else 'program'}
    return result


def save_goal(conn, user_id, activity, payload):
    checked_activity(activity)
    _, week = _active_week(conn, user_id)
    current = _goals(conn, user_id, week['blocks'] if week else [])[activity]
    p.revision({'revision': current['goal_revision']}, payload.get('expected_revision'))
    target = p.number(payload.get('target_minutes', current['target_minutes']), 'objectif hebdomadaire', high=10080)
    daily = p.number(payload.get('daily_target_minutes', current['daily_target_minutes']), 'objectif quotidien', high=1440)
    conn.execute('''INSERT INTO training_category_goals VALUES(?,?,?,?,1,?) ON CONFLICT(user_id,activity)
        DO UPDATE SET target_minutes=excluded.target_minutes,daily_target_minutes=excluded.daily_target_minutes,
        revision=training_category_goals.revision+1,updated_at=excluded.updated_at''', (user_id, activity, target, daily, p.stamp()))
    return {'id': activity, 'activity': activity, **_goals(conn, user_id, [])[activity]}


def _range(conn, lower=None, upper=None):
    today = review_preferences.study_date(p.now(), review_preferences.read(conn)['study_day'])
    try:
        start = date.fromisoformat(lower) if lower else today - timedelta(days=29)
        end = date.fromisoformat(upper) if upper else today
        if (lower and start.isoformat() != lower) or (upper and end.isoformat() != upper):
            raise ValueError()
    except (TypeError, ValueError):
        p.error('La période doit utiliser le format AAAA-MM-JJ.')
    if end < start or (end - start).days >= 730:
        p.error('Choisis une période ordonnée de 730 jours maximum.')
    return start, end


def _fact(activity, day, duration, kind='unknown', quantity=0, unit=None, attempts=None, sessions=0, resource=None, unknown=None):
    return {'activity': 'puzzles' if activity == 'storm' else activity, 'date': day,
            'duration_ms': duration, 'duration_kind': kind, 'quantity': quantity, 'unit': unit,
            'attempts': attempts, 'sessions': sessions, 'resource': resource,
            'unknown': duration is None if unknown is None else unknown}


def _native_facts(conn, user_id, lower, upper):
    """Project old source measurements, subtracting their *lifetime* credits.

    A registered new source uses credits exclusively: clocks and measured active
    time are not interchangeable. Legacy counters may have a pre-ledger baseline;
    only that baseline is added, once, at the source's recorded date.
    """
    import training_history
    sources, args = training_history._sources(conn, user_id, 'all')
    if not sources:
        return []
    coverage = {(row['tool'], row['source_id']): dict(row) for row in conn.execute('''
        SELECT a.tool,a.source_id,SUM(c.duration_ms) duration_ms,SUM(c.quantity) quantity,SUM(c.attempts) attempts,
        COUNT(*) credits FROM training_activity_links a JOIN training_activity_credits c ON c.activity_id=a.id
        WHERE a.user_id=? AND a.source_key NOT LIKE 'episode:%' GROUP BY a.tool,a.source_id''', (user_id,))}
    native = {(row['tool'], row['source_id']): dict(row) for row in conn.execute(
        'SELECT * FROM training_native_sources WHERE user_id=?', (user_id,))}
    day_settings = review_preferences.read(conn)['study_day']
    # Wide UTC envelope, followed by the configured local study-day boundary.
    lo = datetime.combine(lower - timedelta(days=2), datetime.min.time(), timezone.utc).timestamp() * 1000
    hi = datetime.combine(upper + timedelta(days=3), datetime.min.time(), timezone.utc).timestamp() * 1000
    query = 'SELECT * FROM (' + ' UNION ALL '.join(sources) + ') WHERE COALESCE(finished_ms,started_ms)>=? AND COALESCE(finished_ms,started_ms)<?'
    result, seen = [], set()
    for row in conn.execute(query, [*args, lo, hi]):
        item = dict(row)
        key = item['tool'], item['id']
        seen.add(key)
        timestamp = item['finished_ms'] if item['finished_ms'] is not None else item['started_ms']
        day = review_preferences.study_date(datetime.fromtimestamp(timestamp / 1000, timezone.utc), day_settings)
        if not lower <= day <= upper:
            continue
        source, covered = native.get(key), coverage.get(key)
        resource = json.loads(source['resource']) if source else None
        metrics = json.loads(item['metrics'])
        if not resource and metrics.get('base_id') is not None:
            resource = a._resource(conn, metrics['base_id']) or {'type': 'base', 'id': metrics['base_id'], 'name': metrics.get('base_name') or 'Deleted database'}
        if not resource and metrics.get('entry_id') is not None:
            entry = conn.execute('SELECT base_id FROM entries WHERE id=?', (metrics['entry_id'],)).fetchone()
            resource = a._resource(conn, entry['base_id']) if entry else None
        finished = item['status'] == 'completed'
        # Planned runs have one explicit episode-completion credit. Free native
        # sessions count at native completion and never acquire that second one.
        session = int(finished and item['tool'] not in ('review', 'puzzles', 'reading') and not (source and source['run_id']))
        if source and not source['legacy']:
            if session:
                result.append(_fact(item['tool'], day.isoformat(), None, sessions=session, resource=resource, unknown=False))
            continue
        if item['tool'] == 'review' and covered:
            continue
        duration = source['duration_ms'] if source else item['duration_ms']
        attempts = source['attempts'] if source else (item['total_count'] if item['tool'] == 'storm' else item['completed_count'])
        unit = p.NATIVE_UNITS.get('puzzles' if item['tool'] == 'storm' else item['tool'])
        quantity = source['quantity'] if source else (int(finished) if unit == 'games' and item['tool'] != 'reading' else 0 if item['tool'] == 'reading' else attempts or 0)
        if covered:
            duration = max(0, duration - (covered['duration_ms'] or 0)) if duration is not None else None
            quantity = max(0, quantity - (covered['quantity'] or 0))
            attempts = max(0, attempts - (covered['attempts'] or 0)) if attempts is not None else None
            if not duration and not quantity and not attempts and not session:
                continue
        result.append(_fact(item['tool'], day.isoformat(), duration, item['duration_kind'], quantity, unit, attempts, session, resource))
    # Retain a legacy baseline even if its native row was subsequently removed.
    for key, source in native.items():
        if key in seen or not source['legacy']:
            continue
        if conn.execute('SELECT 1 FROM (' + ' UNION ALL '.join(sources) + ') WHERE tool=? AND id=? LIMIT 1', [*args, *key]).fetchone():
            continue
        day = review_preferences.study_date(datetime.fromisoformat(source['created_at']), day_settings)
        if not lower <= day <= upper:
            continue
        covered = coverage.get(key, {})
        duration = max(0, source['duration_ms'] - (covered.get('duration_ms') or 0)) if source['duration_ms'] is not None else None
        quantity = max(0, source['quantity'] - (covered.get('quantity') or 0))
        attempts = max(0, source['attempts'] - (covered.get('attempts') or 0)) if source['attempts'] is not None else None
        result.append(_fact(source['tool'], day.isoformat(), duration, 'elapsed', quantity,
                            p.NATIVE_UNITS.get('puzzles' if source['tool'] == 'storm' else source['tool']), attempts,
                            resource=json.loads(source['resource'])))
    return result


def facts(conn, user_id, lower, upper):
    result = []
    for row in conn.execute('''SELECT c.*,a.tool,a.resource FROM training_activity_credits c
            JOIN training_activity_links a ON a.id=c.activity_id
            WHERE a.user_id=? AND c.study_date>=? AND c.study_date<=?''', (user_id, lower.isoformat(), upper.isoformat())):
        result.append(_fact(row['tool'], row['study_date'], row['duration_ms'], row['duration_kind'], row['quantity'], row['unit'], row['attempts'],
                            resource=json.loads(row['resource']) if row['resource'] else None,
                            unknown=row['duration_ms'] is None and row['unit'] != 'sessions'))
    for row in conn.execute('''SELECT * FROM training_manual_activities
            WHERE user_id=? AND deleted=0 AND date>=? AND date<=?''', (user_id, lower.isoformat(), upper.isoformat())):
        result.append(_fact(row['activity'] or 'external', row['date'], row['duration_ms'], 'declared', row['quantity'], row['unit'], sessions=row['sessions']))
    import training_games
    return result + _native_facts(conn, user_id, lower, upper) + training_games.facts(conn, user_id, lower, upper)


def _empty():
    return {**a._totals(), 'duration_ms': 0, 'unknown_duration_count': 0, '_known': 0}


def _add(total, fact):
    a._add(total, fact['duration_ms'], fact['duration_kind'], fact['quantity'], fact['unit'], fact['attempts'])
    total['sessions'] += fact['sessions']
    total['unknown_duration_count'] += int(fact['unknown'])
    total['_known'] += int(fact['duration_ms'] is not None)


def _finish(total):
    if not total.pop('_known') and total['unknown_duration_count']:
        total['duration_ms'] = None
    return total


def projection(conn, user_id, lower, upper):
    days = {(lower + timedelta(days=n)).isoformat(): {activity: _empty() for activity in p.ACTIVITIES}
            for n in range((upper - lower).days + 1)}
    categories = {activity: _empty() for activity in p.ACTIVITIES}
    resources = {activity: {} for activity in p.ACTIVITIES}
    total = _empty()
    for fact in facts(conn, user_id, lower, upper):
        activity = fact['activity'] if fact['activity'] in categories else 'external'
        _add(total, fact)
        _add(categories[activity], fact)
        _add(days[fact['date']][activity], fact)
        resource = fact['resource'] or {'type': 'tool', 'id': activity, 'name': TITLES[activity]}
        key = (resource['type'], str(resource.get('id', resource.get('name', ''))), resource.get('generation'))
        entry = resources[activity].setdefault(key, {'resource': resource, 'progress': _empty(), 'days': {}})
        _add(entry['progress'], fact)
        _add(entry['days'].setdefault(fact['date'], _empty()), fact)
    for values in categories.values():
        _finish(values)
    for values in days.values():
        for counts in values.values():
            _finish(counts)
    for entries in resources.values():
        for entry in entries.values():
            _finish(entry['progress'])
            for values in entry['days'].values():
                _finish(values)
    return {'totals': _finish(total), 'categories': categories, 'days': days, 'resources': resources}


def _day_totals(values):
    total = _empty()
    for counts in values.values():
        total['duration_ms'] += counts['duration_ms'] or 0
        total['unknown_duration_count'] += counts['unknown_duration_count']
        total['_known'] += int(counts['duration_ms'] is not None and (counts['duration_ms'] > 0 or not counts['unknown_duration_count']))
        for unit in ('cards', 'games', 'positions', 'sessions'):
            total[unit] += counts[unit]
        if counts['attempts'] is not None:
            total['attempts'] = (total['attempts'] or 0) + counts['attempts']
        for kind, duration in counts['duration_by_kind'].items():
            total['duration_by_kind'][kind] = total['duration_by_kind'].get(kind, 0) + duration
    # Empty categories are not evidence of known time in a different category.
    if total['unknown_duration_count'] and not total['duration_by_kind']:
        total['_known'] = 0
    return _finish(total)


def statistics(conn, user_id, date_from=None, date_to=None):
    lower, upper = _range(conn, date_from, date_to)
    data = projection(conn, user_id, lower, upper)
    return {'date_from': lower.isoformat(), 'date_to': upper.isoformat(), 'totals': data['totals'],
            'categories': [{'id': activity, 'activity': activity, 'title': TITLES[activity], **values}
                           for activity, values in data['categories'].items()],
            'days': [{'date': day, **_day_totals(values),
                      'by_activity': {activity: counts['duration_ms'] for activity, counts in values.items()},
                      'by_activity_duration_by_kind': {activity: counts['duration_by_kind'] for activity, counts in values.items()},
                      'by_activity_unknown': {activity: counts['unknown_duration_count'] for activity, counts in values.items()}}
                     for day, values in data['days'].items()]}


def _progress(values, target):
    realized = (values['duration_ms'] or 0) / 60000
    return {**values, 'realized': realized, 'target': target, 'remaining': max(0, target - realized),
            'complete': target > 0 and realized >= target, 'has_goal': target > 0}


def overview(conn, user_id):
    start, study_day = p.current_week(conn)
    lower = date.fromisoformat(start)
    upper = lower + timedelta(days=6)
    today = review_preferences.study_date(p.now(), study_day).isoformat()
    data = projection(conn, user_id, lower, upper)
    program, week = _active_week(conn, user_id)
    blocks = week['blocks'] if week else []
    goals = _goals(conn, user_id, blocks)
    runs = a.active_runs(conn, user_id)
    categories = []
    for activity in p.ACTIVITIES:
        goal = goals[activity]
        categories.append({'id': activity, 'activity': activity, 'title': TITLES[activity], **goal,
                           'progress': _progress(data['categories'][activity], goal['target_minutes']),
                           'today': _progress(data['days'][today][activity], goal['daily_target_minutes']),
                           'blocks': [b for b in blocks if b['activity'] == activity],
                           'resources': [{'resource': entry['resource'], **entry['progress'], 'progress': entry['progress'],
                                          'today': entry['days'].get(today, _finish(_empty()))}
                                         for entry in data['resources'][activity].values()],
                           'active_runs': [run for run in runs if run['activity'] == activity]})
    return {'week_start': start, 'week_end': upper.isoformat(), **data['totals'], 'totals': data['totals'],
            'today': {'date': today, **_day_totals(data['days'][today])},
            'days': [{'date': day, **_day_totals(values)} for day, values in data['days'].items()],
            'categories': categories, 'active_program': program, 'active_week': week, 'active_runs': runs,
            'planned_minutes': sum(goal['target_minutes'] for goal in goals.values()),
            'daily_planned_minutes': sum(goal['daily_target_minutes'] for goal in goals.values()),
            'manual_activities': [item for item in a.manual_list(conn, user_id) if start <= item['date'] <= upper.isoformat()]}


def category_launch(conn, user_id, activity, payload, run=None):
    scope = payload.get('goal_scope', 'free')
    if scope not in ('today', 'week', 'free'):
        p.error('Choisis la journée, la semaine ou une séance libre.')
    category = next(item for item in overview(conn, user_id)['categories'] if item['id'] == activity)
    values = category['today'] if scope == 'today' else category['progress']
    free = scope == 'free' or values['target'] == 0
    launch = {**(run['launch'] if run else {}), 'activity': activity, 'category_id': activity,
              'base_id': payload.get('base_id', run['launch'].get('base_id') if run else None),
              'minutes': None, 'automatic': activity in p.AUTOMATIC, 'options': run['block'].get('options', {}) if run else {}, 'free': free}
    launch.pop('goal', None)
    launch.pop('review_goal', None)
    if not free:
        if values['remaining'] <= 0:
            p.error('L’objectif choisi est déjà atteint. Une séance libre reste disponible.', 409)
        baseline = a.run_document(conn, user_id, run['id']) if run else {}
        start, settings = p.current_week(conn)
        launch['goal'] = {'scope': scope, 'study_date': review_preferences.study_date(p.now(), settings).isoformat(),
                          'week_start': start, 'metric': 'minutes', 'unit': 'minutes', 'target': values['target'],
                          'realized': values['realized'], 'remaining': values['remaining'],
                          'baseline_duration_ms': baseline.get('duration_ms') or 0,
                          'baseline_quantity': baseline.get('quantity') or 0, 'baseline_sessions': baseline.get('sessions') or 0}
        launch['minutes'] = values['remaining']
    if run and activity == 'review' and run['native_ref']:
        import review_sessions
        # A free goal clears both native thresholds while retaining all answers.
        native_goal = launch.get('goal') or {'metric': 'free', 'unit': 'minutes', 'remaining': 1}
        launch['review_goal'] = review_sessions.retarget_training_goal(conn, run['id'], run['native_ref']['id'], native_goal)
    return launch


def create_run(conn, user_id, activity, payload):
    checked_activity(activity)
    if activity not in p.AUTOMATIC:
        p.error('Ouvre cette activité directement ou ajoute une déclaration de temps.')
    if payload.get('run_id'):
        run = a._run_row(conn, user_id, payload['run_id'])
        if run['activity'] != activity or run['state'] in ('completed', 'cancelled'):
            p.error('Cette séance ne peut pas être reprise dans cette catégorie.', 409)
        if payload.get('expected_revision') is not None:
            p.revision(run, payload['expected_revision'])
        if payload.get('base_id') is not None and payload['base_id'] != run['launch'].get('base_id'):
            p.error('Reprends la même ressource pour conserver cette séance.', 409)
        launch = category_launch(conn, user_id, activity, payload, run)
        conn.execute("UPDATE training_runs SET launch=?,state=?,revision=revision+1 WHERE id=?",
                     (p.encode(launch), 'active' if run['native_ref'] or a._real_work(conn, user_id, run['id']) else 'preparing', run['id']))
        return a.run_document(conn, user_id, run['id'])
    resource = None
    if payload.get('base_id') is not None:
        base_id = p.number(payload['base_id'], 'base', low=1, integer=True)
        resource = next((item for item in p.resource_catalog(conn) if item['type'] == 'base' and item['id'] == base_id and activity in item['activities']), None)
        if resource is None:
            p.error('Cette base ne permet pas cette activité.', 409)
        resource = {key: resource[key] for key in ('type', 'id', 'name', 'generation')}
    if activity == 'reading' and resource is None:
        p.error('Choisis une base de lecture.')
    launch = category_launch(conn, user_id, activity, payload)
    week = category_week(conn, user_id)
    block = category_block(activity, resource)
    identity = p.uid()
    conn.execute('''INSERT INTO training_runs VALUES(?,?,?,?,?,?,?, ?,1,'preparing',NULL,?,?,NULL)''',
                 (identity, user_id, week['id'], week['program_id'], block['id'], p.encode(block), p.signature(block),
                  activity, p.encode(launch), p.stamp()))
    return a.run_document(conn, user_id, identity)
