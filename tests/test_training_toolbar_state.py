"""Native clocks and programme budgets retain their original timing semantics."""
import subprocess
from test_board_interactions import node_binary, ROOT


def test_training_toolbar_state():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests/training_toolbar_state.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
