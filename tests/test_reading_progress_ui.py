"""Exercise reading tracking without a browser, real time, or production API."""
import subprocess

import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize('scenario', [
    'toolbar_disposal_restores_workbench_before_failed_action_remount',
    'toolbar_elapsed_survives_heartbeats_and_pause_excludes_all_inactive_time',
    'toolbar_recorded_time_waits_for_receipt_confirmation_and_never_counts_retry_twice',
    'rereading_earlier_move_retains_exact_viewed_path_on_heartbeat',
    'debounce_tracks_last_viewed_position_independently_of_furthest',
    'hidden_and_reopened_reading_uses_distinct_visit_id',
    'account_reset_discards_queued_writes_and_stale_response_updates',
    'default_browser_timers_keep_the_host_receiver',
    'mainline_and_markup_are_escaped_and_explicit',
    'debounce_preserves_furthest_mainline_and_ignores_variations',
    'writes_are_serialized_across_tracker_replacement',
    'manual_rewind_survives_later_heartbeats',
    'active_time_excludes_hidden_blurred_and_idle_periods',
    'disposal_flushes_once_and_removes_every_listener',
    'unknown_response_retry_reuses_receipt_and_never_double_counts',
    'conflict_refresh_preserves_remote_manual_bookmark',
    'failed_navigation_settlement_keeps_payload_until_recovery',
    'failed_payload_survives_tracker_replacement',
    'saved_content_change_discards_old_pending_paths',
    'temporary_moves_and_promotions_never_advance_saved_reading',
    'draft_heartbeats_use_saved_bookmark_and_fen',
    'explicit_save_refreshes_the_readable_source_line',
    'saved_mainline_comparison_stops_at_first_changed_ancestor',
    'move_marker_does_not_modify_content_or_mark_untracked_games',
])
def test_reading_progress_interface(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/reading_progress_ui.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
