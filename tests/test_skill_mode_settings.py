import subprocess

from test_board_interactions import node_binary, ROOT


def test_skill_mode_settings():
    result = subprocess.run(
        [node_binary(), '--test', str(ROOT / 'tests/skill_mode_settings.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=30,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr
