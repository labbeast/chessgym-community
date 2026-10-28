"""My Games contributes played time once, with honest measurement provenance."""
import json
from datetime import date

import pytest

import db
import entry_catalog
import pgnlib
import training
import training_games as games
import training_programs


DAY = date(2026, 10, 25)


@pytest.fixture
def client(tmp_path, monkeypatch):
    # These projection tests need storage only; no HTTP server or client thread.
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'games.sqlite3')
    db.init_db()
    training.init_training()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO users VALUES(1,'owner','unused','today')")
        training_programs.init_schema(conn)
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(1,'My games','today')")


def add_game(conn, *, base_id=1, headers=None, moves='1. e4 e5', cached=False):
    tags = {'Date': '2026.10.25', 'White': 'Alice', 'Black': 'Bob', 'Result': '1-0', **(headers or {})}
    text = '\n'.join(f'[{key} "{value}"]' for key, value in tags.items() if value is not None)
    text += '\n\n' + moves + ' ' + tags['Result']
    conn.execute('UPDATE bases SET settings=? WHERE id=?', (json.dumps({'played': True}), base_id))
    identity = conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
        VALUES(?,'Played game',?,'2030-01-01','2030-01-01')''', (base_id, text)).lastrowid
    if cached:
        entry_catalog.get(conn, conn.execute('SELECT * FROM entries WHERE id=?', (identity,)).fetchone())
    return identity


def project(lower=DAY, upper=DAY, user_id=1):
    with db.read_conn() as conn:
        return games.facts(conn, user_id, lower, upper)


def test_duration_priority_and_whole_game_cadence_estimate(client):
    with db.get_conn() as conn:
        add_game(conn, headers={'Duration': '00:02:30.5', 'TimeControl': '600+5',
                                'StartTime': '12:00:00', 'EndTime': '12:04:00'})
        add_game(conn, headers={'StartTime': '12:00:00', 'EndTime': '12:04:00', 'TimeControl': '600+5'})
        add_game(conn, headers={'TimeControl': '600+5'},
                 moves='1. e4 {[%clk 0:10:03]} e5 {[%clk 0:10:00]}')
        add_game(conn, headers={'TimeControl': '600+5'}, moves='1. e4 e5 2. Nf3 Nc6')
        add_game(conn)
    facts = project()
    assert [(f['duration_ms'], f['duration_kind']) for f in facts] == [
        (150500, 'elapsed'), (240000, 'elapsed'), (7000, 'calculated'),
        (1220000, 'estimated'), (None, 'unknown')]
    assert all(f['quantity'] == 1 and f['unit'] == 'games' and f['sessions'] == 0 for f in facts)
    assert all(f['resource']['id'] == 1 for f in facts)
    assert facts[-1]['unknown'] and not facts[0]['unknown']


def test_partial_clocks_do_not_masquerade_as_complete_and_variations_do_not_count(client):
    with db.get_conn() as conn:
        add_game(conn, headers={'TimeControl': '600+5'}, moves='1. e4 {[%clk 0:10:03]} e5')
        add_game(conn, headers={'TimeControl': '600+5'},
                 moves='1. e4 {[%emt 0:00:02]} (1. d4 {[%emt 1:00:00]}) e5 {[%emt 0:00:03]}')
        add_game(conn, moves='1. e4 {[%emt 0:00:02]} e5')
    assert [(f['duration_ms'], f['duration_kind']) for f in project()] == [
        (1210000, 'estimated'), (5000, 'calculated'), (None, 'unknown')]


@pytest.mark.parametrize('control', ['?', '-', '40/7200:3600', '1/86400', '*60', '0+0'])
def test_unsupported_cadences_leave_time_unknown(client, control):
    with db.get_conn() as conn:
        add_game(conn, headers={'TimeControl': control})
    fact, = project()
    assert fact['duration_ms'] is None and fact['duration_kind'] == 'unknown'


def test_played_date_uses_study_timezone_and_boundary_without_import_date(client):
    with db.get_conn() as conn:
        conn.execute("INSERT OR REPLACE INTO preferences VALUES('study_day',?)",
                     (json.dumps({'timezone': 'America/Toronto', 'start_hour': 4}),))
        add_game(conn, headers={'UTCDate': '2026.10.26', 'UTCTime': '07:59:59', 'Duration': '1'})
        add_game(conn, headers={'UTCDate': '2026.10.26', 'UTCTime': '08:00:00', 'Duration': '2'})
        add_game(conn, headers={'Date': '2026.10.26', 'StartTime': '03:59:59', 'Duration': '3'})
        add_game(conn, headers={'Date': '2026.10.25', 'Duration': '4'})
        add_game(conn, headers={'UTCDate': '2026.10.26', 'UTCTime': None, 'Duration': '5'})
        add_game(conn, headers={'Date': '2026.10.??', 'Duration': '6'})
        add_game(conn, headers={'Date': '2026.02.31', 'Duration': '7'})
    assert [f['duration_ms'] for f in project()] == [1000, 3000, 4000]
    assert [f['duration_ms'] for f in project(date(2026, 10, 26), date(2026, 10, 26))] == [2000, 5000]
    assert project(user_id=2) == []


def test_explicit_midnight_interval_is_attributed_to_start_day(client):
    with db.get_conn() as conn:
        add_game(conn, headers={'StartTime': '23:59:00', 'EndDate': '2026.10.26', 'EndTime': '00:01:00'})
        add_game(conn, headers={'StartTime': '23:59:00', 'EndTime': '00:01:00'})
        add_game(conn, headers={'UTCDate': '2026.10.25', 'UTCTime': '23:59:00',
                                'UTCEndDate': '2026.10.26', 'UTCEndTime': '00:02:00'})
        add_game(conn, headers={'Duration': 'invalid', 'TimeControl': '60'})
        add_game(conn, headers={'Duration': '0'})
        add_game(conn, headers={'TimeControl': '1/86400', 'StartTime': '12:00:00', 'EndTime': '13:00:00'})
    assert [(f['duration_ms'], f['duration_kind']) for f in project()] == [
        (120000, 'elapsed'), (None, 'unknown'), (180000, 'elapsed'),
        (120000, 'estimated'), (0, 'elapsed'), (None, 'unknown')]
    assert project(date(2026, 10, 26), date(2026, 10, 26)) == []


def test_same_online_game_is_counted_once_using_best_duration(client):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(2,'Other games','today')")
        add_game(conn, headers={'Site': 'https://lichess.org/abcdefgh/white', 'TimeControl': '600'})
        add_game(conn, base_id=2, headers={'Link': 'https://lichess.org/abcdefgh', 'Duration': '42'})
        add_game(conn, headers={'Site': 'https://lichess.org/ijklmnop', 'Duration': '5'})
        # Identical moves/players without a stable source id can be different games.
        add_game(conn, headers={'Duration': '6'})
        add_game(conn, headers={'Duration': '7'})
    facts = project()
    assert [f['duration_ms'] for f in facts] == [42000, 5000, 6000, 7000]
    assert facts[0]['resource']['id'] == 2


def test_otb_copies_need_identified_event_and_precise_time_or_round(client):
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(2,'Second copy','today')")
        tags = {'Event': 'Club Championship', 'StartTime': '10:00:00', 'Duration': '10'}
        add_game(conn, headers=tags)
        add_game(conn, base_id=2, headers=tags, moves='1. e4 {Comment} (1. d4 d5) e5')
        add_game(conn, headers={**tags, 'StartTime': '11:00:00'})
        round_tags = {'Event': 'Club Championship', 'Round': '1', 'Duration': '20'}
        add_game(conn, headers=round_tags)
        add_game(conn, base_id=2, headers=round_tags)
        add_game(conn, headers={**round_tags, 'Round': '2'})
        add_game(conn, headers={'Event': 'Club Championship', 'Duration': '30'})
        add_game(conn, base_id=2, headers={'Event': 'Club Championship', 'Duration': '30'})
    assert [f['duration_ms'] for f in project()] == [10000, 10000, 20000, 20000, 30000, 30000]


def test_import_identity_survives_removed_source_headers(client):
    with db.get_conn() as conn:
        conn.execute('CREATE TABLE sync_imports(entry_id INTEGER,site TEXT,remote_id TEXT)')
        identity = add_game(conn, headers={'Duration': '42'})
        conn.execute("INSERT INTO sync_imports VALUES(?,'lichess','abcdefgh')", (identity,))
        add_game(conn, headers={'Site': 'https://lichess.org/abcdefgh', 'TimeControl': '600'})
    assert [f['duration_ms'] for f in project()] == [42000]


def test_computer_copies_reference_bases_and_derived_exercises_are_excluded(client):
    with db.get_conn() as conn:
        copied = add_game(conn, headers={'Duration': '60'})
        conn.execute('''INSERT INTO computer_games(user_id,id,revision,snapshot,pgn,white,black,side,
            provider,result,ply_count,time_control,created_at,updated_at)
            VALUES(1,'computer',1,'{}','','Alice','Computer','white','stockfish','1-0',2,'600','today','today')''')
        conn.execute("INSERT INTO computer_game_copies VALUES(1,'computer',1,?,'today')", (copied,))
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(2,'Reference','today')")
        conn.execute("INSERT INTO reference_bases(base_id,storage_key,source) VALUES(2,'reference','file')")
        add_game(conn, base_id=2, headers={'Duration': '60'})
        add_game(conn, headers={'SourceEntry': '1', 'Duration': '60'})
        add_game(conn, headers={'Duration': '60'}, moves='')
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(3,'Ordinary study','today')")
        add_game(conn, base_id=3, headers={'Duration': '60'})
        conn.execute("UPDATE bases SET settings='{}' WHERE id=3")
    assert project() == []


def test_legacy_unknown_result_still_counts_played_game(client):
    with db.get_conn() as conn:
        add_game(conn, headers={'Result': '*', 'TimeControl': '60'})
    fact, = project()
    assert fact['quantity'] == 1 and fact['duration_ms'] == 120000


def test_read_projection_follows_edits_deletes_and_played_membership(client):
    with db.get_conn() as conn:
        identity = add_game(conn, headers={'Duration': '10'}, cached=True)
    assert project()[0]['duration_ms'] == 10000
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET pgn=replace(pgn, '[Duration \"10\"]', '[Duration \"20\"]') WHERE id=?", (identity,))
    assert project()[0]['duration_ms'] == 20000
    with db.get_conn() as conn:
        conn.execute("UPDATE bases SET settings='{}' WHERE id=1")
    assert project() == []
    with db.get_conn() as conn:
        conn.execute('UPDATE bases SET settings=? WHERE id=1', (json.dumps({'played': True}),))
        conn.execute('DELETE FROM entries WHERE id=?', (identity,))
    assert project() == []


def test_out_of_period_games_are_never_replayed_and_reads_do_not_write(client, monkeypatch):
    with db.get_conn() as conn:
        add_game(conn, headers={'Date': '2020.01.01', 'TimeControl': '600'}, cached=True)
        add_game(conn, headers={'Date': '2020.01.02', 'TimeControl': '600'})
        add_game(conn, headers={'Duration': '3'})
    original = pgnlib.load_game
    seen = []

    def tracked(text):
        assert '2020.' not in text
        seen.append(text)
        return original(text)

    monkeypatch.setattr(pgnlib, 'load_game', tracked)
    with db.read_conn() as conn:
        before = conn.total_changes
        assert games.facts(conn, 1, DAY, DAY)[0]['duration_ms'] == 3000
        assert conn.total_changes == before
    assert len(seen) == 1
