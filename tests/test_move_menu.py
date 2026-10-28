"""Exercise move-menu events and detached editor history without claiming visual QA."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

CASES = [
    'reading_bookmark_context_action_targets_only_eligible_mainline_move',
    'actions_target_enclosing_branch',
    'context_targets_clicked_move_only',
    'keyboard_and_accessible_button',
    'touch_long_press_and_scroll_cancel',
    'dismissal_and_disposal',
    'history_restores_tree_annotations_and_cursor',
    'history_branching_limits_and_metadata',
]

@pytest.mark.parametrize('scenario', CASES)
def test_move_menu(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/move_menu.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
