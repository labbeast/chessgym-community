"""SQLite storage. The portable local ChessGym profile lives in DATA_DIR."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
import re
import sqlite3
from pathlib import Path
from uuid import uuid4

DATA_DIR = Path(os.environ.get("CHESSGYM_DATA_DIR", Path(__file__).parent / "data"))
DB_PATH = DATA_DIR / "chessgym.sqlite3"


class ManagedConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def get_conn():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=20, factory=ManagedConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=20000")
    return conn


@contextmanager
def read_conn():
    """A cancellable read connection; always detach its handler before closing."""
    import reference_queries
    with get_conn() as conn:
        guard = None
        try:
            guard = reference_queries.attach(conn)
            conn.execute('PRAGMA query_only=ON')
            yield conn
        finally:
            if guard is not None:
                guard.detach(conn)


def init_db():
    with get_conn() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL,
            parent_id INTEGER REFERENCES folders(id) ON DELETE RESTRICT
        );
        CREATE TABLE IF NOT EXISTS bases (
            id INTEGER PRIMARY KEY, name TEXT NOT NULL,
            folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
            tags TEXT NOT NULL DEFAULT '[]', settings TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT, base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
            title TEXT NOT NULL, pgn TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1,
            start_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS entries_by_base ON entries(base_id);
        CREATE TABLE IF NOT EXISTS entry_history (
            id INTEGER PRIMARY KEY, entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
            before_content TEXT NOT NULL, after_content TEXT NOT NULL,
            before_path TEXT NOT NULL DEFAULT '', after_path TEXT NOT NULL DEFAULT '',
            undone INTEGER NOT NULL DEFAULT 0 CHECK(undone IN (0,1)), created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS history_by_entry ON entry_history(entry_id,id);
        CREATE TABLE IF NOT EXISTS service_credentials (
            service TEXT PRIMARY KEY, token TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reference_bases (
            base_id INTEGER PRIMARY KEY REFERENCES bases(id) ON DELETE CASCADE,
            storage_key TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
            encoding TEXT NOT NULL DEFAULT 'utf-8-sig',
            max_games INTEGER, status TEXT NOT NULL DEFAULT 'paused',
            error TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        ''')

        if 'encoding' not in {row['name'] for row in conn.execute('PRAGMA table_info(reference_bases)')}:
            conn.execute("ALTER TABLE reference_bases ADD COLUMN encoding TEXT NOT NULL DEFAULT 'utf-8-sig'")
        _migrate_entry_identity(conn)
        _migrate_entry_seen(conn)
        _migrate_library_organization(conn)
        import reading_progress
        reading_progress.init_schema(conn)
        import reading_visits
        reading_visits.init_schema(conn)
        import workspace_state
        workspace_state.init_schema(conn)
        import entry_catalog
        entry_catalog.init_schema(conn)
        import computer_history
        computer_history.init_schema(conn)
        import color_training
        color_training.init_schema(conn)


def ensure_local_owner(conn=None):
    """Preserve the former owner identity or create a passwordless local profile.

    The historical users table is also referenced by backups and saved work.
    Keeping its identifier and username preserves browser workspace namespaces;
    old password hashes and session rows remain inert migration data.
    """
    if conn is None:
        with get_conn() as connection:
            return ensure_local_owner(connection)
    user = conn.execute('SELECT id,username FROM users WHERE id=1').fetchone()
    if user is None:
        created = conn.execute('''INSERT INTO users(id,username,password_hash,created_at)
                                  VALUES(1,'local','',?) ON CONFLICT(id) DO NOTHING''',
                               (datetime.now(timezone.utc).isoformat(timespec='seconds'),))
        if created.rowcount:
            # Two new installations may share a browser and localhost URL.
            # A new namespace keeps their locally cached drafts separate.
            conn.execute("INSERT INTO preferences(key,value) VALUES('workspace_epoch',?) ON CONFLICT(key) DO NOTHING",
                         (json.dumps(uuid4().hex),))
        user = conn.execute('SELECT id,username FROM users WHERE id=1').fetchone()
    return dict(user)


def _migrate_entry_identity(conn):
    """Keep deleted entry IDs retired, including IDs retained in review history.

    Replace the parent table without renaming the old table: its existing foreign
    keys must continue to reference entries throughout SQLite's schema migration.
    The whole replacement rolls back if copying or foreign-key validation fails.
    """
    schema = conn.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'").fetchone()
    if schema is None or re.search(r'\bAUTOINCREMENT\b', schema['sql'], re.IGNORECASE):
        return
    if conn.in_transaction:
        raise RuntimeError('La migration des identifiants exige une transaction indépendante.')
    foreign_keys = conn.execute('PRAGMA foreign_keys').fetchone()[0]
    legacy_alter = conn.execute('PRAGMA legacy_alter_table').fetchone()[0]
    conn.execute('PRAGMA foreign_keys=OFF')
    # A view may refer to entries while it is briefly absent inside the transaction.
    conn.execute('PRAGMA legacy_alter_table=ON')
    try:
        conn.execute('BEGIN IMMEDIATE')
        fields = ('id', 'base_id', 'title', 'pgn', 'selected', 'start_path', 'created_at', 'updated_at')
        columns = tuple(row['name'] for row in conn.execute('PRAGMA table_info(entries)'))
        if columns != fields:
            raise RuntimeError('Structure des parties inconnue : aucune migration appliquée.')
        objects = [row['sql'] for row in conn.execute(
            "SELECT sql FROM sqlite_master WHERE tbl_name='entries' AND type IN ('index','trigger') AND sql IS NOT NULL")]
        retired_id = conn.execute('SELECT coalesce(max(id),0) FROM entries').fetchone()[0]
        tables = {row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'sqlite_sequence' in tables:
            prior = conn.execute("SELECT seq FROM sqlite_sequence WHERE name='entries'").fetchone()
            if prior:
                retired_id = max(retired_id, prior[0])
        if 'review_cards' in tables:
            # Deleted solve/play sources leave entry_id=NULL, but identity retains it.
            for row in conn.execute("SELECT identity FROM review_cards WHERE type IN ('solve','play')"):
                match = re.match(r'^([1-9][0-9]*):', row['identity'])
                if match:
                    value = int(match.group(1))
                    if value <= 9223372036854775807:
                        retired_id = max(retired_id, value)
        if 'jobs' in tables:
            # Old analysis jobs outlive their source and must not attach to a new game.
            for row in conn.execute("SELECT payload FROM jobs WHERE kind='analyse'"):
                try:
                    payload = json.loads(row['payload'])
                except (TypeError, ValueError):
                    continue
                value = payload.get('entry_id') if isinstance(payload, dict) else None
                if type(value) is int and 0 < value <= 9223372036854775807:
                    retired_id = max(retired_id, value)
        conn.execute('''CREATE TABLE entries_stable_ids (
            id INTEGER PRIMARY KEY AUTOINCREMENT, base_id INTEGER NOT NULL REFERENCES bases(id) ON DELETE CASCADE,
            title TEXT NOT NULL, pgn TEXT NOT NULL, selected INTEGER NOT NULL DEFAULT 1,
            start_path TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        )''')
        names = ','.join(fields)
        conn.execute(f'INSERT INTO entries_stable_ids({names}) SELECT {names} FROM entries')
        conn.execute('DROP TABLE entries')
        conn.execute('ALTER TABLE entries_stable_ids RENAME TO entries')
        for sql in objects:
            conn.execute(sql)
        conn.execute("DELETE FROM sqlite_sequence WHERE name='entries'")
        conn.execute("INSERT INTO sqlite_sequence(name,seq) VALUES('entries',?)", (retired_id,))
        if conn.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise RuntimeError('Liens invalides dans la base : la migration des identifiants est annulée.')
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    finally:
        conn.execute(f'PRAGMA legacy_alter_table={legacy_alter}')
        conn.execute(f'PRAGMA foreign_keys={foreign_keys}')


def _migrate_entry_seen(conn):
    """Remember explicit consultations, recovering only proven past reviews once."""
    if not conn.in_transaction:
        conn.execute('BEGIN IMMEDIATE')
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(entries)')}
    if 'seen_at' in columns:
        return
    conn.execute('ALTER TABLE entries ADD COLUMN seen_at TEXT')
    tables = {row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if 'review_cards' not in tables:
        return
    historical_date = ('(SELECT MIN(h.reviewed_at) FROM review_history h WHERE h.card_id=c.id)'
                       if 'review_history' in tables else 'NULL')
    # A background analysis, generated queue or updated PGN does not prove that
    # the person has seen a game. Keep those entries new instead of guessing.
    conn.execute(f'''UPDATE entries SET seen_at=(
        SELECT MIN(coalesce({historical_date},c.updated_at)) FROM review_cards c
        WHERE c.entry_id=entries.id
          AND (c.repetitions>0 OR c.state='mastered' OR {historical_date} IS NOT NULL)
    ) WHERE EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id=entries.id
        AND (c.repetitions>0 OR c.state='mastered' OR {historical_date} IS NOT NULL))''')


def mark_entry_seen(conn, entry_id, timestamp):
    """Mark in the caller's transaction, without touching PGN/history/scheduling."""
    conn.execute('UPDATE entries SET seen_at=? WHERE id=? AND seen_at IS NULL', (timestamp, entry_id))
    row = conn.execute('SELECT seen_at FROM entries WHERE id=?', (entry_id,)).fetchone()
    return row['seen_at'] if row else None


def _migrate_library_organization(conn):
    """Keep the former alphabetical order once, then persist user ordering."""
    if not conn.in_transaction:
        conn.execute('BEGIN IMMEDIATE')
    columns = {row['name'] for row in conn.execute('PRAGMA table_info(bases)')}
    if 'sort_order' not in columns:
        conn.execute('ALTER TABLE bases ADD COLUMN sort_order INTEGER')
        ordered = conn.execute('SELECT id FROM bases ORDER BY name COLLATE NOCASE,id').fetchall()
        conn.executemany('UPDATE bases SET sort_order=? WHERE id=?',
                         ((index, row['id']) for index, row in enumerate(ordered)))
    conn.execute('CREATE INDEX IF NOT EXISTS bases_by_order ON bases(sort_order,id)')
    conn.execute('''CREATE TRIGGER IF NOT EXISTS new_base_at_end AFTER INSERT ON bases
        WHEN NEW.sort_order IS NULL BEGIN
        UPDATE bases SET sort_order=(SELECT coalesce(max(sort_order),-1)+1 FROM bases WHERE id<>NEW.id)
        WHERE id=NEW.id; END''')
    conn.execute('''CREATE TABLE IF NOT EXISTS base_logos (
        base_id INTEGER PRIMARY KEY REFERENCES bases(id) ON DELETE CASCADE,
        icon TEXT NOT NULL DEFAULT 'database', image BLOB, digest TEXT
    )''')
