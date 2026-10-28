"""Compact PGN move rows retain branches, annotations and stored score provenance."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize("scenario", [
    "deepest_evaluation_wins_without_downgrading_ties_or_missing_depth",
    "move_scores_prefer_depth_and_remain_usable_without_a_report",
    "loss_prefers_deepest_scores_but_keeps_a_complete_comparable_pair",
    "live_position_analysis_preserves_report_deltas_for_both_colours_and_variations",
    "mainline_rows_pair_both_colours_and_fullmove_numbers",
    "black_fen_start_preserves_number_and_empty_white_cell",
    "alternatives_appear_at_branch_point_before_continuation",
    "nested_variations_keep_child_order_without_losing_moves",
    "comments_nags_and_result_are_preserved_near_their_move",
    "report_requires_path_and_fen_and_must_not_be_stale",
    "imported_evaluations_work_for_variations_and_deeper_scores_take_precedence",
    "scores_handle_zero_mate_and_missing_without_fake_zero",
    "elapsed_times_stay_with_their_moves_scores_and_variations",
    "missing_or_invalid_elapsed_times_do_not_fall_back_to_remaining_clocks",
    "elapsed_time_labels_are_translated_without_changing_notation",
    "untrusted_text_and_paths_cannot_inject_html",
    "empty_and_cyclic_documents_are_finite",
    "loss_uses_the_mover_perspective_and_lichess_judgements",
    "loss_requires_a_complete_matching_source_pair",
    "engine_best_move_and_improvements_never_get_negative_losses_or_mate_blames",
    "lichess_thresholds_and_lopsided_positions_are_contextual",
    "mates_have_explicit_labels_and_no_fabricated_pawn_loss",
    "time_accents_use_strict_initial_budget_thresholds_in_both_modes",
    "unknown_initial_budget_or_clock_never_creates_a_time_accent",
    "automatic_accents_preserve_user_nags_and_can_be_disabled_independently",
    "display_changes_invalidate_cached_rows_but_cursor_changes_preserve_them",
])
def test_analysis_moves(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/analysis_moves.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
