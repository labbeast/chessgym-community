"""Coverage reports display conditional probabilities and only scan on request."""
import subprocess

import pytest

from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize("scenario", [
    "probability_and_filters_use_fractions_and_validate_bounds",
    "results_rank_gaps_escape_notation_and_state_partial_limits",
    "results_distinguish_local_frequency_mixed_roots_and_stale_data",
    "mount_only_loads_cache_and_restores_saved_filters",
    "user_changes_survive_a_late_cache_response",
    "permanent_limits_require_narrowing_and_do_not_offer_futile_continuation",
    "non_resumable_missing_statistics_offer_refresh_instead_of_continuation",
    "manual_scan_aborts_cache_prevents_duplicate_and_accepts_only_latest_response",
    "cancel_and_dispose_abort_requests_and_ignore_late_results",
    "invalid_filters_and_network_errors_preserve_results_without_silent_scan",
    "explorer_receives_ranked_gap_full_line_and_isolated_profile_once",
    "explorer_failure_keeps_bilan_available_and_disposal_is_safe",
])
def test_repertoire_coverage_ui(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/repertoire_coverage.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
