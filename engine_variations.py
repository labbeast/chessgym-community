"""Canonical legal PV snapshots shared by the two UCI engine lanes."""
import chess


def line_snapshot(board, raw, *, require_full_line, keep_history):
    """Build one white-relative evaluation without mutating the source position.

    The live lane accepts only fully legal lines and evaluates standalone FENs.
    The game/report lane may keep a legal prefix and must preserve repetition
    history. Those policies are explicit instead of accidentally diverging.
    Malformed UCI tokens always reject the line, as do empty variations.
    """
    replay = board.copy(stack=keep_history)
    sans, positions, ucis = [], [], []
    try:
        for uci in raw['pv']:
            move = chess.Move.from_uci(uci)
            if move not in replay.legal_moves:
                if require_full_line:
                    return None
                break
            san = replay.san(move)
            replay.push(move)
            outcome = replay.outcome()
            sans.append(san)
            ucis.append(uci)
            positions.append({'uci': uci, 'san': san, 'fen': replay.fen(),
                              'game_over': outcome is not None,
                              'result': outcome.result() if outcome else '*'})
    except (ValueError, KeyError):
        return None
    if not ucis:
        return None
    white_score = raw['score'] if board.turn == chess.WHITE else -raw['score']
    return {'uci': ucis[0], 'pv': ucis, 'san': sans, 'positions': positions,
            'cp': white_score if raw['kind'] == 'cp' else None,
            'mate': white_score if raw['kind'] == 'mate' else None,
            'depth': raw['depth']}
