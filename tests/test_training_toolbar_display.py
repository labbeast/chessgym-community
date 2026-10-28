"""Shared header clock presentation; native modules own all measurements."""
import subprocess
from pathlib import Path
from test_board_interactions import node_binary


def test_training_toolbar_display():
    result = subprocess.run(
        [node_binary(), '--test', str(Path(__file__).with_name('training_toolbar_display.mjs'))],
        capture_output=True, text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr
