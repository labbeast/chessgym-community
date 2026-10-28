"""Privacy-sensitive browser interactions for private device pairing."""
import subprocess

from test_board_interactions import node_binary, ROOT


def test_private_device_pairing_ui():
    result = subprocess.run(
        [node_binary(), '--test', str(ROOT / 'tests/private_access_ui.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr