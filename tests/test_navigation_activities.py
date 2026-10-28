"""Check unfinished-activity navigation signals without changing user data."""
import subprocess

from test_board_interactions import ROOT, node_binary


def test_navigation_activity_states_and_accessibility():
    result = subprocess.run(
        [node_binary(), '--test', str(ROOT / 'tests/navigation_activities.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
