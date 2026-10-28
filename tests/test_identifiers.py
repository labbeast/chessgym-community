"""Shared browser identifiers work with and without secure-context Web Crypto."""
import subprocess

from test_board_interactions import ROOT, node_binary


def test_browser_identifiers():
    result = subprocess.run(
        [node_binary(), '--test', str(ROOT / 'tests/identifiers.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr
