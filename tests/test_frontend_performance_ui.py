import subprocess
from test_board_interactions import node_binary, ROOT

def test_frontend_performance_and_pagination():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests/frontend_performance.mjs')], capture_output=True, text=True, encoding='utf-8', timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
