"""Personal training definitions and weekly snapshots; no native exercise state.

Service functions participate in the caller's SQLite transaction. Reads never
create weeks; program edits leave existing weeks unchanged unless requested.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from datetime import date, datetime, timedelta, timezone
from uuid import uuid4

from fastapi import HTTPException
import review_preferences

ACTIVITIES = ('review', 'reading', 'puzzles', 'guess', 'computer', 'games', 'analysis', 'external', 'blindfold', 'coordinates', 'color')
AUTOMATIC = ('review', 'reading', 'puzzles', 'guess', 'computer', 'blindfold', 'coordinates', 'color')
# Derived activities are followed automatically, but never launch native runs.
DERIVED = ('games',)
NATIVE_UNITS = {'review': 'cards', 'reading': 'games', 'puzzles': 'positions', 'guess': 'games', 'computer': 'games', 'games': 'games', 'blindfold': 'positions', 'coordinates': 'positions', 'color': 'positions'}
TOOL_NAMES = {'puzzles': 'Puzzles et Storm', 'guess': 'Deviner le coup', 'computer': 'Jouer contre l’ordinateur', 'games': 'Mes parties', 'blindfold': 'À l’aveugle', 'coordinates': 'Coordonnées', 'color': 'Color'}


def tool_resource(activity):
    return {'type': 'tool', 'id': activity, 'name': TOOL_NAMES[activity], 'generation': 'tool-v1'}
UNITS = ('cards', 'games', 'positions', 'sessions')


def now():
    return datetime.now(timezone.utc)


def stamp(value=None):
    return (value or now()).isoformat(timespec='milliseconds')


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def uid():
    return str(uuid4())


def error(message, code=422):
    raise HTTPException(code, message)


def text(value, name, *, maximum=200, empty=False):
    if not isinstance(value, str) or len(value) > maximum or (not empty and not value.strip()):
        error('Texte invalide : ' + name)
    return value.strip()


def number(value, name, *, low=0, high=100000, nullable=False, integer=False):
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high or (integer and int(value) != value):
        error('Valeur hors limites : ' + name)
    return int(value) if integer else value


def revision(row, expected):
    if type(expected) is not int or expected != row['revision']:
        error('Cette version a changé sur un autre appareil. Recharge-la en conservant ton brouillon.', 409)


def init_schema(conn):
    statements = [
        '''CREATE TABLE IF NOT EXISTS training_programs (
            id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',revision INTEGER NOT NULL,
            definition TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)''',
        "CREATE UNIQUE INDEX IF NOT EXISTS training_one_active ON training_programs(user_id) WHERE status='active'",
        '''CREATE TABLE IF NOT EXISTS training_pending_activation (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            program_id TEXT NOT NULL REFERENCES training_programs(id),effective_date TEXT NOT NULL)''',
        '''CREATE TABLE IF NOT EXISTS training_weeks (
            id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            program_id TEXT NOT NULL REFERENCES training_programs(id),name TEXT NOT NULL,
            week_start TEXT NOT NULL,revision INTEGER NOT NULL,program_revision INTEGER NOT NULL,
            definition TEXT NOT NULL,study_day TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
            UNIQUE(user_id,program_id,week_start))''',
        '''CREATE TABLE IF NOT EXISTS training_runs (
            id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            week_id TEXT NOT NULL REFERENCES training_weeks(id),program_id TEXT NOT NULL,
            block_id TEXT NOT NULL,block TEXT NOT NULL,signature TEXT NOT NULL,activity TEXT NOT NULL,
            revision INTEGER NOT NULL,state TEXT NOT NULL,native_ref TEXT,launch TEXT NOT NULL,
            started_at TEXT NOT NULL,finished_at TEXT)''',
        'CREATE INDEX IF NOT EXISTS training_runs_owner_state ON training_runs(user_id,state)',
        '''CREATE TABLE IF NOT EXISTS training_activity_links (
            id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            source_key TEXT NOT NULL,tool TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,
            resource TEXT,signature TEXT,run_id TEXT REFERENCES training_runs(id),
            program_id TEXT,block_id TEXT,origin TEXT NOT NULL,revision INTEGER NOT NULL,
            review_history_id INTEGER REFERENCES review_history(id) ON DELETE SET NULL,
            created_at TEXT NOT NULL,UNIQUE(user_id,source_key))''',
        'CREATE UNIQUE INDEX IF NOT EXISTS training_review_source ON training_activity_links(review_history_id) WHERE review_history_id IS NOT NULL',
        '''CREATE TABLE IF NOT EXISTS training_activity_credits (
            id TEXT PRIMARY KEY,activity_id TEXT NOT NULL REFERENCES training_activity_links(id),
            event_key TEXT NOT NULL,duration_ms INTEGER,duration_kind TEXT NOT NULL,
            quantity REAL NOT NULL DEFAULT 0,unit TEXT,recorded_at TEXT NOT NULL,
            study_date TEXT NOT NULL,week_start TEXT NOT NULL,study_day TEXT NOT NULL,
            rule_version INTEGER NOT NULL DEFAULT 1,unit_key TEXT,attempts INTEGER,UNIQUE(activity_id,event_key))''',
        'CREATE INDEX IF NOT EXISTS training_credit_week ON training_activity_credits(week_start,activity_id)',
        '''CREATE TABLE IF NOT EXISTS training_manual_activities (
            id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            program_id TEXT NOT NULL,block_id TEXT NOT NULL,signature TEXT NOT NULL,
            week_id TEXT NOT NULL REFERENCES training_weeks(id),date TEXT NOT NULL,
            duration_ms INTEGER,quantity REAL NOT NULL,sessions INTEGER NOT NULL,
            title TEXT NOT NULL,note TEXT NOT NULL,revision INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL)''',
        '''CREATE TABLE IF NOT EXISTS training_manual_history (
            id INTEGER PRIMARY KEY,activity_id TEXT NOT NULL,revision INTEGER NOT NULL,
            snapshot TEXT NOT NULL,recorded_at TEXT NOT NULL)''',
        '''CREATE TABLE IF NOT EXISTS training_templates (
            id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            name TEXT NOT NULL,revision INTEGER NOT NULL,definition TEXT NOT NULL,
            created_at TEXT NOT NULL,updated_at TEXT NOT NULL)''',
        '''CREATE TABLE IF NOT EXISTS training_mutation_receipts (
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            mutation_id TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT NOT NULL,
            created_at TEXT NOT NULL,PRIMARY KEY(user_id,mutation_id))''',
        '''CREATE TABLE IF NOT EXISTS training_resource_identity (
            base_id INTEGER PRIMARY KEY REFERENCES bases(id) ON DELETE CASCADE,
            generation TEXT NOT NULL UNIQUE)''',
        '''CREATE TRIGGER IF NOT EXISTS training_base_identity AFTER INSERT ON bases BEGIN
            INSERT OR IGNORE INTO training_resource_identity(base_id,generation) VALUES(NEW.id,lower(hex(randomblob(16))));
            END''',
        '''INSERT OR IGNORE INTO training_resource_identity(base_id,generation)
            SELECT id,lower(hex(randomblob(16))) FROM bases''',
    ]
    for statement in statements:
        conn.execute(statement)
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(training_activity_credits)')}
    if 'unit_key' not in columns:
        conn.execute('ALTER TABLE training_activity_credits ADD COLUMN unit_key TEXT')
    if 'attempts' not in columns:
        conn.execute('ALTER TABLE training_activity_credits ADD COLUMN attempts INTEGER')
        # Recover only counts established by the old ledger. A finished game
        # cannot tell us how many guess-the-move answers were submitted.
        conn.execute('''UPDATE training_activity_credits SET attempts=CASE
            WHEN event_key='answer' AND activity_id IN
                (SELECT id FROM training_activity_links WHERE tool='review') THEN 1
            WHEN unit='positions' THEN CAST(quantity AS INTEGER) END''')
    conn.execute('CREATE INDEX IF NOT EXISTS training_credit_unit_key ON training_activity_credits(unit_key) WHERE quantity>0')
    import training_native
    import training_assistance
    training_native.init_schema(conn)
    training_assistance.init_schema(conn)
    import training_categories
    training_categories.init_schema(conn)


def resource_catalog(conn):
    result = []
    for row in conn.execute('''SELECT b.*,i.generation,
            EXISTS(SELECT 1 FROM reference_bases r WHERE r.base_id=b.id) reference,
            (SELECT COUNT(*) FROM entries e WHERE e.base_id=b.id) entry_count
            FROM bases b LEFT JOIN training_resource_identity i ON i.base_id=b.id ORDER BY b.name,b.id'''):
        settings = json.loads(row['settings'])
        activities = ['analysis']
        if settings.get('guess_enabled') is True:
            activities.append('guess')
        if not row['reference']:
            activities.append('blindfold')
            if settings.get('review_enabled'):
                activities.append('review')
            if settings.get('reading_enabled'):
                activities.append('reading')
        result.append({'type': 'base', 'id': row['id'], 'name': row['name'],
                       'generation': row['generation'], 'activities': activities,
                       'available': True, 'entry_count': row['entry_count'], 'reference': bool(row['reference'])})
    result.extend({**tool_resource(activity), 'activities': [activity], 'available': True, 'entry_count': None, 'reference': False} for activity in TOOL_NAMES)
    return result


def resource_index(conn):
    """One request-local snapshot for checking a whole set of training blocks."""
    return {resource['id']: resource for resource in resource_catalog(conn)}


def checked_definition(conn, value):
    if not isinstance(value, dict) or set(value) - {'schema_version', 'budget_minutes', 'intention', 'blocks'} or type(value.get('schema_version', 1)) is not int or value.get('schema_version', 1) != 1:
        error('Définition de programme inconnue.')
    blocks = value.get('blocks', [])
    if not isinstance(blocks, list) or len(blocks) > 100:
        error('Un programme contient au maximum 100 blocs.')
    catalog = resource_index(conn)
    output, identities = [], set()
    for block in blocks:
        allowed = {'id', 'title', 'axis', 'activity', 'resource', 'metric', 'target', 'unit', 'session_minutes', 'unit_minutes', 'priority', 'notes', 'options'}
        if not isinstance(block, dict) or set(block) - allowed:
            error('Champs de bloc inconnus.')
        identity = text(block.get('id'), 'identifiant', maximum=160)
        if identity in identities:
            error('Chaque bloc doit avoir un identifiant distinct.')
        identities.add(identity)
        activity, metric, unit = block.get('activity'), block.get('metric'), block.get('unit', 'cards')
        if activity not in ACTIVITIES or metric not in ('minutes', 'sessions', 'quantity') or unit not in UNITS:
            error('Activité, objectif ou unité inconnu.')
        if metric == 'quantity' and activity == 'review' and unit != 'cards':
            error('Les révisions mesurent une quantité de cartes.')
        if metric == 'quantity' and activity == 'reading' and unit != 'games':
            error('La lecture mesure une quantité de parties étudiées.')
        if activity in ('review', 'reading'):
            unit = 'cards' if activity == 'review' else 'games'
        resource = block.get('resource', {'type': 'external', 'name': ''})
        if not isinstance(resource, dict) or set(resource) - {'type', 'id', 'name', 'generation'} or resource.get('type') not in ('base', 'external', 'tool'):
            error('Ressource invalide.')
        if activity in DERIVED:
            if resource.get('type') != 'tool' or resource.get('id') != activity:
                error('Games utilise automatiquement les parties de My Games.')
            if metric == 'sessions':
                error('Games mesure du temps ou un nombre de parties.')
        resource = dict(resource)
        if resource['type'] == 'base':
            bid = number(resource.get('id'), 'base', low=1, high=9223372036854775807, integer=True)
            current = catalog.get(bid)
            generation = resource.get('generation')
            if generation is not None:
                text(generation, 'identité de ressource', maximum=100)
            if current and generation in (None, current['generation']):
                resource = {key: current[key] for key in ('type', 'id', 'name', 'generation')}
            else:
                resource = {'type': 'base', 'id': bid, 'name': text(resource.get('name', 'Ressource indisponible'), 'ressource'), 'generation': generation or 'missing:' + uid()}
        elif resource['type'] == 'tool':
            if resource.get('id') != activity or activity not in TOOL_NAMES:
                error('Cet outil ne correspond pas à l’activité du bloc.')
            resource = tool_resource(activity)
        else:
            resource = {'type': 'external', 'name': text(resource.get('name', ''), 'ressource', maximum=500, empty=True)}
        if resource['type'] != 'external' and activity in NATIVE_UNITS:
            expected_unit = NATIVE_UNITS[activity]
            if metric == 'quantity' and unit != expected_unit:
                error('Cette activité mesure la quantité en ' + expected_unit + '.')
            unit = expected_unit
        import training_native_options
        options = training_native_options.checked(activity, block.get('options', {}))
        priority = block.get('priority', 'normal')
        if priority not in ('essential', 'normal', 'optional'):
            error('Priorité inconnue.')
        output.append({'id': identity, 'title': text(block.get('title'), 'nom du bloc'),
                       'axis': text(block.get('axis', 'Personnel'), 'axe', maximum=80), 'activity': activity,
                       'resource': resource, 'metric': metric, 'target': number(block.get('target'), 'objectif', low=0), 'unit': unit,
                       'session_minutes': number(block.get('session_minutes'), 'durée de séance', low=1, high=480, nullable=True),
                       'unit_minutes': number(block.get('unit_minutes'), 'durée par unité', low=.01, high=1440, nullable=True),
                       'priority': priority, 'notes': text(block.get('notes', ''), 'consigne', maximum=2000, empty=True), **({'options': copy.deepcopy(options)} if options else {})})
    return {'schema_version': 1, 'budget_minutes': number(value.get('budget_minutes'), 'budget', low=1, high=10080, nullable=True),
            'intention': text(value.get('intention', ''), 'intention', maximum=2000, empty=True), 'blocks': output}


def signature(block):
    resource = block['resource']
    source = {k: resource.get(k) for k in ('type', 'id', 'generation')} if resource['type'] in ('base', 'tool') else resource
    return hashlib.sha256(encode([block['activity'], source, block['unit']]).encode()).hexdigest()


def block_status(conn, block, *, catalog=None):
    automatic = block['activity'] in AUTOMATIC + DERIVED
    resource = block['resource']
    if resource['type'] == 'tool':
        valid = automatic and resource.get('id') == block['activity'] and resource.get('generation') == 'tool-v1'
        return {'available': valid, 'automatic': valid, 'unavailable_reason': None if valid else 'Choisis un outil compatible.'}
    if block['activity'] not in ('review', 'reading') and resource['type'] == 'external':
        return {'available': True, 'automatic': False, 'unavailable_reason': None}
    if resource['type'] != 'base':
        return {'available': False, 'automatic': automatic, 'unavailable_reason': 'Choisis une base compatible.'}
    if catalog is None:
        catalog = resource_index(conn)
    current = catalog.get(resource['id'])
    if current is not None and current['generation'] != resource.get('generation'):
        current = None
    # Guess association filters new choices without invalidating saved programmes.
    available = bool(current and (block['activity'] == 'guess' or block['activity'] in current['activities'])
                     and (current['entry_count'] > 0 or current['reference']))
    return {'available': available, 'automatic': automatic,
            'unavailable_reason': None if available else 'La ressource est absente, vide ou cette activité est désactivée.'}


def planned_minutes(block):
    if block['metric'] == 'minutes':
        return block['target']
    factor = block['session_minutes'] if block['metric'] == 'sessions' else block['unit_minutes']
    return None if factor is None else block['target'] * factor


def get_program(conn, user_id, identity):
    row = conn.execute('SELECT * FROM training_programs WHERE id=? AND user_id=?', (identity, user_id)).fetchone()
    if row is None:
        error('Programme introuvable.', 404)
    return {**dict(row), 'definition': json.loads(row['definition'])}


def list_programs(conn, user_id):
    return [get_program(conn, user_id, row['id']) for row in conn.execute("SELECT id FROM training_programs WHERE user_id=? AND status!='categories' ORDER BY updated_at DESC,id", (user_id,))]


def active_program(conn, user_id):
    row = conn.execute("SELECT id FROM training_programs WHERE user_id=? AND status='active'", (user_id,)).fetchone()
    return get_program(conn, user_id, row['id']) if row else None


def save_program(conn, user_id, payload, identity=None):
    prior = get_program(conn, user_id, identity) if identity else None
    if prior:
        revision(prior, payload.get('expected_revision'))
    if type(payload.get('apply_to_current', False)) is not bool:
        error('Le choix d’application à la semaine doit être oui ou non.')
    definition = checked_definition(conn, payload.get('definition'))
    name = text(payload.get('name'), 'programme')
    timestamp = stamp()
    if prior:
        conn.execute('UPDATE training_programs SET name=?,definition=?,revision=revision+1,updated_at=? WHERE id=?', (name, encode(definition), timestamp, identity))
        if payload.get('apply_to_current'):
            week_start, _ = current_week(conn)
            rows = conn.execute('SELECT id FROM training_weeks WHERE user_id=? AND program_id=? AND week_start=?', (user_id, identity, week_start)).fetchall()
            for row in rows:
                conn.execute('UPDATE training_weeks SET name=?,definition=?,revision=revision+1,program_revision=?,updated_at=? WHERE id=?',
                             (name, encode(definition), prior['revision'] + 1, timestamp, row['id']))
    else:
        identity = uid()
        conn.execute('INSERT INTO training_programs VALUES(?,?,?,\'draft\',1,?,?,?)', (identity, user_id, name, encode(definition), timestamp, timestamp))
    return get_program(conn, user_id, identity)


def current_week(conn, at=None):
    day = review_preferences.read(conn)['study_day']
    today = review_preferences.study_date(at or now(), day)
    return (today - timedelta(days=today.weekday())).isoformat(), day


def pending_activation(conn, user_id):
    row = conn.execute('SELECT program_id,effective_date FROM training_pending_activation WHERE user_id=?', (user_id,)).fetchone()
    return dict(row) if row else None


def _make_active(conn, user_id, identity):
    conn.execute("UPDATE training_programs SET status='draft' WHERE user_id=? AND status='active' AND id!=?", (user_id, identity))
    conn.execute("UPDATE training_programs SET status='active' WHERE id=? AND user_id=?", (identity, user_id))
    conn.execute('DELETE FROM training_pending_activation WHERE user_id=?', (user_id,))


def ensure_current_week(conn, user_id):
    week_start, day = current_week(conn)
    pending = pending_activation(conn, user_id)
    if pending and pending['effective_date'] <= week_start:
        _make_active(conn, user_id, pending['program_id'])
    program = active_program(conn, user_id)
    if program is None:
        return None
    row = conn.execute('SELECT id FROM training_weeks WHERE user_id=? AND program_id=? AND week_start=?', (user_id, program['id'], week_start)).fetchone()
    if row:
        return row['id']
    identity, timestamp = uid(), stamp()
    conn.execute('INSERT INTO training_weeks VALUES(?,?,?,?,?,1,?,?,?,?,?)',
                 (identity, user_id, program['id'], program['name'], week_start, program['revision'], encode(program['definition']), encode(day), timestamp, timestamp))
    return identity


def activate(conn, user_id, identity, payload):
    program = get_program(conn, user_id, identity)
    revision(program, payload.get('expected_revision'))
    catalog = resource_index(conn)
    if not any(block_status(conn, b, catalog=catalog)['available'] for b in program['definition']['blocks']):
        error('Ajoute au moins un bloc utilisable avant d’activer le programme.')
    effective = payload.get('effective', 'now')
    if effective not in ('now', 'next_week'):
        error('Date de prise d’effet inconnue.')
    if effective == 'next_week':
        start, _ = current_week(conn)
        start = (date.fromisoformat(start) + timedelta(days=7)).isoformat()
        conn.execute('INSERT INTO training_pending_activation VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET program_id=excluded.program_id,effective_date=excluded.effective_date', (user_id, identity, start))
        return None
    _make_active(conn, user_id, identity)
    return ensure_current_week(conn, user_id)


def week_row(conn, user_id, identity):
    row = conn.execute('SELECT * FROM training_weeks WHERE id=? AND user_id=?', (identity, user_id)).fetchone()
    if row is None:
        error('Semaine introuvable.', 404)
    return {**dict(row), 'definition': json.loads(row['definition']), 'study_day': json.loads(row['study_day'])}


def find_block(week, block_id):
    block = next((block for block in week['definition']['blocks'] if block['id'] == block_id), None)
    if block is None:
        error('Ce bloc ne fait plus partie de cette semaine.', 404)
    return block


def update_week(conn, user_id, identity, payload):
    week = week_row(conn, user_id, identity)
    revision(week, payload.get('expected_revision'))
    if week['week_start'] != current_week(conn)[0]:
        error('Les objectifs des semaines passées sont conservés.', 409)
    definition = checked_definition(conn, payload.get('definition'))
    conn.execute('UPDATE training_weeks SET definition=?,revision=revision+1,updated_at=? WHERE id=?', (encode(definition), stamp(), identity))


def _builtin(name, key, specs):
    blocks = []
    for index, (title, axis, activity, metric, target, unit, minutes) in enumerate(specs):
        blocks.append({'id': key + ':' + str(index), 'title': title, 'axis': axis, 'activity': activity,
                       'resource': {'type': 'external', 'name': 'À personnaliser'}, 'metric': metric, 'target': target,
                       'unit': unit, 'session_minutes': minutes, 'unit_minutes': minutes, 'priority': 'normal', 'notes': ''})
    return {'id': 'builtin:' + key, 'name': name, 'builtin': True, 'revision': 1,
            'definition': {'schema_version': 1, 'budget_minutes': None, 'intention': '', 'blocks': blocks}}


BUILTINS = [
    _builtin('Équilibré', 'balanced', [('Calcul', 'Calcul', 'puzzles', 'minutes', 60, 'positions', 20), ('Répertoire', 'Ouvertures', 'review', 'sessions', 3, 'cards', 15), ('Lecture', 'Stratégie', 'reading', 'quantity', 2, 'games', 20)]),
    _builtin('Focus calcul', 'calculation', [('Calcul', 'Calcul', 'puzzles', 'minutes', 90, 'positions', 30), ('Reprendre mes erreurs', 'Calcul', 'review', 'minutes', 30, 'cards', 15), ('Finales', 'Finales', 'reading', 'minutes', 30, 'games', 15)]),
    _builtin('Jouer et progresser', 'play', [('Jouer', 'Parties et analyse', 'computer', 'sessions', 2, 'games', 30), ('Analyser mes parties', 'Parties et analyse', 'analysis', 'quantity', 2, 'games', 30), ('Travailler mes erreurs', 'Calcul', 'review', 'minutes', 30, 'cards', 15)]),
]


def templates(conn, user_id):
    return copy.deepcopy(BUILTINS) + [{**dict(row), 'builtin': False, 'definition': json.loads(row['definition'])}
                                    for row in conn.execute('SELECT * FROM training_templates WHERE user_id=? ORDER BY name,id', (user_id,))]


def save_template(conn, user_id, payload, identity=None):
    old = None
    if identity:
        old = conn.execute('SELECT * FROM training_templates WHERE id=? AND user_id=?', (identity, user_id)).fetchone()
        if old is None:
            error('Modèle personnel introuvable.', 404)
        revision(old, payload.get('expected_revision'))
    name, definition, timestamp = text(payload.get('name'), 'modèle'), checked_definition(conn, payload.get('definition')), stamp()
    if old:
        conn.execute('UPDATE training_templates SET name=?,definition=?,revision=revision+1,updated_at=? WHERE id=?', (name, encode(definition), timestamp, identity))
    else:
        identity = uid()
        conn.execute('INSERT INTO training_templates VALUES(?,?,?,1,?,?,?)', (identity, user_id, name, encode(definition), timestamp, timestamp))
    return next(item for item in templates(conn, user_id) if item['id'] == identity)
