"""Streaming parser and bounded browser cache, without a browser or live engine."""
import subprocess
from pathlib import Path
import pytest
from test_board_interactions import node_binary

ROOT = Path(__file__).resolve().parents[1]

@pytest.mark.parametrize('scenario', [
    'changing_engine_invalidates_completed_and_inflight_analysis',
    'engine_status_refresh_preserves_cache_unless_identity_changed',
    'chunks_utf8_and_final_line_without_newline',
    'only_completed_results_cache_and_mutations_are_isolated',
    'cache_is_bounded_expires_and_keys_full_fen_settings',
    'rejects_wrong_positions_malformed_events_and_server_errors',
    'abort_does_not_store_or_publish_late_result',
    'credentials_refresh_and_terminal_empty_result',
])
def test_streaming_engine_client(scenario):
    result = subprocess.run([node_binary(), str(ROOT / 'tests/engine_analysis_client.mjs'), scenario],
                            capture_output=True, text=True, encoding='utf-8', timeout=15,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stdout + result.stderr
