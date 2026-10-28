"""Paginated metadata and explicit defaults copying use isolated personal stores."""
import json
import sqlite3
import pytest
import db
import entry_catalog
import pgnlib
from test_library import owner, client, make_base, import_entry, PGN


def seed(owner, base, number=7):
    ids=[]
    for i in range(number):
        text=PGN.replace('[White "Blanc"]',f'[White "Joueur {i}"]').replace('[Black "Noir"]',f'[Black "Émile nom{number-i}"]').replace('[Date "2026.10.19"]',f'[Date "2026.10.{i+1:02d}"]')
        response=owner.post(f'/api/bases/{base}/import',json={'pgn':text})
        assert response.status_code==200,response.text
    return [e['id'] for e in owner.get(f'/api/bases/{base}/entries').json()['entries']]


def test_pagination_search_inclusion_and_around_share_one_order(owner):
    base=make_base(owner);ids=seed(owner,base)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET selected=0 WHERE id=?',(ids[3],))
    data=owner.get(f'/api/bases/{base}/entries?limit=2&offset=2').json()
    assert [e['id'] for e in data['entries']]==ids[2:4]
    assert (data['total'],data['total_all'],data['selected_total'],data['has_more'])==(7,7,6,True)
    around=owner.get(f'/api/bases/{base}/entries?limit=2&around_id={ids[4]}&sort=date&descending=true').json()
    assert around['index']==2 and around['offset']==2 and around['previous_id']==ids[5] and around['next_id']==ids[3]
    assert around['entries'][0]['id']==ids[4]
    missing=owner.get(f'/api/bases/{base}/entries?limit=2&around_id={ids[3]}&inclusion=included').json()
    assert missing['total']==6 and missing['around_found'] is False and missing['index'] is None
    found=owner.get(f'/api/bases/{base}/entries?limit=2&search=emile%20nom5').json()
    assert [e['id'] for e in found['entries']]==[ids[2]]
    assert found['total']==1 and found['total_all']==7
    for query in ('limit=0','limit=201','offset=-1','sort=sql','inclusion=invalid'):
        assert owner.get(f'/api/bases/{base}/entries?{query}').status_code in (400,422)


def test_warm_summary_reads_neither_pgn_nor_writes_bookmarks(owner,monkeypatch):
    base=make_base(owner,reading_enabled=True);ids=seed(owner,base,3)
    traces=[];real=db.get_conn
    def traced():
        conn=real();conn.set_trace_callback(traces.append);return conn
    monkeypatch.setattr(db,'get_conn',traced)
    monkeypatch.setattr(pgnlib,'load_game',lambda *_: (_ for _ in ()).throw(AssertionError('warm summary reparsed PGN')))
    result=owner.get(f'/api/bases/{base}/entries?limit=2')
    assert result.status_code==200,result.text
    assert result.json()['entries'][0]['id']==ids[0]
    assert not any(s.lstrip().upper().startswith(('INSERT','UPDATE','DELETE','BEGIN IMMEDIATE')) for s in traces)
    assert not any('SELECT pgn' in s or 'SELECT e.*' in s and 'c.entry_id IS NULL' not in s for s in traces)


def test_external_same_timestamp_edits_invalidate_summary_and_revision(owner):
    base=make_base(owner);entry=import_entry(owner,base)
    before=owner.get(f'/api/bases/{base}/entries?limit=2').json()['entries'][0]
    with db.get_conn() as conn:
        original=conn.execute('SELECT pgn,updated_at FROM entries WHERE id=?',(entry,)).fetchone()
        conn.execute('UPDATE entries SET pgn=?,title=? WHERE id=?',(original['pgn'].replace('[White "Blanc"]','[White "Nouveau"]'),'Autre',entry))
        assert conn.execute('SELECT 1 FROM entry_catalog WHERE entry_id=?',(entry,)).fetchone() is None
    after=owner.get(f'/api/bases/{base}/entries?limit=2').json()['entries'][0]
    assert after['headers']['White']=='Nouveau' and after['title']=='Autre'
    assert after['revision']!=before['revision'] and after['updated_at']==before['updated_at']
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?',(entry,))
        assert conn.execute('SELECT count(*) FROM entry_catalog').fetchone()[0]==0


def test_change_between_preparation_and_snapshot_is_explicit_not_missing_row(owner,monkeypatch):
    base=make_base(owner);entry=import_entry(owner,base);real=entry_catalog.prepare
    def changing(**kwargs):
        real(**kwargs)
        with db.get_conn() as conn:conn.execute("UPDATE entries SET title=title||'!' WHERE id=?",(entry,))
    monkeypatch.setattr(entry_catalog,'prepare',changing)
    response=owner.get(f'/api/bases/{base}/entries?limit=2')
    assert response.status_code==503 and response.headers['retry-after']=='1'


def test_preview_then_atomic_apply_preserves_cards_history_and_other_settings(owner):
    first=make_base(owner,review_enabled=True,hard=3,skill=4,new_limit=5);second=make_base(owner,medium=8)
    import_entry(owner,first)
    owner.patch('/api/preferences',json={'review_defaults':{'hard':7,'medium':9,'new_limit':12}})
    with db.get_conn() as conn:
        before=[tuple(r) for r in conn.execute('SELECT * FROM review_cards')]
        history=[tuple(r) for r in conn.execute('SELECT * FROM review_history')]
    endpoint='/api/preferences/review-defaults/apply';request={'base_ids':[first,second],'preview':True}
    preview=owner.post(endpoint,json=request);assert preview.status_code==200,preview.text
    value=preview.json();assert value['bases'][0]['changes']['hard']=={'before':3,'after':7}
    # Retired quotas are neither advertised nor copied over old stored values.
    assert 'new_limit' not in value['defaults']
    assert all('new_limit' not in base['changes'] for base in value['bases'])
    applied=owner.post(endpoint,json={**request,'preview':False,'expected_revision':value['revision']})
    assert applied.status_code==200,applied.text
    with db.get_conn() as conn:
        settings=json.loads(conn.execute('SELECT settings FROM bases WHERE id=?',(first,)).fetchone()[0])
        assert settings['hard']==7 and settings['new_limit']==5 and settings['skill']==4
        assert before==[tuple(r) for r in conn.execute('SELECT * FROM review_cards')]
        assert history==[tuple(r) for r in conn.execute('SELECT * FROM review_history')]
    assert owner.post(endpoint,json={**request,'preview':False,'expected_revision':value['revision']}).status_code==409


def test_defaults_changed_after_preview_do_not_partially_modify_bases(owner):
    bases=[make_base(owner,hard=3),make_base(owner,hard=4)]
    endpoint='/api/preferences/review-defaults/apply';preview=owner.post(endpoint,json={'base_ids':bases}).json()
    owner.patch('/api/preferences',json={'review_defaults':{'hard':8}})
    response=owner.post(endpoint,json={'base_ids':bases,'preview':False,'expected_revision':preview['revision']})
    assert response.status_code==409
    with db.get_conn() as conn:assert [json.loads(r[0])['hard'] for r in conn.execute('SELECT settings FROM bases ORDER BY id')]==[3,4]
    assert owner.post(endpoint,json={'base_ids':bases,'preview':False}).status_code==400

def test_cold_preparation_is_bounded_resumable_and_has_stable_reason(owner,monkeypatch):
    base=make_base(owner)
    with db.get_conn() as conn:
        conn.executemany('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',[(base,str(i),PGN,'now','now') for i in range(5)])
    monkeypatch.setattr(entry_catalog,'MAX_PREPARE',2);monkeypatch.setattr(entry_catalog,'BATCH_SIZE',2)
    first=owner.get(f'/api/bases/{base}/entries?limit=2')
    assert first.status_code==503 and first.headers['x-chessgym-reason']=='catalog-preparing'
    with db.get_conn() as conn:assert conn.execute('SELECT count(*) FROM entry_catalog').fetchone()[0]==2
    assert owner.get(f'/api/bases/{base}/entries?limit=2').status_code==503
    final=owner.get(f'/api/bases/{base}/entries?limit=2')
    assert final.status_code==200 and final.json()['total']==5


def test_preparation_does_not_install_stale_parse_after_source_write(owner,monkeypatch):
    base=make_base(owner);entry=import_entry(owner,base)
    with db.get_conn() as conn:conn.execute('DELETE FROM entry_catalog')
    real=entry_catalog.derived;once=[]
    def racing(row,game=None):
        value=real(row,game)
        if not once:
            once.append(1)
            with db.get_conn() as conn:conn.execute("UPDATE entries SET title='Nouvelle version' WHERE id=?",(entry,))
        return value
    monkeypatch.setattr(entry_catalog,'derived',racing)
    actual=owner.get(f'/api/bases/{base}/entries?limit=2').json()['entries'][0]
    assert actual['title']=='Nouvelle version'
    with db.get_conn() as conn:
        row=conn.execute('SELECT * FROM entries WHERE id=?',(entry,)).fetchone()
        assert actual['revision']==entry_catalog.revision(row)
