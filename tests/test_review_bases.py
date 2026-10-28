"""Desktop and phone base overviews expose the same review state and actions."""
import subprocess

import pytest

from test_board_interactions import node_binary, ROOT


@pytest.mark.parametrize("scenario", [
    "exclusive_progress_is_accessible_and_identical_on_desktop_and_phone",
    "desktop_and_mobile_keep_counts_and_actions",
    "mastered_and_empty_bases_do_not_offer_unavailable_sessions",
    "play_and_new_labels_keep_engine_settings_and_defaults",
    "names_tags_and_unknown_categories_are_text",
])
def test_review_base_overview(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/review_bases.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
