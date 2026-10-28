"""Exercise native programme context and finish guards with the actual controllers."""
import subprocess

import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize('harness,scenario', [
    ('review_interface.mjs', 'training_run_context_survives_pause_and_never_finishes_implicitly'),
    ('review_interface.mjs', 'training_finish_preserves_ungraded_work_and_accepts_fresh_card'),
    ('review_interface.mjs', 'training_settle_waits_for_grade_and_rejects_uncertain_receipt'),
    ('review_interface.mjs', 'training_empty_queue_does_not_bind_another_native_session'),
    ('reading_progress_ui.mjs', 'training_context_exists_before_first_write_and_survives_visit_changes'),
    ('reading_progress_ui.mjs', 'training_retry_retains_original_run_and_receipt'),
])
def test_native_programme_context(harness, scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests' / harness), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
