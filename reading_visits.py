"""Journal new reading visits; historical cumulative progress is not backfilled."""
import re
from fastapi import HTTPException

def init_schema(conn):
    conn.execute("""CREATE TABLE IF NOT EXISTS reading_visits (
      id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
      base_id INTEGER REFERENCES bases(id) ON DELETE SET NULL,
      title TEXT NOT NULL,base_name TEXT NOT NULL,
      started_at TEXT NOT NULL,updated_at TEXT NOT NULL,finished_at TEXT,
      active_seconds REAL NOT NULL DEFAULT 0,first_path TEXT NOT NULL,last_path TEXT NOT NULL,
      read_moves INTEGER NOT NULL,total_moves INTEGER NOT NULL,last_sequence INTEGER NOT NULL DEFAULT 0
    )""")
    conn.execute('CREATE INDEX IF NOT EXISTS reading_visits_user_date ON reading_visits(user_id,started_at DESC)')

def checked(payload):
    identity=payload.get('visit_id')
    if identity is None:return None
    if not isinstance(identity,str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,100}',identity):
        raise HTTPException(400,'Identifiant de visite de lecture invalide.')
    viewed=payload.get('visit_path')
    if 'visit_path' in payload and (not isinstance(viewed,str) or not re.fullmatch(r'(?:0(?:\.0)*)?',viewed)):
        raise HTTPException(400,'La position de lecture doit appartenir à la ligne principale.')
    sequence=payload.get('visit_sequence',0);ended=payload.get('visit_end',False)
    if type(sequence) is not int or not 0<=sequence<=10_000_000 or type(ended) is not bool or not payload.get('request_id'):
        raise HTTPException(400,'Suivi de visite de lecture invalide.')
    return identity,sequence,ended

def record(conn,entry,payload,state,*,user_id,timestamp):
    visit=checked(payload)
    if visit is None or payload.get('mode','visit')!='visit':return
    identity,sequence,ended=visit
    prior=conn.execute('SELECT * FROM reading_visits WHERE id=?',(identity,)).fetchone()
    if prior is not None and (prior['user_id']!=user_id or prior['entry_id']!=entry['id']):
        raise HTTPException(409,'Cette visite de lecture appartient à une autre partie.')
    base=conn.execute('SELECT name FROM bases WHERE id=?',(entry['base_id'],)).fetchone()
    path=payload.get('visit_path',payload.get('path',''));seconds=payload.get('active_seconds',0)
    if prior is None:
        conn.execute('INSERT INTO reading_visits VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            (identity,user_id,entry['id'],entry['base_id'],entry['title'],base['name'] if base else '',
             timestamp,timestamp,timestamp if ended else None,seconds,path,path,state['read_moves'],state['total_moves'],sequence))
    else:
        # Old retried heartbeats still add their unique measured time, but must
        # not move the last viewed position backwards after a later receipt.
        newer=sequence>=prior['last_sequence']
        conn.execute("""UPDATE reading_visits SET active_seconds=active_seconds+?,
          updated_at=CASE WHEN ? THEN ? ELSE updated_at END,
          finished_at=CASE WHEN ? AND finished_at IS NULL THEN ? ELSE finished_at END,
          last_path=CASE WHEN ? THEN ? ELSE last_path END,
          read_moves=CASE WHEN ? THEN ? ELSE read_moves END,
          total_moves=CASE WHEN ? THEN ? ELSE total_moves END,last_sequence=MAX(last_sequence,?) WHERE id=?""",
          (seconds,newer,timestamp,ended,timestamp,newer,path,newer,state['read_moves'],newer,state['total_moves'],sequence,identity))
