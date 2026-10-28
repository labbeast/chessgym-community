"""Native program integration uses accepted facts, durable receipts and measured units."""
import copy
import csv
import io
import json
from datetime import datetime, timezone
from uuid import uuid4

import chess
import pytest
from fastapi import HTTPException

import db
import color_training
import computer_history
import computer_history_api
import guess_move
import puzzle_store
import puzzle_training
import training_activity as activity
import training_assistance as assistance
import training_native as native
import training_programs as programs
import training_skills
from test_training_programs import client, request, block, program, activate, run
from test_computer_history import snapshot


def native_block(tool, **values):
    return block(tool, **{'resource': programs.tool_resource(tool), 'unit': programs.NATIVE_UNITS[tool], **values})


@pytest.fixture
def tools(client, tmp_path, monkeypatch):
    color_training.init_color_training()
    training_skills.init_training_skills()
    guess_move.init_guess_move()
    puzzle_training.init_puzzles()
    monkeypatch.setattr(puzzle_training, '_storm_prefetch_enabled', False)
    with db.get_conn() as conn:
        computer_history.init_schema(conn)
    for router in (color_training.router, training_skills.router, guess_move.router, puzzle_training.router, computer_history_api.router):
        client.app.include_router(router)
    source = tmp_path / 'native-puzzles.csv'
    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(['PuzzleId', 'FEN', 'Moves', 'Rating', 'RatingDeviation', 'Popularity', 'NbPlays', 'Themes', 'GameUrl', 'OpeningTags'])
    for identity, rating in [('PuzzleA', 700), ('PuzzleB', 1500), ('PuzzleC', 1600)]:
        writer.writerow([identity, chess.STARTING_FEN, 'e2e4 e7e5 g1f3 b8c6', rating, 50, 98, 100, 'opening fork', 'https://lichess.org/abcdefgh#1', 'Italian_Game'])
    source.write_text(stream.getvalue(), encoding='utf8')
    puzzle_store.import_bank(source)
    return client


def launch(client, tool, **values):
    week = activate(client, program(client, [native_block(tool, **values)]))
    return week, run(client, week)


def current_run(client, execution):
    return request(client, 'GET', '/runs/' + execution['id'])


def finish(client, execution):
    current = current_run(client, execution)
    return request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'finish', 'expected_revision': current['revision']})


def test_color_creation_receipt_context_pause_expiry_and_explicit_finish(tools, monkeypatch):
    client = tools
    week, execution = launch(client, 'color')
    body = {'duration': 30, 'training_run_id': execution['id'], 'request_id': str(uuid4())}
    created = client.post('/api/skills/color', json=body).json()
    assert created['training_run_id'] == execution['id']
    assert client.post('/api/skills/color', json=body).json()['id'] == created['id']
    assert client.post('/api/skills/color', json={**body, 'duration': 60}).status_code == 409
    assert current_run(client, execution)['quantity'] == 0
    answer = {'index': created['index'], 'nonce': created['nonce'], 'color': color_training.square_color(created['target']['square'])}
    accepted = client.post('/api/skills/color/' + created['id'] + '/answer', json=answer).json()
    client.post('/api/skills/color/' + created['id'] + '/answer', json=answer)
    current = current_run(client, execution)
    assert current['quantity'] == 1 and current['sessions'] == 0
    request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'finish', 'expected_revision': current['revision']}, status=409)
    paused = request(client, 'PATCH', '/runs/' + execution['id'], {'action': 'pause', 'expected_revision': current['revision']})
    monkeypatch.setattr(color_training.time, 'time', lambda: accepted['deadline'] + 1)
    # An explicit program finish can settle an expired native timer even after pause.
    ended = finish(client, execution)
    assert ended['sessions'] == 1 and ended['duration_ms'] == 30000
    assert request(client, 'GET', '/weeks/' + week['id'])['blocks'][0]['progress']['positions'] == 1
    assert client.post('/api/skills/color', json=body).json()['id'] == created['id']


def test_singleton_guard_does_not_abandon_other_active_work(tools):
    client = tools
    old = client.post('/api/skills/color', json={'duration': 30}).json()
    _, execution = launch(client, 'color')
    blocked = client.post('/api/skills/color', json={'duration': 30, 'training_run_id': execution['id'], 'request_id': str(uuid4())})
    assert blocked.status_code == 409
    assert client.get('/api/skills/color/' + old['id']).json()['finished'] is False
    assert current_run(client, execution)['native_ref'] is None


def test_coordinates_counts_accepted_answers_and_rejects_wrong_tool(tools, monkeypatch):
    client = tools
    week, execution = launch(client, 'coordinates', metric='quantity', target=2)
    wrong = client.post('/api/skills/color', json={'training_run_id': execution['id']})
    assert wrong.status_code == 409
    payload = {'duration': 30, 'training_run_id': execution['id'], 'request_id': str(uuid4())}
    created = client.post('/api/skills/coordinates', json=payload).json()
    accepted = client.post('/api/skills/coordinates/' + created['id'] + '/answer', json={'index': 0, 'square': created['target']['square']}).json()
    assert current_run(client, execution)['quantity'] == 1
    assert client.post('/api/skills/coordinates', json=payload).json()['id'] == created['id']
    monkeypatch.setattr(training_skills.time, 'time', lambda: created['deadline'] + 1)
    ended = finish(client, execution)
    assert ended['sessions'] == 1 and ended['duration_ms'] == 30000
    assert request(client, 'GET', '/weeks/' + week['id'])['blocks'][0]['progress']['realized'] == 1


def test_guess_tracks_first_accepted_attempt_and_one_completed_game(tools, monkeypatch):
    client = tools
    monkeypatch.setattr(guess_move, '_evaluate', lambda *args: {'best': {'cp': 0}, 'proposal': {'cp': 0}})
    week, execution = launch(client, 'guess')
    payload = {'entry_id': 1, 'side': 'white', 'training_run_id': execution['id'], 'request_id': str(uuid4())}
    response = client.post('/api/guess-move/sessions', json=payload)
    assert response.status_code == 200, response.text
    created = response.json()
    assert created['training_run_id'] == execution['id']
    answer = {'path': '', 'uci': 'e2e4', 'elapsed_ms': 12000}
    accepted = client.post('/api/guess-move/sessions/' + created['id'] + '/attempt', json=answer)
    assert accepted.status_code == 200, accepted.text
    client.post('/api/guess-move/sessions/' + created['id'] + '/attempt', json=answer)
    assert current_run(client, execution)['duration_ms'] == 12000
    assert current_run(client, execution)['quantity'] == 0
    assert current_run(client, execution)['attempts'] == 1
    assert request(client, 'GET', '/weeks/' + week['id'])['today']['attempts'] == 1
    ended = client.post('/api/guess-move/sessions/' + created['id'] + '/continue', json={'path': ''}).json()
    assert ended['completed']
    assert finish(client, execution)['sessions'] == 1
    progress = request(client, 'GET', '/weeks/' + week['id'])['blocks'][0]['progress']
    assert progress['games'] == 1 and progress['duration_ms'] == 12000
    assert client.post('/api/guess-move/sessions', json={**payload, 'side': 'both'}).status_code == 409


def test_puzzles_count_once_and_storm_only_credits_parent(tools, monkeypatch):
    client = tools
    week, execution = launch(client, 'puzzles')
    payload = {'puzzle_id': 'PuzzleA', 'training_run_id': execution['id'], 'request_id': str(uuid4())}
    created = client.post('/api/puzzles/attempts', json=payload).json()
    assert created['training_run_id'] == execution['id']
    assert client.post('/api/puzzles/attempts', json=payload).json()['id'] == created['id']
    assert client.post('/api/puzzles/attempts', json={**payload, 'puzzle_id': 'PuzzleB'}).status_code == 409
    first = client.post('/api/puzzles/attempts/' + created['id'] + '/move', json={'request_id': 'native-puzzle-move-1', 'version': 0, 'move': 'e7e5'}).json()['attempt']
    client.post('/api/puzzles/attempts/' + created['id'] + '/move', json={'request_id': 'native-puzzle-move-2', 'version': first['version'], 'move': 'b8c6'})
    assert current_run(client, execution)['quantity'] == 1
    storm_payload = {'training_run_id': execution['id'], 'request_id': str(uuid4()), 'filters': {'color': 'black'}}
    storm = client.post('/api/puzzles/storm', json=storm_payload).json()
    assert storm['storm']['training_run_id'] == execution['id']
    attempt = storm['attempt']
    client.post('/api/puzzles/attempts/' + attempt['id'] + '/move', json={'request_id': 'native-storm-move-1', 'version': 0, 'move': 'e7e5'})
    assert current_run(client, execution)['quantity'] == 2
    with db.get_conn() as conn:
        links = conn.execute('SELECT tool,source_id FROM training_activity_links WHERE run_id=?', (execution['id'],)).fetchall()
        assert {(row['tool'], row['source_id']) for row in links} == {('puzzles', created['id']), ('storm', storm['storm']['id'])}
        deadline = conn.execute('SELECT deadline_ms FROM puzzle_storm WHERE id=?', (storm['storm']['id'],)).fetchone()[0]
    monkeypatch.setattr(puzzle_training.time, 'time', lambda: deadline / 1000 + 1)
    assert finish(client, execution)['sessions'] == 1


def test_blindfold_reconstruction_preserves_source_and_records_total_duration(tools, monkeypatch):
    client = tools
    week, execution = launch(client, 'blindfold')
    with db.get_conn() as conn:
        source = conn.execute('SELECT pgn FROM entries WHERE id=1').fetchone()[0]
    payload = {'mode': 'reconstruct', 'entry_id': 1, 'training_run_id': execution['id'], 'request_id': str(uuid4())}
    response = client.post('/api/skills/blindfold', json=payload)
    assert response.status_code == 200, response.text
    created = response.json()
    assert created['training_run_id'] == execution['id']
    client.post('/api/skills/blindfold/' + created['id'] + '/ready')
    ended = client.post('/api/skills/blindfold/' + created['id'] + '/position', json={'pieces': {}}).json()
    assert ended['finished']
    assert current_run(client, execution)['quantity'] == 1
    assert current_run(client, execution)['duration_ms'] == ended['result']['total_elapsed_ms']
    assert finish(client, execution)['sessions'] == 1
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=1').fetchone()[0] == source


def test_computer_uses_active_high_water_and_never_recounts_takeback(tools):
    client = tools
    week, execution = launch(client, 'computer')
    def save(value, revision):
        value['session']['training_run_id'] = execution['id']
        response = client.put('/api/computer/games/' + value['session']['id'], json={'snapshot': value, 'expected_revision': revision, 'mutation_id': str(uuid4())})
        assert response.status_code == 200, response.text
        return response.json()['revision']
    value = snapshot(game_id='tracked-computer')
    value['session']['activity'] = {'version': 1, 'elapsed_ms': 0}
    revision = save(value, 0)
    for duration in [12000, 3000, 12000, 18000]:
        value = snapshot(['e2e4'], game_id='tracked-computer')
        value['session']['activity'] = {'version': 1, 'elapsed_ms': duration}
        revision = save(value, revision)
    value['session']['resigned'] = True
    save(value, revision)
    current = current_run(client, execution)
    assert current['duration_ms'] == 18000 and current['quantity'] == 1
    assert finish(client, execution)['sessions'] == 1


@pytest.mark.parametrize('tool', list(native.TOOLS))
def test_adapter_cross_week_high_water_and_legacy_unknown_baseline(client, monkeypatch, tool):
    activity_name = native.TOOLS[tool]
    week, execution = launch(client, activity_name)
    with db.get_conn() as conn:
        native.register(conn, 1, tool, 'new-native', training_run_id=execution['id'])
        native.record(conn, 1, tool, 'new-native', duration_ms=1000, quantity=1)
        native.record(conn, 1, tool, 'new-native', duration_ms=500, quantity=0)
    monkeypatch.setattr(programs, 'now', lambda: datetime(2026, 10, 26, 16, tzinfo=timezone.utc))
    newer = request(client, 'POST', '/weeks/current', {})['week']
    with db.get_conn() as conn:
        native.record(conn, 1, tool, 'new-native', duration_ms=1500, quantity=2, finished=True)
        native.record(conn, 1, tool, 'old-unknown', duration_ms=None, quantity=10)
        native.record(conn, 1, tool, 'old-unknown', duration_ms=90000, quantity=10)
        native.record(conn, 1, tool, 'old-unknown', duration_ms=91000, quantity=11)
    assert request(client, 'GET', '/weeks/' + week['id'])['duration_ms'] == 1000
    # The older occurrence contributes only its new 1000 ms; automatic
    # assignment now includes this eligible free work in the programme too.
    assert request(client, 'GET', '/weeks/' + newer['id'])['duration_ms'] == 1500
    with db.get_conn() as conn:
        old = conn.execute("SELECT id FROM training_activity_links WHERE source_key=?", ('native:' + tool + ':old-unknown',)).fetchone()
        credits = conn.execute('SELECT SUM(duration_ms),SUM(quantity) FROM training_activity_credits WHERE activity_id=?', (old['id'],)).fetchone()
        assert tuple(credits) == (1000, 1)


def test_native_credit_failure_rolls_back_authoritative_color_answer(tools, monkeypatch):
    client = tools
    _, execution = launch(client, 'color')
    created = client.post('/api/skills/color', json={'training_run_id': execution['id']}).json()
    monkeypatch.setattr(activity, '_credit', lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError('forced atomic failure')))
    with pytest.raises(RuntimeError):
        client.post('/api/skills/color/' + created['id'] + '/answer', json={'index': 0, 'nonce': created['nonce'], 'color': color_training.square_color(created['target']['square'])})
    state = client.get('/api/skills/color/' + created['id']).json()
    assert state['index'] == 0 and state['started_at'] is None


def test_assistance_respects_opt_out_and_explicit_unassignment(client):
    week = activate(client, program(client, [native_block('guess')]))
    assert request(client, 'GET', '/assistance')['settings']['auto_assign']
    request(client, 'PATCH', '/assistance/settings', {'expected_revision': 0, 'auto_assign': False})
    with db.get_conn() as conn:
        native.register(conn, 1, 'guess', 'free-source', base_id=1)
        native.record(conn, 1, 'guess', 'free-source', duration_ms=2000, quantity=1, finished=True)
    overview = request(client, 'GET', '/assistance')
    assert not overview['settings']['auto_assign'] and overview['unambiguous_count'] == 1
    free = request(client, 'GET', '/activities?unassigned=true')['items'][0]
    before = free['first_at']
    assert request(client, 'POST', '/assistance/assign', {}) == {'assigned': 1, 'remaining': 0}
    progress = request(client, 'GET', '/weeks/' + week['id'])['blocks'][0]['progress']
    assert progress['games'] == 1 and progress['duration_ms'] == 2000
    assigned = request(client, 'GET', '/activities')['items'][0]
    assert assigned['first_at'] == before
    unassigned = request(client, 'PUT', '/activities/' + assigned['id'] + '/assignment', {'expected_revision': assigned['revision'], 'week_id': None, 'block_id': None})
    request(client, 'PATCH', '/assistance/settings', {'expected_revision': 1, 'auto_assign': True})
    with db.get_conn() as conn:
        native.record(conn, 1, 'guess', 'free-source', duration_ms=3000, quantity=1, finished=True)
    assert request(client, 'GET', '/activities')['items'][0]['assignment'] is None
    with db.get_conn() as conn:
        native.register(conn, 1, 'guess', 'new-free-source', base_id=1)
        native.record(conn, 1, 'guess', 'new-free-source', duration_ms=1000, quantity=1, finished=True)
    assert request(client, 'GET', '/weeks/' + week['id'])['blocks'][0]['progress']['duration_ms'] == 1000


def test_auto_assignment_leaves_ambiguous_resources_for_user(client):
    first = native_block('guess')
    second = native_block('guess', resource={'type': 'base', 'id': 1})
    week = activate(client, program(client, [first, second]))
    request(client, 'PATCH', '/assistance/settings', {'expected_revision': 0, 'auto_assign': True})
    with db.get_conn() as conn:
        native.register(conn, 1, 'guess', 'ambiguous-source', base_id=1)
        native.record(conn, 1, 'guess', 'ambiguous-source', duration_ms=1000, quantity=1, finished=True)
    assert request(client, 'GET', '/assistance')['unambiguous_count'] == 0
    assert request(client, 'GET', '/activities?unassigned=true')['items'][0]['assignment'] is None


def test_suggestions_exclude_unknown_duration_occurrences_and_apply_only_explicitly(client):
    value = program(client, [native_block('computer', unit_minutes=20)])
    week = activate(client, value)
    request(client, 'PATCH', '/assistance/settings', {'expected_revision': 0, 'auto_assign': True})
    with db.get_conn() as conn:
        for index, duration in enumerate([120000, 120000, 120000, None, None]):
            native.register(conn, 1, 'computer', str(index))
            native.record(conn, 1, 'computer', str(index), duration_ms=duration, quantity=1, finished=True, duration_kind='active')
    suggestion = next(item for item in request(client, 'GET', '/assistance')['suggestions'] if item['field'] == 'unit_minutes')
    assert suggestion['proposed'] == 2 and suggestion['samples'] == 3
    assert request(client, 'GET', '/programs/' + value['id'])['definition']['blocks'][0]['unit_minutes'] == 20
    body = {**suggestion, 'expected_revision': value['revision']}
    changed = request(client, 'POST', '/assistance/apply', body)
    assert changed['definition']['blocks'][0]['unit_minutes'] == 2
    assert request(client, 'GET', '/weeks/' + week['id'])['definition']['blocks'][0]['unit_minutes'] == 20
    request(client, 'POST', '/assistance/apply', {**body, 'expected_revision': changed['revision']}, status=409)


def test_duplicate_week_is_independent_draft_with_no_copied_work_and_receipt(client):
    week, execution = launch(client, 'color')
    with db.get_conn() as conn:
        native.register(conn, 1, 'color', 'finished-color', training_run_id=execution['id'])
        native.record(conn, 1, 'color', 'finished-color', duration_ms=30000, quantity=10, finished=True)
    body = {'name': 'Copied plan', 'expected_revision': week['revision'], 'mutation_id': str(uuid4())}
    duplicate = request(client, 'POST', '/weeks/' + week['id'] + '/duplicate', body)
    assert duplicate == request(client, 'POST', '/weeks/' + week['id'] + '/duplicate', body)
    assert duplicate['status'] == 'draft' and duplicate['definition']['blocks'][0]['id'] != week['blocks'][0]['id']
    assert request(client, 'GET', '/state')['current_program_id'] == week['program_id']
    copied_week = activate(client, duplicate)
    assert copied_week['duration_ms'] is None and copied_week['blocks'][0]['progress']['positions'] == 0


@pytest.mark.parametrize('tool, options', [
    ('color', {'duration': 45}), ('coordinates', {'mode': 'invented'}),
    ('computer', {'skill': 21}), ('computer', {'clock_minutes': -1}),
    ('blindfold', {'max_pieces': 40}), ('guess', {'side': 'random'}),
    ('puzzles', {'filters': {'rating_min': 2000, 'rating_max': 1000}}),
    ('puzzles', {'training_run_id': 'must-not-be-saved'}),
])
def test_program_rejects_invalid_native_launch_settings_atomically(client, tool, options):
    body = {'name': 'Invalid', 'definition': {'blocks': [native_block(tool, options=options)]}}
    request(client, 'POST', '/programs', body, status=422)
    assert request(client, 'GET', '/programs')['items'] == []


def test_configured_auto_assignment_requires_the_actual_selection(client):
    week = activate(client, program(client, [native_block('color', options={'duration': 60})]))
    request(client, 'PATCH', '/assistance/settings', {'expected_revision': 0, 'auto_assign': True})
    with db.get_conn() as conn:
        for identity, duration in [('wrong-selection', 30), ('matching-selection', 60)]:
            native.register(conn, 1, 'color', identity, options={'duration': duration})
            native.record(conn, 1, 'color', identity, duration_ms=duration * 1000, quantity=20, finished=True)
    state = request(client, 'GET', '/weeks/' + week['id'])
    assert state['blocks'][0]['progress']['duration_ms'] == 60000
    assert len(state['unassigned']) == 1 and state['unassigned'][0]['source_id'] == 'wrong-selection'


def test_program_and_native_contexts_are_owner_scoped(tools):
    from accounts_api import require_user
    client = tools
    week, execution = launch(client, 'color')
    created = client.post('/api/skills/color', json={'training_run_id': execution['id'], 'request_id': 'owner-source-launch'}).json()
    client.app.dependency_overrides[require_user] = lambda: {'id': 2}
    assert client.get('/api/skills/color/' + created['id']).status_code == 404
    assert client.post('/api/skills/color', json={'training_run_id': execution['id'], 'request_id': 'owner-source-launch'}).status_code == 404
    assert request(client, 'GET', '/assistance')['settings'] == {'auto_assign': True, 'revision': 0}
    request(client, 'POST', '/weeks/' + week['id'] + '/duplicate', {'expected_revision': week['revision']}, status=404)


def test_summaries_never_expire_native_sessions_or_create_credits(tools, monkeypatch):
    client = tools
    week, execution = launch(client, 'coordinates')
    created = client.post('/api/skills/coordinates', json={'training_run_id': execution['id']}).json()
    def snapshot_tables():
        with db.get_conn() as conn:
            return {name: [dict(row) for row in conn.execute('SELECT * FROM ' + name + ' ORDER BY rowid')]
                    for name in ('training_native_sources', 'training_activity_links', 'training_activity_credits', 'skill_sessions', 'training_weeks')}
    before = snapshot_tables()
    monkeypatch.setattr(training_skills.time, 'time', lambda: created['deadline'] + 60)
    for endpoint in ['/state', '/summary', '/assistance', '/weeks/' + week['id'], '/runs/' + execution['id']]:
        request(client, 'GET', endpoint)
    assert snapshot_tables() == before


def test_personal_backup_keeps_native_context_receipts_and_high_water(tools, tmp_path):
    import backup_service
    import sqlite3
    import zipfile
    client = tools
    week, execution = launch(client, 'color')
    body = {'duration': 30, 'training_run_id': execution['id'], 'request_id': 'backup-native-launch'}
    created = client.post('/api/skills/color', json=body).json()
    client.post('/api/skills/color/' + created['id'] + '/answer', json={'index': 0, 'nonce': created['nonce'], 'color': color_training.square_color(created['target']['square'])})
    request(client, 'PATCH', '/assistance/settings', {'expected_revision': 0, 'auto_assign': True})
    archive = tmp_path / 'native-backup.zip'
    backup_service.build_archive(archive)
    with zipfile.ZipFile(archive) as zipped:
        target = tmp_path / 'restore-check'
        target.mkdir()
        zipped.extract('chessgym.sqlite3', target)
    with sqlite3.connect(target / 'chessgym.sqlite3') as restored:
        restored.row_factory = sqlite3.Row
        programs.init_schema(restored)
        assert native.creation(restored, 1, 'color', execution['id'], body['request_id'], request_payload=body) == created['id']
        assert assistance.settings(restored, 1)['auto_assign']
        assert activity.week_summary(restored, 1, week['id'])['attempts'] == 1
        before = restored.execute('SELECT COUNT(*) FROM training_activity_credits').fetchone()[0]
        native.record(restored, 1, 'color', created['id'], duration_ms=0, quantity=1)
        assert restored.execute('SELECT COUNT(*) FROM training_activity_credits').fetchone()[0] == before
        assert restored.execute('PRAGMA foreign_key_check').fetchall() == []


def test_failed_puzzle_counts_as_work_without_finishing_the_block(tools, monkeypatch):
    client = tools
    week = activate(client, program(client, [native_block('puzzles')]))
    clock = [1792944000.0]
    monkeypatch.setattr(puzzle_training.time, 'time', lambda: clock[0])
    created = client.post('/api/puzzles/attempts', json={'puzzle_id': 'PuzzleA'}).json()
    clock[0] += 12
    response = client.post('/api/puzzles/attempts/' + created['id'] + '/move', json={'request_id': 'daily-failed-puzzle', 'version': 0, 'move': 'c7c5'})
    assert response.status_code == 200, response.text
    assert response.json()['attempt']['failed']
    client.post('/api/puzzles/attempts/' + created['id'] + '/move', json={'request_id': 'daily-failed-puzzle', 'version': 0, 'move': 'c7c5'})
    result = request(client, 'GET', '/weeks/' + week['id'])
    assert result['today']['attempts'] == result['blocks'][0]['progress']['positions'] == 1
    assert result['today']['duration_ms'] == 12000
    assert result['blocks'][0]['progress']['sessions'] == 0


def test_blindfold_two_stages_do_not_count_solving_time_twice(tools, monkeypatch):
    client = tools
    _, execution = launch(client, 'blindfold')
    clock = [1000000.0]
    monkeypatch.setattr(training_skills.time, 'time', lambda: clock[0])
    payload = {'mode': 'positions', 'max_pieces': 32, 'rating_min': 0, 'rating_max': 4000, 'reconstruct_after': True, 'training_run_id': execution['id']}
    response = client.post('/api/skills/blindfold', json=payload)
    assert response.status_code == 200, response.text
    created = response.json()
    clock[0] += 5
    client.post('/api/skills/blindfold/' + created['id'] + '/ready')
    clock[0] += 10
    client.post('/api/skills/blindfold/' + created['id'] + '/answer', json={'index': 0, 'move': 'e7e5'})
    clock[0] += 10
    solved = client.post('/api/skills/blindfold/' + created['id'] + '/answer', json={'index': 1, 'move': 'b8c6'}).json()
    assert solved['phase'] == 'reconstruct'
    assert current_run(client, execution)['duration_ms'] == 25000
    clock[0] += 10
    finished = client.post('/api/skills/blindfold/' + created['id'] + '/position', json={'pieces': {}}).json()
    assert finished['finished']
    assert current_run(client, execution)['duration_ms'] == finished['result']['total_elapsed_ms'] == 35000
