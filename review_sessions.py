"""Durable single-base and daily sessions; ordered identifiers, paged solutions."""
from __future__ import annotations

import json
import math
from uuid import UUID, uuid4
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from db import get_conn
import review_generation
import review_preferences
import daily_review

router = APIRouter(prefix='/api/review-sessions')
PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


def init_schema(conn):
    statements = '''CREATE TABLE IF NOT EXISTS review_sessions (
        id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, request_json TEXT NOT NULL,
        base_id INTEGER NOT NULL, goal TEXT NOT NULL, priority TEXT NOT NULL,
        probability_available INTEGER NOT NULL, total INTEGER NOT NULL,
        created_at TEXT NOT NULL, initial_response TEXT
    );
    CREATE TABLE IF NOT EXISTS review_session_items (
        session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL, card_id TEXT NOT NULL, probability REAL,
        PRIMARY KEY(session_id,position)
    );
    CREATE INDEX IF NOT EXISTS review_history_first_review ON review_history(card_id,reviewed_at);
    CREATE INDEX IF NOT EXISTS review_history_date_numeric ON review_history(julianday(reviewed_at));
    CREATE INDEX IF NOT EXISTS review_history_card_date_numeric ON review_history(card_id,julianday(reviewed_at));
    '''
    # These constant CREATE statements contain no triggers or embedded
    # semicolons. Unlike executescript, execute preserves a caller's transaction.
    for statement in statements.split(';'):
        if statement.strip():
            conn.execute(statement)
    # Additive migration: retain legacy session IDs, order, receipts and base_id.
    additions = {
        'review_sessions': {'mode': "TEXT NOT NULL DEFAULT 'base'", 'selection_json': "TEXT NOT NULL DEFAULT '{}'",
            'training_run_id': 'TEXT'},
        'review_session_items': {'base_id': 'INTEGER', 'selection_reason': 'TEXT',
            'planned_repetitions': 'INTEGER', 'completed_at': 'TEXT', 'history_id': 'INTEGER',
            'elapsed_ms': 'INTEGER NOT NULL DEFAULT 0'},
    }
    for table, fields in additions.items():
        existing = {row['name'] for row in conn.execute('PRAGMA table_info(' + table + ')')}
        for name, kind in fields.items():
            if name not in existing:
                conn.execute('ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + kind)
    conn.execute('CREATE INDEX IF NOT EXISTS review_session_card ON review_session_items(session_id,card_id)')
    conn.execute('CREATE INDEX IF NOT EXISTS review_session_live_card ON review_session_items(card_id) WHERE base_id IS NULL OR base_id!=-1')
    # A deleted base's numeric ID can be reused, as can position-derived card
    # IDs in a new repertoire. Retire the old membership before either returns.
    # Keep the row and its ordinal so paging and creation receipts stay stable.
    conn.execute('''CREATE TRIGGER IF NOT EXISTS review_session_retire_deleted_card
        AFTER DELETE ON review_cards BEGIN
            UPDATE review_session_items SET base_id=-1
            WHERE card_id=OLD.id AND (base_id IS NULL OR base_id!=-1);
        END''')


class CreateSession(BaseModel):
    model_config = ConfigDict(extra='forbid')
    base_id: int = Field(gt=0, strict=True)
    all: StrictBool = False
    selection: Literal['review', 'learn', 'both'] | None = None
    goal: dict | None = None
    request_id: UUID
    training_run_id: UUID | None = None


class CreateDailySession(daily_review.DailyOptions):
    request_id: UUID
    training_run_id: UUID | None = None


def _base_ids(session):
    if session['mode'] == 'daily':
        return json.loads(session['selection_json']).get('base_ids', [])
    return [session['base_id']]


def _page(conn, session, offset, limit):
    import training
    import review_maintenance
    rows = conn.execute('''SELECT i.position,i.probability,i.base_id AS planned_base_id,
        i.selection_reason,i.planned_repetitions,i.completed_at,c.* FROM review_session_items i
        LEFT JOIN review_cards c ON c.id=i.card_id
        WHERE i.session_id=? AND i.position>=? ORDER BY i.position LIMIT ?''',
        (session['id'], offset, limit)).fetchall()
    ids = _base_ids(session)
    bases = {bid: conn.execute('SELECT * FROM bases WHERE id=?', (bid,)).fetchone() for bid in ids}
    multipliers = training.review_multipliers(conn)
    settings_by_base = {bid: {**training.settings_of(base), 'multipliers': multipliers}
                        for bid, base in bases.items() if base is not None}
    mastery_days = training.auto_mastery_days(conn)
    maintenance_ids = review_maintenance.due_card_ids(conn, training.now(), base_ids=ids)
    cards, skipped, skipped_completed, skipped_unavailable = [], [], [], []
    probability_order = session['priority'] in ('probability', 'balanced')
    for row in rows:
        bid = row['planned_base_id'] if row['planned_base_id'] is not None else session['base_id']
        settings = settings_by_base.get(bid, {})
        retired = bid == -1
        answered = not retired and (row['completed_at'] is not None or (
            row['id'] is not None and row['planned_repetitions'] is not None
            and row['repetitions'] != row['planned_repetitions']))
        if (retired or answered or row['id'] is None or not row['active']
                or row['base_id'] != bid or not settings.get('review_enabled', False)
                or (row['state'] == 'mastered' and row['id'] not in maintenance_ids)
                or (row['planned_repetitions'] is not None
                    and row['repetitions'] != row['planned_repetitions'])):
            skipped.append(row['position'])
            (skipped_completed if answered else skipped_unavailable).append(row['position'])
            continue
        maintenance = review_maintenance.get(conn, row['id']) if row['state'] == 'mastered' else None
        card = training._public_card(row, settings, mastery_days,
            {row['identity']: row['probability']}, probability_order,
            maintenance=maintenance, base_name=bases[bid]['name'])
        card['session_index'] = row['position']
        card['session_id'] = session['id']
        card['selection_reason'] = row['selection_reason'] or card.get('selection_reason', 'due')
        cards.append(card)
    end = rows[-1]['position'] + 1 if rows else min(offset, session['total'])
    progress = conn.execute('''SELECT COUNT(*) completed, COALESCE(SUM(elapsed_ms),0) elapsed_ms
        FROM review_session_items WHERE session_id=? AND completed_at IS NOT NULL''', (session['id'],)).fetchone()
    result = {'session_id': session['id'], 'base_id': session['base_id'] if session['mode']=='base' else None,
              'mode': session['mode'], 'selection': json.loads(session['selection_json']).get('selection'),
              'base_ids': ids, 'total': session['total'],
              'offset': offset, 'next_offset': end if end < session['total'] else None,
              'cards': cards, 'skipped': skipped, 'skipped_completed': skipped_completed,
              'skipped_unavailable': skipped_unavailable, 'goal': json.loads(session['goal']),
              'priority': session['priority'], 'probability_available': bool(session['probability_available']),
              'completed': progress['completed'], 'elapsed_ms': progress['elapsed_ms'],
              'training_run_id': session['training_run_id']}
    if session['mode'] == 'daily':
        name = {'review': 'Tout réviser', 'learn': 'Tout apprendre'}.get(result['selection'], 'Réviser / Apprendre')
        result['base'] = {'id': None, 'name': name, 'settings': {}}
        result['plan'] = json.loads(session['selection_json'])
    return result


def _receipt(conn, request_id, encoded):
    old = conn.execute('SELECT * FROM review_sessions WHERE request_id=?', (str(request_id),)).fetchone()
    if old:
        previous, incoming = json.loads(old['request_json']), json.loads(encoded)
        # Recover creations awaiting acknowledgement from the previous client.
        if 'selection' not in previous and incoming.get('selection') in (None, 'both'):
            incoming.pop('selection', None)
        if previous != incoming:
            raise HTTPException(409, 'Cet identifiant de séance a déjà été utilisé avec d’autres options.')
        return json.loads(old['initial_response'])
    return None


def _finish_creation(conn, identity):
    session = conn.execute('SELECT * FROM review_sessions WHERE id=?', (identity,)).fetchone()
    result = _page(conn, session, 0, PAGE_SIZE)
    conn.execute('UPDATE review_sessions SET initial_response=? WHERE id=?', (json.dumps(result, ensure_ascii=False), identity))
    return result


def retarget_training_goal(conn, run_id, session_id, goal, *, extend=True):
    """Rebase only the stop threshold; keep native answers, ordinals and receipts."""
    session = conn.execute('SELECT * FROM review_sessions WHERE id=? AND training_run_id=?',
                           (str(session_id), str(run_id))).fetchone()
    if session is None:
        raise HTTPException(409, 'Cette séance ne correspond plus au bloc du programme.')
    remaining = goal['remaining']
    if not isinstance(remaining, (int, float)) or not math.isfinite(remaining) or remaining <= 0:
        raise HTTPException(409, 'L’objectif de cette période est déjà atteint.')
    progress = conn.execute('''SELECT COUNT(*) completed, COALESCE(SUM(elapsed_ms),0) elapsed_ms
        FROM review_session_items WHERE session_id=? AND completed_at IS NOT NULL''', (str(session_id),)).fetchone()
    native_goal = {'minutes': None, 'cards': None}
    if goal['metric'] == 'minutes':
        native_goal['minutes'] = progress['elapsed_ms'] / 60000 + remaining
    elif goal['metric'] == 'quantity' and goal['unit'] == 'cards':
        native_goal['cards'] = progress['completed'] + math.ceil(remaining)
    # An old daily session may have been cut to its previous card allowance.
    # An explicit period choice may extend it, without moving or repeating any
    # existing member, including a card currently being answered in the browser.
    if extend:
        selection = json.loads(session['selection_json']).get('selection') or 'both'
        plan = daily_review.plan(conn, daily_review.DailyOptions(
            base_ids=_base_ids(session), selection=selection, goal={'minutes': None, 'cards': None}))
        present = {row['card_id'] for row in conn.execute(
            'SELECT card_id FROM review_session_items WHERE session_id=?', (str(session_id),))}
        added = [card for card in plan['cards'] if card['id'] not in present]
        conn.executemany('''INSERT INTO review_session_items(session_id,position,card_id,probability,
            base_id,selection_reason,planned_repetitions) VALUES (?,?,?,?,?,?,?)''',
            ((str(session_id), session['total'] + index, card['id'], card['probability'],
              card['base_id'], card['selection_reason'], card['planned_repetitions']) for index, card in enumerate(added)))
        conn.execute('UPDATE review_sessions SET total=? WHERE id=?', (session['total'] + len(added), str(session_id)))
    conn.execute('UPDATE review_sessions SET goal=? WHERE id=?', (json.dumps(native_goal), str(session_id)))
    return native_goal


def _bind_training_session(conn, run_id, session_id, base_id):
    import training_activity
    run = training_activity.bind_native(conn, 1, run_id, 'review', session_id, base_id=base_id)
    if run and run['launch'].get('goal'):
        launch = {**run['launch'], 'review_goal': retarget_training_goal(
            conn, run_id, session_id, run['launch']['goal'], extend=False)}
        conn.execute('UPDATE training_runs SET launch=? WHERE id=?', (json.dumps(launch), run_id))


@router.post('')
def create_session(request: CreateSession):
    import training
    # Preserve the old receipt encoding when no programme context was supplied.
    encoded = review_generation.json_text(request.model_dump(mode='json',
        exclude=({'training_run_id'} if request.training_run_id is None else set()) |
                ({'selection'} if request.selection is None else set())))
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        old = _receipt(conn, request.request_id, encoded)
        if old is not None:
            return old
        run_id = str(request.training_run_id) if request.training_run_id else None
        selection = request.selection
        if run_id:
            import training_activity
            run = training_activity.validate_run(conn, 1, run_id, 'review', base_id=request.base_id)
            selected = run['launch'].get('options', {}).get('selection', 'both')
            if selection is not None and selection != selected:
                raise HTTPException(409, 'La sélection ne correspond pas au bloc du programme.')
            selection = selected
        base = training.get_base(conn, request.base_id)
        settings = training._sync_base(conn, base)
        training.apply_auto_mastery(conn)
        if not settings.get('review_enabled', False):
            raise HTTPException(409, 'Cette base n’est pas activée pour les révisions.')
        defaults = review_preferences.read(conn)['review_session_defaults']
        goal = review_preferences.checked_session_defaults(request.goal or {}, defaults)
        chosen, probabilities, probability_order = training._ordered_cards(conn, request.base_id, settings, all=request.all, selection=selection)
        if run_id and not chosen:
            raise HTTPException(409, 'Aucune carte disponible pour ce bloc. Choisis une autre activité ou ajuste les options de révision.')
        identity = str(uuid4())
        conn.execute('''INSERT INTO review_sessions(id,request_id,request_json,base_id,goal,priority,
            probability_available,total,created_at,training_run_id) VALUES (?,?,?,?,?,?,?,?,?,?)''',
            (identity, str(request.request_id), encoded, request.base_id, json.dumps(goal),
             'probability' if probability_order else 'due', bool(probabilities), len(chosen), training.stamp(), run_id))
        repetitions = {row['id']: row['repetitions'] for row in conn.execute(
            'SELECT id,repetitions FROM review_cards WHERE base_id=?', (request.base_id,))}
        conn.execute('UPDATE review_sessions SET selection_json=? WHERE id=?',
                     (json.dumps({'selection': selection}), identity))
        conn.executemany('INSERT INTO review_session_items(session_id,position,card_id,probability,base_id,planned_repetitions) VALUES (?,?,?,?,?,?)',
            ((identity, index, card['id'], probabilities.get(card['identity']), request.base_id, repetitions[card['id']]) for index, card in enumerate(chosen)))
        if run_id:
            _bind_training_session(conn, run_id, identity, request.base_id)
        return _finish_creation(conn, identity)


@router.post('/daily-preview')
def preview_daily(request: daily_review.DailyOptions):
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        return daily_review.public_plan(daily_review.plan(conn, request))


@router.post('/daily')
def create_daily(request: CreateDailySession):
    import training
    encoded = review_generation.json_text({'mode': 'daily', **request.model_dump(mode='json',
        exclude={'training_run_id'} if request.training_run_id is None else set())})
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        old = _receipt(conn, request.request_id, encoded)
        if old is not None:
            return old
        run_id = str(request.training_run_id) if request.training_run_id else None
        if run_id:
            if request.base_ids is None or len(request.base_ids) != 1:
                raise HTTPException(422, 'Un bloc du programme doit lancer les révisions d’une seule base.')
            import training_activity
            run = training_activity.validate_run(conn, 1, run_id, 'review', base_id=request.base_ids[0])
            if request.selection != run['launch'].get('options', {}).get('selection', 'both'):
                raise HTTPException(409, 'La sélection ne correspond pas au bloc du programme.')
        options = daily_review.DailyOptions(**request.model_dump(exclude={'request_id', 'training_run_id'}))
        plan = daily_review.plan(conn, options)
        if run_id and not plan['total']:
            raise HTTPException(409, 'Aucune carte disponible pour ce bloc. Choisis une autre activité ou ajuste les options de révision.')
        identity = str(uuid4())
        conn.execute('''INSERT INTO review_sessions(id,request_id,request_json,base_id,goal,priority,
            probability_available,total,created_at,mode,selection_json,training_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
            (identity, str(request.request_id), encoded, 0, json.dumps(plan['goal']), 'balanced',
             any(card['probability'] is not None for card in plan['cards']), plan['total'], training.stamp(),
             'daily', review_generation.json_text(daily_review.public_plan(plan)), run_id))
        conn.executemany('''INSERT INTO review_session_items(session_id,position,card_id,probability,
            base_id,selection_reason,planned_repetitions) VALUES (?,?,?,?,?,?,?)''',
            ((identity, index, card['id'], card['probability'], card['base_id'],
              card['selection_reason'], card['planned_repetitions']) for index, card in enumerate(plan['cards'])))
        if run_id:
            _bind_training_session(conn, run_id, identity, request.base_ids[0])
        return _finish_creation(conn, identity)


@router.get('/{session_id}')
def get_session(session_id: UUID, offset: int = Query(0, ge=0), limit: int = Query(PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE)):
    import training
    with get_conn() as conn:
        session = conn.execute('SELECT * FROM review_sessions WHERE id=?', (str(session_id),)).fetchone()
        if session is None:
            raise HTTPException(404, 'Cette séance est introuvable.')
        for bid in _base_ids(session):
            base = conn.execute('SELECT * FROM bases WHERE id=?', (bid,)).fetchone()
            if base is not None:
                training._sync_base(conn, base)
        training.apply_auto_mastery(conn)
        conn.commit()
        conn.execute('BEGIN')
        return _page(conn, session, offset, limit)


def validate_answer(conn, request, card):
    """Validate membership under the same writer transaction as grading."""
    sid = getattr(request, 'session_id', None)
    index = getattr(request, 'session_index', None)
    if sid is None and index is None:
        return
    if sid is None or index is None or getattr(request, 'request_id', None) is None:
        raise HTTPException(422, 'La réponse de séance exige son identifiant, sa position et un identifiant de tentative.')
    row = conn.execute('''SELECT i.*,s.base_id AS legacy_base_id,s.mode,s.selection_json FROM review_session_items i
        JOIN review_sessions s ON s.id=i.session_id WHERE i.session_id=? AND i.position=?''',
        (str(sid), index)).fetchone()
    if row is None or row['card_id'] != card['id']:
        raise HTTPException(409, 'Cette carte ne correspond pas à la position dans la séance.')
    bid = row['base_id'] if row['base_id'] is not None else row['legacy_base_id']
    if row['completed_at'] is not None or bid != card['base_id']:
        raise HTTPException(409, 'Cette réponse a déjà été enregistrée ou sa base a changé.')
    if row['planned_repetitions'] is not None and row['planned_repetitions'] != card['repetitions']:
        raise HTTPException(409, 'Cette carte a déjà été travaillée depuis la préparation de la séance.')


def record_answer(conn, request, card_id, history_id, response):
    import training
    sid = getattr(request, 'session_id', None)
    if sid is None:
        return
    conn.execute('''UPDATE review_session_items SET completed_at=?,history_id=?,elapsed_ms=?
        WHERE session_id=? AND position=? AND card_id=? AND completed_at IS NULL''',
        (training.stamp(), history_id, getattr(request, 'elapsed_ms', 0), str(sid), request.session_index, card_id))
    count = conn.execute('SELECT COUNT(*) FROM review_session_items WHERE session_id=? AND completed_at IS NOT NULL', (str(sid),)).fetchone()[0]
    response['session_completed'] = count


def training_run(conn, session_id):
    """Read the server-owned context; grades cannot choose another run."""
    if session_id is None:
        return None
    row = conn.execute('SELECT training_run_id FROM review_sessions WHERE id=?', (str(session_id),)).fetchone()
    return row['training_run_id'] if row else None
