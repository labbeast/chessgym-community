"""Isolated multiprocess importer benchmark; never writes to application data.

Prepare a bounded sample at a chosen reference import's committed checkpoint (read only).
Replace the example reference ID with your own base ID:
    python scripts/benchmark_reference_parallel.py prepare --reference-id 1 --games 5000 --name reference-sample
Run equal imports into new stores, with process-tree memory sampling on Windows:
    python scripts/benchmark_reference_parallel.py run --name reference-sample --workers 1 2 4 6 --note "Live import running; noisy measurements"

The sample, independent SQLite stores, logs and reports remain under
output/reference-benchmark. Timings include process/pool startup. Verification
is outside the timed import. A fresh 5000-game index does not model writes into
a million-game production index or justify projecting its speedup.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import inspect
import io
import json
import os
from pathlib import Path
import platform
import random
import sqlite3
import struct
import subprocess
import sys
import time
from datetime import datetime, timezone
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output' / 'reference-benchmark'
sys.path.insert(0, str(ROOT))


def utc():
    return datetime.now(timezone.utc).isoformat()


def bounded(path):
    path = Path(path).resolve()
    if not path.is_relative_to(OUTPUT.resolve()):
        raise ValueError('All benchmark outputs must stay inside output/reference-benchmark.')
    return path


def write_json(path, value):
    bounded(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def read_meta(path):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as conn:
        return {key: json.loads(value) for key, value in conn.execute('SELECT key,value FROM meta')}


def prepare(args):
    import reference_store

    folder = bounded(OUTPUT / args.name)
    folder.mkdir(parents=True, exist_ok=True)
    sample = folder / 'sample.pgn'
    if sample.exists():
        raise ValueError('Sample already exists; use another name or reuse it with run.')
    catalog = ROOT / 'data' / 'chessgym.sqlite3'
    with sqlite3.connect(catalog.as_uri() + '?mode=ro', uri=True) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute('SELECT * FROM reference_bases WHERE base_id=?', (args.reference_id,)).fetchone()
        if row is None:
            raise ValueError('Reference base not found.')
        row = dict(row)
    key = row['storage_key']
    if len(key) != 32 or any(char not in '0123456789abcdef' for char in key):
        raise ValueError('Invalid storage key.')
    live_store = ROOT / 'data' / 'references' / (key + '.sqlite3')
    meta = read_meta(live_store)
    state = meta['import']
    source = Path(row['source']).resolve(strict=True)
    before = source.stat()
    start = state['offset']
    count, framing_errors, end = 0, 0, start
    digest = hashlib.sha256()
    started = time.perf_counter()
    with reference_store._source_stream(source, start, lambda: False) as (stream, _):
        with sample.open('xb') as target:
            for raw, offset, error in reference_store._record_stream(stream, start):
                if not raw.strip() and not error:
                    continue
                if error:
                    # A truncated malformed record cannot be reproduced faithfully.
                    raise ValueError('Cannot extract an oversized framed record: ' + error)
                target.write(raw)
                digest.update(raw)
                end = offset
                count += 1
                framing_errors += bool(error)
                if count >= args.games:
                    break
    after = source.stat()
    assert (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
    description = {
        'created_at': utc(), 'reference_id': args.reference_id, 'source': str(source),
        'source_bytes': before.st_size, 'source_mtime_ns': before.st_mtime_ns,
        'encoding': row.get('encoding', 'utf-8-sig'), 'start_offset': start,
        'end_offset': end, 'source_processed_at_checkpoint': state['processed'],
        'production_totals_at_checkpoint': meta['totals'], 'production_status': state['status'],
        'records': count, 'framing_errors': framing_errors, 'sample_bytes': sample.stat().st_size,
        'sample_sha256': digest.hexdigest(), 'extraction_seconds': time.perf_counter() - started,
        'source_unchanged': True,
    }
    write_json(folder / 'sample.json', description)
    print(json.dumps(description, ensure_ascii=False), flush=True)


class WindowsProcessTree:
    """Sample current RSS summed across the importer and all its descendants.

    Peak is max of simultaneous sums at 100 ms intervals, not a sum of lifetime
    peaks. It may miss a short allocation spike or a short-lived process.
    Windows shared pages can be counted once in each process's working set.
    """

    def __init__(self):
        from ctypes import wintypes as w

        class ProcessEntry(ctypes.Structure):
            _fields_ = [('dwSize', w.DWORD), ('cntUsage', w.DWORD), ('th32ProcessID', w.DWORD),
                        ('th32DefaultHeapID', ctypes.c_size_t), ('th32ModuleID', w.DWORD),
                        ('cntThreads', w.DWORD), ('th32ParentProcessID', w.DWORD),
                        ('pcPriClassBase', w.LONG), ('dwFlags', w.DWORD), ('szExeFile', w.WCHAR * 260)]

        class Counters(ctypes.Structure):
            _fields_ = [('cb', w.DWORD), ('PageFaultCount', w.DWORD),
                        ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                        ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                        ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                        ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t)]

        self.w, self.Entry, self.Counters = w, ProcessEntry, Counters
        self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        self.psapi = ctypes.WinDLL('psapi', use_last_error=True)
        self.kernel.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
        self.kernel.CreateToolhelp32Snapshot.restype = w.HANDLE
        for name in ('Process32FirstW', 'Process32NextW'):
            getattr(self.kernel, name).argtypes = [w.HANDLE, ctypes.POINTER(ProcessEntry)]
        self.kernel.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
        self.kernel.OpenProcess.restype = w.HANDLE
        self.kernel.CloseHandle.argtypes = [w.HANDLE]
        self.psapi.GetProcessMemoryInfo.argtypes = [w.HANDLE, ctypes.POINTER(Counters), w.DWORD]
        self.kernel.GetProcessTimes.argtypes = [w.HANDLE, *([ctypes.POINTER(w.FILETIME)] * 4)]
        self.cpu = {}
        self.seen = set()

    def sample(self, root_pid):
        handle = self.kernel.CreateToolhelp32Snapshot(2, 0)
        if handle in (None, ctypes.c_void_p(-1).value):
            return None
        parents = {}
        entry = self.Entry()
        entry.dwSize = ctypes.sizeof(entry)
        try:
            ok = self.kernel.Process32FirstW(handle, ctypes.byref(entry))
            while ok:
                parents[entry.th32ProcessID] = entry.th32ParentProcessID
                ok = self.kernel.Process32NextW(handle, ctypes.byref(entry))
        finally:
            self.kernel.CloseHandle(handle)
        selected = {root_pid}
        while True:
            children = {pid for pid, parent in parents.items() if parent in selected}
            if children <= selected:
                break
            selected.update(children)
        rss = count = 0
        for pid in selected:
            process = self.kernel.OpenProcess(0x1010, False, pid)
            if not process:
                continue
            try:
                counters = self.Counters()
                counters.cb = ctypes.sizeof(counters)
                if self.psapi.GetProcessMemoryInfo(process, ctypes.byref(counters), counters.cb):
                    rss += counters.WorkingSetSize
                    count += 1
                    self.seen.add(pid)
                stamps = [self.w.FILETIME() for _ in range(4)]
                if self.kernel.GetProcessTimes(process, *(ctypes.byref(stamp) for stamp in stamps)):
                    self.cpu[pid] = sum((stamp.dwHighDateTime << 32) | stamp.dwLowDateTime for stamp in stamps[2:]) / 10_000_000
            finally:
                self.kernel.CloseHandle(process)
        return {'rss_bytes': rss, 'process_count': count}


def child(args):
    import reference_store

    sample = bounded(Path(args.sample))
    store = bounded(Path(args.store))
    if store.exists():
        raise ValueError('Timed imports require a fresh independent store.')
    counters = {'parse_seconds': 0.0, 'parse_calls': 0, 'write_and_compress_seconds': 0.0, 'write_calls': 0,
                'explicit_commit_seconds': 0.0, 'connection_cleanup_seconds': 0.0}
    original_parse = reference_store._parse_record
    insert_name = '_insert_prepared' if args.worker_count > 1 and hasattr(reference_store, '_insert_prepared') else '_insert_game'
    original_insert = getattr(reference_store, insert_name)
    original_connect = reference_store._connect

    class ConnectionProxy:
        def __init__(self, connection):
            self.connection = connection

        def __getattr__(self, name):
            return getattr(self.connection, name)

        def commit(self):
            began = time.perf_counter()
            try:
                return self.connection.commit()
            finally:
                counters['explicit_commit_seconds'] += time.perf_counter() - began

    @contextmanager
    def connected(*values, **keywords):
        with original_connect(*values, **keywords) as connection:
            try:
                yield ConnectionProxy(connection)
            finally:
                began = time.perf_counter()
        counters['connection_cleanup_seconds'] += time.perf_counter() - began

    def parsed(*values, **keywords):
        began = time.perf_counter()
        try:
            return original_parse(*values, **keywords)
        finally:
            counters['parse_seconds'] += time.perf_counter() - began
            counters['parse_calls'] += 1

    def inserted(*values, **keywords):
        began = time.perf_counter()
        try:
            return original_insert(*values, **keywords)
        finally:
            counters['write_and_compress_seconds'] += time.perf_counter() - began
            counters['write_calls'] += 1

    # Spawned parser children import the normal module. Only the sequential path
    # can report total parse time; write timing always measures the single writer.
    if args.worker_count == 1:
        reference_store._parse_record = parsed
    setattr(reference_store, insert_name, inserted)
    reference_store._connect = connected
    kwargs = {'encoding': args.encoding}
    if 'workers' in inspect.signature(reference_store.import_file).parameters:
        kwargs['workers'] = args.worker_count
    elif args.worker_count != 1:
        raise ValueError('Parallel importer is not available yet.')
    started = time.perf_counter()
    state = reference_store.import_file(store, sample, **kwargs)
    elapsed = time.perf_counter() - started
    if args.worker_count != 1:
        counters['parse_seconds'] = None
        counters['parse_calls'] = None
    metrics = {'workers': args.worker_count, 'import_seconds': elapsed, 'status': state,
               'instrumentation': counters, 'instrumented_writer_function': insert_name,
               'sqlite_bytes': store.stat().st_size,
               'writer_cache_kib': getattr(reference_store, 'IMPORT_CACHE_KIB', 16384),
               'code_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                               for name in ('reference_store.py', 'reference_parallel.py') if (ROOT / name).exists()}}
    write_json(Path(args.child_result), metrics)
    if state['status'] != 'completed':
        raise ValueError('Import did not complete: ' + str(state))


def digest_rows(conn, sql):
    digest, count = hashlib.sha256(), 0
    for row in conn.execute(sql):
        for value in row:
            data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode('utf-8')
            digest.update(b'B' if isinstance(value, bytes) else b'J')
            digest.update(struct.pack('>Q', len(data)))
            digest.update(data)
        count += 1
    return {'rows': count, 'sha256': digest.hexdigest()}


def verify(store):
    import chess.pgn
    import reference_store

    with sqlite3.connect(store.as_uri() + '?mode=ro', uri=True) as conn:
        quick_check = conn.execute('PRAGMA quick_check').fetchone()[0]
        assert quick_check == 'ok'
        games = digest_rows(conn, 'SELECT * FROM games ORDER BY id')
        positions = digest_rows(conn, 'SELECT * FROM positions ORDER BY position_key,game_id')
        ids = [row[0] for row in conn.execute('SELECT id FROM games ORDER BY id')]
    legal_plies = 0
    for game_id in random.Random(20261021).sample(ids, min(20, len(ids))):
        raw = reference_store.read_game(store, game_id)['pgn']
        game = chess.pgn.read_game(io.StringIO(raw))
        assert game is not None and not game.errors
        pending = [game]
        while pending:
            node = pending.pop()
            board = node.board()
            for variation in node.variations:
                assert variation.move in board.legal_moves
                legal_plies += 1
                pending.append(variation)
    return {'quick_check': quick_check, 'games': games, 'positions': positions,
            'legally_replayed_games': min(20, len(ids)), 'legally_replayed_plies_all_variations': legal_plies}


def run(args):
    folder = bounded(OUTPUT / args.name)
    sample = folder / 'sample.pgn'
    description = json.loads((folder / 'sample.json').read_text(encoding='utf-8'))
    assert hashlib.sha256(sample.read_bytes()).hexdigest() == description['sample_sha256']
    run_dir = folder / ('run-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ'))
    run_dir.mkdir()
    report = {'started_at': utc(), 'python': sys.version, 'platform': platform.platform(),
              'logical_cpu_count': os.cpu_count(), 'sample': description, 'note': args.note, 'runs': [],
              'limitations': ['Fresh small indexes do not model growing million-game index writes.',
                             'Sequential run order; OS file cache is not flushed; startup is included.',
                             'Tree RSS sampled every 100 ms; short peaks may be missed; shared pages may be counted multiple times.',
                             'Sequential writer stage includes compression and SQL; parallel _insert_prepared excludes worker-side compression.',
                             'Explicit commits are measured separately; they can include SQLite WAL checkpoints.']}
    for workers in args.workers:
        store = run_dir / f'workers-{workers}.sqlite3'
        result_path = run_dir / f'workers-{workers}.json'
        command = [sys.executable, '-X', 'utf8', str(Path(__file__).resolve()), '_child',
                   '--sample', str(sample), '--store', str(store), '--worker-count', str(workers),
                   '--encoding', description['encoding'], '--child-result', str(result_path)]
        memory = WindowsProcessTree() if os.name == 'nt' else None
        peak_rss = peak_processes = samples = 0
        began = time.perf_counter()
        with (run_dir / f'workers-{workers}.log').open('wb') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            while process.poll() is None:
                if memory:
                    measurement = memory.sample(process.pid)
                    if measurement:
                        peak_rss = max(peak_rss, measurement['rss_bytes'])
                        peak_processes = max(peak_processes, measurement['process_count'])
                        samples += 1
                time.sleep(.1)
            elapsed = time.perf_counter() - began
        if process.returncode:
            raise RuntimeError(f'workers={workers} failed; inspect {run_dir / f"workers-{workers}.log"}')
        metrics = json.loads(result_path.read_text(encoding='utf-8'))
        metrics.update(wall_seconds_including_startup=elapsed, tree_peak_sampled_rss_bytes=peak_rss,
                       tree_peak_process_count=peak_processes, memory_samples=samples,
                       sampled_tree_cpu_seconds=sum(memory.cpu.values()) if memory else None,
                       verification=verify(store), store=str(store))
        if report['runs']:
            baseline = report['runs'][0]
            for key in ('games', 'positions'):
                assert metrics['verification'][key] == baseline['verification'][key], f'Content differs: {key}'
            for key in ('processed', 'imported', 'duplicates', 'rejected', 'game_count', 'indexed_positions'):
                assert metrics['status'][key] == baseline['status'][key], f'Counter differs: {key}'
            metrics['speedup_vs_first_run'] = baseline['wall_seconds_including_startup'] / elapsed
        else:
            metrics['speedup_vs_first_run'] = 1.0
        report['runs'].append(metrics)
        write_json(run_dir / 'report.json', report)
        print(json.dumps({key: metrics[key] for key in ('workers', 'wall_seconds_including_startup', 'tree_peak_sampled_rss_bytes', 'speedup_vs_first_run', 'instrumentation')}, ensure_ascii=False), flush=True)
    report['completed_at'] = utc()
    write_json(run_dir / 'report.json', report)
    lines = ['# Import parallèle — échantillon indépendant', '', args.note, '',
             f"Échantillon : {description['records']:,} parties, offset {description['start_offset']:,}; source intacte.", '',
             '| Processus demandés | Temps avec démarrage | Gain vs premier | RAM arbre max échantillonnée |',
             '| ---: | ---: | ---: | ---: |']
    for item in report['runs']:
        lines.append(f"| {item['workers']} | {item['wall_seconds_including_startup']:.2f} s | {item['speedup_vs_first_run']:.2f}× | {item['tree_peak_sampled_rss_bytes']/1024**2:.1f} MiB |")
    lines += ['', 'Identité complète des lignes games (PGN compressés, en-têtes et identités inclus) et positions vérifiée entre tous les modes; compteurs et contrôles SQLite identiques.',
              '20 parties sont aussi rejouées légalement, variantes comprises, dans chaque base.', '',
              'Ces petites bases neuves ne représentent pas le coût d’écriture dans une base dépassant un million de parties. Aucune extrapolation de durée totale.',
              'RAM : somme simultanée des working sets Windows, toutes les 100 ms; peut compter des pages partagées plusieurs fois et manquer un pic bref. Les autres processus de l’application sont exclus.']
    (run_dir / 'report.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    print(str(run_dir / 'report.json'), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    prep = subs.add_parser('prepare')
    prep.add_argument('--reference-id', type=int, required=True)
    prep.add_argument('--games', type=int, default=5000)
    prep.add_argument('--name', required=True)
    bench = subs.add_parser('run')
    bench.add_argument('--name', required=True)
    bench.add_argument('--workers', nargs='+', type=int, default=[1, 2, 4, 6])
    bench.add_argument('--note', default='Concurrent production import may affect timings.')
    internal = subs.add_parser('_child')
    for flag in ('sample', 'store', 'encoding', 'child-result'):
        internal.add_argument('--' + flag, required=True)
    internal.add_argument('--worker-count', type=int, required=True)
    args = parser.parse_args()
    if args.action == 'prepare':
        if not 1 <= args.games <= 10000:
            parser.error('Samples must contain between 1 and 10000 records.')
        prepare(args)
    elif args.action == 'run':
        if any(value not in (1, 2, 4, 6) for value in args.workers) or len(set(args.workers)) != len(args.workers):
            parser.error('Choose distinct process counts from 1,2,4,6.')
        run(args)
    else:
        child(args)


if __name__ == '__main__':
    main()
