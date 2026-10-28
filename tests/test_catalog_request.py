import subprocess

from test_board_interactions import ROOT, node_binary


def test_catalog_request():
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/catalog_request.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
