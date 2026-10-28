"""Run actual repertoire panel snapshots and handlers with isolated fake HTTP responses."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "gap_below_threshold_opens_with_probability_without_changing_profile",
    "gap_old_empty_report_refreshes_once_and_reuses_saved_threshold",
    "gap_fallback_revalidation_checks_candidate_and_threshold",
    "gap_button_uses_cached_maximum_and_saved_filters_without_mount_scan",
    "gap_missing_or_stale_runs_one_bounded_scan_with_saved_profile",
    "gap_none_offers_coverage_and_explicit_continue",
    "gap_revalidation_rejects_deleted_line_and_changed_filter",
    "gap_fresh_revalidation_accepts_current_result",
    "gap_navigation_and_disposal_ignore_delayed_response",
    "gap_invalid_probabilities_never_open_or_fabricate_pgn",
    "gap_failed_refresh_keeps_analysis_and_can_retry",
    "free_and_saved_snapshot_payloads",
    "compatible_and_transposition_rows_escape_and_gate_addition",
    "no_main_repertoire_and_training_make_no_requests",
    "navigation_debounces_and_aborts_outdated_check",
    "pgn_changes_invalidate_without_path_change",
    "principal_changes_force_new_check",
    "extension_sends_captured_fingerprints_and_prevents_double_submit",
    "stale_click_rechecks_without_extension",
    "navigation_during_add_keeps_original_snapshot_then_refreshes_current",
    "conflict_rechecks_without_repeating_mutation",
    "isolated_position_uses_backend_reason_and_never_fabricates_compatibility",
    "locks_missing_fingerprint_and_disposal_block_mutation",
    "dispose_during_add_does_not_touch_other_screen",
    "load_failure_retry_recovers"
])
def test_repertoire_panel_ui(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/repertoire_panel_ui.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
