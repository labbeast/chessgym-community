"""Installer safeguards; no network, package installation, or user data writes."""
from io import BytesIO
import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import warnings
import zipfile

import pytest


SPEC = importlib.util.spec_from_file_location(
    'chessgym_install_maia3', Path(__file__).parents[1] / 'scripts' / 'install_maia.py')
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class Response(BytesIO):
    url = 'https://official.example/checkpoint'


def archive(path, additions=()):
    prefix = f'maia3-{installer.SOURCE_COMMIT}/'
    with zipfile.ZipFile(path, 'w') as out:
        out.writestr(prefix + 'LICENSE', 'license')
        out.writestr(prefix + 'pyproject.toml', '[project]\nname="maia3"')
        out.writestr(prefix + 'maia3/uci.py', 'PINNED = True\n')
        out.writestr(prefix + 'maia3/__init__.py', '')
        for name, value in additions:
            if isinstance(name, str) and '\\' in name:
                # ZipInfo normally normalizes backslashes on Windows. Preserve
                # the actual foreign archive bytes to test the extraction guard.
                info = zipfile.ZipInfo(name)
                info.filename = name
                name = info
            out.writestr(name, value)
    return path


def test_download_wrong_hash_preserves_existing_file_and_removes_partial(tmp_path, monkeypatch):
    target = tmp_path / 'model.pt'
    target.write_bytes(b'previous')
    monkeypatch.setattr(installer.urllib.request, 'urlopen', lambda *a, **k: Response(b'wrong'))
    with pytest.raises(ValueError, match='SHA-256'):
        installer.download('https://example/model', target, '0' * 64, max_bytes=100)
    assert target.read_bytes() == b'previous'
    assert not list(tmp_path.glob('*.part'))


def test_download_refuses_oversized_response(tmp_path, monkeypatch):
    monkeypatch.setattr(installer.urllib.request, 'urlopen', lambda *a, **k: Response(b'123456'))
    with pytest.raises(ValueError, match='exceeds'):
        installer.download('https://example/model', tmp_path / 'model.pt', '0' * 64, max_bytes=5)
    assert not list(tmp_path.iterdir())


def test_download_rejects_http_redirect(tmp_path, monkeypatch):
    response = Response(b'weights')
    response.url = 'http://example/model'
    monkeypatch.setattr(installer.urllib.request, 'urlopen', lambda *a, **k: response)
    with pytest.raises(ValueError, match='Unencrypted'):
        installer.download('https://example/model', tmp_path / 'model.pt', '0' * 64, max_bytes=100)


def test_download_valid_cache_avoids_network(tmp_path, monkeypatch):
    target = tmp_path / 'model.pt'
    target.write_bytes(b'weights')
    def unexpected(*args, **kwargs):
        pytest.fail('Verified cache must not perform network access')
    monkeypatch.setattr(installer.urllib.request, 'urlopen', unexpected)
    installer.download('https://example/model', target, installer.digest(target), max_bytes=100)


def test_valid_download_is_committed_after_verification(tmp_path, monkeypatch):
    monkeypatch.setattr(installer.urllib.request, 'urlopen', lambda *a, **k: Response(b'weights'))
    target = tmp_path / 'model.pt'
    installer.download('https://example/model', target, hashlib.sha256(b'weights').hexdigest(), max_bytes=7)
    assert target.read_bytes() == b'weights'
    assert not list(tmp_path.glob('*.part'))


@pytest.mark.parametrize('name', [
    f'maia3-{installer.SOURCE_COMMIT}/../escape.py',
    '/outside.py', 'C:/outside.py',
    f'maia3-{installer.SOURCE_COMMIT}/dir\\escape.py', 'different-root/maia3/uci.py',
])
def test_extract_validates_all_entries_before_any_write(tmp_path, name):
    bundle = archive(tmp_path / 'source.zip', [(name, 'unsafe')])
    destination = tmp_path / 'source'
    with pytest.raises(ValueError, match='Unsafe'):
        installer.extract_source(bundle, destination)
    assert not destination.exists()


def test_extract_rejects_symlink(tmp_path):
    link = zipfile.ZipInfo(f'maia3-{installer.SOURCE_COMMIT}/escape.py')
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    bundle = archive(tmp_path / 'source.zip', [(link, '../outside')])
    with pytest.raises(ValueError, match='Unsafe'):
        installer.extract_source(bundle, tmp_path / 'source')


def test_extract_rejects_duplicate_entries(tmp_path):
    with warnings.catch_warnings():
        warnings.simplefilter('ignore', UserWarning)
        bundle = archive(tmp_path / 'source.zip', [(f'maia3-{installer.SOURCE_COMMIT}/maia3/uci.py', 'replacement')])
    with pytest.raises(ValueError, match='Duplicate'):
        installer.extract_source(bundle, tmp_path / 'source')


def test_extract_preserves_source_layout(tmp_path):
    bundle = archive(tmp_path / 'source.zip')
    names = installer.extract_source(bundle, tmp_path / 'source')
    assert 'maia3/uci.py' in names
    assert (tmp_path / 'source' / 'maia3' / 'uci.py').read_text() == 'PINNED = True\n'


@pytest.fixture
def installed(tmp_path, monkeypatch):
    bundle = archive(tmp_path / 'maia3-source.zip')
    monkeypatch.setattr(installer, 'SOURCE_SHA256', installer.digest(bundle))
    installer.extract_source(bundle, tmp_path / 'source')
    monkeypatch.setattr(installer, 'LICENSE_SHA256', installer.digest(tmp_path / 'source' / 'LICENSE'))
    package = tmp_path / 'runtime' / 'site-packages' / 'maia3'
    package.mkdir(parents=True)
    for path in (tmp_path / 'source' / 'maia3').glob('*.py'):
        (package / path.name).write_bytes(path.read_bytes())
    model = tmp_path / 'models' / 'maia3-79m.pt'
    model.parent.mkdir()
    model.write_bytes(b'model')
    known_hash = installer.digest(model)
    monkeypatch.setattr(installer, 'MODELS', {'maia3-79m': {'sha256': known_hash}})
    monkeypatch.setattr(installer, 'runtime_details', lambda root: {'package_dir': str(package)})
    manifest = {
        'engine': 'maia3', 'default_model': 'maia3-79m',
        'python': installer.python_path(tmp_path).relative_to(tmp_path).as_posix(),
        'source': {'commit': installer.SOURCE_COMMIT, 'sha256': installer.SOURCE_SHA256},
        'models': {'maia3-79m': {'path': 'models/maia3-79m.pt', 'sha256': known_hash}},
        'files': {'models/maia3-79m.pt': {'sha256': known_hash}},
    }
    def save():
        (tmp_path / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    save()
    return tmp_path, package, model, manifest, save


def test_verify_checks_source_package_and_checkpoint(installed):
    root, *_ = installed
    assert installer.verify(root) == 1


def test_verify_cannot_hide_corrupt_model_by_omitting_file_manifest(installed):
    root, _, model, manifest, save = installed
    model.write_bytes(b'corrupt')
    manifest['files'] = {}
    save()
    with pytest.raises(ValueError, match='checkpoint'):
        installer.verify(root)


def test_verify_refuses_model_path_outside_root(installed):
    root, _, _, manifest, save = installed
    manifest['models']['maia3-79m']['path'] = '../model.pt'
    save()
    with pytest.raises(ValueError, match='checkpoint'):
        installer.verify(root)


@pytest.mark.parametrize('change', ['modified', 'missing', 'extra'])
def test_verify_rejects_modified_installed_package_even_when_version_unchanged(installed, change):
    root, package, *_ = installed
    if change == 'modified':
        (package / 'uci.py').write_text('MODIFIED = True\n')
    elif change == 'missing':
        (package / 'uci.py').unlink()
    else:
        (package / 'extra.py').write_text('EXTRA = True\n')
    with pytest.raises(ValueError, match='Installed Maia 3'):
        installer.verify(root)


def test_runtime_install_targets_dedicated_environment_and_cpu_index(tmp_path, monkeypatch):
    python = installer.python_path(tmp_path)
    python.parent.mkdir(parents=True)
    python.write_bytes(b'fake')
    calls = []
    monkeypatch.setattr(installer, 'run_python', lambda executable, *args, **kw: calls.append((executable, args)))
    installer.install_runtime(tmp_path)
    assert all(executable == python for executable, args in calls)
    torch_call = next(args for executable, args in calls if f'torch=={installer.TORCH_VERSION}' in args)
    assert torch_call[torch_call.index('--index-url') + 1] == installer.CPU_INDEX
    assert '--no-deps' in torch_call
    assert all('--isolated' in args for executable, args in calls)
