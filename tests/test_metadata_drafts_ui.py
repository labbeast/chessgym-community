import subprocess
from test_board_interactions import node_binary, ROOT


def test_metadata_draft_and_explicit_library_save():
    result = subprocess.run([node_binary(), '--test', str(ROOT / 'tests/metadata_drafts.mjs')],
                            capture_output=True, text=True, encoding='utf-8', timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
