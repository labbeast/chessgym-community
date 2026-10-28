"""Computer view state, lifecycle and source-document isolation without production data."""
import subprocess
from pathlib import Path

import pytest
from test_board_interactions import node_binary

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize('scenario', [
    'statistics_pauses_active_game_without_reset_and_resumes_only_untimed',
    'late_statistics_dialog_is_closed_after_navigation',
    'active_duration_keeps_measuring_after_illegal_input',
    'active_duration_pauses_closes_and_resumes_without_offline_time',
    'untimed_explicit_pause_locks_play_and_survives_reload_until_resume',
    'untimed_explicit_pause_is_not_cleared_by_statistics_or_visibility',
    'untimed_explicit_pause_aborts_pending_engine_and_ignores_late_reply',
    'active_duration_stops_at_game_end_and_restart_begins_at_zero',
    'legacy_games_remain_unmeasured_and_new_games_get_active_duration',
    'active_duration_excludes_hidden_views_and_timed_pauses',
    'active_duration_keeps_elapsed_time_when_a_move_is_taken_back',
    'clocks_exclude_human_validation_latency_and_commit_increment_once',
    'rejected_moves_receive_no_increment_and_resume_the_same_clock',
    'timed_reloads_stay_paused_until_explicit_resume',
    'timed_takeback_restores_per_move_clocks_and_pgn_annotations',
    'pause_aborts_engine_and_ignores_a_reply_after_time_has_stopped',
    'flag_fall_uses_server_result_and_cancels_pending_engine',
    'replacement_archives_before_creating_a_new_identity_and_failure_keeps_game',
    'origin_follows_selected_branch_without_mutating_saved_game',
    'educational_null_moves_start_from_current_diagram_without_masking_broken_history',
    'late_results_cannot_change_disposed_or_restarted_games',
    'newer_request_wins_even_if_an_old_response_arrives_later',
    'takeback_keeps_launch_history_and_removes_human_plus_reply',
    'snapshots_and_analysis_copies_do_not_share_mutable_state',
    'partial_model_installation_keeps_visible_selection_and_request_consistent',
    'maia3_level_range_comes_from_opponent_api',
    'maia3_restores_legacy_games_without_losing_history_or_strength',
    'restoration_revalidates_position_locked_and_resumes_engine_once',
    'navigation_or_availability_failure_during_resume_preserves_game_immediately',
    'restored_resignation_stays_finished_and_does_not_restart_engine',
    'failed_restore_validation_does_not_leave_game_locked',
    'pending_engine_response_is_ignored_after_resignation',
    'computer_first_move_and_completed_positions_do_not_accept_human_moves',
    'pending_human_move_is_durable_before_network_and_replayed_once',
    'restoration_keeps_move_intent_until_confirmation_and_network_failure',
    'rejected_saved_intent_is_cleared_without_engine_request',
    'old_snapshots_acquire_frozen_config_and_preserve_human_side',
    'setup_changes_cannot_change_active_engine_or_resumed_strength',
    'starting_game_freezes_its_own_settings',
    'explicit_cancellation_clears_pending_intent_before_undo_restart_or_resign',
])
def test_computer_play_client(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/computer_play_client.mjs'), scenario],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stdout + result.stderr
