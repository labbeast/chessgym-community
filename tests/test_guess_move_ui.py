import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario',[
 'game_information_shows_players_ratings_event_and_date',
 'game_information_preserves_partial_dates_and_escapes_headers',
 'historical_clocks_follow_navigation_flip_and_annotation_gaps',
 'historical_clocks_hide_during_preview_and_outside_the_source_line',
 'conceals_then_scores_and_explores_without_source_mutation',
 'pending_engine_locks_proposal_and_retry_uses_first_move',
 'double_submission_and_late_response_cannot_overwrite_other_page',
 'first_move_persists_after_error_without_unlocked_second_chance',
 'failed_recovery_after_disposal_preserves_other_page',
 'failed_recovery_after_new_launch_preserves_selected_game',
 'complete_history_shows_summary_and_analysis_callback',
 'launch_current_document_posts_detached_pgn_and_path',
 'settings_update_selected_game_defaults_without_starting_a_session',
 'current_position_default_and_inline_override_preserve_selected_source',
 'active_settings_are_locked_and_statistics_preserve_session',
 'startup_blocks_settings_and_late_statistics_are_closed',
 'restored_settings_are_validated_and_only_explicit_save_notifies_workspace',
])
def test_guess_move_ui(scenario):
    result=subprocess.run([node_binary(),str(ROOT/'tests/guess_move.mjs'),scenario],capture_output=True,text=True,encoding='utf-8',timeout=20,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
    assert result.returncode==0,result.stderr+result.stdout
