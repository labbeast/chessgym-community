"""Saved analysis provenance never guesses the engine or rewrites old reports."""
import json

import db
import engine
import game_analysis as ga
from test_game_analysis import store, add, fake_engine, run


def test_new_report_records_versions_parameters_and_each_evaluation(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    monkeypatch.setattr(ga, '_engine_identity', lambda: 'original-engine')
    _, summary = run(entry_id, depth=20, time_ms=900)
    provenance = summary['provenance']
    assert provenance['versions_match'] is True
    recorded = provenance['recorded']
    assert recorded['evaluation_version'] == ga.EVALUATION_VERSION
    assert recorded['classification_version'] == ga.CLASSIFICATION_VERSION
    assert recorded['engine_identity'] == 'original-engine'
    assert recorded['requested'] == {'depth': 20, 'time_ms': 900, 'multipv': 1, 'skill': 20}
    report = ga.get_analysis(entry_id)
    assert report['summary']['provenance'] == provenance
    assert all(item['provenance']['method'] == 'engine' for item in report['positions'])
    # Reading saved analysis must not depend on the currently available engine.
    monkeypatch.setattr(engine, 'status', lambda: (_ for _ in ()).throw(AssertionError('No engine lookup')))
    monkeypatch.setattr(ga, '_engine_identity', lambda: 'replacement-engine')
    assert ga.get_analysis(entry_id)['summary']['provenance']['recorded'] == recorded


def test_legacy_report_stays_readable_unknown_and_unmodified(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    with db.get_conn() as conn:
        conn.execute('UPDATE game_analysis_reports SET provenance=NULL WHERE entry_id=?', (entry_id,))
        original = tuple(conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone())
        positions = conn.execute('SELECT evaluation FROM game_analysis_positions WHERE entry_id=?', (entry_id,)).fetchall()
    ga.init_analysis()
    report = ga.get_analysis(entry_id)
    assert report['status'] == 'done'
    assert report['summary']['provenance']['recorded'] is None
    assert report['summary']['provenance']['versions_match'] is None
    with db.get_conn() as conn:
        assert tuple(conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?', (entry_id,)).fetchone()) == original
        assert [tuple(row) for row in conn.execute('SELECT evaluation FROM game_analysis_positions WHERE entry_id=?', (entry_id,))] == [tuple(row) for row in positions]


def test_classification_change_is_visible_without_recalculating_saved_scores(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    previous = ga.CLASSIFICATION_VERSION
    monkeypatch.setattr(ga, 'CLASSIFICATION_VERSION', previous + 1)
    value = ga.get_analysis(entry_id)['summary']['provenance']
    assert value['recorded']['classification_version'] == previous
    assert value['rendered_with']['classification_version'] == previous + 1
    assert value['versions_match'] is False


def test_legacy_classification_is_rebuilt_with_lichess_thresholds_without_engine_or_writes(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch, scores=(50, 0, 100))
    run(entry_id)
    with db.get_conn() as conn:
        provenance = json.loads(conn.execute('SELECT provenance FROM game_analysis_reports WHERE entry_id=?',
                                             (entry_id,)).fetchone()[0])
        provenance['classification_version'] = 1
        conn.execute('UPDATE game_analysis_reports SET provenance=? WHERE entry_id=?',
                     (json.dumps(provenance), entry_id))
        original_report = tuple(conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?',
                                             (entry_id,)).fetchone())
        original_positions = [tuple(row) for row in conn.execute(
            'SELECT * FROM game_analysis_positions WHERE entry_id=? ORDER BY ply', (entry_id,))]
    monkeypatch.setattr(engine, '_run', lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError('No engine run')))
    monkeypatch.setattr(engine, 'status', lambda: (_ for _ in ()).throw(AssertionError('No engine lookup')))
    report = ga.get_analysis(entry_id)
    assert [(item['ply'], item['kind']) for item in report['findings']] == [(2, 'inaccuracy')]
    assert report['summary']['inaccuracies'] == 1
    assert report['summary']['mistakes'] == report['summary']['blunders'] == 0
    assert report['summary']['provenance']['recorded']['classification_version'] == 1
    assert report['summary']['provenance']['rendered_with']['classification_version'] == 2
    assert report['summary']['provenance']['versions_match'] is False
    with db.get_conn() as conn:
        assert tuple(conn.execute('SELECT * FROM game_analysis_reports WHERE entry_id=?',
                                  (entry_id,)).fetchone()) == original_report
        assert [tuple(row) for row in conn.execute('SELECT * FROM game_analysis_positions WHERE entry_id=? ORDER BY ply',
                                                  (entry_id,))] == original_positions


def test_deeper_verification_keeps_its_own_parameters(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    original = ga.get_analysis(entry_id)
    ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': original['fingerprint']})
    report = ga.get_analysis(entry_id)
    assert report['summary']['provenance']['recorded']['requested']['time_ms'] == 400
    assert report['positions'][0]['provenance']['requested']['time_ms'] == 2000
    assert report['positions'][0]['provenance']['requested']['depth'] == 24
    assert report['positions'][1]['provenance']['requested']['time_ms'] == 2000
    assert report['positions'][2]['provenance']['requested']['time_ms'] == 400


def test_migration_from_old_report_schema_preserves_all_rows(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    with db.get_conn() as conn:
        conn.execute('ALTER TABLE game_analysis_reports DROP COLUMN provenance')
        original = [tuple(row) for row in conn.execute('SELECT * FROM game_analysis_reports')]
    ga.init_analysis()
    ga.init_analysis()
    with db.get_conn() as conn:
        assert [tuple(row)[:-1] for row in conn.execute('SELECT * FROM game_analysis_reports')] == original
        assert conn.execute('SELECT provenance FROM game_analysis_reports').fetchone()[0] is None
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
