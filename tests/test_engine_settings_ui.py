"""Persistent Stockfish limits and the compact settings dialog, without a browser."""
import subprocess
import pytest
from test_board_interactions import ROOT, node_binary

@pytest.mark.parametrize('scenario', [
    'lazy_loading_is_shared_and_persisted_settings_control_search',
    'time_dialog_saves_bounds_and_reopens_saved_values',
    'infinite_mode_has_no_search_limit_and_preserves_other_choices',
    'depth_dialog_has_no_implicit_time_limit',
    'invalid_active_values_never_reach_server_and_hidden_values_keep_previous',
    'failed_load_retries_and_failed_save_leaves_current_settings',
    'stale_dialogs_neither_open_nor_submit_and_closed_save_does_not_restart',
    'closed_dialog_saves_are_serialized_and_latest_choice_wins_on_server',
    'failed_first_save_allows_queued_save_and_stale_initial_load_is_ignored',
    'late_initial_load_after_failed_then_successful_queue_keeps_latest_choice',
    'new_load_waits_for_pending_saves_instead_of_reading_older_server_state',
    'late_load_cannot_overwrite_newly_saved_settings',
])
def test_engine_settings_ui(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/engine_settings_ui.mjs'), scenario],
                            capture_output=True, text=True, encoding='utf-8', timeout=15,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
