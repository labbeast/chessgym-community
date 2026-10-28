import hashlib
import io
import json
from pathlib import Path
import stat
import tarfile
import threading
import zipfile

import pytest

import engine_installations as installs


def sha(data):
    return hashlib.sha256(data).hexdigest()


def archive(path, names):
    with zipfile.ZipFile(path, 'w') as bundle:
        for name, data in names:
            item = zipfile.ZipInfo(name)
            # zipfile normalises Windows separators when constructing ZipInfo;
            # preserve the raw archive spelling to exercise hostile inputs.
            item.filename = name
            bundle.writestr(item, data)
    return path


def release():
    return {'tag_name': 'sf_19', 'prerelease': False, 'draft': False, 'assets': [{
        'name': 'stockfish-windows-x86-64-universal.zip', 'size': 100,
        'digest': 'sha256:' + 'f' * 64,
        'browser_download_url': installs.STOCKFISH_REPOSITORY +
        '/releases/download/sf_19/stockfish-windows-x86-64-universal.zip'}]}


def wait(manager):
    manager._thread.join(5)
    assert not manager._thread.is_alive()
    return manager.status()


@pytest.mark.parametrize(('system', 'machine', 'expected'), [
    ('Windows', 'AMD64', 'stockfish-windows-x86-64-universal.zip'),
    ('Windows', 'ARM64', 'stockfish-windows-arm64-universal.zip'),
    ('Linux', 'x86_64', 'stockfish-linux-x86-64-universal.tar.gz'),
    ('Linux', 'aarch64', 'stockfish-linux-arm64-universal.tar.gz'),
    ('Linux', 'riscv64', 'stockfish-linux-riscv64-universal.tar.gz'),
    ('Darwin', 'arm64', 'stockfish-macos-universal.tar.gz'),
    ('Windows', 'i386', None), ('Plan9', 'AMD64', None),
])
def test_assets_use_portable_build_for_correct_host(monkeypatch, system, machine, expected):
    monkeypatch.setattr(installs.platform, 'system', lambda: system)
    monkeypatch.setattr(installs.platform, 'machine', lambda: machine)
    assert installs._platform_asset() == expected


def test_release_requires_official_stable_matching_artifact(monkeypatch):
    monkeypatch.setattr(installs, '_platform_asset', lambda: release()['assets'][0]['name'])
    monkeypatch.setattr(installs, '_json', lambda url: release())
    result = installs._stockfish_release()
    assert result['version'] == '19'
    assert result['sha256'] == 'f' * 64


@pytest.mark.parametrize('change', [
    lambda value: value.update(prerelease=True),
    lambda value: value.update(draft=True),
    lambda value: value.update(tag_name='stockfish-dev-foo'),
    lambda value: value['assets'][0].update(digest=None),
    lambda value: value['assets'][0].update(digest='sha1:' + 'a' * 64),
    lambda value: value['assets'][0].update(size=installs.MAX_DOWNLOAD + 1),
    lambda value: value['assets'][0].update(size=True),
    lambda value: value['assets'][0].update(browser_download_url='https://example.org/malware.zip'),
])
def test_release_rejects_unverifiable_metadata(monkeypatch, change):
    value = release()
    change(value)
    monkeypatch.setattr(installs, '_platform_asset', lambda: release()['assets'][0]['name'])
    monkeypatch.setattr(installs, '_json', lambda url: value)
    with pytest.raises((ValueError, TypeError)):
        installs._stockfish_release()


@pytest.mark.parametrize('url', [
    'http://github.com/file', 'file:///etc/passwd', 'https://evil.com/archive',
    'https://github.com.evil.com/file', 'https://token@github.com/file',
    'https://github.com:8888/file',
])
def test_download_rejects_unknown_origins_and_credentials(url):
    with pytest.raises(ValueError):
        installs._safe_url(url)


@pytest.mark.parametrize('name', [
    '../escape.exe', '/absolute.exe', 'C:/drive.exe', 'a\\b.exe',
    'a/../b.exe', 'a/./b.exe', 'a//b.exe', 'a/alternate:stream',
    'a/trailing./b', 'a/space /b', 'a/CON.txt', 'LPT1.exe',
])
def test_archive_rejects_ambiguous_or_escaping_paths(tmp_path, name):
    source = archive(tmp_path / 'bad.zip', [(name, b'bad')])
    with pytest.raises(ValueError):
        installs._extract(source, tmp_path / 'target')
    assert not (tmp_path / 'target').exists()


def test_archive_validates_all_entries_before_any_write(tmp_path):
    source = archive(tmp_path / 'bad.zip', [('good/file.exe', b'good'), ('../bad.exe', b'bad')])
    with pytest.raises(ValueError):
        installs._extract(source, tmp_path / 'target')
    assert not (tmp_path / 'target').exists()


def test_archive_rejects_case_aliases_and_symlink(tmp_path):
    source = archive(tmp_path / 'duplicate.zip', [('a.exe', b'a'), ('A.exe', b'b')])
    with pytest.raises(ValueError):
        installs._extract(source, tmp_path / 'target')
    with zipfile.ZipFile(tmp_path / 'link.zip', 'w') as bundle:
        info = zipfile.ZipInfo('link')
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        bundle.writestr(info, '../outside')
    with pytest.raises(ValueError):
        installs._extract(tmp_path / 'link.zip', tmp_path / 'target')


def test_zip_and_tar_extract_regular_files(tmp_path):
    source = archive(tmp_path / 'good.zip', [('stockfish/COPYING', b'GPL'), ('stockfish/engine.exe', b'exe')])
    files = installs._extract(source, tmp_path / 'zip')
    assert len(files) == 2
    assert (tmp_path / 'zip/stockfish/COPYING').read_bytes() == b'GPL'
    with tarfile.open(tmp_path / 'good.tar.gz', 'w:gz') as bundle:
        item = tarfile.TarInfo('stockfish/engine')
        item.size = 3
        item.mode = 0o755
        bundle.addfile(item, io.BytesIO(b'exe'))
    assert len(installs._extract(tmp_path / 'good.tar.gz', tmp_path / 'tar')) == 1


def test_tar_links_are_never_followed(tmp_path):
    with tarfile.open(tmp_path / 'bad.tar.gz', 'w:gz') as bundle:
        item = tarfile.TarInfo('stockfish/engine')
        item.type = tarfile.SYMTYPE
        item.linkname = '../../outside'
        bundle.addfile(item)
    with pytest.raises(ValueError):
        installs._extract(tmp_path / 'bad.tar.gz', tmp_path / 'target')


def test_expansion_is_bounded(tmp_path, monkeypatch):
    source = archive(tmp_path / 'large.zip', [('a', b'123'), ('b', b'456')])
    monkeypatch.setattr(installs, 'MAX_EXPANDED', 5)
    with pytest.raises(ValueError):
        installs._extract(source, tmp_path / 'target')


def test_download_checks_size_and_hash_before_publish(tmp_path, monkeypatch):
    monkeypatch.setattr(installs, '_open', lambda *args, **kwargs: io.BytesIO(b'official'))
    target = tmp_path / 'archive.zip'
    spec = {'url': 'unused', 'bytes': 8, 'sha256': sha(b'official')}
    progress = []
    installs._download(spec, target, progress.append)
    assert target.read_bytes() == b'official'
    assert progress[-1] == 1
    assert not list(tmp_path.glob('*.part'))


@pytest.mark.parametrize(('data', 'size', 'digest'), [(b'bad', 3, 'f' * 64), (b'long', 3, sha(b'long')),
                                                     (b'short', 10, sha(b'short'))])
def test_failed_download_never_publishes(tmp_path, monkeypatch, data, size, digest):
    monkeypatch.setattr(installs, '_open', lambda *args, **kwargs: io.BytesIO(data))
    with pytest.raises(ValueError):
        installs._download({'url': 'unused', 'bytes': size, 'sha256': digest}, tmp_path / 'archive', lambda _: None)
    assert not list(tmp_path.iterdir())


def test_only_catalog_identifiers_are_accepted(tmp_path):
    manager = installs.EngineInstallationManager(tmp_path)
    for value in ('https://github.com/malware.zip', '../engine', '', None, []):
        with pytest.raises(ValueError):
            manager.start_job(value)
    assert not manager.root.exists()


def test_single_job_and_registry_after_success_only(tmp_path, monkeypatch):
    registered, entered, release_event = [], threading.Event(), threading.Event()
    manager = installs.EngineInstallationManager(tmp_path, register=lambda value: registered.append(value) or value)
    def install(stage):
        entered.set()
        assert release_event.wait(3)
        assert not registered
        return {'id': 'verified', 'path': str(stage / 'engine')}
    monkeypatch.setattr(manager, '_install_stockfish', install)
    monkeypatch.setattr(installs, '_platform_asset', lambda: 'compatible')
    started = manager.start_job('stockfish-latest')
    assert entered.wait(2)
    with pytest.raises(RuntimeError):
        manager.start_job('maia3-5m')
    release_event.set()
    final = wait(manager)
    assert final['state'] == 'completed'
    assert final['progress'] == 100
    assert len(registered) == 1
    assert not list(manager.root.glob('.staging-*'))
    assert manager.status('different-job') is None
    assert manager.status(started['id']) == final
    assert installs.EngineInstallationManager(tmp_path).status() == final


def test_failed_job_keeps_working_install_and_never_registers(tmp_path, monkeypatch):
    old = tmp_path / 'engines/maia3/model.pt'
    old.parent.mkdir(parents=True)
    old.write_bytes(b'existing working engine')
    registered = []
    manager = installs.EngineInstallationManager(tmp_path, register=registered.append)
    def install(stage, model):
        (stage / 'partial').write_bytes(b'partial')
        raise ValueError('hash mismatch')
    monkeypatch.setattr(manager, '_install_maia', install)
    manager.start_job('maia3-5m')
    final = wait(manager)
    assert final['state'] == 'failed'
    assert 'hash mismatch' in final['error']
    assert registered == []
    assert old.read_bytes() == b'existing working engine'
    assert not list(manager.root.glob('.staging-*'))


def test_restart_marks_interrupted_job_retryable(tmp_path):
    root = tmp_path / 'engines/managed'
    root.mkdir(parents=True)
    (root / 'install-job.json').write_text(json.dumps({'id': 'old', 'state': 'running'}))
    manager = installs.EngineInstallationManager(tmp_path)
    assert manager.status()['state'] == 'failed'
    assert not manager.busy


def test_upstream_maia_is_reported_without_adopting_unverified_revision(tmp_path, monkeypatch):
    manager = installs.EngineInstallationManager(tmp_path)
    monkeypatch.setattr(installs, '_stockfish_release', lambda: {
        'version': '19', 'release_url': 'official', 'bytes': 100, 'sha256': 'f' * 64})
    monkeypatch.setattr(installs, '_json', lambda url: {'sha': '0' * 40})
    result = manager.check_updates()
    assert result['stockfish']['version'] == '19'
    assert result['maia3']['new_upstream']
    assert not result['maia3']['automatic_update_supported']
    assert result['maia3']['source_commit'] == installs.install_maia.SOURCE_COMMIT
    assert result['maia3']['models'][0]['revision'] != '0' * 40
    assert not manager.root.exists()


def test_update_service_failure_does_not_break_local_catalogue(tmp_path, monkeypatch):
    manager = installs.EngineInstallationManager(tmp_path)
    def failure(*args):
        raise OSError('offline')
    monkeypatch.setattr(installs, '_json', failure)
    result = manager.check_updates()
    assert len(result['errors']) == 4
    assert {item['id'] for item in manager.catalog()} == {'stockfish-latest', 'maia3-79m', 'maia3-5m'}


def test_adoption_of_verified_local_maia_does_not_change_files(tmp_path, monkeypatch):
    current = tmp_path / 'engines/maia3'
    current.mkdir(parents=True)
    original = json.dumps({'models': {'maia3-79m': {'path': 'models/maia3-79m.pt'}}})
    (current / 'manifest.json').write_text(original)
    manager = installs.EngineInstallationManager(tmp_path)
    calls = []
    monkeypatch.setattr(installs.install_maia, 'verify', lambda root: calls.append(Path(root)))
    monkeypatch.setattr(installs, '_probe_maia', lambda root, model: {'move': 'e2e4'})
    monkeypatch.setattr(installs.install_maia, 'install', lambda *args, **kwargs: pytest.fail('must not modify adopted engine'))
    manager.start_job('maia3-79m')
    final = wait(manager)
    assert final['state'] == 'completed'
    assert final['engine']['managed_root'] is None
    assert final['engine']['path'] == str(current)
    assert (current / 'manifest.json').read_text() == original


def test_existing_manifest_cannot_point_outside_installation(tmp_path):
    manager = installs.EngineInstallationManager(tmp_path)
    final = manager.root / 'engine'
    final.mkdir(parents=True)
    spec = {'id': 'engine', 'managed_root': str(final), 'kind': 'uci', 'path': str(tmp_path / 'outside.exe')}
    (final / 'installation.json').write_text(json.dumps({'engine': spec, 'files': {'a': 'f' * 64}}))
    with pytest.raises(ValueError, match='sort de son installation'):
        manager._existing(final, 'engine')


@pytest.mark.parametrize('tamper', ['executable-and-manifest', 'extra-executable'])
def test_reinstall_uses_official_archive_not_editable_local_manifest(tmp_path, monkeypatch, tamper):
    executable = 'stockfish-universal' + ('.exe' if installs.os.name == 'nt' else '')
    original = archive(tmp_path / 'official.zip', [('stockfish/COPYING', b'GPL'),
                                               ('stockfish/' + executable, b'verified executable')])
    spec = {'version': '19', 'name': 'official.zip', 'sha256': installs._digest(original),
            'bytes': original.stat().st_size, 'release_url': installs.STOCKFISH_REPOSITORY, 'url': 'unused'}
    monkeypatch.setattr(installs, '_stockfish_release', lambda: spec)
    monkeypatch.setattr(installs, '_platform_asset', lambda: 'compatible')
    monkeypatch.setattr(installs, '_download', lambda release, target, callback: target.write_bytes(original.read_bytes()))
    probes, registered = [], []
    monkeypatch.setattr(installs, '_probe_stockfish', lambda path: probes.append(path) or {'name': 'Stockfish 19', 'move': 'e2e4'})
    manager = installs.EngineInstallationManager(tmp_path, register=lambda value: registered.append(value) or value)
    manager.start_job('stockfish-latest')
    first = wait(manager)
    assert first['state'] == 'completed'
    root = Path(first['engine']['managed_root'])
    path = Path(first['engine']['path'])
    manifest = json.loads((root / 'installation.json').read_text())
    if tamper == 'executable-and-manifest':
        path.write_bytes(b'changed executable')
        manifest['files'][path.relative_to(root).as_posix()] = installs._digest(path)
    else:
        extra = root / ('stockfish-other' + ('.exe' if installs.os.name == 'nt' else ''))
        extra.write_bytes(b'not from official archive')
        manifest['engine']['path'] = str(extra)
        manifest['files'][extra.name] = installs._digest(extra)
    (root / 'installation.json').write_text(json.dumps(manifest))
    manager.start_job('stockfish-latest')
    second = wait(manager)
    assert second['state'] == 'failed'
    assert len(registered) == 1
    assert len(probes) == 1, 'changed executable must not run even if its local manifest was edited'
