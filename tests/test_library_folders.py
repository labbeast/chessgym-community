"""Folder tree hierarchy, disclosure state and keyboard navigation."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "only_existing_leaf_without_bases_is_deletable",
    "hierarchy_names_are_short_counts_are_direct_and_menu_stays_available",
    "branch_state_survives_renders_and_new_folder_reveals_its_ancestors",
    "missing_parents_cycles_and_duplicates_render_once_without_recursion_limit",
    "folder_names_are_escaped_in_content_and_attributes",
    "keyboard_navigation_skips_closed_branches_and_does_not_select_a_folder",
    "disclosure_click_and_keyboard_only_update_the_relevant_branch",
    "empty_library_keeps_fixed_views_and_invites_folder_creation",
])
def test_library_folders(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/library_folders.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
