"""Review provenance is additive, transactional and included in SQLite backup."""
import json
import sqlite3
from uuid import uuid4

import pytest

import learning_foundations as lf
import db
import training
from test_game_analysis import store, add


@pytest.fixture
def conn():
    connection = sqlite3.connect(':memory:')
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA foreign_keys=ON')
    connection.executescript('''
        CREATE TABLE bases(id INTEGER PRIMARY KEY,name TEXT);
        CREATE TABLE entries(id INTEGER PRIMARY KEY,title TEXT,pgn TEXT,updated_at TEXT);
        CREATE TABLE review_cards(id TEXT PRIMARY KEY,base_id INTEGER,entry_id INTEGER,
            type TEXT,identity TEXT,path TEXT,fen TEXT,answers TEXT,solutions TEXT,
            title TEXT,state TEXT,due TEXT,interval_days REAL,repetitions INTEGER,lapses INTEGER);
        CREATE TABLE review_history(id INTEGER PRIMARY KEY,card_id TEXT,reviewed_at TEXT,grade INTEGER);
        INSERT INTO bases VALUES(7,'Mon répertoire');
        INSERT INTO entries VALUES(12,'Partie modèle','1. e4 e5 *','2026-10-24');
        INSERT INTO review_cards VALUES('existing-card-id',7,12,'solve','solve:12','','start',
            '["e2e4"]','[]','Position','learned','2026-11-24',30,5,1);
        INSERT INTO review_history VALUES(44,'existing-card-id','2026-10-24T12:00:00+00:00',2);
    ''')
    yield connection
    connection.close()


def record(conn, **kwargs):
    card = conn.execute('SELECT * FROM review_cards').fetchone()
    return lf.record_attempt(conn, history_id=44, card=card,
                             settings={'mode': 'hybrid', 'multipliers': {'medium': 2}},
                             content_key='a' * 64, scheduler_version='adaptive-v1',
                             request_id='request-1', context={'kind': 'review'}, **kwargs)


def test_schema_is_idempotent_and_does_not_backfill_or_reidentify(conn):
    old_card = tuple(conn.execute('SELECT * FROM review_cards').fetchone())
    old_history = tuple(conn.execute('SELECT * FROM review_history').fetchone())
    lf.init_schema(conn)
    marker = tuple(conn.execute('SELECT * FROM learning_schema_migrations').fetchone())
    lf.init_schema(conn)
    assert tuple(conn.execute('SELECT * FROM learning_schema_migrations').fetchone()) == marker
    assert tuple(conn.execute('SELECT * FROM review_cards').fetchone()) == old_card
    assert tuple(conn.execute('SELECT * FROM review_history').fetchone()) == old_history
    assert conn.execute('SELECT COUNT(*) FROM review_attempt_context').fetchone()[0] == 0


def test_migration_never_commits_callers_transaction(conn):
    conn.execute('BEGIN')
    conn.execute("UPDATE bases SET name='Not committed' WHERE id=7")
    lf.init_schema(conn)
    assert conn.in_transaction
    conn.rollback()
    assert conn.execute('SELECT name FROM bases').fetchone()[0] == 'Mon répertoire'
    assert not conn.execute("SELECT name FROM sqlite_master WHERE name='review_attempt_context'").fetchone()


def test_context_is_immutable_even_when_source_is_renamed_or_deleted(conn):
    lf.init_schema(conn)
    record(conn)
    original = conn.execute('SELECT snapshot FROM review_attempt_context').fetchone()[0]
    value = json.loads(original)
    assert value['base'] == {'id': 7, 'name': 'Mon répertoire'}
    assert value['card']['identity'] == 'solve:12'
    assert value['card']['repetitions'] == 5
    assert value['content_key'] == 'a' * 64
    assert value['entry']['id'] == 12 and len(value['entry']['pgn_sha256']) == 64
    conn.execute("UPDATE bases SET name='Renamed' WHERE id=7")
    conn.execute('DELETE FROM entries WHERE id=12')
    record(conn)
    assert conn.execute('SELECT snapshot FROM review_attempt_context').fetchone()[0] == original
    assert conn.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 1
    assert conn.execute('SELECT COUNT(*) FROM review_attempt_context').fetchone()[0] == 1
    conn.execute('DELETE FROM review_history WHERE id=44')
    assert conn.execute('SELECT COUNT(*) FROM review_attempt_context').fetchone()[0] == 0


def test_snapshot_keeps_explicit_puzzle_and_analysis_sources(conn):
    conn.executescript('''
        CREATE TABLE puzzle_copies(puzzle_id TEXT,base_id INTEGER,entry_id INTEGER);
        INSERT INTO puzzle_copies VALUES('abc12',7,12);
        CREATE TABLE game_analysis_exercises(source_entry_id INTEGER,source_fingerprint TEXT,
            ply INTEGER,base_id INTEGER,exercise_entry_id INTEGER);
        INSERT INTO game_analysis_exercises VALUES(8,'fingerprint',6,7,12);
        CREATE TABLE game_analysis_reports(entry_id INTEGER,fingerprint TEXT,status TEXT,
            settings TEXT,provenance TEXT,updated_at TEXT);
        INSERT INTO game_analysis_reports VALUES(8,'fingerprint','done','{"depth":20}',
            '{"evaluation_version":1}','2026-10-24');
    ''')
    lf.init_schema(conn)
    record(conn)
    snapshot = json.loads(conn.execute('SELECT snapshot FROM review_attempt_context').fetchone()[0])
    assert snapshot['sources'][0] == {'kind': 'puzzle', 'puzzle_id': 'abc12'}
    source = snapshot['sources'][1]
    assert source['kind'] == 'game_error' and source['source_entry_id'] == 8 and source['ply'] == 6
    assert source['analysis_at_review']['provenance'] == {'evaluation_version': 1}
    conn.execute("UPDATE game_analysis_reports SET fingerprint='changed'")
    assert 'analysis_at_review' not in lf.source_provenance(conn, 12)[1]


def test_recording_rolls_back_with_history_and_backup_keeps_context(conn, tmp_path):
    lf.init_schema(conn)
    conn.commit()
    record(conn)
    assert conn.in_transaction
    conn.rollback()
    assert conn.execute('SELECT COUNT(*) FROM review_attempt_context').fetchone()[0] == 0
    record(conn)
    conn.commit()
    with sqlite3.connect(tmp_path / 'backup.sqlite3') as target:
        conn.backup(target)
        assert target.execute('SELECT COUNT(*) FROM review_attempt_context').fetchone()[0] == 1
        assert target.execute('PRAGMA foreign_key_check').fetchall() == []


def test_cannot_attach_context_to_a_different_card(conn):
    lf.init_schema(conn)
    card = dict(conn.execute('SELECT * FROM review_cards').fetchone())
    card['id'] = 'not-the-reviewed-card'
    with pytest.raises(ValueError):
        lf.record_attempt(conn, history_id=44, card=card, settings={},
                          content_key='x', scheduler_version='v1')


def test_grading_writes_context_once_with_the_authoritative_history(store):
    entry_id = add()
    with db.get_conn() as connection:
        connection.execute('UPDATE entries SET base_id=2 WHERE id=?', (entry_id,))
    card = training.queue(2)['cards'][0]
    request = training.GradeRequest(grade=2, request_id=uuid4(), content_key=card['content_key'])
    first = training.grade_card(card['id'], request)
    assert training.grade_card(card['id'], request) == first
    with db.get_conn() as connection:
        assert connection.execute('SELECT COUNT(*) FROM review_history').fetchone()[0] == 1
        assert connection.execute('SELECT COUNT(*) FROM review_attempt_context').fetchone()[0] == 1
        value = connection.execute('SELECT * FROM review_attempt_context').fetchone()
        snapshot = json.loads(value['snapshot'])
        assert value['request_id'] == str(request.request_id)
        assert value['scheduler_version'] == 'adaptive-v1'
        assert snapshot['card']['id'] == card['id']
        assert snapshot['card']['repetitions'] == 0
        assert snapshot['entry']['id'] == entry_id
        assert snapshot['base'] == {'id': 2, 'name': 'Mes exercices'}
        assert snapshot['content_key'] == card['content_key']
