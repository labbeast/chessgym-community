"""Statistics aggregate saved records without paging, mutations or cross-user data."""
import json
import sqlite3

import pytest

import db
import training_history as history
from accounts_api import require_user
from test_training_history import (client, seed_all, seed_color, seed_computer,
                                   seed_guess, seed_skill)


def stats(client, tool):
    response = client.get('/api/training/history/statistics', params={'tool': tool})
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize('tool', history.STATISTICS_TOOLS)
def test_empty_statistics_keep_unknown_values_null(client, tool):
    data = stats(client, tool)
    assert data['counts'] == {'total': 0, 'completed': 0, 'active': 0, 'interrupted': 0}
    assert data['duration'] == {'total_ms': None, 'known_count': 0, 'unknown_count': 0}
    assert data['performance_scope'] == 'completed'


def test_computer_results_are_from_the_human_side_and_unknown_duration_excluded(client):
    with db.get_conn() as conn:
        seed_computer(conn, identity='win', result='0-1', side='black')
        seed_computer(conn, identity='loss', result='1-0', side='black', timed=False)
        seed_computer(conn, identity='draw', result='1/2-1/2')
        seed_computer(conn, identity='active', result='*')
    data = stats(client, 'computer')
    assert data['counts'] == {'total': 4, 'completed': 3, 'active': 1, 'interrupted': 0}
    assert data['outcomes']['success'] == data['outcomes']['failure'] == data['outcomes']['draw'] == 1
    assert data['duration'] == {'total_ms': 14000, 'known_count': 2, 'unknown_count': 1}


def test_guess_aggregates_all_scored_moves_and_ignores_pending_scores_and_active_sessions(client):
    with db.get_conn() as conn:
        seed_guess(conn, 'done')
        seed_guess(conn, 'active', active=True)
        conn.execute("INSERT INTO guess_attempts(session_id,path,uci,elapsed_ms,score,exact,result,created_at) VALUES('done','2','d2d4',1000,NULL,0,'{}','today')")
    data = stats(client, 'guess')
    assert data['counts']['active'] == 1
    assert data['metrics']['attempts'] == 2
    assert data['metrics']['score'] == 15 and data['metrics']['maximum'] == 20
    assert data['metrics']['exact_count'] == 1 and data['metrics']['accuracy'] == 75
    assert data['duration']['total_ms'] == 5000


@pytest.mark.parametrize('tool', ('coordinates', 'color'))
def test_drill_accuracy_is_weighted_by_answers_and_excludes_abandoned_sessions(client, tool):
    with db.get_conn() as conn:
        if tool == 'color':
            seed_color(conn, 'first', errors=1)
            seed_color(conn, 'second', errors=0)
            seed_color(conn, 'abandoned', abandoned=True)
            seed_color(conn, 'active', active=True)
            table = 'color_sessions'
        else:
            for identity in ('first', 'second'):
                seed_skill(conn, tool, identity)
            seed_skill(conn, tool, 'abandoned', abandoned=True)
            seed_skill(conn, tool, 'active', active=True)
            table = 'skill_sessions'
        conn.execute(f"UPDATE {table} SET result=? WHERE id='second'", (json.dumps({'score': 8, 'errors': 1}),))
    data = stats(client, tool)
    assert data['counts'] == {'total': 4, 'completed': 2, 'active': 1, 'interrupted': 1}
    assert data['metrics']['score'] == 10 and data['metrics']['errors'] == 2
    assert data['metrics']['maximum'] == 12 and data['metrics']['accuracy'] == 83.3
    assert data['metrics']['best_score'] == 8
    assert data['duration']['known_count'] == 2


def test_blindfold_keeps_solve_and_reconstruction_results_distinct(client):
    with db.get_conn() as conn:
        seed_skill(conn, 'blindfold', 'failed-reconstruction')
        seed_skill(conn, 'blindfold', 'done')
        conn.execute("UPDATE skill_sessions SET result=? WHERE id='done'", (json.dumps({'success': True, 'solve_success': True, 'reconstruction_success': True, 'errors': 0, 'accuracy': 100}),))
    data = stats(client, 'blindfold')
    assert data['outcomes']['success'] == data['outcomes']['failure'] == 1
    assert data['metrics']['solve_success'] == data['metrics']['solve_success_count'] == 2
    assert data['metrics']['reconstruction_success'] == 1
    assert data['metrics']['reconstruction_success_count'] == 2
    assert data['metrics']['accuracy'] == 50 and data['metrics']['accuracy_count'] == 2
    assert data['duration'] == {'total_ms': 6000, 'known_count': 1, 'unknown_count': 1}


def test_statistics_cover_more_than_one_hundred_records(client):
    with db.get_conn() as conn:
        for index in range(137):
            seed_color(conn, str(index))
    data = stats(client, 'color')
    assert data['counts']['completed'] == 137
    assert data['metrics']['score'] == 274
    assert data['duration']['total_ms'] == 137 * 30000


@pytest.mark.parametrize('tool', history.STATISTICS_TOOLS)
def test_statistics_do_not_leak_another_users_records(client, tool):
    with db.get_conn() as conn:
        seed_all(conn)
        if tool == 'computer': seed_computer(conn, 'other', user_id=2)
        elif tool == 'guess': seed_guess(conn, 'other', user_id=2)
        elif tool == 'color': seed_color(conn, 'other', user_id=2)
        else: seed_skill(conn, tool, 'other', user_id=2)
    assert stats(client, tool)['counts']['total'] == 1
    client.app.dependency_overrides[require_user] = lambda: {'id': 2}
    assert stats(client, tool)['counts']['total'] == 1
    client.app.dependency_overrides[require_user] = lambda: {'id': 3}
    assert stats(client, tool)['counts']['total'] == 0


def test_statistics_are_read_only_and_never_finalize_expired_sessions(client):
    with db.get_conn() as conn:
        seed_all(conn)
        seed_color(conn, 'expired-active', active=True)
        before = '\n'.join(conn.iterdump())
    for tool in history.STATISTICS_TOOLS:
        stats(client, tool)
    with db.get_conn() as conn:
        assert '\n'.join(conn.iterdump()) == before


def test_statistics_reject_nonlocal_access_and_unknown_tool(client):
    assert client.get('/api/training/history/statistics?tool=invalid').status_code == 422
    assert client.get('/api/training/history/statistics').status_code == 422
    client.app.dependency_overrides.clear()
    assert client.get('/api/training/history/statistics?tool=color', headers={'Host': 'remote.example'}).status_code == 403


def test_statistics_support_missing_optional_tables_without_migration(client, monkeypatch, tmp_path):
    empty = tmp_path / 'empty-statistics.sqlite3'
    sqlite3.connect(empty).close()
    monkeypatch.setattr(db, 'DB_PATH', empty)
    for tool in history.STATISTICS_TOOLS:
        assert stats(client, tool)['counts']['total'] == 0
    with sqlite3.connect(empty) as conn:
        assert conn.execute('SELECT name FROM sqlite_master').fetchall() == []
