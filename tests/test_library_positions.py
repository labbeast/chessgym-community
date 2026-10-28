"""Position lookup keeps every exact PGN occurrence without modifying sources."""
import chess
import chess.pgn
import pytest
from local_test_client import TestClient

import db
import library_positions as positions
import pgnlib


@pytest.fixture(autouse=True)
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'positions.sqlite3')
    db.init_db()
    positions.clear_cache()
    yield
    positions.clear_cache()


def new_base(name='Cours', folder=None, order=None):
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO bases(name,folder_id,sort_order,created_at) VALUES(?,?,?,?)',
                            (name, folder, order, 'stamp')).lastrowid


def add(base, text='1. e4 e5 *', title='Partie'):
    with db.get_conn() as conn:
        return conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                            (base, title, text, 'stamp', 'stamp')).lastrowid


def after(*moves, fen=chess.STARTING_FEN):
    board = chess.Board(fen)
    for move in moves:
        board.push_uci(move)
    return board.fen()


def diagram(fen):
    game = chess.pgn.Game()
    game.setup(chess.Board(fen))
    return pgnlib.export_game(game)


def lookup(*moves, **options):
    return positions.search_position(after(*moves), **options)


def test_initial_terminal_variation_and_exact_reopen_paths():
    text = '1. e4 e5 (1... c5 2. Nf3 (2. Nc3 Nc6)) 2. Nf3 *'
    eid = add(new_base(), text)
    root = lookup()
    assert root['complete'] and root['total_entries'] == root['total_occurrences'] == 1
    assert root['matches'][0]['occurrences'] == [{
        'path': '', 'fen': chess.STARTING_FEN, 'label': 'Position initiale', 'variation': False}]
    mainline = lookup('e2e4', 'e7e5', 'g1f3')['matches'][0]['occurrences'][0]
    assert mainline['path'] == '0.0.0' and mainline['variation'] is False
    side = lookup('e2e4', 'c7c5', 'b1c3', 'b8c6')['matches'][0]
    assert side['entry_id'] == eid and side['occurrence_count'] == 1
    item = side['occurrences'][0]
    assert item['path'] == '0.1.1.0' and item['variation'] is True
    assert item['label'] == '2… Nc6'
    assert pgnlib.node_at(pgnlib.load_game(text), item['path']).board().fen() == item['fen']


def test_transpositions_and_repeated_positions_count_all_occurrences():
    base = new_base()
    text = '1. Nf3 (1. g3 d5 2. Nf3) d5 2. g3 *'
    eid = add(base, text)
    result = lookup('g1f3', 'd7d5', 'g2g3')
    assert result['total_entries'] == 1 and result['total_occurrences'] == 2
    assert [item['path'] for item in result['matches'][0]['occurrences']] == ['0.0.0', '1.0.0']
    assert result['matches'][0]['entry_id'] == eid
    add(base, '1. Nf3 Nf6 2. Ng1 Ng8 *')
    result = lookup()
    assert result['total_entries'] == 2 and result['total_occurrences'] == 3


def test_ignore_move_counters_keep_turn_and_castling():
    base = new_base()
    fen = 'r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 12'
    eid = add(base, diagram(fen))
    other_clock = ' '.join(fen.split()[:4]) + ' 99 501'
    result = positions.search_position(other_clock)
    assert result['total_entries'] == 1
    assert result['matches'][0]['entry_id'] == eid
    assert result['matches'][0]['occurrences'][0]['fen'] == fen
    assert positions.search_position(fen.replace(' b ', ' w '))['total_entries'] == 0
    assert positions.search_position(fen.replace('KQkq', '-'))['total_entries'] == 0


def test_ep_target_matters_only_when_capture_is_legal():
    base = new_base()
    ep = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'
    add(base, diagram(ep))
    assert positions.search_position(ep)['total_entries'] == 1
    assert positions.search_position(ep.replace('d6', '-'))['total_entries'] == 0
    pinned = 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 2'
    add(base, diagram(pinned))
    assert positions.search_position(pinned.replace('d6', '-'))['total_entries'] == 1
    add(base, '1. e4 *')
    # A formal FEN target with no capturing pawn is equivalent to '-'.
    formal = chess.Board()
    formal.push_uci('e2e4')
    assert positions.search_position(formal.fen(en_passant='fen'))['total_entries'] == 1


def test_pedagogical_null_variations_remain_searchable():
    add(new_base(), '1. e4 e5 (1... -- 2. d4) *')
    fen = after('e2e4').replace(' b ', ' w ')
    result = positions.search_position(fen)
    assert result['complete'] and result['total_entries'] == 1
    assert result['matches'][0]['occurrences'][0]['path'] == '0.1'


def test_folder_names_and_base_order_are_fresh_without_reparsing(monkeypatch):
    with db.get_conn() as conn:
        parent = conn.execute('INSERT INTO folders(name) VALUES(?)', ('Étude',)).lastrowid
        child = conn.execute('INSERT INTO folders(name,parent_id) VALUES(?,?)', ('Ouvertures', parent)).lastrowid
    first, second = new_base('A', child, 10), new_base('B', None, 5)
    first_id, second_id = add(first), add(second)
    parser = positions._parse_entry
    calls = []
    def spy(text):
        calls.append(text)
        return parser(text)
    monkeypatch.setattr(positions, '_parse_entry', spy)
    result = lookup()
    assert [item['entry_id'] for item in result['matches']] == [second_id, first_id]
    assert result['matches'][1]['folder_path'] == 'Étude / Ouvertures'
    with db.get_conn() as conn:
        conn.execute('UPDATE folders SET name=? WHERE id=?', ('Cours', parent))
        conn.execute('UPDATE bases SET name=?,sort_order=? WHERE id=?', ('Renommée', 0, first))
        conn.execute('UPDATE entries SET title=? WHERE id=?', ('Autre titre', first_id))
    result = lookup()
    assert result['matches'][0]['entry_title'] == 'Autre titre'
    assert result['matches'][0]['base_name'] == 'Renommée'
    assert result['matches'][0]['folder_path'] == 'Cours / Ouvertures'
    assert len(calls) == 2
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET base_id=? WHERE id=?', (second, first_id))
    result = lookup()
    assert result['matches'][0]['base_id'] == second and result['matches'][0]['folder_path'] == ''
    assert len(calls) == 2


def test_cache_detects_edit_with_same_timestamp_import_delete_and_undo(monkeypatch):
    base = new_base()
    eid = add(base)
    parser = positions._parse_entry
    calls = []
    def spy(text):
        calls.append(text)
        return parser(text)
    monkeypatch.setattr(positions, '_parse_entry', spy)
    assert lookup('e2e4')['total_entries'] == 1
    assert lookup('e2e4', 'e7e5')['total_entries'] == 1
    assert len(calls) == 1
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. d4 d5 *', eid))
    assert lookup('e2e4')['total_entries'] == 0
    assert lookup('d2d4')['total_entries'] == 1
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('1. e4 e5 *', eid))
    assert lookup('e2e4')['total_entries'] == 1
    assert len(calls) == 3
    new_id = add(base)
    assert lookup('e2e4')['total_entries'] == 2 and len(calls) == 4
    with db.get_conn() as conn:
        conn.execute('DELETE FROM entries WHERE id=?', (eid,))
    assert lookup('e2e4')['matches'][0]['entry_id'] == new_id
    assert len(calls) == 4
    assert len(positions._CACHE) == 1


def test_cache_isolated_by_database_path(tmp_path, monkeypatch):
    add(new_base(), '1. e4 *')
    assert lookup('e2e4')['total_entries'] == 1
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'other.sqlite3')
    db.init_db()
    add(new_base(), '1. d4 *')
    assert lookup('e2e4')['total_entries'] == 0
    assert lookup('d2d4')['total_entries'] == 1


def test_page_entries_and_count_all_repetitions(monkeypatch):
    monkeypatch.setattr(positions, 'MAX_OCCURRENCES', 1)
    base = new_base()
    ids = [add(base, '1. Nf3 Nf6 2. Ng1 Ng8 *') for _ in range(5)]
    page = lookup(offset=1, limit=2)
    assert page['total_entries'] == 5 and page['total_occurrences'] == 10
    assert [row['entry_id'] for row in page['matches']] == list(reversed(ids))[1:3]
    assert page['has_more'] and page['complete']
    assert all(row['occurrence_count'] == 2 and len(row['occurrences']) == 1 for row in page['matches'])
    last = lookup(offset=4, limit=2)
    assert not last['has_more'] and len(last['matches']) == 1
    assert lookup(offset=9)['matches'] == []


def test_invalid_records_are_skipped_and_never_claim_complete_absence():
    base = new_base()
    for text in ('', '1. e4 garbage e5 *', '1. e4 e5 2. Bh6 *',
                 '1. e4 *\n\n[Event "Other"]\n\n1. d4 *',
                 '[Variant "Chess960"]\n\n1. e4 *'):
        add(base, text)
    add(base, '1. d4 *')
    result = lookup('e2e4')
    assert result['total_entries'] == 0 and not result['complete']
    assert result['skipped_entries'] == 5
    assert lookup('d2d4')['total_entries'] == 1


@pytest.mark.parametrize('name,value', [('MAX_QUERY_ENTRIES', 1), ('MAX_QUERY_BYTES', 15)])
def test_query_limits_are_reported_as_incomplete(monkeypatch, name, value):
    base = new_base()
    add(base, '1. e4 e5 *')
    add(base, '1. d4 d5 *')
    monkeypatch.setattr(positions, name, value)
    result = lookup('d2d4')
    assert result['skipped_entries'] == 1 and not result['complete']


@pytest.mark.parametrize('name,value', [('MAX_ENTRY_BYTES', 2), ('MAX_ENTRY_POSITIONS', 1),
                                     ('MAX_PATH_PLIES', 1), ('MAX_ENTRY_INDEX_BYTES', 128)])
def test_entry_limits_do_not_return_partial_entries(monkeypatch, name, value):
    add(new_base(), '1. e4 e5 *')
    monkeypatch.setattr(positions, name, value)
    result = lookup()
    assert result['total_entries'] == 0
    assert result['skipped_entries'] == 1 and result['complete'] is False


def test_cache_memory_and_count_bounds_do_not_limit_results(monkeypatch):
    monkeypatch.setattr(positions, 'MAX_CACHE_ENTRIES', 2)
    monkeypatch.setattr(positions, 'MAX_CACHE_POSITIONS', 5)
    monkeypatch.setattr(positions, 'MAX_CACHE_BYTES', 2000)
    base = new_base()
    for _ in range(5):
        add(base)
    assert lookup()['total_entries'] == 5
    assert len(positions._CACHE) <= 2
    assert positions._CACHE_SIZE <= 5 and positions._CACHE_BYTES <= 2000
    monkeypatch.setattr(positions, 'MAX_CACHE_BYTES', 1)
    positions.clear_cache()
    assert lookup('e2e4')['total_entries'] == 5 and not positions._CACHE


@pytest.mark.parametrize('fen', ['invalid', '', '8/8/8/8/8/8/8/8 w - - 0 1', 'x' * 257])
def test_invalid_query_fens_fail_explicitly(fen):
    with pytest.raises(ValueError):
        positions.search_position(fen)


def test_api_authentication_validation_and_no_writes(monkeypatch):
    import app
    import jobs
    monkeypatch.setattr(jobs, 'start_worker', lambda: None)
    monkeypatch.setattr(jobs, 'stop_worker', lambda: None)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        assert client.get('/api/library/position', params={'fen': chess.STARTING_FEN}, headers={'Host': 'remote.invalid'}).status_code == 403
        assert client.get('/api/status').status_code == 200
        bid = client.post('/api/bases', json={'name': 'Cours', 'settings': {'review_enabled': True}}).json()['id']
        item = client.post('/api/entries', json={'base_id': bid, 'pgn': '1. e4 e5 *'}).json()
        assert client.get(f'/api/bases/{bid}/queue?all=true').status_code == 200
        def snapshot():
            with db.get_conn() as conn:
                return {name: [dict(row) for row in conn.execute(f'SELECT * FROM {name}')]
                        for name in ('entries', 'entry_history', 'review_cards', 'review_history', 'preferences')}
        before = snapshot()
        response = client.get('/api/library/position', params={'fen': after('e2e4')})
        assert response.status_code == 200, response.text
        assert response.json()['matches'][0]['entry_id'] == item['id']
        assert snapshot() == before
        assert client.get('/api/library/position', params={'fen': 'bad'}).status_code == 400
        for params in ({'fen': chess.STARTING_FEN, 'offset': -1},
                       {'fen': chess.STARTING_FEN, 'limit': 101}, {'fen': chess.STARTING_FEN, 'limit': 0}):
            assert client.get('/api/library/position', params=params).status_code == 422


def test_summary_lists_every_matching_base_without_loading_a_game_page():
    first, second, empty = new_base('A', order=2), new_base('B', order=1), new_base('Vide')
    for _ in range(3):
        add(first, '1. Nf3 Nf6 2. Ng1 Ng8 *')
    add(second)
    add(empty, '1. d4 d5 *')
    result = lookup(summary=True, limit=1, offset=2)
    assert result['matches'] == [] and not result['has_more']
    assert result['total_entries'] == 5 and result['total_occurrences'] == 8
    assert [row['base_id'] for row in result['bases']] == [second, first, empty]
    assert [(row['total_entries'], row['total_occurrences']) for row in result['bases']] == [(1, 1), (3, 6), (1, 1)]
    after_e4 = lookup('e2e4', summary=True)
    assert [row['base_id'] for row in after_e4['bases']] == [second]


def test_selected_base_has_independent_pagination_and_does_not_scan_other_bases(monkeypatch):
    first, second = new_base('A'), new_base('B')
    add(first, 'not a valid PGN')
    ids = [add(second) for _ in range(4)]
    page = lookup(base_id=second, offset=1, limit=2)
    assert page['total_entries'] == 4 and page['skipped_entries'] == 0 and page['complete']
    assert [row['entry_id'] for row in page['matches']] == list(reversed(ids))[1:3]
    assert page['has_more']
    assert [row['base_id'] for row in page['bases']] == [second]
    assert not lookup(base_id=second, offset=3, limit=2)['has_more']


def test_match_contains_current_pgn_headers_for_compact_display():
    base = new_base()
    text = '[White "Alice"]\n[Black "Bob"]\n[WhiteElo "1800"]\n[BlackElo "1750"]\n[Date "2026.10.22"]\n[Result "1-0"]\n\n1. e4 e5 1-0'
    eid = add(base, text)
    headers = lookup('e2e4', base_id=base)['matches'][0]['headers']
    assert headers['White'] == 'Alice' and headers['BlackElo'] == '1750'
    assert headers['Result'] == '1-0' and headers['Date'] == '2026.10.22'
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', (text.replace('1800', '1850'), eid))
    assert lookup('e2e4', base_id=base)['matches'][0]['headers']['WhiteElo'] == '1850'


def test_selected_base_dates_sort_before_pagination_with_utc_partial_and_unknown_dates():
    base = new_base()
    def dated(date, utc=None):
        return add(base, f'[Date "{date}"]\n' + (f'[UTCDate "{utc}"]\n' if utc else '') + '\n1. e4 e5 *')
    old = dated('2020.12.31', '2029.01.01')  # Date has precedence over UTCDate.
    fallback = dated('????.??.??', '2026.10.23')
    missing = add(base)
    unknown = dated('0000.00.00')
    full = dated('2026.10.22')
    partial_year = dated('2026.??.??')
    partial_day = dated('2026.10.??')
    tied = dated('2026.10.22')
    expected = [partial_year, partial_day, fallback, tied, full, old, unknown, missing]
    pages = [lookup('e2e4', base_id=base, offset=start, limit=3) for start in (0, 3, 6)]
    assert [row['entry_id'] for page in pages for row in page['matches']] == expected
    assert [page['has_more'] for page in pages] == [True, True, False]
    assert all(page['total_entries'] == 8 for page in pages)
    assert lookup('e2e4', base_id=base, offset=9)['matches'] == []
    with db.get_conn() as conn:
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', ('[Date "2027.01.01"]\n\n1. e4 e5 *', old))
    assert lookup('e2e4', base_id=base, limit=1)['matches'][0]['entry_id'] == old


def test_date_sort_preserves_base_group_order():
    first, second = new_base('First', order=1), new_base('Second', order=2)
    old = add(first, '[Date "2000.01.01"]\n\n1. e4 *')
    new = add(second, '[Date "2026.01.01"]\n\n1. e4 *')
    page = lookup('e2e4')
    assert [row['base_id'] for row in page['bases']] == [first, second]
    assert [row['entry_id'] for row in page['matches']] == [old, new]


def test_summary_flags_incomplete_bases_without_claiming_complete_counts():
    base = new_base()
    add(base)
    add(base, 'invalid PGN')
    result = lookup(summary=True)
    assert result['total_entries'] == 1 and result['skipped_entries'] == 1
    assert not result['complete'] and not result['bases'][0]['complete']


def test_missing_and_invalid_base_filters_fail_explicitly():
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as caught:
        lookup(base_id=999)
    assert caught.value.status_code == 404
    for value in (0, -1, True, '1'):
        with pytest.raises(ValueError):
            lookup(base_id=value)


def test_reference_summary_counts_without_loading_headers_and_selected_page(tmp_path, monkeypatch):
    import reference_store
    import reference_library
    study, reference = new_base('Étude', order=2), new_base('Référence', order=1)
    add(study)
    source = tmp_path / 'masters.pgn'
    source.write_text('[White "Master"]\n[Black "Other"]\n[WhiteElo "2600"]\n[BlackElo "2500"]\n[Date "2026.09.01"]\n[Result "1-0"]\n\n1. e4 e5 1-0', encoding='utf-8')
    storage_key = 'a' * 32
    with db.get_conn() as conn:
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source) VALUES(?,?,?)', (reference, storage_key, str(source)))
    reference_store.import_file(reference_library.store_path(storage_key), source)
    original = reference_store.search_position
    calls = []
    def search(*args, **options):
        calls.append(options)
        return original(*args, **options)
    monkeypatch.setattr(reference_store, 'search_position', search)
    result = lookup('e2e4', summary=True)
    assert result['matches'] == [] and result['total_entries'] == 2
    assert [row['base_id'] for row in result['bases']] == [reference, study]
    assert result['bases'][0]['reference'] and calls[-1]['summary']
    page = lookup('e2e4', base_id=reference)
    assert page['total_entries'] == 1 and len(page['matches']) == 1
    assert page['matches'][0]['headers']['WhiteElo'] == '2600'
    assert page['matches'][0]['reference_source'] == {'base_id': reference, 'game_id': 1}
    assert not calls[-1]['summary']
