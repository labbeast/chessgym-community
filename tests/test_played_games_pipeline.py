"""The full play → import → Stockfish → exercise → review loop on an isolated DB."""
import time

import pytest
from local_test_client import TestClient

import app
import db
import engine
import pgnlib
import sync_remote


GAME = '''[Event "Pipeline test"]
[Site "https://lichess.org/Pipe1234"]
[White "pipelineplayer"]
[Black "PipelineOpponent"]
[WhiteElo "1700"]
[BlackElo "1710"]
[TimeControl "600+0"]
[Result "0-1"]

1. f3 {[%clk 0:09:58]} e5 {[%clk 0:09:59]}
2. g4 {Une erreur à retrouver. [%clk 0:09:55]} Qh4# {[%clk 0:09:56]} 0-1
'''


def wait_for(predicate, *, timeout=30):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        time.sleep(0.05)
    pytest.fail(f'Background pipeline did not finish in {timeout}s; last state: {last!r}')


def test_sync_analyse_exercise_review_end_to_end(tmp_path, monkeypatch):
    if not engine.binary_path():
        pytest.skip('Real Stockfish is required for this pipeline integration test')
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'played-games-pipeline.sqlite3')

    downloads = []
    def downloaded(site, username, **options):
        options['check_cancelled']()
        downloads.append((site, username))
        return {'games': [{'remote_id': 'Pipe1234', 'pgn': GAME, 'standard': True,
                           'finished': True, 'ended_at': time.time() * 1000}],
                'limit_reached': False}
    monkeypatch.setattr(sync_remote, 'download_games', downloaded)

    # This uses the production lifespan, including its actual persistent worker.
    with TestClient(app.app, base_url='http://localhost', client=('127.0.0.1', 50000)) as client:
        assert client.get('/api/status').status_code == 200
        source_base = client.post('/api/bases', json={'name': 'Mes parties synchronisées'}).json()['id']
        created = client.post('/api/sync/accounts', json={'site': 'lichess', 'username': 'pipelineplayer',
                            'base_id': source_base, 'auto_analyse': True, 'auto_sync': False})
        assert created.status_code == 200, created.text
        account_id = created.json()['id']

        def job_done(job_id):
            jobs = client.get('/api/jobs').json()['jobs']
            job = next(item for item in jobs if item['id'] == job_id)
            assert job['status'] not in ('error', 'cancelled'), job
            return job if job['status'] == 'done' else None

        started = client.post(f'/api/sync/accounts/{account_id}/run', json={})
        assert started.status_code == 200, started.text
        sync_job = wait_for(lambda: job_done(started.json()['job']['id']))
        assert sync_job['result']['imported'] == 1
        assert sync_job['result']['analysis_queued'] == 1
        entry_id = sync_job['result']['entry_ids'][0]
        with db.get_conn() as conn:
            imported_pgn = conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0]

        def analysis_done():
            result = client.get(f'/api/game-analysis/{entry_id}')
            assert result.status_code == 200, result.text
            report = result.json()
            assert report['status'] not in ('error', 'cancelled', 'stale'), report
            return report if report['status'] == 'done' and report['job']['status'] == 'done' else None

        report = wait_for(analysis_done)
        assert report['summary']['analysed_positions'] == 5
        assert report['summary']['blunders'] >= 1
        mistake = next(finding for finding in report['findings'] if finding['ply'] == 3)
        assert mistake['kind'] == 'blunder' and mistake['uci'] == 'g2g4'
        assert mistake['side'] == 'white' and mistake['before_path'] == '0.0'
        assert mistake['pv'] and mistake['best_uci'] != 'g2g4'

        exercise_base = client.post('/api/bases', json={'name': 'Mes erreurs à réviser'}).json()['id']
        enabled = client.patch(f'/api/bases/{exercise_base}', json={'settings': {'review_enabled': True, 'type': 'solve'}})
        assert enabled.status_code == 200, enabled.text
        made = client.post(f'/api/game-analysis/{entry_id}/exercise', json={'ply': 3, 'base_id': exercise_base,
                           'title': 'Éviter le mat', 'comment': 'Protéger le roi.', 'plies': 1})
        assert made.status_code == 200, made.text
        exercise_id = made.json()['entry_id']
        review = client.get(f'/api/bases/{exercise_base}/queue')
        assert review.status_code == 200, review.text
        cards = review.json()['cards']
        assert len(cards) == 1 and cards[0]['entry_id'] == exercise_id
        assert cards[0]['fen'] == mistake['fen']
        assert cards[0]['answers'] == [mistake['best_uci']]
        assert cards[0]['answers'] != ['g2g4']
        assert cards[0]['comment'] == 'Protéger le roi.'

        with db.get_conn() as conn:
            after_pgn = conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0]
            exercise = pgnlib.load_game(conn.execute('SELECT pgn FROM entries WHERE id=?', (exercise_id,)).fetchone()[0])
        assert imported_pgn == after_pgn  # Neither Stockfish nor exercise creation edited the source.
        original, after = pgnlib.load_game(GAME), pgnlib.load_game(after_pgn)
        assert [node.clock() for node in after.mainline()] == [node.clock() for node in original.mainline()]
        assert [node.comment for node in after.mainline()] == [node.comment for node in original.mainline()]
        assert after.headers['WhiteElo'] == '1700' and after.headers['BlackElo'] == '1710'
        assert len(list(exercise.mainline_moves())) == 1
        assert exercise.headers['SourceEntry'] == str(entry_id)

        repeated = client.post(f'/api/sync/accounts/{account_id}/run', json={})
        assert repeated.status_code == 200, repeated.text
        duplicate_job = wait_for(lambda: job_done(repeated.json()['job']['id']))
        assert duplicate_job['result']['imported'] == 0
        assert duplicate_job['result']['duplicates'] == 1
        assert duplicate_job['result']['analysis_queued'] == 0
        assert downloads == [('lichess', 'pipelineplayer'), ('lichess', 'pipelineplayer')]
        with db.get_conn() as conn:
            assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?', (source_base,)).fetchone()[0] == 1
            assert conn.execute('SELECT COUNT(*) FROM entries WHERE base_id=?', (exercise_base,)).fetchone()[0] == 1
            assert conn.execute('SELECT COUNT(*) FROM jobs WHERE kind=?', ('analyse',)).fetchone()[0] == 1
