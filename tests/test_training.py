import json
from datetime import datetime, timezone

import chess
import pytest
from fastapi import HTTPException
from pydantic import ValidationError

import db
import engine
import training


@pytest.fixture()
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'test.sqlite3')
    db.init_db()
    training.init_training()


def base(settings=None, name='Étude'):
    configuration = {'review_enabled': True, 'type': 'moves', 'color': 'white',
                     'mode': 'hybrid', 'new_limit': 10, 'spacing': 'adaptive'}
    configuration.update(settings or {})
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
                            (name,json.dumps(configuration),training.stamp())).lastrowid


def entry(base_id, pgn, selected=True, start_path=''):
    with db.get_conn() as conn:
        return conn.execute('''INSERT INTO entries(base_id,title,pgn,selected,start_path,created_at,updated_at)
                            VALUES (?,?,?,?,?,?,?)''',
                            (base_id,'Exemple',pgn,int(selected),start_path,training.stamp(),training.stamp())).lastrowid


def update_settings(base_id, **changes):
    with db.get_conn() as conn:
        row = conn.execute('SELECT settings FROM bases WHERE id=?',(base_id,)).fetchone()
        settings = json.loads(row['settings'])
        settings.update(changes)
        conn.execute('UPDATE bases SET settings=? WHERE id=?',(json.dumps(settings),base_id))


def good(card, **values):
    return training.grade_card(card['id'], training.GradeRequest(grade=values.pop('grade',2),**values))


def test_own_moves_deduplicate_with_all_accepted_answers(database):
    bid = base()
    entry(bid, '1. e4 e5 2. Nf3 Nc6 3. Bc4 *')
    entry(bid, '1. e4 e5 2. Nf3 Nc6 3. Bb5 *')
    cards = training.queue(bid)['cards']
    assert len(cards) == 3
    assert sorted(cards[-1]['answers']) == ['f1b5','f1c4']
    assert all(chess.Board(card['fen']).turn == chess.WHITE for card in cards)
    counts = training.reviews()['bases'][0]
    assert counts['total'] == counts['unseen'] == 3
    assert counts['due'] == counts['learned'] == counts['learning'] == 0


def test_history_survives_path_reorder_and_duplicate_entry_deletion(database):
    bid = base()
    first = entry(bid,'1. e4 e5 2. Nf3 *')
    second = entry(bid,'1. e4 e5 2. Nf3 *')
    before = training.queue(bid)['cards']
    target = next(card for card in before if card['answers'] == ['g1f3'])
    good(target)
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?',('1. d4 (1. e4 e5 2. Nf3) d5 *',second))
        conn.execute('DELETE FROM entries WHERE id=?',(first,))
    after = next(card for card in training.queue(bid,all=True)['cards'] if card['id'] == target['id'])
    assert after['path'] == '1.0'
    assert after['state'] == 'learned'
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM review_history WHERE card_id=?',(target['id'],)).fetchone()[0] == 1


def test_type_switch_preserves_separate_histories(database):
    bid = base()
    entry(bid,'1. e4 e5 2. Nf3 *')
    card = training.queue(bid)['cards'][0]
    good(card)
    update_settings(bid,type='play')
    practice = training.queue(bid)['cards'][0]
    assert practice['id'] != card['id'] and practice['state'] == 'unseen'
    good(practice,grade=1)
    update_settings(bid,type='moves')
    restored = next(item for item in training.queue(bid,all=True)['cards'] if item['id'] == card['id'])
    assert restored['state'] == 'learned'
    assert training.reviews()['bases'][0]['learned'] == 1


def test_due_dates_remain_real_but_legacy_daily_limit_is_ignored(database):
    bid = base({'new_limit':1})
    entry(bid,'1. e4 e5 2. Nf3 Nc6 3. Bc4 *')
    card = training.queue(bid)['cards'][0]
    result = good(card)
    assert result['interval_days'] == 5
    assert datetime.fromisoformat(result['due']) > datetime.now(timezone.utc)
    assert len(training.queue(bid, selection='learn')['cards']) == 2
    assert training.queue(bid, selection='review')['cards'] == []
    assert len(training.queue(bid,all=True)['cards']) == 3
    with db.get_conn() as conn:
        conn.execute("UPDATE review_cards SET due='2000-01-01T00:00:00+00:00' WHERE id=?",(card['id'],))
    assert training.queue(bid)['cards'][0]['id'] == card['id']
    assert training.reviews()['bases'][0]['due'] == 1


def test_auto_records_first_error_hybrid_keeps_manual_override(database):
    bid = base({'mode':'auto'})
    entry(bid,'1. e4 e5 2. Nf3 *')
    card = training.queue(bid)['cards'][0]
    result = good(card,grade=3,errors=1)
    assert result['grade'] == 0 and result['state'] == 'learning'
    assert result['interval_days'] == pytest.approx(10/1440)
    update_settings(bid,mode='hybrid')
    result = good(card,grade=3,errors=1,assisted=True)
    assert result['grade'] == 3
    with db.get_conn() as conn:
        last = conn.execute('SELECT * FROM review_history ORDER BY id DESC').fetchone()
        assert last['proposed_grade'] == 0 and last['requested_grade'] == 3 and last['assisted'] == 1


def test_assistance_downgrades_automatic_and_play_stays_manual(database):
    bid = base({'mode':'auto'})
    entry(bid,'1. e4 e5 *')
    card = training.queue(bid)['cards'][0]
    assert good(card,grade=3,assisted=True)['grade'] == 1
    update_settings(bid,type='play')
    card = training.queue(bid)['cards'][0]
    assert good(card,grade=0)['grade'] == 0


def test_start_path_and_solution_variants_preserved(database):
    bid = base({'type':'solve'})
    entry(bid,'1. e4 e5 2. Nf3 (2. Bc4 Nc6) Nc6 *',start_path='0.0')
    card = training.queue(bid)['cards'][0]
    board = chess.Board()
    board.push_san('e4'); board.push_san('e5')
    assert card['fen'] == board.fen()
    assert set(card['answers']) == {'g1f3','f1c4'}
    assert sorted(card['solutions']) == sorted([['g1f3','b8c6'],['f1c4','b8c6']])
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET start_path='9.9' WHERE base_id=?",(bid,))
    assert training.queue(bid)['cards'] == []


def test_no_unsolved_diagram_or_unselected_card(database):
    bid = base({'type':'solve'})
    entry(bid,'[SetUp "1"]\n[FEN "8/8/8/8/8/4k3/8/4K2R w K - 0 1"]\n\n*')
    entry(bid,'1. e4 *',selected=False)
    assert training.queue(bid)['cards'] == []
    update_settings(bid,type='play')
    # Position is valid with standard king/rook castling rights.
    assert len(training.queue(bid)['cards']) == 1


def test_repertoire_prefix_extension_preserves_source_and_branches(database):
    bid = base({'is_repertoire':True,'primary':True})
    target = entry(bid,'1. e4 e5 (1... c5) 2. Nf3 *')
    sid = base({'review_enabled':False})
    source_pgn = '1. e4 e5 2. Nf3 Nc6 {À retenir} 3. Bc4 $1 *'
    source = entry(sid,source_pgn)
    check = training.compatibility(source,'0.0.0.0.0')['white']
    assert check['compatible'] and check['extendable']
    assert training.extend(bid,training.ExtendRequest(entry_id=source,path='0.0.0.0.0'))['added_moves'] == 2
    with db.get_conn() as conn:
        updated = conn.execute('SELECT pgn FROM entries WHERE id=?',(target,)).fetchone()[0]
        unchanged = conn.execute('SELECT pgn FROM entries WHERE id=?',(source,)).fetchone()[0]
    assert unchanged == source_pgn
    game = training.load_game(updated)
    assert len(game.variations[0].variations) == 2
    ending = training.node_at(game,'0.0.0.0.0')
    assert 1 in ending.nags and ending.parent.comment == 'À retenir'
    assert training.extend(bid,training.ExtendRequest(entry_id=source,path='0.0.0.0.0'))['added_moves'] == 0


def test_opponent_deviation_and_isolated_fen_are_not_compatible(database):
    bid = base({'is_repertoire':True,'primary':True})
    entry(bid,'1. e4 e5 2. Nf3 *')
    sid = base({'review_enabled':False})
    deviates = entry(sid,'1. e4 c5 2. Nf3 *')
    assert not training.compatibility(deviates,'0.0.0')['white']['compatible']
    with pytest.raises(HTTPException) as error:
        training.extend(bid,training.ExtendRequest(entry_id=deviates,path='0.0.0'))
    assert error.value.status_code == 409
    diagram = entry(sid,'[SetUp "1"]\n[FEN "8/8/8/8/8/4k3/8/4K2R w K - 0 1"]\n\n*')
    assert not training.compatibility(diagram,'')['white']['compatible']


def test_empty_repertoire_accepts_standard_path(database):
    bid = base({'is_repertoire':True,'primary':True,'color':'black'})
    sid = base({'review_enabled':False})
    source = entry(sid,'1. d4 d5 2. c4 *')
    assert training.compatibility(source,'0.0.0')['black']['extendable']
    assert training.extend(bid,training.ExtendRequest(entry_id=source,path='0.0.0'))['added_moves'] == 3
    assert training.reviews()['bases'][0]['total'] == 1


def test_engine_rejects_bad_fen_history_and_unavailable(monkeypatch):
    with pytest.raises(HTTPException):
        engine.analyse('bad fen')
    with pytest.raises(HTTPException):
        engine.play(chess.STARTING_FEN,history=['e2e5'])
    with pytest.raises(HTTPException):
        engine.play(chess.STARTING_FEN,history=['e2e4'])
    monkeypatch.setenv('CHESSGYM_ENGINE','not-an-installed-engine')
    assert engine.status()['available'] is False
    with pytest.raises(HTTPException) as error:
        engine.analyse(chess.STARTING_FEN)
    assert error.value.status_code == 503
    assert training.AnalysisRequest(fen=chess.STARTING_FEN,time_ms=100000).time_ms == 100000
    with pytest.raises(ValidationError):
        training.AnalysisRequest(fen=chess.STARTING_FEN,time_ms=engine.MAX_TIME_MS + 1)


def test_history_reconstruction_recognizes_repetition():
    board = chess.Board()
    history = ['g1f3','g8f6','f3g1','f6g8'] * 2
    for move in history:
        board.push_uci(move)
    result = engine.play(board.fen(),history=history)
    assert result['game_over'] and result['result'] == '1/2-1/2' and result['uci'] is None


@pytest.mark.skipif(not engine.binary_path(),reason='Stockfish absent')
def test_real_stockfish_white_pov_multi_pv_and_legal_play():
    analysis = engine.analyse(chess.STARTING_FEN,multipv=3,time_ms=100)
    assert len(analysis['lines']) == 3
    assert len({line['uci'] for line in analysis['lines']}) == 3
    for line in analysis['lines']:
        board = chess.Board()
        for move in line['pv']:
            board.push_uci(move)
        assert line['depth'] > 0 and (line['cp'] is not None or line['mate'] is not None)
    reply = engine.play(chess.STARTING_FEN,skill=0,time_ms=100)
    assert chess.Move.from_uci(reply['uci']) in chess.Board().legal_moves
    white = engine.analyse('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1',1,100)
    black = engine.analyse('8/8/8/8/8/6k1/5q2/7K b - - 0 1',1,100)
    assert white['lines'][0]['mate'] == 1
    assert black['lines'][0]['mate'] == -1
