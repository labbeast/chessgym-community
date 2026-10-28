"""Isolated worker: only trusted code and validated local paths are invoked."""
import argparse
from contextlib import contextmanager
import os
from pathlib import Path

import reference_store
import reference_phase


def default_import_workers():
    """Leave capacity for the board/engine and cap parallel parser memory."""
    configured = os.environ.get('CHESSGYM_IMPORT_WORKERS', '').strip().lower()
    if configured not in ('', 'auto'):
        if not configured.isascii() or not configured.isdecimal() or not 1 <= int(configured) <= 16:
            raise ValueError('CHESSGYM_IMPORT_WORKERS doit être auto ou un entier de 1 à 16.')
        return int(configured)
    cpus = os.cpu_count() or 1
    if hasattr(os, 'sched_getaffinity'):
        try:
            cpus = min(cpus, len(os.sched_getaffinity(0)))
        except OSError:
            pass
    return max(1, min(4, cpus - 2))


def default_import_cache_mib():
    """The standalone worker keeps its conservative budget unless configured."""
    configured = os.environ.get('CHESSGYM_IMPORT_CACHE_MB', '').strip()
    if not configured:
        return reference_store.IMPORT_CACHE_KIB // 1024
    if not configured.isascii() or not configured.isdecimal() or not 64 <= int(configured) <= 4096:
        raise ValueError('CHESSGYM_IMPORT_CACHE_MB doit être un entier de 64 à 4096.')
    return int(configured)


def default_sort_positions():
    configured = os.environ.get('CHESSGYM_IMPORT_SORT_POSITIONS', '').strip()
    if configured not in ('', '0', '1'):
        raise ValueError('CHESSGYM_IMPORT_SORT_POSITIONS doit être 0 ou 1.')
    return configured == '1'


@contextmanager
def parent_exit_check(pid):
    """A stopped/crashed server must not leave an orphan importer running."""
    if pid is None:
        yield lambda: False
    elif os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.WaitForSingleObject.restype = wintypes.DWORD
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE only.
        try:
            yield lambda: not handle or kernel.WaitForSingleObject(handle, 0) != 258
        finally:
            if handle:
                kernel.CloseHandle(handle)
    else:
        yield lambda: os.getppid() != pid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--store', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--cancel', required=True)
    parser.add_argument('--max-games', type=int)
    parser.add_argument('--encoding', default='utf-8-sig')
    parser.add_argument('--parent-pid', type=int)
    parser.add_argument('--workers', type=int)
    parser.add_argument('--run-id')
    parser.add_argument('--cache-mib', type=int)
    parser.add_argument('--sort-positions', action=argparse.BooleanOptionalAction, default=None)
    args = parser.parse_args()
    marker = Path(args.cancel)
    publisher = reference_phase.Publisher(args.store, args.run_id, args.source) if args.run_id else None
    with parent_exit_check(args.parent_pid) as parent_exited:
        result = reference_store.import_file(Path(args.store), Path(args.source), max_games=args.max_games,
                                            cancelled=lambda: marker.exists() or parent_exited(), encoding=args.encoding,
                                            workers=args.workers if args.workers is not None else default_import_workers(),
                                            cache_mib=args.cache_mib if args.cache_mib is not None else default_import_cache_mib(),
                                            sort_positions=args.sort_positions if args.sort_positions is not None else default_sort_positions(),
                                            phase=publisher.publish if publisher else None)
    if publisher:
        publisher.publish('finished', result)
    if result.get('status') == 'failed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
