"""Measure the reference store on an isolated local PGN sample.

The source is read-only. Stores and reports must stay inside
ChessGym/output/reference-benchmark; the application database is never opened.
Example:
    .venv/Scripts/python.exe -X utf8 scripts/benchmark_reference.py \
        --source path/to/archive.pgn.zst --name lichess-2013-100k --games 100000
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import random
import sqlite3
import statistics
import sys
import time
from contextlib import contextmanager
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output' / 'reference-benchmark'
sys.path.insert(0, str(ROOT))

import chess
import chess.pgn


def process_memory():
    """OS-reported process working set, not a Python-allocation estimate."""
    if os.name == 'nt':
        from ctypes import wintypes

        class Counters(ctypes.Structure):
            _fields_ = [
                ('cb', wintypes.DWORD), ('PageFaultCount', wintypes.DWORD),
                ('PeakWorkingSetSize', ctypes.c_size_t), ('WorkingSetSize', ctypes.c_size_t),
                ('QuotaPeakPagedPoolUsage', ctypes.c_size_t), ('QuotaPagedPoolUsage', ctypes.c_size_t),
                ('QuotaPeakNonPagedPoolUsage', ctypes.c_size_t), ('QuotaNonPagedPoolUsage', ctypes.c_size_t),
                ('PagefileUsage', ctypes.c_size_t), ('PeakPagefileUsage', ctypes.c_size_t),
            ]

        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        psapi = ctypes.WinDLL('psapi', use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return {'current_rss_bytes': counters.WorkingSetSize,
                    'process_peak_rss_bytes': counters.PeakWorkingSetSize,
                    'method': 'Windows GetProcessMemoryInfo; process lifetime peak working set'}
    elif sys.platform != 'win32':
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return {'process_peak_rss_bytes': peak if sys.platform == 'darwin' else peak * 1024,
                'method': 'getrusage; process lifetime peak resident set'}
    return {'method': 'unavailable'}


def source_identity(path):
    stat = path.stat()
    with path.open('rb') as stream:
        prefix_sha = hashlib.sha256(stream.read(1024 * 1024)).hexdigest()
    return {'path': str(path), 'bytes': stat.st_size, 'mtime_ns': stat.st_mtime_ns,
            'first_mib_sha256': prefix_sha}


def rows_of(result):
    if isinstance(result, list):
        return result
    for key in ('items', 'games', 'entries', 'results', 'matches'):
        if isinstance(result.get(key), list):
            return result[key]
    raise ValueError(f'No paginated rows in result keys: {list(result)}')


def total_of(result):
    for key in ('total', 'count', 'game_count'):
        if isinstance(result.get(key), int):
            return result[key]
    raise ValueError(f'No total in result keys: {list(result)}')


def timed(call, repeat=5):
    durations = []
    value = None
    for _ in range(repeat + 1):
        started = time.perf_counter()
        value = call()
        durations.append((time.perf_counter() - started) * 1000)
    return {'first_after_import_ms': round(durations[0], 3),
            'repeat_ms': [round(v, 3) for v in durations[1:]],
            'repeat_median_ms': round(statistics.median(durations[1:]), 3)}, value


def describe_result(result):
    summary = {key: result[key] for key in ('total', 'count', 'game_count', 'terminal_count', 'status') if key in result}
    for key in ('items', 'games', 'entries', 'results', 'matches', 'moves'):
        if isinstance(result.get(key), list):
            summary[f'{key}_returned'] = len(result[key])
    return summary


def storage_metrics(store):
    files = [{'name': p.name, 'bytes': p.stat().st_size} for p in store.parent.glob(store.name + '*') if p.is_file()]
    # Introspection is read-only and deliberately does not depend on private tables.
    with sqlite3.connect(store.as_uri() + '?mode=ro', uri=True) as conn:
        tables = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]
        counts = {}
        for table in tables:
            quoted = '"' + table.replace('"', '""') + '"'
            counts[table] = conn.execute(f'SELECT COUNT(*) FROM {quoted}').fetchone()[0]
        integrity = conn.execute('PRAGMA quick_check').fetchone()[0]
        version = conn.execute('SELECT sqlite_version()').fetchone()[0]
    return {'files': files, 'total_bytes': sum(item['bytes'] for item in files),
            'row_counts': counts, 'sqlite_quick_check': integrity, 'sqlite_version': version}


def verify_games(api, store, total, sample_size):
    """Read and legally replay deterministic random PGNs, then probe their positions."""
    offsets = random.Random(20261021).sample(range(total), min(sample_size, total))
    verified, position_checks, positions, profiles = [], [], {}, {'speeds': {}, 'ratings': [], 'dates': []}
    move_checks = 0
    for offset in offsets:
        listing = api.list_games(store, offset=offset, limit=1)
        item = rows_of(listing)[0]
        game_id = item['id']
        record = api.read_game(store, game_id)
        text = record if isinstance(record, str) else record['pgn']
        stream = io.StringIO(text)
        game = chess.pgn.read_game(stream)
        assert game is not None and not game.errors, f'Invalid imported PGN {game_id}'
        assert chess.pgn.read_game(stream) is None, f'Multiple games in record {game_id}'
        board = game.board()
        moves = list(game.mainline_moves())
        mid_fen = board.fen(en_passant='legal')
        for ply, move in enumerate(moves, 1):
            assert move in board.legal_moves, f'Illegal move in game {game_id}, ply {ply}'
            board.push(move)
            if ply == len(moves) // 2:
                mid_fen = board.fen(en_passant='legal')
        final_fen = board.fen(en_passant='legal')
        if len(moves) >= 2:
            expected_move = moves[len(moves) // 2].uci()
            explorer = api.explorer_data(store, mid_fen)
            # A repetition may index the first outgoing move in this game. Only
            # unique middle positions can assert the exact later continuation.
            replay = game.board()
            target = ' '.join(mid_fen.split()[:4])
            occurrences = 0
            for move in moves:
                occurrences += ' '.join(replay.fen(en_passant='legal').split()[:4]) == target
                replay.push(move)
            if occurrences == 1:
                assert any(row['uci'] == expected_move and row['total'] >= 1 for row in explorer['moves']), f'Indexed continuation missing for {game_id}'
                move_checks += 1
        verified.append({'id': game_id, 'offset': offset, 'plies': len(moves),
                         'result': game.headers.get('Result'), 'sha256': hashlib.sha256(text.encode()).hexdigest()})
        date = game.headers.get('Date', '?')
        profiles['dates'].append(date if date[:4].isdigit() else game.headers.get('UTCDate', date))
        for tag in ('WhiteElo', 'BlackElo'):
            if game.headers.get(tag, '').isdigit():
                profiles['ratings'].append(int(game.headers[tag]))
        speed = item.get('speed', game.headers.get('TimeControl', '?'))
        profiles['speeds'][speed] = profiles['speeds'].get(speed, 0) + 1
        if len(moves) >= 24 and not positions:
            positions = {'middle': mid_fen, 'end': final_fen}
        # Very popular positions may paginate this sampled game beyond the first
        # page. They remain valid probes but are not counted as proven membership.
        if len(position_checks) < 20 and len(moves) >= 24:
            result = api.search_position(store, final_fen, offset=0, limit=100)
            found = any(row.get('id', row.get('game_id')) == game_id for row in rows_of(result))
            count = total_of(result)
            assert found or count > 100, f'Final position missing from index for game {game_id}'
            position_checks.append({'game_id': game_id, 'found_in_first_page': found, 'matches': count})
    assert len(verified) == min(sample_size, total)
    ratings = profiles.pop('ratings')
    dates = profiles.pop('dates')
    profiles.update(rating_min=min(ratings) if ratings else None, rating_max=max(ratings) if ratings else None,
                    date_min=min(dates) if dates else None, date_max=max(dates) if dates else None)
    return {'random_seed': 20261021, 'requested_games': sample_size, 'verified_games': len(verified),
            'legal_replay': True, 'records': verified, 'position_membership_checks': position_checks,
            'middle_position_move_checks': move_checks,
            'sample_profile': profiles}, positions


@contextmanager
def source_text(path):
    with path.open('rb') as raw:
        if path.name.lower().endswith('.zst'):
            import zstandard
            with zstandard.ZstdDecompressor().stream_reader(raw) as reader:
                with io.TextIOWrapper(reader, encoding='utf-8-sig') as text:
                    yield text
        else:
            with io.TextIOWrapper(raw, encoding='utf-8-sig') as text:
                yield text


def verify_source_prefix(api, store, source, total, limit=10):
    """Compare independently parsed source PGNs with complete stored PGNs.

    Intended for these known-valid fresh benchmark samples, not deduplicating
    resume runs where imported IDs no longer correspond to source offsets.
    """
    verified = 0
    annotated_nodes = 0
    nag_count = 0
    machine_clock_nodes = 0
    machine_eval_nodes = 0
    with source_text(source) as stream:
        for offset in range(min(limit, total)):
            original = chess.pgn.read_game(stream)
            assert original is not None and not original.errors, 'Unexpected invalid source-prefix PGN'
            item = rows_of(api.list_games(store, offset=offset, limit=1))[0]
            retrieved = chess.pgn.read_game(io.StringIO(api.read_game(store, item['id'])['pgn']))
            expected = original.accept(chess.pgn.StringExporter(headers=True, variations=True, comments=True))
            actual = retrieved.accept(chess.pgn.StringExporter(headers=True, variations=True, comments=True))
            assert actual == expected, f'Source PGN annotations or content changed at offset {offset}'
            stack = [original]
            while stack:
                node = stack.pop()
                annotated_nodes += bool(node.comment or node.starting_comment)
                nag_count += len(node.nags)
                machine_clock_nodes += '[%clk ' in node.comment
                machine_eval_nodes += '[%eval ' in node.comment
                stack.extend(node.variations)
            verified += 1
    return {'games': verified, 'canonical_pgn_equal': True, 'annotated_nodes': annotated_nodes,
            'nags': nag_count, 'clock_nodes': machine_clock_nodes, 'evaluation_nodes': machine_eval_nodes}


def measure_queries(api, store, total, positions):
    calls = {
        'list_first_50': lambda: api.list_games(store, offset=0, limit=50),
        'list_last_50': lambda: api.list_games(store, offset=max(0, total - 50), limit=50),
        'explorer_initial': lambda: api.explorer_data(store, chess.STARTING_FEN),
        'position_initial': lambda: api.search_position(store, chess.STARTING_FEN, offset=0, limit=50),
        'explorer_initial_1800_1900_rapid': lambda: api.explorer_data(store, chess.STARTING_FEN, rating_min=1800, rating_max=1900, speed='rapid'),
    }
    for label, fen in positions.items():
        calls[f'explorer_{label}'] = lambda fen=fen: api.explorer_data(store, fen)
        calls[f'position_{label}'] = lambda fen=fen: api.search_position(store, fen, offset=0, limit=50)
    result = {}
    for label, call in calls.items():
        timing, value = timed(call)
        timing['result'] = describe_result(value)
        result[label] = timing
    return result


def write_reports(name, report):
    path = OUTPUT / f'{name}.json'
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    lines = [f'# Benchmark ChessGym — {name}', '', f"Mesuré le {report['measured_at']}.", '',
             f"Source : `{report['source']['path']}`.",
             f"Limite demandée : {report['requested_games']:,} parties.",
             f"Import : **{report['import_seconds']:.2f} s**.",
             f"Stockage mesuré : **{report['storage']['total_bytes'] / 1024**2:.2f} Mio** (fichiers présents).", '',
             'Ces mesures concernent cette machine et ce lot. Elles ne prédisent pas les performances à un million ou dix millions de parties.', '',
             'Les requêtes sont mesurées après import : les caches du système peuvent déjà être chauds. La mémoire est le pic du processus Python depuis son lancement, pas une mesure du seul index.', '',
             '| Requête | Premier appel après import | Médiane des 5 répétitions |',
             '| --- | ---: | ---: |']
    for name_, measurement in report.get('queries', {}).items():
        lines.append(f"| {name_} | {measurement['first_after_import_ms']:.3f} ms | {measurement['repeat_median_ms']:.3f} ms |")
    if report.get('recheck'):
        recheck = report['recheck']
        lines += ['', '## Vérification après optimisation de l’index', '',
                  f"Mise à jour du stockage existant : {recheck['index_update_seconds']:.3f} s, sans réimporter les PGN.",
                  f"Stockage après mise à jour : {recheck['storage']['total_bytes'] / 1024**2:.2f} Mio.", '',
                  '| Requête | Premier appel mesuré | Médiane des 5 répétitions |',
                  '| --- | ---: | ---: |']
        for name_, measurement in recheck['queries'].items():
            lines.append(f"| {name_} | {measurement['first_after_import_ms']:.3f} ms | {measurement['repeat_median_ms']:.3f} ms |")
    lines += ['', f"Contrôle SQLite : **{report['storage']['sqlite_quick_check']}**.",
              f"PGN relus et rejoués légalement : **{report.get('integrity', {}).get('verified_games', 0)}**.",
              f"Source inchangée (taille, date et empreinte du premier Mio) : **{report['source_unchanged']}**.", '',
              'Le rapport JSON adjacent contient les paramètres, compteurs, positions de test et mesures brutes.']
    (OUTPUT / f'{name}.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--games', type=int, default=100000)
    parser.add_argument('--integrity-samples', type=int, default=100)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--recheck', action='store_true', help='update isolated indexes and remeasure an existing report, without importing')
    args = parser.parse_args()
    if not args.name or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in args.name):
        parser.error('--name must contain only letters, digits, dashes or underscores')
    if args.games <= 0 or args.integrity_samples <= 0:
        parser.error('sample limits must be positive')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    store = (OUTPUT / f'{args.name}.sqlite3').resolve()
    if not store.is_relative_to(OUTPUT.resolve()):
        parser.error('store must stay inside the isolated benchmark directory')
    if store.exists() and not args.resume and not args.recheck:
        parser.error('store already exists; choose a fresh name or explicitly --resume')
    import reference_store as api

    source = args.source.resolve(strict=True)
    if args.recheck:
        previous = OUTPUT / f'{args.name}.json'
        if not store.is_file() or not previous.is_file():
            parser.error('--recheck requires an existing benchmark store and report')
        report = json.loads(previous.read_text(encoding='utf-8'))
        if source_identity(source) != report['source']:
            parser.error('source no longer matches the existing benchmark report')
        started = time.perf_counter()
        api.init_store(store)
        recheck = {'at': datetime.now(timezone.utc).isoformat(),
                   'index_update_seconds': round(time.perf_counter() - started, 6),
                   'importer_sha256': hashlib.sha256(Path(api.__file__).read_bytes()).hexdigest()}
        total = total_of(api.list_games(store, offset=0, limit=1))
        recheck['integrity'], positions = verify_games(api, store, total, args.integrity_samples)
        recheck['integrity']['source_prefix'] = verify_source_prefix(api, store, source, total)
        recheck['queries'] = measure_queries(api, store, total, positions)
        recheck['storage'] = storage_metrics(store)
        report['recheck'] = recheck
        assert source_identity(source) == report['source']
        assert recheck['storage']['sqlite_quick_check'] == 'ok'
        output = write_reports(args.name, report)
        print(json.dumps({'report': str(output), 'recheck': recheck}, ensure_ascii=False), flush=True)
        return
    report = {'measured_at': datetime.now(timezone.utc).isoformat(),
              'platform': platform.platform(), 'python': sys.version, 'python_chess': chess.__version__,
              'importer_sha256_at_start': hashlib.sha256(Path(api.__file__).read_bytes()).hexdigest(),
              'schema_version': api.SCHEMA_VERSION,
              'source': source_identity(source), 'store': str(store), 'requested_games': args.games,
              'memory_before': process_memory(), 'resume': args.resume}
    last_print = [0.0]

    def progress(value):
        now = time.monotonic()
        if now - last_print[0] >= 15:
            print(json.dumps({'progress': value}, ensure_ascii=False), flush=True)
            last_print[0] = now

    started = time.perf_counter()
    report['import_status'] = api.import_file(store, source, max_games=args.games, progress=progress)
    report['import_seconds'] = round(time.perf_counter() - started, 6)
    report['memory_after_import'] = process_memory()
    report['status'] = api.status(store)
    print(json.dumps({'import_seconds': report['import_seconds'], 'status': report['status']}, ensure_ascii=False), flush=True)
    if report['status'].get('status') not in ('paused', 'completed') or report['status'].get('error'):
        (OUTPUT / f'{args.name}-failed.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        raise RuntimeError('Import did not finish or pause cleanly; see the failed report')
    initial = api.list_games(store, offset=0, limit=50)
    total = total_of(initial)
    assert total > 0, 'No games were imported'
    report['games_per_second'] = round(total / report['import_seconds'], 3) if not args.resume else None
    report['integrity'], positions = verify_games(api, store, total, args.integrity_samples)
    if not args.resume:
        report['integrity']['source_prefix'] = verify_source_prefix(api, store, source, total)
    report['probe_positions'] = positions
    report['queries'] = measure_queries(api, store, total, positions)
    report['storage'] = storage_metrics(store)
    report['source_unchanged'] = source_identity(source) == report['source']
    assert report['source_unchanged'], 'Source metadata changed during benchmark'
    assert report['storage']['sqlite_quick_check'] == 'ok', 'SQLite quick_check failed'
    report['memory_after_validation'] = process_memory()
    output = write_reports(args.name, report)
    print(json.dumps({'report': str(output), 'games': total, 'seconds': report['import_seconds'],
                      'storage_bytes': report['storage']['total_bytes'], 'integrity_games': report['integrity']['verified_games']}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
