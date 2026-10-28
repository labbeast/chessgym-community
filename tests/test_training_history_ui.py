"""Shared training history presentation and async request safety."""
import subprocess
from pathlib import Path
from test_board_interactions import node_binary


def test_training_history_ui():
    result = subprocess.run(
        [node_binary(), "--test", str(Path(__file__).with_name("training_history_ui.mjs"))],
        capture_output=True, text=True, encoding="utf-8", timeout=30,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr
