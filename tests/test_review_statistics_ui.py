"""Review dashboards load, filter and display recorded facts without stale updates."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "english_statistics_translate_labels_not_database_names",
    "exclusive_progress_matches_overview_and_does_not_duplicate_mastered",
    "loads_default_period_and_local_timezone",
    "filters_request_scope_and_keep_control_nodes",
    "stale_response_cannot_replace_new_filter",
    "disposed_component_ignores_late_response_and_events",
    "late_failure_cannot_erase_new_success",
    "error_is_escaped_and_retry_loads_data",
    "deleted_saved_base_has_recovery_to_all_bases",
    "values_labels_and_estimates_have_honest_definitions",
    "empty_history_has_no_invented_percent_or_personal_duration",
    "heatmap_has_accessible_day_values_and_roving_focus",
    "history_metric_changes_without_network_and_preserves_options",
    "base_actions_are_scoped_and_disabled_history_is_preserved",
    "base_names_and_server_errors_are_not_html",
    "saved_options_restore_metric_and_invalid_filters_are_normalized",
    "mastered_cards_are_in_learned_without_duplicate_distribution_and_no_review_action",
    "charts_and_durations_are_bounded_and_offer_accessible_values",
])
def test_review_statistics_ui(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/review_statistics.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
