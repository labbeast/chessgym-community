import subprocess
from pathlib import Path

from test_board_interactions import node_binary


def test_analysis_time_ui():
    root = Path(__file__).resolve().parents[1]
    subprocess.run([node_binary(), '--test', str(root / 'tests' / 'analysis_time.mjs')], cwd=root, check=True)
