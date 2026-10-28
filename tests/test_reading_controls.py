"""Reading controls preserve the board while adapting annotation space and text."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize("scenario", [
    "markup_is_compact_accessible_and_uses_local_click_actions",
    "mount_applies_defaults_and_saved_settings_without_writing_storage",
    "toggles_persist_and_keep_the_reading_menu_open",
    "font_limits_are_enforced_and_reset_restores_all_preferences",
    "malformed_storage_and_non_boolean_values_cannot_break_layout",
    "denied_storage_and_absent_document_remain_usable",
    "public_update_validates_persists_and_returns_isolated_state",
    "cleanup_removes_own_listener_and_prevents_late_changes",
    "absent_hosts_and_unrelated_clicks_are_ignored",
    "presets_remember_independent_adjustments_without_navigation_on_mount",
    "touch_comfort_persists_and_applies_before_analysis_mount",
    "move_preferences_restore_migrate_and_validate",
    "move_controls_keep_profiles_and_reset_independent",
    "move_controls_have_labelled_native_inputs"
])
def test_reading_controls(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/reading_controls.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
