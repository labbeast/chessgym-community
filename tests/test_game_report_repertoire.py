"""The report compares saved move paths, never edits PGNs or queries a service."""
from contextlib import contextmanager
import json

import chess
import pytest
from fastapi import FastAPI, HTTPException
from local_test_client import TestClient

import db
import game_analysis
import game_report_repertoire as report


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'repertoire-report.sqlite3')
    db.init_db()
    return tmp_path


def base(name='Opening', color='white', primary=True, repertoire=True):
    settings = {'is_repertoire': repertoire, 'color': color, 'primary': primary}
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
                            (name, json.dumps(settings), '2026-10-23')).lastrowid


def entry(pgn, base_id=None, selected=True):
    if base_id is None:
        base_id = base('Played games', repertoire=False)
    with db.get_conn() as conn:
        return conn.execute('''INSERT INTO entries(base_id,title,pgn,selected,created_at,updated_at)
            VALUES(?,?,?,?,?,?)''', (base_id, 'Game', pgn, int(selected), '2026-10-23', '2026-10-23')).lastrowid


def compare(pgn, repertoire='1. e4 e5 2. Nf3 Nc6 *', color='white'):
    repertoire_id = base(color=color)
    entry(repertoire, repertoire_id)
    source_id = entry(pgn)
    return report.get_repertoire_comparison(source_id, color), source_id, repertoire_id


def test_primary_selection_and_saved_fingerprint_are_read_only(store):
    chosen = base('Main white')
    entry('1. e4 e5 2. Nf3 *', chosen, selected=False)
    other = base('Other white', primary=False)
    entry('1. d4 d5 *', other)
    black = base('Main black', color='black')
    entry('1. d4 Nf6 *', black)
    source_pgn = '[Event "Stored"]\n\n1. e4 {Stored note} e5 2. Nf3 *'
    source = entry(source_pgn)
    with db.get_conn() as conn:
        before = [tuple(row) for row in conn.execute('SELECT * FROM entries ORDER BY id')]
    result = report.get_repertoire_comparison(source, 'white')
    assert result['status'] == 'inside'
    assert result['base_id'] == chosen
    assert result['name'] == 'Main white'
    assert result['covered_plies'] == result['total_plies'] == 3
    assert result['first_exit'] is None
    assert result['source_fingerprint'] == game_analysis.game_snapshot(source_pgn)[2]
    assert result['choices'] == [
        {'id': chosen, 'name': 'Main white', 'primary': True},
        {'id': other, 'name': 'Other white', 'primary': False},
    ]
    with db.get_conn() as conn:
        assert [tuple(row) for row in conn.execute('SELECT * FROM entries ORDER BY id')] == before


@pytest.mark.parametrize('color,pgn,kind,ply,san,expected', [
    ('white', '1. e4 e5 2. Bc4 *', 'own_deviation', 3, 'Bc4', 'Nf3'),
    ('white', '1. e4 c5 *', 'opponent_gap', 2, 'c5', 'e5'),
    ('black', '1. e4 c5 *', 'own_deviation', 2, 'c5', 'e5'),
    ('black', '1. e4 e5 2. Bc4 *', 'opponent_gap', 3, 'Bc4', 'Nf3'),
])
def test_first_exit_distinguishes_player_and_opponent(store, color, pgn, kind, ply, san, expected):
    result, _, _ = compare(pgn, color=color)
    assert result['status'] == 'exit'
    exit = result['first_exit']
    assert exit['kind'] == kind and exit['ply'] == ply and exit['san'] == san
    assert exit['known_until_ply'] == result['covered_plies'] == ply - 1
    assert exit['before_path'] == '.'.join(['0'] * (ply - 1))
    assert exit['path'] == '.'.join(['0'] * ply)
    board = chess.Board(exit['fen'])
    assert board.san(chess.Move.from_uci(exit['uci'])) == san
    board.push_uci(exit['uci'])
    assert board.fen() == exit['after_fen']
    assert [move['san'] for move in exit['expected']] == [expected]
    assert exit['transposition'] is False and exit['rejoins_at_ply'] is None


@pytest.mark.parametrize('color', ['white', 'black'])
def test_finishing_known_line_is_not_mislabelled_a_personal_error(store, color):
    result, _, _ = compare('1. e4 e5 2. Nf3 Nc6 *', repertoire='1. e4 e5 *', color=color)
    assert result['status'] == 'exit'
    assert result['covered_plies'] == 2
    assert result['first_exit']['kind'] == 'line_end'
    assert result['first_exit']['ply'] == 3
    assert result['first_exit']['expected'] == []
    assert 'prolonge' in result['message']


def test_ending_at_repertoire_leaf_and_empty_played_line_are_inside(store):
    result, _, repertoire_id = compare('1. e4 e5 *', repertoire='1. e4 e5 *')
    assert result['status'] == 'inside' and result['covered_plies'] == 2
    result = report.get_repertoire_comparison(entry('*'), 'white', repertoire_id)
    assert result['status'] == 'inside' and result['covered_plies'] == result['total_plies'] == 0


def test_all_repertoire_variations_are_covered_and_source_variations_are_ignored(store):
    repertoire = '1. e4 (1. d4 d5) e5 (1... c5 2. Nf3) 2. Nf3 *'
    result, _, _ = compare('1. e4 (1. a4 a5) c5 2. Nf3 *', repertoire)
    assert result['status'] == 'inside' and result['covered_plies'] == 3


def test_expected_moves_retain_mainline_then_variation_order(store):
    result, _, _ = compare('1. c4 *', '1. e4 (1. d4) *')
    assert result['first_exit']['expected'] == [{'uci': 'e2e4', 'san': 'e4'}, {'uci': 'd2d4', 'san': 'd4'}]


def test_transposition_never_erases_first_deviation(store):
    result, _, _ = compare('1. Nf3 d5 2. d4 Nf6 *', '1. d4 d5 2. Nf3 Nf6 *')
    assert result['status'] == 'exit' and result['covered_plies'] == 0
    exit = result['first_exit']
    assert exit['kind'] == 'own_deviation' and exit['ply'] == 1
    assert exit['transposition'] is True and exit['rejoins_at_ply'] == 3
    assert 'transposition' in result['message']


def test_known_position_edges_do_not_mix_distinct_opening_paths(store):
    repertoire_id = base()
    entry('1. Nf3 d5 2. d4 e6 *', repertoire_id)
    entry('1. d4 d5 2. Nf3 Nf6 *', repertoire_id)
    result = report.get_repertoire_comparison(entry('1. Nf3 d5 2. d4 Nf6 *'), 'white')
    assert result['status'] == 'exit'
    assert result['covered_plies'] == 3
    assert result['first_exit']['kind'] == 'opponent_gap'
    assert result['first_exit']['expected'] == [{'uci': 'e7e6', 'san': 'e6'}]
    assert result['first_exit']['transposition'] is True
    assert result['first_exit']['rejoins_at_ply'] == 4


def test_no_primary_keeps_options_and_explicit_choice_is_respected(store):
    source = entry('1. d4 d5 *')
    none = report.get_repertoire_comparison(source, 'white')
    assert none['status'] == 'no_repertoire' and none['choices'] == []
    alternative = base('Alternative', primary=False)
    entry('1. d4 d5 *', alternative)
    result = report.get_repertoire_comparison(source, 'white')
    assert result['status'] == 'no_repertoire' and result['reason'] == 'no_primary'
    assert result['base_id'] is None and result['choices'][0]['id'] == alternative
    assert report.get_repertoire_comparison(source, 'white', alternative)['status'] == 'inside'
    main = base('Main')
    entry('1. e4 *', main)
    assert report.get_repertoire_comparison(source, 'white')['base_id'] == main
    assert report.get_repertoire_comparison(source, 'white', alternative)['status'] == 'inside'


def test_invalid_or_wrong_color_choice_is_rejected(store):
    source = entry('1. e4 *')
    ordinary, black = base(repertoire=False), base(color='black')
    for chosen, status in [(ordinary, 422), (black, 422), (9999, 404), (0, 422)]:
        with pytest.raises(HTTPException) as error:
            report.get_repertoire_comparison(source, 'white', chosen)
        assert error.value.status_code == status
    with pytest.raises(HTTPException) as error:
        report.get_repertoire_comparison(9999, 'white')
    assert error.value.status_code == 404


def test_partial_fen_source_and_null_move_have_explicit_unavailability(store):
    fen = chess.Board()
    fen.push_san('e4')
    result, _, _ = compare(f'[SetUp "1"]\n[FEN "{fen.fen()}"]\n\n1... e5 *')
    assert result['status'] == 'unavailable' and result['reason'] == 'partial_source'
    assert result['first_exit'] is None and 'FEN' in result['message']
    result = report.get_repertoire_comparison(entry('1. e4 -- *'), 'white')
    # The shared strict PGN parser already rejects null main-line moves.
    assert result['status'] == 'unavailable' and result['reason'] == 'invalid_source'


def test_invalid_and_partial_repertoires_are_not_reported_as_exact_coverage(store):
    repertoire_id = base()
    source = entry('1. e4 *')
    result = report.get_repertoire_comparison(source, 'white')
    assert result['reason'] == 'empty_repertoire'
    fen = chess.Board()
    fen.push_san('e4')
    partial_id = entry(f'[SetUp "1"]\n[FEN "{fen.fen()}"]\n\n1... e5 *', repertoire_id)
    result = report.get_repertoire_comparison(source, 'white')
    assert result['status'] == 'unavailable' and result['reason'] == 'partial_repertoire'
    entry('1. e4 *', repertoire_id)
    result = report.get_repertoire_comparison(source, 'white')
    assert result['status'] == 'inside' and result['ignored_partial_entries'] == 1
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('not valid PGN data', partial_id))
    result = report.get_repertoire_comparison(source, 'white')
    assert result['status'] == 'unavailable' and result['reason'] == 'invalid_repertoire'


@pytest.mark.parametrize('limit,value', [('MAX_GRAPH_NODES', 1), ('MAX_REPERTOIRE_BYTES', 1), ('MAX_REPERTOIRE_ENTRIES', 0)])
def test_limits_return_unavailable_instead_of_a_partial_comparison(store, monkeypatch, limit, value):
    repertoire_id = base()
    entry('1. e4 e5 *', repertoire_id)
    source = entry('1. e4 e5 *')
    monkeypatch.setattr(report, limit, value)
    result = report.get_repertoire_comparison(source, 'white')
    assert result['status'] == 'unavailable' and result['reason'] == 'repertoire_limit'
    assert result['first_exit'] is None and result['covered_plies'] == 0


def test_http_contract_validates_query_and_uses_selected_repertoire(store):
    result, source, repertoire_id = compare('1. e4 *')
    app = FastAPI()
    app.include_router(report.router)
    with TestClient(app) as client:
        response = client.get(f'/api/game-analysis/{source}/repertoire?color=white&base_id={repertoire_id}')
        assert response.status_code == 200 and response.json() == result
        assert client.get(f'/api/game-analysis/{source}/repertoire?color=purple').status_code == 422
        assert client.get(f'/api/game-analysis/{source}/repertoire?color=white&base_id=-1').status_code == 422
        assert client.get(f'/api/game-analysis/{source}/repertoire').status_code == 422


def test_pgn_parsing_runs_after_sqlite_snapshot_is_closed(store, monkeypatch):
    repertoire_id = base()
    entry('1. e4 e5 *', repertoire_id)
    source = entry('1. e4 e5 *')
    read_conn, load_game = db.read_conn, report.pgnlib.load_game
    active, parsed = [], []

    @contextmanager
    def tracked_read():
        with read_conn() as conn:
            active.append(conn)
            try:
                yield conn
            finally:
                active.pop()

    def parse(pgn):
        assert active == [], 'Repertoire parsing must not retain the SQLite read transaction'
        parsed.append(pgn)
        return load_game(pgn)

    monkeypatch.setattr(db, 'read_conn', tracked_read)
    monkeypatch.setattr(report.pgnlib, 'load_game', parse)
    assert report.get_repertoire_comparison(source, 'white')['status'] == 'inside'
    assert len(parsed) == 2
