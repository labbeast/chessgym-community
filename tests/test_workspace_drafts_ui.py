import subprocess
from test_board_interactions import node_binary, ROOT

def test_workspace_drafts_ui():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests' / 'workspace_drafts.mjs')], capture_output=True, text=True, encoding='utf-8', timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
