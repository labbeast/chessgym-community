import subprocess

import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize('scenario', [
    'blindfold_position_description_groups_icons_and_sorted_squares',
    'blindfold_preparation_clock_resumes_freezes_and_cleans_up',
    'blindfold_result_includes_visualization_and_total_without_legacy_double_counting',
    'orientation_and_grid_are_consistent',
    'notation_and_reconstruction_are_localized_and_escaped',
    'coordinate_clicks_use_server_receipts_and_ignore_late_result',
    'coordinate_target_is_inside_board_for_all_modes',
    'blindfold_empty_board_never_contains_position_and_has_promotion_choice',
    'reconstruction_submission_uses_only_user_pieces',
    'lost_response_recovers_server_indices_without_resubmitting',
    'blindfold_search_ignores_late_results_and_supports_clearing',
    'blindfold_final_reconstruction_is_on_by_default_and_optional',
    'final_reconstruction_hides_all_prompts_and_starts_with_an_empty_board',
    'correct_final_move_enters_memory_stage_without_finishing_or_fetching_history',
    'lost_last_move_response_recovers_reconstruction_without_leaking_position',
    'puzzle_result_keeps_reconstruction_as_secondary_statistics',
    'completed_two_stage_puzzle_opens_board_at_its_final_position',
    'rated_blindfold_has_two_profiles_progressive_targets_and_legacy_migration',
    'rating_result_uses_solution_and_shows_secondary_reconstruction',
    'rated_blindfold_restores_active_phase_and_server_answer_index',
])
def test_training_skills_ui(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/training_skills.mjs'), scenario],
                            capture_output=True, text=True, encoding='utf-8', timeout=20,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
