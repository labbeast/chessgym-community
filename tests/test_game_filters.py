"""The same population must be selected in a study base and a SQL archive."""
from itertools import product
import sqlite3
from types import SimpleNamespace

import pytest

from game_filters import GameFilter
from game_metadata import rating, speed
import explorer_local
import reference_store


@pytest.mark.parametrize('options', [
    {}, {'rating_min': 1600}, {'rating_max': 2000},
    {'rating_min': 1600, 'rating_max': 2000}, {'speeds': ['unknown']},
    {'speeds': ['rapid', 'unknown']}, {'speeds': ['rapid', 'blitz', 'rapid']},
    {'rating_min': 1600, 'rating_max': 2000, 'speeds': ['rapid', 'unknown']},
    {'from_year': 2020}, {'to_year': 2025}, {'from_year': 2020, 'to_year': 2025},
    {'from_year': 2020, 'rating_min': 1600, 'speeds': ['classical', 'unknown']},
])
def test_sql_and_memory_select_identical_population(options):
    population = GameFilter(**options)
    rows = [SimpleNamespace(id=index, white_elo=white, black_elo=black, speed=cadence, year=year)
            for index, (white, black, cadence, year) in enumerate(product(
                (None, 1599, 1600, 2000, 2001), (None, 1599, 1600, 2000, 2001),
                (None, 'unknown', 'blitz', 'rapid', 'classical'), (None, 2019, 2020, 2025, 2026)))]
    conn = sqlite3.connect(':memory:')
    try:
        conn.execute('CREATE TABLE games(id, white_elo, black_elo, speed, year)')
        conn.executemany('INSERT INTO games VALUES(?,?,?,?,?)',
                         [(r.id, r.white_elo, r.black_elo, r.speed, r.year) for r in rows])
        clauses, values = population.sql()
        sql = 'SELECT id FROM games g' + (' WHERE ' + ' AND '.join(clauses) if clauses else '')
        actual = {row[0] for row in conn.execute(sql, values)}
        assert actual == {r.id for r in rows if population.matches(r)}
    finally:
        conn.close()


@pytest.mark.parametrize(('control', 'expected'), [
    ('29', 'ultraBullet'), ('30', 'bullet'), ('179', 'bullet'), ('180', 'blitz'),
    ('479', 'blitz'), ('480', 'rapid'), ('1499', 'rapid'), ('1500', 'classical'),
    ('300+5', 'rapid'), ('1/86400', 'correspondence'), ('40/7200:3600', None),
    ('?', None), ('-', None), ('', None),
])
def test_time_control_classification_ignores_event_names(control, expected):
    assert speed({'TimeControl': control, 'Event': 'Rapid tournament'}) == expected


@pytest.mark.parametrize(('value', 'expected'), [
    ('1600', 1600), ('0', None), ('9999', 9999), ('10000', None),
    ('?', None), ('1600?', None), (1600, None), (None, None),
])
def test_rating_metadata_keeps_unknown_ratings_unknown(value, expected):
    assert rating(value) == expected


def test_game_identity_matches_existing_archive_fingerprint():
    pgn = ('[Event "École"]\n[Site "Montréal"]\n[Date "2026.10.23"]\n'
           '[Round "1"]\n[White "Alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n'
           '1. e4 {note} e5 (1... c5) 2. Nf3 Nc6 1-0')
    # Captured from the pre-refactor parser. Persisted archive identities must
    # remain byte-for-byte compatible, including Unicode/header ordering.
    expected = '97be1d0269cb8558048de6edf97f5e4f56ef07c4333276b2f353a80eed3adbb7'
    assert reference_store._parse_record(pgn.encode()).identity.hex() == expected
    assert explorer_local._parse_entry(pgn).identity == expected
    annotated = pgn.replace('{note}', '{a changed comment}').replace('(1... c5)', '(1... d5)')
    assert reference_store._parse_record(annotated.encode()).identity.hex() == expected
    assert explorer_local._parse_entry(annotated).identity == expected
