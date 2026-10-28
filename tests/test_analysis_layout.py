"""Exercise viewport fitting and observer lifecycle with explicit element geometry."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', [
    'mobile_portrait_geometry_uses_full_width_even_with_short_height_or_reading_preferences',
    'mobile_landscape_geometry_preserves_side_panel_and_toolbar_without_page_scroll',
    'mobile_geometry_ignores_desktop_board_reduction_and_never_goes_negative',
    'mobile_observer_keeps_full_width_through_toolbar_tabs_and_engine_changes',
    'observer_switches_between_portrait_landscape_and_desktop_geometry',
    'shrinking_workspace_follows_width_and_recovers_desktop_dimensions',
    'desktop_geometry_maximizes_central_board_with_controls_and_side_columns',
    'collapsed_tools_reserve_the_reclaimed_column_for_notation',
    'reduced_board_reclaims_width_and_still_fits_short_workspaces',
    'explicit_refresh_applies_reading_preferences_and_restores_normal_geometry',
    'graph_size_and_presence_do_not_reduce_the_central_board',
    'short_desktop_keeps_the_central_board_and_controls_visible',
    'temporary_report_controls_fit_below_board_and_release_their_space',
    'clock_bands_fit_both_players_and_release_hidden_space',
    'replaced_clock_bands_are_remeasured_from_the_stable_host',
    'narrow_desktop_keeps_both_tool_columns_and_never_returns_negative_size',
    'observer_reacts_to_workbench_and_toolbar_resizing_without_redundant_writes',
    'replaced_board_toolbar_is_remeasured_from_the_stable_host',
    'responsive_mode_switch_clears_inline_size_without_geometry_change',
    'disconnect_removes_resize_listener_and_ignores_late_observer_delivery',
    'missing_observer_or_unmounted_elements_are_safe',
])
def test_analysis_layout(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/analysis_layout.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
