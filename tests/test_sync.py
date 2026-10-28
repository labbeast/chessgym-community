import json
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

import db
import jobs
import sync
import sync_remote


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'sync.sqlite3')
    db.init_db()
    sync.init_sync()
    jobs.init_jobs()
    with db.get_conn() as conn:
        conn.execute("INSERT INTO bases(id,name,settings,created_at) VALUES(1,'Played','{\"review_enabled\":false}',?)", (sync._now(),))
        conn.execute("INSERT INTO bases(id,name,created_at) VALUES(2,'Other',?)", (sync._now(),))
    return 1


def account(**kwargs):
    return sync.create_account({'site': 'lichess', 'username': 'Example', 'base_id': 1, 'auto_analyse': False, **kwargs})


def record(identifier='abcdefgh', *, site='lichess', comment='[%clk 0:09:58]', result='1-0', moves='1. e4 { COMMENT } e5 2. Nf3 Nc6'):
    url = sync_remote.canonical_url(site, identifier)
    return {'remote_id': identifier, 'standard': True, 'finished': True, 'pgn': f'[White "example"]\n[Black "Opponent"]\n[Site "{url}"]\n[Result "{result}"]\n\n{moves.replace("COMMENT", comment)} {result}'}


class Context:
    def __init__(self):
        self.cancel_event = threading.Event()
        self.steps = []
    def check_cancelled(self):
        if self.cancel_event.is_set():
            raise jobs.JobCancelled()
    def progress(self, done, total, message):
        self.steps.append((done, total, message))


def download(monkeypatch, records, limited=False):
    monkeypatch.setattr(sync_remote, 'download_games', lambda *a, **k: {'games': records, 'limit_reached': limited})


def test_account_lifecycle_preserves_games_and_played_settings(store):
    saved = account()
    assert saved['username'] == 'example' and saved['base_name'] == 'Played'
    assert saved['enabled'] and not saved['auto_sync'] and saved['max_games'] == 100
    with db.get_conn() as conn:
        settings = json.loads(conn.execute('SELECT settings FROM bases WHERE id=1').fetchone()[0])
    assert settings == {'review_enabled': False, 'played': True}
    changed = sync.update_account(saved['id'], {'max_games': 200, 'auto_sync': True})
    assert changed['max_games'] == 200 and changed['auto_sync']
    with pytest.raises(ValueError):
        account()
    assert sync.delete_account(saved['id']) == {'deleted': True}
    assert sync.list_accounts() == {'accounts': []}
    assert account()['id'] != saved['id']


@pytest.mark.parametrize('patch', [
    {'site':'other'}, {'username':'https://evil.com'}, {'username':'a\r\nb'},
    {'username':'a'}, {'base_id':True}, {'base_id':0}, {'base_id':999},
    {'auto_sync':1}, {'auto_analyse':'false'}, {'enabled':0},
    {'max_games':501}, {'max_games':0}, {'max_games':True}, {'max_games':1.1},
    {'lookback_days':366}, {'lookback_days':0}, {'interval_minutes':14},
    {'interval_minutes':1441}, {'extra':'bad'}])
def test_invalid_account_is_atomic(store, patch):
    before = sync.list_accounts()
    with pytest.raises((ValueError, HTTPException)):
        account(**patch)
    assert sync.list_accounts() == before


def test_import_preserves_clocks_and_annotations_repeat_never_overwrites(store, monkeypatch):
    saved = account()
    download(monkeypatch, [record()])
    result = sync.sync_account(Context(), {'account_id': saved['id']})
    assert result['imported'] == 1 and result['entry_ids']
    entry_id = result['entry_ids'][0]
    with db.get_conn() as conn:
        text = conn.execute('SELECT pgn FROM entries WHERE id=?', (entry_id,)).fetchone()[0]
        assert '[%clk 0:09:58]' in text
        conn.execute('UPDATE entries SET pgn=? WHERE id=?', (text.replace('e4', 'e4 $1 { Personal note }', 1).replace('abcdefgh', 'changed'), entry_id))
    result = sync.sync_account(Context(), {'account_id': saved['id']})
    assert result['imported'] == 0 and result['duplicates'] == 1
    with db.get_conn() as conn:
        assert 'Personal note' in conn.execute('SELECT pgn FROM entries').fetchone()[0]
    sync.delete_account(saved['id'])
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 1
    fresh = account()
    assert sync.sync_account(Context(), {'account_id': fresh['id']})['duplicates'] == 1


def test_link_existing_pgn_without_touching_content(store, monkeypatch):
    saved = account()
    source = record(comment='My existing annotation')['pgn']
    with db.get_conn() as conn:
        conn.execute('INSERT INTO entries(id,base_id,title,pgn,created_at,updated_at) VALUES(42,1,?,?,?,?)', ('original', source, 'date', 'date'))
    download(monkeypatch, [record()])
    result = sync.sync_account(Context(), {'account_id': saved['id']})
    assert result['linked'] == 1 and result['imported'] == 0
    with db.get_conn() as conn:
        assert conn.execute('SELECT pgn FROM entries WHERE id=42').fetchone()[0] == source


def test_same_remote_game_can_exist_in_separate_destinations(store, monkeypatch):
    first, second = account(), account(base_id=2)
    download(monkeypatch, [record(), record()])
    for target in (first, second):
        result = sync.sync_account(Context(), {'account_id':target['id']})
        assert result['imported'] == 1 and result['duplicates'] == 1


def test_source_link_on_an_exercise_does_not_hide_the_original_game(store, monkeypatch):
    saved=account()
    derived='[SourceEntry "99"]\n[SourcePly "1"]\n'+record()['pgn']
    with db.get_conn() as conn:
        conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(1,?,?,?,?)',('exercise',derived,'date','date'))
    download(monkeypatch,[record()])
    result=sync.sync_account(Context(),{'account_id':saved['id']})
    assert result['imported']==1 and result['linked']==0


@pytest.mark.parametrize('patch', [
    {'standard':False}, {'finished':False}, {'remote_id':None}, {'remote_id':2},
    {'remote_id':'evil'}, {'pgn':'not pgn'}, {'pgn':None},
    {'pgn':record(result='*')['pgn']},
    {'pgn':record()['pgn'].replace('example','another')},
    {'pgn':record()['pgn'].replace('e4', 'e5',1)},
    {'pgn':record(moves='')['pgn']},
])
def test_unusable_games_skip_without_abort(store, monkeypatch, patch):
    saved = account()
    download(monkeypatch, [{**record(), **patch}, record('ijklmnop')])
    result = sync.sync_account(Context(), {'account_id': saved['id']})
    assert result['skipped'] == 1 and result['imported'] == 1


def test_cancel_preserves_committed_games_and_reports_partial_result(store, monkeypatch):
    saved = account()
    download(monkeypatch, [record(), record('ijklmnop')])
    ctx = Context()
    original = ctx.progress
    def progress(done, total, message):
        original(done,total,message)
        if done == 1:
            ctx.cancel_event.set()
    ctx.progress = progress
    with pytest.raises(jobs.JobCancelled):
        sync.sync_account(ctx, {'account_id':saved['id']})
    current = sync.list_accounts()['accounts'][0]
    assert current['last_sync_at'] is None and current['last_result']['imported'] == 1
    assert 'interrompue' in current['last_error']
    assert sync.sync_account(Context(), {'account_id':saved['id']})['imported'] == 1


@pytest.mark.parametrize('patch', [{'base_id': 2}, {'site': 'chesscom'}, {'username': 'changed'}])
def test_connection_changed_during_download_imports_nothing(store, monkeypatch, patch):
    # Windows can return the same clock value for two consecutive changes.
    monkeypatch.setattr(sync, '_now', lambda: '2026-10-28T12:00:00+00:00')
    saved = account()
    def altered(*args,**kwargs):
        changed = sync.update_account(saved['id'], patch)
        assert changed['updated_at'] == saved['updated_at']
        return {'games':[record()]}
    monkeypatch.setattr(sync_remote, 'download_games', altered)
    with pytest.raises(jobs.JobCancelled):
        sync.sync_account(Context(), {'account_id':saved['id']})
    with db.get_conn() as conn:
        assert conn.execute('SELECT count(*) FROM entries').fetchone()[0] == 0
    current = sync.list_accounts()['accounts'][0]
    assert current['last_error'] is None and current['last_result'] is None
    assert all(current[key] == value for key, value in patch.items())


def test_auto_analysis_only_for_new_games_and_failure_does_not_stop_import(store, monkeypatch):
    import game_analysis
    saved = account(auto_analyse=True)
    download(monkeypatch, [record(),record('ijklmnop')], True)
    called=[]
    def queue(entry_id):
        called.append(entry_id)
        if len(called)==1:
            raise HTTPException(503,'Engine missing')
    monkeypatch.setattr(game_analysis, 'queue_analysis', queue)
    result=sync.sync_account(Context(), {'account_id':saved['id']})
    assert result['imported']==2 and result['analysis_queued']==1 and result['analysis_skipped']==1
    assert result['limit_reached'] and 'Limite atteinte' in result['message']
    resumed=sync.sync_account(Context(), {'account_id':saved['id']})
    assert len(called)==3 and resumed['analysis_queued']==1
    assert called[0]==called[2]


def test_auto_analysis_outbox_survives_interruption_after_import(store, monkeypatch):
    import game_analysis
    saved=account(auto_analyse=True)
    download(monkeypatch,[record()])
    ctx=Context()
    def interrupt(done,total,message):
        if done:
            ctx.cancel_event.set()
    ctx.progress=interrupt
    called=[]
    monkeypatch.setattr(game_analysis,'queue_analysis',lambda entry_id:called.append(entry_id))
    with pytest.raises(jobs.JobCancelled):
        sync.sync_account(ctx,{'account_id':saved['id']})
    assert called==[]
    with db.get_conn() as conn:
        assert conn.execute('SELECT needs_analysis FROM sync_imports').fetchone()[0]==1
    resumed=sync.sync_account(Context(),{'account_id':saved['id']})
    assert resumed['imported']==0 and resumed['analysis_queued']==1 and len(called)==1
    with db.get_conn() as conn:
        assert conn.execute('SELECT needs_analysis FROM sync_imports').fetchone()[0]==0


def test_linked_manual_game_is_not_added_to_analysis_outbox(store, monkeypatch):
    import game_analysis
    saved=account(auto_analyse=True)
    with db.get_conn() as conn:
        conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(1,?,?,?,?)',('manual',record()['pgn'],'date','date'))
    download(monkeypatch,[record()])
    called=[]
    monkeypatch.setattr(game_analysis,'queue_analysis',lambda entry_id:called.append(entry_id))
    result=sync.sync_account(Context(),{'account_id':saved['id']})
    assert result['linked']==1 and called==[]


def test_remote_failure_records_safe_error_and_no_success_timestamp(store, monkeypatch):
    saved=account()
    def failed(*args,**kwargs):
        raise sync_remote.RemoteError('Site inaccessible')
    monkeypatch.setattr(sync_remote, 'download_games', failed)
    with pytest.raises(sync_remote.RemoteError):
        sync.sync_account(Context(), {'account_id':saved['id']})
    current=sync.list_accounts()['accounts'][0]
    assert current['last_error']=='Site inaccessible' and current['last_sync_at'] is None
    assert current['last_attempt_at']


def test_partial_chesscom_sync_imports_preserves_annotations_and_retries(store, monkeypatch):
    saved = account(site='chesscom')
    download(monkeypatch, [])
    sync.sync_account(Context(), {'account_id': saved['id']})
    last_complete = sync.list_accounts()['accounts'][0]['last_sync_at']
    data = {'games': [record('live:123', site='chesscom')], 'limit_reached': False,
            'partial': True, 'unavailable_months': ['2026-10']}
    monkeypatch.setattr(sync_remote, 'download_games', lambda *a, **k: data)
    first = sync.sync_account(Context(), {'account_id': saved['id']})
    current = sync.list_accounts()['accounts'][0]
    assert first['imported'] == 1 and first['partial']
    assert current['last_sync_at'] == last_complete and current['last_error'] is None
    assert current['last_result']['unavailable_months'] == ['2026-10']
    assert 'partielle' in first['message'] and '2026-10' in first['message']
    with db.get_conn() as conn:
        conn.execute("UPDATE entries SET title='Personal title' WHERE id=?", (first['entry_ids'][0],))
    data.update(partial=False, unavailable_months=[])
    again = sync.sync_account(Context(), {'account_id': saved['id']})
    assert again['duplicates'] == 1 and again['imported'] == 0
    current = sync.list_accounts()['accounts'][0]
    assert not current['last_result']['partial'] and current['last_sync_at'] != last_complete
    with db.get_conn() as conn:
        assert conn.execute('SELECT title FROM entries').fetchone()[0] == 'Personal title'


def test_queue_and_scheduler_deduplicate_and_honor_opt_in(store):
    first=account(auto_sync=True)
    account(base_id=2)
    assert len(sync.schedule_due())==1
    assert sync.run_account(first['id'], {})['job']['id']==sync.schedule_due()[0]['id']
    with db.get_conn() as conn:
        conn.execute('UPDATE sync_accounts SET last_attempt_at=? WHERE id=?', (sync._now(),first['id']))
    assert sync.schedule_due()==[]
    assert len(sync.run_all({})['jobs'])==2
    sync.update_account(first['id'], {'enabled':False})
    with pytest.raises(ValueError):
        sync.run_account(first['id'], {})
    assert len(sync.run_all({})['jobs'])==1
