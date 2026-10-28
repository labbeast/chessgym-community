"""Reference game selection and confirmed actions without touching live data."""
import subprocess
from test_board_interactions import node_binary, ROOT


def test_reference_selection_and_actions():
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/reference_selection.mjs')],
        text=True, encoding='utf-8', capture_output=True, timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
