"""Menu activity flags follow resumable sessions, without mutating history."""
from datetime import datetime, timezone
import json

from fastapi import FastAPI
from local_test_client import TestClient
import pytest

import db
import training
import puzzle_training
import guess_move
import training_skills
import color_training
import review_maintenance
from accounts_api import require_user

NOW = 1792857600


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'unfinished.sqlite3')
    monkeypatch.setattr(training, 'now', lambda: datetime.fromtimestamp(NOW, timezone.utc))
    db.init_db()
    training.init_training()
    puzzle_training.init_puzzles()
    guess_move.init_guess_move()
    training_skills.init_training_skills()
    color_training.init_color_training()
    with db.get_conn() as conn:
        conn.execute('PRAGMA ignore_check_constraints=ON')
        conn.execute("INSERT INTO users VALUES(1,'owner','unused','today'),(2,'other','unused','today')")
    app = FastAPI()
    app.include_router(training.router)
    app.dependency_overrides[require_user] = lambda: {'id': 1}
    with TestClient(app) as result:
        yield result


def insert(conn, table, **values):
    conn.execute(f"INSERT INTO {table} ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))


def seed_skill(conn, kind, *, user_id=1, started=NOW, finished=None, identity=None):
    insert(conn, 'skill_sessions', id=identity or kind, user_id=user_id, kind=kind,
           config=json.dumps({'duration': 30}), state='{}', created_at=NOW,
           started_at=started, finished_at=finished)


def seed_color(conn, *, user_id=1, started=NOW, finished=None, identity='color'):
    insert(conn, 'color_sessions', id=identity, user_id=user_id, duration=30,
           state='{}', created_at=NOW, started_at=started, finished_at=finished)


def seed_guess(conn, *, user_id=1, path='', identity='guess'):
    insert(conn, 'guess_sessions', id=identity, user_id=user_id, title='Game', source_pgn='*',
           start_path='', current_path=path, side='white', created_at='today', updated_at='today')


def seed_puzzle(conn, *, status='active', mode='classic', identity='puzzle'):
    insert(conn, 'puzzle_attempts', id=identity, puzzle_id='puzzle', mode=mode, snapshot='{}',
           fen='fen', status=status, rated=0, started_at='today', started_ms=NOW * 1000)


def seed_storm(conn, *, deadline=(NOW + 30) * 1000, clock_started=1, status='active'):
    insert(conn, 'puzzle_storm', id='storm', started_ms=NOW * 1000, deadline_ms=deadline,
           clock_started=clock_started, status=status, color='white')


def activities(client):
    result = client.get('/api/training/unfinished')
    assert result.status_code == 200, result.text
    return result.json()['activities']


def test_empty_and_completed_sessions_have_no_indicator(client):
    assert activities(client) == []
    assert client.get('/api/training/unfinished').json()['review_due_count'] == 0
    with db.get_conn() as conn:
        seed_guess(conn, path=None)
        seed_skill(conn, 'coordinates', finished=NOW)
        seed_skill(conn, 'blindfold', finished=NOW)
        seed_color(conn, finished=NOW)
        seed_puzzle(conn, status='completed')
        seed_puzzle(conn, identity='revealed', status='revealed')
        seed_storm(conn, status='completed')
    assert activities(client) == []


def test_active_sessions_are_distinct_and_scoped_to_their_owner(client):
    with db.get_conn() as conn:
        seed_guess(conn)
        seed_skill(conn, 'coordinates')
        seed_skill(conn, 'blindfold')
        seed_color(conn)
        seed_puzzle(conn)
        seed_storm(conn)
    assert activities(client) == ['puzzles', 'guess', 'blindfold', 'coordinates', 'color']
    client.app.dependency_overrides[require_user] = lambda: {'id': 2}
    assert activities(client) == []
    with db.get_conn() as conn:
        seed_guess(conn, user_id=2, identity='other-guess')
        seed_skill(conn, 'blindfold', user_id=2, identity='other-blindfold')
        seed_color(conn, user_id=2, identity='other-color')
    assert activities(client) == ['guess', 'blindfold', 'color']


@pytest.mark.parametrize('seconds_left, expected', [(1, ['puzzles', 'coordinates', 'color']), (0, []), (-1, [])])
def test_timed_sessions_expire_at_the_deadline_without_being_finalized(client, seconds_left, expected):
    with db.get_conn() as conn:
        seed_skill(conn, 'coordinates', started=NOW - 30 + seconds_left)
        seed_color(conn, started=NOW - 30 + seconds_left)
        seed_storm(conn, deadline=(NOW + seconds_left) * 1000)
        # A stale Storm attempt cannot keep the puzzles indicator on by itself.
        seed_puzzle(conn, mode='storm')
        before = '\n'.join(conn.iterdump())
    assert activities(client) == expected
    assert activities(client) == expected
    with db.get_conn() as conn:
        assert '\n'.join(conn.iterdump()) == before


def test_waiting_color_and_storm_and_untimed_blindfold_remain_resumable(client):
    with db.get_conn() as conn:
        seed_color(conn, started=None)
        seed_storm(conn, deadline=1, clock_started=0)
        seed_skill(conn, 'blindfold', started=NOW - 86400)
    assert activities(client) == ['puzzles', 'blindfold', 'color']


def test_unfinished_activity_endpoint_rejects_nonlocal_access(client):
    client.app.dependency_overrides.clear()
    assert client.get('/api/training/unfinished', headers={'Host': 'remote.example'}).status_code == 403


def seed_review_base(conn, name, *, enabled=True, reference=False):
    base_id = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
        (name, json.dumps({'review_enabled': enabled, 'type': 'solve'}), training.stamp())).lastrowid
    if reference:
        insert(conn, 'reference_bases', base_id=base_id, storage_key=name, source='unused.pgn')
    return base_id


def seed_review_card(conn, base_id, identity, *, state='learned', due=None, active=True, maintenance_due=None):
    insert(conn, 'review_cards', id=identity, base_id=base_id, type='solve', identity=identity,
           path='', fen='unused', answers='[]', title=identity, comment='', state=state,
           due=due, active=int(active), updated_at=training.stamp())
    if maintenance_due is not None:
        insert(conn, 'review_maintenance', card_id=identity, due=maintenance_due,
               created_at=training.stamp(), updated_at=training.stamp())


def test_review_count_includes_only_due_cards_from_enabled_study_bases(client):
    past = datetime.fromtimestamp(NOW - 1, timezone.utc).isoformat()
    current = training.stamp()
    future = datetime.fromtimestamp(NOW + 1, timezone.utc).isoformat()
    with db.get_conn() as conn:
        base = seed_review_base(conn, 'Study')
        seed_review_card(conn, base, 'learned', due=past)
        seed_review_card(conn, base, 'learning-at-boundary', state='learning', due=current)
        seed_review_card(conn, base, 'future', due=future)
        seed_review_card(conn, base, 'unseen', state='unseen', due=past)
        seed_review_card(conn, base, 'mastered', state='mastered', due=past)
        seed_review_card(conn, base, 'inactive', due=past, active=False)
        seed_review_card(conn, base, 'undated')
        seed_review_card(conn, base, 'invalid-date', due='invalid')
        disabled = seed_review_base(conn, 'Disabled', enabled=False)
        seed_review_card(conn, disabled, 'disabled', due=past)
        reference = seed_review_base(conn, 'Reference', reference=True)
        seed_review_card(conn, reference, 'reference', due=past)
    result = client.get('/api/training/unfinished').json()
    assert result == {'activities': [], 'review_due_count': 2}
    client.app.dependency_overrides[require_user] = lambda: {'id': 2}
    # /reviews exposes the shared study library to every authenticated account.
    assert client.get('/api/training/unfinished').json()['review_due_count'] == 2


def test_review_count_includes_eligible_maintenance_without_creating_or_grading_it(client, monkeypatch):
    past = datetime.fromtimestamp(NOW - 1, timezone.utc).isoformat()
    future = datetime.fromtimestamp(NOW + 1, timezone.utc).isoformat()
    with db.get_conn() as conn:
        base = seed_review_base(conn, 'Study')
        seed_review_card(conn, base, 'ordinary', due=past)
        for number in range(4):
            seed_review_card(conn, base, f'maintenance-{number}', state='mastered', maintenance_due=past)
        seed_review_card(conn, base, 'future-maintenance', state='mastered', maintenance_due=future)
        seed_review_card(conn, base, 'unscheduled-mastery', state='mastered')
        conn.execute("INSERT OR REPLACE INTO preferences(key,value) VALUES ('review_maintenance',?)",
                     (json.dumps({'enabled': True, 'daily_limit': 2}),))
        before = '\n'.join(conn.iterdump())
    def no_mutation(*args, **kwargs):
        pytest.fail('Navigation must not synchronize or schedule review cards')
    monkeypatch.setattr(training, '_sync_base', no_mutation)
    monkeypatch.setattr(training, 'apply_auto_mastery', no_mutation)
    monkeypatch.setattr(review_maintenance, 'ensure_scheduled', no_mutation)
    for _ in range(2):
        assert client.get('/api/training/unfinished').json() == {'activities': [], 'review_due_count': 3}
    with db.get_conn() as conn:
        assert '\n'.join(conn.iterdump()) == before
        conn.execute("UPDATE preferences SET value=? WHERE key='review_maintenance'",
                     (json.dumps({'enabled': False, 'daily_limit': 2}),))
    assert client.get('/api/training/unfinished').json()['review_due_count'] == 1


def test_review_count_changes_without_changing_unfinished_session_flags(client):
    past = datetime.fromtimestamp(NOW - 1, timezone.utc).isoformat()
    future = datetime.fromtimestamp(NOW + 1, timezone.utc).isoformat()
    with db.get_conn() as conn:
        seed_guess(conn)
        base = seed_review_base(conn, 'Study')
        seed_review_card(conn, base, 'due', due=past)
    assert client.get('/api/training/unfinished').json() == {'activities': ['guess'], 'review_due_count': 1}
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET due=? WHERE id='due'", (future,))
    assert client.get('/api/training/unfinished').json() == {'activities': ['guess'], 'review_due_count': 0}
