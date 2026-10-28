"""Long directory searches expose activity without inventing a percentage."""
import subprocess

from test_board_interactions import ROOT, node_binary


def test_library_directory_search_progress():
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/library_directory_progress.mjs')],
        text=True, encoding='utf-8', capture_output=True, timeout=25,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
