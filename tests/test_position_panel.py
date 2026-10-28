"""Exercise position lookup panel with controlled responses and source navigation."""
import subprocess

import pytest

from test_board_interactions import ROOT, node_binary


@pytest.mark.parametrize("scenario", [
    "summary_lists_bases_and_exact_counts_before_any_games",
    "base_shows_players_ratings_result_date_and_exact_root_and_variation_links",
    "back_reuses_summary_without_changing_the_board",
    "hidden_panel_does_not_search_and_aborts_on_hide",
    "movement_debounces_resets_selected_base_and_only_latest_response_survives",
    "same_position_clock_changes_reuse_search_refresh_preserves_base_scope",
    "pagination_append_deduplicates_entries_and_retries_in_place",
    "returning_during_base_load_aborts_and_late_results_cannot_replace_next_base",
    "search_errors_retry_and_partial_results_are_honest",
    "partial_bases_show_scope_and_failed_detail_keeps_a_way_back",
    "unsafe_metadata_names_labels_and_errors_are_escaped",
    "exercise_titles_and_single_position_remain_clickable_without_metadata",
    "source_changes_locks_and_stale_clicks_block_navigation",
    "asynchronous_open_guard_survives_quicksave_but_not_navigation_or_hide",
    "failed_open_keeps_results_and_can_be_retried",
    "dispose_cancels_request_and_prevents_late_render_and_navigation",
    "training_or_disposed_board_does_not_fetch",
])
def test_position_panel(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/position_panel.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
