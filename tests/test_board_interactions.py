
"""Exercise Board's real event handlers with a tiny DOM and legal python-chess fixtures.

The fake DOM provides geometry and event dispatch, not a chess implementation.
It does not replace visual/touch verification in a real browser.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess

import chess
import pytest

from pgnlib import game_payload, load_game

ROOT = Path(__file__).resolve().parents[1]
CASES = [
    'player_bands_without_clocks_follow_flip_navigation_and_preview',
    'analysis_clocks_are_optional_and_distinguish_unknown_from_zero',
    'analysis_clocks_follow_branches_flip_and_restored_positions',
    'analysis_clocks_mask_preview_and_pending_positions_without_hiding_bands',
    'initial_legal_state_is_playable_without_network_roundtrip',
    'invalid_initial_legal_state_falls_back_to_exact_position_request',
    'initial_legal_state_does_not_survive_navigation_or_document_replacement',
    'analysis_settings_cancel_restart_and_keep_exact_cache_keys',
    'engine_settings_controls_do_not_enable_training_or_count_as_assistance',
    'analysis_preferences_load_before_stream_and_only_latest_position_runs',
    'analysis_preferences_disposed_board_cannot_start_delayed_engine',
    'right_draw_toggles_arrows_circles_without_changing_chess',
    'right_draw_preview_capture_and_release_outside_are_safe',
    'right_draw_scopes_context_menu_and_ignores_other_buttons',
    'right_draw_flips_keeps_engine_arrows_and_hides_during_pv',
    'right_draw_clears_on_left_click_navigation_and_new_exercise',
    'right_draw_training_and_multiple_boards_are_independent',
    'copy_pgn_control_survives_navigation_and_respects_edit_locks',
    'inactive_engine_is_quiet_but_training_and_analysis_errors_remain_visible',
    'pv_hover_is_continuous_across_buttons_and_line_gaps',
    'pv_gap_preserves_stream_until_actual_line_exit',
    'progressive_updates_preserve_all_square_button_identities',
    'queued_analysis_flushes_after_move_unlock',
    'progressive_cache_returns_instantly_and_aborts_navigation',
    'analysis_starts_before_legal_and_late_responses_are_discarded',
    'stored_scores_require_matching_path_fen_and_prefer_greater_depth',
    'live_evaluation_records_position_without_report_and_preserves_annotations',
    'live_evaluation_only_replaces_a_shallower_report',
    'live_evaluation_cache_is_saved_and_training_never_writes',
    'live_evaluation_saves_during_preview_and_defers_while_locked',
    'live_evaluation_discards_late_navigation_document_and_disposal_results',
    'streamed_pv_keeps_hover_preview_and_click_target_stable',
    'manual_refresh_preserves_cache_and_bypasses_both_caches',
    'docked_engine_controls_preview_and_atomic_play',
    'docked_engine_clears_stale_results_and_keeps_default_board',
    'keyboard_navigation_follows_current_branch_and_notifies',
    'keyboard_variation_selection_preserves_board_engine_and_pgn',
    'keyboard_variation_entry_and_reset_follow_chosen_branch',
    'keyboard_current_move_siblings_take_priority_over_replies',
    'keyboard_leaf_black_and_nested_siblings_are_selectable',
    'keyboard_lone_current_move_falls_back_to_child_variants',
    'keyboard_selecting_current_sibling_does_not_advance',
    'keyboard_stale_sibling_choices_are_ignored',
    'keyboard_single_continuation_preserves_vertical_scrolling',
    'keyboard_ignores_editing_composition_and_modified_keys',
    'keyboard_modal_and_menu_own_their_input',
    'keyboard_busy_training_and_drag_are_not_navigated',
    'keyboard_multiple_boards_consume_once_and_dispose',
    'drag_mouse_touch_flipped_and_ghost',
    'drag_cancellation_and_legal_moves',
    'capture_transfer_and_dialog_drag',
    'click_click_and_drag_threshold',
    'drag_promotion_and_cancel',
    'snapshot_rook_promotion_and_en_passant',
    'hover_focus_and_stale_preview',
    'apply_pv_preserves_branches_comments_and_headers',
    'saved_pv_stays_local_and_preserves_source_revision',
    'training_opens_detached_analysis_without_answer',
    'coordinates_and_keyboard_pv_labels',
    'drop_remains_at_destination_until_server_accepts',
    'rejected_review_and_failed_request_restore_position',
    'pending_capture_castle_and_en_passant',
    'pending_promotion_choice_and_cancel',
    'pending_move_cannot_replace_a_new_document',
]


def node_binary():
    for candidate in [os.environ.get('CHESSGYM_NODE'), shutil.which('node'),
                      Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe']:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    pytest.skip('Node is required for the interaction tests')


def fixture_line(fen, moves, by_fen):
    board = chess.Board(fen)
    initial = board.fen()
    snapshots = []
    by_fen[board.fen()] = {'legal': [m.uci() for m in board.legal_moves]}
    for uci in moves:
        move = chess.Move.from_uci(uci)
        assert move in board.legal_moves
        san = board.san(move)
        board.push(move)
        snapshots.append({'uci': uci, 'san': san, 'fen': board.fen(),
                          'game_over': board.is_game_over(), 'result': board.result()})
        by_fen[board.fen()] = {'legal': [m.uci() for m in board.legal_moves],
                             'game_over': board.is_game_over()}
    return {'fen': initial, 'line': {'pv': moves, 'san': [s['san'] for s in snapshots],
                                   'positions': snapshots, 'cp': 25, 'depth': 10}}


@pytest.fixture(scope='module')
def fixtures():
    by_fen = {}
    result = {'byFen': by_fen}
    result['opening'] = fixture_line(chess.STARTING_FEN, ['e2e4', 'e7e5', 'g1f3'], by_fen)
    result['castle'] = fixture_line(chess.STARTING_FEN,
                                   ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1e2', 'g8f6', 'e1g1'], by_fen)
    result['capture'] = fixture_line(chess.STARTING_FEN,
                                     ['e2e4', 'd7d5', 'e4d5'], by_fen)
    result['promotion'] = fixture_line('7k/P7/8/8/8/8/8/K7 w - - 0 1', ['a7a8q'], by_fen)
    result['enpassant'] = fixture_line(chess.STARTING_FEN,
                                      ['e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6'], by_fen)
    black = chess.Board()
    black.push_uci('e2e4')
    result['black'] = fixture_line(black.fen(), ['e7e5', 'g1f3'], by_fen)
    result['document'] = game_payload(load_game('''[White "Auteur"]
[Black "Adversaire"]
[Result "*"]

1. e4 $1 {Idée conservée} (1. d4 $5 {Autre ligne} d5) 1... c5 *
'''))
    result['variationDocument'] = game_payload(load_game('''[White "Auteur"]
[Black "Adversaire"]
[Result "*"]

1. e4 $1 {Idée conservée}
(1. d4 $5 {Autre ligne} d5 (1... Nf6 2. c4 (2. Nf3) 2... e6))
(1. c4 {Anglaise} e5)
1... c5 (1... e5 2. Nf3) *
'''))
    result['childForkDocument'] = game_payload(load_game('1. e4 c5 (1... e5 2. Nf3) *'))
    for node in result['variationDocument']['nodes'] + result['childForkDocument']['nodes']:
        position = chess.Board(node['fen'])
        by_fen[position.fen()] = {
            'legal': [move.uci() for move in position.legal_moves],
            'game_over': position.is_game_over(),
        }
    return result


@pytest.mark.parametrize('scenario', CASES)
def test_board_interactions(scenario, fixtures):
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/board_interactions.mjs'), scenario],
        input=json.dumps(fixtures), text=True, encoding='utf-8', capture_output=True,
        timeout=15, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout
