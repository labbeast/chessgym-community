"""Preview and atomically apply only initial review defaults to selected bases."""
import hashlib
import hmac
import json
import re
from fastapi import HTTPException
import db
import review_preferences
from library_service import DEFAULT_SETTINGS


def apply(payload):
    if not isinstance(payload,dict) or set(payload)-{'base_ids','preview','expected_revision'}:
        raise HTTPException(400,'Options de copie des réglages invalides.')
    ids=payload.get('base_ids');preview=payload.get('preview',True)
    if type(preview) is not bool or not isinstance(ids,list) or not 1<=len(ids)<=500 or any(type(i) is not int or i<1 for i in ids) or len(set(ids))!=len(ids):
        raise HTTPException(400,'Sélectionne entre 1 et 500 bases distinctes.')
    ids=sorted(ids)
    with db.get_conn() as conn:
        conn.execute('BEGIN' if preview else 'BEGIN IMMEDIATE')
        rows=[dict(row) for row in conn.execute('SELECT b.id,b.name,b.settings,r.base_id AS reference_id FROM bases b LEFT JOIN reference_bases r ON r.base_id=b.id WHERE b.id IN ('+','.join('?' for _ in ids)+') ORDER BY b.id',ids)]
        if len(rows)!=len(ids) or any(row['reference_id'] is not None for row in rows):
            raise HTTPException(409,'La sélection a changé ou contient une grande base de référence.')
        defaults={key:value for key,value in review_preferences.read(conn)['review_defaults'].items() if key!='new_limit'}
        canonical=json.dumps({'defaults':defaults,'bases':rows},ensure_ascii=False,sort_keys=True,separators=(',',':'))
        revision=hashlib.sha256(canonical.encode()).hexdigest()
        if not preview:
            expected=payload.get('expected_revision')
            if not isinstance(expected,str) or not re.fullmatch('[a-f0-9]{64}',expected):raise HTTPException(400,'Prévisualise les changements avant de les appliquer.')
            if not hmac.compare_digest(expected,revision):raise HTTPException(409,'Les bases ou les réglages globaux ont changé. Actualise l’aperçu.')
        bases=[]
        for row in rows:
            saved=json.loads(row['settings']);current={**DEFAULT_SETTINGS,**saved}
            changes={key:{'before':current.get(key),'after':value} for key,value in defaults.items() if current.get(key)!=value}
            bases.append({'id':row['id'],'name':row['name'],'changes':changes})
            if not preview and changes:
                conn.execute('UPDATE bases SET settings=? WHERE id=?',(json.dumps({**saved,**defaults}),row['id']))
        return {'bases':bases,'revision':revision,'applied':not preview,'defaults':defaults}
