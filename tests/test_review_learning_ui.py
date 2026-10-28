import subprocess
from test_board_interactions import node_binary, ROOT


def test_review_learning_ui():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests/review_learning.mjs')],
        text=True, encoding='utf-8', capture_output=True, timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
