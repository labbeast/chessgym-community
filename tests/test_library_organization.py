"""Library ordering and logos stay portable and preserve chess/review documents."""
import base64
import io
import sqlite3

import pytest
from local_test_client import TestClient
from PIL import Image
from PIL.PngImagePlugin import PngInfo

import app
import db
import jobs
import library_organization as organization


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'library.sqlite3')
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as browser:
        yield browser


@pytest.fixture
def owner(client):
    ok(client.get('/api/status'))
    return client


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def base(owner, name, **fields):
    return ok(owner.post('/api/bases', json={'name': name, **fields}))


def folder(owner, name='Dossier', parent_id=None):
    return ok(owner.post('/api/folders', json={'name': name, 'parent_id': parent_id}))['id']


def library(owner):
    return ok(owner.get('/api/library'))['bases']


def order(owner):
    return [item['id'] for item in library(owner)]


def move(owner, base_id, **fields):
    return owner.post('/api/library/bases/move', json={'base_id': base_id, **fields})


def picture(fmt='PNG', size=(48, 32), color=(140, 90, 50), **options):
    image = Image.new('RGB', size, color)
    output = io.BytesIO()
    image.save(output, format=fmt, **options)
    mime = {'PNG': 'png', 'JPEG': 'jpeg', 'WEBP': 'webp'}[fmt]
    return 'data:image/' + mime + ';base64,' + base64.b64encode(output.getvalue()).decode()


def db_snapshot():
    with db.get_conn() as conn:
        return {name: [tuple(row) for row in conn.execute('SELECT * FROM ' + name)]
                for name in ('bases', 'entries', 'review_cards', 'review_history', 'base_logos')}


def test_library_defaults_and_new_bases_append(owner):
    z = base(owner, 'Zulu')
    a = base(owner, 'Alpha')
    assert order(owner) == [z['id'], a['id']]
    assert z['logo'] == {'kind': 'icon', 'icon': 'database'}
    ok(owner.patch(f"/api/bases/{z['id']}", json={'name': 'Un autre nom'}))
    assert order(owner) == [z['id'], a['id']]
    db.init_db()
    assert order(owner) == [z['id'], a['id']]


def test_reorder_persists_and_move_to_nested_folder_and_root(owner):
    parent = folder(owner)
    child = folder(owner, 'Sous-dossier', parent)
    a, b, c = [base(owner, name)['id'] for name in ('A', 'B', 'C')]
    result = ok(move(owner, c, before_id=a))
    assert result['order'] == [c, a, b]
    assert result['base']['id'] == c and result['base']['folder_id'] is None
    result = ok(move(owner, a, folder_id=child))
    assert result['order'] == [c, b, a] and result['base']['folder_id'] == child
    ok(move(owner, b, folder_id=child, after_id=a))
    assert order(owner) == [c, a, b]
    ok(move(owner, b, folder_id=child, before_id=a))
    assert [item['id'] for item in library(owner) if item['folder_id'] == child] == [b, a]
    # A global reorder may anchor across folders without changing source location.
    result = ok(move(owner, a, before_id=c))
    assert result['base']['folder_id'] == child
    assert order(owner) == [a, c, b]
    result = ok(move(owner, a, folder_id=None))
    assert result['base']['folder_id'] is None and order(owner) == [c, b, a]
    db.init_db()
    assert order(owner) == [c, b, a]


def test_move_keeps_pgn_analysis_and_review_schedule(owner):
    item = base(owner, 'Tactiques', settings={'review_enabled': True})
    entry = ok(owner.post('/api/entries', json={'base_id': item['id'], 'pgn': '1. e4 e5 2. Nf3 *'}))
    card = ok(owner.get(f"/api/bases/{item['id']}/queue?all=true"))['cards'][0]
    ok(owner.post(f"/api/reviews/{card['id']}/grade", json={'grade': 2, 'elapsed_ms': 12000}))
    before = db_snapshot()
    destination = folder(owner)
    ok(move(owner, item['id'], folder_id=destination))
    after = db_snapshot()
    for key in ('entries', 'review_cards', 'review_history'):
        assert after[key] == before[key]
    assert ok(owner.get(f"/api/entries/{entry['id']}"))['base_id'] == item['id']


@pytest.mark.parametrize('patch', [
    {'base_id': True}, {'base_id': 0}, {'base_id': '1'}, {'base_id': 2**64},
    {'folder_id': True}, {'folder_id': '1'}, {'folder_id': 9999},
    {'before_id': None}, {'before_id': True}, {'before_id': 9999},
    {'before_id': 2, 'after_id': 3}, {'unsupported': True},
])
def test_invalid_move_is_atomic(owner, patch):
    source = base(owner, 'Source')['id']
    base(owner, 'Autre')
    before = db_snapshot()
    response = owner.post('/api/library/bases/move', json={'base_id': source, **patch})
    assert response.status_code in (400, 404, 409), response.text
    assert db_snapshot() == before


def test_move_checks_deleted_source_self_anchor_and_destination_mismatch(owner):
    source = base(owner, 'Source')['id']
    anchor = base(owner, 'Autre')['id']
    target = folder(owner)
    before = db_snapshot()
    assert move(owner, 9999, folder_id=target).status_code == 404
    assert move(owner, source, before_id=source).status_code == 400
    assert move(owner, source, folder_id=target, before_id=anchor).status_code == 409
    assert db_snapshot() == before


def test_old_schema_order_migrates_once_and_direct_insert_appends(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'old.sqlite3')
    with sqlite3.connect(db.DB_PATH) as conn:
        conn.execute('''CREATE TABLE bases (id INTEGER PRIMARY KEY,name TEXT NOT NULL,
                        folder_id INTEGER,tags TEXT NOT NULL DEFAULT '[]',
                        settings TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL)''')
        conn.executemany('INSERT INTO bases(id,name,created_at) VALUES(?,?,?)',
                         [(1, 'Zulu', 'old'), (2, 'bravo', 'old'), (3, 'Alpha', 'old')])
    db.init_db()
    with db.get_conn() as conn:
        assert [row['id'] for row in conn.execute('SELECT id FROM bases ORDER BY sort_order,id')] == [3, 2, 1]
        organization.move_base(conn, {'base_id': 1, 'before_id': 3})
    db.init_db()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(name,created_at) VALUES('Aardvark','new')")
        assert [row['id'] for row in conn.execute('SELECT id FROM bases ORDER BY sort_order,id')] == [1, 3, 2, 4]
        assert not conn.execute('PRAGMA foreign_key_check').fetchall()


@pytest.mark.parametrize('icon', sorted(organization.ICONS))
def test_every_preset_survives_settings_update(owner, icon):
    item = base(owner, 'Base')
    updated = ok(owner.patch(f"/api/bases/{item['id']}", json={'logo': {'kind': 'icon', 'icon': icon}}))
    assert updated['logo'] == {'kind': 'icon', 'icon': icon}
    result = ok(owner.patch(f"/api/bases/{item['id']}", json={'name': 'Renommée'}))
    assert result['logo'] == updated['logo']
    assert owner.get(f"/api/bases/{item['id']}/logo").status_code == 404


@pytest.mark.parametrize('fmt', ['PNG', 'JPEG', 'WEBP'])
def test_logo_formats_normalize_and_survive_other_changes(owner, fmt):
    item = base(owner, 'Photos')
    updated = ok(owner.patch(f"/api/bases/{item['id']}", json={
        'logo': {'kind': 'image', 'data_url': picture(fmt, (1024, 768))},
        'name': 'Avec image'}))
    assert updated['name'] == 'Avec image' and updated['logo']['kind'] == 'image'
    assert 'data_url' not in updated['logo']
    response = owner.get(updated['logo']['image_url'])
    assert response.status_code == 200
    assert response.headers['content-type'] == 'image/png'
    assert response.headers['cache-control'] == 'no-store'
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.format == 'PNG' and image.size == (512, 384)
        assert not image.getexif() and not image.info
    ok(owner.patch(f"/api/bases/{item['id']}", json={'tags': ['Cours']}))
    assert library(owner)[0]['logo'] == updated['logo']
    db.init_db()
    assert owner.get(updated['logo']['image_url']).content == response.content


def test_logo_strips_metadata_corrects_orientation_and_versions_changes(owner):
    exif = Image.Exif()
    exif[274] = 6
    exif[315] = 'Uploaded private author'
    item = base(owner, 'Image', logo={'kind': 'image', 'data_url': picture('JPEG', (80, 40), exif=exif)})
    response = owner.get(item['logo']['image_url'])
    with Image.open(io.BytesIO(response.content)) as image:
        assert image.size == (40, 80) and not image.getexif() and not image.info
    info = PngInfo()
    info.add_text('Comment', 'Uploaded private comment')
    updated = ok(owner.patch(f"/api/bases/{item['id']}", json={
        'logo': {'kind': 'image', 'data_url': picture(pnginfo=info)}}))
    assert updated['logo']['image_url'] != item['logo']['image_url']
    with Image.open(io.BytesIO(owner.get(updated['logo']['image_url']).content)) as image:
        assert not image.info


def test_icon_replacement_discards_uploaded_blob_and_delete_cascades(owner):
    item = base(owner, 'Image', logo={'kind': 'image', 'data_url': picture()})
    ok(owner.patch(f"/api/bases/{item['id']}", json={'logo': {'kind': 'icon', 'icon': 'king'}}))
    assert owner.get(item['logo']['image_url']).status_code == 404
    with db.get_conn() as conn:
        row = conn.execute('SELECT * FROM base_logos WHERE base_id=?', (item['id'],)).fetchone()
        assert row['image'] is None and row['digest'] is None
    ok(owner.delete(f"/api/bases/{item['id']}"))
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM base_logos').fetchone()[0] == 0


@pytest.mark.parametrize('logo', [
    None, 'star', {}, {'kind': 'icon', 'icon': 'unknown'},
    {'kind': 'icon', 'icon': 'king', 'image_url': 'javascript:alert(1)'},
    {'kind': 'image', 'data_url': 'data:image/svg+xml;base64,PHN2Zz4='},
    {'kind': 'image', 'data_url': 'data:image/png;base64,not-base64'},
    {'kind': 'image', 'data_url': 'data:image/png;base64,aGVsbG8='},
    {'kind': 'image', 'data_url': 'data:image/png;base64,'},
    {'kind': 'image', 'data_url': []},
])
def test_invalid_logo_is_atomic_for_create_and_patch(owner, logo):
    item = base(owner, 'Originale')
    before = db_snapshot()
    assert owner.patch(f"/api/bases/{item['id']}", json={'name': 'Ne doit pas changer', 'logo': logo}).status_code == 400
    assert owner.post('/api/bases', json={'name': 'Ne doit pas exister', 'logo': logo}).status_code == 400
    assert db_snapshot() == before


def test_logo_checks_declared_format_truncation_and_size(owner, monkeypatch):
    item = base(owner, 'Image')
    before = db_snapshot()
    good = picture()
    invalid_images = [good.replace('image/png', 'image/jpeg'), good[:-16]]
    for data_url in invalid_images:
        assert owner.patch(f"/api/bases/{item['id']}", json={'logo': {'kind': 'image', 'data_url': data_url}}).status_code == 400
    monkeypatch.setattr(organization, 'MAX_IMAGE_BYTES', 16)
    assert owner.patch(f"/api/bases/{item['id']}", json={'logo': {'kind': 'image', 'data_url': good}}).status_code == 413
    assert db_snapshot() == before


def test_logo_pixel_limit_and_invalid_settings_never_write(owner, monkeypatch):
    item = base(owner, 'Image')
    before = db_snapshot()
    monkeypatch.setattr(organization, 'MAX_IMAGE_PIXELS', 1000)
    assert owner.patch(f"/api/bases/{item['id']}", json={'logo': {'kind': 'image', 'data_url': picture()}}).status_code == 400
    assert owner.patch(f"/api/bases/{item['id']}", json={'settings': {'skill': 200}, 'logo': {'kind': 'icon', 'icon': 'book'}}).status_code == 400
    assert db_snapshot() == before


def test_private_routes_and_origin_protection(owner):
    item = base(owner, 'Image', logo={'kind': 'image', 'data_url': picture()})
    image_url = item['logo']['image_url']
    assert move(owner, item['id']).status_code == 200
    assert owner.post('/api/library/bases/move', json={'base_id': item['id']}, headers={'Origin': 'https://external.invalid'}).status_code == 403
    assert owner.patch(f"/api/bases/{item['id']}", json={'logo': {'kind': 'icon', 'icon': 'book'}}, headers={'Origin': 'https://external.invalid'}).status_code == 403
    owner.cookies.clear()
    assert owner.get(image_url).status_code == 200
    assert owner.get(image_url, headers={'Host': 'remote.invalid'}).status_code == 403
    assert owner.post('/api/library/bases/move', json={'base_id': item['id']}, headers={'Host': 'remote.invalid'}).status_code == 403
    assert owner.patch(f"/api/bases/{item['id']}", json={'logo': {'kind': 'icon', 'icon': 'book'}}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_order_migration_rolls_back_schema_and_data_if_interrupted(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'rollback.sqlite3')
    with sqlite3.connect(db.DB_PATH) as conn:
        conn.execute('''CREATE TABLE bases (id INTEGER PRIMARY KEY,name TEXT NOT NULL,
                        folder_id INTEGER,tags TEXT NOT NULL DEFAULT '[]',
                        settings TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL)''')
        conn.execute("INSERT INTO bases(name,created_at) VALUES('Originale','old')")

    class FailingConnection(db.ManagedConnection):
        def execute(self, sql, *args):
            if sql.startswith('CREATE INDEX IF NOT EXISTS bases_by_order'):
                raise RuntimeError('Simulated migration interruption')
            return super().execute(sql, *args)

    original_get_conn = db.get_conn

    def interrupted_connection():
        connection = sqlite3.connect(db.DB_PATH, factory=FailingConnection)
        connection.row_factory = sqlite3.Row
        connection.execute('PRAGMA foreign_keys=ON')
        return connection

    monkeypatch.setattr(db, 'get_conn', interrupted_connection)
    with pytest.raises(RuntimeError, match='Simulated migration interruption'):
        db.init_db()
    with sqlite3.connect(db.DB_PATH) as conn:
        assert 'sort_order' not in {row[1] for row in conn.execute('PRAGMA table_info(bases)')}
        assert conn.execute('SELECT id,name FROM bases').fetchall() == [(1, 'Originale')]
    monkeypatch.setattr(db, 'get_conn', original_get_conn)
    db.init_db()
    with db.get_conn() as conn:
        assert conn.execute('SELECT sort_order FROM bases').fetchone()[0] == 0


def test_logo_decoded_size_limit_checks_base64_padding(monkeypatch):
    monkeypatch.setattr(organization, 'MAX_IMAGE_BYTES', 17)
    # Both 17 and 18 bytes use 24 base64 characters; test the decoded limit too.
    encoded = base64.b64encode(b'x' * 18).decode()
    with pytest.raises(organization.HTTPException) as error:
        organization.checked_logo({'kind': 'image', 'data_url': 'data:image/png;base64,' + encoded})
    assert error.value.status_code == 413
