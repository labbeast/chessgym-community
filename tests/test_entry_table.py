"""Batch table interactions preserve selection and require concrete mutation choices."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "new_badge_tracks_server_status_without_changing_selection_or_review_inclusion",
    "numeric_sort_unknown_last_and_stable",
    "dates_added_updated_and_unknowns",
    "bases_open_ascending_and_new_sort_columns_start_ascending",
    "search_is_accent_insensitive_multi_field_and_combined_with_inclusion",
    "selection_is_distinct_from_review_and_header_is_tristate",
    "select_all_affects_filtered_rows_and_exposes_hidden_selection",
    "sorting_keeps_selection_and_update_prunes_deleted_ids",
    "delete_requires_concrete_confirmation_and_cancel_does_nothing",
    "delete_confirmed_is_atomic_payload_and_prunes_rows",
    "destinations_move_excludes_source_duplicate_includes_it",
    "batch_review_changes_all_selected_including_hidden_without_changing_selection",
    "individual_review_is_independent_of_bulk_selection",
    "failed_request_keeps_selection_rows_and_can_retry",
    "busy_prevents_duplicate_submission",
    "busy_remains_locked_until_owner_finishes_refreshing",
    "disposed_after_request_notifies_owner_without_touching_old_dom",
    "dispose_closes_owned_dialog_and_prevents_pending_confirm",
    "row_actions_scope_one_entry_and_escape_metadata",
    "batch_start_invalidates_pending_navigation_before_request_and_only_once",
    "batch_metadata_five_games_changes_event_only_and_preserves_selection",
    "batch_metadata_cancel_or_empty_patch_makes_no_request",
    "batch_metadata_error_keeps_rows_selection_and_unlocks_dialog",
    "batch_metadata_late_success_notifies_owner_without_rendering",
    "no_other_base_does_not_offer_a_move_to_itself"
])
def test_entry_table(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/entry_table.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
