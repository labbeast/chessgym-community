"""Native launch recovery and program navigation use the actual JS helpers."""
import subprocess
from test_board_interactions import node_binary, ROOT


def test_training_plan_launch_and_navigation():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests/training_plan_launch.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
