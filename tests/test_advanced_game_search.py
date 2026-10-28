"""Advanced metadata searches use isolated stores and never edit game sources."""
from datetime import date
import json
import sqlite3

import pytest

import db
import entry_catalog
import game_search
import pgnlib
from test_library import client, owner, make_base


@pytest.fixture
def games(owner):
    base = make_base(owner, played=True, reading_enabled=True)
    specifications = [
        dict(White='Labbé, Émile', Black='Carlsen, Magnus', Event='Championnat du Québec',
             Site='Montréal', Date='2024.02.29', Round='4.1', WhiteElo='1850', BlackElo='2850',
             Result='1-0', ECO='B90', Opening='Sicilienne, Najdorf', TimeControl='300+3'),
        dict(White='Émile, Robert', Black='Labbé, Jean', Event='Championnat du Québec',
             Site='Québec', Date='2024.02.??', Round='4.2', WhiteElo='1800', BlackElo='1900',
             Result='0-1', ECO='B99', Opening='Sicilienne', TimeControl='600+5'),
        dict(White='Carlsen, Magnus', Black='Labbé, Émile', Event='Coupe 100%_locale',
             Site='Montréal', Date='2023.??.??', Round='2', WhiteElo='2800', BlackElo='1800',
             Result='1/2-1/2', ECO='C20', Opening='Partie du pion roi', TimeControl='60+0'),
        dict(White='Labbé, Émile', Black='Nakamura, Hikaru', Event='Open', Site='Paris',
             Date='????.??.??', UTCDate='2025.01.01', Result='*', ECO='B91', TimeControl='?'),
        dict(White='Inconnu', Black='Autre', Event='Open', Date='????.??.??',
             Result='*', ECO='?', TimeControl='40/7200:3600'),
        dict(White='Labbé, Émile', Black='Adversaire', Event='Championnat du Québec',
             Date='2024.03.01', Result='1-0', ECO='B89', WhiteElo='2000', BlackElo='2000',
             TimeControl='1800'),
    ]
    ids = []
    for headers in specifications:
        source = '\n'.join('[' + key + ' ' + json.dumps(value, ensure_ascii=False) + ']' for key, value in headers.items())
        source += '\n\n1. e4 e5 ' + headers['Result'] + '\n'
        result = owner.post(f'/api/bases/{base}/import', json={'pgn': source})
        assert result.status_code == 200, result.text
        with db.get_conn() as conn:
            ids.append(conn.execute('SELECT max(id) FROM entries').fetchone()[0])
    return base, ids, specifications


def found(owner, base, **filters):
    response = owner.get(f'/api/bases/{base}/entries', params={'sort': 'added', 'descending': 'false', **filters})
    assert response.status_code == 200, response.text
    return response.json()


def test_names_match_one_player_with_accents_order_and_color(owner, games):
    base, ids, _ = games
    data = found(owner, base, first_name='EMILE', last_name='labbe')
    assert [e['id'] for e in data['entries']] == [ids[0], ids[2], ids[3], ids[5]]
    assert [e['id'] for e in found(owner, base, player='émile labbe', player_color='black')['entries']] == [ids[2]]
    assert [e['id'] for e in found(owner, base, white='MAGNUS', black='emile')['entries']] == [ids[2]]
    assert found(owner, base, first_name='Emile', last_name='Jean')['total'] == 0


def test_combined_metadata_search_and_literal_text(owner, games):
    base, ids, _ = games
    response = found(owner, base, player='labbe emile', event='quebec championnat', site='montreal',
                     round='4.1', opening='najdorf', result='1-0', eco='b9', speed='blitz',
                     date_from='2024-02-29', date_to='2024-02-29', rating_min=1800, rating_max=2900)
    assert [e['id'] for e in response['entries']] == [ids[0]]
    assert response['total_all'] == 6
    assert found(owner, base, event='100%_')['total'] == 1
    assert found(owner, base, event="%' OR 1=1 --")['total'] == 0
    assert found(owner, base, player='labbe', search='Hikaru')['total'] == 1
    assert found(owner, base, player='labbe', search='inexistant')['total'] == 0


def test_partial_dates_intersect_bounds_and_utc_fallback(owner, games):
    base, ids, _ = games
    assert [e['id'] for e in found(owner, base, date_from='2024-02-29', date_to='2024-02-29')['entries']] == ids[:2]
    assert [e['id'] for e in found(owner, base, date_from='2023-06-01', date_to='2023-06-30')['entries']] == [ids[2]]
    assert [e['id'] for e in found(owner, base, date_from='2025-01-01')['entries']] == [ids[3]]
    assert ids[4] not in [e['id'] for e in found(owner, base, date_to='9999-12-31')['entries']]


def test_elo_sides_require_range_on_same_rating_and_exclude_missing(owner, games):
    base, ids, _ = games
    both = found(owner, base, rating_min=1800, rating_max=1900)
    assert [e['id'] for e in both['entries']] == [ids[1]]
    assert [e['id'] for e in found(owner, base, rating_min=1800, rating_max=1900, rating_side='either')['entries']] == ids[:3]
    assert [e['id'] for e in found(owner, base, rating_min=2800, rating_side='white')['entries']] == [ids[2]]
    assert [e['id'] for e in found(owner, base, rating_min=2800, rating_side='black')['entries']] == [ids[0]]
    assert found(owner, base, rating_min=2100, rating_max=2700, rating_side='either')['total'] == 0


def test_eco_range_results_and_unknown_cadence(owner, games):
    base, ids, _ = games
    assert [e['id'] for e in found(owner, base, eco='B90-B99')['entries']] == [ids[0], ids[1], ids[3]]
    assert [e['id'] for e in found(owner, base, eco='B90')['entries']] == [ids[0]]
    assert found(owner, base, eco='B')['total'] == 4
    assert [e['id'] for e in found(owner, base, result='*', speed='unknown')['entries']] == [ids[3], ids[4]]
    assert [e['id'] for e in found(owner, base, sort='result')['entries']][-2:] == [ids[3], ids[4]]


def test_filtered_pagination_context_and_global_played_search(owner, games):
    base, ids, _ = games
    data = found(owner, base, player='emile labbe', limit=2, offset=2)
    assert (data['total'], data['offset'], data['has_more']) == (4, 2, False)
    assert [e['id'] for e in data['entries']] == [ids[3], ids[5]]
    around = found(owner, base, player='emile labbe', limit=2, around_id=ids[3])
    assert (around['index'], around['previous_id'], around['next_id']) == (2, ids[2], ids[5])
    assert found(owner, base, player='emile labbe', limit=2, around_id=ids[1])['around_found'] is False
    other = make_base(owner)
    with db.get_conn() as conn:
        row = conn.execute('SELECT title,pgn,created_at,updated_at FROM entries WHERE id=?', (ids[0],)).fetchone()
        conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)', [other, *tuple(row)])
    all_games = owner.get('/api/entries', params={'player': 'labbe emile'}).json()
    played_games = owner.get('/api/entries', params={'played': 'true', 'player': 'labbe emile'}).json()
    assert (all_games['total'], played_games['total']) == (5, 4)


@pytest.mark.parametrize('params', [
    {'date_from': '2024-02-30'}, {'date_from': '2024'},
    {'date_from': '2025-01-01', 'date_to': '2024-12-31'},
    {'rating_min': -1}, {'rating_max': 4001}, {'rating_min': '1.5'},
    {'rating_min': 2000, 'rating_max': 1000}, {'rating_side': 'average'},
    {'eco': 'F00'}, {'eco': 'B99-B90'}, {'eco': 'B9%'},
    {'result': 'draw'}, {'player_color': 'red'}, {'speed': 'guess'},
    {'player': 'x' * 201}, [('event', 'one'), ('event', 'two')],
])
def test_invalid_search_is_rejected(owner, params):
    response = owner.get('/api/entries', params=params)
    assert response.status_code == 422, response.text


def test_search_remains_authenticated(client):
    assert client.get('/api/entries?player=test', headers={'Host': 'remote.invalid'}).status_code == 403
    assert client.get('/api/bases/1/entries?eco=B90', headers={'Host': 'remote.invalid'}).status_code == 403


def test_existing_catalog_schema_upgrades_additively_and_repeatedly():
    with sqlite3.connect(':memory:') as conn:
        conn.execute('CREATE TABLE entries(id INTEGER PRIMARY KEY,pgn TEXT,title TEXT,start_path TEXT)')
        conn.executescript(entry_catalog.SCHEMA)
        conn.execute("INSERT INTO entries VALUES(7,'unchanged PGN {notes}','Original','0.1')")
        conn.execute('''INSERT INTO entry_catalog(entry_id,pgn_digest,revision,headers,root_fen,moves,
                        pgn_bytes,search_text,title_key) VALUES(7,'digest','revision','{}','root','[]',21,'original','original')''')
        before = conn.execute('SELECT * FROM entry_catalog').fetchone()
        source = conn.execute('SELECT * FROM entries').fetchone()
        columns = [row[1] for row in conn.execute('PRAGMA table_info(entry_catalog)')]
        entry_catalog.init_schema(conn)
        entry_catalog.init_schema(conn)
        assert conn.execute('SELECT ' + ','.join(columns) + ' FROM entry_catalog').fetchone() == before
        assert conn.execute('SELECT * FROM entries').fetchone() == source
        assert conn.execute('SELECT search_version FROM entry_catalog').fetchone()[0] == 0


def test_upgrade_and_warm_search_preserve_pgn_bookmarks_history(owner, games, monkeypatch):
    base, ids, _ = games
    found(owner, base)
    with db.get_conn() as conn:
        source_before = [tuple(row) for row in conn.execute('SELECT * FROM entries')]
        histories = {name: [tuple(row) for row in conn.execute('SELECT * FROM ' + name)]
                     for name in ('entry_history', 'review_history', 'reading_progress')}
        conn.execute('UPDATE entry_catalog SET search_version=0,event=NULL,date_start=NULL,eco=NULL')
    monkeypatch.setattr(pgnlib, 'load_game', lambda *_: (_ for _ in ()).throw(AssertionError('PGN reparsed')))
    assert found(owner, base, event='quebec')['total'] == 3
    traces = []; real = db.get_conn
    def traced():
        conn = real(); conn.set_trace_callback(traces.append); return conn
    monkeypatch.setattr(db, 'get_conn', traced)
    assert found(owner, base, eco='B9')['total'] == 3
    assert not any(sql.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE', 'BEGIN IMMEDIATE')) for sql in traces)
    with db.get_conn() as conn:
        assert [tuple(row) for row in conn.execute('SELECT * FROM entries')] == source_before
        for table, rows in histories.items():
            assert [tuple(row) for row in conn.execute('SELECT * FROM ' + table)] == rows


def test_directory_keys_are_exact_and_editions_remain_separate(owner, games):
    base, ids, headers = games
    key = game_search.player_key('Labbé, Émile')
    assert found(owner, base, player_key=key)['total'] == 4
    assert found(owner, base, player_key=key, player='Magnus')['total'] == 0
    assert [e['id'] for e in found(owner, base, player_key=key, player_color='black')['entries']] == [ids[2]]
    event = game_search.event_key(headers[0])
    assert [e['id'] for e in found(owner, base, event_key=event)['entries']] == [ids[0]]
    assert game_search.event_key({**headers[0], 'Date': '2025.02.28'}) != event


@pytest.mark.parametrize('value,fallback,expected', [
    ('2024.02.??', None, ('2024-02-01', '2024-02-29')),
    ('2023.??.??', None, ('2023-01-01', '2023-12-31')),
    ('????.??.??', '2026.10.25', ('2026-10-25', '2026-10-25')),
    ('2024.02.30', None, None), ('0000.01.01', None, None),
    ('2024.??.05', None, None), ('2024.02.00', None, None),
])
def test_date_interval_rules(value, fallback, expected):
    actual = game_search.date_bounds(value, fallback)
    assert actual == ((None, None) if expected is None else tuple(date.fromisoformat(day).toordinal() for day in expected))
