"""The session toolbar reconciles live source time with recorded program time."""
import db
import training_native as native
import training_programs as programs
from test_training_programs import client, request, block, program, activate, run


def test_run_exposes_only_its_own_native_counter_baselines(client):
    blocks = [block('color', resource=programs.tool_resource('color'), unit='positions') for _ in range(2)]
    week = activate(client, program(client, blocks))
    first, other = run(client, week), run(client, week, 1)
    with db.get_conn() as conn:
        native.register(conn, 1, 'color', 'first-source', training_run_id=first['id'])
        native.record(conn, 1, 'color', 'first-source', duration_ms=12000, quantity=3, finished=True)
        native.register(conn, 1, 'color', 'second-source', training_run_id=first['id'])
        native.record(conn, 1, 'color', 'second-source', duration_ms=4000, quantity=1)
        native.register(conn, 1, 'color', 'unrelated-source', training_run_id=other['id'])
        native.record(conn, 1, 'color', 'unrelated-source', duration_ms=50000, quantity=5)
    current = request(client, 'GET', '/runs/' + first['id'])
    assert current['duration_ms'] == 16000
    assert {item['source_id']: (item['duration_ms'], item['finished']) for item in current['native_progress']} == {
        'first-source': (12000, 1), 'second-source': (4000, 0)}
    # A 7-second live counter contributes only its unrecorded 3 seconds.
    source = next(item for item in current['native_progress'] if item['source_id'] == 'second-source')
    assert current['duration_ms'] + max(0, 7000 - source['duration_ms']) == 19000
    again = request(client, 'GET', '/runs/' + first['id'])
    assert again == current


def test_preparing_run_has_no_invented_native_time(client):
    execution = run(client, activate(client, program(client)))
    assert execution['duration_ms'] is None
    assert execution['native_progress'] == []
