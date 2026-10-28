"""Only empty organizational folders can be removed; chess data remains intact."""
import pytest

import db
from test_library_organization import client, owner, base, folder, ok, db_snapshot


def folder_rows():
    with db.read_conn() as conn:
        return [tuple(row) for row in conn.execute('SELECT * FROM folders ORDER BY id')]


def test_delete_empty_leaf_preserves_parent_pgn_reviews_and_other_bases(owner):
    parent = folder(owner, 'Cours')
    leaf = folder(owner, 'Dossier vide', parent)
    other = base(owner, 'Parties', folder_id=parent, settings={'review_enabled': True})
    ok(owner.post('/api/entries', json={'base_id': other['id'], 'pgn': '1. e4 {Plan} e5 2. Nf3 *'}))
    card = ok(owner.get(f"/api/bases/{other['id']}/queue?all=true"))['cards'][0]
    ok(owner.post(f"/api/reviews/{card['id']}/grade", json={'grade': 2, 'elapsed_ms': 12000}))
    before = db_snapshot()
    assert ok(owner.delete(f'/api/folders/{leaf}')) == {'ok': True}
    assert db_snapshot() == before
    assert [row[0] for row in folder_rows()] == [parent]


def test_delete_empty_folder_before_any_base_exists(owner):
    empty = folder(owner, 'Premier dossier')
    assert ok(owner.get('/api/library'))['bases'] == []
    ok(owner.delete(f'/api/folders/{empty}'))
    assert ok(owner.get('/api/library')) == {'folders': [], 'bases': []}


@pytest.mark.parametrize('content', ['empty_base', 'child_folder', 'nested_base'])
def test_nonempty_folder_cannot_delete_or_detach_contents(owner, content):
    parent = folder(owner, 'Protégé')
    if content == 'empty_base':
        base(owner, 'Même sans parties', folder_id=parent)
    else:
        child = folder(owner, 'Sous-dossier', parent)
        if content == 'nested_base':
            base(owner, 'Dans le sous-dossier', folder_id=child)
    before, folders = db_snapshot(), folder_rows()
    response = owner.delete(f'/api/folders/{parent}')
    assert response.status_code == 409, response.text
    assert db_snapshot() == before
    assert folder_rows() == folders


def test_stale_empty_library_snapshot_does_not_authorize_deletion(owner):
    empty = folder(owner, 'Vide au dernier affichage')
    assert not ok(owner.get('/api/library'))['bases']
    moved = base(owner, 'Ajout concurrent', folder_id=empty)
    before = db_snapshot()
    assert owner.delete(f'/api/folders/{empty}').status_code == 409
    assert db_snapshot() == before
    assert ok(owner.get('/api/library'))['bases'][0]['id'] == moved['id']


@pytest.mark.parametrize('identity', [0, -1, 999999])
def test_missing_or_synthetic_folders_cannot_be_deleted(owner, identity):
    keep = folder(owner, 'Conserver')
    assert owner.delete(f'/api/folders/{identity}').status_code == 404
    assert [row[0] for row in folder_rows()] == [keep]


def test_folder_deletion_rejects_remote_host(owner):
    keep = folder(owner, 'Conserver')
    owner.cookies.clear()
    assert owner.delete(f'/api/folders/{keep}', headers={'Host': 'remote.invalid'}).status_code == 403
    assert [row[0] for row in folder_rows()] == [keep]
