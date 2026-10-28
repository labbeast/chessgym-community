"""Dynamic board menu model, recoverability and presentation safety."""
import subprocess
from pathlib import Path
import pytest
from test_board_interactions import node_binary


@pytest.mark.parametrize('script', ['board_menu.mjs', 'board_recent_position.mjs'])
def test_board_menu(script):
    result = subprocess.run(
        [node_binary(), '--test', str(Path(__file__).with_name(script))],
        capture_output=True, text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr
