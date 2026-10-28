"""Game reports must be resumable, position-correct, and leave user PGNs intact."""
import json
import threading

import chess
import pytest
from fastapi import HTTPException

import db
import engine
import game_analysis as ga
import jobs
import pgnlib
import sync
import training


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'game-analysis.sqlite3')
    db.init_db()
    ga.init_analysis()
    jobs.init_jobs()
    sync.init_sync()
    training.init_training()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(1,'Mes parties','{}',?)", (ga.stamp(),))
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(2,'Mes exercices',?,?)",
                     (json.dumps({'review_enabled': True, 'type': 'solve'}), ga.stamp()))
    return tmp_path


@pytest.mark.parametrize('headers,accounts,expected', [
    ({'Site': 'https://lichess.org/AbCd1234', 'White': 'PLAYER', 'Black': 'Opponent'},
     [('lichess', 'player', True)], 'white'),
    ({'Site': 'Chess.com', 'White': 'Opponent', 'Black': ' Player '},
     [('chesscom', 'player', True)], 'black'),
    ({'Site': '?', 'Link': 'https://www.chess.com/game/live/123', 'White': 'Player'},
     [('chesscom', 'player', True)], 'white'),
    ({'Site': 'https://lichess.org/AbCd1234', 'Black': 'Player'},
     [('lichess', 'player', False)], 'black'),
    ({'Site': 'https://lichess.org/AbCd1234', 'White': 'Player', 'Black': 'Other'},
     [('chesscom', 'player', True), ('lichess', 'other', True)], 'black'),
    ({'Site': 'Lichess', 'White': 'Player', 'Black': 'Other'},
     [('lichess', 'player', True), ('lichess', 'other', True)], None),
    ({'Site': 'https://lichess.org/AbCd1234', 'White': 'Player', 'Black': 'PLAYER'},
     [('lichess', 'player', True)], None),
    ({'Site': 'https://lichess.org/AbCd1234', 'White': 'Player'},
     [('chesscom', 'player', True)], None),
    ({'Site': '?', 'White': 'Player'}, [('lichess', 'player', True)], None),
    ({'Site': 'https://lichess.org/AbCd1234', 'Link': 'https://www.chess.com/game/live/123', 'White': 'Player'},
     [('lichess', 'player', True)], None),
    ({'Site': 'https://lichess.org.evil.invalid/AbCd1234', 'White': 'Player'},
     [('lichess', 'player', True)], None),
    ({'Site': 'https://evil.invalid@lichess.org/AbCd1234', 'White': 'Player'},
     [('lichess', 'player', True)], None),
    ({'Site': 'https://lichess.org/AbCd1234', 'White': 'Opponent'},
     [('lichess', 'player', True)], None),
])
def test_personal_side_is_provider_specific_case_insensitive_and_unambiguous(store, headers, accounts, expected):
    for site, username, enabled in accounts:
        sync.create_account({'site': site, 'username': username, 'base_id': 1, 'enabled': enabled})
    pgn = '\n'.join(f'[{key} "{value}"]' for key, value in headers.items()) + '\n\n1. e4 e5 *'
    entry_id = add(pgn)
    report = ga.get_analysis(entry_id)
    assert report['status'] == 'none'
    assert report['user_side'] == expected


def test_import_site_takes_precedence_and_deleted_account_is_not_inferred(store):
    account = sync.create_account({'site': 'lichess', 'username': 'player', 'base_id': 2})
    sync.create_account({'site': 'chesscom', 'username': 'opponent', 'base_id': 1})
    entry_id = add('[Site "Chess.com"]\n[White "Player"]\n[Black "Opponent"]\n\n1. e4 e5 *')
    with db.get_conn() as conn:
        conn.execute('INSERT INTO sync_imports(base_id,site,remote_id,entry_id,imported_at) VALUES(1,?,?,?,?)',
                     ('lichess', 'AbCd1234', entry_id, ga.stamp()))
    assert ga.get_analysis(entry_id)['user_side'] == 'white'
    sync.delete_account(account['id'])
    assert ga.get_analysis(entry_id)['user_side'] is None


def test_conflicting_import_providers_leave_side_unknown(store):
    sync.create_account({'site': 'lichess', 'username': 'player', 'base_id': 1})
    entry_id = add('[Site "Lichess"]\n[White "Player"]\n\n1. e4 e5 *')
    with db.get_conn() as conn:
        for site, remote_id in [('lichess', 'AbCd1234'), ('chesscom', 'live:123')]:
            conn.execute('INSERT INTO sync_imports(base_id,site,remote_id,entry_id,imported_at) VALUES(1,?,?,?,?)',
                         (site, remote_id, entry_id, ga.stamp()))
    assert ga.get_analysis(entry_id)['user_side'] is None


def test_personal_side_does_not_remove_opponent_positions_or_findings(store, monkeypatch):
    sync.create_account({'site': 'lichess', 'username': 'player', 'base_id': 1})
    entry_id = add('[Site "Lichess"]\n[White "Player"]\n[Black "Opponent"]\n\n1. e4 e5 *')
    fake_engine(monkeypatch)
    run(entry_id)
    report = ga.get_analysis(entry_id)
    assert report['user_side'] == 'white'
    assert len(report['positions']) == 3
    assert {finding['side'] for finding in report['findings']} == {'white', 'black'}
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?',
                     ('[Site "Lichess"]\n[White "Player"]\n\n1. d4 d5 *', entry_id))
    stale = ga.get_analysis(entry_id)
    assert stale['status'] == 'stale' and stale['user_side'] == 'white'


def add(pgn='1. e4 e5 *'):
    pgnlib.load_game(pgn)
    with db.get_conn() as conn:
        cursor = conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(1,?,?,?,?)',
                              ('Une partie', pgn, ga.stamp(), ga.stamp()))
        return cursor.lastrowid


class Context:
    def __init__(self, stop_at=None):
        self.cancel_event = threading.Event()
        self.records = []
        self.stop_at = stop_at

    def check_cancelled(self):
        if self.cancel_event.is_set():
            raise engine.AnalysisCancelled()

    def progress(self, current, total, message):
        self.records.append((current, total, message))
        if current == self.stop_at:
            self.cancel_event.set()


def fake_engine(monkeypatch, scores=(100, 0, 200), choices=('d2d4', 'g8f6', 'g1f3')):
    calls = []
    def run(board, time_ms, **kwargs):
        calls.append((board.copy(), time_ms, kwargs))
        index = min(len(board.move_stack), len(scores) - 1)
        uci = choices[min(index, len(choices) - 1)]
        assert chess.Move.from_uci(uci) in board.legal_moves
        return {'lines': [{'cp': scores[index], 'mate': None, 'pv': [uci], 'depth': 12}]}
    monkeypatch.setattr(engine, '_run', run)
    return calls


def run(entry_id, **options):
    context = Context()
    result = ga.analyse_game(context, {'entry_id': entry_id, **options})
    return context, result


def test_scores_paths_and_side_are_correct_and_source_untouched(store, monkeypatch):
    pgn = '[White "Alice"]\n[Black "Bob"]\n\n1. e4! {Une note [%clk 0:10:00]} (1. d4 d5) e5 *'
    entry_id = add(pgn)
    calls = fake_engine(monkeypatch)
    context, summary = run(entry_id)
    assert summary['analysed_positions'] == 3
    assert summary['inaccuracies'] == 1 and summary['mistakes'] == 0 and summary['blunders'] == 1
    assert 'accuracy' not in summary
    report = ga.get_analysis(entry_id)
    assert report['status'] == 'done'
    white, black = report['findings']
    assert (white['ply'], white['path'], white['before_path'], white['side'], white['loss_cp']) == (1, '0', '', 'white', 100)
    assert (black['ply'], black['path'], black['before_path'], black['side'], black['loss_cp']) == (2, '0.0', '0', 'black', 200)
    board = chess.Board()
    board.push_uci('e2e4')
    assert black['fen'] == board.fen()
    assert [len(call[0].move_stack) for call in calls] == [0, 1, 2]
    assert all(call[1] == 400 and call[2]['multipv'] == 1 for call in calls)
    assert [x[:2] for x in context.records] == [(1, 3), (2, 3), (3, 3)]
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0] == pgn


@pytest.mark.parametrize('before,after,side,expected', [
    (300, 0, 'white', ('blunder', 300, True)),
    (-300, 0, 'black', ('blunder', 300, True)),
    (0, -50, 'white', None),
    (0, 100, 'black', ('inaccuracy', 100, False)),
    (0, -49, 'white', None),
    (100, 200, 'white', None),
    (-200, -500, 'black', None),
    (900, 600, 'white', ('inaccuracy', 300, False)),
])
def test_centipawn_classification(before, after, side, expected):
    result = ga.classify({'cp': before, 'mate': None}, {'cp': after, 'mate': None}, side, 'a2a3')
    assert (None if result is None else (result['kind'], result['loss_cp'], result['missed_opportunity'])) == expected


@pytest.mark.parametrize('side,sign', [('white', 1), ('black', -1)])
@pytest.mark.parametrize('loss_cp,kind', [
    (54, None), (55, 'inaccuracy'),
    (110, 'inaccuracy'), (111, 'mistake'),
    (168, 'mistake'), (169, 'blunder'),
    (70, 'inaccuracy'), (150, 'mistake'),
])
def test_lichess_thresholds_at_nearest_centipawn_from_equal_position(side, sign, loss_cp, kind):
    finding = ga.classify(evaluation(cp=0), evaluation(cp=-sign * loss_cp), side, 'a2a3')
    assert (finding['kind'] if finding else None) == kind
    if finding:
        assert finding['loss_cp'] == loss_cp


def evaluation(cp=None, mate=None, winner=None):
    return {'cp': cp, 'mate': mate, 'winner': winner}


@pytest.mark.parametrize('before,after,side,kind,missed', [
    (evaluation(cp=0), evaluation(mate=-2, winner='black'), 'white', 'blunder', False),
    (evaluation(cp=0), evaluation(mate=0, winner='white'), 'black', 'blunder', False),
    (evaluation(mate=2, winner='white'), evaluation(cp=0), 'white', 'blunder', True),
    (evaluation(mate=-2, winner='black'), evaluation(cp=-300), 'black', 'blunder', False),
    (evaluation(mate=2, winner='white'), evaluation(mate=3, winner='white'), 'white', None, None),
    (evaluation(mate=-2, winner='black'), evaluation(mate=-1, winner='black'), 'white', None, None),
    (evaluation(cp=100), evaluation(mate=2, winner='white'), 'white', None, None),
])
def test_mate_changes_never_present_invented_centipawns(before, after, side, kind, missed):
    result = ga.classify(before, after, side, 'a2a3')
    if kind is None:
        assert result is None
    else:
        assert result['kind'] == kind
        assert result['loss_cp'] is None
        assert result['missed_opportunity'] is missed


@pytest.mark.parametrize('side,sign', [('white', 1), ('black', -1)])
@pytest.mark.parametrize('transition', ['created', 'lost'])
@pytest.mark.parametrize('advantage,kind', [
    (699, 'blunder'), (700, 'blunder'), (701, 'mistake'),
    (999, 'mistake'), (1000, 'inaccuracy'),
])
def test_lichess_mate_transition_boundaries(side, sign, transition, advantage, kind):
    if transition == 'created':
        before, after = evaluation(cp=-sign * advantage), evaluation(mate=-sign * 2)
    else:
        before, after = evaluation(mate=sign * 2), evaluation(cp=sign * advantage)
    finding = ga.classify(before, after, side, 'a2a3')
    assert finding['kind'] == kind
    assert finding['loss_cp'] is None and finding['mate_change'] is True
    assert finding['missed_mate'] is (transition == 'lost')


def test_played_best_move_never_labeled_error_from_search_noise():
    assert ga.classify({'cp': 80, 'mate': None, 'best_uci': 'e2e4'}, {'cp': -80, 'mate': None}, 'white', 'e2e4') is None


@pytest.mark.parametrize('fen,cp,winner', [
    ('7k/6Q1/5K2/8/8/8/8/8 b - - 0 1', None, 'white'),
    ('8/8/8/8/8/5k2/6q1/7K w - - 0 1', None, 'black'),
    ('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 0, None),
    ('7k/8/6K1/8/8/8/8/8 w - - 0 1', 0, None),
])
def test_terminal_positions_do_not_call_engine(monkeypatch, fen, cp, winner):
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('No engine call for terminal'))
    result = ga.evaluate_position(chess.Board(fen), ga.DEFAULT_OPTIONS)
    assert result['terminal'] and result['cp'] == cp and result['winner'] == winner
    assert result['mate'] == (0 if winner else None)


def test_automatic_repetition_draw_uses_move_history(monkeypatch):
    board = chess.Board()
    for _ in range(4):
        for move in ('g1f3', 'g8f6', 'f3g1', 'f6g8'):
            board.push_uci(move)
    assert board.is_fivefold_repetition()
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('Already drawn'))
    assert ga.evaluate_position(board, ga.DEFAULT_OPTIONS)['result'] == '1/2-1/2'


def test_claimable_draw_is_not_automatically_forced(monkeypatch):
    board = chess.Board()
    for _ in range(2):
        for move in ('g1f3', 'g8f6', 'f3g1', 'f6g8'):
            board.push_uci(move)
    assert board.can_claim_threefold_repetition() and not board.is_game_over()
    calls = fake_engine(monkeypatch, (50,), ('e2e4',))
    assert not ga.evaluate_position(board, ga.DEFAULT_OPTIONS)['terminal']
    assert len(calls[0][0].move_stack) == 8


def test_cancel_and_resume_skips_completed_positions(store, monkeypatch):
    entry_id = add()
    calls = fake_engine(monkeypatch)
    context = Context(stop_at=1)
    with pytest.raises(engine.AnalysisCancelled):
        ga.analyse_game(context, {'entry_id': entry_id})
    assert ga.get_analysis(entry_id)['status'] == 'cancelled'
    assert len(ga.get_analysis(entry_id)['positions']) == 1
    run(entry_id)
    assert [len(call[0].move_stack) for call in calls] == [0, 1, 2]
    assert ga.get_analysis(entry_id)['status'] == 'done'


def test_finished_run_recomputes_and_options_change_invalidates_resume(store, monkeypatch):
    entry_id = add()
    calls = fake_engine(monkeypatch)
    run(entry_id)
    run(entry_id, depth=18, time_ms=1000)
    assert len(calls) == 6
    assert all(call[1] == 1000 and call[2]['depth'] == 18 for call in calls[3:])
    assert ga.get_analysis(entry_id)['summary']['settings'] == {'depth': 18, 'time_ms': 1000}
    run(entry_id, depth=18, time_ms=1000)
    assert len(calls) == 9


def test_engine_failure_keeps_partial_report_and_can_resume(store, monkeypatch):
    entry_id = add()
    calls = fake_engine(monkeypatch)
    working = engine._run
    def interrupted(board, *args, **kwargs):
        if len(board.move_stack) == 1:
            raise HTTPException(503, 'Le moteur est occupé.')
        return working(board, *args, **kwargs)
    monkeypatch.setattr(engine, '_run', interrupted)
    with pytest.raises(HTTPException):
        run(entry_id)
    report = ga.get_analysis(entry_id)
    assert report['status'] == 'error'
    assert report['summary']['analysed_positions'] == 1
    assert report['findings'] == []
    monkeypatch.setattr(engine, '_run', working)
    run(entry_id)
    assert [len(call[0].move_stack) for call in calls] == [0, 1, 2]
    assert ga.get_analysis(entry_id)['status'] == 'done'


def test_comment_edit_during_analysis_is_preserved_and_does_not_stop_report(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    working = engine._run
    edited = '1. e4! {Une nouvelle note} e5 *'
    def annotated(board, *args, **kwargs):
        if not board.move_stack:
            with db.get_conn() as conn:
                conn.execute('UPDATE entries SET pgn=? WHERE id=?', (edited, entry_id))
        return working(board, *args, **kwargs)
    monkeypatch.setattr(engine, '_run', annotated)
    run(entry_id)
    assert ga.get_analysis(entry_id)['status'] == 'done'
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0] == edited


@pytest.mark.parametrize('change_mainline', [False, True])
def test_report_read_never_mixes_concurrent_replacement_versions(store, monkeypatch, change_mainline):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    original = ga.get_analysis(entry_id)
    replacement_pgn = '1. d4 d5 *' if change_mainline else '1. e4 e5 *'
    replacement_fingerprint = ga.game_snapshot(replacement_pgn)[2]
    replacement_options = ga._settings_key({'depth': 18, 'time_ms': 1000})
    triggered = []
    real_get_conn = ga.get_conn

    class InterleavedRead:
        def __init__(self):
            self.conn = real_get_conn()

        def __enter__(self):
            self.conn.__enter__()
            return self

        def __exit__(self, *args):
            return self.conn.__exit__(*args)

        def execute(self, sql, *args):
            result = self.conn.execute(sql, *args)
            if sql.startswith('SELECT * FROM game_analysis_reports') and not triggered:
                triggered.append(True)
                # A real separate WAL writer commits between the report metadata
                # and position reads. The reader must retain one coherent snapshot.
                with real_get_conn() as writer:
                    writer.execute('BEGIN IMMEDIATE')
                    writer.execute('UPDATE entries SET pgn=? WHERE id=?', (replacement_pgn, entry_id))
                    writer.execute('UPDATE game_analysis_reports SET fingerprint=?,settings=? WHERE entry_id=?',
                                   (replacement_fingerprint, replacement_options, entry_id))
                    rows = writer.execute('SELECT ply,evaluation FROM game_analysis_positions WHERE entry_id=?', (entry_id,)).fetchall()
                    for row in rows:
                        value = json.loads(row['evaluation'])
                        value['cp'] = 500 + row['ply'] * 100
                        writer.execute('UPDATE game_analysis_positions SET evaluation=? WHERE entry_id=? AND ply=?',
                                       (json.dumps(value), entry_id, row['ply']))
            return result

    monkeypatch.setattr(ga, 'get_conn', InterleavedRead)
    snapshot = ga.get_analysis(entry_id)
    assert triggered == [True]
    assert snapshot['summary'] == original['summary']
    assert snapshot['positions'] == original['positions']
    assert snapshot['findings'] == original['findings']
    current = ga.get_analysis(entry_id)
    assert current['summary']['settings'] == {'depth': 18, 'time_ms': 1000}
    assert current['positions'][0]['cp'] == 500
    expected_after = chess.Board()
    expected_after.push_uci('d2d4' if change_mainline else 'e2e4')
    assert current['positions'][1]['fen'] == expected_after.fen()


def test_annotations_and_headers_keep_report_but_mainline_change_stales_it(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('[White "New name"]\n\n1. e4! {Comment} (1. d4 d5) e5 *', entry_id))
    assert ga.get_analysis(entry_id)['status'] == 'done'
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. d4 d5 *', entry_id))
    report = ga.get_analysis(entry_id)
    assert report['status'] == 'stale' and report['findings'] == [] and report['positions'] == []
    with pytest.raises(HTTPException) as error:
        ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2})
    assert error.value.status_code == 409


def test_edit_during_calculation_is_rejected_before_checkpoint(store, monkeypatch):
    entry_id = add()
    def changed(board, options, cancel):
        with db.get_conn() as conn:
            conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. d4 d5 *', entry_id))
        return {'cp': 10, 'mate': None, 'pv': ['e2e4']}
    monkeypatch.setattr(ga, 'evaluate_position', changed)
    with pytest.raises(HTTPException) as error:
        run(entry_id)
    assert error.value.status_code == 409
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM game_analysis_positions').fetchone()[0] == 0
    assert ga.get_analysis(entry_id)['status'] == 'stale'


def test_fingerprint_also_retains_root_counters():
    game = chess.pgn.Game()
    game.setup(chess.Board('8/8/8/3k4/8/3K4/R7/8 w - - 0 1'))
    first = ga.game_snapshot(pgnlib.export_game(game))[2]
    game.headers['FEN'] = game.headers['FEN'].replace('0 1', '100 1')
    assert ga.game_snapshot(pgnlib.export_game(game))[2] != first


def test_pv_is_legal_truncated_and_never_uses_original_wrong_branch(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    with db.get_conn() as conn:
        row = conn.execute('SELECT evaluation FROM game_analysis_positions WHERE entry_id=? AND ply=0', (entry_id,)).fetchone()
        value = json.loads(row[0])
        value['pv'] = ['d2d4', 'd7d5', 'd1h8', 'e2e4']
        conn.execute('UPDATE game_analysis_positions SET evaluation=? WHERE entry_id=? AND ply=0', (json.dumps(value), entry_id))
    result = ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2, 'plies': 32, 'title': 'Trouver le bon plan', 'comment': 'Prends ton temps.'})
    assert result['duplicate'] is False
    with db.get_conn() as conn:
        row = conn.execute('SELECT * FROM entries WHERE id=?', (result['entry_id'],)).fetchone()
        exercise = pgnlib.load_game(row['pgn'])
        assert row['title'] == 'Trouver le bon plan'
        assert row['start_path'] == ''
        assert exercise.comment == 'Prends ton temps.'
        assert list(move.uci() for move in exercise.mainline_moves()) == ['d2d4', 'd7d5']
        assert len(exercise.variations) == 1 and exercise.variations[0].move.uci() != 'e2e4'
        assert exercise.headers['SourceEntry'] == str(entry_id)
        assert exercise.headers['SourcePly'] == '1'
        base = conn.execute('SELECT * FROM bases WHERE id=2').fetchone()
        training._sync_base(conn, base)
        card = conn.execute('SELECT * FROM review_cards WHERE entry_id=?', (result['entry_id'],)).fetchone()
        assert json.loads(card['answers']) == ['d2d4']
    assert ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2}) == {**result, 'duplicate': True}


@pytest.mark.parametrize('plies,expected', [(None, 1), (1, 1), (3, 3), (32, 4)])
def test_exercise_solution_length_is_configurable_and_defaults_to_one(store, monkeypatch, plies, expected):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    with db.get_conn() as conn:
        value = json.loads(conn.execute('SELECT evaluation FROM game_analysis_positions WHERE entry_id=? AND ply=0', (entry_id,)).fetchone()[0])
        value['pv'] = ['d2d4', 'd7d5', 'c2c4', 'e7e6']
        conn.execute('UPDATE game_analysis_positions SET evaluation=? WHERE entry_id=? AND ply=0', (json.dumps(value), entry_id))
    options = {'ply': 1, 'base_id': 2}
    if plies is not None:
        options['plies'] = plies
    made = ga.create_exercise(entry_id, options)
    with db.get_conn() as conn:
        game = pgnlib.load_game(conn.execute('SELECT pgn FROM entries WHERE id=?', (made['entry_id'],)).fetchone()[0])
    assert len(list(game.mainline_moves())) == expected


def test_black_exercise_starts_before_black_move_and_retains_source_metadata(store, monkeypatch):
    entry_id = add('[White "Alice"]\n[Black "Bob"]\n[Site "https://lichess.org/abcdefgh"]\n\n1. e4 e5 *')
    fake_engine(monkeypatch)
    run(entry_id)
    result = ga.create_exercise(entry_id, {'ply': 2, 'base_id': 2})
    with db.get_conn() as conn:
        game = pgnlib.load_game(conn.execute('SELECT pgn FROM entries WHERE id=?', (result['entry_id'],)).fetchone()[0])
    assert game.board().turn == chess.BLACK
    assert game.headers['Site'] == 'https://lichess.org/abcdefgh'
    assert game.headers['SourceWhite'] == 'Alice' and game.headers['SourceBlack'] == 'Bob'
    assert next(iter(game.mainline_moves())).uci() == 'g8f6'


def test_exercise_delete_allows_recreate_and_source_delete_cleans_links(store, monkeypatch):
    entry_id = add()
    fake_engine(monkeypatch)
    run(entry_id)
    first = ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2})
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?', (first['entry_id'],))
    second = ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2})
    assert not second['duplicate']
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?', (entry_id,))
        assert conn.execute('SELECT COUNT(*) FROM game_analysis_exercises').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM game_analysis_reports').fetchone()[0] == 0
        assert conn.execute('SELECT id FROM entries WHERE id=?', (second['entry_id'],)).fetchone()


@pytest.mark.parametrize('payload', [
    {'ply': True, 'base_id': 2}, {'ply': 0, 'base_id': 2}, {'ply': 3, 'base_id': 2},
    {'ply': 1, 'base_id': True}, {'ply': 1, 'base_id': 999}, {'ply': 1, 'base_id': 2, 'title': 'x' * 201},
    {'ply': 1, 'base_id': 2, 'comment': 'x' * 4001}, {'ply': 1, 'base_id': 2, 'anything': 1},
    {'ply': 1, 'base_id': 2, 'plies': True}, {'ply': 1, 'base_id': 2, 'plies': 0},
    {'ply': 1, 'base_id': 2, 'plies': 33}, {'ply': 1, 'base_id': 2, 'plies': '3'},
])
def test_exercise_rejects_bad_input_atomically(store, payload):
    entry_id = add()
    with pytest.raises(HTTPException):
        ga.create_exercise(entry_id, payload)
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0] == 1


@pytest.mark.parametrize('options', [
    {'depth': True}, {'depth': 0}, {'depth': 2**31}, {'depth': '18'}, {'time_ms': True},
    {'time_ms': 99}, {'time_ms': 2**53}, {'time_ms': 100.5}, {'time_ms': '100'}, {'other': 1}, {'time_ms': None, 'depth': None},
])
def test_invalid_analysis_settings(options):
    with pytest.raises(HTTPException):
        ga.options_of(options)


def test_queue_is_deduplicated_and_queued_snapshot_is_checked(store, monkeypatch):
    entry_id = add()
    monkeypatch.setattr(engine, 'status', lambda: {'available': True})
    first = ga.queue_analysis(entry_id)
    assert ga.queue_analysis(entry_id)['id'] == first['id']
    assert ga.get_analysis(entry_id)['status'] == 'queued'
    assert first['payload']['fingerprint'] == ga.game_snapshot('1. e4 e5 *')[2]
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. d4 d5 *', entry_id))
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('Stale queued content'))
    with pytest.raises(HTTPException) as error:
        ga.analyse_game(Context(), first['payload'])
    assert error.value.status_code == 409


def test_unavailable_engine_does_not_enqueue(store, monkeypatch):
    entry_id = add()
    monkeypatch.setattr(engine, 'status', lambda: {'available': False})
    with pytest.raises(HTTPException) as error:
        ga.queue_analysis(entry_id)
    assert error.value.status_code == 503
    assert jobs.latest_for('analyse', {'entry_id': entry_id}) is None


def test_oversized_game_rejected_before_engine(monkeypatch):
    game = chess.pgn.Game()
    node = game
    for _ in range(251):
        for uci in ('g1f3', 'g8f6', 'f3g1', 'f6g8'):
            node = node.add_variation(chess.Move.from_uci(uci))
    monkeypatch.setattr(pgnlib, 'load_game', lambda text: game)
    with pytest.raises(HTTPException) as error:
        ga.game_snapshot('oversized')
    assert error.value.status_code == 422


def test_real_stockfish_report_and_exercise_are_legal(store):
    if not engine.binary_path():
        pytest.skip('Stockfish required')
    entry_id = add('[SetUp "1"]\n[FEN "7k/8/5KQ1/8/8/8/8/8 w - - 0 1"]\n\n1. Qg7# 1-0')
    context, summary = run(entry_id, time_ms=100, depth=8)
    report = ga.get_analysis(entry_id)
    assert summary['analysed_positions'] == 2
    assert report['positions'][0]['mate'] > 0
    assert report['positions'][1]['winner'] == 'white' and report['positions'][1]['terminal']
    made = ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2})
    with db.get_conn() as conn:
        exercise = pgnlib.load_game(conn.execute('SELECT pgn FROM entries WHERE id=?', (made['entry_id'],)).fetchone()[0])
    assert list(exercise.mainline_moves())
    assert exercise.end().board().is_checkmate()

def test_partial_report_restarts_all_positions_with_a_different_engine(store, monkeypatch):
    identity = ['engine-A']
    monkeypatch.setattr(ga, '_engine_identity', lambda: identity[0])
    entry_id = add()
    calls = fake_engine(monkeypatch)
    with pytest.raises(engine.AnalysisCancelled):
        ga.analyse_game(Context(stop_at=1), {'entry_id': entry_id})
    assert ga.get_analysis(entry_id)['summary']['engine_identity'] == 'engine-A'
    identity[0] = 'engine-B'
    run(entry_id)
    assert [len(call[0].move_stack) for call in calls] == [0, 0, 1, 2]
    assert [call[2]['expected_identity'] for call in calls] == ['engine-A', 'engine-B', 'engine-B', 'engine-B']
    assert ga.get_analysis(entry_id)['summary']['engine_identity'] == 'engine-B'


def test_legacy_partial_report_without_engine_provenance_is_recomputed(store, monkeypatch):
    monkeypatch.setattr(ga, '_engine_identity', lambda: 'engine-A')
    entry_id = add()
    calls = fake_engine(monkeypatch)
    with pytest.raises(engine.AnalysisCancelled):
        ga.analyse_game(Context(stop_at=1), {'entry_id': entry_id})
    with db.get_conn() as conn:
        conn.execute('UPDATE game_analysis_reports SET settings=? WHERE entry_id=?',
                     (ga._settings_key(ga.DEFAULT_OPTIONS), entry_id))
    run(entry_id)
    assert [len(call[0].move_stack) for call in calls] == [0, 0, 1, 2]


def test_engine_change_during_position_stops_before_mixed_checkpoint(store, monkeypatch):
    identity = ['engine-A']
    monkeypatch.setattr(ga, '_engine_identity', lambda: identity[0])
    entry_id = add()
    calls = fake_engine(monkeypatch)
    original = engine._run
    def changed(board, *args, **kwargs):
        result = original(board, *args, **kwargs)
        if len(board.move_stack) == 1:
            identity[0] = 'engine-B'
        return result
    monkeypatch.setattr(engine, '_run', changed)
    with pytest.raises(HTTPException) as exc:
        run(entry_id)
    assert exc.value.status_code == 409 and 'moteur a changé' in exc.value.detail
    report = ga.get_analysis(entry_id)
    assert report['status'] == 'error'
    assert [position['ply'] for position in report['positions']] == [0]
    assert report['summary']['engine_identity'] == 'engine-A'
    monkeypatch.setattr(engine, '_run', original)
    run(entry_id)
    assert [len(call[0].move_stack) for call in calls] == [0, 1, 0, 1, 2]
    assert ga.get_analysis(entry_id)['summary']['engine_identity'] == 'engine-B'


def test_queued_report_refuses_a_different_engine_before_touching_checkpoints(store, monkeypatch):
    identity = ['engine-A']
    monkeypatch.setattr(ga, '_engine_identity', lambda: identity[0])
    monkeypatch.setattr(engine, 'status', lambda: {'available': True})
    entry_id = add()
    queued = ga.queue_analysis(entry_id)
    assert queued['payload']['engine_identity'] == 'engine-A'
    identity[0] = 'engine-B'
    monkeypatch.setattr(engine, '_run', lambda *a, **kw: pytest.fail('must not start new engine'))
    with pytest.raises(HTTPException) as exc:
        ga.analyse_game(Context(), queued['payload'])
    assert exc.value.status_code == 409
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM game_analysis_reports').fetchone()[0] == 0


def test_reverification_of_another_engine_report_requires_explicit_rerun(store, monkeypatch):
    identity = ['engine-A']
    monkeypatch.setattr(ga, '_engine_identity', lambda: identity[0])
    entry_id = add()
    calls = fake_engine(monkeypatch)
    run(entry_id)
    before = ga.get_analysis(entry_id)
    identity[0] = 'engine-B'
    payload = {'ply': 1, 'fingerprint': before['fingerprint']}
    for action in (ga.verify_finding, lambda entry, value: ga.retry_finding(entry, {**value, 'uci': 'd2d4'})):
        with pytest.raises(HTTPException) as exc:
            action(entry_id, payload)
        assert exc.value.status_code == 409
    assert len(calls) == 3
    assert ga.get_analysis(entry_id)['positions'] == before['positions']


@pytest.mark.parametrize('options,expected', [
    ({}, {'time_ms': 400, 'depth': None}),
    ({'depth': 1}, {'time_ms': None, 'depth': 1}),
    ({'depth': 64}, {'time_ms': None, 'depth': 64}),
    ({'depth': 2**31 - 1}, {'time_ms': None, 'depth': 2**31 - 1}),
    ({'depth': 64, 'time_ms': None}, {'time_ms': None, 'depth': 64}),
    ({'time_ms': 120001}, {'time_ms': 120001, 'depth': None}),
    ({'time_ms': 2**53 - 1}, {'time_ms': 2**53 - 1, 'depth': None}),
    ({'time_ms': 1000, 'depth': 18}, {'time_ms': 1000, 'depth': 18}),
])
def test_analysis_limits_follow_explicit_mode(options, expected):
    assert ga.options_of(options) == expected


def test_depth_only_report_and_exercise_preserve_actual_limit(store, monkeypatch):
    entry_id = add()
    calls = fake_engine(monkeypatch)
    run(entry_id, depth=64, time_ms=None)
    assert calls and all(call[1] is None and call[2]['depth'] == 64 for call in calls)
    report = ga.get_analysis(entry_id)
    assert report['summary']['settings'] == {'depth': 64, 'time_ms': None}
    made = ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2})
    with db.get_conn() as conn:
        game = pgnlib.load_game(conn.execute('SELECT pgn FROM entries WHERE id=?', (made['entry_id'],)).fetchone()[0])
    assert 'AnalysisTimeMs' not in game.headers
    assert game.headers['AnalysisDepth'] == '64'
