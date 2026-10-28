"""Global review defaults remain separate from existing base settings."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "queued_preferences_cannot_write_after_account_change",
    "english_defaults_are_translated_and_values_stay_numeric",
    "defaults_limits_and_capability_are_explicit",
    "save_serializes_forms_and_recovers_after_failure",
    "old_server_and_stale_form_cannot_submit",
])
def test_review_preferences_ui(scenario):
    result = subprocess.run([node_binary(), str(ROOT / "tests/review_preferences.mjs"), scenario], text=True, encoding="utf-8", capture_output=True, timeout=15, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    assert result.returncode == 0, result.stderr + result.stdout
