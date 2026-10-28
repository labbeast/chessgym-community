"""Entry IDs stay unique across deletion, migration and every insertion path."""
import json

import pytest

import db
import game_analysis
import jobs
import sync
import training


LEGACY_SCHEMA = '''
CREATE TABLE bases (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, folder_id INTEGER,
    tags TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE TABLE entries (
    id INTEGER PRIMARY KEY, base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
    title TEXT NOT NULL, pgn TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1,
    start_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX entries_by_base ON entries(base_id);
CREATE TABLE entry_history (
    id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    before_content TEXT NOT NULL, after_content TEXT NOT NULL,
    before_path TEXT NOT NULL DEFAULT '', after_path TEXT NOT NULL DEFAULT '',
    undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1)), created_at TEXT NOT NULL
);
'''
PGN = '[Event "Étude"]\n\n1. e4 {Une note} e5 (1... c5) 2. Nf3 *'


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'entry-identity.sqlite3')


def legacy():
    with db.get_conn() as conn:
        conn.executescript(LEGACY_SCHEMA)
        conn.execute('INSERT INTO bases(id,name,settings,created_at) VALUES(7,?,?,?)',
                     ('Exercices', json.dumps({'review_enabled': True, 'type': 'solve'}), '2026-10-20'))
        for number in (41, 42):
            conn.execute('''INSERT INTO entries(id,base_id,title,pgn,selected,start_path,created_at,updated_at)
                VALUES(?,7,?,?,1,'0',?,?)''', (number, f'Exercice {number}', PGN, '2026-10-19', '2026-10-20'))


def insert_entry(conn):
    return conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
        VALUES(7,'Nouvelle partie',?,'2026-10-20','2026-10-20')''', (PGN,)).lastrowid


def rows(conn, table):
    return [dict(row) for row in conn.execute(f'SELECT * FROM {table}')]


def test_fresh_database_never_reuses_deleted_highest_id(database):
    db.init_db()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(7,'Base','2026-10-20')")
        first = insert_entry(conn)
        conn.execute('DELETE FROM entries WHERE id=?', (first,))
        second = insert_entry(conn)
        assert second > first
        conn.execute('DELETE FROM entries')
    db.init_db()
    with db.get_conn() as conn:
        assert insert_entry(conn) > second
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []


def test_legacy_migration_preserves_all_rows_links_indexes_triggers_and_views(database):
    legacy()
    training.init_training()
    sync.init_sync()
    game_analysis.init_analysis()
    with db.get_conn() as conn:
        base = dict(conn.execute('SELECT * FROM bases WHERE id=7').fetchone())
        training._sync_base(conn, base)
        card = conn.execute('SELECT id FROM review_cards WHERE entry_id=41').fetchone()[0]
        conn.execute('''INSERT INTO review_history(card_id,reviewed_at,grade,proposed_grade,requested_grade,
            errors,hints,elapsed_ms,assisted,mode,interval_days,due) VALUES(?,'date',2,2,2,0,0,1000,0,'hybrid',3,'due')''', (card,))
        conn.execute('''INSERT INTO entry_history(entry_id,before_content,after_content,created_at)
            VALUES(41,'{"title":"Avant"}','{"title":"Après"}','date')''')
        conn.execute("INSERT INTO game_analysis_reports(entry_id,fingerprint,settings,status,created_at,updated_at) VALUES(41,'fp','{}','done','date','date')")
        conn.execute("INSERT INTO game_analysis_positions(entry_id,ply,fen,evaluation) VALUES(41,0,'fen','{}')")
        conn.execute("INSERT INTO game_analysis_exercises(source_entry_id,source_fingerprint,ply,base_id,exercise_entry_id) VALUES(41,'fp',2,7,42)")
        conn.execute("INSERT INTO sync_imports(base_id,site,remote_id,entry_id,imported_at,needs_analysis) VALUES(7,'lichess','game',41,'date',1)")
        conn.execute('CREATE INDEX custom_entry_title ON entries(title)')
        conn.execute('CREATE TABLE entry_audit (entry_id INTEGER, title TEXT)')
        conn.execute('''CREATE TRIGGER entry_title_changed AFTER UPDATE OF title ON entries BEGIN
            INSERT INTO entry_audit(entry_id,title) VALUES(NEW.id,NEW.title); END''')
        conn.execute('CREATE VIEW entry_titles AS SELECT id,title FROM entries')
        tables = ('entries', 'entry_history', 'review_cards', 'review_history', 'sync_imports',
                  'game_analysis_reports', 'game_analysis_positions', 'game_analysis_exercises')
        before = {table: rows(conn, table) for table in tables}
        # Consultation migration adds only this status; the existing history
        # proves entry 41 was reviewed, while background analysis proves nothing.
        for entry in before['entries']:
            entry['seen_at'] = 'date' if entry['id'] == 41 else None
        references = {table: [tuple(row) for row in conn.execute(f'PRAGMA foreign_key_list({table})')] for table in tables[1:]}
    db.init_db()
    db.init_db()  # Idempotent startup must not rebuild or duplicate anything.
    with db.get_conn() as conn:
        assert 'AUTOINCREMENT' in conn.execute("SELECT sql FROM sqlite_master WHERE name='entries'").fetchone()[0]
        assert {table: rows(conn, table) for table in tables} == before
        assert {table: [tuple(row) for row in conn.execute(f'PRAGMA foreign_key_list({table})')] for table in tables[1:]} == references
        assert conn.execute('PRAGMA foreign_key_check').fetchall() == []
        assert {row['name'] for row in conn.execute('PRAGMA index_list(entries)')} == {'entries_by_base', 'custom_entry_title'}
        assert len(rows(conn, 'entry_titles')) == 2
        conn.execute("UPDATE entries SET title='Modifié' WHERE id=41")
        assert rows(conn, 'entry_audit') == [{'entry_id': 41, 'title': 'Modifié'}]
        # CASCADE and SET NULL still operate on the replacement table.
        conn.execute('DELETE FROM entries WHERE id=41')
        for table in ('entry_history', 'sync_imports', 'game_analysis_reports', 'game_analysis_positions', 'game_analysis_exercises'):
            assert rows(conn, table) == []
        assert conn.execute('SELECT entry_id FROM review_cards WHERE id=?', (card,)).fetchone()[0] is None
        assert len(rows(conn, 'review_history')) == 1
        conn.execute('DELETE FROM entries WHERE id=42')
        assert insert_entry(conn) > 42


def test_migration_reserves_deleted_ids_retained_only_in_review_identities(database):
    legacy()
    training.init_training()
    with db.get_conn() as conn:
        base = dict(conn.execute('SELECT * FROM bases WHERE id=7').fetchone())
        training._sync_base(conn, base)
        conn.execute("UPDATE review_cards SET identity='907:8/8/8/8/8/8/8/8 w - -',entry_id=NULL WHERE entry_id=42")
        conn.execute('DELETE FROM entries')
    db.init_db()
    with db.get_conn() as conn:
        assert insert_entry(conn) == 908
        conn.execute('DELETE FROM entries')
        assert insert_entry(conn) == 909


def test_migration_is_atomic_and_restores_foreign_keys_on_validation_failure(database):
    legacy()
    with db.get_conn() as conn:
        conn.execute('PRAGMA foreign_keys=OFF')
        conn.execute("INSERT INTO entry_history(entry_id,before_content,after_content,created_at) VALUES(999,'{}','{}','date')")
        conn.commit()
        conn.execute('PRAGMA foreign_keys=ON')
        before = rows(conn, 'entries')
        with pytest.raises(RuntimeError, match='Liens invalides'):
            db._migrate_entry_identity(conn)
        assert conn.in_transaction is False
        assert conn.execute('PRAGMA foreign_keys').fetchone()[0] == 1
        assert conn.execute('PRAGMA legacy_alter_table').fetchone()[0] == 0
        assert rows(conn, 'entries') == before
        assert len(rows(conn, 'entry_history')) == 1
        assert 'AUTOINCREMENT' not in conn.execute("SELECT sql FROM sqlite_master WHERE name='entries'").fetchone()[0]
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='entries_stable_ids'").fetchone() is None
        # Correcting the old dangling link allows retry, without loss of entries.
        conn.execute('DELETE FROM entry_history WHERE entry_id=999')
        conn.commit()
        db._migrate_entry_identity(conn)
        assert rows(conn, 'entries') == before
        assert conn.execute('PRAGMA foreign_keys').fetchone()[0] == 1


def test_unrecognized_legacy_columns_fail_without_dropping_data(database):
    legacy()
    with db.get_conn() as conn:
        conn.execute("ALTER TABLE entries ADD COLUMN future_field TEXT DEFAULT 'conserver'")
        conn.commit()
        before = rows(conn, 'entries')
        with pytest.raises(RuntimeError, match='Structure des parties inconnue'):
            db._migrate_entry_identity(conn)
        assert rows(conn, 'entries') == before
        assert conn.execute('PRAGMA foreign_keys').fetchone()[0] == 1
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='entries_stable_ids'").fetchone() is None


def test_migration_does_not_commit_callers_transaction(database):
    legacy()
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET title='En attente' WHERE id=41")
        with pytest.raises(RuntimeError, match='transaction indépendante'):
            db._migrate_entry_identity(conn)
        assert conn.in_transaction
        conn.rollback()
        assert conn.execute('SELECT title FROM entries WHERE id=41').fetchone()[0] == 'Exercice 41'


def test_migration_reserves_sources_retained_only_in_old_analysis_jobs(database):
    legacy()
    jobs.init_jobs()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO jobs(kind,status,payload,created_at,updated_at) VALUES('analyse','cancelled',?,'date','date')",
                     (json.dumps({'entry_id': 1200, 'fingerprint': 'old-source'}),))
        conn.execute("INSERT INTO jobs(kind,status,payload,created_at,updated_at) VALUES('analyse','error','broken json','date','date')")
    db.init_db()
    with db.get_conn() as conn:
        assert insert_entry(conn) == 1201
        assert len(rows(conn, 'jobs')) == 2
