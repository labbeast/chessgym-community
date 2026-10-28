"""Check analysis entry navigation order and accessibility without a browser."""
import subprocess

import pytest

from test_board_interactions import ROOT, node_binary


@pytest.mark.parametrize('scenario', [
    'displayed_sort_and_filter_order_is_preserved',
    'mixed_entries_are_normalized_deduplicated_without_reordering',
    'first_and_last_entries_never_wrap',
    'unrelated_free_and_unsaved_documents_have_no_navigation',
    'invalid_identifiers_cannot_create_a_navigation_context',
    'context_and_document_are_not_mutated',
    'markup_has_accessible_labels_and_boundary_disabled_buttons',
    'untrusted_metadata_cannot_inject_markup',
])
def test_entry_navigation(scenario):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/entry_navigation.mjs'), scenario],
        text=True, encoding='utf-8', capture_output=True, timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
