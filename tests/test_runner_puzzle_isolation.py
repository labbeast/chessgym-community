"""Validation runners must never seed a puzzle bank inherited from the host."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
CHILD = r'''
import importlib
import json
from pathlib import Path
import sys

root, directory, name = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
sys.path.insert(0, str(root))
runner = importlib.import_module('scripts.' + name)
if name == 'test_learning_changes':
    # Exercise the real environment setup, then write through the same bank
    # API as a test would. Keep this nested runner inside pytest's temporary tree.
    runner.__file__ = str(directory / 'scripts' / 'test_learning_changes.py')
    sys.argv = [runner.__file__]
    import pytest
    def seeded_tests(*args, **kwargs):
        import db
        import puzzle_store
        original_data = db.DATA_DIR
        assert puzzle_store.bank_path() == original_data / 'puzzles' / 'bank.sqlite3'
        # Per-test fixtures change DATA_DIR. The runner must preserve that
        # isolation instead of pinning every test to one shared puzzle bank.
        db.DATA_DIR = directory / 'fixture-data'
        assert db.DATA_DIR != original_data
        assert puzzle_store.bank_path() == db.DATA_DIR / 'puzzles' / 'bank.sqlite3'
        with puzzle_store.bank_connection(write=True) as conn:
            puzzle_store.init_bank(conn)
        return 0
    pytest.main = seeded_tests
    assert runner.main() == 0
else:
    # Run actual fixture seeding without opening a server or browser.
    import uvicorn
    uvicorn.run = lambda *args, **kwargs: None
    runner.serve(str(directory / 'data'), 0)

import db
import puzzle_store
with puzzle_store.bank_connection() as conn:
    count = conn.execute('SELECT count(*) FROM puzzles').fetchone()[0]
print(json.dumps({'bank': str(puzzle_store.bank_path()), 'data': str(db.DATA_DIR), 'count': count}))
'''


@pytest.mark.parametrize('runner,expected_count', [
    ('test_puzzles_browser', 40),
    ('test_training_skills_browser', 4),
    ('test_learning_changes', 0),
])
def test_fixture_bank_is_isolated_from_inherited_configuration(tmp_path, runner, expected_count):
    inherited = tmp_path / 'existing-bank.sqlite3'
    conn = sqlite3.connect(inherited)
    try:
        conn.execute('CREATE TABLE sentinel(value TEXT)')
        conn.execute("INSERT INTO sentinel VALUES('original data')")
        conn.commit()
    finally:
        conn.close()
    original = inherited.read_bytes()
    directory = tmp_path / 'validation'
    result = subprocess.run(
        [sys.executable, '-c', CHILD, str(ROOT), str(directory), runner],
        cwd=ROOT, env={**os.environ, 'CHESSGYM_PUZZLE_BANK': str(inherited)},
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        timeout=30, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
    report = json.loads(result.stdout.splitlines()[-1])
    bank = Path(report['bank']).resolve()
    assert bank == Path(report['data']).resolve() / 'puzzles' / 'bank.sqlite3'
    assert bank.is_relative_to(directory.resolve())
    assert bank.is_file()
    assert report['count'] == expected_count
    assert inherited.read_bytes() == original
