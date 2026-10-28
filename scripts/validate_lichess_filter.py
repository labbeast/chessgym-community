"""Independently validate a completed Lichess filtered archive, read only.

All PGN headers are checked without the filter's predicate. Zstandard is decoded
to the real end of every frame (including checksums); a small deterministic
sample is fully replayed. Memory is bounded by chunks and one PGN record.
The original source is never opened for writing and is not rescanned.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import random
import re
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import chess.pgn
import zstandard
import reference_store

OFFICIAL_GAMES = 89_616_462
OFFICIAL_SHA256 = '1de8eb64fed443f4be310c779e8d60a13bcfc6e3b104bcb39a018eb056edec89'
HEADER_END = re.compile(rb'\r?\n[ \t]*\r?\n')
TAGS = re.compile(rb'(?m)^\[(WhiteElo|BlackElo|TimeControl|Result|Site|Variant) "((?:[^"\\\r\n]|\\.)*)"\][ \t]*\r?$')
CONTROL = re.compile(rb'(\d+)(?:\+(\d+))?\Z')
COMMENTS = re.compile(rb'\{[^}]*\}|;[^\r\n]*|^%[^\r\n]*', re.MULTILINE)


def utc():
    return datetime.now(timezone.utc).isoformat()


def publish(path, report):
    temporary = path.with_name(path.name + '.writing')
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, path)


class CheckedZstdReader(io.RawIOBase):
    """Expose bounded decoded chunks while checking frame completion explicitly.

    stream_reader alone can accept a prefix ending before the frame footer.
    decompressobj.eof distinguishes that case and verifies any stored checksum.
    """

    def __init__(self, raw):
        self.raw = raw
        self.decoder = None
        self.unused = b''
        self.pending = memoryview(b'')
        self.frames = 0
        self.compressed_bytes = self.decompressed_bytes = 0
        self.compressed_sha = hashlib.sha256()
        self.decompressed_sha = hashlib.sha256()
        self.reached_eof = False

    def readable(self):
        return True

    def _fill(self):
        while not self.pending:
            block, self.unused = self.unused, b''
            if not block:
                block = self.raw.read(64 * 1024)
                if not block:
                    if self.decoder is not None:
                        raise ValueError('Incomplete Zstandard frame: archive ended before its footer.')
                    self.reached_eof = True
                    return False
                self.compressed_sha.update(block)
                self.compressed_bytes += len(block)
            if self.decoder is None:
                self.decoder = zstandard.ZstdDecompressor(max_window_size=128 * 1024 * 1024).decompressobj()
            decoded = self.decoder.decompress(block)
            if len(decoded) > 64 * 1024 * 1024:
                raise ValueError('Unexpectedly large decompressed chunk.')
            self.decompressed_bytes += len(decoded)
            self.decompressed_sha.update(decoded)
            if self.decoder.eof:
                self.frames += 1
                self.unused = self.decoder.unused_data
                self.decoder = None
            self.pending = memoryview(decoded)
        return True

    def readinto(self, target):
        if not self._fill():
            return 0
        count = min(len(target), len(self.pending))
        target[:count] = self.pending[:count]
        self.pending = self.pending[count:]
        return count


def checked_headers(record, number):
    separator = HEADER_END.search(record)
    if not separator:
        raise ValueError(f'Game {number}: headers have no complete separator.')
    headers = {}
    for match in TAGS.finditer(record, 0, separator.start()):
        key, value = match.groups()
        if key in headers:
            raise ValueError(f'Game {number}: duplicate {key!r}.')
        headers[key] = value
    ratings = []
    for key in (b'WhiteElo', b'BlackElo'):
        value = headers.get(key, b'')
        if not value.isdigit() or int(value) < 1600:
            raise ValueError(f'Game {number}: {key!r} is not a numeric rating >=1600.')
        ratings.append(int(value))
    control = CONTROL.fullmatch(headers.get(b'TimeControl', b''))
    if not control:
        raise ValueError(f'Game {number}: unsupported TimeControl.')
    estimated_seconds = int(control[1]) + 40 * int(control[2] or b'0')
    if 480 <= estimated_seconds < 1500:
        cadence = 'rapid'
    elif 1500 <= estimated_seconds < 21600:
        cadence = 'classical'
    else:
        raise ValueError(f'Game {number}: time control outside rapid/classical ({estimated_seconds}s).')
    if headers.get(b'Variant', b'Standard') != b'Standard':
        raise ValueError(f'Game {number}: non-standard variant.')
    return headers, ratings, cadence, estimated_seconds


def replay(record, number, headers):
    text = record.decode('utf-8-sig', errors='strict')
    stream = io.StringIO(text)
    game = chess.pgn.read_game(stream)
    if game is None or game.errors or chess.pgn.read_game(stream) is not None:
        raise ValueError(f'Sampled game {number}: invalid PGN.')
    pending = [(game, game.board())]
    plies = 0
    while pending:
        node, board = pending.pop()
        for child in node.variations:
            if child.move not in board.legal_moves:
                raise ValueError(f'Sampled game {number}: illegal move.')
            next_board = board.copy(stack=False)
            next_board.push(child.move)
            pending.append((child, next_board))
            plies += 1
    return {'record': number, 'site': headers.get(b'Site', b'').decode('utf-8'),
            'legal_plies_all_variations': plies, 'raw_pgn_sha256': hashlib.sha256(record).hexdigest()}


def wait_for_completion(path, timeout, output, progress):
    started = time.monotonic()
    last_notice = 0
    while True:
        try:
            state = json.loads(path.read_text(encoding='utf-8'))
        except (FileNotFoundError, json.JSONDecodeError):
            state = {}
        if state.get('status') == 'completed' and state.get('integrity_verified') is True:
            return state
        if state.get('status') in ('failed', 'error', 'cancelled', 'limited'):
            raise ValueError('Source filtering did not complete: ' + str(state.get('status')))
        if time.monotonic() - started >= timeout:
            raise TimeoutError('Waiting for completed and integrity_verified filtering report timed out.')
        if time.monotonic() - last_notice >= 300:
            progress.update(updated_at=utc(), filter_status=state.get('status'),
                            filter_games_processed=state.get('total_games'),
                            filter_games_selected=state.get('qualified_games'))
            publish(output, progress)
            print(json.dumps({key: progress.get(key) for key in ('status', 'updated_at', 'filter_games_processed', 'filter_games_selected')}), flush=True)
            last_notice = time.monotonic()
        time.sleep(30)


def validate(archive, filtering, output, report):
    if filtering.get('total_games') != OFFICIAL_GAMES or filtering.get('source_sha256') != OFFICIAL_SHA256:
        raise ValueError('Completed filter report does not match official source count/SHA256.')
    if Path(filtering['output']).resolve() != archive:
        raise ValueError('The requested archive does not match the completed filter report.')
    expected = filtering['qualified_games']
    sample_ids = set(random.Random(20261022).sample(range(1, expected + 1), min(24, expected)))
    if expected:
        sample_ids.update((1, expected))
    before = archive.stat()
    original = Path(filtering['source'])
    original_before = original.stat()
    source_fingerprint = filtering['source_fingerprint']
    if (original_before.st_size, original_before.st_mtime_ns) != (source_fingerprint['size'], source_fingerprint['mtime_ns']):
        raise ValueError('Original source metadata changed after filtering.')
    started = last_notice = time.monotonic()
    report.update(status='validating', validation_started_at=utc(), expected_games=expected,
                  filter_status='completed', filter_games_processed=filtering['total_games'],
                  filter_games_selected=expected,
                  expected_breakdown={key: filtering['qualified_by_speed'].get(key, 0) for key in ('rapid', 'classical')},
                  source_official_count_and_sha_confirmed_by_filter_report=True,
                  source_hash_not_recomputed=True, samples=[], sample_seed=20261022)
    publish(output, report)
    print(json.dumps({'status': 'validating', 'expected_games': expected}), flush=True)
    count, counts, smallest, largest = 0, Counter(), [None, None], [None, None]
    last_record = last_headers = None
    with archive.open('rb') as raw:
        checked = CheckedZstdReader(raw)
        with io.BufferedReader(checked, buffer_size=256 * 1024) as decoded:
            for record, offset, error in reference_store._record_stream(decoded):
                if error:
                    raise ValueError(error)
                if not record.strip():
                    continue
                count += 1
                headers, ratings, cadence, _ = checked_headers(record, count)
                counts[cadence] += 1
                for side in (0, 1):
                    smallest[side] = ratings[side] if smallest[side] is None else min(smallest[side], ratings[side])
                    largest[side] = ratings[side] if largest[side] is None else max(largest[side], ratings[side])
                if count in sample_ids:
                    report['samples'].append(replay(record, count, headers))
                last_record, last_headers = record, headers
                if time.monotonic() - last_notice >= 30:
                    report.update(updated_at=utc(), verified_games=count, verified_by_speed=dict(counts),
                                  elapsed_seconds=time.monotonic() - started, compressed_bytes_read=checked.compressed_bytes,
                                  decompressed_bytes_read=checked.decompressed_bytes)
                    publish(output, report)
                    print(json.dumps({key: report[key] for key in ('status', 'verified_games', 'elapsed_seconds')}), flush=True)
                    last_notice = time.monotonic()
        if not checked.reached_eof or checked.decoder is not None or checked.frames < 1:
            raise ValueError('Complete Zstandard EOF was not verified.')
    if count != expected:
        raise ValueError(f'Game count differs from filter report: {count} != {expected}.')
    if {key: counts[key] for key in ('rapid', 'classical')} != report['expected_breakdown']:
        raise ValueError('Cadence totals differ from filter report.')
    if checked.decompressed_bytes != filtering['selected_pgn_bytes']:
        raise ValueError('Decoded PGN byte count differs from filter report.')
    if last_record:
        separator = HEADER_END.search(last_record)
        body = COMMENTS.sub(b' ', last_record[separator.end():])
        ending = body.rsplit(None, 1)
        if not ending or ending[-1] != last_headers.get(b'Result') or b'{' in body or b'}' in body:
            raise ValueError('Final PGN record is incomplete or has an inconsistent result.')
    after = archive.stat()
    original_after = original.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('Filtered archive changed during independent validation.')
    if (original_before.st_size, original_before.st_mtime_ns) != (original_after.st_size, original_after.st_mtime_ns):
        raise ValueError('Original source changed during independent validation.')
    report.update(status='completed', updated_at=utc(), completed_at=utc(), verified_games=count,
                  verified_by_speed=dict(counts), min_white_elo=smallest[0], min_black_elo=smallest[1],
                  max_white_elo=largest[0], max_black_elo=largest[1],
                  elapsed_seconds=time.monotonic() - started,
                  compressed_bytes_read=checked.compressed_bytes, decompressed_bytes_read=checked.decompressed_bytes,
                  compressed_sha256=checked.compressed_sha.hexdigest(), decompressed_sha256=checked.decompressed_sha.hexdigest(),
                  complete_zstd_frames=checked.frames, zstd_checksums_and_eof_verified=True,
                  final_pgn_complete=True, all_selected_headers_eligible=True,
                  original_unchanged=True, filtered_archive_unchanged=True,
                  scope='Every selected PGN header checked; deterministic sample legally replayed; no full move analysis outside sample; no database access.')
    publish(output, report)
    print(json.dumps({key: report[key] for key in ('status', 'verified_games', 'verified_by_speed', 'elapsed_seconds', 'compressed_sha256')}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--filter-report', type=Path, required=True)
    parser.add_argument('--output-report', type=Path, required=True)
    parser.add_argument('--wait-seconds', type=int, default=0)
    args = parser.parse_args()
    archive, filtering, output = (path.resolve() for path in (args.archive, args.filter_report, args.output_report))
    allowed = (ROOT / 'output' / 'lichess-filter').resolve()
    if not output.is_relative_to(allowed) or output in (archive, filtering):
        parser.error('Validation reports must stay under output/lichess-filter and be distinct from their inputs.')
    if output.exists():
        parser.error('Validation report already exists; select a new report path.')
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {'status': 'waiting', 'created_at': utc(), 'archive': str(archive), 'filter_report': str(filtering)}
    publish(output, report)
    try:
        complete = wait_for_completion(filtering, args.wait_seconds, output, report)
        validate(archive, complete, output, report)
    except Exception as exc:
        report.update(status='failed', updated_at=utc(), error=str(exc))
        publish(output, report)
        raise


if __name__ == '__main__':
    main()
