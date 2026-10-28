"""Probability UI behavior with isolated requests and branch fixtures."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', ["local_filter_key_is_normalized_and_comparison_filters_do_not_change_probability","local_filter_changes_cancel_stale_probability_and_start_new_request","branch_path_is_current_variation_and_settings_key_is_relevant","malformed_history_is_unknown_not_one_hundred_percent","numeric_display_handles_zero_unknown_and_rare_rates","debounce_sends_only_latest_branch_and_preserves_own_moves","same_fen_different_branch_rejects_late_result","changing_side_filters_or_visibility_cancels_and_never_accepts_late","cache_is_bounded_uses_complete_results_and_honors_refresh","unavailable_malformed_and_hidden_do_not_fabricate_probability"])
def test_explorer_probability_ui(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/explorer_probability_ui.mjs'), scenario], text=True, encoding='utf-8', capture_output=True, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
