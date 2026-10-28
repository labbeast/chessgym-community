"""Verify base-logo selection and asynchronous uploads without browser automation."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', [
    'untouched_image_is_preserved',
    'upload_is_not_saved_until_ready',
    'invalid_file_preserves_selection',
    'stale_read_does_not_replace_new_choice',
    'error_unlocks_retry_and_newest_upload_wins',
    'logo_sources_are_local_and_unknown_icons_fall_back',
])
def test_base_appearance(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/base_appearance.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
