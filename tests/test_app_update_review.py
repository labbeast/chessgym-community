"""Independent regression checks for user data during an application update."""
from contextlib import nullcontext
import os
from pathlib import Path
import shutil
import subprocess

import pytest

import app_update_worker as worker
import backup_service


def test_missing_rollback_backup_is_rejected_before_changing_code(tmp_path, monkeypatch):
    root, data = tmp_path / 'source', tmp_path / 'data'
    root.mkdir()
    calls = []
    def git(_root, *arguments, **kwargs):
        calls.append(arguments)
        return 'b' * 40 if arguments == ('rev-parse', 'HEAD') else ''
    monkeypatch.setattr(worker, 'git', git)
    monkeypatch.setattr(backup_service, 'offline_guard', nullcontext)
    plan = {'id': 'a' * 32, 'commit': 'b' * 40, 'previous_commit': 'c' * 40,
            'database_backup': str(data / 'app-updates' / 'backups' / ('a' * 32) / 'chessgym.sqlite3'),
            'previous_runtime': None}
    with pytest.raises(ValueError):
        worker.rollback(root, data, plan)
    assert not any(arguments[0] == 'reset' for arguments in calls)


def test_prepare_protects_custom_data_directory_inside_checkout(tmp_path, monkeypatch):
    root = tmp_path / 'source'
    root.mkdir()
    data = root / 'personal'
    data.mkdir()
    monkeypatch.setattr(worker, 'require_installation', lambda *args: 'a' * 40)
    monkeypatch.setattr(worker, '_origin', lambda root: worker.REPOSITORY)
    calls = []
    def git(_root, *arguments, **kwargs):
        calls.append(arguments)
        if arguments[0] == 'rev-parse':
            return 'b' * 40
        if arguments[0] == 'diff':
            return 'personal/chessgym.sqlite3'
        if arguments[0] == 'archive':
            pytest.fail('An update touching the configured data directory reached archive preparation')
        return ''
    monkeypatch.setattr(worker, 'git', git)
    with pytest.raises(ValueError):
        worker.prepare(root, data, {'tag': 'v1.0.0', 'version': '1.0.0', 'object_id': 'b' * 40}, lambda *args: None)
    assert not any(arguments[0] == 'archive' for arguments in calls)


def test_real_fast_forward_refuses_to_overwrite_an_ignored_personal_file(tmp_path, monkeypatch):
    """All Git mutations happen in this newly-created test repository."""
    executable = shutil.which('git')
    if not executable:
        pytest.skip('Git is required for the isolated update collision fixture')
    root, data = tmp_path / 'source', tmp_path / 'data'
    root.mkdir()
    environment = dict(os.environ, GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_SYSTEM=os.devnull)
    def git(*arguments):
        return subprocess.run([executable, '-c', 'core.hooksPath=' + os.devnull, *arguments], cwd=root,
                              env=environment, capture_output=True, text=True, encoding='utf-8', check=True,
                              creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0)).stdout.strip()
    git('init')
    git('config', 'user.name', 'ChessGym isolated test')
    git('config', 'user.email', 'fixture@example.invalid')
    git('remote', 'add', 'origin', worker.REPOSITORY)
    (root / '.gitignore').write_text('notes.pgn\n', encoding='utf-8')
    (root / 'application.txt').write_text('old', encoding='utf-8')
    git('add', '.gitignore', 'application.txt')
    git('commit', '-m', 'Old fixture release')
    previous = git('rev-parse', 'HEAD')
    (root / 'notes.pgn').write_text('release example', encoding='utf-8')
    (root / 'application.txt').write_text('new', encoding='utf-8')
    git('add', '-f', 'notes.pgn', 'application.txt')
    git('commit', '-m', 'New fixture release')
    commit = git('rev-parse', 'HEAD')
    git('checkout', '-b', 'installed', previous)
    (root / 'notes.pgn').write_text('personal annotations', encoding='utf-8')
    identity = 'e' * 32
    interpreter = worker.python_path(data / 'app-updates' / 'runtimes' / identity)
    interpreter.parent.mkdir(parents=True)
    interpreter.write_bytes(b'test-only placeholder; never executed')
    plan = {'id': identity, 'commit': commit, 'previous_commit': previous, 'version': '1.0.0',
            'python': str(interpreter), 'phase': 'prepared'}
    worker.write_json(data / 'app-updates' / 'pending.json', plan)
    monkeypatch.setattr(backup_service, 'offline_guard', nullcontext)
    with pytest.raises((ValueError, RuntimeError)):
        worker.apply_pending(root, data)
    assert git('rev-parse', 'HEAD') == previous
    assert (root / 'application.txt').read_text(encoding='utf-8') == 'old'
    assert (root / 'notes.pgn').read_text(encoding='utf-8') == 'personal annotations'


def test_failed_rollback_retains_recovery_journal_and_prevents_blind_restart(tmp_path, monkeypatch):
    root, data = tmp_path / 'source', tmp_path / 'data'
    root.mkdir()
    monkeypatch.setenv('CHESSGYM_DATA_DIR', str(data))
    plan = {'id': 'c' * 32, 'version': '1.0.0', 'phase': 'applied', 'database_backup': 'retained-backup'}
    pending = data / 'app-updates' / 'pending.json'
    worker.write_json(pending, plan)
    worker.write_json(data / 'app-updates' / 'settings.json', {'schema': 1, 'restart_required': True,
                                                             'settings': {'automatic_updates': False, 'interval_hours': 168}})
    monkeypatch.setattr(worker, 'apply_pending', lambda *args: plan)
    monkeypatch.setattr(worker, 'selected_python', lambda *args: 'test-interpreter')
    launched = []
    monkeypatch.setattr(worker.subprocess, 'Popen', lambda *args, **kwargs: launched.append(args) or object())
    monkeypatch.setattr(worker, '_wait_healthy', lambda *args: False)
    monkeypatch.setattr(worker, 'stop_child', lambda child: None)
    def failed_rollback(*args):
        raise ValueError('The backup needs manual repair')
    monkeypatch.setattr(worker, 'rollback', failed_rollback)
    assert worker.supervise(root) == 1
    assert len(launched) == 1
    assert worker.read_json(pending) == plan
    state = worker.read_json(data / 'app-updates' / 'settings.json')
    assert state['recovery_required'] is True
    assert state['job']['state'] == 'failed'
    assert worker.supervise(root) == 1
    assert len(launched) == 1, 'A mixed source/database state must not be launched again'
