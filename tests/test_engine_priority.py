"""Interactive requests win the next engine slot without preempting a search."""
import io
import threading
import time
from types import SimpleNamespace

import chess
import pytest
from fastapi import HTTPException

import engine


def start(callback):
    errors=[]
    def run():
        try:
            callback()
        except BaseException as exc:
            errors.append(exc)
    thread=threading.Thread(target=run,daemon=True)
    thread.start()
    return thread,errors


def wait_for(predicate):
    deadline=time.monotonic()+2
    while time.monotonic()<deadline:
        if predicate():
            return
        time.sleep(.005)
    pytest.fail('Timed out waiting for engine gate state')


def test_interactive_gets_next_slot_ahead_of_background_without_preemption():
    gate=engine._EngineGate()
    assert gate.acquire(background=True)
    background_started=threading.Event()
    foreground_acquired=threading.Event()
    release_foreground=threading.Event()
    order=[]
    def background():
        background_started.set()
        assert gate.acquire(background=True)
        order.append('background')
        gate.release()
    def foreground():
        assert gate.acquire(timeout=1)
        order.append('interactive')
        foreground_acquired.set()
        try:
            assert release_foreground.wait(2)
        finally:
            gate.release()
    bg,bg_errors=start(background)
    assert background_started.wait(1)
    fg,fg_errors=start(foreground)
    wait_for(lambda:gate._waiting_interactive==1)
    assert order==[] and gate.locked()  # Current search is still the owner.
    gate.release()
    try:
        assert foreground_acquired.wait(1)
        assert order==['interactive'] and bg.is_alive()
    finally:
        release_foreground.set()
    bg.join(2);fg.join(2)
    assert not bg_errors and not fg_errors
    assert order==['interactive','background'] and not gate.locked()


def test_cancelling_interactive_waiter_does_not_block_background_forever():
    gate=engine._EngineGate()
    assert gate.acquire(background=True)
    cancel=threading.Event()
    fg,errors=start(lambda:gate.acquire(timeout=15,cancel=cancel))
    wait_for(lambda:gate._waiting_interactive==1)
    cancel.set();fg.join(1)
    assert not fg.is_alive() and len(errors)==1 and isinstance(errors[0],engine.AnalysisCancelled)
    assert gate._waiting_interactive==0 and gate.locked()
    gate.release()
    assert gate.acquire(timeout=.2,background=True)
    gate.release()


def test_cancelling_background_wait_does_not_release_another_owner():
    gate=engine._EngineGate()
    assert gate.acquire()
    cancel=threading.Event()
    bg,errors=start(lambda:gate.acquire(background=True,cancel=cancel))
    cancel.set();bg.join(1)
    assert not bg.is_alive() and len(errors)==1 and isinstance(errors[0],engine.AnalysisCancelled)
    assert gate.locked() and gate._waiting_interactive==0
    gate.release()
    assert gate.acquire(timeout=.2)
    gate.release()


def test_interactive_timeout_cleans_up_priority_registration():
    gate=engine._EngineGate()
    assert gate.acquire(background=True)
    assert gate.acquire(timeout=.02) is False
    assert gate._waiting_interactive==0 and gate.locked()
    gate.release()
    assert gate.acquire(timeout=.2,background=True)
    gate.release()
    with pytest.raises(RuntimeError):
        gate.release()


@pytest.mark.parametrize('background,expected_timeout',[(False,15),(True,-1)])
def test_run_assigns_only_background_requests_an_unbounded_cancellable_wait(monkeypatch,background,expected_timeout):
    class Marker(Exception): pass
    calls=[]
    class Gate:
        def acquire(self,**kwargs):
            calls.append(kwargs)
            raise Marker()
    cancel,closed=threading.Event(),threading.Event()
    monkeypatch.setattr(engine,'_LOCK',Gate())
    monkeypatch.setattr(engine,'_get_worker',lambda:SimpleNamespace(closed=closed))
    monkeypatch.setattr(engine,'binary_path',lambda:'/test/stockfish')
    with pytest.raises(Marker):
        engine._run(chess.Board(),400,multipv=1,background=background,cancel=cancel)
    assert len(calls)==1
    call=calls[0]
    assert call['timeout']==expected_timeout and call['background'] is background
    signal=call['cancel']
    assert not signal.is_set()
    cancel.set()
    assert signal.is_set()  # The caller can cancel a queued request.
    cancel.clear()
    assert not signal.is_set()
    closed.set()
    assert signal.is_set()  # Closing the engine also cancels the wait.



def test_interactive_busy_error_remains_503_without_starting_engine(monkeypatch):
    class Gate:
        def acquire(self,**kwargs): return False
    monkeypatch.setattr(engine,'_LOCK',Gate())
    monkeypatch.setattr(engine,'binary_path',lambda:'/test/stockfish')
    monkeypatch.setattr(engine.subprocess,'Popen',lambda *a,**kw:pytest.fail('Busy engine must not start'))
    with pytest.raises(HTTPException) as exc:
        engine._run(chess.Board(),400,multipv=1)
    assert exc.value.status_code==503


def test_failed_background_process_start_releases_gate(monkeypatch):
    gate=engine._EngineGate()
    monkeypatch.setattr(engine,'_LOCK',gate)
    monkeypatch.setattr(engine,'binary_path',lambda:'/test/stockfish')
    def unavailable(*args,**kwargs): raise OSError('unavailable')
    monkeypatch.setattr(engine.subprocess,'Popen',unavailable)
    with pytest.raises(HTTPException):
        engine._run(chess.Board(),400,multipv=1,background=True)
    assert not gate.locked() and gate._waiting_interactive==0
    assert gate.acquire(timeout=.2)
    gate.release()


@pytest.mark.parametrize('background',[False,True])
def test_active_cancellation_closes_process_and_releases_gate(monkeypatch,background):
    gate=engine._EngineGate()
    search_started,closed=threading.Event(),threading.Event()
    commands=[]
    class Input(io.StringIO):
        def write(self,text):
            commands.append(text.strip())
            if text.startswith('go '): search_started.set()
            return super().write(text)
    class Output:
        def __iter__(self):
            yield 'uciok\n'
            yield 'readyok\n'
            closed.wait(3)
        def close(self): closed.set()
    process=SimpleNamespace(stdin=Input(),stdout=Output(),wait=lambda **kw:closed.set(),kill=closed.set)
    monkeypatch.setattr(engine,'_LOCK',gate)
    monkeypatch.setattr(engine,'binary_path',lambda:'/test/stockfish')
    monkeypatch.setattr(engine.subprocess,'Popen',lambda *a,**kw:process)
    cancel=threading.Event()
    thread,errors=start(lambda:engine._run(chess.Board(),3000,multipv=1,background=background,cancel=cancel))
    try:
        assert search_started.wait(1)
        assert gate.locked()
        cancel.set();thread.join(1)
        assert not thread.is_alive()
        assert len(errors)==1 and isinstance(errors[0],engine.AnalysisCancelled)
        assert closed.is_set() and 'quit' in commands and not gate.locked()
        assert gate.acquire(timeout=.2)
        gate.release()
    finally:
        cancel.set();closed.set();thread.join(2)
