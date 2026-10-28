"""Transpositions preserve exact tree identity and never change repertoire PGNs."""
import json

import pytest
from fastapi import HTTPException

import db
import pgnlib
import repertoire_transpositions as subject
from entry_content import entry_revision
from test_library import client, owner

SOURCE = '1. Nf3 d5 2. d4 Nf6 *'
TARGET = '1. d4 d5 2. Nf3 Nf6 {Conserver cette note} 3. c4 e6 *'
PATH = '0.0.0.0'


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'transpositions.sqlite3')
    db.init_db()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(1,'Répertoire blanc',?, 'now')", (json.dumps({'is_repertoire': True, 'color': 'white'}),))
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(2,'Notes', '{}','now')")


def add(pgn, base=1, title='Une ligne'):
    with db.get_conn() as conn:
        return conn.execute("INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,'now','now')", (base, title, pgn)).lastrowid


def search(pgn=SOURCE, path=PATH, **kwargs):
    return subject.transpositions(subject.TranspositionRequest(pgn=pgn, path=path, **kwargs))


def fen_pgn(fen):
    return '[SetUp "1"]\n[FEN "' + fen + '"]\n\n*'


def test_matching_move_order_contains_exact_source_and_continuations_without_writes(store):
    entry = add(TARGET)
    add(TARGET, base=2)
    with db.get_conn() as conn:
        before = list(map(tuple, conn.execute('SELECT * FROM entries ORDER BY id')))
        revision = entry_revision(conn.execute('SELECT * FROM entries WHERE id=?', (entry,)).fetchone())
    result = search()
    assert result['total'] == 1 and not result['partial']
    match = result['matches'][0]
    assert (match['entry_id'], match['path'], match['revision']) == (entry, PATH, revision)
    assert match['same_move_order'] is False
    assert match['move_order'] == '1. d4 1… d5 2. Nf3 2… Nf6'
    assert match['comment'] == 'Conserver cette note'
    assert match['continuations'] == [{'uci': 'c2c4', 'san': 'c4', 'path': PATH + '.0'}]
    assert subject.position_key(pgnlib.node_at(pgnlib.load_game(TARGET), PATH).board()) == result['position_key']
    with db.get_conn() as conn:
        assert list(map(tuple, conn.execute('SELECT * FROM entries ORDER BY id'))) == before


def test_same_entry_other_branch_and_saved_draft_input_are_supported(store):
    pgn = '1. d4 d5 (1... Nf6 2. Nf3 d5 {Autre chemin}) 2. Nf3 Nf6 *'
    entry = add(pgn)
    result = search(pgn=pgn.replace('Autre chemin', 'Note locale non enregistrée'), entry_id=entry)
    assert [m['path'] for m in result['matches']] == ['0.1.0.0']
    assert result['matches'][0]['comment'] == 'Autre chemin'


def test_same_order_is_opt_in_and_current_occurrence_is_excluded(store):
    entry = add(SOURCE)
    assert search()['total'] == 0
    assert search(different_only=False)['matches'][0]['same_move_order'] is True
    assert search(different_only=False, entry_id=entry)['total'] == 0


def test_position_identity_ignores_move_counters_but_keeps_castling_and_turn(store):
    root = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq -'
    add(fen_pgn(root + ' 15 25'))
    assert search(fen_pgn(root + ' 0 1'), '', different_only=False)['total'] == 1
    assert search(fen_pgn(root.replace('KQkq', '-') + ' 0 1'), '', different_only=False)['total'] == 0
    assert search(fen_pgn(root.replace(' w ', ' b ') + ' 0 1'), '', different_only=False)['total'] == 0


def test_position_identity_keeps_only_legal_en_passant_rights(store):
    position = '8/8/8/3pP3/8/8/4K3/7k w - '
    add(fen_pgn(position + 'd6 0 1'))
    assert search(fen_pgn(position + '- 0 1'), '', different_only=False)['total'] == 0
    assert search(fen_pgn(position + 'd6 2 7'), '', different_only=False)['total'] == 1
    no_capture = '8/8/8/3p4/8/8/4K3/7k w - '
    add(fen_pgn(no_capture + 'd6 0 1'))
    assert search(fen_pgn(no_capture + '- 0 1'), '', different_only=False)['total'] == 1


def test_null_move_paths_are_never_transpositions(store):
    pgn = '1. e4 e5 (1... -- 2. d4) *'
    add(pgn)
    with pytest.raises(HTTPException) as error:
        search(pgn, '0.1.0')
    assert error.value.status_code == 422
    result = search(fen_pgn(pgnlib.node_at(pgnlib.load_game(pgn), '0.1.0').board().fen()), '', different_only=False)
    assert result['total'] == 0


def test_pagination_keeps_source_order_and_is_bounded(store):
    ids = [add(TARGET, title=str(n)) for n in range(7)]
    pages = [search(offset=offset, limit=3) for offset in (0, 3, 6)]
    assert [match['entry_id'] for page in pages for match in page['matches']] == ids
    assert [page['next_offset'] for page in pages] == [3, 6, None]
    assert all(page['total'] == 7 for page in pages)


@pytest.mark.parametrize('limit,value,reason', [('MAX_ENTRIES', 1, 'entries'), ('MAX_NODES', 3, 'nodes'), ('MAX_MATCHES', 1, 'matches'), ('MAX_TOTAL_BYTES', 2, 'bytes'), ('MAX_ENTRY_BYTES', 2, 'large_entry')])
def test_partial_limits_are_reported_never_as_complete_absence(store, monkeypatch, limit, value, reason):
    add(TARGET)
    add(TARGET)
    monkeypatch.setattr(subject, limit, value)
    result = search()
    assert result['partial'] is True
    assert reason in result['limit_reasons']


def test_invalid_record_is_reported_and_following_games_still_searchable(store):
    add('not a valid PGN')
    target = add(TARGET)
    result = search()
    assert result['partial'] and result['invalid_entries'] == 1
    assert result['matches'][0]['entry_id'] == target


def test_explicit_scope_requires_repertoire(store):
    with pytest.raises(HTTPException) as error:
        search(base_id=2)
    assert error.value.status_code == 404


def test_api_is_private(client):
    assert client.post('/api/repertoires/transpositions', json={'pgn': SOURCE, 'path': PATH}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_api_accepts_draft_and_rejects_invalid_paths_and_fields(owner):
    base = owner.post('/api/bases', json={'name': 'Ordres de coups', 'settings': {'is_repertoire': True}}).json()['id']
    assert owner.post(f'/api/bases/{base}/import', json={'pgn': TARGET}).status_code == 200
    response = owner.post('/api/repertoires/transpositions', json={'pgn': SOURCE, 'path': PATH, 'base_id': base})
    assert response.status_code == 200 and response.json()['total'] == 1
    for extra in ({'path':'0.99'}, {'path':'../x'}, {'offset':-1}, {'limit':51}, {'base_id':True}, {'different_only':'yes'}, {'unknown':1}):
        assert owner.post('/api/repertoires/transpositions', json={'pgn': SOURCE, 'path': PATH, **extra}).status_code == 422
