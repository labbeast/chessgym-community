import subprocess
from test_board_interactions import node_binary, ROOT

def test_workspace_state():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests' / 'workspace_state.mjs')], capture_output=True, text=True, encoding='utf-8', timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
