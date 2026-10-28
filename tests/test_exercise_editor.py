"""Exercise editing uses a detached board and preserves the source analysis."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize('scenario', [
    'detached_position_and_cancel',
    'manual_branches_and_edit_history',
    'variation_selection_preserves_exercise_annotation_draft',
    'annotation_and_tree_actions',
    'save_only_draft_pgn',
    'source_link_saves_manual_solution_and_recovers_stale_report',
    'save_lock_prevents_duplicates_and_changes',
    'failed_save_keeps_draft_and_reuses_created_base',
    'edit_failure_preserves_draft',
    'close_disposes_board_and_listeners',
    'no_solution_validation_and_optional_engine',
    'successful_creation_survives_refresh_error',
    'close_ignores_pending_manual_move_and_reopens_cleanly',
    'prefilled_solution_is_detached_at_root_and_preserves_annotations',
    'prefilled_solution_saves_exact_moves_and_variants_without_engine_additions',
    'prefilled_invalid_document_opens_no_dialog',
    'on_closed_runs_once_after_disposal_on_cancel_and_save',
])
def test_exercise_editor(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/exercise_editor.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
