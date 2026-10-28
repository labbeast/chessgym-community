"""Lumbra installation reads small local fixtures; no network or user data."""
import hashlib
import io
from pathlib import Path
import subprocess
import sys

import pytest

import db
import lumbra_resources as resources
import reference_library
import reference_store
import resource_policy


PGN = '[Event "Fixture"]\n[White "Alpha"]\n[Black "Beta"]\n[WhiteElo "2500"]\n[BlackElo "2510"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n'
ELITE = 'lumbra-otb-elite'
COMPLETE = 'lumbra-otb-complete'


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path / 'data')
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'data' / 'personal.sqlite3')
    monkeypatch.setattr(resources, '_free_space', lambda *args: None)
    monkeypatch.setenv('CHESSGYM_IMPORT_WORKERS', '1')
    monkeypatch.setenv('CHESSGYM_IMPORT_CACHE_MB', '64')
    db.init_db()
    return resources.LumbraResources(db.DATA_DIR)


def source(tmp_path, text=PGN, name='download.pgn'):
    path = tmp_path / name
    path.write_text(text, encoding='utf-8')
    return path


def test_catalog_is_local_and_both_official_sources_are_declared(isolated, monkeypatch):
    monkeypatch.setattr(resources, '_seven_zip', lambda: None)
    cards = isolated.catalog()
    assert [card['id'] for card in cards] == [ELITE, COMPLETE]
    assert all(card['category'] == 'database' and card['installation_mode'] == 'browser-download' for card in cards)
    assert cards[0]['download_url'] == 'https://lumbrasgigabase.com/lgb-file/11049/'
    assert cards[1]['download_url'] == 'https://lumbrasgigabase.com/lgb-file/11047/'
    assert all(card['license'] == 'CC BY-NC 4.0' and not card['installed'] for card in cards)
    assert all(card['available'] and not card['seven_zip_available'] for card in cards)


def test_install_requires_browser_download_file(isolated):
    with pytest.raises(ValueError, match='site officiel'):
        isolated.install(ELITE)
    with pytest.raises(ValueError, match='inconnue'):
        isolated.install('other')
    with pytest.raises(ValueError, match='chemin complet'):
        isolated.install(ELITE, source_path='relative.pgn')


def test_plain_pgn_is_published_once_and_keeps_a_source_copy(isolated, tmp_path):
    original = source(tmp_path)
    stages = []
    result = isolated.install(ELITE, lambda stage, percent: stages.append((stage, percent)), source_path=original)
    row = reference_library.require_reference(result['base_id'])
    assert reference_library.get_status(result['base_id'])['status'] == 'completed'
    assert result['count'] == 1
    assert Path(result['pgn_path']).read_text(encoding='utf-8') == PGN
    assert Path(result['pgn_path']) != original
    assert row['source'] == result['pgn_path']
    assert result['sha256'] == hashlib.sha256(original.read_bytes()).hexdigest()
    assert isolated.install(ELITE, source_path=original)['base_id'] == result['base_id']
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 1
        assert not conn.execute('SELECT 1 FROM preferences WHERE key=?', ('explorer_settings',)).fetchone()
    assert isolated.catalog()[0]['installed']
    assert stages[-1] == ('Base Lumbra disponible', 100)
    assert not list(isolated.root.glob('.staging-*'))
    original.unlink()
    assert Path(row['source']).is_file()


def test_revised_file_and_complete_base_keep_older_sources(isolated, tmp_path):
    original = source(tmp_path)
    old = isolated.install(ELITE, source_path=original)
    original.write_text(PGN.replace('Fixture', 'Revised'), encoding='utf-8')
    new = isolated.install(ELITE, source_path=original)
    complete = isolated.install(COMPLETE, source_path=original)
    assert len({old['base_id'], new['base_id'], complete['base_id']}) == 3
    assert Path(old['pgn_path']).read_text(encoding='utf-8') == PGN
    assert reference_library.get_status(old['base_id'])['game_count'] == 1
    # Choosing an old source again reuses the matching old base, even though the
    # resource record points at the newer version.
    again = source(tmp_path, name='old-copy.pgn')
    assert isolated.install(ELITE, source_path=again)['base_id'] == old['base_id']


def test_invalid_pgn_never_publishes_reference_or_record(isolated, tmp_path):
    for text in ('<html>Error</html>', '[Invalid PGN content]\n'):
        with pytest.raises(ValueError):
            isolated.install(ELITE, source_path=source(tmp_path, text))
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 0
    assert not (isolated.root / 'installed.json').exists()
    assert not list(isolated.root.glob('.staging-*'))


def test_failed_new_version_preserves_installed_reference(isolated, tmp_path, monkeypatch):
    original = source(tmp_path)
    old = isolated.install(ELITE, source_path=original)
    original.write_text(PGN.replace('Fixture', 'Changed'), encoding='utf-8')
    monkeypatch.setattr(resources, '_integrity', lambda path: (_ for _ in ()).throw(ValueError('Integrity failure')))
    with pytest.raises(ValueError, match='Integrity'):
        isolated.install(ELITE, source_path=original)
    assert isolated._records()[ELITE]['base_id'] == old['base_id']
    assert reference_library.get_status(old['base_id'])['game_count'] == 1
    assert Path(old['pgn_path']).read_text(encoding='utf-8') == PGN
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 1


def test_install_uses_configured_resource_budget(isolated, tmp_path, monkeypatch):
    captured = {}
    actual = reference_store.import_file
    monkeypatch.setenv('CHESSGYM_IMPORT_WORKERS', '4')
    monkeypatch.setenv('CHESSGYM_IMPORT_CACHE_MB', '128')
    monkeypatch.setattr(resource_policy, '_CURRENT', {'profile':'custom', 'total_threads':4, 'hash_mb':128, 'import_workers':2})
    monkeypatch.setattr(resource_policy, '_DESIRED', dict(resource_policy._CURRENT))
    def importing(*args, **kwargs):
        captured.update(kwargs)
        assert reference_library.import_active()
        # Keep the fixture serial while checking the allocated parallel budget.
        return actual(*args, **{**kwargs, 'workers': 1})
    monkeypatch.setattr(reference_store, 'import_file', importing)
    isolated.install(ELITE, source_path=source(tmp_path))
    assert captured['workers'] == 2
    assert captured['cache_mib'] == 128
    assert not reference_library.import_active()


def test_stop_and_low_disk_never_publish(isolated, tmp_path, monkeypatch):
    original = source(tmp_path)
    def stop(stage, percent):
        if stage == 'Ajout de la base Lumbra à la bibliothèque':
            raise InterruptedError('Stopped')
    with pytest.raises(InterruptedError):
        isolated.install(ELITE, stop, source_path=original)
    assert not reference_library.import_active()
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 0
    monkeypatch.setattr(resources, '_free_space', lambda *args: (_ for _ in ()).throw(ValueError('Espace disque')))
    with pytest.raises(ValueError, match='Espace disque'):
        isolated.install(ELITE, source_path=original)


def listing(name='games.pgn', size=123, extra=''):
    return f'Path = {name}\nSize = {size}\nPacked Size = 77\nAttributes = A\nEncrypted = -\n{extra}\n'


@pytest.mark.parametrize('name', ['../games.pgn', '/games.pgn', 'C:\\games.pgn', 'dir/../games.pgn',
    'dir//games.pgn', 'NUL.pgn', 'games.pgn:stream', 'games*.pgn', 'a\x00.pgn', 'a\n.pgn'])
def test_archive_member_paths_are_rejected(name):
    with pytest.raises(ValueError):
        resources._pgn_member(listing(name), 1000)


def test_archive_regular_pgn_and_metadata_validation():
    assert resources._pgn_member(listing('Folder/games.pgn'), 1000) == ('Folder/games.pgn', 123)
    for data in (listing(extra='Symbolic Link = elsewhere'), listing(extra='Hard Link = other'),
                 listing().replace('Encrypted = -', 'Encrypted = +'), listing(size=1001),
                 listing(size=0), listing('one.pgn') + listing('two.pgn'), listing('README.txt'),
                 listing().replace('Attributes = A', 'Attributes = A lrwxrwxrwx')):
        with pytest.raises(ValueError):
            resources._pgn_member(data, 1000)


def test_missing_7zip_has_actionable_fallback(isolated, tmp_path, monkeypatch):
    archive = tmp_path / 'download.7z'
    archive.write_bytes(b'7z fixture')
    monkeypatch.setattr(resources, '_seven_zip', lambda: None)
    with pytest.raises(ValueError, match='décompresse'):
        isolated.install(ELITE, source_path=archive)
    assert not isolated.root.exists()


def test_command_output_is_bounded_and_process_error_is_reported():
    with pytest.raises(ValueError, match='taille'):
        resources._command_output([sys.executable, '-c', "import sys;sys.stdout.buffer.write(b'x'*100)"],
            io.BytesIO(), maximum=10, timeout=10, progress=lambda *args: None, stage='test')
    with pytest.raises(ValueError, match='endommagée'):
        resources._command_output([sys.executable, '-c', 'raise SystemExit(2)'], io.BytesIO(),
            maximum=10, timeout=10, progress=lambda *args: None, stage='test')


def test_installed_7zip_extracts_only_the_pgn_as_stream(isolated, tmp_path):
    executable = resources._seven_zip()
    if not executable:
        pytest.skip('7-Zip is not installed on this test host')
    original = source(tmp_path, name='masters.pgn')
    (tmp_path / 'README.txt').write_text('fixture attribution', encoding='utf-8')
    archive = tmp_path / 'official-fixture.7z'
    subprocess.run([executable, 'a', '-t7z', '-bd', str(archive), original.name, 'README.txt'],
        cwd=tmp_path, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    result = isolated.install(ELITE, source_path=archive)
    assert result['count'] == 1
    assert Path(result['pgn_path']).read_bytes() == original.read_bytes()
    assert Path(result['archive_path']).read_bytes() == archive.read_bytes()
    assert not (Path(result['pgn_path']).parent / 'README.txt').exists()
    assert isolated.install(ELITE, source_path=archive)['base_id'] == result['base_id']


def test_deleted_reference_is_not_reported_installed(isolated, tmp_path):
    result = isolated.install(ELITE, source_path=source(tmp_path))
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=?', (result['base_id'],))
    assert not isolated.catalog()[0]['installed']


def test_reused_base_id_is_not_mistaken_for_deleted_lumbra_resource(isolated, tmp_path):
    elite_source = source(tmp_path)
    elite = isolated.install(ELITE, source_path=elite_source)
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=?', (elite['base_id'],))
    complete_source = source(tmp_path, PGN.replace('Fixture', 'Other collection'), name='complete.pgn')
    complete = isolated.install(COMPLETE, source_path=complete_source)
    assert complete['base_id'] == elite['base_id'], 'Fixture must exercise SQLite ID reuse'
    cards = {item['id']: item for item in isolated.catalog()}
    assert not cards[ELITE]['installed']
    assert cards[COMPLETE]['installed']
    reinstalled = isolated.install(ELITE, source_path=elite_source)
    assert reinstalled['base_id'] != complete['base_id']
    assert reference_library.require_reference(reinstalled['base_id'])['source'] == elite['pgn_path']
    assert reference_library.require_reference(complete['base_id'])['source'] == complete['pgn_path']
