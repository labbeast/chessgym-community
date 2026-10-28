"""Probability-ranked repertoire holes, without live remote requests."""
import asyncio
from datetime import datetime, timedelta, timezone
import json
import threading

import chess
import pytest
from fastapi import HTTPException
from local_test_client import TestClient

import db
import pgnlib
import repertoire_coverage as coverage


class Request:
    async def is_disconnected(self):
        return False


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'coverage.sqlite3')
    monkeypatch.setattr(coverage.explorer_credentials, 'get_token', lambda: 'private-test-token')
    db.init_db()
    coverage.init_coverage()


def make_base(pgns, color='white', **settings):
    settings = {'is_repertoire': True, 'color': color, **settings}
    with db.get_conn() as conn:
        base_id = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES (?,?,?)',
            ('My repertoire', json.dumps(settings), '2026-01-01')).lastrowid
        for pgn in pgns:
            conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
                VALUES (?,?,?,?,?)''', (base_id, 'Private source title', pgn, '2026-01-01', '2026-01-01'))
    return base_id


def board(moves=()):
    result = chess.Board()
    for move in moves:
        result.push_uci(move)
    return result


def sample(moves, total=100, **extra):
    return {'status': 'ok', 'moves': [{'uci': move, 'total': count} for move, count in moves.items()],
            'total': total, 'complete': sum(moves.values()) == total, 'stale': False,
            'fetched_at': datetime.now(timezone.utc).isoformat(), **extra}


def install_dataset(monkeypatch, positions):
    calls = []
    def remote(source, fen, ratings, speeds, token, *, cache_ttl):
        # A separate writer proves the caller released its SQLite transaction.
        with db.get_conn() as conn:
            conn.execute("INSERT OR REPLACE INTO preferences(key,value) VALUES('test-write','true')")
        assert source == 'lichess' and cache_ttl == 7 * 24 * 60 * 60
        assert token == 'private-test-token'
        key = coverage._key(chess.Board(fen))
        calls.append((key, ratings, speeds))
        assert key in positions, f'Unexpected statistics request: {fen}'
        return positions[key]
    monkeypatch.setattr(coverage.explorer_remote, 'remote_data', remote)
    return calls


def scan(base_id, **payload):
    return asyncio.run(coverage.scan_coverage(base_id, payload, Request()))


@pytest.mark.parametrize('color,moves,counts,expected', [
    ('white', ['e2e4'], {'e7e5': 99, 'c7c5': 1}, 'c7c5'),
    ('black', [], {'e2e4': 99, 'd2d4': 1}, 'd2d4'),
])
def test_largest_gap_is_available_below_threshold_for_both_colors(database, monkeypatch, color, moves, counts, expected):
    base_id = make_base(['1. e4 e5 2. Nf3 *'], color=color)
    calls = install_dataset(monkeypatch, {coverage._key(board(moves)): sample(counts)})
    result = scan(base_id, min_probability=.05, max_ply=2)
    assert result['status'] == 'complete'
    assert result['gaps'] == []
    assert result['best_gap']['uci'] == expected
    assert result['best_gap']['probability'] == pytest.approx(.01)
    assert result['options'] == {'min_probability': .05, 'max_ply': 2}
    assert len(calls) == 1
    assert coverage.get_coverage(base_id) == result


def test_below_threshold_search_stops_when_remaining_paths_cannot_improve_best(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 Nc6 *', '1. e4 c5 2. Nf3 *', '1. e4 d5 2. exd5 *'])
    rare = coverage._key(board(['e2e4', 'c7c5', 'g1f3']))
    calls = install_dataset(monkeypatch, {
        coverage._key(board(['e2e4'])): sample({'e7e5': 91, 'c7c5': 6, 'd7d5': 2, 'g7g6': 1}),
        coverage._key(board(['e2e4', 'e7e5', 'g1f3'])): sample({'b8c6': 100}),
        rare: sample({'d7d6': 70, 'a7a6': 30}),
    })
    result = scan(base_id, min_probability=.1, max_ply=4)
    assert result['gaps'] == []
    # The known 1% hole (1...g6) must not hide a larger hole reached through
    # the covered 6% Sicilian branch, even though both are below the 10% filter.
    assert result['best_gap']['san_line'] == '1. e4 c5 2. Nf3 d6'
    assert result['best_gap']['probability'] == pytest.approx(.042)
    assert result['status'] == 'complete'
    assert len(calls) == 3 and calls[-1][0] == rare
    # No request for the 2% Scandinavian branch, which cannot beat 4.2%.
    assert rare in result['sample_keys']
    assert coverage._key(board(['e2e4', 'c7c5'])) not in result['priorities']
    repeated = scan(base_id)
    assert repeated['best_gap'] == result['best_gap']
    assert repeated['request_count'] == 0 and len(calls) == 3


def test_below_threshold_own_reply_hole_is_retained_without_remote_expansion(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 Nc6 *', '1. e4 c5 *'])
    calls = install_dataset(monkeypatch, {
        coverage._key(board(['e2e4'])): sample({'e7e5': 99, 'c7c5': 1}),
        coverage._key(board(['e2e4', 'e7e5', 'g1f3'])): sample({'b8c6': 100}),
    })
    result = scan(base_id, min_probability=.05, max_ply=4)
    assert result['gaps'] == []
    assert result['best_gap']['kind'] == 'own_reply'
    assert result['best_gap']['san_line'] == '1. e4 c5'
    assert result['best_gap']['probability'] == pytest.approx(.01)
    assert len(calls) == 2


def test_below_threshold_search_keeps_request_budget_and_resumes_from_samples(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 Nc6 *', '1. e4 c5 2. Nf3 *'])
    calls = install_dataset(monkeypatch, {
        coverage._key(board(['e2e4'])): sample({'e7e5': 99, 'c7c5': 1}),
        coverage._key(board(['e2e4', 'e7e5', 'g1f3'])): sample({'b8c6': 100}),
        coverage._key(board(['e2e4', 'c7c5', 'g1f3'])): sample({'d7d6': 100}),
    })
    monkeypatch.setattr(coverage, 'MAX_REQUESTS', 2)
    first = scan(base_id, min_probability=.05, max_ply=4)
    assert first['status'] == 'partial' and first['best_gap'] is None
    assert first['gaps'] == [] and first['resumable']
    assert first['request_count'] == len(calls) == 2
    second = scan(base_id)
    assert second['status'] == 'complete'
    assert second['best_gap']['probability'] == pytest.approx(.01)
    assert second['request_count'] == 1 and len(calls) == 3
    assert second['options'] == first['options']


def test_white_probabilities_ignore_our_moves_and_find_first_holes(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 Nc6 3. Bb5 *'])
    e4, e4e5nf3 = board(['e2e4']), board(['e2e4', 'e7e5', 'g1f3'])
    calls = install_dataset(monkeypatch, {
        coverage._key(e4): sample({'e7e5': 60, 'c7c5': 40}),
        coverage._key(e4e5nf3): sample({'b8c6': 50, 'g8f6': 50}),
    })
    result = scan(base_id, max_ply=5)
    assert result['status'] == 'complete'
    assert result['priorities'][coverage._key(chess.Board())] == 1
    assert result['priorities'][coverage._key(board(['e2e4', 'e7e5']))] == .6
    assert result['priorities'][coverage._key(board(['e2e4', 'e7e5', 'g1f3', 'b8c6']))] == .3
    assert [gap['probability'] for gap in result['gaps']] == [.4, .3]
    assert all(gap['kind'] == 'opponent_reply' for gap in result['gaps'])
    assert [gap['san'] for gap in result['gaps']] == ['c5', 'Nf6']
    assert len(calls) == 2 and all(key.split()[1] == 'b' for key, _, _ in calls)
    assert result['gaps'][0]['san_line'] == '1. e4 c5'
    for gap in result['gaps']:
        game = pgnlib.load_game(gap['pgn'])
        assert game.end().board().fen() == gap['fen']
        assert 'Private source title' not in gap['pgn']


def test_black_counts_only_white_responses(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 Nc6 *'], color='black')
    calls = install_dataset(monkeypatch, {
        coverage._key(chess.Board()): sample({'e2e4': 60, 'd2d4': 40}),
        coverage._key(board(['e2e4', 'e7e5'])): sample({'g1f3': 90, 'f1c4': 10}),
    })
    result = scan(base_id, max_ply=4)
    assert result['priorities'][coverage._key(board(['e2e4']))] == .6
    assert result['priorities'][coverage._key(board(['e2e4', 'e7e5', 'g1f3']))] == pytest.approx(.54)
    assert [gap['probability'] for gap in result['gaps']] == [.4, .06]
    assert all(key.split()[1] == 'w' for key, _, _ in calls)


def test_known_opponent_reply_without_our_answer_has_distinct_kind(database, monkeypatch):
    base_id = make_base(['1. e4 e5 *'])
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])): sample({'e7e5': 100})})
    result = scan(base_id, max_ply=5)
    assert len(result['gaps']) == 1
    gap = result['gaps'][0]
    assert gap['kind'] == 'own_reply' and gap['probability'] == 1
    assert gap['path'] == '0.0' and gap['uci'] is None
    assert gap['fen'] == board(['e2e4', 'e7e5']).fen()


def test_transpositions_deduplicate_priorities_and_existing_answer_avoids_gap(database, monkeypatch):
    # 1.Nf3 d5 2.d4 transposes after ...Nf6 into a prepared response in the
    # other entry. The missing order must not become an artificial hole.
    base_id = make_base(['1. Nf3 d5 2. d4 *', '1. d4 Nf6 2. Nf3 d5 3. c4 *'])
    positions = {}
    for prefix, reply, count in [
        (['g1f3'], 'd7d5', 100),
        (['g1f3', 'd7d5', 'd2d4'], 'g8f6', 100),
        (['d2d4'], 'g8f6', 100),
        (['d2d4', 'g8f6', 'g1f3'], 'd7d5', 100),
    ]:
        positions[coverage._key(board(prefix))] = sample({reply: count})
    calls = install_dataset(monkeypatch, positions)
    result = scan(base_id, max_ply=5)
    target = coverage._key(board(['d2d4', 'g8f6', 'g1f3', 'd7d5']))
    assert result['priorities'][target] == 1, 'Own choices and transpositions are never summed to 2'
    assert result['gaps'] == []
    assert len(calls) == 4


def test_duplicate_chapters_and_own_branches_do_not_add_probability(database, monkeypatch):
    base_id = make_base(['1. e4 e5 *', '1. e4 e5 *', '1. d4 d5 *'])
    calls = install_dataset(monkeypatch, {
        coverage._key(board(['e2e4'])): sample({'e7e5': 100}),
        coverage._key(board(['d2d4'])): sample({'d7d5': 100}),
    })
    result = scan(base_id)
    assert len(calls) == 2 and len(result['gaps']) == 2
    assert all(gap['probability'] == 1 for gap in result['gaps'])
    assert result['probability_method'] == 'maximum_path'
    assert result['priorities'][coverage._key(chess.Board())] == 1


def test_cached_get_and_priorities_never_access_remote_or_change_transaction(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])): sample({'e7e5': 100})})
    result = scan(base_id, max_ply=3)
    monkeypatch.setattr(coverage.explorer_remote, 'remote_data', lambda *a, **k: pytest.fail('Unexpected network'))
    assert coverage.get_coverage(base_id) == result
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        before = conn.total_changes
        assert coverage.cached_priorities(conn, base_id) == result['priorities']
        assert conn.in_transaction and conn.total_changes == before
        settings = {'is_repertoire': True, 'color': 'white', 'opening_priority': 'probability', 'mode': 'hybrid'}
        conn.execute('UPDATE bases SET settings=? WHERE id=?', (json.dumps(settings), base_id))
        assert coverage.cached_priorities(conn, base_id) == result['priorities']
        conn.execute('UPDATE entries SET pgn=? WHERE base_id=?', ('1. d4 d5 *', base_id))
        assert coverage.cached_priorities(conn, base_id) == {}
    assert coverage.get_coverage(base_id)['status'] == 'not_scanned'


def test_incremental_request_limit_resumes_from_saved_samples(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 Nc6 3. Bb5 *'])
    calls = install_dataset(monkeypatch, {
        coverage._key(board(['e2e4'])): sample({'e7e5': 100}),
        coverage._key(board(['e2e4', 'e7e5', 'g1f3'])): sample({'b8c6': 100}),
    })
    monkeypatch.setattr(coverage, 'MAX_REQUESTS', 1)
    first = scan(base_id, max_ply=5)
    assert first['status'] == 'partial' and first['request_count'] == 1 and first['truncated']
    second = scan(base_id)
    assert second['status'] == 'complete' and second['request_count'] == 1
    assert len(calls) == 2
    third = scan(base_id)
    assert third['request_count'] == 0 and third['status'] == 'complete'


@pytest.mark.parametrize('status', ['auth_required', 'rate_limited', 'unavailable'])
def test_outage_is_partial_and_not_zero_or_fake_gap(database, monkeypatch, status):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])):
        {'status': status, 'total': 0, 'moves': [], 'message': 'Service indisponible'}})
    result = scan(base_id, max_ply=3)
    assert result['status'] == 'partial' and result['unknown_count'] == 1
    assert result['gaps'] == [] and result['message'] == 'Service indisponible'
    assert coverage._key(board(['e2e4', 'e7e5'])) not in result['priorities']


def test_incomplete_statistics_preserve_unknown_mass_and_true_frequencies(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])):
        sample({'e7e5': 20, 'c7c5': 10}, total=100)})
    result = scan(base_id, max_ply=3)
    assert result['status'] == 'partial' and result['unknown_count'] == 1
    assert result['gaps'][0]['probability'] == .1
    assert result['priorities'][coverage._key(board(['e2e4', 'e7e5']))] == .2


def test_custom_roots_are_explicitly_conditional_and_pgn_is_replayable(database, monkeypatch):
    start = board(['e2e4'])
    game = chess.pgn.Game()
    game.setup(start)
    game.add_variation(chess.Move.from_uci('e7e5')).add_variation(chess.Move.from_uci('g1f3'))
    base_id = make_base([pgnlib.export_game(game)])
    install_dataset(monkeypatch, {coverage._key(start): sample({'e7e5': 60, 'c7c5': 40})})
    result = scan(base_id, max_ply=2)
    assert result['conditional_root']
    gap = result['gaps'][0]
    assert gap['conditional_root'] and gap['root_fen'] == start.fen()
    assert gap['san_line'] == '1... c5'
    assert pgnlib.load_game(gap['pgn']).end().board().fen() == gap['fen']


@pytest.mark.parametrize('payload', [
    {'min_probability': 0}, {'min_probability': True}, {'min_probability': float('nan')},
    {'max_ply': 0}, {'max_ply': 61}, {'max_ply': True}, {'ratings': []},
    {'ratings': [1650]}, {'speeds': ['unknown']}, {'reset': 'yes'}, {'source': 'masters'},
])
def test_invalid_options_rejected_before_any_remote_request(database, monkeypatch, payload):
    base_id = make_base(['1. e4 *'])
    monkeypatch.setattr(coverage.explorer_remote, 'remote_data', lambda *a, **k: pytest.fail('Network before validation'))
    with pytest.raises(HTTPException) as error:
        scan(base_id, **payload)
    assert error.value.status_code == 422


def test_scan_does_not_modify_pgn_selection_or_card_history(database, monkeypatch):
    import training
    training.init_training()
    base_id = make_base(['1. e4 e5 2. Nf3 *'], review_enabled=True, type='moves')
    cards = training.queue(base_id)['cards']
    training.grade_card(cards[0]['id'], training.GradeRequest(grade=2))
    with db.get_conn() as conn:
        before_entries = [tuple(row) for row in conn.execute('SELECT * FROM entries')]
        before_cards = [tuple(row) for row in conn.execute('SELECT * FROM review_cards')]
        before_history = [tuple(row) for row in conn.execute('SELECT * FROM review_history')]
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])): sample({'e7e5': 100})})
    scan(base_id, max_ply=3)
    with db.get_conn() as conn:
        assert [tuple(row) for row in conn.execute('SELECT * FROM entries')] == before_entries
        assert [tuple(row) for row in conn.execute('SELECT * FROM review_cards')] == before_cards
        assert [tuple(row) for row in conn.execute('SELECT * FROM review_history')] == before_history


def test_repeated_position_cycle_terminates_without_repeated_requests(database, monkeypatch):
    base_id = make_base(['1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 *'])
    calls = install_dataset(monkeypatch, {
        coverage._key(board(['g1f3'])): sample({'g8f6': 100}),
        coverage._key(board(['g1f3', 'g8f6', 'f3g1'])): sample({'f6g8': 100}),
    })
    result = scan(base_id, max_ply=60)
    assert result['positions_scanned'] == 4 and len(calls) == 2
    assert result['gaps'] == []


def test_fingerprint_change_during_network_rejects_stale_report(database, monkeypatch):
    base_id = make_base(['1. e4 e5 *'])
    def changed(*args, **kwargs):
        with db.get_conn() as conn:
            conn.execute('UPDATE entries SET pgn=? WHERE base_id=?', ('1. d4 d5 *', base_id))
        return sample({'e7e5': 100})
    monkeypatch.setattr(coverage.explorer_remote, 'remote_data', changed)
    with pytest.raises(HTTPException) as error:
        scan(base_id)
    assert error.value.status_code == 409
    assert coverage.get_coverage(base_id)['status'] == 'not_scanned'


def test_busy_scan_has_clear_conflict_and_missing_table_is_safe(database):
    base_id = make_base(['1. e4 *'])
    lock = threading.Lock()
    key = (str(db.DB_PATH.resolve()), base_id)
    coverage._locks[key] = lock
    lock.acquire()
    try:
        with pytest.raises(HTTPException) as error:
            scan(base_id)
        assert error.value.status_code == 409
    finally:
        lock.release()
    with db.get_conn() as conn:
        conn.execute('DROP TABLE repertoire_coverage')
        assert coverage.cached_priorities(conn, base_id) == {}


def test_expired_report_is_not_used_for_priorities(database, monkeypatch):
    base_id = make_base(['1. e4 *'])
    scan(base_id, max_ply=1)
    with db.get_conn() as conn:
        expired = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        conn.execute('UPDATE repertoire_coverage SET updated_at=? WHERE base_id=?', (expired, base_id))
        assert coverage.cached_priorities(conn, base_id) == {}
    assert coverage.get_coverage(base_id)['status'] == 'not_scanned'


def test_api_authentication_filters_and_persisted_restart(database, monkeypatch):
    import app
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    calls = install_dataset(monkeypatch, {coverage._key(board(['e2e4'])): sample({'e7e5': 100})})

    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        endpoint = f'/api/repertoires/{base_id}/coverage'
        assert client.get(endpoint, headers={'Host': 'remote.invalid'}).status_code == 403
        assert client.post(endpoint, json={}, headers={'Host': 'remote.invalid'}).status_code == 403
        assert client.get('/api/status').status_code == 200
        result = client.post(endpoint, json={'max_ply': 3, 'ratings': [1800, 2000], 'speeds': ['rapid', 'blitz']})
        assert result.status_code == 200, result.text
        report = result.json()
        assert report['filters'] == {'ratings': [1800, 2000], 'speeds': ['blitz', 'rapid']}
        assert calls[0][1:] == ([1800, 2000], ['blitz', 'rapid'])
        assert client.post(endpoint, json={}, headers={'origin': 'https://unrelated.example'}).status_code == 403
    monkeypatch.setattr(coverage.explorer_remote, 'remote_data', lambda *a, **k: pytest.fail('Restart GET cannot fetch remotely'))
    coverage._locks.clear()
    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        assert client.get('/api/status').status_code == 200
        assert client.get(endpoint).json() == report
        assert client.post(endpoint, json={}).json()['request_count'] == 0


def test_invalid_source_is_partial_and_has_no_false_gap(database, monkeypatch):
    base_id = make_base(['1. e4 invalid *'])
    monkeypatch.setattr(coverage.explorer_remote, 'remote_data', lambda *a, **k: pytest.fail('Invalid PGN cannot query'))
    result = scan(base_id)
    assert result['status'] == 'partial' and result['unknown_count'] == 1
    assert result['gaps'] == []


def test_profile_change_does_not_reuse_incompatible_samples(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    calls = install_dataset(monkeypatch, {coverage._key(board(['e2e4'])): sample({'e7e5': 100})})
    scan(base_id, max_ply=3)
    scan(base_id, ratings=[2000], speeds=['blitz'])
    assert len(calls) == 2
    assert calls[-1][1:] == ([2000], ['blitz'])


def test_disconnection_keeps_partial_work_without_network(database, monkeypatch):
    base_id = make_base(['1. e4 e5 *'])
    class Disconnected:
        async def is_disconnected(self):
            return True
    monkeypatch.setattr(coverage.explorer_remote, 'remote_data', lambda *a, **k: pytest.fail('Disconnected scan cannot query'))
    result = asyncio.run(coverage.scan_coverage(base_id, {}, Disconnected()))
    assert result['status'] == 'partial' and result['truncated']
    assert result['request_count'] == 0


def test_fresh_report_does_not_extend_expired_statistics_lifetime(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])): sample({'e7e5': 100})})
    scan(base_id, max_ply=3)
    with db.get_conn() as conn:
        row = conn.execute('SELECT samples FROM repertoire_coverage WHERE base_id=?', (base_id,)).fetchone()
        samples = json.loads(row['samples'])
        for value in samples.values():
            value['fetched_at'] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
        conn.execute('UPDATE repertoire_coverage SET samples=? WHERE base_id=?', (json.dumps(samples), base_id))
        assert coverage.cached_priorities(conn, base_id) == {}
    assert coverage.get_coverage(base_id)['status'] == 'not_scanned'


def test_valid_until_follows_oldest_used_sample_and_ignores_unused_samples(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    fetched = datetime.now(timezone.utc) - timedelta(days=6)
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])):
        sample({'e7e5': 100}, fetched_at=fetched.isoformat())})
    first = scan(base_id, max_ply=3)
    second = scan(base_id)
    assert second['valid_until'] == first['valid_until']
    assert datetime.fromisoformat(second['valid_until']) == fetched + timedelta(days=7)
    with db.get_conn() as conn:
        row = conn.execute('SELECT samples FROM repertoire_coverage WHERE base_id=?', (base_id,)).fetchone()
        samples = json.loads(row['samples'])
        samples['unused'] = {'fetched_at': (fetched - timedelta(days=5)).isoformat(), 'data': {}}
        conn.execute('UPDATE repertoire_coverage SET samples=? WHERE base_id=?', (json.dumps(samples), base_id))
        assert coverage.cached_priorities(conn, base_id) == first['priorities']
    assert coverage.get_coverage(base_id) == second


@pytest.mark.parametrize('constant,value,reason', [
    ('MAX_VISITS', 2, 'position_limit'),
    ('MAX_GRAPH_NODES', 2, 'source_size'),
    ('MAX_GAPS', 0, 'result_limit'),
])
def test_fixed_limits_do_not_promise_that_continuation_can_finish(database, monkeypatch, constant, value, reason):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    install_dataset(monkeypatch, {coverage._key(board(['e2e4'])): sample({'e7e5': 50, 'c7c5': 50})})
    monkeypatch.setattr(coverage, constant, value)
    result = scan(base_id, max_ply=3)
    assert result['status'] == 'partial'
    assert result['needs_narrowing'] and not result['resumable']
    assert reason in result['limit_reasons']
    assert 'continue' not in result['message'].lower()


def test_request_limit_is_explicitly_resumable(database, monkeypatch):
    base_id = make_base(['1. e4 e5 2. Nf3 *'])
    monkeypatch.setattr(coverage, 'MAX_REQUESTS', 0)
    result = scan(base_id, max_ply=3)
    assert result['resumable'] and not result['needs_narrowing']
    assert result['limit_reasons'] == ['request_limit']


def test_deleted_entry_invalidates_report_but_shared_side_variation_still_has_gap(database, monkeypatch):
    source = '1. Nf3 f5 2. d3 (2. g3 { would also be fine. }) Nf6 3. g3 *'
    base_id = make_base([source] * 4 + ['1. Nf3 f5 2. g3 *'])
    install_dataset(monkeypatch, {
        coverage._key(board(['g1f3'])): sample({'f7f5': 100}),
        coverage._key(board(['g1f3', 'f7f5', 'd2d3'])): sample({'g8f6': 100}),
        coverage._key(board(['g1f3', 'f7f5', 'g2g3'])): sample({'g8f6': 100}),
    })
    first = scan(base_id, max_ply=5)
    assert [gap['san_line'] for gap in first['gaps']] == ['1. Nf3 f5 2. g3 Nf6']
    with db.get_conn() as conn:
        removed = conn.execute('SELECT MAX(id) FROM entries WHERE base_id=?', (base_id,)).fetchone()[0]
        conn.execute('DELETE FROM entries WHERE id=?', (removed,))
        assert coverage.cached_priorities(conn, base_id) == {}
    invalidated = coverage.get_coverage(base_id)
    assert invalidated['status'] == 'not_scanned' and invalidated['stale']
    assert invalidated['gaps'] == []

    monkeypatch.setattr(coverage.explorer_remote, 'remote_data',
        lambda *args, **kwargs: pytest.fail('Fresh position samples should be reused'))
    second = scan(base_id)
    assert second['request_count'] == 0
    assert [gap['san_line'] for gap in second['gaps']] == ['1. Nf3 f5 2. g3 Nf6']
    assert second['gaps'][0]['entry_id'] != removed
    with db.get_conn() as conn:
        remaining = conn.execute('SELECT pgn FROM entries WHERE base_id=?', (base_id,)).fetchall()
        assert len(remaining) == 4
        assert all(row['pgn'] == source for row in remaining)
    assert coverage.get_coverage(base_id) == second


def test_removing_side_variation_from_all_sources_drops_gap_despite_cached_samples(database, monkeypatch):
    source = '1. Nf3 f5 2. d3 (2. g3 { would also be fine. }) Nf6 3. g3 *'
    base_id = make_base([source] * 4)
    calls = install_dataset(monkeypatch, {
        coverage._key(board(['g1f3'])): sample({'f7f5': 100}),
        coverage._key(board(['g1f3', 'f7f5', 'd2d3'])): sample({'g8f6': 100}),
        coverage._key(board(['g1f3', 'f7f5', 'g2g3'])): sample({'g8f6': 100}),
    })
    first = scan(base_id, max_ply=5)
    assert [gap['san_line'] for gap in first['gaps']] == ['1. Nf3 f5 2. g3 Nf6']
    assert len(calls) == 3
    with db.get_conn() as conn:
        entries = conn.execute('SELECT id,pgn FROM entries WHERE base_id=?', (base_id,)).fetchall()
        for entry in entries:
            game = pgnlib.load_game(entry['pgn'])
            game.variations[0].variations[0].remove_variation(chess.Move.from_uci('g2g3'))
            conn.execute('UPDATE entries SET pgn=? WHERE id=?', (pgnlib.export_game(game), entry['id']))
        assert coverage.cached_priorities(conn, base_id) == {}
        updated = [row['pgn'] for row in conn.execute('SELECT pgn FROM entries WHERE base_id=?', (base_id,))]
    assert coverage.get_coverage(base_id)['status'] == 'not_scanned'

    monkeypatch.setattr(coverage.explorer_remote, 'remote_data',
        lambda *args, **kwargs: pytest.fail('Fresh position samples should be reused'))
    second = scan(base_id)
    assert second['status'] == 'complete' and second['request_count'] == 0
    assert second['gaps'] == []
    assert coverage._key(board(['g1f3', 'f7f5', 'd2d3', 'g8f6'])) in second['priorities']
    assert coverage._key(board(['g1f3', 'f7f5', 'g2g3'])) not in second['sample_keys']
    with db.get_conn() as conn:
        assert [row['pgn'] for row in conn.execute('SELECT pgn FROM entries WHERE base_id=?', (base_id,))] == updated
    for pgn in updated:
        game = pgnlib.load_game(pgn)
        assert [move.uci() for move in game.mainline_moves()] == ['g1f3', 'f7f5', 'd2d3', 'g8f6', 'g2g3']
        assert len(game.variations[0].variations[0].variations) == 1
