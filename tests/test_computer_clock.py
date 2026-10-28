"""Monotonic computer-game clocks, using deterministic elapsed play time."""
import subprocess
from pathlib import Path
import pytest
from test_board_interactions import node_binary
ROOT = Path(__file__).resolve().parents[1]
@pytest.mark.parametrize('scenario', [
    'presets_and_custom_limits_are_explicit',
    'reload_never_charges_closed_browser_time',
    'pause_stops_both_clocks_and_preserves_active_elapsed_time',
    'held_proposals_have_no_latency_cost_or_early_increment',
    'flag_fall_cannot_be_rescued_with_increment',
    'undo_restores_both_sides_and_truncates_obsolete_clock_history',
    'final_move_freezes_clock_and_clock_labels_round_up',
])
def test_computer_clock(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/computer_clock.mjs'), scenario], capture_output=True, text=True, encoding='utf-8', timeout=20, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
