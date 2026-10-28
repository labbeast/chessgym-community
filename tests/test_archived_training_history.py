"""Read-only compatibility for saved results from the archived Mix experiment."""
import json

import pytest
from fastapi import HTTPException

import db
import guess_move
import training_native
import training
from test_training_history import client, seed_guess, STAMP


def session(outcome='win', status='completed'):
    return {
        'id': 'mix-integration', 'user_id': 1, 'base_id': 1,
        'status': status, 'side': 'black', 'position_count': 6,
        'threshold_cp': 100, 'cumulative_cp': 120, 'outcome': outcome,
        'completion_reason': 'positions' if status == 'completed' else None,
        'total_elapsed_ms': 8100, 'total_historical_ms': 8000,
        'total_observation_ms': 12000,
        'minimum_time_seconds': 15, 'total_topup_ms': 2000,
        'attempts': [{'index': 0, 'uci': 'e7e5', 'elapsed_ms': 8100,
                      'exact': False, 'delta_cp': 120,
                      'result': {'proposal_san': 'e5', 'original_san': 'c5'}}],
    }


def save(value):
    with db.get_conn() as conn:
        conn.execute('CREATE TABLE IF NOT EXISTS guess_mix_sessions (id TEXT PRIMARY KEY,user_id INTEGER,data TEXT,created_at TEXT,updated_at TEXT)')
        conn.execute('INSERT INTO guess_mix_sessions(id,user_id,data,created_at,updated_at) VALUES(?,?,?,?,?)',
                     (value['id'], value['user_id'], json.dumps(value), STAMP, STAMP))


@pytest.mark.parametrize('outcome,expected', [('win', 'success'), ('loss', 'failure'), ('draw', 'draw')])
def test_mix_history_is_scoped_and_uses_comparative_result(client, outcome, expected):
    value = session(outcome)
    save(value)
    response = client.get('/api/training/history?tool=guess')
    assert response.status_code == 200, response.text
    item = response.json()['items'][0]
    assert item['id'] == value['id'] and item['outcome'] == expected
    assert item['metrics']['mode'] == 'mix'
    assert item['open_available'] is False
    assert item['detail_available'] is True
    assert item['metrics']['minimum_time_seconds'] == 15
    assert item['metrics']['total_topup_ms'] == 2000
    assert item['duration_ms'] == 20100
    assert item['score'] is None and item['maximum'] is None
    detail = client.get('/api/training/history/guess/' + value['id'])
    assert detail.status_code == 200, detail.text
    event = detail.json()['events'][0]
    assert event['action'] == 'e5'
    assert event['details']['expected'] == 'c5'
    assert event['details']['delta_cp'] == 120
    other = {**value, 'id': 'mix-other', 'user_id': 2}
    save(other)
    assert client.get('/api/training/history?tool=guess').json()['total'] == 1
    assert client.get('/api/training/history/guess/mix-other').status_code == 404


def test_mix_delta_does_not_change_classic_accuracy(client):
    save(session())
    with db.get_conn() as conn:
        seed_guess(conn)
    response = client.get('/api/training/history/statistics?tool=guess')
    assert response.status_code == 200, response.text
    statistics = response.json()
    assert statistics['counts']['completed'] == 2
    assert statistics['metrics']['score'] == 15
    assert statistics['metrics']['maximum'] == 20
    assert statistics['metrics']['accuracy'] == 75


def test_active_mix_has_no_winner_and_does_not_leak_source(client):
    value = session(status='playing')
    value['source_pgn'] = 'hidden source'
    value['positions'] = [{'original_uci': 'a7a5'}]
    save(value)
    response = client.get('/api/training/history?tool=guess')
    assert response.json()['items'][0]['outcome'] == 'unknown'
    assert 'hidden source' not in response.text and 'a7a5' not in response.text


def test_history_preserves_legacy_sessions_without_a_minimum(client):
    value = session()
    del value['minimum_time_seconds']
    del value['total_topup_ms']
    save(value)
    item = client.get('/api/training/history?tool=guess').json()['items'][0]
    assert item['metrics']['minimum_time_seconds'] == 0
    assert item['metrics']['total_topup_ms'] == 0
    assert item['duration_ms'] == 20100
    with db.get_conn() as conn:
        stored = json.loads(conn.execute('SELECT data FROM guess_mix_sessions WHERE id=?', (value['id'],)).fetchone()[0])
    assert stored == value


def test_a_programme_cannot_resume_an_archived_mix_through_the_classic_endpoint(client, monkeypatch):
    monkeypatch.setattr(training_native, 'creation', lambda *args, **kwargs: 'mix-existing')
    with pytest.raises(HTTPException) as error:
        guess_move.start_session(guess_move.StartRequest(pgn='1. e4 e5 *'), user={'id': 1})
    assert error.value.status_code == 409


def test_archived_mix_is_not_advertised_as_resumable(client):
    save(session(status="playing"))
    assert "guess" not in training.unfinished_training(user={"id": 1})["activities"]


def test_fresh_install_has_no_mix_table(client):
    with db.get_conn() as conn:
        assert conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='guess_mix_sessions'").fetchone() is None
