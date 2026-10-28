"""Actual transposition controller and exact-source navigation guards."""
import subprocess
import pytest
from test_board_interactions import node_binary, ROOT

@pytest.mark.parametrize('scenario', ["explicit_search_preserves_draft_and_payload","no_primary_needed_and_dynamic_content_is_escaped","scopes_and_same_order_invalidate_then_paginate","partial_empty_does_not_claim_complete_absence","stale_search_cannot_replace_new_position","disposal_ignores_late_response","stale_click_and_invalid_index_do_not_navigate","opening_preserves_exact_branch_and_guards_duplicates","error_is_visible_and_retry_is_explicit","changed_target_keeps_current_analysis_and_reports_error","document_validation_rejects_modified_or_missing_path_without_mutation","english_interface_keeps_user_data"])
def test_transposition_navigation(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/repertoire_transpositions.mjs'), scenario], text=True, encoding='utf-8', capture_output=True, timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout
