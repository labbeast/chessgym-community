"""Compare source-order and batch-sorted inserts on independent seeded stores.

Only files under output/reference-benchmark may be read or written. Every timed
run starts from a fresh SQLite backup of the same isolated seed. Defaults use a
756 MiB, 100k-game seed, the existing 5000-game Mega sample and a 64 MiB writer
cache. ABBA ordering reduces (but cannot eliminate) filesystem-cache/order bias.
Production imports may continue: record that competing I/O explicitly.
"""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import inspect
import json
import os
from pathlib import Path
import platform
import shutil
import sqlite3
import statistics
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts.benchmark_reference_parallel import WindowsProcessTree, digest_rows, utc, verify

OUTPUT = ROOT / 'output' / 'reference-benchmark'
COUNTERS = ('processed', 'imported', 'duplicates', 'rejected', 'game_count',
            'indexed_positions', 'offset', 'bytes_read', 'total_bytes', 'status')


def bounded(path):
    path = Path(path).resolve()
    if not path.is_relative_to(OUTPUT.resolve()):
        raise ValueError('Only isolated output/reference-benchmark paths are allowed.')
    return path


def write_json(path, value):
    path = bounded(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def read_meta(path):
    with closing(sqlite3.connect(bounded(path).as_uri() + '?mode=ro', uri=True)) as conn:
        return {key: json.loads(value) for key, value in conn.execute('SELECT key,value FROM meta')}


def seed_description(path, cache_mib):
    path = bounded(path)
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as conn:
        meta = {key: json.loads(value) for key, value in conn.execute('SELECT key,value FROM meta')}
        key_bytes = conn.execute('SELECT length(position_key) FROM positions LIMIT 1').fetchone()[0]
        pages = conn.execute('PRAGMA page_count').fetchone()[0]
        page_size = conn.execute('PRAGMA page_size').fetchone()[0]
    stat = path.stat()
    key_lower_bound = key_bytes * meta['totals']['indexed_positions']
    if key_lower_bound <= cache_mib * 1024**2:
        raise ValueError('The seed position keys alone must exceed the configured SQLite cache.')
    return {'path': str(path), 'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns,
            'page_count': pages, 'page_size': page_size, 'metadata': meta,
            'position_key_bytes': key_bytes, 'position_key_bytes_total': key_lower_bound,
            'position_key_bytes_over_cache': key_lower_bound / (cache_mib * 1024**2)}


def clone_seed(seed, destination):
    seed, destination = bounded(seed), bounded(destination)
    if destination.exists():
        raise ValueError('Refusing to overwrite an existing benchmark store.')
    before = (seed.stat().st_size, seed.stat().st_mtime_ns)
    with closing(sqlite3.connect(seed.as_uri() + '?mode=ro', uri=True)) as source:
        with closing(sqlite3.connect(destination)) as target:
            source.backup(target, pages=2048)
    if before != (seed.stat().st_size, seed.stat().st_mtime_ns):
        raise RuntimeError('The isolated seed changed while it was copied.')


def assert_equal_runs(left, right):
    for key in ('games', 'positions'):
        if left['verification'][key] != right['verification'][key]:
            raise AssertionError('Complete content differs: ' + key)
    for key in COUNTERS:
        if left['metadata']['import'].get(key) != right['metadata']['import'].get(key):
            raise AssertionError('Import counter differs: ' + key)
    if left['metadata']['totals'] != right['metadata']['totals']:
        raise AssertionError('Corpus totals differ')


def child(args):
    import reference_store

    code_before = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                   for name in ('reference_store.py', 'reference_parallel.py')}
    store, sample = bounded(args.store), bounded(args.sample)
    if 'sort_positions' not in inspect.signature(reference_store.import_file).parameters:
        raise ValueError('The importer does not yet expose sort_positions.')
    counters = {'explicit_commit_seconds': 0.0, 'explicit_commits': 0,
                'connection_cleanup_seconds': 0.0, 'write_connections': 0,
                'insert_and_buffer_seconds': 0.0, 'insert_calls': 0,
                'sorted_flush_seconds': 0.0, 'sorted_flush_within_insert_seconds': 0.0,
                'sorted_flush_calls': 0}
    original_connect = reference_store._connect
    original_insert = reference_store._insert_prepared
    original_flush = reference_store._SortedPositionBuffer.flush
    insert_depth = 0

    def inserted(*values, **keywords):
        nonlocal insert_depth
        began = time.perf_counter()
        insert_depth += 1
        try:
            return original_insert(*values, **keywords)
        finally:
            insert_depth -= 1
            counters['insert_and_buffer_seconds'] += time.perf_counter() - began
            counters['insert_calls'] += 1

    def flushed(*values, **keywords):
        began = time.perf_counter()
        try:
            return original_flush(*values, **keywords)
        finally:
            elapsed = time.perf_counter() - began
            counters['sorted_flush_seconds'] += elapsed
            counters['sorted_flush_calls'] += 1
            if insert_depth:
                counters['sorted_flush_within_insert_seconds'] += elapsed

    class Proxy:
        def __init__(self, conn):
            self.conn = conn

        def __getattr__(self, name):
            return getattr(self.conn, name)

        def commit(self):
            began = time.perf_counter()
            try:
                return self.conn.commit()
            finally:
                counters['explicit_commit_seconds'] += time.perf_counter() - began
                counters['explicit_commits'] += 1

    @contextmanager
    def connected(*values, **keywords):
        cleanup_started = None
        try:
            with original_connect(*values, **keywords) as conn:
                if not keywords.get('readonly'):
                    counters['write_connections'] += 1
                try:
                    yield Proxy(conn)
                finally:
                    cleanup_started = time.perf_counter()
        finally:
            if cleanup_started is not None:
                counters['connection_cleanup_seconds'] += time.perf_counter() - cleanup_started

    reference_store._connect = connected
    reference_store._insert_prepared = inserted
    reference_store._SortedPositionBuffer.flush = flushed
    began = time.perf_counter()
    progress_path = bounded(args.progress)
    def progress(state):
        write_json(progress_path, {'updated_at': utc(), 'elapsed_seconds': time.perf_counter() - began,
                                  'state': state, 'instrumentation': counters})
    state = reference_store.import_file(store, sample, encoding=args.encoding,
                                        workers=args.workers, batch_size=args.batch_size,
                                        cache_mib=args.cache_mib, sort_positions=args.sorted,
                                        progress=progress)
    import_seconds = time.perf_counter() - began
    # import_file's final close can checkpoint WAL; that time is already included
    # above and in connection_cleanup_seconds. Explicitly drain any remainder.
    checkpoint_started = time.perf_counter()
    with closing(sqlite3.connect(store, timeout=30)) as conn:
        journal_mode = conn.execute('PRAGMA journal_mode').fetchone()[0]
        checkpoint = tuple(conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone())
    checkpoint_seconds = time.perf_counter() - checkpoint_started
    if checkpoint[0] != 0:
        raise RuntimeError('Terminal checkpoint remained busy')
    counters['writer_insert_and_flush_seconds'] = (counters['insert_and_buffer_seconds']
        + counters['sorted_flush_seconds'] - counters['sorted_flush_within_insert_seconds'])
    code_after = {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                  for name in code_before}
    if code_after != code_before:
        raise AssertionError('Importer code changed during a timed run.')
    result = {'sorted': args.sorted, 'workers': args.workers, 'cache_mib': args.cache_mib,
              'batch_size': args.batch_size, 'status': state, 'metadata': read_meta(store),
              'import_seconds': import_seconds, 'terminal_checkpoint_seconds': checkpoint_seconds,
              'import_and_checkpoint_seconds': import_seconds + checkpoint_seconds,
              'instrumentation': counters, 'terminal_checkpoint': checkpoint,
              'journal_mode': journal_mode, 'sqlite_bytes': store.stat().st_size,
              'code_sha256_before': code_before, 'code_sha256': code_after}
    write_json(args.result, result)
    if state['status'] != 'completed':
        raise RuntimeError('Sample import did not complete: ' + str(state))


def summary(report):
    groups = {mode: [item['import_and_checkpoint_seconds'] for item in report['runs']
                     if item['sorted'] is mode] for mode in (False, True)}
    if not all(groups.values()):
        return None
    old, new = (statistics.median(groups[mode]) for mode in (False, True))
    return {'source_order_median_seconds': old, 'sorted_median_seconds': new,
            'source_order_runs_seconds': groups[False], 'sorted_runs_seconds': groups[True],
            'median_speedup': old / new, 'median_time_reduction_percent': 100 * (1 - new / old)}


def run(args):
    seed, sample_dir = bounded(args.seed), bounded(args.sample_dir)
    sample = sample_dir / 'sample.pgn'
    sample_info = json.loads((sample_dir / 'sample.json').read_text(encoding='utf-8'))
    if hashlib.sha256(sample.read_bytes()).hexdigest() != sample_info['sample_sha256']:
        raise ValueError('Sample checksum differs from its extraction manifest.')
    seed_info = seed_description(seed, args.cache_mib)
    run_dir = bounded(OUTPUT / args.name)
    run_dir.mkdir(exist_ok=False)
    if shutil.disk_usage(run_dir).free < seed.stat().st_size * 6:
        raise ValueError('Insufficient free space for four independent seed copies and WAL files.')
    report = {'started_at': utc(), 'python': sys.version, 'platform': platform.platform(),
              'note': args.note, 'seed': seed_info, 'sample': sample_info,
              'configuration': {'workers': args.workers, 'cache_mib': args.cache_mib,
                                'batch_size': args.batch_size, 'order': 'ABBA',
                                'A': 'source order', 'B': 'sorted positions'},
              'limitations': ['Production import competes for CPU, disk and filesystem cache.',
                             'OS file caches are not flushed; ABBA only reduces order bias.',
                             'Seed is larger than SQLite cache but much smaller than the current Mega index.',
                             'Seed games are Lichess; appended sample games are Mega.',
                             'Backup and full correctness verification are outside timed imports.',
                             'RSS sampled every 100 ms may miss peaks and double-count shared pages.',
                             'Import time includes connection cleanup and its automatic WAL checkpoint.'],
              'runs': []}
    report_path = run_dir / 'report.json'
    write_json(report_path, report)
    print(str(report_path), flush=True)
    for index, sorted_positions in enumerate((False, True, True, False), 1):
        label = f'{index}-' + ('sorted' if sorted_positions else 'source')
        store = run_dir / (label + '.sqlite3')
        result_path = run_dir / (label + '.json')
        progress_path = run_dir / (label + '-progress.json')
        report['current'] = {'run': label, 'phase': 'copying isolated seed', 'started_at': utc()}
        write_json(report_path, report)
        copied = time.perf_counter()
        clone_seed(seed, store)
        copy_seconds = time.perf_counter() - copied
        command = [sys.executable, '-X', 'utf8', str(Path(__file__).resolve()), '_child',
                   '--sample', str(sample), '--store', str(store), '--result', str(result_path),
                   '--progress', str(progress_path), '--workers', str(args.workers),
                   '--cache-mib', str(args.cache_mib), '--batch-size', str(args.batch_size),
                   '--encoding', sample_info['encoding']]
        if sorted_positions:
            command.append('--sorted')
        memory = WindowsProcessTree() if os.name == 'nt' else None
        peak_rss = peak_processes = samples = 0
        began = time.perf_counter()
        last_report = began
        with (run_dir / (label + '.log')).open('wb') as log:
            process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, cwd=ROOT,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            report['current'] = {'run': label, 'phase': 'import', 'pid': process.pid, 'started_at': utc()}
            write_json(report_path, report)
            while process.poll() is None:
                if memory:
                    measurement = memory.sample(process.pid)
                    if measurement:
                        peak_rss = max(peak_rss, measurement['rss_bytes'])
                        peak_processes = max(peak_processes, measurement['process_count'])
                        samples += 1
                if time.perf_counter() - last_report >= 10:
                    report['current']['elapsed_seconds'] = time.perf_counter() - began
                    report['current']['sampled_peak_rss_bytes'] = peak_rss
                    write_json(report_path, report)
                    last_report = time.perf_counter()
                time.sleep(.1)
        elapsed = time.perf_counter() - began
        if process.returncode:
            report['current']['phase'] = 'failed'
            write_json(report_path, report)
            raise RuntimeError('Timed import failed; inspect ' + str(run_dir / (label + '.log')))
        metrics = json.loads(result_path.read_text(encoding='utf-8'))
        metrics.update(run=label, seed_copy_seconds=copy_seconds, store=str(store),
                       wall_seconds_including_startup=elapsed, tree_peak_sampled_rss_bytes=peak_rss,
                       tree_peak_process_count=peak_processes, memory_samples=samples,
                       sampled_tree_cpu_seconds=sum(memory.cpu.values()) if memory else None)
        report['current'] = {'run': label, 'phase': 'full verification', 'started_at': utc()}
        write_json(report_path, report)
        check_started = time.perf_counter()
        metrics['verification'] = verify(store)
        metrics['verification_seconds'] = time.perf_counter() - check_started
        if report['runs']:
            assert_equal_runs(report['runs'][0], metrics)
            if metrics['code_sha256'] != report['runs'][0]['code_sha256']:
                raise AssertionError('Importer code changed between runs; timings cannot be compared.')
        report['runs'].append(metrics)
        report['summary'] = summary(report)
        write_json(report_path, report)
        print(json.dumps({'run': label, 'seconds': metrics['import_and_checkpoint_seconds'],
                          'rss_mib': peak_rss / 1024**2, 'verified': True}), flush=True)
    if read_meta(seed) != seed_info['metadata'] or seed.stat().st_mtime_ns != seed_info['mtime_ns']:
        raise AssertionError('The isolated seed changed during the benchmark.')
    report.update(completed_at=utc(), current={'phase': 'completed'}, seed_unchanged=True)
    write_json(report_path, report)
    print(json.dumps(report['summary']), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest='action', required=True)
    bench = subs.add_parser('run')
    bench.add_argument('--seed', default=str(OUTPUT / 'lichess-2013-100k.sqlite3'))
    bench.add_argument('--sample-dir', default=str(OUTPUT / 'mega-parallel-5000'))
    bench.add_argument('--name', default='position-order-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    bench.add_argument('--note', default='Production import running concurrently; measurements are noisy.')
    internal = subs.add_parser('_child')
    for name in ('sample', 'store', 'result', 'progress', 'encoding'):
        internal.add_argument('--' + name, required=True)
    internal.add_argument('--sorted', action='store_true')
    for sub in (bench, internal):
        sub.add_argument('--workers', type=int, default=4)
        sub.add_argument('--cache-mib', type=int, default=64)
        sub.add_argument('--batch-size', type=int, default=250)
    args = parser.parse_args()
    if not 1 <= args.workers <= 16 or not 64 <= args.cache_mib <= 4096 or not 1 <= args.batch_size <= 5000:
        parser.error('Invalid worker count, cache budget or batch size.')
    if args.action == 'run':
        run(args)
    else:
        child(args)


if __name__ == '__main__':
    main()
