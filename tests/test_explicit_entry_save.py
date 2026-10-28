"""Old analysis tabs must not persist PGN edits without an explicit save."""
import pytest

import db
from test_variation_editing import owner, make_entry


ROUTES = [
    ('post', '/move', {'path': '0', 'uci': 'e7e6'}),
    ('post', '/line', {'path': '0', 'moves': ['e7e6', 'd2d4']}),
    ('post', '/tree', {'path': '1', 'action': 'main'}),
    ('patch', '/node', {'path': '0', 'comment': 'Edited annotation', 'nags': [1]}),
    ('post', '/undo', {}),
    ('post', '/redo', {}),
    ('patch', '', {'pgn': '1. d4 d5 *', 'title': 'Saved manually'}),
]


def prepared_entry(owner, suffix):
    entry = make_entry(owner)
    response = owner.patch(f"/api/entries/{entry['id']}/node", json={
        'explicit_save': True, 'path': '0', 'comment': 'First saved annotation'})
    assert response.status_code == 200
    if suffix == '/redo':
        response = owner.post(f"/api/entries/{entry['id']}/undo", json={'explicit_save': True})
        assert response.status_code == 200
    return entry['id']


def snapshot(entry_id):
    with db.read_conn() as conn:
        return {
            'entry': dict(conn.execute('SELECT * FROM entries WHERE id=?', (entry_id,)).fetchone()),
            'history': [dict(row) for row in conn.execute(
                'SELECT * FROM entry_history WHERE entry_id=? ORDER BY id', (entry_id,))],
        }


@pytest.mark.parametrize('method,suffix,body', ROUTES)
@pytest.mark.parametrize('marker', ['missing', False, None, 1, 'true'])
def test_legacy_or_non_boolean_intent_never_changes_content_or_history(owner, method, suffix, body, marker):
    entry_id = prepared_entry(owner, suffix)
    before = snapshot(entry_id)
    payload = dict(body)
    if marker != 'missing':
        payload['explicit_save'] = marker
    # Supplying a valid revision does not imply that the user clicked Save.
    payload['expected_revision'] = owner.get(f'/api/entries/{entry_id}').json()['revision']
    response = getattr(owner, method)(f'/api/entries/{entry_id}' + suffix, json=payload)
    assert response.status_code == 409
    assert 'Recharge ChessGym' in response.json()['detail']
    assert snapshot(entry_id) == before


@pytest.mark.parametrize('method,suffix,body', ROUTES)
def test_explicit_save_keeps_supported_editing_routes_working(owner, method, suffix, body):
    entry_id = prepared_entry(owner, suffix)
    before = snapshot(entry_id)
    revision = owner.get(f'/api/entries/{entry_id}').json()['revision']
    response = getattr(owner, method)(f'/api/entries/{entry_id}' + suffix,
        json={**body, 'explicit_save': True, 'expected_revision': revision})
    assert response.status_code == 200, response.text
    assert snapshot(entry_id)['entry']['pgn'] != before['entry']['pgn']


def test_full_save_still_checks_revision_and_is_atomic(owner):
    entry_id = prepared_entry(owner, '')
    before = snapshot(entry_id)
    response = owner.patch(f'/api/entries/{entry_id}', json={
        'explicit_save': True, 'expected_revision': '0' * 64, 'pgn': '1. d4 *'})
    assert response.status_code == 409 and 'autre appareil' in response.json()['detail']
    assert snapshot(entry_id) == before


def test_library_metadata_selection_and_reading_actions_remain_available(owner):
    entry_id = prepared_entry(owner, '')
    before = snapshot(entry_id)
    assert owner.patch(f'/api/entries/{entry_id}', json={'selected': False}).status_code == 200
    assert snapshot(entry_id)['entry']['pgn'] == before['entry']['pgn']
    assert owner.patch(f'/api/entries/{entry_id}', json={'headers': {'Event': 'Tournament'}}).status_code == 200
    entry = owner.get(f'/api/entries/{entry_id}').json()
    assert entry['headers']['Event'] == 'Tournament'
    assert owner.post(f'/api/entries/{entry_id}/seen', json={}).status_code == 200
    assert owner.patch(f"/api/bases/{entry['base_id']}", json={'settings': {'reading_enabled': True}}).status_code == 200
    saved = snapshot(entry_id)
    assert owner.post(f'/api/entries/{entry_id}/reading', json={'path': '0'}).status_code == 200
    assert snapshot(entry_id) == saved
