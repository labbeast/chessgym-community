import io
import sqlite3

import chess
import chess.pgn
import pytest

import pgnlib
import reference_store as store


def pgn(moves=(), *, white='Alice', black='Bob', result='*', fen=None, **headers):
    game = chess.pgn.Game()
    if fen:
        game.setup(chess.Board(fen))
    game.headers.update(White=white, Black=black, Event='Test', Date='2026.10.21', Result=result, **headers)
    board = game.board()
    node = game
    for uci in moves:
        move = chess.Move.from_uci(uci)
        assert move in board.legal_moves
        node = node.add_variation(move)
        board.push(move)
    return pgnlib.export_game(game)


def source(tmp_path, *games, name='games.pgn'):
    path = tmp_path / name
    path.write_text('\n\n'.join(games) + '\n\n', encoding='utf-8', newline='')
    return path


def after(*moves):
    board = chess.Board()
    for uci in moves:
        board.push_uci(uci)
    return board.fen()


def test_import_keeps_original_annotations_and_indexes_only_mainline(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    annotated = pgn(['e2e4', 'e7e5'], result='1-0', WhiteElo='1800', BlackElo='1900', TimeControl='600+0')
    annotated = annotated.replace('1. e4', '1. e4 $1 {accent é [%clk 0:09:58]} (1. d4 d5)')
    path = source(tmp_path, annotated)
    result = store.import_file(db, path)
    assert (result['status'], result['game_count'], result['indexed_positions']) == ('completed', 1, 3)
    assert result['rejected'] == 0
    read = store.read_game(db, 1)
    assert read['pgn'] == path.read_text(encoding='utf-8')
    assert read['headers']['White'] == 'Alice'
    data = store.explorer_data(db, chess.STARTING_FEN)
    assert data['total'] == data['white'] == 1
    assert data['moves'][0]['uci'] == 'e2e4'
    assert data['moves'][0]['average_rating'] == 1800
    assert store.explorer_data(db, after('e2e4'))['moves'][0]['average_rating'] == 1900
    assert store.search_position(db, after('d2d4'))['total'] == 0
    end = store.search_position(db, after('e2e4', 'e7e5'))
    assert end['matches'][0]['ply'] == 2 and end['matches'][0]['san'] == 'e5'
    assert store.explorer_data(db, after('e2e4', 'e7e5'))['terminal_count'] == 1


def test_resume_and_duplicates_are_atomic_and_result_independent(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    first = pgn(['e2e4'], result='1-0')
    second = pgn(['d2d4'], white='Carole')
    corrected_copy = first.replace('1-0', '0-1').replace('1. e4', '1. e4 {different comment}')
    path = source(tmp_path, first, second, corrected_copy)
    report = store.import_file(db, path, max_games=1, batch_size=1)
    assert report['status'] == 'paused' and report['limit_reached']
    assert report['processed'] == report['imported'] == report['game_count'] == 1
    report = store.import_file(db, path, batch_size=1)
    assert report['status'] == 'completed'
    assert (report['processed'], report['imported'], report['duplicates'], report['game_count']) == (3, 2, 1, 2)
    assert store.import_file(db, path)['processed'] == 3
    assert store.explorer_data(db, chess.STARTING_FEN)['white'] == 1
    # A new file can add games while retaining global corpus totals.
    new = source(tmp_path, second, pgn(['c2c4'], white='David'), name='other.pgn')
    report = store.import_file(db, new)
    assert (report['processed'], report['imported'], report['duplicates'], report['game_count']) == (2, 1, 1, 3)


def test_failure_rolls_back_rows_and_checkpoint_together(tmp_path, monkeypatch):
    db = tmp_path / 'reference.sqlite3'
    path = source(tmp_path, *(pgn(['e2e4'], white=str(i)) for i in range(4)))
    original = store._insert_game
    calls = 0

    def fail_third(conn, parsed, raw):
        nonlocal calls
        calls += 1
        if calls == 3:
            raise sqlite3.OperationalError('simulated disk failure')
        return original(conn, parsed, raw)

    monkeypatch.setattr(store, '_insert_game', fail_third)
    report = store.import_file(db, path, batch_size=2)
    assert report['status'] == 'failed' and report['game_count'] == report['processed'] == 2
    monkeypatch.setattr(store, '_insert_game', original)
    report = store.import_file(db, path, batch_size=2)
    assert report['status'] == 'completed' and report['game_count'] == report['processed'] == 4
    assert store.list_games(db)['total'] == 4


def test_cancel_commits_partial_batch_and_can_resume(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    path = source(tmp_path, *(pgn(['e2e4'], white=str(i)) for i in range(3)))
    calls = 0

    def cancel():
        nonlocal calls
        calls += 1
        return calls >= 2

    report = store.import_file(db, path, cancelled=cancel)
    assert report['status'] == 'paused' and report['game_count'] == 1
    assert not report['limit_reached']
    assert store.import_file(db, path)['game_count'] == 3


def test_repeated_positions_count_once_and_unknown_results_are_not_draws(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    loop = ['g1f3', 'g8f6', 'f3g1', 'f6g8']
    store.import_file(db, source(tmp_path, pgn(loop + ['d2d4']), pgn(loop, white='Other'), pgn([], white='Root')))
    data = store.explorer_data(db, chess.STARTING_FEN)
    assert data['total'] == data['unknown'] == 2 and data['draws'] == 0
    assert data['terminal_count'] == 1
    assert [move['uci'] for move in data['moves']] == ['g1f3']
    found = store.search_position(db, chess.STARTING_FEN)
    assert found['total'] == 3
    assert all(row['ply'] == 0 for row in found['matches'])


def test_position_identity_castling_turn_and_legal_en_passant():
    board = chess.Board()
    key = store.position_key(board)
    assert len(key) == 58
    board.fullmove_number = 98
    board.halfmove_clock = 42
    assert store.position_key(board) == key
    board.turn = chess.BLACK
    assert store.position_key(board) != key
    board.turn = chess.WHITE
    board.castling_rights = chess.BB_A1
    assert store.position_key(board) != key
    board = chess.Board(after('e2e4'))
    board.ep_square = chess.E3
    no_legal_ep = store.position_key(board)
    board.ep_square = None
    assert store.position_key(board) == no_legal_ep
    board = chess.Board(after('e2e4', 'a7a6', 'e4e5', 'd7d5'))
    legal_ep = store.position_key(board)
    board.ep_square = None
    assert store.position_key(board) != legal_ep


def test_transposition_and_fen_root(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    root = after('g1f3', 'd7d5', 'g2g3')
    store.import_file(db, source(tmp_path,
        pgn(['g1f3', 'd7d5', 'g2g3', 'g8f6']),
        pgn(['g2g3', 'd7d5', 'g1f3', 'c7c5'], white='Other'),
        pgn(['b8c6'], white='Diagram', fen=root)))
    data = store.explorer_data(db, ' '.join(root.split()[:4]) + ' 99 200')
    assert data['total'] == 3
    assert {move['uci'] for move in data['moves']} == {'g8f6', 'c7c5', 'b8c6'}


@pytest.mark.parametrize('invalid', [
    '[Event "Bad"]\n[Result "bad"]\n\n1. e4 *',
    '[Event "Bad"]\n[Result "1-0"]\n\n1. e4 0-1',
    '[Event "Bad"]\n[Event "Duplicate"]\n\n1. e4 *',
    '[Event Bad]\n\n1. e4 *',
    '[Variant "Atomic"]\n\n1. e4 *',
    '[Event "Bad"]\n\n1. e4 e6 2. Bh6 *',
    '[Event "Bad"]\n\n1. e4 (1. d4 e5 2. Ba6) *',
    '[Event "Bad"]\n\n1. e4 garbage *',
    '[Event "Bad"]\n\n1. -- *',
])
def test_rejects_invalid_records_without_discarding_following_games(tmp_path, invalid):
    db = tmp_path / 'reference.sqlite3'
    report = store.import_file(db, source(tmp_path, invalid, pgn(['e2e4'])))
    assert report['status'] == 'completed'
    assert report['processed'] == 2 and report['rejected'] == report['imported'] == 1
    assert report['rejections'][0]['reason']


def test_journal_is_bounded_and_invalid_encoding_is_explicit(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    path = source(tmp_path, *['[Event "Bad"]\n\n1. bad *'] * 30)
    with path.open('ab') as file:
        file.write(b'[Event "\xff"]\n\n1. e4 *\n\n')
    report = store.import_file(db, path)
    assert report['rejected'] == 31 and len(report['rejections']) == store.MAX_REJECTIONS
    assert report['game_count'] == 0


def test_record_split_preserves_multiline_comments(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    commented = pgn(['e2e4']).replace('1. e4', '1. e4 {text\n\n[Event "Not a header"]\ncontinued}')
    report = store.import_file(db, source(tmp_path, commented, pgn(['d2d4'], white='Other')))
    assert report['game_count'] == 2 and report['rejected'] == 0
    assert '[Event "Not a header"]' in store.read_game(db, 1)['pgn']


def test_oversized_records_recover_without_unbounded_buffers(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'MAX_GAME_BYTES', 300)
    db = tmp_path / 'reference.sqlite3'
    bad = '[Event "Large"]\n\n1. e4 {' + 'x' * 500 + '} *'
    report = store.import_file(db, source(tmp_path, bad, pgn(['d2d4'])))
    assert report['rejected'] == report['imported'] == 1


def test_pagination_filters_sort_and_escaped_search(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    path = source(tmp_path,
        pgn(['e2e4'], white='Zed', WhiteElo='1800', BlackElo='1850', TimeControl='600'),
        pgn(['d2d4'], white='Alpha', WhiteElo='1800', BlackElo='1700', TimeControl='600'),
        pgn(['c2c4'], white='Percent%', WhiteElo='1900', BlackElo='1850', TimeControl='180'),
        pgn(['g1f3'], white='No rating', TimeControl='600'))
    store.import_file(db, path)
    page = store.list_games(db, sort='white', offset=1, limit=2)
    assert page['total'] == 4 and page['has_more']
    assert [row['headers']['White'] for row in page['entries']] == ['No rating', 'Percent%']
    assert store.list_games(db, search='%')['total'] == 1
    assert store.list_games(db, rating_min=1800, rating_max=1900, speed='rapid')['total'] == 1
    assert store.explorer_data(db, chess.STARTING_FEN, rating_min=1800, rating_max=1900, speed='rapid')['total'] == 1
    assert store.explorer_data(db, chess.STARTING_FEN, from_year=2027)['total'] == 0
    with pytest.raises(ValueError):
        store.list_games(db, sort='id; DROP TABLE games')
    with pytest.raises(ValueError):
        store.read_game(db, 999)


def test_import_lock_prevents_a_second_writer(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    store.init_store(db)
    path = source(tmp_path, pgn(['e2e4']))
    with store._import_lock(db):
        with pytest.raises(ValueError, match='déjà'):
            store.import_file(db, path)
    assert store.import_file(db, path)['game_count'] == 1


def test_zstandard_stream_resume_without_duplicate_work(tmp_path):
    zstandard = pytest.importorskip('zstandard')
    db = tmp_path / 'reference.sqlite3'
    path = tmp_path / 'archive.pgn.zst'
    original = '\n\n'.join(pgn(['e2e4'], white=str(i)) for i in range(5)) + '\n\n'
    path.write_bytes(zstandard.ZstdCompressor().compress(original.encode('utf-8')))
    first = store.import_file(db, path, max_games=2)
    assert first['processed'] == first['game_count'] == 2 and first['limit_reached']
    second = store.import_file(db, path)
    assert second['processed'] == second['game_count'] == 5
    assert second['duplicates'] == 0 and second['status'] == 'completed'
    assert second['bytes_read'] == path.stat().st_size


def test_header_without_separator_and_bom(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    path = tmp_path / 'bom.pgn'
    path.write_bytes(('\ufeff' + pgn(['e2e4']) + '\n' + pgn(['d2d4'], white='Other')).encode('utf-8'))
    report = store.import_file(db, path)
    assert report['game_count'] == 2 and report['rejected'] == 0


def test_many_stores_deduplicate_before_stats_and_allow_study_exclusion(tmp_path):
    one = tmp_path / 'one.sqlite3'
    two = tmp_path / 'two.sqlite3'
    common = pgn(['e2e4'], result='1-0', WhiteElo='1800', BlackElo='1850')
    store.import_file(one, source(tmp_path, common, pgn(['d2d4'], white='D', result='1/2-1/2')))
    store.import_file(two, source(tmp_path, common.replace('1-0', '0-1'), pgn(['e2e4'], white='E', WhiteElo='1900'), name='two.pgn'))
    data = store.explorer_data_many([one, two], chess.STARTING_FEN)
    assert data['total'] == 3 and data['duplicates'] == 1 and data['white'] == 1
    assert data['game_count'] == 4 and data['game_count_is_sum']
    row = next(row for row in data['moves'] if row['uci'] == 'e2e4')
    assert row['total'] == 2 and row['rating_count'] == 2 and row['rating_sum'] == 3700 and row['average_rating'] == 1850
    reverse = store.explorer_data_many([two, one], chess.STARTING_FEN)
    assert reverse['black'] == 1 and reverse['white'] == 0
    identity = store._parse_record(common.encode()).identity
    excluded = store.explorer_data_many([one, two], chess.STARTING_FEN, exclude_identities=[identity.hex()])
    assert excluded['total'] == 2 and excluded['white'] == excluded['black'] == 0
    excluded_single = store.explorer_data_many([one], chess.STARTING_FEN, exclude_identities=[identity])
    assert excluded_single['total'] == excluded_single['draws'] == 1


def test_many_stores_filter_unknowns_and_terminals(tmp_path):
    one, two = tmp_path / 'one.sqlite3', tmp_path / 'two.sqlite3'
    common = pgn(['e2e4'], WhiteElo='1800', BlackElo='1850', TimeControl='600')
    store.import_file(one, source(tmp_path, common, pgn(['d2d4'], white='D')))
    store.import_file(two, source(tmp_path, common, pgn(['e2e4', 'e7e5'], white='E', WhiteElo='1800', BlackElo='1850', TimeControl='600'), name='two.pgn'))
    result = store.explorer_data_many([one, two], after('e2e4'), speed='rapid', rating_min=1800)
    assert result['total'] == result['unknown'] == result['terminal_count'] == 1
    assert result['duplicates'] == 1


def test_export_streams_whole_games_with_annotations(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    first = pgn(['e2e4']).replace('e4', 'e4 {note}')
    second = pgn(['d2d4'], white='Other')
    path = source(tmp_path, first, second)
    store.import_file(db, path)
    chunks = list(store.iter_pgn(db))
    assert len(chunks) == 2
    assert chunks[0].strip() == first and chunks[1].strip() == second
    assert len(pgnlib.parse_games('\n\n'.join(chunks))) == 2


def test_legacy_chessbase_encoding_is_explicit_and_retry_is_deduplicated(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    path = tmp_path / 'legacy.pgn'
    ascii_game = pgn(['e2e4'])
    accented = pgn(['d2d4'], white='André').replace('1. d4', '1. d4 {À étudier – important}')
    path.write_bytes((ascii_game + '\n\n' + accented + '\n\n').encode('cp1252'))
    initial = store.import_file(db, path)
    assert initial['imported'] == initial['rejected'] == 1
    retried = store.import_file(db, path, encoding='cp1252')
    assert retried['status'] == 'completed' and retried['encoding'] == 'cp1252'
    assert retried['game_count'] == 2 and retried['duplicates'] == retried['imported'] == 1
    assert store.read_game(db, 2)['headers']['White'] == 'André'
    assert 'À étudier – important' in store.read_game(db, 2)['pgn']
    assert path.read_bytes().decode('cp1252').strip().endswith(accented)


def test_future_schema_is_rejected_before_any_schema_changes(tmp_path):
    db = tmp_path / 'future.sqlite3'
    with sqlite3.connect(db) as conn:
        conn.execute('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)')
        conn.execute("INSERT INTO meta VALUES('schema_version','999')")
    with pytest.raises(ValueError, match='Version'):
        store.init_store(db)
    with sqlite3.connect(db) as conn:
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert tables == {'meta'}


def test_cancellation_can_interrupt_an_oversized_unclosed_comment(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'MAX_GAME_BYTES', 100)
    db = tmp_path / 'reference.sqlite3'
    path = tmp_path / 'broken.pgn'
    path.write_bytes(b'[Event "Large"]\n\n1. e4 {' + b'x' * 1000)
    report = store.import_file(db, path, cancelled=lambda: True)
    assert report['status'] == 'paused' and report['processed'] == report['game_count'] == 0


def test_utc_date_indexes_early_lichess_archives_without_changing_headers(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    historic = pgn(['e2e4'], UTCDate='2012.12.31').replace('[Date "2026.10.21"]', '[Date "????.??.??"]')
    recent = pgn(['d2d4'], white='Recent')
    store.import_file(db, source(tmp_path, recent, historic))
    assert store.list_games(db, sort='date')['entries'][0]['id'] == 2
    assert store.explorer_data(db, chess.STARTING_FEN, from_year=2012, to_year=2013)['total'] == 1
    assert store.read_game(db, 2)['headers']['Date'] == '????.??.??'
    original = store.read_game(db, 2)['pgn']
    # Upgrade metadata written by the initial importer, exactly once.
    with sqlite3.connect(db) as conn:
        conn.execute("UPDATE games SET date='????.??.??',year=NULL WHERE id=2")
        conn.execute("DELETE FROM meta WHERE key='utc_date_fallback'")
    store.init_store(db)
    store.init_store(db)
    assert store.explorer_data(db, chess.STARTING_FEN, to_year=2013)['total'] == 1
    assert store.read_game(db, 2)['pgn'] == original


def test_position_results_are_newest_first_before_paging_and_unknown_dates_last(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    dates = [('2020.12.31', '2029.01.01'), ('????.??.??', '2026.10.23'),
             ('????.??.??', None), ('0000.00.00', None), ('2026.10.22', None),
             ('2026.??.??', None), ('2026.10.??', None), ('2026.10.22', None)]
    games = [pgn(['e2e4'], white=f'Player {i}', **({'UTCDate': utc} if utc else {}))
             .replace('[Date "2026.10.21"]', f'[Date "{date}"]') for i, (date, utc) in enumerate(dates)]
    store.import_file(db, source(tmp_path, *games))
    pages = [store.search_position(db, after('e2e4'), offset=start, limit=3) for start in (0, 3, 6)]
    assert [row['game_id'] for page in pages for row in page['matches']] == [6, 7, 2, 8, 5, 1, 4, 3]
    assert [page['has_more'] for page in pages] == [True, True, False]
    assert all(page['total'] == 8 for page in pages)
    # Pages can begin after the last known date, not only cross its boundary.
    assert [row['game_id'] for row in store.search_position(db, after('e2e4'), offset=7)['matches']] == [3]
    assert store.search_position(db, after('e2e4'), offset=9)['matches'] == []
    assert store.search_position(db, after('e2e4'), summary=True)['matches'] == []


def test_frequent_position_reads_date_index_before_limiting_headers(tmp_path, monkeypatch):
    from contextlib import contextmanager
    db = tmp_path / 'reference.sqlite3'
    store.init_store(db)
    key = store.position_key(chess.Board())
    with sqlite3.connect(db) as conn:
        conn.executemany('''INSERT INTO games(id,identity,identity_payload,title,headers,pgn,
            white,black,event,date,year,outcome,plies) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''',
            ((i, b'', b'', 'Game', '{}', b'', 'W', 'B', 'Test',
              '2027.01.01' if i == 1 else '2026.01.01', 2026, '*', 0) for i in range(1, 10005)))
        conn.executemany('INSERT INTO positions(position_key,game_id,ply,san) VALUES(?,?,0,?)',
                         ((key, i, '') for i in range(1, 10005)))
        store._set_meta(conn, 'totals', {'game_count': 10004, 'indexed_positions': 10004})
    original, queries = store._connect, []
    @contextmanager
    def traced(*args, **options):
        with original(*args, **options) as conn:
            conn.set_trace_callback(queries.append)
            yield conn
    monkeypatch.setattr(store, '_connect', traced)
    first = store.search_position(db, chess.STARTING_FEN, limit=2)
    next_page = store.search_position(db, chess.STARTING_FEN, offset=2, limit=2)
    assert [row['game_id'] for row in first['matches']] == [1, 10004]
    assert [row['game_id'] for row in next_page['matches']] == [10003, 10002]
    query = next(query for query in queries if 'CROSS JOIN positions' in query)
    with sqlite3.connect(db) as conn:
        plan = [row[-1] for row in conn.execute('EXPLAIN QUERY PLAN ' + query)]
    assert any('COVERING INDEX games_date' in step for step in plan)
    assert any('PRIMARY KEY (position_key=? AND game_id=?)' in step for step in plan)
    # The only temporary sort is outside the limited page, not over all hits.
    assert sum('TEMP B-TREE' in step for step in plan) == 1


def test_semantic_identity_collision_never_discards_a_different_game(tmp_path, monkeypatch):
    class Collision:
        def digest(self):
            return b'X' * 32

    monkeypatch.setattr(store.hashlib, 'sha256', lambda value: Collision())
    one, two = tmp_path / 'one.sqlite3', tmp_path / 'two.sqlite3'
    first, second = pgn(['e2e4']), pgn(['d2d4'])
    report = store.import_file(one, source(tmp_path, first, second, first))
    assert report['game_count'] == 2 and report['duplicates'] == 1
    store.import_file(two, source(tmp_path, second, name='two.pgn'))
    combined = store.explorer_data_many([one, two], chess.STARTING_FEN)
    assert combined['total'] == 2 and combined['duplicates'] == 1


def test_multi_speed_and_unknown_filters_use_only_real_metadata(tmp_path):
    db = tmp_path / 'reference.sqlite3'
    games = [
        pgn(['e2e4'], white='Rapid', WhiteElo='1700', BlackElo='1900', TimeControl='600'),
        pgn(['d2d4'], white='Blitz', WhiteElo='1800', BlackElo='1850', TimeControl='180+2'),
        pgn(['c2c4'], white='Unknown', WhiteElo='1800', BlackElo='1800'),
        pgn(['g1f3'], white='Missing Elo', TimeControl='600'),
        pgn(['b2b3'], white='Opponent too strong', WhiteElo='1800', BlackElo='1901', TimeControl='600'),
    ]
    store.import_file(db, source(tmp_path, *games))
    selected = store.explorer_data(db, chess.STARTING_FEN, rating_min=1700, rating_max=1900, speeds=['rapid', 'blitz'])
    assert selected['total'] == selected['game_count'] == 2
    assert {row['uci'] for row in selected['moves']} == {'e2e4', 'd2d4'}
    unknown = store.explorer_data(db, chess.STARTING_FEN, speeds=['unknown'])
    assert unknown['total'] == unknown['game_count'] == 1
    combined = store.explorer_data(db, chess.STARTING_FEN, speeds=['rapid', 'unknown'])
    assert combined['total'] == combined['game_count'] == 4
    assert store.explorer_data(db, chess.STARTING_FEN, speeds=[])['total'] == 5
    assert store.list_games(db, speed='unknown')['total'] == 1
    assert store.list_games(db, speeds=['blitz', 'unknown'])['total'] == 2
    assert store.explorer_data(db, chess.STARTING_FEN, speed='rapid')['total'] == 3


def test_reference_duplicates_follow_filters_before_priority(tmp_path):
    one, two = tmp_path / 'one.sqlite3', tmp_path / 'two.sqlite3'
    low = pgn(['e2e4'], WhiteElo='1500', BlackElo='1550', TimeControl='600', result='1-0')
    high = low.replace('1500', '1800').replace('1550', '1900').replace('600', '180').replace('1-0', '0-1')
    store.import_file(one, source(tmp_path, low))
    store.import_file(two, source(tmp_path, high, name='other.pgn'))
    result = store.explorer_data_many([one, two], chess.STARTING_FEN, rating_min=1700, speeds=['blitz'])
    assert result['game_count'] == result['total'] == result['black'] == 1
    assert result['white'] == 0 and result['duplicates'] == 0
    both = store.explorer_data_many([one, two], chess.STARTING_FEN, speeds=['rapid', 'blitz'])
    assert both['game_count'] == 2 and both['total'] == both['white'] == both['duplicates'] == 1


def test_filtered_corpus_count_cache_is_bounded_and_tracks_new_import_batches(tmp_path, monkeypatch):
    monkeypatch.setattr(store, 'MAX_FILTER_COUNTS', 3)
    store._FILTER_COUNTS.clear()
    db = tmp_path / 'reference.sqlite3'
    first = pgn(['e2e4'], WhiteElo='1800', BlackElo='1850', TimeControl='600')
    store.import_file(db, source(tmp_path, first))
    for minimum in range(1700, 1708):
        result = store.explorer_data(db, chess.STARTING_FEN, rating_min=minimum)
        assert result['game_count'] == 1
    assert len(store._FILTER_COUNTS) <= 3
    # Same profile, changed committed corpus size: no stale count survives.
    second = pgn(['d2d4'], white='Other', WhiteElo='1800', BlackElo='1850', TimeControl='600')
    store.import_file(db, source(tmp_path, second, name='second.pgn'))
    assert store.explorer_data(db, chess.STARTING_FEN, rating_min=1707)['game_count'] == 2
    # Another store with the same game count must not share profile counts.
    other = tmp_path / 'other.sqlite3'
    store.import_file(other, source(tmp_path, pgn(['c2c4']), pgn(['g1f3'], white='No Elo'), name='third.pgn'))
    assert store.explorer_data(other, chess.STARTING_FEN, rating_min=1707)['game_count'] == 0
    assert len(store._FILTER_COUNTS) <= 3


def test_speed_filter_validation_and_legacy_argument_compatibility():
    assert store.normalize_speeds(None) == store.normalize_speeds([]) == ()
    assert store.normalize_speeds(['rapid', 'rapid', 'unknown']) == ('rapid', 'unknown')
    assert store.normalize_speeds(speed='rapid') == ('rapid',)
    assert store.normalize_speeds(['rapid'], speed='rapid') == ('rapid',)
    for kwargs in ({'speeds': 'rapid'}, {'speeds': ['other']}, {'speeds': ['blitz'], 'speed': 'rapid'}):
        with pytest.raises(ValueError):
            store.normalize_speeds(**kwargs)
