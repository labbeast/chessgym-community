"""Transactional source revisions and per-entry review-card derivations.

SQL triggers cover ordinary edits as well as every application workflow.
Rollbacks, restarts, deletions and entry moves cannot poison this cache.
"""
import hashlib
import json


def json_text(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(json_text(value).encode()).hexdigest()


def init_schema(conn):
    conn.executescript('''
    CREATE TABLE IF NOT EXISTS review_generation (
      base_id INTEGER PRIMARY KEY REFERENCES bases(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 0, synced_revision INTEGER NOT NULL DEFAULT -1,
      settings_key TEXT
    );
    CREATE TABLE IF NOT EXISTS review_entry_derivations (
      entry_id INTEGER PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL, cards TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS review_grade_receipts (
      request_id TEXT PRIMARY KEY, request_json TEXT NOT NULL,
      response_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS review_source_insert AFTER INSERT ON entries BEGIN
      INSERT INTO review_generation(base_id,revision) VALUES (NEW.base_id,1)
      ON CONFLICT(base_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS review_source_delete AFTER DELETE ON entries BEGIN
      INSERT INTO review_generation(base_id,revision)
      SELECT OLD.base_id,1 WHERE EXISTS (SELECT 1 FROM bases WHERE id=OLD.base_id)
      ON CONFLICT(base_id) DO UPDATE SET revision=revision+1;
    END;
    CREATE TRIGGER IF NOT EXISTS review_source_update
      AFTER UPDATE OF base_id,pgn,title,start_path,selected ON entries
      WHEN OLD.base_id IS NOT NEW.base_id OR OLD.pgn IS NOT NEW.pgn
        OR OLD.title IS NOT NEW.title OR OLD.start_path IS NOT NEW.start_path
        OR OLD.selected IS NOT NEW.selected
    BEGIN
      INSERT INTO review_generation(base_id,revision) VALUES (OLD.base_id,1)
      ON CONFLICT(base_id) DO UPDATE SET revision=revision+1;
      INSERT INTO review_generation(base_id,revision)
      SELECT NEW.base_id,1 WHERE NEW.base_id != OLD.base_id
      ON CONFLICT(base_id) DO UPDATE SET revision=revision+1;
    END;
    ''')


def is_current(conn, base_id, generation_settings):
    row = conn.execute('SELECT revision,synced_revision,settings_key FROM review_generation WHERE base_id=?', (base_id,)).fetchone()
    return bool(row and row['revision'] == row['synced_revision'] and row['settings_key'] == digest([1, generation_settings]))


def sync(conn, base_id, generation_settings, derive, timestamp):
    """Caller holds a write transaction and provides its canonical base snapshot."""
    conn.execute('INSERT OR IGNORE INTO review_generation(base_id) VALUES (?)', (base_id,))
    revision = conn.execute('SELECT * FROM review_generation WHERE base_id=?', (base_id,)).fetchone()
    settings_key = digest([1, generation_settings])  # Bump if derivation semantics change.
    if revision['revision'] == revision['synced_revision'] and revision['settings_key'] == settings_key:
        return
    cards = {}
    entries = conn.execute('''SELECT e.*,d.source_key,d.cards AS derived_cards FROM entries e
        LEFT JOIN review_entry_derivations d ON d.entry_id=e.id
        WHERE e.base_id=? AND e.selected=1 ORDER BY e.id''', (base_id,)).fetchall()
    for entry in entries:
        source_key = digest([base_id, settings_key, entry['pgn'], entry['start_path'], entry['title']])
        if entry['source_key'] == source_key:
            contributions = json.loads(entry['derived_cards'])
        else:
            contributions = derive(entry)
            conn.execute('''INSERT INTO review_entry_derivations(entry_id,source_key,cards) VALUES (?,?,?)
                ON CONFLICT(entry_id) DO UPDATE SET source_key=excluded.source_key,cards=excluded.cards''',
                (entry['id'], source_key, json_text(contributions)))
        for card in contributions:
            if card['id'] in cards:
                cards[card['id']]['answers'] = sorted(set(cards[card['id']]['answers']) | set(card['answers']))
            else:
                cards[card['id']] = card

    previous = {row['id']: row for row in conn.execute('SELECT * FROM review_cards WHERE base_id=?', (base_id,))}
    fields = ('entry_id','type','identity','path','fen','answers','solutions','title','comment')
    for card in cards.values():
        card = {**card, 'answers': json.dumps(card['answers']), 'solutions': json.dumps(card['solutions'])}
        old = previous.get(card['id'])
        if old is not None and old['active'] and all(old[key] == card[key] for key in fields):
            continue
        conn.execute('''INSERT INTO review_cards
            (id,base_id,entry_id,type,identity,path,fen,answers,solutions,title,comment,active,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)
            ON CONFLICT(id) DO UPDATE SET entry_id=excluded.entry_id,path=excluded.path,
              fen=excluded.fen,answers=excluded.answers,solutions=excluded.solutions,
              title=excluded.title,comment=excluded.comment,active=1,updated_at=excluded.updated_at''',
            (card['id'],base_id,*(card[key] for key in fields),timestamp))
    removed = [(row['id'],) for row in previous.values() if row['active'] and row['id'] not in cards]
    if removed:
        conn.executemany('UPDATE review_cards SET active=0 WHERE id=?', removed)
    conn.execute('UPDATE review_generation SET synced_revision=?,settings_key=? WHERE base_id=?',
                 (revision['revision'], settings_key, base_id))

