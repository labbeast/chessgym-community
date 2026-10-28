import subprocess

from test_board_interactions import ROOT, node_binary


def test_engine_manager():
    result = subprocess.run(
        [node_binary(), '--test', str(ROOT / 'tests' / 'engine_manager.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
