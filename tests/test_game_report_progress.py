"""Per-moment account progress, receipts, conflicts and portable backup coverage."""
import io
import json
import sqlite3
import zipfile

import pytest

import db
import game_analysis
import game_report_progress as progress
from test_library import client, owner

PGN = '1. e4 e5 2. Nf3 *'


@pytest.fixture
def entry(owner):
    base = owner.post('/api/bases', json={'name': 'Mes parties'}).json()['id']
    owner.post(f'/api/bases/{base}/import', json={'pgn': PGN})
    entry_id = owner.get(f'/api/bases/{base}/entries').json()['entries'][0]['id']
    fingerprint = game_analysis.game_snapshot(PGN)[2]
    return entry_id, fingerprint


def payload(entry, **changes):
    return {'fingerprint': entry[1], 'ply': 1, 'expected_revision': 0, 'mutation_id': 'report-test-mutation', 'state': {'outcome': 'reviewed', 'hint': True, 'revealed': False, 'attempts': 2}, **changes}


def endpoint(entry):
    return f'/api/game-analysis/{entry[0]}/progress'


def test_progress_is_private(client):
    fingerprint = game_analysis.game_snapshot(PGN)[2]
    assert client.get('/api/game-analysis/1/progress', params={'fingerprint': fingerprint}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.put('/api/game-analysis/1/progress', json=payload((1, fingerprint)), headers={'Host': 'remote.invalid'}).status_code == 403


def test_save_reload_reset_and_source_pgn_unchanged(owner, entry):
    before = owner.get(f'/api/entries/{entry[0]}').json()
    saved = owner.put(endpoint(entry), json=payload(entry))
    assert saved.status_code == 200, saved.text
    assert saved.json()['item']['revision'] == 1
    loaded = owner.get(endpoint(entry), params={'fingerprint': entry[1]}).json()
    assert loaded['items'] == [saved.json()['item']]
    reset = owner.put(endpoint(entry), json=payload(entry, expected_revision=1, mutation_id='explicit-reset-request', state={'outcome': None, 'hint': False, 'revealed': False, 'attempts': 0}))
    assert reset.status_code == 200 and reset.json()['item']['revision'] == 2
    assert reset.json()['item']['state']['outcome'] is None
    after = owner.get(f'/api/entries/{entry[0]}').json()
    assert (before['pgn'], before['revision']) == (after['pgn'], after['revision'])


def test_receipts_precede_revision_validation_and_reject_payload_reuse(owner, entry):
    body = payload(entry)
    first = owner.put(endpoint(entry), json=body)
    repeated = owner.put(endpoint(entry), json=body)
    assert repeated.status_code == 200 and repeated.json() == first.json()
    assert owner.put(endpoint(entry), json={**body, 'state': {'outcome': 'solved'}}).status_code == 409
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM game_report_moment_progress').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM game_report_progress_receipts').fetchone()[0] == 1


def test_concurrent_same_moment_conflicts_but_other_moments_merge(owner, entry):
    first = owner.put(endpoint(entry), json=payload(entry)).json()
    stale = owner.put(endpoint(entry), json=payload(entry, mutation_id='second-device-same-ply'))
    assert stale.status_code == 409 and stale.headers['X-ChessGym-Reason'] == 'report-progress-conflict'
    other = owner.put(endpoint(entry), json=payload(entry, ply=2, mutation_id='second-device-other-ply', state={'outcome': 'missed', 'attempts': 3}))
    assert other.status_code == 200 and other.json()['item']['revision'] == 1
    explicit = owner.put(endpoint(entry), json=payload(entry, expected_revision=first['item']['revision'], mutation_id='explicit-conflict-choice', state={'outcome': 'solved'}))
    assert explicit.status_code == 200 and explicit.json()['item']['state']['revealed'] is True
    assert len(owner.get(endpoint(entry), params={'fingerprint': entry[1]}).json()['items']) == 2


def test_changed_mainline_rejects_old_progress_but_annotation_change_retains_it(owner, entry):
    saved = owner.put(endpoint(entry), json=payload(entry)).json()
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. e4 {Une note} e5 2. Nf3 *', entry[0]))
    assert owner.get(endpoint(entry), params={'fingerprint': entry[1]}).status_code == 200
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. d4 d5 *', entry[0]))
    assert owner.get(endpoint(entry), params={'fingerprint': entry[1]}).status_code == 409
    rejected = owner.put(endpoint(entry), json=payload(entry, expected_revision=1, mutation_id='stale-mainline-write'))
    assert rejected.status_code == 409 and rejected.headers['X-ChessGym-Reason'] == 'report-source-changed'
    # The first accepted action remains acknowledgeable after a lost response.
    assert owner.put(endpoint(entry), json=payload(entry)).json() == saved


@pytest.mark.parametrize('patch', [{'ply':0}, {'ply':1001}, {'ply':4}, {'expected_revision':-1}, {'expected_revision':True}, {'fingerprint':'wrong'}, {'mutation_id':'short'}, {'state':{'hint':'yes'}}, {'state':{'outcome':'invented'}}, {'state':{'attempts':-1}}, {'state':{'unknown':1}}, {'unexpected':True}])
def test_invalid_progress_is_atomic(owner, entry, patch):
    response = owner.put(endpoint(entry), json=payload(entry, **patch))
    assert response.status_code == 422, response.text
    assert owner.get(endpoint(entry), params={'fingerprint': entry[1]}).json()['items'] == []


def test_progress_is_in_personal_backup_and_schema_init_is_idempotent(owner, entry, tmp_path):
    owner.put(endpoint(entry), json=payload(entry))
    with db.get_conn() as conn:
        progress.init_schema(conn)
        progress.init_schema(conn)
    archive = owner.get('/api/backup?mode=personal')
    assert archive.status_code == 200
    with zipfile.ZipFile(io.BytesIO(archive.content)) as zipped:
        name = next(name for name in zipped.namelist() if name.endswith('chessgym.sqlite3'))
        target = tmp_path / 'restored-progress.sqlite3'
        target.write_bytes(zipped.read(name))
    with sqlite3.connect(target) as conn:
        state = json.loads(conn.execute('SELECT state FROM game_report_moment_progress').fetchone()[0])
        assert state['outcome'] == 'reviewed' and state['hint']
        assert conn.execute('SELECT count(*) FROM game_report_progress_receipts').fetchone()[0] == 1


def test_read_does_not_write_and_filters_account(owner, entry):
    owner.put(endpoint(entry), json=payload(entry))
    with db.get_conn() as conn:
        before = conn.execute('SELECT * FROM game_report_moment_progress').fetchall()
    assert progress.read_progress(entry[0], entry[1], user={'id': 2})['items'] == []
    owner.get(endpoint(entry), params={'fingerprint': entry[1]})
    with db.get_conn() as conn:
        assert [tuple(r) for r in conn.execute('SELECT * FROM game_report_moment_progress')] == [tuple(r) for r in before]
