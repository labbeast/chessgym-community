"""Repertoire reach estimates are conditional on our own selected moves."""
from copy import deepcopy
import json

import chess
import pytest
from local_test_client import TestClient

import app
import db
import explorer


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'probability.sqlite3')
    monkeypatch.delenv('CHESSGYM_LICHESS_TOKEN', raising=False)

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        yield client


@pytest.fixture
def owner(client):
    assert client.get('/api/status').status_code == 200
    return client


def path(moves=(), color='white', start=chess.STARTING_FEN, **settings):
    board = chess.Board(start)
    for uci in moves:
        board.push_uci(uci)
    return {'fen': board.fen(), 'start_fen': start, 'moves': list(moves),
            'settings': {'repertoire_color': color, **settings}}


def sample(uci, count, total=100, **flags):
    return {'status': 'ok', 'total': total, 'moves': [{'uci': uci, 'total': count}],
            'stale': False, 'complete': True, **flags}


def result(owner, payload):
    response = owner.post('/api/explorer/probability', json=payload)
    assert response.status_code == 200, response.text
    return response.json()


LINE = ['e2e4', 'e7e5', 'g1f3', 'b8c6']


def test_probability_requires_owner(client):
    assert client.post('/api/explorer/probability', json=path(), headers={'Host': 'remote.invalid'}).status_code == 403


def test_white_only_counts_black_replies(owner, monkeypatch):
    calls = []
    def dataset(source, fen, ids, settings, bases):
        calls.append(fen)
        board = chess.Board(fen)
        assert not board.turn
        return sample('e7e5', 25) if board.fullmove_number == 1 else sample('b8c6', 20)
    monkeypatch.setattr(explorer, '_dataset', dataset)
    actual = result(owner, path(LINE))
    assert actual['probability'] == pytest.approx(.05)
    assert actual['opponent_moves'] == actual['evaluated_opponent_moves'] == 2
    assert actual['sample_min'] == 100
    assert actual['conditional_root'] is False
    assert actual['stale'] is False
    assert len(calls) == 2


def test_black_only_counts_white_moves(owner, monkeypatch):
    calls = []
    def dataset(source, fen, ids, settings, bases):
        board = chess.Board(fen)
        calls.append(fen)
        assert board.turn
        return sample('e2e4', 60) if board.fullmove_number == 1 else sample('g1f3', 90)
    monkeypatch.setattr(explorer, '_dataset', dataset)
    actual = result(owner, path(LINE, color='black'))
    assert actual['probability'] == pytest.approx(.54)
    assert actual['opponent_moves'] == 2
    assert len(calls) == 2


@pytest.mark.parametrize('moves,color', [([], 'white'), ([], 'black'), (['e2e4'], 'white')])
def test_no_opponent_moves_needs_no_dataset(owner, monkeypatch, moves, color):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: pytest.fail('Own moves must not fetch data'))
    actual = result(owner, path(moves, color=color))
    assert actual['status'] == 'ok' and actual['probability'] == 1
    assert actual['opponent_moves'] == 0 and actual['sample_min'] is None


def test_own_followup_does_not_reduce_probability(owner, monkeypatch):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: sample('e7e5', 40))
    assert result(owner, path(LINE[:2]))['probability'] == result(owner, path(LINE[:3]))['probability'] == .4


def test_custom_root_is_explicit_and_respects_its_side_to_move(owner, monkeypatch):
    board = chess.Board(); board.push_uci('e2e4')
    monkeypatch.setattr(explorer, '_dataset', lambda *a: sample('e7e5', 20))
    actual = result(owner, path(['e7e5', 'g1f3'], start=board.fen()))
    assert actual['probability'] == .2 and actual['opponent_moves'] == 1
    assert actual['conditional_root'] is True and actual['start_fen'] == board.fen()
    monkeypatch.setattr(explorer, '_dataset', lambda *a: pytest.fail('Black move belongs to repertoire'))
    assert result(owner, path(['e7e5'], color='black', start=board.fen()))['probability'] == 1


@pytest.mark.parametrize('status', ['unavailable', 'rate_limited', 'auth_required'])
def test_first_unknown_stops_further_requests(owner, monkeypatch, status):
    calls = []
    def dataset(*args):
        calls.append(args)
        return sample('e7e5', 0, 0, status=status, message='Statistiques indisponibles')
    monkeypatch.setattr(explorer, '_dataset', dataset)
    actual = result(owner, path(LINE))
    assert actual['status'] == 'unavailable' and actual['probability'] is None
    assert actual['reason'] == status and actual['evaluated_opponent_moves'] == 0
    assert len(calls) == 1


@pytest.mark.parametrize('data,reason', [
    (sample('e7e5', 0, 0), 'no_samples'),
    (sample('c7c5', 10, complete=False), 'incomplete_sample'),
])
def test_missing_statistics_are_not_zero(owner, monkeypatch, data, reason):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: deepcopy(data))
    actual = result(owner, path(LINE))
    assert actual['probability'] is None and actual['reason'] == reason


def test_present_move_uses_full_total_even_when_other_rows_truncated(owner, monkeypatch):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: sample('e7e5', 30, complete=False))
    assert result(owner, path(LINE[:2]))['probability'] == .3


@pytest.mark.parametrize('data', [sample('c7c5', 100), sample('e7e5', 0)])
def test_known_zero_stops_descendants(owner, monkeypatch, data):
    calls = []
    def dataset(*args):
        calls.append(args)
        return deepcopy(data)
    monkeypatch.setattr(explorer, '_dataset', dataset)
    actual = result(owner, path(LINE))
    assert actual['status'] == 'ok' and actual['probability'] == 0
    assert actual['opponent_moves'] == 2 and actual['evaluated_opponent_moves'] == 1
    assert len(calls) == 1


def test_stale_counts_are_explicit(owner, monkeypatch):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: sample('e7e5', 25, stale=True, status='rate_limited'))
    actual = result(owner, path(LINE[:2]))
    assert actual['probability'] == .25 and actual['stale'] is True


def test_full_path_is_validated_even_after_potential_zero(owner, monkeypatch):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: pytest.fail('Validate before queries'))
    bad = path(LINE)
    bad['moves'][-1] = 'b8b5'
    assert owner.post('/api/explorer/probability', json=bad).status_code == 400


@pytest.mark.parametrize('patch', [
    {'fen': 'broken'}, {'start_fen': 'broken'}, {'start_fen': None},
    {'moves': None}, {'moves': 'e2e4'}, {'moves': [123]},
    {'moves': ['0000']}, {'moves': ['e2e5']}, {'url': 'https://example.test'},
    {'fen': chess.STARTING_FEN}, {'settings': {'repertoire_color': 'w'}},
])
def test_bad_input_never_fetches(owner, monkeypatch, patch):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: pytest.fail('No lookup for invalid input'))
    assert owner.post('/api/explorer/probability', json={**path(LINE), **patch}).status_code == 400


def test_fen_counters_must_also_match_actual_path(owner, monkeypatch):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: pytest.fail('No lookup for mismatched FEN'))
    payload = path(LINE)
    payload['fen'] = payload['fen'].rsplit(' ', 1)[0] + ' 99'
    assert owner.post('/api/explorer/probability', json=payload).status_code == 400


def test_too_long_path_is_unavailable_without_queries(owner, monkeypatch):
    monkeypatch.setattr(explorer, '_dataset', lambda *a: pytest.fail('Do not crawl long games'))
    moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 31
    actual = result(owner, path(moves))
    assert actual['probability'] is None and actual['reason'] == 'path_too_long'


def test_disconnected_navigation_stops_between_factors(owner, monkeypatch):
    calls = []
    async def disconnected(self):
        return bool(calls)
    monkeypatch.setattr(explorer.Request, 'is_disconnected', disconnected)
    def dataset(*args):
        calls.append(args)
        return sample('e7e5', 50)
    monkeypatch.setattr(explorer, '_dataset', dataset)
    actual = result(owner, path(LINE))
    assert actual['probability'] is None and actual['reason'] == 'disconnected'
    assert actual['evaluated_opponent_moves'] == 1 and len(calls) == 1


def test_deadline_never_returns_partial_probability_as_complete(owner, monkeypatch):
    times = iter([0, 0, explorer.PROBABILITY_TIME_BUDGET + 1])
    monkeypatch.setattr(explorer, 'monotonic', lambda: next(times))
    calls = []
    def dataset(*args):
        calls.append(args)
        return sample('e7e5', 50)
    monkeypatch.setattr(explorer, '_dataset', dataset)
    actual = result(owner, path(LINE))
    assert actual['probability'] is None and actual['reason'] == 'deadline'
    assert len(calls) == 1


def test_positive_frequencies_never_underflow_to_a_false_zero(owner, monkeypatch):
    def dataset(source, fen, *args):
        board = chess.Board(fen)
        uci = 'g8f6' if board.piece_at(chess.G8) else 'f6g8'
        return sample(uci, 1, total=10**18)
    monkeypatch.setattr(explorer, '_dataset', dataset)
    moves = ['g1f3', 'g8f6', 'f3g1', 'f6g8'] * 10
    actual = result(owner, path(moves))
    assert actual['status'] == 'unavailable' and actual['probability'] is None
    assert actual['reason'] == 'underflow'


def test_primary_filters_reused_without_master_queries(owner, monkeypatch):
    calls = []
    monkeypatch.setattr(explorer.explorer_credentials, 'get_token', lambda: 'test-token')
    def remote(source, fen, **filters):
        calls.append((source, filters))
        return sample('e7e5', 20)
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data', remote)
    actual = result(owner, path(LINE[:2], speeds=['blitz'], ratings=[1800, 2000], engine_depth=30))
    assert actual['probability'] == .2
    assert calls == [('lichess', {'speeds': ['blitz'], 'ratings': [1800, 2000], 'token': 'test-token'})]


def test_local_selected_bases_use_real_counts_and_preserve_pgn(owner):
    base = owner.post('/api/bases', json={'name': 'Source'}).json()['id']
    pgns = ['[White "A"]\n\n1. e4 e5 2. Nf3 Nc6 *',
            '[White "B"]\n\n1. e4 c5 2. Nf3 Nc6 *',
            '[White "C"]\n\n1. d4 d5 *']
    for pgn in pgns:
        assert owner.post('/api/entries', json={'base_id': base, 'pgn': pgn}).status_code == 200
    with db.get_conn() as conn:
        before = [row['pgn'] for row in conn.execute('SELECT pgn FROM entries ORDER BY id')]
    actual = result(owner, path(LINE, source='local', base_ids=[base]))
    assert actual['probability'] == .5 and actual['sample_min'] == 1
    empty = result(owner, path(LINE, source='local', base_ids=[]))
    assert empty['probability'] is None and empty['reason'] == 'no_samples'
    with db.get_conn() as conn:
        assert before == [row['pgn'] for row in conn.execute('SELECT pgn FROM entries ORDER BY id')]


def test_settings_default_upgrade_and_persistence(owner):
    legacy = {key: value for key, value in explorer.DEFAULT_SETTINGS.items()
              if key not in ('repertoire_color', 'show_probability')}
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences(key,value) VALUES(?,?)', (explorer.SETTINGS_KEY, json.dumps(legacy)))
    loaded = owner.get('/api/explorer/settings').json()
    assert loaded['repertoire_color'] == 'white' and loaded['show_probability'] is True
    saved = owner.patch('/api/explorer/settings', json={'repertoire_color': 'black', 'show_probability': False})
    assert saved.status_code == 200
    assert owner.get('/api/explorer/settings').json() == saved.json()
    assert saved.json() == {**legacy, 'repertoire_color': 'black', 'show_probability': False}


@pytest.mark.parametrize('patch', [
    {'repertoire_color': 'w'}, {'repertoire_color': 'Black'}, {'repertoire_color': None},
    {'repertoire_color': True}, {'repertoire_color': []},
    {'show_probability': 1}, {'show_probability': 'true'}, {'show_probability': None},
])
def test_probability_setting_validation_is_atomic(owner, patch):
    before = owner.get('/api/explorer/settings').json()
    assert owner.patch('/api/explorer/settings', json=patch).status_code == 400
    assert owner.get('/api/explorer/settings').json() == before


def test_probability_uses_only_primary_local_population(owner, monkeypatch):
    base = owner.post('/api/bases', json={'name': 'Local population'}).json()['id']
    calls = []

    def local(fen, base_ids, **filters):
        calls.append((fen, base_ids, filters))
        return sample('e7e5', 25)

    monkeypatch.setattr(explorer.explorer_local, 'local_data', local)
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data',
                        lambda *args, **kwargs: pytest.fail('Probability must not query the comparison population'))
    filters = {'rating_min': 1700, 'rating_max': 1900, 'speeds': ['rapid', 'unknown']}
    payload = path(LINE[:2], source='local', base_ids=[base], local_filters=filters,
                   master_source='lichess', master_ratings=[2500], master_speeds=['bullet'],
                   master_local_filters={'rating_min': 2400, 'rating_max': 2600, 'speeds': ['classical']})
    actual = result(owner, payload)
    assert actual['probability'] == .25
    assert len(calls) == 1 and calls[0][1:] == ([base], filters)
    payload['settings'].update(master_source='local', master_base_ids=[base],
                               master_local_filters={'rating_min': 0, 'rating_max': 1000, 'speeds': ['blitz']})
    assert result(owner, payload)['probability'] == .25
    assert len(calls) == 2 and calls[1] == calls[0]


def test_local_probability_changes_with_primary_rating_and_cadence_only(owner, monkeypatch):
    monkeypatch.setattr(explorer.explorer_remote, 'remote_data',
                        lambda *args, **kwargs: pytest.fail('A local probability must not query Lichess'))
    base = owner.post('/api/bases', json={'name': 'Actual populations'}).json()['id']
    for name, elo, control, reply in [
        ('Rapid A', 1800, '600+0', 'e5'), ('Rapid B', 1800, '600+0', 'c5'),
        ('Master', 2400, '600+0', 'e5'), ('Unknown cadence', 1800, None, 'c5'),
    ]:
        headers = f'[White "{name}"]\n[Black "Opponent"]\n[WhiteElo "{elo}"]\n[BlackElo "{elo}"]'
        if control is not None:
            headers += f'\n[TimeControl "{control}"]'
        response = owner.post('/api/entries', json={'base_id': base, 'pgn': f'{headers}\n\n1. e4 {reply} *'})
        assert response.status_code == 200, response.text
    with db.get_conn() as conn:
        before = [row['pgn'] for row in conn.execute('SELECT pgn FROM entries ORDER BY id')]
    payload = path(LINE[:2], source='local', base_ids=[base],
                   local_filters={'rating_min': 1700, 'rating_max': 1900, 'speeds': ['rapid']},
                   master_source='local', master_base_ids=[base],
                   master_local_filters={'rating_min': 2300, 'rating_max': 2600, 'speeds': ['rapid']})
    assert result(owner, payload)['probability'] == .5
    payload['settings'].update(master_source='lichess', master_ratings=[2500], master_speeds=['bullet'])
    assert result(owner, payload)['probability'] == .5
    payload['settings']['local_filters'].update(rating_min=2300, rating_max=2600)
    assert result(owner, payload)['probability'] == 1
    payload['settings']['local_filters'].update(rating_min=1700, rating_max=1900, speeds=['unknown'])
    assert result(owner, payload)['probability'] == 0
    with db.get_conn() as conn:
        assert before == [row['pgn'] for row in conn.execute('SELECT pgn FROM entries ORDER BY id')]
