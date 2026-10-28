"""An abruptly killed import coordinator must not leave Windows parsers alive."""
import ctypes
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest


@pytest.mark.skipif(os.name != 'nt', reason='Windows process-handle lifecycle regression')
def test_initialized_parsers_exit_when_coordinator_is_forcibly_killed(tmp_path):
    from ctypes import wintypes

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.WaitForSingleObject.restype = wintypes.DWORD
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
    kernel.TerminateProcess.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    root = Path(__file__).resolve().parents[1]
    script = tmp_path / 'isolated_coordinator.py'
    ready = tmp_path / 'ready'
    ready.mkdir()
    script.write_text('''import io
import os
from pathlib import Path
import sys
import time

sys.path.insert(0, ROOT)
import reference_parallel
real_guard_parent = reference_parallel.guard_parent

def initialize():
    real_guard_parent()
    Path(sys.argv[1], str(os.getpid()) + '.ready').write_text('ready')

def records():
    raw = b'[Event "Lifecycle"]\\n[Result "*"]\\n\\n1. e4 e5 *\\n'
    for number in range(4096):
        yield raw, (number + 1) * len(raw), None

if __name__ == '__main__':
    reference_parallel.guard_parent = initialize
    for _ in reference_parallel.ordered_records(records(), io.BytesIO(),
            encoding='utf-8-sig', workers=2):
        time.sleep(0.05)
'''.replace('ROOT', repr(str(root))), encoding='utf-8')

    children = []
    with (tmp_path / 'coordinator.log').open('wb') as log:
        environment = dict(os.environ, __PYVENV_LAUNCHER__=sys.executable)
        coordinator = subprocess.Popen(
            [getattr(sys, '_base_executable', sys.executable), '-X', 'utf8', str(script), str(ready)],
            cwd=tmp_path, stdout=log, stderr=log, env=environment,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        try:
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and len(list(ready.glob('*.ready'))) < 2:
                assert coordinator.poll() is None, (tmp_path / 'coordinator.log').read_text(errors='replace')
                time.sleep(0.05)
            pids = [int(path.stem) for path in ready.glob('*.ready')]
            assert len(pids) == 2, 'Both real parsing children must initialize before the crash.'
            for pid in pids:
                # Keep an exact process handle: PID reuse cannot satisfy the assertion.
                handle = kernel.OpenProcess(0x00100000 | 0x0001, False, pid)
                assert handle, f'Cannot open test child {pid}: {ctypes.get_last_error()}'
                children.append(handle)
                assert kernel.WaitForSingleObject(handle, 0) == 258

            coordinator.kill()
            coordinator.wait(timeout=10)
            for handle in children:
                assert kernel.WaitForSingleObject(handle, 10_000) == 0, 'Parsing child survived its coordinator.'
        finally:
            if coordinator.poll() is None:
                coordinator.kill()
                coordinator.wait(timeout=10)
            for handle in children:
                if kernel.WaitForSingleObject(handle, 0) == 258:
                    kernel.TerminateProcess(handle, 98)
                    kernel.WaitForSingleObject(handle, 5000)
                kernel.CloseHandle(handle)
