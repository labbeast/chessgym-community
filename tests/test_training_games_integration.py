"""Played games feed period goals without creating training sessions or receipts."""
import json

import db
import training_programs as programs
from test_training_programs import client, request, block, program, activate


def seed_game(*, day='2026.10.25', cadence='600+5'):
    with db.get_conn() as conn:
        conn.execute('UPDATE bases SET settings=? WHERE id=1', (json.dumps({'played': True}),))
        pgn = f'[Date "{day}"]\n[TimeControl "{cadence}"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0'
        conn.execute('UPDATE entries SET pgn=? WHERE id=1', (pgn,))


def games_block(**patch):
    return block('games', **{'resource': {'type': 'tool', 'id': 'games'}, 'unit': 'games', **patch})


def test_games_count_original_date_in_overview_and_statistics_without_writes(client):
    seed_game()
    with db.get_conn() as conn:
        before = conn.total_changes
        conn.execute('PRAGMA query_only=ON')
        import training_categories
        overview = training_categories.overview(conn, 1)
        assert conn.total_changes == before
    games = next(c for c in overview['categories'] if c['id'] == 'games')
    assert games['progress']['games'] == 1
    assert games['progress']['duration_ms'] == 1220000
    assert games['progress']['duration_by_kind'] == {'estimated': 1220000}
    stats = request(client, 'GET', '/statistics?date_from=2026-10-25&date_to=2026-10-25')
    assert stats['totals']['duration_ms'] == overview['duration_ms'] == 1220000
    assert stats['days'][0]['by_activity_duration_by_kind']['games'] == {'estimated': 1220000}
    earlier = request(client, 'GET', '/statistics?date_from=2026-10-24&date_to=2026-10-24')
    assert earlier['totals']['duration_ms'] == 0
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM training_activity_credits').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM training_runs').fetchone()[0] == 0


def test_games_daily_weekly_goals_and_multiple_program_goals_count_total_once(client):
    seed_game()
    week = activate(client, program(client, [games_block(target=20), games_block(target=60)]))
    assert all(b['available'] and b['automatic'] for b in week['blocks'])
    assert [b['progress']['duration_ms'] for b in week['blocks']] == [1220000, 1220000]
    assert week['duration_ms'] == 1220000
    assert week['blocks'][0]['progress']['complete'] is True
    assert week['blocks'][1]['progress']['complete'] is False
    request(client, 'PATCH', '/category-goals/games', {
        'expected_revision': 0, 'target_minutes': 60, 'daily_target_minutes': 20,
    })
    overview = request(client, 'GET', '/overview')
    games = next(c for c in overview['categories'] if c['id'] == 'games')
    assert games['today']['complete'] is True
    assert games['progress']['complete'] is False
    summary = request(client, 'GET', '/summary?date_from=2026-10-25&date_to=2026-10-25')
    assert summary['duration_ms'] == 1220000


def test_games_unknown_time_keeps_game_count_and_corrections_refresh(client):
    seed_game(cadence='?')
    overview = request(client, 'GET', '/overview')
    games = next(c for c in overview['categories'] if c['id'] == 'games')
    assert games['progress']['duration_ms'] is None
    assert games['progress']['games'] == 1
    assert games['progress']['unknown_duration_count'] == 1
    seed_game(day='2026.10.20', cadence='300')
    stats = request(client, 'GET', '/statistics?date_from=2026-10-20&date_to=2026-10-20')
    assert stats['totals']['duration_ms'] == 600000
    assert request(client, 'GET', '/statistics?date_from=2026-10-25&date_to=2026-10-25')['totals']['duration_ms'] == 0
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=1')
    assert request(client, 'GET', '/overview')['duration_ms'] == 0


def test_games_is_automatic_but_cannot_create_runs_or_manual_credits(client):
    state = request(client, 'GET', '/state')
    assert any(r['type'] == 'tool' and r['id'] == 'games' for r in state['resources'])
    week = activate(client, program(client, [games_block()]))
    request(client, 'POST', '/categories/games/runs', {}, status=422)
    request(client, 'POST', f"/weeks/{week['id']}/blocks/{week['blocks'][0]['id']}/runs", {}, status=422)
    request(client, 'POST', '/manual-activities', {
        'activity': 'games', 'date': '2026-10-25', 'duration_minutes': 10,
    }, status=422)
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM training_runs').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM training_manual_activities').fetchone()[0] == 0


def test_games_programs_validate_passive_resource_and_game_units(client):
    for invalid in [games_block(metric='sessions'),
                    games_block(metric='quantity', unit='cards')]:
        request(client, 'POST', '/programs', {'name': 'Invalid', 'definition': {'blocks': [invalid]}}, status=422)
    invalid = games_block()
    invalid['resource'] = {'type': 'base', 'id': 1}
    request(client, 'POST', '/programs', {'name': 'Invalid', 'definition': {'blocks': [invalid]}}, status=422)
    assert 'games' not in programs.AUTOMATIC
