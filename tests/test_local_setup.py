"""Installation checks with no downloads, server launches, or production data."""
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

import pytest

ROOT = Path(__file__).resolve().parents[1]


def load_setup():
    spec = importlib.util.spec_from_file_location('chessgym_setup_test', ROOT / 'scripts' / 'prepare_local.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_import_setup_has_no_side_effects(monkeypatch):
    import urllib.request
    monkeypatch.setattr(subprocess, 'run', lambda *a, **kw: pytest.fail('An import must not install packages'))
    monkeypatch.setattr(urllib.request, 'urlopen', lambda *a, **kw: pytest.fail('An import must not download'))
    load_setup()


@pytest.mark.parametrize('development, filename', [(False, 'requirements.txt'), (True, 'requirements-dev.txt')])
def test_setup_consumes_pins_without_rewriting(tmp_path, monkeypatch, development, filename):
    setup = load_setup()
    original = {
        'requirements.txt': b'Pillow==13.0.0\nzstandard==0.25.0\n',
        'requirements-dev.txt': b'-r requirements.txt\npytest==9.1.1\n',
        'requirements.lock.txt': b'preserve-exact-lock\n',
    }
    for name, content in original.items():
        (tmp_path / name).write_bytes(content)
    calls = []
    monkeypatch.setattr(setup, 'ROOT', tmp_path)
    monkeypatch.setattr(setup.subprocess, 'run', lambda command, **kw: calls.append((command, kw)))
    monkeypatch.setattr(setup, 'prepare_pieces', lambda root: None)
    monkeypatch.setattr(setup, 'prepare_engine', lambda root: None)
    monkeypatch.setenv('TEMP', str(tmp_path))
    monkeypatch.setenv('TMP', str(tmp_path))
    assert setup.main(['--dev'] if development else []) == 0
    assert len(calls) == 1
    assert calls[0][0][-2:] == ['-r', str(tmp_path / filename)]
    assert calls[0][1]['check'] is True
    for name, content in original.items():
        assert (tmp_path / name).read_bytes() == content


@pytest.mark.parametrize('system,machine', [('Linux', 'x86_64'), ('Darwin', 'arm64'), ('Windows', 'ARM64')])
def test_setup_does_not_download_windows_engine_elsewhere(tmp_path, monkeypatch, capsys, system, machine):
    setup = load_setup()
    monkeypatch.setattr(setup.platform, 'system', lambda: system)
    monkeypatch.setattr(setup.platform, 'machine', lambda: machine)
    monkeypatch.setattr(setup, 'download', lambda *a: pytest.fail('Windows archive must not be downloaded'))
    assert setup.prepare_engine(tmp_path) is False
    assert 'CHESSGYM_ENGINE' in capsys.readouterr().out
    assert not (tmp_path / 'engines').exists()


def test_setup_rejects_wrong_archive_before_extraction(tmp_path, monkeypatch):
    setup = load_setup()
    monkeypatch.setattr(setup.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(setup.platform, 'machine', lambda: 'AMD64')
    (tmp_path / '.tmp').mkdir()
    (tmp_path / '.tmp' / 'stockfish-18.zip').write_bytes(b'wrong archive')
    monkeypatch.setattr(setup, 'download', lambda *a: pytest.fail('Existing archive should be checked'))
    with pytest.raises(RuntimeError, match='checksum'):
        setup.prepare_engine(tmp_path)
    assert not (tmp_path / 'engines').exists()


def test_setup_rejects_archive_path_traversal(tmp_path, monkeypatch):
    setup = load_setup()
    monkeypatch.setattr(setup.platform, 'system', lambda: 'Windows')
    monkeypatch.setattr(setup.platform, 'machine', lambda: 'AMD64')
    (tmp_path / '.tmp').mkdir()
    archive = tmp_path / '.tmp' / 'stockfish-18.zip'
    with zipfile.ZipFile(archive, 'w') as bundle:
        bundle.writestr('../outside.txt', 'must not be written')
    with archive.open('rb') as source:
        digest = setup.hashlib.file_digest(source, 'sha256').hexdigest()
    monkeypatch.setattr(setup, 'STOCKFISH_SHA256', digest)
    with pytest.raises(RuntimeError, match='Unsafe archive path'):
        setup.prepare_engine(tmp_path)
    assert not (tmp_path / 'outside.txt').exists()


def powershell_config(tmp_path, *args):
    executable = shutil.which('powershell') or shutil.which('pwsh')
    if not executable:
        pytest.skip('PowerShell is not installed')
    # Evaluate only the parameter/configuration prefix, never the real launcher.
    source = (ROOT / 'Start-ChessGym.ps1').read_text(encoding='utf-8-sig')
    prefix = source.split("$ErrorActionPreference =", 1)[0]
    assert 'Start-Process' not in prefix and 'Invoke-RestMethod' not in prefix
    script = tmp_path / 'launcher-config.ps1'
    script.write_text(prefix + '\n@{workers=$ImportWorkers; cache=$ImportCacheMB; cpu=[Environment]::ProcessorCount} | ConvertTo-Json -Compress\n', encoding='utf-8')
    # Windows PowerShell can emit localized errors in the console code page,
    # even when Python runs in UTF-8 mode. Preserve bytes; json.loads accepts
    # the successful ASCII JSON output without a platform-dependent decoder.
    return subprocess.run([executable, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', str(script), *map(str, args)], capture_output=True, timeout=20,
                          creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))


def test_windows_launcher_defaults_are_bounded(tmp_path):
    result = powershell_config(tmp_path)
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout)
    assert config['workers'] == max(1, min(4, config['cpu']))
    assert config['cache'] == 256


def test_windows_launcher_preserves_explicit_production_budget(tmp_path):
    result = powershell_config(tmp_path, '-ImportWorkers', 12, '-ImportCacheMB', 1024)
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout)
    assert config['workers'] == 12
    assert config['cache'] == 1024


@pytest.mark.parametrize('args', [('-ImportWorkers', -1), ('-ImportWorkers', 17), ('-ImportCacheMB', 63), ('-ImportCacheMB', 4097)])
def test_windows_launcher_rejects_invalid_limits(tmp_path, args):
    assert powershell_config(tmp_path, *args).returncode != 0
