"""Atomic adapters from accepted native facts to program credits.

Only creation hooks opt new occurrences in. An older occurrence first seen on an
update is baselined, never retroactively credited. Cumulative counters keep their
high-water mark across takebacks, retries and out-of-order device updates.
"""
from __future__ import annotations
import json
import hashlib
import math
import training_programs as p
import training_activity as a

TOOLS = {'puzzles': 'puzzles', 'storm': 'puzzles', 'guess': 'guess',
         'computer': 'computer', 'blindfold': 'blindfold', 'coordinates': 'coordinates', 'color': 'color'}
UNITS = {'puzzles': 'positions', 'storm': 'positions', 'guess': 'games',
         'computer': 'games', 'blindfold': 'positions', 'coordinates': 'positions', 'color': 'positions'}
NAMES = {'puzzles': 'Puzzle', 'storm': 'Puzzle Storm', 'guess': 'Deviner le coup',
         'computer': 'Partie contre l’ordinateur', 'blindfold': 'À l’aveugle', 'coordinates': 'Coordonnées', 'color': 'Color'}


def init_schema(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS training_native_sources (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tool TEXT NOT NULL,source_id TEXT NOT NULL,run_id TEXT REFERENCES training_runs(id),
        resource TEXT NOT NULL,title TEXT NOT NULL,request_id TEXT,options TEXT NOT NULL DEFAULT '{}',request_hash TEXT,legacy INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,quantity REAL NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,
        finished INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,attempts INTEGER,
        PRIMARY KEY(user_id,tool,source_id))''')
    if 'options' not in {row['name'] for row in conn.execute('PRAGMA table_info(training_native_sources)')}:
        conn.execute("ALTER TABLE training_native_sources ADD COLUMN options TEXT NOT NULL DEFAULT '{}'")
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(training_native_sources)')}
    for name, definition in [('request_hash', 'TEXT'), ('legacy', 'INTEGER NOT NULL DEFAULT 0'), ('attempts', 'INTEGER')]:
        if name not in columns:
            conn.execute('ALTER TABLE training_native_sources ADD COLUMN ' + name + ' ' + definition)
            if name == 'attempts':
                conn.execute("UPDATE training_native_sources SET attempts=CAST(quantity AS INTEGER) WHERE tool IN ('puzzles','storm','blindfold','coordinates','color')")
    conn.execute('CREATE UNIQUE INDEX IF NOT EXISTS training_native_creation_receipt ON training_native_sources(user_id,tool,request_id) WHERE request_id IS NOT NULL')
    conn.execute('CREATE INDEX IF NOT EXISTS training_native_run ON training_native_sources(run_id,finished)')


def ready(conn):
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='training_native_sources'").fetchone() is not None


def context(conn, user_id, tool, source_id):
    if not ready(conn):
        return None
    row = conn.execute('SELECT * FROM training_native_sources WHERE user_id=? AND tool=? AND source_id=?', (user_id, tool, str(source_id))).fetchone()
    return dict(row) if row else None


def run_id(conn, user_id, tool, source_id):
    item = context(conn, user_id, tool, source_id)
    return item['run_id'] if item else None


def creation(conn, user_id, tool, training_run_id=None, request_id=None, *, base_id=None, active_ids=(), request_payload=None):
    """Validate before replacing anything; return the original ID on a retry."""
    if request_id is not None:
        request_id = p.text(request_id, 'identifiant de lancement', maximum=160)
        if len(request_id) < 8:
            p.error('Identifiant de lancement trop court.')
    if not ready(conn):
        if training_run_id is not None:
            p.error('Le programme doit être initialisé avant ce lancement.', 409)
        return None
    if request_id:
        previous = conn.execute('SELECT * FROM training_native_sources WHERE user_id=? AND tool=? AND request_id=?', (user_id, tool, request_id)).fetchone()
        if previous:
            digest = hashlib.sha256(p.encode(request_payload).encode()).hexdigest() if request_payload is not None else None
            if previous['run_id'] != training_run_id or previous['request_hash'] != digest:
                p.error('Ce lancement appartient déjà à un autre épisode.', 409)
            return previous['source_id']
    if training_run_id is not None:
        run = a.validate_run(conn, user_id, training_run_id, TOOLS[tool], base_id=base_id)
        resource = run['block']['resource']
        if resource['type'] == 'base' and base_id is None:
            p.error('Choisis une partie de la base prévue pour ce bloc.', 409)
        existing = conn.execute('SELECT source_id,tool FROM training_native_sources WHERE user_id=? AND run_id=? AND finished=0 ORDER BY created_at DESC LIMIT 1', (user_id, training_run_id)).fetchone()
        if existing:
            if existing['tool'] != tool or request_id is not None:
                p.error('Reprends d’abord la séance déjà ouverte pour ce bloc.', 409)
            return existing['source_id']
        if any(active_ids):
            p.error('Une autre séance est déjà ouverte. Reprends-la ou termine-la avant de lancer ce bloc.', 409)
    return None


def register(conn, user_id, tool, source_id, *, training_run_id=None, request_id=None, base_id=None, title=None, baseline_duration=0, baseline_quantity=0, baseline_attempts=0, options=None, request_payload=None, legacy=False):
    if not ready(conn):
        return None
    old = context(conn, user_id, tool, source_id)
    if old:
        if training_run_id is not None and old['run_id'] != training_run_id:
            p.error('Cette séance appartient déjà à un autre épisode.', 409)
        return old
    run = a.validate_run(conn, user_id, training_run_id, TOOLS[tool], base_id=base_id)
    resource = a._resource(conn, base_id) if base_id else p.tool_resource(TOOLS[tool])
    if resource is None:
        p.error('Cette base n’est plus disponible.', 404)
    if run:
        resource = run['block']['resource']
        reference = {'tool': tool, 'id': str(source_id)}
        conn.execute("UPDATE training_runs SET native_ref=?,state='active',revision=revision+1 WHERE id=?", (p.encode(reference), run['id']))
    conn.execute('''INSERT INTO training_native_sources
        (user_id,tool,source_id,run_id,resource,title,request_id,duration_ms,quantity,created_at,options,request_hash,legacy,attempts)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (user_id, tool, str(source_id), training_run_id, p.encode(resource), title or NAMES[tool], request_id, baseline_duration, baseline_quantity, p.stamp(), p.encode(options or {}), hashlib.sha256(p.encode(request_payload).encode()).hexdigest() if request_payload is not None else None, int(legacy), baseline_attempts))
    return context(conn, user_id, tool, source_id)


def record(conn, user_id, tool, source_id, *, duration_ms, quantity, attempts=None, finished=False, duration_kind='elapsed', title=None, base_id=None):
    if not ready(conn):
        return
    if duration_ms is not None:
        duration_ms = max(0, round(duration_ms)) if isinstance(duration_ms, (int, float)) and math.isfinite(duration_ms) else None
    quantity = max(0, quantity)
    if attempts is None and UNITS[tool] == 'positions':
        attempts = int(quantity)
    if attempts is not None:
        attempts = max(0, int(attempts))
    source = context(conn, user_id, tool, source_id)
    if source is None:
        # A pre-feature session is retained but its past cumulative totals are
        # a baseline. Future accepted increments can be measured honestly.
        register(conn, user_id, tool, source_id, title=title, base_id=base_id,
                 baseline_duration=duration_ms, baseline_quantity=quantity, baseline_attempts=attempts, legacy=True)
        conn.execute('UPDATE training_native_sources SET finished=? WHERE user_id=? AND tool=? AND source_id=?', (int(finished), user_id, tool, str(source_id)))
        return
    high_duration = None if duration_ms is None and source['duration_ms'] is None else max(source['duration_ms'] or 0, duration_ms or 0)
    delta_duration = None if duration_ms is None else 0 if source['legacy'] and source['duration_ms'] is None else max(0, duration_ms - (source['duration_ms'] or 0))
    high_quantity = max(source['quantity'], quantity)
    delta_quantity = high_quantity - source['quantity']
    high_attempts = source['attempts'] if attempts is None else max(source['attempts'] or 0, attempts)
    delta_attempts = None if attempts is None or source['attempts'] is None else max(0, attempts - source['attempts'])
    if delta_quantity or delta_duration or delta_attempts:
        run = a._run_row(conn, user_id, source['run_id']) if source['run_id'] else None
        link = a._link(conn, user_id=user_id, source_key='native:' + tool + ':' + str(source_id),
                       tool=tool, source_id=source_id, title=source['title'], resource=json.loads(source['resource']), run=run)
        a._credit(conn, link, 'counter:' + str(source['revision'] + 1), duration_ms=delta_duration,
                  duration_kind=duration_kind, quantity=delta_quantity, unit=UNITS[tool], attempts=delta_attempts)
    if high_duration == source['duration_ms'] and high_quantity == source['quantity'] and high_attempts == source['attempts'] and int(finished) == source['finished']:
        return
    conn.execute('''UPDATE training_native_sources SET duration_ms=?,quantity=?,attempts=?,finished=?,revision=revision+1
        WHERE user_id=? AND tool=? AND source_id=?''', (high_duration, high_quantity, high_attempts, int(finished), user_id, tool, str(source_id)))


def unfinished(conn, run_id):
    if not ready(conn):
        return False
    # Timed tools own expiry and its accepted final transaction. Program reads
    # never settle them; an explicit finish request may settle an elapsed timer.
    import time
    for source in conn.execute('SELECT * FROM training_native_sources WHERE run_id=? AND finished=0', (run_id,)).fetchall():
        tool, identity, user_id = source['tool'], source['source_id'], source['user_id']
        if tool == 'color':
            import color_training
            row = color_training._row(conn, identity, user_id)
            if color_training._expire(row, time.time()):
                color_training._save(conn, row)
        elif tool == 'coordinates':
            import training_skills
            row = training_skills._row(conn, identity, user_id, tool)
            if row['finished_at'] is None and time.time() >= row['started_at'] + row['config']['duration']:
                training_skills._coordinate_result(row, time.time())
                training_skills._save(conn, row)
        elif tool == 'storm':
            import puzzle_training
            puzzle_training._storm_state(conn, identity)
    return conn.execute('SELECT 1 FROM training_native_sources WHERE run_id=? AND finished=0 LIMIT 1', (run_id,)).fetchone() is not None


def puzzle(conn, attempt):
    if attempt['mode'] == 'storm':
        return
    worked = attempt['version'] > 0
    record(conn, 1, 'puzzles', attempt['id'], duration_ms=attempt['elapsed_ms'] if worked else 0,
           quantity=int(worked), finished=attempt['status'] != 'active')


def storm(conn, state):
    if not state.get('clock_started'):
        return
    totals = conn.execute("SELECT COALESCE(SUM(elapsed_ms),0) duration_ms,SUM(CASE WHEN version>0 THEN 1 ELSE 0 END) quantity FROM puzzle_attempts WHERE session_id=?", (state['id'],)).fetchone()
    record(conn, 1, 'storm', state['id'], duration_ms=totals['duration_ms'], quantity=totals['quantity'] or 0, finished=state['status'] != 'active')


def guess(conn, session):
    facts = conn.execute('SELECT COALESCE(SUM(elapsed_ms),0) duration_ms,COUNT(*) answered FROM guess_attempts WHERE session_id=?', (session['id'],)).fetchone()
    record(conn, session['user_id'], 'guess', session['id'], duration_ms=facts['duration_ms'],
           quantity=int(session['current_path'] is None and facts['answered'] > 0), attempts=facts['answered'], finished=session['current_path'] is None, title=session['title'])


def skill(conn, row):
    state, result, config = row['state'], row['result'] or {}, row['config']
    if row['kind'] == 'coordinates':
        quantity = state.get('correct', 0) + state.get('errors', 0)
        duration = min(config['duration'] * 1000, max((event.get('elapsed_ms', 0) for event in state.get('events', [])), default=0))
        if row['finished_at'] is not None and quantity:
            duration = min(config['duration'] * 1000, max(duration, round((row['finished_at'] - row['started_at']) * 1000)))
    else:
        quantity = int(row['finished_at'] is not None and row['started_at'] is not None)
        duration = result.get('total_elapsed_ms', result.get('elapsed_ms'))
        if duration is None:
            duration = max((state.get('solve_result') or {}).get('elapsed_ms', 0), max((event.get('elapsed_ms', 0) for event in state.get('attempts', [])), default=0))
            duration += round(max(0, row['started_at'] - row['created_at']) * 1000) if row['started_at'] is not None else 0
    record(conn, row['user_id'], row['kind'], row['id'], duration_ms=duration, quantity=quantity,
           finished=row['finished_at'] is not None, title=state.get('title'))


def color(conn, row):
    state = row['state']; quantity = state['correct'] + state['errors']
    duration = max((event.get('elapsed_ms', 0) for event in state['events']), default=0)
    if row['finished_at'] is not None and row['started_at'] is not None and quantity:
        duration = min(row['duration'] * 1000, max(duration, round((row['finished_at'] - row['started_at']) * 1000)))
    record(conn, row['user_id'], 'color', row['id'], duration_ms=duration, quantity=quantity, finished=row['finished_at'] is not None)


def computer(conn, user_id, game_id, session, *, is_new=False):
    run = session.get('training_run_id')
    if is_new:
        existing = creation(conn, user_id, 'computer', run)
        if existing is not None and existing != game_id:
            p.error('Reprends la partie déjà attachée à ce bloc.', 409)
        options = dict(session.get('config', {}))
        options.setdefault('side', session.get('side'))
        register(conn, user_id, 'computer', game_id, training_run_id=run, options=options)
    old = context(conn, user_id, 'computer', game_id)
    if old and run != old['run_id']:
        p.error('Le contexte d’entraînement de cette partie ne peut pas être remplacé.', 409)
    position = session['position']
    worked = len(position['history']) > session.get('baseline', 0)
    duration = session.get('activity', {}).get('elapsed_ms')
    record(conn, user_id, 'computer', game_id, duration_ms=duration, duration_kind='active',
           quantity=int(position['game_over'] and (worked or (duration or 0) > 0)), finished=position['game_over'])
