"""Durable report outbox uses actual store under network and concurrency failures."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', ["active_attempt_completion_is_retained_while_a_conflict_awaits_choice", "corrupted_pending_state_is_preserved_without_breaking_open", "old_receipt_cannot_regress_newer_progress_from_another_device", "delayed_read_cannot_regress_an_acknowledged_write", "no_open_or_read_fabricates_progress","reviewed_hints_and_solution_survive_reload","lost_response_retries_identical_receipt_after_reload","updates_during_request_are_not_lost_or_mutated","concurrent_moments_do_not_overwrite_each_other","same_moment_conflict_preserves_both_until_explicit_server_choice","explicit_local_conflict_choice_uses_fresh_revision_and_new_receipt","conflict_changes_again_requires_another_choice","account_and_restore_epoch_isolate_pending_writes_and_late_results","local_storage_failure_is_visible_even_when_server_saves","source_change_keeps_local_work_without_retry_loop","explicit_reset_is_persisted_without_deleting_other_moments","malformed_local_state_is_preserved_and_blocks_mutation"])
def test_report_progress_store(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/game_report_progress_store.mjs'), scenario], text=True, encoding='utf-8', capture_output=True, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
