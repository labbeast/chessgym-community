"""The shared UCI lane reuses one process without leaking options, history or searches."""
import io
import queue
import subprocess
import threading
from copy import deepcopy

import chess
from fastapi import HTTPException
import pytest

import engine


class FakeProcess:
    def __init__(self):
        self.commands=[]
        self.searches=[]
        self.options={}
        self.board=chess.Board()
        self.output=queue.Queue()
        self.closed=threading.Event()
        self.search_started=threading.Event()
        self.behavior='normal'
        process=self

        class Input(io.StringIO):
            def write(self,text):
                for command in text.splitlines():
                    process.command(command)
                return len(text)
        class Output:
            def __iter__(self):
                while True:
                    line=process.output.get()
                    if line is None:
                        return
                    yield line+'\n'
            def close(self):
                process.kill()
        self.stdin=Input()
        self.stdout=Output()

    def command(self, command):
        self.commands.append(command)
        if command=='uci':
            self.output.put('id name Testfish')
            for option in ('Threads','Hash','UCI_LimitStrength','Skill Level','MultiPV'):
                self.output.put('option name '+option+' type spin default 1')
            self.output.put('uciok')
        elif command=='isready':
            self.output.put('readyok')
        elif command.startswith('setoption name '):
            name,value=command[15:].split(' value ')
            self.options[name]=value
        elif command.startswith('position fen '):
            position=command[13:].split(' moves ')
            self.board=chess.Board(position[0])
            if len(position)>1:
                for move in position[1].split():
                    self.board.push_uci(move)
        elif command.startswith('go '):
            self.searches.append({'options':deepcopy(self.options),'board':self.board.copy(),'command':command})
            self.search_started.set()
            if self.behavior=='blocked':
                return
            if self.behavior=='crash':
                self.kill()
                return
            if self.behavior=='malformed':
                self.output.put('bestmove')
                return
            legal=list(self.board.legal_moves)
            if ' searchmoves ' in command:
                legal=[chess.Move.from_uci(m) for m in command.split(' searchmoves ')[1].split()]
            for rank,move in enumerate(legal[:int(self.options.get('MultiPV',1))],1):
                self.output.put(f'info depth 12 multipv {rank} score cp {rank*10} pv {move.uci()}')
            self.output.put('bestmove '+legal[0].uci())
        elif command=='quit':
            self.kill()

    def poll(self):
        return 0 if self.closed.is_set() else None

    def kill(self):
        if not self.closed.is_set():
            self.closed.set()
            self.output.put(None)

    def wait(self,timeout):
        if not self.closed.wait(timeout):
            raise subprocess.TimeoutExpired('Testfish',timeout)
        return 0


@pytest.fixture
def workers(monkeypatch):
    engine.shutdown()
    import resource_policy
    monkeypatch.setattr(resource_policy,'_CURRENT',resource_policy.defaults())
    monkeypatch.setattr(resource_policy,'_DESIRED',resource_policy.defaults())
    monkeypatch.setattr(resource_policy,'_IMPORT_ACTIVE',None)
    monkeypatch.setattr(engine,'_WORKER',None)
    monkeypatch.setattr(engine,'_LOCK',engine._EngineGate())
    monkeypatch.setattr(engine,'binary_path',lambda:'/test/stockfish')
    created=[]
    def create(*args,**kwargs):
        worker=FakeProcess()
        created.append(worker)
        return worker
    monkeypatch.setattr(engine.subprocess,'Popen',create)
    yield created
    engine.shutdown()


def test_reuses_process_and_resets_strength_multipv_root_restrictions_and_limits(workers):
    engine._run(chess.Board(),100,skill=4)
    board=chess.Board()
    board.push_uci('e2e4')
    result=engine._run(board,700,multipv=3,depth=18,background=True,root_moves=[chess.Move.from_uci('c7c5')])
    assert result['lines'][0]['uci']=='c7c5'
    engine._run(chess.Board(),250,multipv=1,background=True)
    assert len(workers)==1
    worker=workers[0]
    assert worker.commands.count('uci')==1 and worker.commands.count('ucinewgame')==3
    first,second,third=worker.searches
    assert first['options']['Skill Level']=='4' and first['options']['MultiPV']=='1'
    assert second['options']['Skill Level']=='20' and second['options']['MultiPV']=='3'
    assert second['command']=='go depth 18 movetime 700 searchmoves c7c5'
    assert third['options']['MultiPV']=='1' and third['command']=='go movetime 250'
    assert all(s['options']['Threads']=='1' and s['options']['Hash']=='64' and
               s['options']['UCI_LimitStrength']=='false' for s in worker.searches)
    assert not worker.closed.is_set()


def test_each_request_sends_its_full_root_history_even_with_identical_current_fen(workers):
    original=chess.Board()
    for move in ['g1f3','g8f6','f3g1','f6g8']:
        original.push_uci(move)
    engine._run(original,100,multipv=1,background=True)
    # Same complete FEN, but a deliberately different history.
    engine._run(chess.Board(original.fen()),100,multipv=1,background=True)
    first,second=workers[0].searches
    assert [move.uci() for move in first['board'].move_stack]==['g1f3','g8f6','f3g1','f6g8']
    assert second['board'].move_stack==[]
    assert first['board'].fen()==second['board'].fen()
    positions=[c for c in workers[0].commands if c.startswith('position ')]
    assert ' moves g1f3 g8f6 f3g1 f6g8' in positions[0] and ' moves ' not in positions[1]


@pytest.mark.parametrize('failure',['crash','malformed'])
def test_bad_search_is_disposed_and_next_request_restarts(workers,failure):
    engine._run(chess.Board(),100,multipv=1,background=True)
    workers[0].behavior=failure
    with pytest.raises(HTTPException) as exc:
        engine._run(chess.Board(),100,multipv=1,background=True)
    assert exc.value.status_code==503 and workers[0].closed.is_set() and not engine._LOCK.locked()
    assert engine._run(chess.Board(),100,multipv=1,background=True)['lines']
    assert len(workers)==2


def test_dead_idle_worker_and_changed_engine_path_restart_cleanly(workers,monkeypatch):
    engine._run(chess.Board(),100,multipv=1)
    workers[0].kill()
    engine._run(chess.Board(),100,multipv=1)
    assert len(workers)==2
    monkeypatch.setattr(engine,'binary_path',lambda:'/other/stockfish')
    engine._run(chess.Board(),100,multipv=1)
    assert len(workers)==3 and workers[1].closed.is_set()


def start(callback):
    results,errors=[],[]
    def run():
        try:
            results.append(callback())
        except BaseException as error:
            errors.append(error)
    thread=threading.Thread(target=run,daemon=True)
    thread.start()
    return thread,results,errors


@pytest.mark.parametrize('shutdown',[False,True])
def test_cancel_or_shutdown_active_search_closes_reader_and_next_request_can_restart(workers,shutdown):
    engine._run(chess.Board(),100,multipv=1)
    worker=workers[0]
    worker.behavior='blocked'
    worker.search_started.clear()
    cancel=threading.Event()
    thread,results,errors=start(lambda:engine._run(chess.Board(),3000,multipv=1,cancel=cancel,background=True))
    assert worker.search_started.wait(1)
    reader=engine._WORKER.reader
    if shutdown:
        engine.shutdown()
    else:
        cancel.set()
    thread.join(2)
    assert not thread.is_alive() and not results and len(errors)==1
    assert isinstance(errors[0],engine.AnalysisCancelled)
    assert worker.closed.is_set() and not reader.is_alive() and not engine._LOCK.locked()
    engine._run(chess.Board(),100,multipv=1)
    assert len(workers)==2


def test_shutdown_closes_idle_process_and_streams_and_is_repeatable(workers):
    engine._run(chess.Board(),100,multipv=1)
    reader=engine._WORKER.reader
    engine.shutdown()
    engine.shutdown()
    assert workers[0].closed.is_set() and workers[0].stdin.closed
    assert not reader.is_alive() and not engine._LOCK.locked()



def test_next_search_reconfigures_reused_worker_from_shared_resource_plan(workers,monkeypatch):
    import resource_policy
    monkeypatch.setattr(resource_policy,'_CURRENT',dict(resource_policy.DEFAULT))
    monkeypatch.setattr(resource_policy,'_DESIRED',dict(resource_policy.DEFAULT))
    monkeypatch.setattr(resource_policy,'_IMPORT_ACTIVE',None)
    engine._run(chess.Board(),100,multipv=1)
    resource_policy._DESIRED={'profile':'custom','total_threads':8,'import_workers':2,'hash_mb':1024}
    engine._run(chess.Board(),100,multipv=1)
    assert len(workers)==1
    assert workers[0].searches[0]['options']['Threads']=='1'
    assert workers[0].searches[1]['options']['Threads']=='3'
    assert workers[0].searches[1]['options']['Hash']=='512'
    assert resource_policy.get_settings()['active_searches']==0

def test_report_engine_identity_guard_rejects_before_starting_process(workers, monkeypatch):
    monkeypatch.setattr(engine, 'binary_identity', lambda path: 'current-binary')
    with pytest.raises(HTTPException) as exc:
        engine._run(chess.Board(), 100, multipv=1, expected_identity='old-binary')
    assert exc.value.status_code == 409
    assert workers == []
    assert not engine._LOCK.locked()


def test_depth_only_search_has_no_movetime_or_elapsed_deadline(workers, monkeypatch):
    deadlines = []
    original = engine._Worker.next_line
    def receive(worker, deadline, cancel=None):
        if worker.process.search_started.is_set():
            deadlines.append(deadline)
        return original(worker, deadline, cancel)
    monkeypatch.setattr(engine._Worker, 'next_line', receive)
    engine._run(chess.Board(), None, depth=80, background=True)
    assert workers[0].searches[-1]['command'] == 'go depth 80'
    assert deadlines and all(deadline is None for deadline in deadlines)


def test_resource_acquisition_failure_releases_gate(workers, monkeypatch):
    import resource_policy
    def unavailable(**options):
        raise engine.AnalysisCancelled()
    monkeypatch.setattr(resource_policy, 'acquire', unavailable)
    with pytest.raises(engine.AnalysisCancelled):
        engine._run(chess.Board(), None, depth=80)
    assert not engine._LOCK.locked()
    assert workers == []


def test_shutdown_cancels_wait_for_cpu_budget_before_starting_a_process(workers, monkeypatch):
    import resource_policy
    waiting = threading.Event()
    def busy(cancel=None, **options):
        waiting.set()
        import time
        deadline = time.monotonic() + 2
        while not cancel.is_set() and time.monotonic() < deadline:
            time.sleep(.01)
        assert cancel.is_set(), 'Shutdown did not reach the CPU waiter'
        raise engine.AnalysisCancelled()
    monkeypatch.setattr(resource_policy, 'acquire', busy)
    thread, results, errors = start(lambda: engine._run(chess.Board(), None, depth=80, background=True))
    assert waiting.wait(1)
    engine.shutdown()
    thread.join(1)
    assert not thread.is_alive() and not results and len(errors) == 1
    assert isinstance(errors[0], engine.AnalysisCancelled)
    assert not engine._LOCK.locked() and workers == []
