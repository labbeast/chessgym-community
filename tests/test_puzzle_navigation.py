import subprocess

import pytest
from test_board_interactions import ROOT, node_binary


@pytest.mark.parametrize('scenario', [
    'bundled_storm_result_displays_only_the_ready_next_attempt',
    'classic_and_legacy_servers_do_not_request_inline_storm',
    'legacy_storm_next_runs_without_a_feedback_timeout',
    'next_selection_error_does_not_retry_or_create_another_attempt',
    'delayed_final_move_cannot_replace_history_or_return',
    'resume_play_uses_server_current_attempt_after_a_hidden_transition',
    'delayed_resume_cannot_replace_a_new_navigation',
    'late_review_cannot_replace_storm_before_or_after_restart_response',
    'late_review_cannot_replace_new_classic_puzzle',
    'late_exercise_lookup_cannot_open_after_restart',
    'late_exercise_parse_cannot_open_while_restart_request_is_pending',
    'active_storm_history_restores_clock_context_and_keeps_events',
    'history_restores_different_current_attempt_with_its_own_events',
    'history_detects_expired_storm_and_opens_results',
    'late_storm_restore_cannot_replace_restarted_session',
    'exercise_uses_source_solution_and_keeps_the_result_unchanged',
])
def test_puzzle_navigation(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/puzzle_navigation.mjs'), scenario],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
