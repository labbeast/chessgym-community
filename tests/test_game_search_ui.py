"""Advanced search and linked directories preserve pagination and navigation."""
import subprocess
from test_board_interactions import node_binary, ROOT


def test_game_search_ui():
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/game_search_ui.mjs")],
        text=True, encoding="utf-8", capture_output=True, timeout=25,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
