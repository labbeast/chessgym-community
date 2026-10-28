"""Revision cards, persistent scheduling and exact-path repertoire extension."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import io
import json
import random
from typing import Annotated, Literal
from uuid import UUID

import chess
import chess.pgn
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, StrictInt, StrictStr, ConfigDict, model_validator

from db import get_conn, mark_entry_seen
from accounts_api import require_user
import engine
import pgnlib
import review_generation
import review_progress
import review_preferences
import review_schedule
import review_maintenance
import learning_foundations

# Keep existing Python callers compatible while the HTTP transport has its own
# module and no longer depends on review/repertoire implementation details.
from engine_api import (
    AnalysisRequest, StreamAnalysisRequest, PlayRequest,
    ENGINE_SETTINGS_KEY, ENGINE_DEFAULT_SETTINGS,
    analyse, analyse_stream, play, get_engine_settings, patch_engine_settings,
)
import engine_api

router = APIRouter(prefix='/api')
router.include_router(engine_api.router)


def now():
    return datetime.now(timezone.utc)


def stamp(value=None):
    return (value or now()).isoformat(timespec='seconds')


def _navigation_review_due_count(conn, tables, current):
    # Use the same authenticated study-library scope as /reviews. This summary
    # must never regenerate PGNs or advance the mastery scheduler.
    if not {'bases', 'review_cards'} <= tables:
        return 0
    references = {row[0] for row in conn.execute('SELECT base_id FROM reference_bases')} if 'reference_bases' in tables else set()
    base_ids = [base['id'] for base in conn.execute('SELECT id,settings FROM bases')
                if base['id'] not in references and settings_of(base).get('review_enabled', False)]
    maintenance_available = {'review_maintenance', 'review_maintenance_events'} <= tables
    count = 0
    for base_id in base_ids:
        count += review_progress.counts_for_base(conn, base_id, current)['due']
        if maintenance_available:
            count += len(review_maintenance.due_card_ids(conn, current, base_ids=[base_id]))
    return count


@router.get('/training/unfinished')
def unfinished_training(user=Depends(require_user)):
    """Read resumable activity flags without finalizing expired sessions."""
    current, activities = now(), []
    timestamp = current.timestamp()
    with get_conn() as conn:
        conn.execute('BEGIN')
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        review_due_count = _navigation_review_due_count(conn, tables, current)

        def exists(table, condition, parameters=()):
            return table in tables and conn.execute(
                f'SELECT 1 FROM {table} WHERE {condition} LIMIT 1', parameters).fetchone() is not None

        # Puzzle tables predate accounts and belong to the installation owner,
        # matching the ownership convention used by the training history.
        if user['id'] == 1 and (
            exists('puzzle_attempts', "mode='classic' AND status='active'") or
            exists('puzzle_storm', "status='active' AND (clock_started=0 OR deadline_ms>?)", (int(timestamp * 1000),))
        ):
            activities.append('puzzles')
        if exists('guess_sessions', 'user_id=? AND current_path IS NOT NULL', (user['id'],)):
            activities.append('guess')
        if exists('skill_sessions', "user_id=? AND kind='blindfold' AND finished_at IS NULL", (user['id'],)):
            activities.append('blindfold')
        if exists('skill_sessions', """user_id=? AND kind='coordinates' AND finished_at IS NULL
            AND started_at + json_extract(CASE WHEN json_valid(config) THEN config ELSE '{}' END,'$.duration')>?""",
            (user['id'], timestamp)):
            activities.append('coordinates')
        if exists('color_sessions', '''user_id=? AND finished_at IS NULL
            AND (started_at IS NULL OR started_at + duration>?)''', (user['id'], timestamp)):
            activities.append('color')
    return {'activities': activities, 'review_due_count': review_due_count}


def init_training():
    with get_conn() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS review_cards (
          id TEXT PRIMARY KEY, base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
          entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
          type TEXT NOT NULL, identity TEXT NOT NULL, path TEXT NOT NULL,
          fen TEXT NOT NULL, answers TEXT NOT NULL, solutions TEXT NOT NULL DEFAULT '[]',
          title TEXT NOT NULL, comment TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
          state TEXT NOT NULL DEFAULT 'unseen', due TEXT, interval_days REAL NOT NULL DEFAULT 0,
          repetitions INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS review_cards_base_active ON review_cards(base_id, active, type);
        CREATE INDEX IF NOT EXISTS review_cards_pending_mastery ON review_cards(interval_days) WHERE state!='mastered';
        CREATE TABLE IF NOT EXISTS review_history (
          id INTEGER PRIMARY KEY, card_id TEXT NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
          reviewed_at TEXT NOT NULL, grade INTEGER NOT NULL, proposed_grade INTEGER NOT NULL,
          requested_grade INTEGER NOT NULL, errors INTEGER NOT NULL, hints INTEGER NOT NULL,
          elapsed_ms INTEGER NOT NULL, assisted INTEGER NOT NULL, mode TEXT NOT NULL,
          interval_days REAL NOT NULL, due TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS training_migrations (
          name TEXT PRIMARY KEY, applied_at TEXT NOT NULL
        );
        ''')
        review_maintenance.init_schema(conn)
        review_generation.init_schema(conn)
        import review_sessions
        review_sessions.init_schema(conn)
        _migrate_adaptive_spacing(conn)
        _migrate_long_intervals(conn)
        _migrate_hard_grades(conn)
        learning_foundations.init_schema(conn)


def _migrate_adaptive_spacing(conn):
    """Upgrade defaults once, preserving schedules and later explicit user choices."""
    migration = 'adaptive_spacing_max_720_v1'
    conn.execute('BEGIN IMMEDIATE')
    if conn.execute('SELECT 1 FROM training_migrations WHERE name=?', (migration,)).fetchone():
        return
    for base in conn.execute('SELECT id,settings FROM bases').fetchall():
        try:
            settings = json.loads(base['settings'] or '{}')
        except (TypeError, ValueError):
            continue
        if not isinstance(settings, dict):
            continue
        previous = dict(settings)
        if settings.get('spacing') in (None, 'fixed', 'custom'):
            settings['spacing'] = 'adaptive'
        if settings.get('max') is None or settings.get('max') == 180:
            settings['max'] = 720
        if settings != previous:
            conn.execute('UPDATE bases SET settings=? WHERE id=?',
                         (json.dumps(settings, ensure_ascii=False), base['id']))
    conn.execute('INSERT INTO training_migrations(name,applied_at) VALUES (?,?)', (migration, stamp()))


DEFAULT_REVIEW_MULTIPLIERS = review_preferences.DEFAULT_REVIEW_MULTIPLIERS


def review_multipliers(conn):
    return review_preferences.read(conn)['review_multipliers'].copy()


def auto_mastery_days(conn):
    return review_preferences.read(conn)['auto_mastery_days']


def apply_auto_mastery(conn):
    """Keep legacy mastery intact and attach a separate gradual upkeep schedule."""
    threshold = auto_mastery_days(conn)
    query = "SELECT id FROM review_cards WHERE interval_days>? AND state!='mastered'"
    if conn.execute(query + ' LIMIT 1', (threshold,)).fetchone():
        if not conn.in_transaction:
            conn.execute('BEGIN IMMEDIATE')
        threshold = auto_mastery_days(conn)
        cards = conn.execute(query, (threshold,)).fetchall()
        current = now()
        conn.execute("UPDATE review_cards SET state='mastered',due=NULL,updated_at=? WHERE interval_days>? AND state!='mastered'",
                     (stamp(current), threshold))
        review_maintenance.schedule_cards(conn, (card['id'] for card in cards), current)
    review_maintenance.ensure_scheduled(conn, now())
    return threshold


def _migrate_long_intervals(conn):
    # Also catches a changed preference between application startups.
    apply_auto_mastery(conn)


def _migrate_hard_grades(conn):
    """A successful difficult answer is learned; preserve its schedule/history."""
    migration = 'hard_grade_learned_v1'
    if not conn.in_transaction:
        conn.execute('BEGIN IMMEDIATE')
    if conn.execute('SELECT 1 FROM training_migrations WHERE name=?', (migration,)).fetchone():
        return
    conn.execute("""UPDATE review_cards SET state='learned',updated_at=?
        WHERE state='learning' AND
        (SELECT grade FROM review_history WHERE card_id=review_cards.id
         ORDER BY reviewed_at DESC,id DESC LIMIT 1)=1""", (stamp(),))
    conn.execute('INSERT INTO training_migrations(name,applied_at) VALUES (?,?)', (migration, stamp()))


def settings_of(base):
    try:
        settings = json.loads(base['settings'] or '{}')
    except (TypeError, ValueError):
        settings = {}
    return settings if isinstance(settings, dict) else {}


def get_base(conn, base_id):
    base = conn.execute('SELECT * FROM bases WHERE id=?', (base_id,)).fetchone()
    if base is None:
        raise HTTPException(404, 'Base introuvable.')
    return base


def load_game(text):
    try:
        game = chess.pgn.read_game(io.StringIO(text))
    except (ValueError, TypeError):
        raise HTTPException(422, 'Le PGN ne peut pas être lu.')
    if game is None or game.errors:
        raise HTTPException(422, 'Le PGN contient des coups invalides.')
    if not game.board().is_valid():
        raise HTTPException(422, 'La position initiale du PGN est invalide.')
    return game


def node_at(game, path):
    node = game
    if not path:
        return node
    try:
        for component in path.split('.'):
            if not component.isdigit():
                raise ValueError()
            node = node.variations[int(component)]
    except (IndexError, ValueError, AttributeError):
        raise HTTPException(422, 'La position choisie n’existe plus dans ce PGN.')
    return node


def position_key(board):
    # Ignore counters, retain side to move, castling and legal en-passant rights.
    return ' '.join(board.fen().split()[:4])


def walk(node, path=''):
    yield node, path
    for index, child in enumerate(node.variations):
        # Null moves describe hypothetical positions in annotated courses.
        # Do not teach that branch as a sequence of playable opening moves.
        if not child.move:
            continue
        child_path = f'{path}.{index}' if path else str(index)
        yield from walk(child, child_path)


def solution_lines(node, limit=64, max_plies=100):
    lines = []
    def visit(current, moves):
        if len(lines) >= limit:
            return
        children = [child for child in current.variations if child.move]
        if not children or len(moves) >= max_plies:
            if moves:
                lines.append(moves)
            return
        for child in children:
            visit(child, moves + [child.move.uci()])
    visit(node, [])
    return lines


def _derive_entry(entry, base_id, exercise_type, side):
    cards = {}
    try:
        game = load_game(entry['pgn'])
        if exercise_type == 'game':
            positions = [(game, '')]
        elif exercise_type == 'moves':
            positions = [(node, path) for node, path in walk(game)
                         if any(child.move for child in node.variations) and node.board().turn == side]
        else:
            start_path = entry['start_path'] or ''
            positions = [(node_at(game, start_path), start_path)]
    except HTTPException:
        # A stale path must never silently turn into the initial position.
        return []
    for node, path in positions:
        board = node.board()
        key = position_key(board)
        identity = key if exercise_type == 'moves' else f'{entry["id"]}:{key}'
        card_id = hashlib.sha256(f'{base_id}:{exercise_type}:{identity}'.encode()).hexdigest()[:32]
        answers = ([node.variations[0].move.uci()] if node.variations and node.variations[0].move else []) if exercise_type == 'game' else [child.move.uci() for child in node.variations if child.move] if exercise_type != 'play' else []
        # No answer means a diagram, not a solvable card. Play may start from a diagram.
        if exercise_type != 'play' and not answers:
            continue
        if exercise_type == 'play' and board.is_game_over():
            continue
        if card_id in cards:
            cards[card_id]['answers'] = sorted(set(cards[card_id]['answers']) | set(answers))
            continue
        cards[card_id] = {'id': card_id, 'base_id': base_id, 'entry_id': entry['id'],
                          'type': exercise_type, 'identity': identity, 'path': path,
                          'fen': board.fen(), 'answers': answers,
                          'solutions': [[move.uci() for move in game.mainline_moves()]] if exercise_type == 'game' else solution_lines(node) if exercise_type == 'solve' else [],
                          'title': entry['title'] or 'Sans titre', 'comment': node.comment or ''}
    return list(cards.values())


def _sync_base(conn, base):
    # Current bases are a read-only fast path. Writers recheck under the lock.
    if not conn.in_transaction:
        fresh = get_base(conn, base['id'])
        config = settings_of(fresh)
        kind = config.get('type', 'solve')
        if kind not in ('moves', 'solve', 'play', 'game'): kind = 'solve'
        side = chess.BLACK if config.get('color') == 'black' else chess.WHITE
        if review_generation.is_current(conn, base['id'], [kind, side]):
            return config
        conn.execute('BEGIN IMMEDIATE')
    base = get_base(conn, base['id'])
    settings = settings_of(base)
    exercise_type = settings.get('type', 'solve')
    if exercise_type not in ('moves', 'solve', 'play', 'game'):
        exercise_type = 'solve'
    side = chess.BLACK if settings.get('color') == 'black' else chess.WHITE
    review_generation.sync(conn, base['id'], [exercise_type, side],
        lambda entry: _derive_entry(entry, base['id'], exercise_type, side), stamp())
    return settings


def _card_content_key(card, settings, mastery_days=review_preferences.DEFAULT_AUTO_MASTERY_DAYS):
    # Includes scheduling state: two devices must not grade the same old attempt.
    fields = ('id','entry_id','type','path','fen','answers','solutions','title','comment',
              'state','due','interval_days','repetitions','lapses')
    return review_generation.digest([{key: card[key] for key in fields}, settings, mastery_days])


@router.get('/reviews')
def reviews():
    result = []
    with get_conn() as conn:
        apply_auto_mastery(conn)
        conn.commit()
        for base in conn.execute('SELECT * FROM bases ORDER BY name').fetchall():
            if settings_of(base).get('review_enabled', False):
                _sync_base(conn, base)
                conn.commit()
        # Summary reads share a coherent snapshot, without holding a writer lock.
        conn.execute('BEGIN')
        for base in conn.execute('SELECT * FROM bases ORDER BY name'):
            settings = settings_of(base)
            if not settings.get('review_enabled', False):
                continue
            counts = review_progress.counts_for_base(conn, base['id'], stamp())
            counts.update(review_maintenance.counts_for_base(conn, base['id'], now()))
            result.append({'base_id': base['id'], 'name': base['name'],
                           'type': settings.get('type', 'solve'), **dict(counts)})
    return {'bases': result}


def _ordered_cards(conn, base_id, settings, *, all=False, selection=None, rng=None):
    # Metadata only: full solutions are fetched for the requested page afterwards.
    cards = conn.execute("SELECT id,entry_id,path,type,identity,state,due FROM review_cards WHERE base_id=? AND active=1 AND state!='mastered'", (base_id,)).fetchall()
    current = now()
    due_times = {card['id']: review_progress._timestamp(card['due']) for card in cards}
    overdue = sorted([card for card in cards if card['state'] != 'unseen' and due_times[card['id']] is not None and due_times[card['id']] <= current], key=lambda card: due_times[card['id']])
    unseen = [card for card in cards if card['state'] == 'unseen']
    def source_order(card):
        return (card['entry_id'] or 0, tuple(int(part) for part in card['path'].split('.') if part), card['id'])
    unseen.sort(key=source_order)
    probabilities = {}
    probability_order = settings.get('type') == 'moves' and settings.get('review_priority', 'probability') == 'probability'
    if probability_order:
        from repertoire_coverage import cached_priorities
        probabilities = cached_priorities(conn, base_id)
        def likelihood(card):
            value = probabilities.get(card['identity'])
            return -(value if value is not None else -1)
        unseen.sort(key=likelihood)
        if probabilities:
            study_day = review_preferences.read(conn)['study_day']
            overdue.sort(key=lambda card: (0 if card['state'] == 'learning' else 1, review_preferences.study_date(due_times[card['id']], study_day), likelihood(card), due_times[card['id']]))
    elif settings.get('new_order', 'pgn') == 'random':
        (rng or random.SystemRandom()).shuffle(unseen)
    if selection == 'review':
        chosen = overdue
    elif selection == 'learn':
        chosen = unseen
    elif all and selection is None:
        future = sorted([card for card in cards if card['state'] != 'unseen' and (due_times[card['id']] is None or due_times[card['id']] > current)], key=lambda card: due_times[card['id']] or datetime.max.replace(tzinfo=timezone.utc))
        chosen = overdue + unseen + future
    else:
        # Omitted selection supports older clients; new clients choose explicitly.
        # Session goals, rather than a daily allowance, bound new introductions.
        chosen = overdue + unseen
    maintenance_ids = review_maintenance.due_card_ids(conn, current, base_ids=[base_id]) if selection != 'learn' else set()
    if maintenance_ids:
        maintenance = conn.execute("""SELECT c.id,c.entry_id,c.path,c.type,c.identity,c.state,c.due
            FROM review_cards c JOIN review_maintenance m ON m.card_id=c.id
            WHERE c.id IN (""" + ','.join('?' for _ in maintenance_ids) + ') ORDER BY m.due,c.id',
            list(maintenance_ids)).fetchall()
        chosen[len(overdue):len(overdue)] = maintenance
    return chosen, probabilities, probability_order


def _public_card(card, settings, mastery_days, probabilities, probability_order, *, maintenance=None, base_name=None):
    maintenance_card = card['state'] == 'mastered' and maintenance is not None
    due = review_progress._timestamp(card['due'])
    reason = ('maintenance' if maintenance_card else 'new' if card['state'] == 'unseen'
              else 'due' if due is not None and due <= now() else 'future')
    return {key: card[key] for key in ('id','base_id','entry_id','path','fen','type','title','comment','due','state')} | {
        'answers': json.loads(card['answers']), 'solutions': json.loads(card['solutions']),
        'settings': settings, 'content_key': _card_content_key(card, settings, mastery_days),
        'base_name': base_name, 'selection_reason': reason, 'maintenance': maintenance_card,
        'maintenance_due': maintenance['due'] if maintenance_card else None,
        'encounter_probability': probabilities.get(card['identity']), 'probability_priority': probability_order}


@router.get('/bases/{base_id}/queue')
def queue(base_id: int, all: bool = False, selection: Literal['review', 'learn', 'both'] | None = None):
    # Legacy clients retain an unlimited response. New clients use durable pages.
    with get_conn() as conn:
        base = get_base(conn, base_id)
        settings = _sync_base(conn, base)
        mastery_days = apply_auto_mastery(conn)
        settings = {**settings, 'multipliers': review_multipliers(conn)}
        conn.commit()
        conn.execute('BEGIN')
        if not settings.get('review_enabled', False):
            return {'cards': []}
        chosen, probabilities, probability_order = _ordered_cards(conn, base_id, settings, all=all, selection=selection)
        rows = {row['id']: row for row in conn.execute("SELECT * FROM review_cards WHERE base_id=? AND active=1", (base_id,))}
        return {'cards': [_public_card(rows[card['id']], settings, mastery_days, probabilities, probability_order,
                            maintenance=review_maintenance.get(conn, card['id']) if rows[card['id']]['state'] == 'mastered' else None,
                            base_name=base['name']) for card in chosen if card['id'] in rows],
                'priority': 'probability' if probability_order else 'due', 'probability_available': bool(probabilities)}


class MasterRequest(BaseModel):
    request_id: UUID | None = None
    content_key: StrictStr | None = Field(default=None, pattern='^[0-9a-f]{64}$')
    session_id: UUID | None = None
    session_index: StrictInt | None = Field(default=None, ge=0)

    @model_validator(mode='after')
    def session_pair(self):
        if (self.session_id is None) != (self.session_index is None):
            raise ValueError('La séance et la position doivent être indiquées ensemble.')
        return self


class GradeRequest(MasterRequest):
    grade: int = Field(ge=0, le=3)
    errors: int = Field(default=0, ge=0, le=10000)
    hints: int = Field(default=0, ge=0, le=10000)
    elapsed_ms: int = Field(default=0, ge=0, le=86400000)
    assisted: bool = False
    proposed_grade: int | None = Field(default=None, ge=0, le=3)


def _schedule(card, settings, grade, mastery_days=review_preferences.DEFAULT_AUTO_MASTERY_DAYS):
    return review_schedule.schedule(card, settings, grade, mastery_days, current=now())


def _review_receipt(conn, card_id, request, action):
    """Check retries before sync/staleness checks, inside the write transaction."""
    request_json = review_generation.json_text({
        'action': action, 'card_id': card_id, **request.model_dump(mode='json',
            exclude={'session_id', 'session_index'} if request.session_id is None else set())})
    if request.request_id is not None:
        receipt = conn.execute('SELECT * FROM review_grade_receipts WHERE request_id=?',
                               (str(request.request_id),)).fetchone()
        if receipt is not None:
            if receipt['request_json'] != request_json:
                raise HTTPException(409, 'Cette tentative a déjà été enregistrée avec un autre résultat.')
            return request_json, json.loads(receipt['response_json'])
    return request_json, None


def _save_review_receipt(conn, request, request_json, response):
    if request.request_id is not None:
        conn.execute('INSERT INTO review_grade_receipts(request_id,request_json,response_json,created_at) VALUES (?,?,?,?)',
                     (str(request.request_id), request_json, review_generation.json_text(response), stamp()))


def _active_review_card(conn, card_id, request, *, allow_mastered=False):
    """Refresh source-derived content before validating an action's snapshot.

    The caller owns the write transaction so edits, grades and explicit mastery
    cannot interleave between synchronization and recording the action.
    """
    card = conn.execute('SELECT * FROM review_cards WHERE id=?', (card_id,)).fetchone()
    if card is None:
        raise HTTPException(404, 'Carte introuvable.')
    settings = _sync_base(conn, get_base(conn, card['base_id']))
    mastery_days = apply_auto_mastery(conn)
    settings = {**settings, 'multipliers': review_multipliers(conn)}
    card = conn.execute('SELECT * FROM review_cards WHERE id=? AND active=1', (card_id,)).fetchone()
    if card is None or not settings.get('review_enabled', False):
        raise HTTPException(409, 'Cette carte ne fait plus partie des révisions actives.')
    if card['state'] == 'mastered' and not allow_mastered and not review_maintenance.is_due(conn, card_id, now()):
        raise HTTPException(409, 'Cette carte maîtrisée n’est pas disponible pour l’entretien aujourd’hui.')
    if request.content_key is not None and request.content_key != _card_content_key(card, settings, mastery_days):
        raise HTTPException(409, 'Cette carte ou sa progression a changé. Recharge la révision avant de la noter.')
    return card, settings, mastery_days


@router.post('/reviews/{card_id}/grade')
def grade_card(card_id: str, request: GradeRequest):
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        request_json, receipt = _review_receipt(conn, card_id, request, 'grade')
        if receipt is not None:
            return receipt
        card, settings, mastery_days = _active_review_card(conn, card_id, request)
        import review_sessions
        if request.session_id is not None:
            review_sessions.validate_answer(conn, request, card)
        mode = settings.get('mode', 'hybrid')
        grade, proposed = review_schedule.resolve_grade(card['type'], mode, request.grade,
            errors=request.errors, hints=request.hints, assisted=request.assisted)
        maintenance = card['state'] == 'mastered'
        maintenance_before = review_maintenance.get(conn, card_id) if maintenance else None
        current = now()
        if maintenance and (request.errors or request.hints or request.assisted):
            # A recall lapse cannot be hidden by a manually selected Easy grade.
            grade = 0
        if maintenance and grade > 0:
            interval, due, state = card['interval_days'], None, 'mastered'
        else:
            interval, due, state = _schedule(card, settings, grade, mastery_days)
        conn.execute('''UPDATE review_cards SET state=?,due=?,interval_days=?,repetitions=repetitions+1,
                       lapses=lapses+?,updated_at=? WHERE id=?''',
                     (state,due,interval,int(grade==0),stamp(current),card_id))
        history_id = conn.execute('''INSERT INTO review_history
          (card_id,reviewed_at,grade,proposed_grade,requested_grade,errors,hints,elapsed_ms,assisted,mode,interval_days,due)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
          (card_id,stamp(current),grade,proposed,request.grade,request.errors,request.hints,
           request.elapsed_ms,int(request.assisted),mode,interval,due or '')).lastrowid
        maintenance_due = None
        if maintenance:
            maintenance_due = review_maintenance.record_grade(conn, card_id, history_id, grade, current)
        elif state == 'mastered':
            maintenance_due = review_maintenance.schedule_card(conn, card_id, current)
        learning_foundations.record_attempt(conn, history_id=history_id, card=card, settings=settings,
            content_key=_card_content_key(card, settings, mastery_days),
            scheduler_version=review_maintenance.SCHEDULER_VERSION if maintenance else 'adaptive-v1',
            request_id=str(request.request_id) if request.request_id else None,
            context={'kind': 'maintenance' if maintenance else 'review', 'mastery_days': mastery_days,
                     'session_id': str(request.session_id) if request.session_id else None,
                     'session_index': request.session_index,
                     'maintenance_schedule': maintenance_before,
                     'maintenance_settings': review_preferences.read(conn)['review_maintenance'] if maintenance else None})
        mark_entry_seen(conn, card['entry_id'], stamp(current))
        response = {'grade': grade, 'due': due, 'interval_days': interval, 'state': state}
        if maintenance:
            response.update(maintenance=True, maintenance_due=maintenance_due)
        if request.session_id is not None:
            review_sessions.record_answer(conn, request, card_id, history_id, response)
        import training_activity
        training_activity.record_review(conn, history_id=history_id, card=card,
            request_id=str(request.request_id) if request.request_id else None,
            session_id=str(request.session_id) if request.session_id else None,
            run_id=review_sessions.training_run(conn, request.session_id), recorded_at=stamp(current))
        _save_review_receipt(conn, request, request_json, response)
        return response


@router.post('/reviews/{card_id}/master')
def master_card(card_id: str, request: MasterRequest | None = None):
    request = request or MasterRequest()
    with get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        request_json, receipt = _review_receipt(conn, card_id, request, 'master')
        if receipt is not None:
            return receipt
        card, _, _ = _active_review_card(conn, card_id, request, allow_mastered=True)
        import review_sessions
        if request.session_id is not None:
            review_sessions.validate_answer(conn, request, card)
        if card['state'] != 'mastered':
            # Mastering explicitly does not fabricate a successful repetition.
            conn.execute("""UPDATE review_cards SET state='mastered',due=NULL,interval_days=0,updated_at=?
                            WHERE id=?""", (stamp(), card_id))
            review_maintenance.schedule_card(conn, card_id, now())
        mark_entry_seen(conn, card['entry_id'], stamp())
        response = {'state': 'mastered', 'due': None, 'interval_days': 0}
        if request.session_id is not None:
            review_sessions.record_answer(conn, request, card_id, None, response)
        _save_review_receipt(conn, request, request_json, response)
        return response


def source_line(conn, entry_id, path):
    entry = conn.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone()
    if entry is None:
        raise HTTPException(404, 'Partie source introuvable.')
    game = _repertoire_game(entry['pgn'])
    selected = node_at(game,path)
    nodes = []
    while selected.parent is not None:
        nodes.append(selected)
        selected = selected.parent
    nodes.reverse()
    return entry,game,nodes


def _repertoire_game(pgn):
    try:
        return pgnlib.load_game(pgn)
    except (ValueError, RecursionError) as exc:
        raise HTTPException(422, 'Le PGN du répertoire ou de la partie source est invalide.') from exc


def _source_fingerprint(game, path):
    """Formatting-independent identity, retaining every annotation and branch."""
    nodes = []
    stack = [game]
    while stack:
        node = stack.pop()
        nodes.append([node.move.uci() if node.move is not None else None, len(node.variations),
                      node.comment, getattr(node, 'starting_comment', ''), sorted(node.nags)])
        stack.extend(reversed(node.variations))
    content = {'headers': dict(game.headers), 'nodes': nodes, 'path': path}
    return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class RepertoireSource(BaseModel):
    model_config = ConfigDict(extra='forbid')
    entry_id: StrictInt | None = Field(default=None, gt=0)
    pgn: StrictStr | None = Field(default=None, max_length=pgnlib.MAX_PGN_BYTES)
    path: StrictStr = Field(default='', max_length=2000)


def _resolve_repertoire_source(conn, request):
    entry = None
    saved = None
    if request.entry_id is not None:
        entry = conn.execute('SELECT * FROM entries WHERE id=?', (request.entry_id,)).fetchone()
        if entry is None:
            raise HTTPException(404, 'Partie source introuvable.')
        saved = _repertoire_game(entry['pgn'])
    source = _repertoire_game(request.pgn) if request.pgn is not None else saved
    if source is None:
        raise HTTPException(422, 'Indique une partie enregistrée ou un PGN à analyser.')
    if saved is not None and request.pgn is not None and _source_fingerprint(saved, request.path) != _source_fingerprint(source, request.path):
        raise HTTPException(409, 'La partie enregistrée a changé. Recharge-la avant de vérifier son répertoire.')
    selected = node_at(source, request.path)
    nodes = []
    while selected.parent is not None:
        nodes.append(selected)
        selected = selected.parent
    nodes.reverse()
    title = entry['title'] if entry else 'une analyse libre'
    return entry, source, nodes, _source_fingerprint(source, request.path), title


def _repertoire_fingerprint(base, entries):
    content = {'settings': settings_of(base), 'entries': [[entry['id'], entry['pgn']] for entry in entries]}
    return hashlib.sha256(json.dumps(content, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _compatibility(conn, base, source, nodes):
    result = {'base_id': base['id'], 'name': base['name'], 'compatible': False,
              'extendable': False, 'reason': '', 'transposition': False}
    entries = conn.execute('SELECT * FROM entries WHERE base_id=? ORDER BY id',(base['id'],)).fetchall()
    result['repertoire_fingerprint'] = _repertoire_fingerprint(base, entries)
    if any(not node.move for node in nodes):
        result['reason'] = 'Ce chemin contient un coup nul d’analyse et ne peut pas être ajouté au répertoire.'
        return result
    if position_key(source.board()) != position_key(chess.Board()):
        result['reason'] = 'Une position isolée ne permet pas de vérifier le chemin depuis le début de la partie.'
        return result
    tree = {}
    known_positions = set()
    valid_games = 0
    def add_tree(node, branch):
        stack = [(node, branch, node.board())]
        while stack:
            current, current_branch, board = stack.pop()
            known_positions.add(position_key(board))
            for child in current.variations:
                if not child.move:
                    continue
                child_board = board.copy(stack=False)
                child_board.push(child.move)
                stack.append((child, current_branch.setdefault(child.move.uci(), {}), child_board))
    for entry in entries:
        game = _repertoire_game(entry['pgn'])
        if position_key(game.board()) == position_key(chess.Board()):
            valid_games += 1
            add_tree(game,tree)
    if entries and not valid_games:
        result['reason'] = 'Le répertoire ne contient pas de ligne depuis la position initiale.'
        return result
    branch = tree
    for index,node in enumerate(nodes):
        uci = node.move.uci()
        if uci in branch:
            branch = branch[uci]
        elif not branch:
            result.update(compatible=True,extendable=True,reason='La suite prolonge une ligne connue sans déviation.')
            return result
        else:
            result['reason'] = f'Déviation au demi-coup {index+1} : {node.san()} n’est pas dans le répertoire.'
            if nodes and position_key(nodes[-1].board()) in known_positions:
                result['transposition'] = True
                result['reason'] += ' La position actuelle est connue par transposition, mais ce chemin comporte une déviation.'
            return result
    result.update(compatible=True,reason='Le chemin jusqu’à cette position appartient au répertoire.')
    return result


@router.get('/repertoires/compatibility')
def compatibility(entry_id: Annotated[int, Query(gt=0)], path: Annotated[str, Query(max_length=2000)] = ''):
    return check_repertoire(RepertoireSource(entry_id=entry_id, path=path))


@router.post('/repertoires/compatibility')
def check_repertoire(request: RepertoireSource):
    with get_conn() as conn:
        conn.execute('BEGIN')
        _,source,nodes,fingerprint,_ = _resolve_repertoire_source(conn,request)
        result = {'white': None,'black': None,'source_fingerprint':fingerprint}
        for base in conn.execute('SELECT * FROM bases ORDER BY id').fetchall():
            settings = settings_of(base)
            color = settings.get('color','white')
            if settings.get('is_repertoire') and settings.get('primary') and color in result:
                result[color] = _compatibility(conn,base,source,nodes)
        return result


class ExtendRequest(RepertoireSource):
    source_fingerprint: StrictStr | None = Field(default=None, pattern='^[0-9a-f]{64}$')
    repertoire_fingerprint: StrictStr | None = Field(default=None, pattern='^[0-9a-f]{64}$')


@router.post('/repertoires/{base_id}/extend')
def extend(base_id: int, request: ExtendRequest):
    with get_conn() as conn:
        # Reserve the write transaction before reading either document. Another
        # annotation/extension must not be overwritten by a stale parsed tree.
        conn.execute('BEGIN IMMEDIATE')
        base = get_base(conn,base_id)
        if not settings_of(base).get('is_repertoire'):
            raise HTTPException(422, 'La base choisie n’est pas un répertoire.')
        entry,source,nodes,fingerprint,source_title = _resolve_repertoire_source(conn,request)
        if request.source_fingerprint is not None and request.source_fingerprint != fingerprint:
            raise HTTPException(409, 'La ligne source a changé. Vérifie à nouveau sa compatibilité.')
        check = _compatibility(conn,base,source,nodes)
        if request.repertoire_fingerprint is not None and request.repertoire_fingerprint != check['repertoire_fingerprint']:
            raise HTTPException(409, 'Le répertoire a changé. Vérifie à nouveau la ligne avant de l’ajouter.')
        if not check['compatible']:
            raise HTTPException(409,check['reason'])
        if not check['extendable']:
            return {'added_moves': 0}
        best = None
        for target in conn.execute('SELECT * FROM entries WHERE base_id=? ORDER BY id',(base_id,)).fetchall():
            game = _repertoire_game(target['pgn'])
            if position_key(game.board()) != position_key(chess.Board()):
                continue
            node,count = game,0
            for source_node in nodes:
                match = next((child for child in node.variations if child.move == source_node.move),None)
                if match is None:
                    break
                node,count = match,count+1
            if best is None or count > best[0]:
                best = (count,target,game,node)
        if best is None:
            game = chess.pgn.Game()
            game.headers['Event'] = 'Répertoire ChessGym'
            game.headers['Result'] = '*'
            count,target,node = 0,None,game
        else:
            count,target,game,node = best
        for original in nodes[count:]:
            node = node.add_variation(original.move)
            node.comment = original.comment
            node.starting_comment = original.starting_comment
            node.nags = set(original.nags)
        pgn = pgnlib.export_game(game)
        if target is None:
            title = 'Ligne depuis ' + (source_title or 'une partie')
            created = conn.execute('''INSERT INTO entries(base_id,title,pgn,selected,start_path,created_at,updated_at)
                         VALUES (?,?,?,1,'',?,?)''',(base_id,title,pgn,stamp(),stamp()))
            target_id = created.lastrowid
        else:
            conn.execute('UPDATE entries SET pgn=?,updated_at=? WHERE id=?',(pgn,stamp(),target['id']))
            target_id = target['id']
        _sync_base(conn,base)
        return {'added_moves': len(nodes)-count, 'entry_id': target_id, 'base_id': base_id}


@router.get('/reviews/{card_id}/source')
def review_source(card_id: str):
    """A detached study copy; opening it never grades or edits its source."""
    with get_conn() as conn:
        row = conn.execute('SELECT e.pgn FROM review_cards c JOIN entries e ON e.id=c.entry_id WHERE c.id=? AND c.active=1', (card_id,)).fetchone()
    if row is None:
        raise HTTPException(404, 'La partie source de cet exercice est introuvable.')
    return pgnlib.game_payload(load_game(row['pgn']))
