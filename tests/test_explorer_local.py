import chess
import chess.pgn
import pytest

import db
import explorer_local as explorer
import pgnlib


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'explorer-test.sqlite3')
    db.init_db()
    explorer.clear_cache()
    yield
    explorer.clear_cache()


def new_base(name='Games'):
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)', (name, 'stamp')).lastrowid


def add(base, pgn):
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)', (base, 'Game', pgn, 'stamp', 'stamp')).lastrowid


def pgn(moves=(), *, fen=chess.STARTING_FEN, white='A', black='B', date='2026.10.19', result='*', white_elo=None, black_elo=None):
    board = chess.Board(fen)
    game = chess.pgn.Game()
    game.setup(board)
    game.headers.update(White=white, Black=black, Date=date, Result=result)
    if white_elo is not None:
        game.headers['WhiteElo'] = str(white_elo)
    if black_elo is not None:
        game.headers['BlackElo'] = str(black_elo)
    node = game
    for uci in moves:
        move = chess.Move.from_uci(uci)
        assert move in board.legal_moves
        node = node.add_variation(move)
        board.push(move)
    return pgnlib.export_game(game)


def after(*moves):
    board = chess.Board()
    for move in moves:
        board.push_uci(move)
    return board.fen()


def by_move(data):
    return {row['uci']: row for row in data['moves']}


def test_mainlines_results_unknown_and_side_to_move_rating():
    base = new_base()
    annotated = pgn(['e2e4', 'e7e5'], result='1-0', white_elo=1700, black_elo=1600)
    annotated = annotated.replace('1. e4', '1. e4 $1 {Mainline} (1. d4 d5)')
    add(base, annotated)
    add(base, pgn(['e2e4', 'c7c5'], white='C', result='1/2-1/2', white_elo=1800, black_elo=1500))
    add(base, pgn(['e2e4', 'e7e5'], white='D', result='0-1'))
    add(base, pgn(['d2d4', 'd7d5'], white='E', result='*', white_elo='?'))
    data = explorer.local_data(chess.STARTING_FEN, [base])
    assert (data['white'], data['draws'], data['black'], data['unknown'], data['total']) == (1, 1, 1, 1, 4)
    assert data['game_count'] == 4
    rows = by_move(data)
    assert rows['e2e4']['total'] == 3 and rows['e2e4']['average_rating'] == 1750
    assert rows['d2d4']['unknown'] == 1 and rows['d2d4']['draws'] == 0
    assert 'average_rating' not in rows['d2d4']
    assert data['moves'][0]['uci'] == 'e2e4'
    replies = by_move(explorer.local_data(after('e2e4'), [base]))
    assert replies['e7e5']['average_rating'] == 1600
    assert replies['c7c5']['average_rating'] == 1500
    # A line found only in a variation is never another played game.
    assert explorer.local_data(after('d2d4'), [base])['total'] == 1


def test_transpositions_ignore_clocks_but_keep_side_to_move():
    base = new_base()
    add(base, pgn(['g1f3', 'd7d5', 'g2g3', 'g8f6']))
    add(base, pgn(['g2g3', 'd7d5', 'g1f3', 'c7c5'], white='C'))
    fen = after('g1f3', 'd7d5', 'g2g3')
    alternate_counters = ' '.join(fen.split()[:4]) + ' 99 200'
    data = explorer.local_data(alternate_counters, [base])
    assert data['total'] == 2
    assert set(by_move(data)) == {'g8f6', 'c7c5'}
    other_side = fen.replace(' b ', ' w ')
    assert explorer.local_data(other_side, [base])['total'] == 0


def test_repeated_position_first_outgoing_move_counts_once():
    base = new_base()
    loop = ['g1f3', 'g8f6', 'f3g1', 'f6g8']
    add(base, pgn(loop + ['d2d4', 'd7d5']))
    add(base, pgn(loop, white='C'))
    add(base, pgn([], white='Terminal'))
    data = explorer.local_data(chess.STARTING_FEN, [base])
    assert data['total'] == 2
    assert data['terminal_count'] == 1
    assert set(by_move(data)) == {'g1f3'}
    assert by_move(data)['g1f3']['total'] == 2


def test_terminal_positions_are_reported_outside_next_move_total():
    base = new_base()
    add(base, pgn(['e2e4'], result='1-0'))
    add(base, pgn(['e2e4', 'c7c5'], white='C', result='0-1'))
    data = explorer.local_data(after('e2e4'), [base])
    assert data['terminal_count'] == 1
    assert data['total'] == 1 and data['black'] == 1 and data['white'] == 0
    leaf = explorer.local_data(after('e2e4', 'c7c5'), [base])
    assert leaf['total'] == 0 and leaf['terminal_count'] == 1


def test_fen_starts_black_and_castling_rights_are_distinct():
    base = new_base()
    fen = 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 12'
    add(base, pgn(['e8g8'], fen=fen, black_elo=2200))
    no_rights = fen.replace('KQkq', '-')
    add(base, pgn(['a8a7'], fen=no_rights))
    data = explorer.local_data(fen, [base])
    assert data['total'] == 1
    assert data['moves'][0]['uci'] == 'e8g8'
    assert data['moves'][0]['san'] == 'O-O'
    assert data['moves'][0]['average_rating'] == 2200
    assert set(by_move(explorer.local_data(no_rights, [base]))) == {'a8a7'}


def test_only_legal_en_passant_changes_position_identity():
    base = new_base()
    ep = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'
    no_ep = ep.replace('d6', '-')
    add(base, pgn(['e5d6'], fen=ep))
    add(base, pgn(['e5e6'], fen=no_ep))
    assert set(by_move(explorer.local_data(ep, [base]))) == {'e5d6'}
    assert set(by_move(explorer.local_data(no_ep, [base]))) == {'e5e6'}
    # A pinned pawn cannot capture EP; this target does not distinguish positions.
    pinned = 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'
    pinned_without = pinned.replace('d6', '-')
    assert explorer.position_key(chess.Board(pinned)) == explorer.position_key(chess.Board(pinned_without))
    add(base, pgn(['e1f2'], fen=pinned, white='Pinned'))
    add(base, pgn(['e1f2'], fen=pinned_without, white='Other'))
    assert explorer.local_data(pinned, [base])['total'] == 2


def test_duplicates_across_bases_ignore_annotations_but_keep_games():
    first, second = new_base('First'), new_base('Second')
    original = pgn(['e2e4', 'e7e5'], result='1-0')
    add(first, original)
    annotated = original.replace('1. e4', '1. e4 $3 {Comment [%clk 0:10:00]} (1. d4 d5)')
    add(second, annotated)
    add(second, original.replace('1-0', '0-1'))
    add(second, pgn(['e2e4', 'e7e5'], date='2026.10.20'))
    add(second, pgn(['e2e4', 'e7e5'], white='Different player'))
    data = explorer.local_data(chess.STARTING_FEN, [second, first, first])
    assert data['total'] == 3 and data['game_count'] == 3 and data['duplicates'] == 2
    assert data['white'] == 1 and data['black'] == 0 and data['unknown'] == 2


def test_invalid_records_never_contribute_a_partial_game():
    base = new_base()
    add(base, '1. e4 e5 2. Bh6 *')
    add(base, '1. e4 garbage e5 *')
    add(base, '')
    add(base, pgn(['e2e4']) + '\n\n' + pgn(['d2d4']))
    add(base, '[Variant "Chess960"]\n\n1. e4 *')
    add(base, pgn(['g1f3']))
    data = explorer.local_data(chess.STARTING_FEN, [base])
    assert data['invalid_entries'] == 5
    assert data['game_count'] == 1 and data['total'] == 1
    assert set(by_move(data)) == {'g1f3'}


def test_cache_reuses_mainlines_and_invalidates_same_timestamp_edits(monkeypatch):
    base = new_base()
    e4 = pgn(['e2e4', 'e7e5'])
    d4 = pgn(['d2d4', 'd7d5'])
    entry = add(base, e4)
    parser = explorer._parse_entry
    calls = []
    def spy(text):
        calls.append(text)
        return parser(text)
    monkeypatch.setattr(explorer, '_parse_entry', spy)
    explorer.local_data(chess.STARTING_FEN, [base])
    explorer.local_data(after('e2e4'), [base])
    assert calls == [e4]
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET title=?,updated_at=? WHERE id=?', ('Retitled', 'later', entry))
    explorer.local_data(chess.STARTING_FEN, [base])
    assert calls == [e4]
    # Content signature catches edits even if a restored timestamp is unchanged.
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', (d4, entry))
    assert set(by_move(explorer.local_data(chess.STARTING_FEN, [base]))) == {'d2d4'}
    assert calls == [e4, d4]
    # Undo restores content; no old result survives in the derived index.
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', (e4, entry))
    assert set(by_move(explorer.local_data(chess.STARTING_FEN, [base]))) == {'e2e4'}
    assert calls == [e4, d4, e4]
    add(base, pgn(['g1f3'], white='C'))
    assert explorer.local_data(chess.STARTING_FEN, [base])['total'] == 2
    assert len(calls) == 4
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?', (entry,))
    assert set(by_move(explorer.local_data(chess.STARTING_FEN, [base]))) == {'g1f3'}
    assert len(calls) == 4
    with db.get_conn() as conn:
        conn.execute('DELETE FROM bases WHERE id=?', (base,))
    assert explorer.local_data(chess.STARTING_FEN, [base])['total'] == 0


def test_cache_rebuilds_promoted_mainline_without_counting_variations():
    base = new_base()
    original = pgn(['e2e4', 'e7e5']).replace('1. e4', '1. e4 (1. d4 d5)')
    entry = add(base, original)
    assert set(by_move(explorer.local_data(chess.STARTING_FEN, [base]))) == {'e2e4'}
    game = pgnlib.load_game(original)
    game.variations.reverse()
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', (pgnlib.export_game(game), entry))
    assert set(by_move(explorer.local_data(chess.STARTING_FEN, [base]))) == {'d2d4'}


def test_cache_retention_is_bounded_but_large_bases_remain_queryable(monkeypatch):
    monkeypatch.setattr(explorer, 'MAX_CACHE_BASES', 2)
    monkeypatch.setattr(explorer, 'MAX_CACHE_POSITIONS', 4)
    monkeypatch.setattr(explorer, 'MAX_CACHE_ENTRIES', 3)
    bases = [new_base(str(i)) for i in range(4)]
    for i, base in enumerate(bases):
        add(base, pgn(['e2e4'], white=str(i)))
        assert explorer.local_data(chess.STARTING_FEN, [base])['total'] == 1
    assert len(explorer._CACHE) == 2
    assert sum(item.size for item in explorer._CACHE.values()) <= 4
    add(bases[-1], pgn(['d2d4', 'd7d5', 'c2c4'], white='Longer'))
    assert explorer.local_data(chess.STARTING_FEN, [bases[-1]])['total'] == 2
    assert (str(db.DB_PATH.resolve()), bases[-1]) not in explorer._CACHE
    assert explorer.local_data(chess.STARTING_FEN, bases)['total'] == 5
    assert sum(item.size for item in explorer._CACHE.values()) <= 4


def test_no_selected_base_and_invalid_position():
    assert explorer.local_data(chess.STARTING_FEN, [])['moves'] == []
    with pytest.raises(ValueError):
        explorer.local_data('invalid FEN', [])


def test_same_day_same_players_and_moves_keep_distinct_rounds_times_or_links():
    base = new_base()
    original = pgn(['e2e4', 'e7e5'], result='1-0')
    game = pgnlib.load_game(original)
    game.headers.update(Event='Swiss', Site='Club', Round='1', UTCDate='2026.10.19', UTCTime='12:00:00', Time='08:00:00', Link='https://example.test/game/1')
    first = pgnlib.export_game(game)
    add(base, first)
    add(base, first.replace('1. e4', '1. e4 $1 {New comment} (1. c4 e5)'))
    for field, value in (('Round', '2'), ('Event', 'Other event'), ('Site', 'Other club'),
                         ('UTCDate', '2026.10.20'), ('UTCTime', '13:00:00'),
                         ('Time', '09:00:00'), ('Link', 'https://example.test/game/2')):
        different = pgnlib.load_game(first)
        different.headers[field] = value
        add(base, pgnlib.export_game(different))
    data = explorer.local_data(chess.STARTING_FEN, [base])
    assert data['game_count'] == data['total'] == 8
    assert data['duplicates'] == 1


def with_headers(text, **headers):
    game = pgnlib.load_game(text)
    game.headers.update(headers)
    return pgnlib.export_game(game)


def reference_base(tmp_path, *games):
    import reference_library
    import reference_store
    base = new_base('Reference')
    key = f'{base:032x}'
    source = tmp_path / f'reference-{base}.pgn'
    source.write_text('\n\n'.join(games), encoding='utf-8')
    reference_store.import_file(reference_library.store_path(key), source)
    with db.get_conn() as conn:
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source) VALUES(?,?,?)',
                     (base, key, str(source)))
    return base


def test_study_filters_both_players_and_multiple_speeds_without_reparsing(monkeypatch):
    base = new_base()
    add(base, with_headers(pgn(['e2e4'], white='A', white_elo=1700, black_elo=1900), TimeControl='600'))
    add(base, with_headers(pgn(['d2d4'], white='B', white_elo=1700, black_elo=1901), TimeControl='600'))
    add(base, with_headers(pgn(['c2c4'], white='C', white_elo=1800, black_elo=1750), TimeControl='180+2'))
    add(base, with_headers(pgn(['g1f3'], white='D'), TimeControl='600'))
    add(base, with_headers(pgn(['b2b3'], white='E', white_elo=1800, black_elo=1800), Event='Rated Rapid game'))
    original = explorer._parse_entry
    calls = []

    def spy(text):
        calls.append(text)
        return original(text)

    monkeypatch.setattr(explorer, '_parse_entry', spy)
    all_games = explorer.local_data(chess.STARTING_FEN, [base])
    rapid = explorer.local_data(chess.STARTING_FEN, [base], rating_min=1700, rating_max=1900, speeds=['rapid'])
    mixed = explorer.local_data(chess.STARTING_FEN, [base], rating_min=1700, rating_max=1900, speeds=['rapid', 'blitz'])
    unknown = explorer.local_data(chess.STARTING_FEN, [base], speeds=['unknown'])
    assert all_games['total'] == all_games['game_count'] == 5
    assert rapid['total'] == rapid['game_count'] == 1 and set(by_move(rapid)) == {'e2e4'}
    assert mixed['total'] == mixed['game_count'] == 2 and set(by_move(mixed)) == {'e2e4', 'c2c4'}
    assert unknown['total'] == unknown['game_count'] == 1 and set(by_move(unknown)) == {'b2b3'}
    assert explorer.local_data(chess.STARTING_FEN, [base], speeds=[])['total'] == 5
    assert len(calls) == 5


def test_study_duplicates_are_filtered_before_selecting_the_winner():
    first, second = new_base('Excluded'), new_base('Eligible')
    original = with_headers(pgn(['e2e4'], result='1-0', white_elo=1500, black_elo=1500), TimeControl='600')
    eligible = with_headers(original, WhiteElo='1800', BlackElo='1850', TimeControl='180', Result='0-1')
    add(first, original)
    add(second, eligible)
    add(second, eligible)
    result = explorer.local_data(chess.STARTING_FEN, [first, second], rating_min=1700, speeds=['blitz'])
    assert result['total'] == result['game_count'] == result['black'] == 1
    assert result['white'] == 0 and result['duplicates'] == 1
    all_games = explorer.local_data(chess.STARTING_FEN, [first, second])
    assert all_games['white'] == 1 and all_games['black'] == 0


def test_mixed_study_reference_filters_do_not_exclude_eligible_archive_copy(tmp_path):
    study = new_base('Study')
    original = pgn(['e2e4', 'e7e5'], result='1-0', white_elo=1400, black_elo=1500)
    add(study, original)
    eligible = with_headers(original, WhiteElo='1800', BlackElo='1850', TimeControl='600', Result='0-1')
    archive = reference_base(tmp_path, eligible)
    result = explorer.local_data(chess.STARTING_FEN, [study, archive], rating_min=1700, speeds=['rapid'])
    assert result['total'] == result['game_count'] == result['black'] == 1
    unknown = explorer.local_data(chess.STARTING_FEN, [study, archive], speeds=['unknown'])
    assert unknown['total'] == unknown['game_count'] == unknown['white'] == 1
    terminal = explorer.local_data(after('e2e4', 'e7e5'), [study, archive], rating_min=1700, speeds=['rapid'])
    assert terminal['total'] == 0 and terminal['terminal_count'] == 1


def test_mixed_sources_keep_study_priority_only_for_eligible_copies(tmp_path):
    study = new_base('Study')
    original = with_headers(pgn(['e2e4'], result='1-0', white_elo=1800, black_elo=1900), TimeControl='600')
    add(study, original)
    archive = reference_base(tmp_path, with_headers(original, Result='0-1'))
    result = explorer.local_data(chess.STARTING_FEN, [study, archive], rating_min=1700, rating_max=1900, speeds=['rapid'])
    assert result['total'] == result['white'] == 1 and result['black'] == 0
    assert result['game_count'] == 2 and result['game_count_is_sum']
    assert result['moves'][0]['average_rating'] == 1800


def test_cached_import_snapshot_stays_incomplete_after_finalization(tmp_path, monkeypatch):
    import reference_library
    import reference_queries
    reference_queries.clear_cache()
    archive = reference_base(tmp_path, pgn(['e2e4'], result='1-0'))
    current = ['running']
    monkeypatch.setattr(reference_library, 'status_for', lambda *args: {'status': current[0], 'rejected': 0})
    first = explorer.local_data(chess.STARTING_FEN, [archive])
    assert first['total'] == 1 and first['complete'] is False
    current[0] = 'completed'
    cached = explorer.local_data(chess.STARTING_FEN, [archive])
    assert cached['cached'] and cached['complete'] is False
    reference_queries.clear_cache()
    fresh = explorer.local_data(chess.STARTING_FEN, [archive])
    assert fresh['complete'] is True


def test_completed_archive_with_rejections_reuses_cache_and_keeps_warning(tmp_path, monkeypatch):
    import reference_library
    import reference_queries
    import reference_store
    reference_queries.clear_cache()
    archive = reference_base(tmp_path, pgn(['e2e4'], result='1-0'))
    path = reference_library.store_path(f'{archive:032x}')
    with reference_store._connect(path) as conn:
        state = reference_store._get_meta(conn, 'import')
        reference_store._set_meta(conn, 'import', {**state, 'rejected': 3})
    first = explorer.local_data(chess.STARTING_FEN, [archive])
    assert first['total'] == 1 and first['complete'] is False
    reference_queries.clear_cache()
    monkeypatch.setattr(reference_store, 'explorer_data_many',
        lambda *args, **kwargs: pytest.fail('Completed retained games must reuse exact cache'))
    cached = explorer.local_data(chess.STARTING_FEN, [archive])
    assert cached['cached'] and cached['complete'] is False
    assert cached['invalid_entries'] == 3 and cached['total'] == 1
    assert 'rejetées' in cached['message']
    assert 'encore partielle' not in cached['message']


def test_requested_timeout_starts_preparation_and_returns_preparing(tmp_path, monkeypatch):
    import asyncio
    import reference_queries
    import reference_store
    import reference_library
    reference_queries.close_preparations()
    reference_queries.start_preparations()
    reference_queries.clear_cache()
    archive = reference_base(tmp_path, pgn(['e2e4'], result='1-0'))
    path = reference_library.store_path(f'{archive:032x}')
    original = reference_store.explorer_data_many
    calls = []
    def delayed(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            with reference_store._connect(path, readonly=True) as conn:
                conn.execute('''WITH RECURSIVE n(x) AS (
                    VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000000
                    ) SELECT sum(x) FROM n''').fetchone()
        return original(*args, **kwargs)
    monkeypatch.setattr(reference_store, 'explorer_data_many', delayed)
    monkeypatch.setattr(reference_store, 'prepare_explorer_index', lambda path: True)
    class Request:
        async def is_disconnected(self):
            return False
    async def scenario():
        return await reference_queries.run(Request(), explorer.local_data,
            chess.STARTING_FEN, [archive], budget=.05)
    try:
        result = asyncio.run(scenario())
        assert result['status'] == 'preparing' and result['retry_after'] == 3
        assert result['total'] is None and not result['moves']
    finally:
        reference_queries.close_preparations()
        reference_queries.start_preparations()
        reference_queries.clear_cache()


@pytest.mark.parametrize('kwargs', [
    {'rating_min': 1900, 'rating_max': 1700}, {'rating_min': True},
    {'rating_max': -1}, {'speeds': 'rapid'}, {'speeds': ['made-up']},
])
def test_invalid_local_filters_are_rejected_even_without_selected_bases(kwargs):
    with pytest.raises(ValueError):
        explorer.local_data(chess.STARTING_FEN, [], **kwargs)
