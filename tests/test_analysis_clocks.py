"""Historical analysis clocks use PGN annotations on the selected branch."""
import subprocess

import pytest

from test_board_interactions import ROOT, node_binary


@pytest.mark.parametrize('scenario', [
    'strict_seconds_preserve_zero_and_reject_coercion',
    'formatting_handles_fractions_hours_and_minute_boundaries',
    'absent_move_clocks_never_infer_time_from_headers_or_root',
    'standard_root_initializes_both_sides_and_clocks_are_after_moves',
    'missing_or_invalid_own_annotations_clear_only_that_side',
    'variation_clocks_follow_parents_without_mixing_siblings',
    'black_to_move_custom_root_uses_parent_turn_without_initial_inference',
    'complex_controls_and_nonexact_start_fen_do_not_infer_initial_clocks',
    'availability_is_document_wide_and_zero_is_real_data',
    'flip_does_not_swap_colors_or_mutate_documents',
    'updates_to_annotations_remain_visible_with_the_same_document',
    'broken_parent_chains_and_cycles_return_unknown_without_looping',
])
def test_analysis_clocks(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/analysis_clocks.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
