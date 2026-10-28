"""Explicit report actions never rewrite source games or reveal hidden solutions."""
import json

import chess
import pytest
from fastapi import HTTPException

import db
import engine
import game_analysis as ga
import pgnlib
from test_game_analysis import store, add, fake_engine, run, evaluation
from test_game_analysis_api import client, owner, game


def prepared(monkeypatch, pgn='1. e4 e5 *'):
    entry_id = add(pgn)
    fake_engine(monkeypatch)
    run(entry_id)
    return entry_id, ga.get_analysis(entry_id)['fingerprint']


def deep_engine(monkeypatch, scores=(100, 0), during=None):
    calls = []
    def calculate(board, time_ms, **options):
        index = len(calls)
        calls.append((board.copy(), time_ms, options))
        if during:
            during(index, board)
        # The caller must not hold a DB write transaction while Stockfish runs.
        with db.get_conn() as conn:
            conn.execute("INSERT OR REPLACE INTO preferences(key,value) VALUES('action-test','true')")
        score = scores[min(index, len(scores) - 1)]
        value = score if isinstance(score, dict) else evaluation(cp=score)
        best = chess.Move.from_uci('d2d4') if not board.move_stack else next(iter(board.legal_moves))
        assert best in board.legal_moves
        return {'lines': [{**value, 'pv': [best.uci()], 'depth': 23}]}
    monkeypatch.setattr(engine, '_run', calculate)
    return calls


def positions(entry_id):
    with db.get_conn() as conn:
        return [tuple(row) for row in conn.execute('SELECT * FROM game_analysis_positions WHERE entry_id=? ORDER BY ply', (entry_id,))]


def test_report_adds_contextual_priorities_timing_and_exact_fingerprint(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch,
        '[TimeControl "600+5"]\n\n1. e4 {[%clk 0:09:50]} e5 {[%emt 0:00:07] [%clk 0:09:58]} *')
    report = ga.get_analysis(entry_id)
    assert report['fingerprint'] == fingerprint
    assert report['summary']['priority_plies'] == [2, 1]
    assert report['summary']['by_side']['white']['priority_plies'] == [1]
    assert report['summary']['by_side']['black']['priority_plies'] == [2]
    white, black = report['findings']
    assert (white['clock'], white['elapsed']) == (590, 15)
    assert (black['clock'], black['elapsed']) == (598, 7)
    assert white['loss_win_pct'] > 0 and black['loss_win_pct'] > white['loss_win_pct']
    assert all(finding['explanation'] and not finding['verified'] and finding['exercise_ids'] == [] for finding in report['findings'])
    assert 'non personnalisé' in report['summary']['chance_method']


@pytest.mark.parametrize('side,sign', [('white', 1), ('black', -1)])
def test_large_loss_in_still_won_position_is_not_a_blunder(side, sign):
    finding = ga.classify(evaluation(cp=900 * sign), evaluation(cp=600 * sign), side, 'a2a3')
    assert finding['kind'] == 'inaccuracy'
    assert finding['theme'] == 'conversion'
    assert 5 < finding['loss_win_pct'] < 10
    assert ga.classify(evaluation(cp=-900 * sign), evaluation(cp=-1200 * sign), side, 'a2a3') is None


def test_sigmoid_is_symmetric_bounded_and_mates_have_explicit_winners():
    for cp in (-100000, -900, -100, 0, 100, 900, 100000):
        value = evaluation(cp=cp)
        assert 0 <= ga.winning_chances(value, 'white') <= 100
        assert ga.winning_chances(value, 'white') + ga.winning_chances(value, 'black') == pytest.approx(100)
    assert ga.winning_chances(evaluation(mate=0, winner='black'), 'white') == 0
    assert ga.winning_chances(evaluation(mate=3), 'white') == 100


def test_conceding_mate_in_already_lost_position_does_not_invent_a_new_blunder():
    mate = evaluation(mate=-2, winner='black')
    assert ga.classify(evaluation(cp=-1000), mate, 'white', 'a2a3')['kind'] == 'inaccuracy'
    finding = ga.classify(evaluation(cp=-900), mate, 'white', 'a2a3')
    assert finding['kind'] == 'mistake' and finding['loss_cp'] is None
    assert ga.classify(evaluation(cp=-600), mate, 'white', 'a2a3')['kind'] == 'blunder'
    assert ga.classify(evaluation(cp=0), mate, 'white', 'a2a3')['kind'] == 'blunder'


def test_missed_chance_requires_a_measured_improvement_from_previous_move():
    game = pgnlib.load_game('1. e4 e5 2. Nf3 *')
    values = {index: {**evaluation(cp=cp), 'pv': [], 'pv_san': []}
              for index, cp in enumerate((0, 0, 300, 0))}
    report = ga.build_report(game, list(game.mainline_moves()), values, ga.DEFAULT_OPTIONS)
    white = next(item for item in report['findings'] if item['ply'] == 3)
    assert white['theme'] == 'missed_chance'
    assert not any(token in white['explanation'] for token in ('d4', 'Nf3', 'c5'))


@pytest.mark.parametrize('previous_cp,theme', [(100, 'lost_advantage'), (0, 'missed_chance')])
def test_missed_chance_requires_lichess_mistake_threshold_on_previous_move(previous_cp, theme):
    game = pgnlib.load_game('1. e4 e5 2. Nf3 *')
    values = {index: evaluation(cp=cp) for index, cp in enumerate((0, previous_cp, 200, 0))}
    report = ga.build_report(game, list(game.mainline_moves()), values, ga.DEFAULT_OPTIONS)
    white = next(item for item in report['findings'] if item['ply'] == 3)
    assert white['theme'] == theme


def test_verify_only_replaces_two_scores_and_preserves_original_game(store, monkeypatch):
    source = '1. e4! {Ma note} (1. d4 d5) e5 *'
    entry_id, fingerprint = prepared(monkeypatch, source)
    before = positions(entry_id)
    calls = deep_engine(monkeypatch)
    result = ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint})
    assert result['verified'] and result['fingerprint'] == fingerprint
    assert [len(item[0].move_stack) for item in calls] == [0, 1]
    assert all(time_ms == 2000 and options['depth'] == 24 and options['cancel'] is not None for _, time_ms, options in calls)
    report = result['report']
    assert report['findings'][0]['verified']
    assert not report['findings'][1]['verified']
    assert report['summary']['by_side']['white']['verified'] == 1
    assert positions(entry_id)[2] == before[2]
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0] == source
        assert conn.execute('SELECT count(*) FROM entry_history').fetchone()[0] == 0


def test_deeper_verification_can_remove_an_initial_finding(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch)
    deep_engine(monkeypatch, scores=(0, 0))
    result = ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint})
    assert all(item['ply'] != 1 for item in result['report']['findings'])
    assert result['report']['positions'][0]['verified']


@pytest.mark.parametrize('action', ['verify_finding', 'retry_finding'])
@pytest.mark.parametrize('change', ['mainline', 'report', 'scores'])
def test_action_rejects_concurrent_changes_before_writing_or_accepting(store, monkeypatch, action, change):
    entry_id, fingerprint = prepared(monkeypatch)
    original = positions(entry_id)
    def changed(index, _board):
        if index:
            return
        with db.get_conn() as conn:
            if change == 'mainline':
                conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. d4 d5 *', entry_id))
            elif change == 'report':
                conn.execute("UPDATE game_analysis_reports SET status='running' WHERE entry_id=?", (entry_id,))
            else:
                conn.execute("UPDATE game_analysis_positions SET evaluation=? WHERE entry_id=? AND ply=2",
                             (json.dumps(evaluation(cp=777)), entry_id))
    deep_engine(monkeypatch, during=changed)
    with pytest.raises(HTTPException) as caught:
        getattr(ga, action)(entry_id, {'ply': 1, 'fingerprint': fingerprint, **({'uci': 'g1f3'} if action == 'retry_finding' else {})})
    assert caught.value.status_code == 409
    assert positions(entry_id)[:2] == original[:2]


def test_failed_second_calculation_never_partially_verifies(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch)
    before = positions(entry_id)
    def failed(index, _board):
        if index:
            raise HTTPException(503, 'No score')
    deep_engine(monkeypatch, during=failed)
    with pytest.raises(HTTPException):
        ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint})
    assert positions(entry_id) == before


def test_action_cancellation_keeps_report_untouched_and_releases_gate(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch)
    before = positions(entry_id)
    def cancelled(_board, _options, cancel):
        cancel.set()
        raise engine.AnalysisCancelled()
    monkeypatch.setattr(ga, 'evaluate_position', cancelled)
    with pytest.raises(HTTPException) as caught:
        ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint})
    assert caught.value.status_code == 503
    assert positions(entry_id) == before
    assert ga._ACTION_LOCK.acquire(blocking=False)
    ga._ACTION_LOCK.release()


@pytest.mark.parametrize('score,accepted', [(90, True), (105, True), (-150, False)])
def test_retry_accepts_equivalent_alternative_without_revealing_solution(store, monkeypatch, score, accepted):
    entry_id, fingerprint = prepared(monkeypatch)
    before = positions(entry_id)
    calls = deep_engine(monkeypatch, scores=(100, score))
    result = ga.retry_finding(entry_id, {'ply': 1, 'uci': 'g1f3', 'fingerprint': fingerprint})
    assert result['accepted'] is accepted
    assert result['uci'] == 'g1f3' and result['san'] == 'Nf3'
    assert calls[0][0].fen() == chess.STARTING_FEN and calls[1][0].peek().uci() == 'g1f3'
    assert not ({'best_san', 'best_uci', 'pv', 'pv_san', 'before', 'after', 'cp', 'mate'} & result.keys())
    assert positions(entry_id) == before


def test_retry_explicit_reveal_returns_legal_solution(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch)
    deep_engine(monkeypatch)
    result = ga.retry_finding(entry_id, {'ply': 1, 'uci': 'g1f3', 'fingerprint': fingerprint, 'reveal': True})
    assert result['best_uci'] == 'd2d4' and result['best_san'] == 'd4'
    assert result['pv'] == ['d2d4']


def test_retry_does_not_accept_losing_forced_mate_just_because_advantage_stays_large(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch)
    deep_engine(monkeypatch, scores=(evaluation(mate=2, winner='white'), 2000))
    assert not ga.retry_finding(entry_id, {'ply': 1, 'uci': 'g1f3', 'fingerprint': fingerprint})['accepted']


@pytest.mark.parametrize('payload,status', [
    ({'ply': True}, 422), ({'ply': 0}, 422), ({'ply': 3}, 422),
    ({'fingerprint': None}, 422), ({'fingerprint': '0' * 64}, 409),
    ({'unexpected': 1}, 422),
])
def test_verify_rejects_invalid_or_stale_action_before_engine(store, monkeypatch, payload, status):
    entry_id, fingerprint = prepared(monkeypatch)
    monkeypatch.setattr(engine, '_run', lambda *a, **k: pytest.fail('No engine call'))
    with pytest.raises(HTTPException) as caught:
        ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint, **payload})
    assert caught.value.status_code == status


@pytest.mark.parametrize('payload', [{'uci': 'e2e5'}, {'uci': '0000'}, {'uci': None}, {'uci': 'e2e4', 'reveal': 'true'}])
def test_retry_rejects_illegal_moves_and_nonboolean_reveal(store, monkeypatch, payload):
    entry_id, fingerprint = prepared(monkeypatch)
    monkeypatch.setattr(engine, '_run', lambda *a, **k: pytest.fail('No engine call'))
    with pytest.raises(HTTPException) as caught:
        ga.retry_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint, **payload})
    assert caught.value.status_code == 422


def test_actions_reject_running_report_and_busy_gate(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch)
    monkeypatch.setattr(engine, '_run', lambda *a, **k: pytest.fail('No engine call'))
    with db.get_conn() as conn:
        conn.execute("UPDATE game_analysis_reports SET status='running' WHERE entry_id=?", (entry_id,))
    with pytest.raises(HTTPException) as caught:
        ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint})
    assert caught.value.status_code == 409
    assert ga._ACTION_LOCK.acquire(blocking=False)
    try:
        with pytest.raises(HTTPException) as caught:
            ga.verify_finding(entry_id, {'ply': 1, 'fingerprint': fingerprint})
        assert caught.value.status_code == 503
    finally:
        ga._ACTION_LOCK.release()


def test_manual_exercise_keeps_variations_notes_and_links_without_touching_source(store, monkeypatch):
    source = '[White "Alice"]\n[Black "Bob"]\n\n1. e4 {Source note} e5 *'
    entry_id, fingerprint = prepared(monkeypatch, source)
    manual = '{Ma consigne} 1. d4! {Mon explication} (1. Nf3 d5) d5 2. c4 *'
    made = ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2, 'title': 'Mon exercice', 'pgn': manual, 'fingerprint': fingerprint})
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0] == source
        row = conn.execute('SELECT * FROM entries WHERE id=?', (made['entry_id'],)).fetchone()
        exercise = pgnlib.load_game(row['pgn'])
        assert row['title'] == 'Mon exercice'
        assert exercise.comment == 'Ma consigne'
        assert exercise.variations[0].comment == 'Mon explication'
        assert exercise.variations[0].nags == {1}
        assert [node.move.uci() for node in exercise.variations] == ['d2d4', 'g1f3']
        assert exercise.headers['SourceEntry'] == str(entry_id)
        assert exercise.headers['SourcePly'] == '1'
        assert exercise.headers['SourceFingerprint'] == fingerprint
        assert exercise.headers['SolutionSource'] == 'manual'
    assert ga.get_analysis(entry_id)['findings'][0]['exercise_ids'] == [made['entry_id']]
    duplicate = ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2, 'pgn': '1. c4 *', 'fingerprint': fingerprint})
    assert duplicate == {**made, 'duplicate': True}
    with db.get_conn() as conn:
        assert 'Mon explication' in conn.execute('SELECT pgn FROM entries WHERE id=?', (made['entry_id'],)).fetchone()[0]


@pytest.mark.parametrize('payload', [
    {'pgn': '*'}, {'pgn': '1. e5 *'}, {'pgn': None}, {'fingerprint': None},
    {'fingerprint': '0' * 64},
    {'ply': 2, 'pgn': '1. d4 *'},
    {'pgn': '[SetUp "1"]\n[FEN "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 1 1"]\n\n1. d4 *'},
])
def test_manual_exercise_rejects_invalid_empty_or_wrong_root_atomically(store, monkeypatch, payload):
    entry_id, fingerprint = prepared(monkeypatch)
    with pytest.raises(HTTPException):
        ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2, 'pgn': '1. d4 *', 'fingerprint': fingerprint, **payload})
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 1
        assert conn.execute('SELECT count(*) FROM game_analysis_exercises').fetchone()[0] == 0


def test_manual_exercise_cannot_write_to_readonly_reference(store, monkeypatch):
    entry_id, fingerprint = prepared(monkeypatch)
    with db.get_conn() as conn:
        conn.execute("INSERT INTO reference_bases(base_id,storage_key,source) VALUES(2,'abcdef','external.pgn')")
    with pytest.raises(HTTPException) as caught:
        ga.create_exercise(entry_id, {'ply': 1, 'base_id': 2, 'pgn': '1. d4 *', 'fingerprint': fingerprint})
    assert caught.value.status_code == 422


def test_verify_retry_endpoints_require_authentication(client):
    for action in ('verify', 'retry'):
        assert client.post(f'/api/game-analysis/1/{action}', json={}, headers={'Host': 'remote.invalid'}).status_code == 403


def test_http_verify_retry_and_manual_exercise_contracts(owner, monkeypatch):
    entry_id = game(owner)
    fake_engine(monkeypatch)
    run(entry_id)
    fingerprint = owner.get(f'/api/game-analysis/{entry_id}').json()['fingerprint']
    deep_engine(monkeypatch)
    response = owner.post(f'/api/game-analysis/{entry_id}/verify', json={'ply': 1, 'fingerprint': fingerprint})
    assert response.status_code == 200 and response.json()['report']['findings'][0]['verified']
    deep_engine(monkeypatch, scores=(100, 95))
    response = owner.post(f'/api/game-analysis/{entry_id}/retry', json={'ply': 1, 'uci': 'g1f3', 'fingerprint': fingerprint})
    assert response.status_code == 200 and response.json()['accepted']
    assert 'best_uci' not in response.json()
    target = owner.post('/api/bases', json={'name': 'Exercices'}).json()['id']
    response = owner.post(f'/api/game-analysis/{entry_id}/exercise', json={'ply': 1, 'base_id': target, 'pgn': '1. d4 (1. Nf3) *', 'fingerprint': fingerprint})
    assert response.status_code == 200 and not response.json()['duplicate']
    assert owner.get(f'/api/game-analysis/{entry_id}').json()['findings'][0]['exercise_ids'] == [response.json()['entry_id']]
