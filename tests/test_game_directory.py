"""Exact metadata directories and searches, including old reference stores."""
import hashlib
import json

import pytest
from fastapi import HTTPException

import db
import entry_catalog
import game_directory as directory
from game_search import AdvancedGameSearch
import reference_store as store
import training


def document(white='Labbé, Élodie', black='Martin, Jean', event='Open', date='2025.01.02',
             elo='2200', black_elo='2100', eco='B90', result='1-0'):
    headers = dict(Event=event, Site='Montréal', Date=date, Round='1', White=white, Black=black,
                   WhiteElo=elo, BlackElo=black_elo, ECO=eco, Result=result, Opening='Sicilienne', TimeControl='600+5')
    return '\n'.join('[' + key + ' ' + json.dumps(value, ensure_ascii=False) + ']' for key, value in headers.items()) + '\n\n1. e4 {Keep me} c5 ' + result + '\n'


@pytest.fixture
def population(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'study.sqlite3')
    db.init_db(); training.init_training()
    games = [document(), document(white='Jean, Paul', black='LABBE, Elodie', date='2025.??.??', elo='2000', black_elo='2250', eco='B91', result='1/2-1/2'),
             document(white='Labbé, Jean', black='Élodie, Anne', date='2024.12.01', elo='?', black_elo='?', eco='D30', result='0-1'),
             document(white='?', black='?', event='?', date='????.??.??', result='*'),
             document(black='Labbé, Élodie', date='2025.01.03')]
    with db.get_conn() as conn:
        base_id = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
                              ('Studies', json.dumps({'review_enabled': True, 'type': 'solve'}), training.stamp())).lastrowid
        for index, pgn in enumerate(games):
            conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                         (base_id, str(index), pgn, training.stamp(), training.stamp()))
    training.queue(base_id)
    source = tmp_path / 'games.pgn'
    source.write_text('\n'.join(games), encoding='utf-8')
    reference = tmp_path / 'reference.sqlite3'
    store.import_file(reference, source, workers=1)
    return base_id, reference, source


@pytest.mark.parametrize('reference', [False, True])
def test_player_counts_exact_selection_and_related_tournaments(population, reference):
    base_id, path, _ = population
    query = lambda **kw: directory.reference_directory(path, **kw) if reference else directory.study_directory(base_id, **kw)
    result = query(search='labbe elodie')
    assert result['total'] == 1
    player = result['items'][0]
    assert (player['games'], player['white_games'], player['black_games']) == (3, 2, 2)
    assert (player['elo_min'], player['elo_max']) == (2100, 2250)
    events = query(kind='events', player_key=player['key'])
    assert events['total'] == 1 and events['items'][0]['games'] == 3
    search = AdvancedGameSearch(player_key=player['key'])
    matches = store.list_games(path, advanced=search) if reference else entry_catalog.page(base_id=base_id, advanced=search)
    assert matches['total'] == 3


@pytest.mark.parametrize('reference', [False, True])
def test_tournament_editions_partial_dates_paging_and_unknowns(population, reference):
    base_id, path, _ = population
    query = lambda **kw: directory.reference_directory(path, **kw) if reference else directory.study_directory(base_id, **kw)
    events = query(kind='events', sort='date', descending=True, limit=1)
    assert events['total'] == 2 and events['has_more']
    latest = events['items'][0]
    assert latest['date'] == '2025' and latest['games'] == 3
    assert latest['last_date'] == '2025.??.??'  # No fabricated December 31.
    previous = query(kind='events', sort='date', descending=True, offset=1, limit=1)['items'][0]
    assert previous['date'] == '2024' and previous['games'] == 1
    players = query(event_key=latest['key'])
    assert players['total'] == latest['players'] == 3
    search = AdvancedGameSearch(event_key=previous['key'])
    matches = store.list_games(path, advanced=search) if reference else entry_catalog.page(base_id=base_id, advanced=search)
    assert matches['total'] == 1 and matches['entries'][0]['headers']['Date'] == '2024.12.01'


def test_reference_filters_match_studies_without_reading_pgn(population, monkeypatch):
    base_id, path, _ = population
    entry_catalog.prepare(base_ids=[base_id])
    monkeypatch.setattr(store.zlib, 'decompress', lambda *a, **kw: pytest.fail('Search decompressed a PGN'))
    monkeypatch.setattr(entry_catalog.pgnlib, 'load_game', lambda *a, **kw: pytest.fail('Warm study query parsed PGN'))
    for options in [dict(first_name='elodie', last_name='labbe'), dict(player_color='black', player='labbe', rating_min=2200, rating_side='black'),
                    dict(event='open', site='montreal', date_from='2025-06-01', date_to='2025-06-30'),
                    dict(eco='B90-B99', result='1-0'), dict(rating_min=2250, rating_side='either'),
                    dict(opening='sicilienne', speed='rapid'), dict(result='*'), dict(event="%' OR 1=1 --")]:
        advanced = AdvancedGameSearch(**options)
        studies = entry_catalog.page(base_id=base_id, advanced=advanced)
        references = store.list_games(path, advanced=advanced)
        assert studies['total'] == references['total'], options
        assert sorted(item['headers']['Date'] for item in studies['entries']) == sorted(item['headers']['Date'] for item in references['entries'])


def test_directories_preserve_sources_and_reuse_reference_snapshot(population, monkeypatch):
    base_id, path, _ = population
    before = hashlib.sha256(path.read_bytes()).digest()
    with db.get_conn() as conn:
        original = {table: [tuple(row) for row in conn.execute('SELECT * FROM ' + table)]
                    for table in ('entries', 'review_cards', 'review_history')}
    first = directory.reference_directory(path)
    directory.study_directory(base_id)
    monkeypatch.setattr(directory, '_aggregate', lambda *a, **kw: pytest.fail('Warm directory rebuilt all games'))
    second = directory.reference_directory(path, limit=1, offset=1, sort='games', descending=True)
    assert first['total'] == second['total'] and len(second['items']) == 1
    assert hashlib.sha256(path.read_bytes()).digest() == before
    with db.get_conn() as conn:
        assert original == {table: [tuple(row) for row in conn.execute('SELECT * FROM ' + table)] for table in original}


def test_reference_snapshot_invalidates_after_import_continues(population, tmp_path):
    _, path, _ = population
    before = directory.reference_directory(path)['total']
    source = tmp_path / 'more.pgn'
    source.write_text(document(white='New player', black='Other player'), encoding='utf-8')
    store.import_file(path, source, workers=1)
    assert directory.reference_directory(path)['total'] == before + 2


def test_directory_rejects_invalid_requests(population):
    base_id, _, _ = population
    for options in [dict(kind='sql'), dict(sort='missing'), dict(limit=0), dict(offset=-1), dict(search='x'*201)]:
        with pytest.raises(HTTPException):
            directory.study_directory(base_id, **options)
