"""Exercise paginated reference library UI without touching live data."""
import subprocess
from test_board_interactions import node_binary, ROOT


def test_reference_library_controller():
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/reference_library.mjs')],
        text=True, encoding='utf-8', capture_output=True, timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
