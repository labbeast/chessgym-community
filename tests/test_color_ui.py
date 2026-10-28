import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', [
    'clock_starts_with_first_answer_and_uses_server_time',
    'answer_receipt_prevents_duplicate_click_and_advances_wrong_answer',
    'lost_answer_response_recovers_without_resubmitting',
    'recover_locks_answers_and_ignores_obsolete_session',
    'stale_history_errors_do_not_overwrite_current_view',
    'keyboard_respects_browser_shortcuts_forms_and_dialogs',
    'record_eligibility_is_explicit_and_durations_are_separate',
    'english_and_untrusted_square_text_are_safe',
    'settings_cannot_replace_session_during_replay',
    'disposed_answer_is_ignored_and_premature_finish_is_retried',
])
def test_color_ui(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/color_ui.mjs'), scenario],
                            capture_output=True, text=True, encoding='utf-8', timeout=20,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
