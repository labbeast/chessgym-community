"""Base drag-and-drop does not mutate the visible collection before the server accepts it."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize("scenario", [
    "native_pointercancel_does_not_cancel_browser_drag_and_pointer_cancel_is_scoped",
    "native_folder_drop_commits_only_valid_payload_and_waits_for_server",
    "reorder_uses_horizontal_or_vertical_insertion_and_keeps_folder_implicit",
    "foreign_drops_all_bases_and_self_are_never_mutations",
    "pointer_handle_supports_touch_without_stealing_card_long_press",
    "handle_tap_and_keyboard_offer_folder_choice_and_order_controls",
    "rejected_save_keeps_cards_in_original_order_and_restores_controls",
    "escape_dispose_and_outside_release_cancel_without_saving",
])
def test_library_drag(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / "tests/library_drag.mjs"), scenario],
        text=True, encoding="utf-8", capture_output=True, timeout=15,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
