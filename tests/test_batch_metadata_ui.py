"""PGN header edits are explicit and keep untouched per-game values."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "mixed_values_are_clear_and_structural_fields_excluded",
    "patch_only_applies_explicit_fields_and_clear_is_null",
    "invalid_or_duplicate_custom_fields_are_rejected",
    "controls_opt_in_clear_and_revert_preserve_original_values",
    "custom_fields_can_be_added_without_affecting_existing_tags",
    "pending_submission_locks_every_control_and_escape_until_callback_finishes",
    "no_selection_is_rejected_and_individual_editor_remains_exported",
])
def test_batch_metadata_ui(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/batch_metadata.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
