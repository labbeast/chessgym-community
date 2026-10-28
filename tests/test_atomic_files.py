"""Transient Windows sharing locks must not abort a completed preparation step."""
import json
from pathlib import Path

import pytest

import atomic_files
import lumbra_resources
import resource_setup


@pytest.fixture
def clock(monkeypatch):
    current = [0.0]
    delays = []
    monkeypatch.setattr(atomic_files.time, 'monotonic', lambda: current[0])
    def sleep(delay):
        delays.append(delay)
        current[0] += delay
    monkeypatch.setattr(atomic_files.time, 'sleep', sleep)
    return current, delays


def block_replaces(monkeypatch, target, *, failures):
    original = Path.replace
    attempts = []
    def replace(source, destination):
        if Path(destination) == target:
            attempts.append(source)
            if failures is None or len(attempts) <= failures:
                raise PermissionError(13, 'Temporary file sharing lock', str(destination))
        return original(source, destination)
    monkeypatch.setattr(Path, 'replace', replace)
    return attempts


def test_transient_permission_error_retries_same_prepared_file(tmp_path, monkeypatch, clock):
    source, target = tmp_path / 'prepared.tmp', tmp_path / 'state.json'
    source.write_text('new', encoding='utf-8')
    target.write_text('old', encoding='utf-8')
    attempts = block_replaces(monkeypatch, target, failures=1)
    assert atomic_files.replace_with_retry(source, target) == target
    assert attempts == [source, source]
    assert target.read_text(encoding='utf-8') == 'new'
    assert not source.exists()
    assert clock[1] == [.025]


def test_persistent_permission_error_is_bounded_and_preserves_both_files(tmp_path, monkeypatch, clock):
    source, target = tmp_path / 'prepared.tmp', tmp_path / 'state.json'
    source.write_text('new', encoding='utf-8')
    target.write_text('old', encoding='utf-8')
    attempts = block_replaces(monkeypatch, target, failures=None)
    with pytest.raises(PermissionError):
        atomic_files.replace_with_retry(source, target)
    assert 1 < len(attempts) < 20
    assert clock[0][0] == pytest.approx(2.0)
    assert max(clock[1]) <= .25
    assert target.read_text(encoding='utf-8') == 'old'
    assert source.read_text(encoding='utf-8') == 'new'


def test_other_errors_are_not_retried(tmp_path, clock):
    with pytest.raises(FileNotFoundError):
        atomic_files.replace_with_retry(tmp_path / 'absent', tmp_path / 'target')
    assert not clock[1]


@pytest.mark.parametrize('failures', [1, None])
def test_resource_progress_persistence_keeps_previous_json_on_failure(tmp_path, monkeypatch, clock, failures):
    manager = resource_setup.ResourceSetupManager(tmp_path)
    manager._save()
    original = manager.path.read_text(encoding='utf-8')
    manager.state['setup_complete'] = True
    attempts = block_replaces(monkeypatch, manager.path, failures=failures)
    if failures is None:
        with pytest.raises(PermissionError):
            manager._save()
        assert manager.path.read_text(encoding='utf-8') == original
    else:
        manager._save()
        assert json.loads(manager.path.read_text(encoding='utf-8'))['setup_complete']
        assert len(attempts) == 2
    assert not list(tmp_path.glob('resource-setup.json.*.tmp'))


@pytest.mark.parametrize('failures', [1, None])
def test_lumbra_registry_replace_tolerates_sharing_lock(tmp_path, monkeypatch, clock, failures):
    provider = lumbra_resources.LumbraResources(tmp_path)
    provider.root.mkdir(parents=True)
    identity = 'lumbra-otb-elite'
    provider._write_record(identity, {'base_id': 1})
    target = provider.root / 'installed.json'
    attempts = block_replaces(monkeypatch, target, failures=failures)
    if failures is None:
        with pytest.raises(PermissionError):
            provider._write_record(identity, {'base_id': 2})
        assert provider._records()[identity]['base_id'] == 1
    else:
        provider._write_record(identity, {'base_id': 2})
        assert provider._records()[identity]['base_id'] == 2
        assert len(attempts) == 2
    assert not list(provider.root.glob('installed.*.tmp'))
