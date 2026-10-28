"""PGN terminal annotations follow the accepted branch without grading or data writes."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize('scenario', [
    'final_move_comment_uses_source_path_and_preserves_unassisted_result',
    'final_comment_follows_the_accepted_alternative_not_mainline',
    'final_comment_appears_after_reveal_and_automatic_opponent_reply',
    'final_comments_survive_finished_resume_exploration_and_return_to_final',
    'failed_comment_load_preserves_grade_and_retry_only_loads_comments',
    'late_comment_cannot_change_new_card_or_retried_attempt',
    'final_comment_load_does_not_replace_full_source_while_consulting',
])
def test_final_comments(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/review_interface.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
