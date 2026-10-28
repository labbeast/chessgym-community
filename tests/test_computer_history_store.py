"""Durable computer-game journal outbox and account-safe replay."""
import subprocess
from pathlib import Path
import pytest
from test_board_interactions import node_binary
ROOT = Path(__file__).resolve().parents[1]
@pytest.mark.parametrize('scenario', [
    'untimed_pause_and_resume_are_persisted_without_a_move_or_duration_change',
    'same_untimed_position_retains_explicit_pause_from_either_device',
    'active_duration_ticks_are_persisted_and_cross_device_resume_keeps_the_larger_measurement',
    'newer_remote_game_never_discards_already_measured_active_time',
    'same_history_clock_merge_never_returns_time_and_reconciles_takeback_checkpoints',
    'different_clock_settings_or_engine_config_refuse_automatic_merging',
    'terminal_remote_prefix_cannot_be_overwritten_by_longer_local_history',
    'prepare_absent_game_seeds_revision_zero_without_overwriting_local',
    'prepare_same_or_older_server_history_adopts_revision_and_keeps_local',
    'prepare_newer_server_continuation_restores_it_without_mutating_either_copy',
    'prepare_divergent_histories_preserves_local_and_refuses_any_write',
    'prepare_terminal_server_result_is_not_reopened_with_identical_moves',
    'prepare_known_records_skip_fetch_and_late_responses_cannot_cross_accounts',
    'adopt_cannot_discard_pending_or_conflicted_local_games',
    'targeted_archive_rearms_other_games_without_retrying_failures_forever',
    'insecure_lan_context_still_generates_valid_idempotency_ids',
    'unsent_games_survive_close_and_new_games_without_unconfirmed_intent',
    'lost_response_retries_the_same_immutable_mutation_before_newer_position',
    'in_flight_mutation_is_recovered_after_a_closed_browser',
    'compare_and_swap_conflicts_keep_local_game_and_block_replacement',
    'accounts_and_restore_namespaces_do_not_share_outboxes_or_late_acks',
    'tick_coalescing_does_not_delay_move_or_final_result',
    'unavailable_storage_reports_error_and_network_failure_preserves_memory',
    'corrupt_local_storage_is_preserved_and_blocks_replacement',
    'duplicate_snapshots_do_not_create_new_mutations',
])
def test_computer_history_store(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/computer_history_store.mjs'), scenario], capture_output=True, text=True, encoding='utf-8', timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
