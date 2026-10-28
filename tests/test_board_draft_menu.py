"""Draft-only context menu interaction, lifetime and keyboard access."""
import subprocess
from pathlib import Path
from test_board_interactions import node_binary


def test_board_draft_menu():
    result = subprocess.run(
        [node_binary(), '--test', str(Path(__file__).with_name('board_draft_menu.mjs'))],
        capture_output=True, text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr
