"""Context menu modes save in place while folder actions remain keyboard-accessible."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize('scenario', [
    'modes_save_without_navigation_and_allow_multiple_changes',
    'failed_save_keeps_state_and_ignores_duplicate_clicks',
    'reference_bases_only_offer_supported_modes',
    'keyboard_includes_mode_checkboxes_and_restores_card',
    'delete_only_for_current_empty_folder_and_keep_original_actions',
    'keyboard_moves_between_menu_actions_and_escape_restores_folder',
    'native_context_menu_and_other_library_targets_remain_untouched',
])
def test_library_menu(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/library_menu.mjs'), scenario],
                            text=True, encoding='utf-8', capture_output=True, timeout=15,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
