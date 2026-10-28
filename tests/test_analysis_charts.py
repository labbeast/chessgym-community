"""Mainline evaluation/time charts and keyboard/pointer navigation contracts."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "position_evaluations_are_visible_without_full_analysis_and_prefer_depth",
    "position_updates_refresh_chart_and_tooltip_without_changing_line",
    "tooltip_stays_inside_graph_at_edges_and_after_resize",
    "late_navigation_cannot_replace_latest_tooltip",
    "unsaved_analysis_explains_how_to_enable_evaluations",
    "mainline_uses_child_order_and_parent_fen",
    "missing_time_never_becomes_zero",
    "evaluation_white_pov_mate_and_clamp",
    "report_gaps_stale_and_fen_mismatch",
    "svg_does_not_bridge_missing_evaluations",
    "clock_curves_break_on_own_missing_and_share_scale",
    "all_zero_values_stay_real_zero",
    "report_update_navigation_and_edit_invalidation",
    "off_mainline_selection_and_tooltip_are_honest",
    "pointer_click_and_busy_guards",
    "keyboard_claims_event_and_tab_does_not_move_board",
    "dispose_removes_handlers_and_ignores_late_reports",
    "time_only_missing_fields_explained_without_fake_maximum",
    "report_refresh_preserves_keyboard_focus",
])
def test_analysis_charts(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/analysis_charts.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
