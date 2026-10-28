"""Automatic attribution and explicit, evidence-based program assistance."""
from __future__ import annotations
import copy
import json
import statistics
from datetime import date, timedelta
import training_programs as p


def init_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS training_assistance_settings (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        auto_assign INTEGER NOT NULL DEFAULT 1,revision INTEGER NOT NULL DEFAULT 1)''')


def settings(conn, user_id):
    row = conn.execute('SELECT auto_assign,revision FROM training_assistance_settings WHERE user_id=?', (user_id,)).fetchone()
    return {'auto_assign': bool(row['auto_assign']), 'revision': row['revision']} if row else {'auto_assign': True, 'revision': 0}


def update_settings(conn, user_id, payload):
    old = settings(conn, user_id)
    p.revision(old, payload.get('expected_revision'))
    enabled = payload.get('auto_assign')
    if type(enabled) is not bool:
        p.error('Le choix d’attribution automatique doit être oui ou non.')
    conn.execute('''INSERT INTO training_assistance_settings(user_id,auto_assign,revision) VALUES(?,?,1)
        ON CONFLICT(user_id) DO UPDATE SET auto_assign=excluded.auto_assign,revision=revision+1''', (user_id, int(enabled)))
    return settings(conn, user_id)


def candidates(conn, user_id, activity):
    if activity['run_id'] or activity['program_id'] or activity['origin'] != 'free':
        return []
    program = p.active_program(conn, user_id)
    if program is None:
        return []
    start, _ = p.current_week(conn)
    row = conn.execute('SELECT id FROM training_weeks WHERE user_id=? AND program_id=? AND week_start=?', (user_id, program['id'], start)).fetchone()
    if row is None:
        return []
    if not conn.execute('SELECT 1 FROM training_activity_credits WHERE activity_id=? AND week_start=?', (activity['id'], start)).fetchone():
        return []
    week = p.week_row(conn, user_id, row['id'])
    import training_activity
    matches = [block for block in week['definition']['blocks'] if training_activity.compatible_block(block, activity)]
    # A configured block must match the recorded native configuration. Never
    # infer a puzzle selection or opponent from the tool name alone.
    if activity['source_key'].startswith('native:'):
        native = conn.execute('SELECT options FROM training_native_sources WHERE user_id=? AND tool=? AND source_id=?', (user_id, activity['tool'], activity['source_id'])).fetchone()
        actual = json.loads(native['options']) if native else {}
        def contains(expected, observed):
            return all(key in observed and (contains(value, observed[key]) if isinstance(value, dict) and isinstance(observed[key], dict) else value == observed[key]) for key, value in expected.items())
        matches = [block for block in matches if contains(block.get('options', {}), actual)]
    return [(program['id'], block['id'], p.signature(block)) for block in matches]


def auto_assign_link(conn, user_id, identity, *, force=False):
    if not force and not settings(conn, user_id)['auto_assign']:
        return False
    activity = conn.execute('SELECT * FROM training_activity_links WHERE user_id=? AND id=?', (user_id, identity)).fetchone()
    if activity is None:
        return False
    matches = candidates(conn, user_id, activity)
    if len(matches) != 1:
        return False
    program_id, block_id, signature = matches[0]
    conn.execute("UPDATE training_activity_links SET program_id=?,block_id=?,signature=?,origin='automatic',revision=revision+1 WHERE id=?", (program_id, block_id, signature, identity))
    return True


def assign_unique(conn, user_id):
    identities = [row['id'] for row in conn.execute("SELECT id FROM training_activity_links WHERE user_id=? AND block_id IS NULL AND origin='free'", (user_id,))]
    assigned = sum(auto_assign_link(conn, user_id, identity, force=True) for identity in identities)
    return {'assigned': assigned, 'remaining': len(identities) - assigned}


def suggestions(conn, user_id):
    result = []
    current, _ = p.current_week(conn)
    lower = (date.fromisoformat(current) - timedelta(weeks=8)).isoformat()
    for program in p.list_programs(conn, user_id):
        if program['status'] == 'archived':
            continue
        for block in program['definition']['blocks']:
            signature = p.signature(block)
            rows = conn.execute('''SELECT c.duration_ms,c.quantity,c.unit,c.duration_kind,c.week_start,a.run_id,a.id activity_id
                FROM training_activity_links a JOIN training_activity_credits c ON c.activity_id=a.id
                WHERE a.user_id=? AND a.program_id=? AND a.block_id=? AND a.signature=? AND c.week_start>=?''',
                (user_id, program['id'], block['id'], signature, lower)).fetchall()
            known = [row for row in rows if row['duration_ms'] is not None]
            by_run = {}
            for row in known:
                if row['run_id']:
                    by_run[row['run_id']] = by_run.get(row['run_id'], 0) + row['duration_ms']
            completed = [milliseconds / 60000 for run_id, milliseconds in by_run.items()
                         if milliseconds > 0 and conn.execute("SELECT 1 FROM training_runs WHERE id=? AND state='completed'", (run_id,)).fetchone()]
            estimates = []
            if len(completed) >= 3:
                estimates.append(('session_minutes', max(1, min(480, round(statistics.median(completed)))), len(completed), 'Durée médiane des épisodes terminés'))
            paired = {}
            for row in rows:
                key = row['run_id'] or row['activity_id']
                group = paired.setdefault(key, {'duration': 0, 'known': False, 'quantity': 0})
                if row['duration_ms'] is not None:
                    group['duration'] += row['duration_ms']
                    group['known'] = True
                if row['unit'] == block['unit']:
                    group['quantity'] += row['quantity']
            measured = [group for group in paired.values() if group['known'] and group['quantity'] > 0]
            quantity = sum(group['quantity'] for group in measured)
            if quantity >= 3:
                unit_minutes = sum(group['duration'] for group in measured) / 60000 / quantity
                if unit_minutes > 0:
                    estimates.append(('unit_minutes', max(.01, min(1440, round(unit_minutes, 2))), quantity, 'Durée renseignée par unité travaillée'))
            by_week = {}
            for row in rows:
                if row['week_start'] >= current:
                    continue
                value = (row['duration_ms'] or 0) / 60000 if block['metric'] == 'minutes' else row['quantity'] if row['unit'] == ('sessions' if block['metric'] == 'sessions' else block['unit']) else 0
                by_week[row['week_start']] = by_week.get(row['week_start'], 0) + value
            observed = [value for value in by_week.values() if value > 0]
            if len(observed) >= 2:
                proposed = max(.01, min(100000, round(statistics.median(observed), 2)))
                if abs(proposed - block['target']) / max(block['target'], .01) >= .2:
                    estimates.append(('target', proposed, len(observed), 'Volume médian réellement enregistré sur les semaines précédentes'))
            for field, proposed, samples, reason in estimates:
                old = block.get(field)
                if old is not None and abs(old - proposed) < max(.01, old * .1):
                    continue
                result.append({'program_id': program['id'], 'program_revision': program['revision'], 'block_id': block['id'],
                               'title': block['title'], 'field': field, 'current': old, 'proposed': proposed,
                               'samples': samples, 'reason': reason, 'duration_kinds': sorted({row['duration_kind'] for row in known})})
    return result


def overview(conn, user_id):
    activities = conn.execute("SELECT * FROM training_activity_links WHERE user_id=? AND block_id IS NULL AND origin='free'", (user_id,)).fetchall()
    return {'settings': settings(conn, user_id), 'suggestions': suggestions(conn, user_id),
            'unambiguous_count': sum(len(candidates(conn, user_id, item)) == 1 for item in activities)}


def apply_suggestion(conn, user_id, payload):
    program = p.get_program(conn, user_id, payload.get('program_id'))
    p.revision(program, payload.get('expected_revision'))
    candidate = next((item for item in suggestions(conn, user_id) if item['program_id'] == program['id']
                      and item['block_id'] == payload.get('block_id') and item['field'] == payload.get('field')
                      and item['proposed'] == payload.get('proposed')), None)
    if candidate is None:
        p.error('Cette suggestion a changé. Recharge les propositions avant de l’appliquer.', 409)
    definition = copy.deepcopy(program['definition'])
    block = next(block for block in definition['blocks'] if block['id'] == candidate['block_id'])
    block[candidate['field']] = candidate['proposed']
    return p.save_program(conn, user_id, {'name': program['name'], 'definition': definition,
        'expected_revision': program['revision'], 'apply_to_current': payload.get('apply_to_current', False)}, program['id'])


def duplicate_week(conn, user_id, week_id, payload):
    week = p.week_row(conn, user_id, week_id)
    p.revision(week, payload.get('expected_revision'))
    definition = copy.deepcopy(week['definition'])
    for block in definition['blocks']:
        block['id'] = p.uid()
    return p.save_program(conn, user_id, {'name': payload.get('name') or week['name'] + ' — copie', 'definition': definition})
