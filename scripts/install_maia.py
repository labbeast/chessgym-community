"""Install pinned official Maia 3 in its own CPU-only Python environment.

python scripts/install_maia.py                 # recommended 79M model
python scripts/install_maia.py --model 5m      # lightweight server option
python scripts/install_maia.py --with-small    # also retain the 5M alternative
python scripts/install_maia.py --verify

No ChessGym database or application dependency is modified. Old Maia 1 files
are retained. Network access is needed for installation only, never for play.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile
import urllib.request
import venv
import zipfile

DEFAULT_ROOT = Path(__file__).resolve().parents[1] / 'engines' / 'maia3'
SOURCE_COMMIT = '1e13597c42d4858b7cfd7cfdae01e297263364b2'
SOURCE_URL = f'https://codeload.github.com/CSSLab/maia3/zip/{SOURCE_COMMIT}'
SOURCE_SHA256 = 'f5210ea0481aba514d58524f50283496b13e219a715143f97d2d0a62b5e9e3ce'
LICENSE_SHA256 = '8486a10c4393cee1c25392769ddd3b2d6c242d6ec7928e1414efff7dfb2f07ef'
TORCH_VERSION = '2.8.0'
CPU_INDEX = 'https://download.pytorch.org/whl/cpu'
PYPI_INDEX = 'https://pypi.org/simple'
MODELS = {
    'maia3-79m': {
        'repo': 'UofTCSSLab/Maia3-79M',
        'revision': 'a107d6ceb7b298cb04ae1da4edffe2939858b894',
        'sha256': '3fc6181d5db789b45a15305732148757ae74efa3e0028e81ba335b462dac45c2',
        'readme_sha256': '291af86f49337a07933e821884450eed3fde9eea28de3e3c111e5595ae7efcad',
        'bytes': 315651851,
        'license': 'AGPL-3.0 (explicitly stated in the pinned model card)',
    },
    'maia3-5m': {
        'repo': 'UofTCSSLab/Maia3-5M',
        'revision': 'b6559de2398d7140b985f28fd2c19fb5e47ddabe',
        'sha256': 'ba14208b2992d85502f5fb501934abf6aaaeb355e9f3fdf90e326911f562524f',
        'readme_sha256': 'cccd335e2d93d50900aff29608b68a16e095827951192753f0640da9ed604e7e',
        'bytes': 20968049,
        'license': 'Model card refers to source repository for weights licensing; CC BY 4.0 applies to the paper only.',
    },
}
# Explicit transitive pins avoid changing the runtime through future resolution.
DEPENDENCIES = (
    'certifi==2026.10.23', 'charset-normalizer==3.5.2', 'chess==1.11.2',
    'colorama==0.4.6', 'filelock==3.32.3', 'fsspec==2026.7.0',
    'huggingface-hub==0.34.4', 'idna==3.20', 'Jinja2==3.1.6',
    'MarkupSafe==3.0.3', 'mpmath==1.3.0', 'networkx==3.6.1',
    'numpy==2.2.6', 'packaging==26.3', 'python-chess==1.999',
    'PyYAML==6.0.3', 'requests==2.34.2', 'setuptools==80.9.0',
    'sympy==1.14.0', 'tqdm==4.70.1', 'typing_extensions==4.16.0',
    'urllib3==2.8.0', 'wheel==0.45.1',
)


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def download(url, target, expected, *, max_bytes):
    """Replace atomically only after bounded HTTPS download and hash validation."""
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and digest(target) == expected:
        return
    request = urllib.request.Request(url, headers={'User-Agent': 'ChessGym-Maia3-installer/1.0'})
    temporary = None
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            if not response.url.startswith('https://'):
                raise ValueError('Unencrypted download redirect')
            with tempfile.NamedTemporaryFile(dir=target.parent, suffix='.part', delete=False) as stream:
                temporary = Path(stream.name)
                total = 0
                while block := response.read(1024 * 1024):
                    total += len(block)
                    if total > max_bytes:
                        raise ValueError('Download exceeds expected size')
                    stream.write(block)
        if digest(temporary) != expected:
            raise ValueError(f'SHA-256 mismatch: {target.name}')
        temporary.replace(target)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def extract_source(archive, destination):
    """Validate all entries before extracting the pinned source tree."""
    destination = Path(destination).resolve()
    with zipfile.ZipFile(archive) as bundle:
        found = {}
        total = 0
        for item in bundle.infolist():
            path = PurePosixPath(item.filename)
            original = item.orig_filename
            if (path.is_absolute() or '\\' in original or ':' in original
                    or any(part in ('.', '..') for part in path.parts)
                    or not path.parts or path.parts[0] != f'maia3-{SOURCE_COMMIT}'
                    or stat.S_ISLNK(item.external_attr >> 16)
                    or item.file_size > 10 * 1024 * 1024):
                raise ValueError('Unsafe source archive entry')
            if item.is_dir():
                continue
            relative = Path(*path.parts[1:])
            if not relative.parts or relative.as_posix() in found:
                raise ValueError('Duplicate or invalid source archive entry')
            target = (destination / relative).resolve()
            if not target.is_relative_to(destination):
                raise ValueError('Source destination leaves installation directory')
            total += item.file_size
            if total > 50 * 1024 * 1024:
                raise ValueError('Source archive exceeds expected size')
            found[relative.as_posix()] = (item, target)
        if not {'LICENSE', 'pyproject.toml', 'maia3/uci.py'}.issubset(found):
            raise ValueError('Incomplete Maia 3 source archive')
        for item, target in found.values():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(bundle.read(item))
    return list(found)


def python_path(root):
    # Do not resolve the executable symlink: Linux venv/bin/python must retain
    # its venv location or Python may fall back to the system's site-packages.
    return Path(root) / 'runtime' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def runtime_environment():
    env = os.environ.copy()
    env.update({'OMP_NUM_THREADS': '1', 'MKL_NUM_THREADS': '1',
                'OPENBLAS_NUM_THREADS': '1', 'NUMEXPR_NUM_THREADS': '1',
                'PYTHONNOUSERSITE': '1', 'HF_HUB_OFFLINE': '1',
                'HF_HUB_DISABLE_TELEMETRY': '1'})
    return env


def run_python(python, *args, capture=False):
    return subprocess.run([str(python), '-I', *map(str, args)], check=True,
                          capture_output=capture, text=True, encoding='utf-8',
                          env=runtime_environment(), timeout=1200)


def install_runtime(root):
    if sys.version_info < (3, 12):
        raise ValueError('Use Python 3.12 or newer for the pinned Maia 3 runtime.')
    python = python_path(root)
    if not python.is_file():
        venv.EnvBuilder(with_pip=True).create(root / 'runtime')
    # Explicit indexes and isolated pip do not inherit an unrelated private
    # package index. Only the PyTorch CPU index supplies torch.
    run_python(python, '-m', 'pip', '--isolated', 'install', '--no-deps',
               '--index-url', PYPI_INDEX, '--report', root / 'deps-install.json', *DEPENDENCIES)
    run_python(python, '-m', 'pip', '--isolated', 'install', '--no-deps',
               '--index-url', CPU_INDEX, '--report', root / 'torch-install.json',
               f'torch=={TORCH_VERSION}')
    run_python(python, '-m', 'pip', '--isolated', 'install', '--no-deps',
               '--no-build-isolation', '--report', root / 'source-install.json', root / 'source')
    run_python(python, '-m', 'pip', '--isolated', 'check')


def runtime_details(root):
    """Inspect the isolated runtime without importing torch into ChessGym."""
    code = """import json, sys, importlib.metadata as m, pathlib, torch, maia3
print(json.dumps({'python':sys.version.split()[0], 'torch':torch.__version__,
 'cuda':torch.version.cuda, 'threads':torch.get_num_threads(),
 'package_dir':str(pathlib.Path(maia3.__file__).parent),
 'packages':{d.metadata['Name']:d.version for d in m.distributions()}}))"""
    details = json.loads(run_python(python_path(root), '-c', code, capture=True).stdout)
    if details['cuda'] is not None or details['torch'].split('+')[0] != TORCH_VERSION:
        raise ValueError('Maia 3 must use the pinned CPU-only torch runtime')
    installed = {name.lower().replace('_', '-'): version for name, version in details['packages'].items()}
    for pin in DEPENDENCIES:
        name, expected = pin.split('==')
        if installed.get(name.lower().replace('_', '-')) != expected:
            raise ValueError(f'Unexpected Maia 3 dependency version: {name}')
    if installed.get('maia3') != '0.1.0' or details['threads'] != 1:
        raise ValueError('Unexpected Maia 3 package or CPU thread configuration')
    return details


def model_name(value):
    value = value.lower()
    name = value if value.startswith('maia3-') else 'maia3-' + value
    if name not in MODELS:
        raise ValueError('Supported models: 79m, 5m')
    return name


def file_record(root, path, source):
    return {'path': path.relative_to(root).as_posix(), 'source': source,
            'sha256': digest(path), 'bytes': path.stat().st_size}


def verify_package(root, package_dir):
    """Installed Python must match the pinned archive, not merely its version."""
    root, package_dir = Path(root).resolve(), Path(package_dir).resolve()
    if not package_dir.is_relative_to(root / 'runtime'):
        raise ValueError('Maia 3 was not installed inside its isolated runtime')
    archive = root / 'maia3-source.zip'
    if digest(archive) != SOURCE_SHA256:
        raise ValueError('Unexpected Maia 3 source archive hash')
    prefix = f'maia3-{SOURCE_COMMIT}/maia3/'
    with zipfile.ZipFile(archive) as bundle:
        expected = {name.removeprefix(prefix): hashlib.sha256(bundle.read(name)).hexdigest()
                    for name in bundle.namelist() if name.startswith(prefix) and name.endswith('.py')}
    actual = {path.relative_to(package_dir).as_posix(): path for path in package_dir.rglob('*.py')}
    if not expected or actual.keys() != expected.keys():
        raise ValueError('Installed Maia 3 Python files differ from pinned source')
    for name, path in actual.items():
        if not path.resolve().is_relative_to(package_dir) or digest(path) != expected[name]:
            raise ValueError(f'Installed Maia 3 source verification failed: {name}')


def install(root=DEFAULT_ROOT, *, model='79m', with_small=False, models_only=False):
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    selected = model_name(model)
    archive = root / 'maia3-source.zip'
    download(SOURCE_URL, archive, SOURCE_SHA256, max_bytes=5 * 1024 * 1024)
    source_files = extract_source(archive, root / 'source')
    if digest(root / 'source' / 'LICENSE') != LICENSE_SHA256:
        raise ValueError('Maia 3 source license verification failed')
    files = {'maia3-source.zip': file_record(root, archive, SOURCE_URL)}
    for name in source_files:
        path = root / 'source' / name
        files[path.relative_to(root).as_posix()] = file_record(root, path, SOURCE_URL)
    models = {}
    requested = {selected}
    if with_small:
        requested.add('maia3-5m')
    # Retain already verified alternative weights and all old Maia 1 files.
    for alias, info in MODELS.items():
        path = root / 'models' / f'{alias}.pt'
        if path.is_file() and digest(path) == info['sha256']:
            requested.add(alias)
    for alias in sorted(requested):
        info = MODELS[alias]
        base = f"https://huggingface.co/{info['repo']}/resolve/{info['revision']}/"
        path = root / 'models' / f'{alias}.pt'
        url = base + path.name
        download(url, path, info['sha256'], max_bytes=info['bytes'])
        readme = root / 'models' / f'{alias}-README.md'
        download(base + 'README.md', readme, info['readme_sha256'], max_bytes=1024 * 1024)
        models[alias] = {**info, **file_record(root, path, url),
                         'readme': readme.relative_to(root).as_posix(),
                         'hash_source': f"https://huggingface.co/api/models/{info['repo']}?blobs=true"}
        files[path.relative_to(root).as_posix()] = file_record(root, path, url)
        files[readme.relative_to(root).as_posix()] = file_record(root, readme, base + 'README.md')
    if not models_only:
        install_runtime(root)
    details = runtime_details(root)
    package_dir = Path(details.pop('package_dir')).resolve()
    verify_package(root, package_dir)
    for path in package_dir.rglob('*.py'):
        files[path.relative_to(root).as_posix()] = file_record(root, path, SOURCE_URL)
    manifest = {
        'engine': 'maia3', 'version': 1, 'default_model': selected,
        'installed_at': datetime.now(timezone.utc).isoformat(),
        'python': python_path(root).relative_to(root).as_posix(),
        'source': {'repository': 'https://github.com/CSSLab/maia3',
                   'commit': SOURCE_COMMIT, 'url': SOURCE_URL, 'sha256': SOURCE_SHA256,
                   'license': 'AGPL-3.0', 'license_file': 'source/LICENSE'},
        'models': models, 'runtime': details,
        'inference': {'device': 'cpu', 'threads': 1, 'history': True,
                      'temperature': 1, 'top_p': 1, 'multipv': 1,
                      'local_files_only': True, 'trusted_pickle': False},
        'notes': 'Ratings condition human move predictions; they are not guaranteed engine Elo. No automatic downloads during play.',
        'files': files,
    }
    temporary = root / 'manifest.json.part'
    temporary.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    temporary.replace(root / 'manifest.json')
    return manifest


def verify(root=DEFAULT_ROOT):
    root = Path(root).resolve()
    manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('engine') != 'maia3' or manifest.get('default_model') not in manifest.get('models', {}):
        raise ValueError('Invalid Maia 3 installation manifest')
    if (manifest.get('source', {}).get('commit') != SOURCE_COMMIT
            or manifest.get('source', {}).get('sha256') != SOURCE_SHA256
            or manifest.get('python') != python_path(root).relative_to(root).as_posix()):
        raise ValueError('Unexpected Maia 3 source revision')
    if digest(root / 'maia3-source.zip') != SOURCE_SHA256 or digest(root / 'source' / 'LICENSE') != LICENSE_SHA256:
        raise ValueError('Maia 3 pinned source verification failed')
    for name, info in manifest['files'].items():
        target = (root / name).resolve()
        if not target.is_relative_to(root) or not target.is_file() or digest(target) != info['sha256']:
            raise ValueError(f'Installed file verification failed: {name}')
    for alias, info in manifest['models'].items():
        expected_path = f'models/{alias}.pt'
        if (alias not in MODELS or info.get('sha256') != MODELS[alias]['sha256']
                or info.get('path') != expected_path
                or not (root / expected_path).is_file()
                or digest(root / expected_path) != MODELS[alias]['sha256']):
            raise ValueError('Unexpected Maia 3 checkpoint hash')
    details = runtime_details(root)
    verify_package(root, details['package_dir'])
    return len(manifest['files'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--model', choices=('79m', '5m', 'maia3-79m', 'maia3-5m'), default='79m')
    parser.add_argument('--with-small', action='store_true', help='Also install the lightweight 5M model')
    parser.add_argument('--models-only', action='store_true', help='Reuse an installed, verified isolated runtime')
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    if not args.verify:
        install(args.root, model=args.model, with_small=args.with_small, models_only=args.models_only)
    print(f'Maia 3: {verify(args.root)} files verified in {args.root.resolve()}')


if __name__ == '__main__':
    main()

