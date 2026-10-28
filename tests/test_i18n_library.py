import subprocess
from test_board_interactions import node_binary, ROOT


def test_library_english_preserves_user_data_and_switches_at_render_time():
    result = subprocess.run([node_binary(), str(ROOT / 'tests/i18n_library.mjs')], capture_output=True,
                            text=True, encoding='utf-8', timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
