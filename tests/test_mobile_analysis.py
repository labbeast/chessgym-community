"""Run mobile panel behavior without a browser or recreation of study content."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', [
    "mobile_commands_move_existing_controls_and_put_reading_in_more_menu",
    "desktop_mobile_roundtrip_restores_original_command_order_and_draft",
    "disconnect_restores_commands_and_stale_breakpoint_callback_cannot_move_them",
    "absent_command_hosts_leave_tab_controller_usable",
    "initial_panel_has_accessible_selection_without_reentrant_selection_callback",
    "switching_panels_preserves_existing_drafts_and_engine_instances",
    "delegated_clicks_select_only_tabs_inside_the_controller",
    "keyboard_selection_wraps_focus_and_consumes_board_navigation_keys",
    "unrelated_keys_and_modified_shortcuts_are_not_intercepted",
    "breakpoint_changes_sync_mobile_tool_visibility_without_losing_selection",
    "disconnect_detaches_handlers_and_ignores_queued_events",
    "missing_workspace_or_tabs_is_a_safe_noop"
])
def test_mobile_analysis(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/mobile_analysis.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
