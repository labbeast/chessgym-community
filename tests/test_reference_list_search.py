"""Reference text search stays exact without scanning the wide PGN table."""
from contextlib import closing, contextmanager
import re
import sqlite3

import pytest

import reference_store as store
from test_reference_store import pgn, source


@pytest.fixture(scope='module')
def search_archive(tmp_path_factory):
    directory = tmp_path_factory.mktemp('reference-list-search')
    rows = [
        ('Carlsen, Magnus', 'Other', 'Carlsen Cup', 2800, 2750, '1800', '2026.01.01'),
        ('Other', 'Carlsen, Magnus', 'World Rapid', 1800, 1900, '600', '2026.01.01'),
        ('Club player', 'Somebody', 'Carlsen memorial', 2000, 1900, '1800', '2024.02.01'),
        ('Percent%', 'Under_score', 'Slash\\Cup', 2200, 2300, '600', '2020.03.01'),
        ('Percentx', 'UnderXscore', 'SlashXCup', None, 2000, None, '????.??.??'),
        ('Éloi', 'élise', 'Montréal', 1800, 1850, '180', '2025.01.01'),
        ('eloI', 'ÉLISE', 'Épreuve', 1800, 1950, '600', '2025.01.01'),
        ('Carlsen Junior', 'No Elo', 'Test', None, 1700, '600', '2022.01.01'),
        ('CARLSEN Club', 'World', 'Rapid Review', 1850, 1900, '600', '2025.01.01'),
        ('Carlsen, Magnus', 'Alpha', 'Tie', 1850, 1900, '600', '2025.01.01'),
    ]
    games = []
    for index, (white, black, event, white_elo, black_elo, cadence, date) in enumerate(rows):
        headers = {}
        if white_elo is not None:
            headers['WhiteElo'] = str(white_elo)
        if black_elo is not None:
            headers['BlackElo'] = str(black_elo)
        if cadence is not None:
            headers['TimeControl'] = cadence
        text = pgn(['e2e4', 'e7e5'], white=white, black=black,
                   result=('1-0', '0-1', '1/2-1/2')[index % 3], **headers)
        text = text.replace('[Event "Test"]', '[Event "' + event.replace('\\', '\\\\') + '"]')
        text = text.replace('[Date "2026.10.21"]', '[Date "' + date + '"]')
        text = text.replace('1. e4', '1. e4 $1 {Original é [%clk 0:09:58]} (1. d4 d5)')
        games.append(text)
    path = directory / 'reference.sqlite3'
    result = store.import_file(path, source(directory, *games))
    assert result['game_count'] == len(rows) and result['rejected'] == 0
    return path


def original_ids(path, *, search='', sort='id', descending=False,
                 rating_min=None, rating_max=None, speed=None):
    """Independent folded literal-term oracle on the small fixture."""
    sorts = {'id': 'id', 'date': 'date', 'white': 'white COLLATE NOCASE',
             'black': 'black COLLATE NOCASE', 'event': 'event COLLATE NOCASE',
             'white_elo': 'white_elo', 'black_elo': 'black_elo',
             'result': 'outcome', 'title': 'title COLLATE NOCASE'}
    clauses, params = [], []
    from game_search import fold
    for term in fold(search).split():
        clauses.append("(instr(cg_fold(white),?)>0 OR instr(cg_fold(black),?)>0 OR instr(cg_fold(event),?)>0)")
        params.extend([term] * 3)
    for value, operator in ((rating_min, '>='), (rating_max, '<=')):
        if value is not None:
            clauses.extend([f'white_elo {operator} ?', f'black_elo {operator} ?'])
            params.extend([value, value])
    if speed:
        clauses.append('(speed=? OR speed IS NULL)' if speed == 'unknown' else 'speed=?')
        params.append(speed)
    direction = 'DESC' if descending else 'ASC'
    sql = 'SELECT id FROM games' + (' WHERE ' + ' AND '.join(clauses) if clauses else '')
    sql += f' ORDER BY {sorts[sort]} {direction}, id {direction}'
    with closing(sqlite3.connect(path)) as conn:
        conn.create_function('cg_fold',1,fold,deterministic=True)
        return [row[0] for row in conn.execute(sql, params)]


@pytest.mark.parametrize('search', ['Carlsen', 'carlsen', 'memorial', '%', '_', '\\',
                                   'É', 'é', 'éloi', 'nobody', ''])
@pytest.mark.parametrize('filters', [{}, {'rating_min': 1800}, {'rating_max': 1900},
                                    {'rating_min': 1750, 'rating_max': 2000, 'speed': 'rapid'},
                                    {'speed': 'unknown'}])
def test_search_matches_folded_literal_terms_and_filters(search_archive, search, filters):
    expected = original_ids(search_archive, search=search, **filters)
    page = store.list_games(search_archive, search=search, **filters)
    assert [entry['id'] for entry in page['entries']] == expected
    assert page['total'] == len(expected)
    assert page['has_more'] is False


def test_one_game_matching_multiple_fields_is_counted_once(search_archive):
    result = store.list_games(search_archive, search='Carlsen')
    assert [entry['id'] for entry in result['entries']] == [1, 2, 3, 8, 9, 10]
    assert result['total'] == 6


@pytest.mark.parametrize('sort', ['id', 'date', 'white', 'black', 'event',
                                 'white_elo', 'black_elo', 'result', 'title'])
@pytest.mark.parametrize('descending', [False, True])
def test_search_sorting_and_paging_are_stable_including_empty_last_page(search_archive, sort, descending):
    filters = dict(search='Carlsen', sort=sort, descending=descending,
                   rating_min=1700, rating_max=2800)
    expected = original_ids(search_archive, **filters)
    gathered = []
    for offset in range(0, len(expected) + 3, 2):
        page = store.list_games(search_archive, offset=offset, limit=2, **filters)
        actual = [entry['id'] for entry in page['entries']]
        assert actual == expected[offset:offset + 2]
        assert page['total'] == len(expected)
        assert page['offset'] == offset and page['limit'] == 2
        assert page['has_more'] is (offset + len(actual) < len(expected))
        gathered.extend(actual)
    assert gathered == expected


def test_search_reads_covering_name_indexes_instead_of_wide_game_scan(search_archive, monkeypatch):
    monkeypatch.setattr(store, '_SEARCH_MATCHES', store.OrderedDict())
    original = store._connect
    plans = []

    @contextmanager
    def observed(*args, **options):
        with original(*args, **options) as conn:
            def trace(sql):
                # Explain on the same connection, while its temporary match
                # table exists. Never explain recursively or inspect live data.
                normalized = sql.lstrip().upper()
                if not normalized.startswith(('SELECT ', 'INSERT ', 'WITH ', 'CREATE TEMP')):
                    return
                if 'GAMES' not in normalized or 'EXPLAIN' in normalized:
                    return
                try:
                    plans.extend(row[-1] for row in conn.execute('EXPLAIN QUERY PLAN ' + sql))
                except sqlite3.OperationalError:
                    # CREATE TABLE statements have no useful read plan; the
                    # following INSERT/SELECT still proves the access path.
                    pass
            conn.set_trace_callback(trace)
            yield conn

    monkeypatch.setattr(store, '_connect', observed)
    result = store.list_games(search_archive, search='Carlsen', sort='date', rating_min=1700)
    assert result['total'] == 5
    for index in ('games_white', 'games_black', 'games_event'):
        assert any('COVERING INDEX ' + index in step for step in plans), plans
    assert not any(re.fullmatch(r'SCAN (?:g|games)(?: AS \w+)?', step) for step in plans), plans


def test_search_never_changes_stored_games_headers_positions_or_metadata(search_archive):
    def snapshot():
        with closing(sqlite3.connect(search_archive)) as conn:
            return {
                'games': conn.execute('SELECT * FROM games ORDER BY id').fetchall(),
                'positions': conn.execute('SELECT * FROM positions ORDER BY position_key,game_id').fetchall(),
                'meta': conn.execute('SELECT * FROM meta ORDER BY key').fetchall(),
                'schema': conn.execute('SELECT type,name,sql FROM sqlite_master ORDER BY type,name').fetchall(),
            }
    before = snapshot()
    for search in ('Carlsen', 'nobody', '%', '\\'):
        store.list_games(search_archive, search=search, sort='date', descending=True, limit=2)
    assert snapshot() == before
    original = store.read_game(search_archive, 1)['pgn']
    assert all(marker in original for marker in ('$1', 'Original é', 'd4 d5', '[%clk'))


def test_candidate_cache_reuses_names_across_pages_sorts_and_filters(search_archive, monkeypatch):
    monkeypatch.setattr(store, '_SEARCH_MATCHES', store.OrderedDict())
    first=store.list_games(search_archive, search='Carlsen', limit=2)
    assert first['total']==6
    original=store._connect
    @contextmanager
    def no_name_rescan(*args, **kwargs):
        with original(*args, **kwargs) as conn:
            def deny(action, name, column, database, trigger):
                if action==sqlite3.SQLITE_READ and name=='games' and column in ('white','black','event'):
                    return sqlite3.SQLITE_DENY
                return sqlite3.SQLITE_OK
            conn.set_authorizer(deny)
            yield conn
    monkeypatch.setattr(store, '_connect', no_name_rescan)
    next_page=store.list_games(search_archive,search='Carlsen',offset=2,limit=2)
    assert [entry['id'] for entry in next_page['entries']]==[3,8]
    filtered=store.list_games(search_archive,search='Carlsen',sort='date',rating_min=1700)
    assert filtered['total']==5
    assert store.list_games(search_archive,search='Carlsen')['total']==6


def test_candidate_cache_is_invalidated_after_import(tmp_path, monkeypatch):
    monkeypatch.setattr(store, '_SEARCH_MATCHES', store.OrderedDict())
    path=tmp_path/'search.sqlite3'
    store.import_file(path,source(tmp_path,pgn(['e2e4'],white='New Player'),name='first.pgn'))
    assert store.list_games(path,search='New')['total']==1
    store.import_file(path,source(tmp_path,pgn(['d2d4'],white='New Player 2'),name='second.pgn'))
    assert store.list_games(path,search='New')['total']==2


def test_candidate_cache_bounds_large_results_and_profile_count(search_archive, monkeypatch):
    monkeypatch.setattr(store, '_SEARCH_MATCHES', store.OrderedDict())
    monkeypatch.setattr(store,'MAX_SEARCH_MATCH_IDS',2)
    monkeypatch.setattr(store,'MAX_SEARCH_MATCH_PROFILES',2)
    monkeypatch.setattr(store,'MAX_SEARCH_MATCH_CACHE_IDS',3)
    assert store.list_games(search_archive,search='Carlsen')['total']==6
    assert not store._SEARCH_MATCHES
    for search in ('éloi','nobody','Percent','Slash'):
        store.list_games(search_archive,search=search)
    assert len(store._SEARCH_MATCHES)<=2
    assert sum(len(ids) for ids in store._SEARCH_MATCHES.values())<=3
