"""Persistent derived snapshots cannot change source archives or outlive a version."""
from contextlib import contextmanager
import chess
import pytest
import db
import reference_store as store
import reference_queries as queries
import reference_aggregate_cache as cache
from test_reference_store import pgn, source

@pytest.fixture
def archive(tmp_path,monkeypatch):
    monkeypatch.setattr(db,'DB_PATH',tmp_path/'personal.sqlite3');queries.clear_cache()
    path=tmp_path/'reference.sqlite3'
    store.import_file(path,source(tmp_path,pgn(['e2e4'],white='A',WhiteElo='1800',BlackElo='1800',TimeControl='600'),pgn(['d2d4'],white='B'),name='first.pgn'))
    yield path
    queries.clear_cache()


def test_persists_exact_result_across_memory_clear_and_filter_profiles(archive,monkeypatch):
    calls=[]
    def compute():calls.append(1);return {**store.explorer_data(archive,chess.STARTING_FEN),'complete':True}
    first=queries.bounded([archive],('position','all'),compute,persistent=True)
    queries.clear_cache();second=queries.bounded([archive],('position','all'),compute,persistent=True)
    assert second['cached'] and first['moves']==second['moves'] and len(calls)==1
    queries.clear_cache();queries.bounded([archive],('position','rapid'),compute,persistent=True)
    assert len(calls)==2


def test_append_invalidates_persisted_counts_and_positions(archive,tmp_path):
    profile=('start',);compute=lambda:store.explorer_data(archive,chess.STARTING_FEN)
    assert queries.bounded([archive],profile,compute,persistent=True)['total']==2
    store.import_file(archive,source(tmp_path,pgn(['c2c4'],white='C'),name='second.pgn'))
    queries.clear_cache()
    assert queries.bounded([archive],profile,compute,persistent=True)['total']==3


def test_partial_and_failed_queries_never_enter_persistent_cache(archive):
    calls=[]
    def compute():calls.append(1);return {'status':'ok','complete':False,'total':2}
    queries.bounded([archive],('partial',),compute,persistent=True);queries.clear_cache()
    queries.bounded([archive],('partial',),compute,persistent=True)
    assert len(calls)==2
    def failure():raise ValueError('bad')
    with pytest.raises(ValueError):queries.bounded([archive],('failed',),failure,persistent=True)
    assert cache.read(cache.key([archive],('failed',))) is None


def test_cache_is_bounded_and_disposable(archive,monkeypatch):
    monkeypatch.setattr(cache,'MAX_ENTRIES',2)
    for index in range(5):cache.write(str(index),{'status':'ok','total':index})
    with cache._connect() as conn:assert conn.execute('SELECT count(*) FROM snapshots').fetchone()[0]==2
    assert cache.read('4')['total']==4


def test_list_and_position_count_reused_but_not_after_append(archive,tmp_path,monkeypatch):
    trace=[];real=store._connect
    @contextmanager
    def traced(*args,**kwargs):
        with real(*args,**kwargs) as conn:
            conn.set_trace_callback(trace.append);yield conn
    monkeypatch.setattr(store,'_connect',traced)
    store.list_games(archive,rating_min=1700);store.search_position(archive,chess.STARTING_FEN)
    trace.clear()
    assert store.list_games(archive,rating_min=1700)['total']==1
    assert store.search_position(archive,chess.STARTING_FEN)['total']==2
    assert not any('SELECT count(*)' in sql for sql in trace)
    store.import_file(archive,source(tmp_path,pgn(['c2c4'],white='C',WhiteElo='1900',BlackElo='2000'),name='new.pgn'))
    assert store.list_games(archive,rating_min=1700)['total']==2
    assert store.search_position(archive,chess.STARTING_FEN)['total']==3
