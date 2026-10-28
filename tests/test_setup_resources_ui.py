import subprocess

from test_board_interactions import ROOT, node_binary


def test_setup_resources_ui():
    result = subprocess.run(
        [node_binary(), '--test', str(ROOT / 'tests' / 'setup_resources.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
