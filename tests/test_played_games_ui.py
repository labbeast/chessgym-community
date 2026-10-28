"""Exercise synchronization and game-analysis UI handlers with isolated fake requests."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "report_progress_restores_hints_solution_and_explicit_reset",
    "report_progress_pending_errors_and_conflicts_are_visible",
    "report_progress_retry_hint_is_immediately_retained",
    "unknown_identity_becomes_personal_without_overriding_choice",
    "personal_side_filters_findings_and_summary_by_default",
    "personal_default_tracks_identity_until_manual_filter_chosen",
    "unknown_side_stays_explicit_and_can_be_selected",
    "accepted_reports_notify_charts_and_pgn_edits_clear_them",
    "renderers_escape_untrusted_and_white_scores",
    "sync_initial_no_automatic_mutation_or_refresh",
    "sync_partial_warning_clears_after_complete_sync",
    "sync_auto_polls_only_visible_and_does_not_run",
    "sync_late_response_and_disposal",
    "sync_duplicate_run_and_completed_refresh_once",
    "sync_error_stops_polling_and_recovers",
    "account_new_base_saved_once_and_public_fields_only",
    "account_validation_before_any_mutation",
    "closed_account_form_does_not_mutate_or_close_replacement",
    "job_cancel_deduplicated_and_retry_route",
    "analysis_findings_go_before_move_and_busy_guard",
    "analysis_navigation_no_refetch_but_edit_invalidates",
    "analysis_no_duplicate_queue_and_progress",
    "analysis_late_response_cannot_replace_new_document",
    "analysis_settings_validate_and_survive_poll",
    "exercise_opens_manual_editor_without_changing_source",
    "exercise_rejects_stale_or_busy_source",
    "incomplete_report_and_cancellation_are_explicit",
    "waiting_queue_compact_results_and_open_game",
    "exercise_custom_fen_and_review_base_keep_manual_start",
    "sync_completion_preserves_other_open_editor",
    "long_queue_uses_total_and_keeps_current_job_visible",
    "completed_sync_timestamp_refreshes_when_job_is_not_listed",
    "filters_are_display_only_and_do_not_queue"
    ,"report_hides_solution_until_requested_and_prioritizes_own_moments"
    ,"report_session_outcomes_and_owned_lock_keep_drafts_untouched"
    ,"report_failed_session_releases_controls"
    ,"report_pgn_reload_clears_review_state_for_changed_fingerprint"
    ,"report_pgn_reload_preserves_review_state_for_same_fingerprint"
    ,"report_verify_can_clear_a_false_positive_without_rewriting_pgn"
    ,"report_manual_exercise_keeps_source_link_and_existing_opens"
    ,"report_repertoire_precedes_engine_and_ignores_old_color_results"
    ,"report_repertoire_secondary_does_not_open_primary_tools"
    ,"report_blocks_changed_mainline_but_allows_unsaved_notes"
    ,"report_localization_and_html_are_safe"
])
def test_played_games_ui(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/played_games_ui.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
