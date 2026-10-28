import json
from pathlib import Path
import sqlite3
import shutil
import zipfile

from fastapi import HTTPException
import pytest

import backup_service as backups
import db
import reference_library
import training


@pytest.fixture
def personal(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'study.sqlite3')
    monkeypatch.setattr(backups, '_THREAD', None)
    db.init_db()
    training.init_training()
    with db.get_conn() as conn:
        conn.execute('INSERT INTO users VALUES(1,?,?,?)', ('owner', 'test-hash', backups.now()))
        base = conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)', ('Course', backups.now())).lastrowid
        conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                     (base, 'Annotated game', '1. e4 { Keep this note } e5 *', backups.now(), backups.now()))
    return tmp_path, base


def test_manual_and_automatic_backup_rotation_only_removes_owned_automatic_files(personal):
    root, _ = personal
    backups.update_settings({'enabled': True, 'keep': 2})
    folder = Path(backups.settings()['destination'])
    folder.mkdir(parents=True)
    unrelated = folder / 'important.zip'; unrelated.write_bytes(b'keep')
    manual = backups.create_archive()
    generated = [backups.create_archive(automatic=True)['id'] for _ in range(4)]
    listed = {item['id'] for item in backups.list_archives()}
    assert listed == {manual['id'], *generated[-2:]}
    assert unrelated.read_bytes() == b'keep'
    assert backups.verify_archive(backups.archive_path(manual['id']))['entries'] == 1
    assert not list(folder.glob('*.partial'))
    assert not list(folder.glob('snapshot-*'))


def test_personal_snapshot_never_opens_reference_stores(personal, monkeypatch):
    with db.get_conn() as conn:
        ref = conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)', ('Mega', backups.now())).lastrowid
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source) VALUES(?,?,?)', (ref, 'a'*32, '/archive.pgn'))
    monkeypatch.setattr(reference_library, 'store_path', lambda *a: pytest.fail('A personal backup must not open references'))
    item = backups.create_archive()
    with zipfile.ZipFile(backups.archive_path(item['id'])) as archive:
        assert not any(name.startswith('references/') for name in archive.namelist())
        manifest = json.loads(archive.read('metadata.json'))
        assert manifest['backup']['omitted_reference_stores'][0]['base_id'] == ref


def test_public_puzzle_bank_is_separate_from_personal_progress(personal):
    root, _ = personal
    path = root / 'puzzles' / 'bank.sqlite3'
    path.parent.mkdir()
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE sample(id TEXT)')
        conn.execute("INSERT INTO sample VALUES('puzzle')")
    with db.get_conn() as conn:
        conn.execute('CREATE TABLE sample_attempts(result TEXT)')
        conn.execute("INSERT INTO sample_attempts VALUES('solved')")
    for mode in ('personal', 'full'):
        target = root / (mode + '.zip')
        backups.build_archive(target, mode)
        with zipfile.ZipFile(target) as archive:
            metadata = json.loads(archive.read('metadata.json'))['backup']
            assert metadata['puzzle_bank_included'] == (mode == 'full')
            assert ('puzzles/bank.sqlite3' in archive.namelist()) == (mode == 'full')
            assert bool(metadata['omitted_puzzle_bank']) == (mode == 'personal')
            snapshot = root / (mode + '-snapshot.sqlite3')
            snapshot.write_bytes(archive.read('chessgym.sqlite3'))
            with sqlite3.connect(snapshot) as conn:
                assert conn.execute('SELECT result FROM sample_attempts').fetchone()[0] == 'solved'


def test_restore_requires_stopped_app_and_preserves_rollback_and_reference_files(personal):
    root, base = personal
    item = backups.create_archive()
    archive = backups.archive_path(item['id'])
    ref = root / 'references' / ('b'*32+'.sqlite3')
    ref.parent.mkdir(); ref.write_bytes(b'Untouched reference store')
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET title=?', ('Changed after backup',))
        conn.execute('INSERT INTO sessions VALUES(?,?,?)', ('session-after-backup', 1, 9999999999))
    with backups.offline_guard():
        with pytest.raises(RuntimeError, match='Arrête ChessGym'):
            backups.restore_offline(archive, confirm=True)
    with db.get_conn() as conn:
        assert conn.execute('SELECT title FROM entries').fetchone()[0] == 'Changed after backup'
    result = backups.restore_offline(archive, confirm=True)
    assert result['restored'] and result['entries'] == 1
    with db.get_conn() as conn:
        assert conn.execute('SELECT title FROM entries').fetchone()[0] == 'Annotated game'
        assert conn.execute('SELECT count(*) FROM sessions').fetchone()[0] == 0
        assert len(json.loads(conn.execute("SELECT value FROM preferences WHERE key='workspace_epoch'").fetchone()[0])) == 32
        assert conn.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    with sqlite3.connect(result['rollback'], factory=db.ManagedConnection) as conn:
        assert conn.execute('SELECT title FROM entries').fetchone()[0] == 'Changed after backup'
    assert ref.read_bytes() == b'Untouched reference store'


@pytest.mark.parametrize('name', ['../elsewhere.zip', 'C:\\private.zip', 'manual.zip', 'chessgym-auto-20261022T000000000000Z-abcdefgh.zip'])
def test_download_names_are_confined(personal, name):
    with pytest.raises(HTTPException) as error:
        backups.archive_path(name)
    assert error.value.status_code == 404


@pytest.mark.parametrize('patch', [{'keep': 0}, {'keep': True}, {'interval_hours': .5}, {'enabled': 'yes'}, {'destination': 'relative'}, {'unknown': 1}])
def test_invalid_settings_are_atomic(personal, patch):
    before = backups.settings()
    with pytest.raises(HTTPException):
        backups.update_settings(patch)
    assert backups.settings() == before


def test_invalid_archive_does_not_touch_live_database(personal):
    root, _ = personal
    bad = root / 'bad.zip'
    with zipfile.ZipFile(bad, 'w') as archive:
        archive.writestr('../escape', 'bad')
        archive.writestr('metadata.json', '{}')
        archive.writestr('chessgym.sqlite3', b'invalid')
    with pytest.raises(ValueError):
        backups.restore_offline(bad, confirm=True)
    with db.get_conn() as conn:
        assert conn.execute('SELECT title FROM entries').fetchone()[0] == 'Annotated game'
    assert not (root.parent / 'escape').exists()


def test_rotation_waits_for_successful_verification(personal, monkeypatch):
    backups.update_settings({'keep': 1})
    first = backups.create_archive(automatic=True)
    monkeypatch.setattr(backups, 'verify_archive', lambda path: (_ for _ in ()).throw(ValueError('damaged')))
    with pytest.raises(ValueError, match='damaged'):
        backups.create_archive(automatic=True)
    assert [item['id'] for item in backups.list_archives()] == [first['id']]
    assert backups.status()['last_run']['status'] == 'error'


def test_scheduler_is_nonblocking_and_does_not_duplicate_recent_success(personal, monkeypatch):
    backups.update_settings({'enabled': True, 'interval_hours': 24})
    started = []
    class Thread:
        def __init__(self, *, target, **kwargs): self.target = target
        def start(self): started.append(self); self.target()
        def is_alive(self): return False
    monkeypatch.setattr(backups.threading, 'Thread', Thread)
    backups.scheduler_tick(); backups.scheduler_tick()
    assert len(started) == 1
    assert len(backups.list_archives()) == 1


def test_retention_keeps_its_original_destination_when_settings_change_mid_backup(personal, monkeypatch):
    root, _ = personal
    backups.update_settings({'keep': 3})
    previous = [backups.create_archive(automatic=True)['id'] for _ in range(2)]
    original_folder = Path(backups.settings()['destination'])
    other = root / 'new-destination'; other.mkdir()
    for name in previous:
        shutil.copy2(original_folder / name, other / name)
    backups.update_settings({'keep': 1})
    original_build = backups.build_archive
    def build(path, mode='personal'):
        original_build(path, mode)
        backups.update_settings({'destination': str(other)})
    monkeypatch.setattr(backups, 'build_archive', build)
    latest = backups.create_archive(automatic=True)
    assert {item['id'] for item in backups.list_archives(root=original_folder)} == {latest['id']}
    assert {item['id'] for item in backups.list_archives(root=other)} == set(previous)


def test_retention_never_removes_another_installations_automatic_backup(personal):
    root, _ = personal
    backups.update_settings({'keep': 1})
    other = backups.create_archive(automatic=True)
    path = backups.archive_path(other['id'])
    with zipfile.ZipFile(path) as archive:
        contents = {name: archive.read(name) for name in archive.namelist()}
    metadata = json.loads(contents['metadata.json']); metadata['backup']['owner'] = 'another-installation'
    contents['metadata.json'] = json.dumps(metadata).encode()
    with zipfile.ZipFile(path, 'w') as archive:
        for name, value in contents.items(): archive.writestr(name, value)
    newest = backups.create_archive(automatic=True)
    assert {item['id'] for item in backups.list_archives()} == {other['id'], newest['id']}
