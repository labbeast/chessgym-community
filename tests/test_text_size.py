"""Verify text-size persistence UI behavior, including failed and stale saves."""
import subprocess
from test_board_interactions import node_binary, ROOT


def test_text_size():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests/text_size.mjs')],
                            text=True, encoding='utf-8', capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
