"""Isolated optional filter experiment. Does not alter the running scanner."""
from collections import deque
from contextlib import ExitStack
import hashlib
import io
import json
import multiprocessing
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from scripts import filter_lichess_archive as scan
from reference_parallel import parsing_pool
import zstandard


def inside_comment(record):
    separator = scan.HEADER_END.search(record)
    if separator is None:
        scan.record_info(record)
    body = record[separator.end():]
    # In ordinary Lichess movetext only brace comments carry across lines.
    # Semicolon / percent lines may contain misleading braces: use the full
    # existing lexer for those uncommon records. No move validation is skipped;
    # it happens independently in a worker before any result is written.
    if b';' in body or body.startswith(b'%') or b'\n%' in body:
        return b'{' in scan.COMMENTS.sub(b' ', body)
    return body.rfind(b'{') > body.rfind(b'}')


def raw_records(chunks):
    pending = b''
    for chunk in chunks:
        data = pending + chunk
        start = 0
        for match in scan.EVENT_START.finditer(data):
            boundary = match.start()
            if boundary == 0 or not data[start:boundary].strip(b'\xef\xbb\xbf \r\n\t'):
                continue
            candidate = data[start:boundary]
            if inside_comment(candidate):
                continue
            yield candidate
            start = boundary
        pending = data[start:]
        if len(pending) > scan.MAX_RECORD_BYTES:
            raise ValueError('Record too large')
    if pending.strip(b'\xef\xbb\xbf \r\n\t'):
        yield pending


def prepare(records):
    counts = {speed: 0 for speed in scan.SPEEDS}
    selected = []
    selected_speeds = dict(counts)
    for record in records:
        info = scan.record_info(record, final=True)
        speed = scan.speed_of(info.get(b'TimeControl'))
        counts[speed] += 1
        white = scan.rating_of(info.get(b'WhiteElo'))
        black = scan.rating_of(info.get(b'BlackElo'))
        if white is not None and black is not None and min(white, black) >= 1600 and speed in ('rapid', 'classical'):
            selected.append(record)
            selected_speeds[speed] += 1
    return counts, selected_speeds, b''.join(selected)


def batches(records, budget=2 * 1024 * 1024):
    batch, size = [], 0
    for record in records:
        if batch and (size + len(record) > budget or len(batch) >= 1024):
            yield batch
            batch, size = [], 0
        batch.append(record)
        size += len(record)
    if batch:
        yield batch


def parallel_results(records, workers):
    with parsing_pool(workers) as pool:
        pending = deque()
        for batch in batches(records):
            pending.append(pool.apply_async(prepare, (batch,)))
            if len(pending) >= workers * 2:
                yield pending.popleft().get(timeout=60)
        while pending:
            yield pending.popleft().get(timeout=60)


def run(path, workers, directory):
    state = dict(compressed_bytes_read=0, decompressed_bytes_read=0, zstd_frames=0)
    digest = hashlib.sha256()
    selected_digest = hashlib.sha256()
    counts = {speed: 0 for speed in scan.SPEEDS}
    selected = dict(counts)
    output = directory / f'filtered-{workers}.pgn.zst'
    started = time.perf_counter()
    with ExitStack() as stack:
        raw = stack.enter_context(open(path, 'rb'))
        destination = stack.enter_context(open(output, 'xb'))
        writer = stack.enter_context(zstandard.ZstdCompressor(level=3, write_checksum=True).stream_writer(destination))
        chunks = scan.decoded_chunks(raw, True, state, digest, lambda: False)
        framed = raw_records(chunks)
        results = parallel_results(framed, workers) if workers > 1 else map(prepare, batches(framed))
        for by_speed, qualified, data in results:
            for key in counts:
                counts[key] += by_speed[key]
                selected[key] += qualified[key]
            selected_digest.update(data)
            writer.write(data)
    elapsed = time.perf_counter() - started
    return dict(workers=workers, seconds=elapsed, games_per_second=sum(counts.values()) / elapsed,
                total=sum(counts.values()), by_speed=counts, qualified_by_speed=selected,
                selected_sha256=selected_digest.hexdigest(), source_sha256=digest.hexdigest())


def main():
    directory = ROOT / 'output' / 'lichess-filter' / ('parallel-experiment-' + time.strftime('%Y%m%dT%H%M%S'))
    directory.mkdir()
    sample = ROOT / 'output' / 'lichess-filter' / 'sample-complete.pgn.zst'
    data = sample.read_bytes()
    path = directory / 'repeated-sample.pgn.zst'
    with open(path, 'xb') as handle:
        for _ in range(16):
            handle.write(data)
    started = time.perf_counter()
    baseline = scan.scan_archive(path, output=directory / 'baseline.pgn.zst', expected_games=7138 * 16)
    baseline['seconds'] = time.perf_counter() - started
    with open(directory / 'baseline.pgn.zst', 'rb') as raw, zstandard.ZstdDecompressor().stream_reader(raw) as reader:
        digest = hashlib.sha256()
        while block := reader.read(1024 * 1024):
            digest.update(block)
    baseline['selected_sha256'] = digest.hexdigest()
    results = [run(path, workers, directory) for workers in (1, 2, 4)]
    for result in results:
        assert result['total'] == baseline['total_games']
        assert result['by_speed'] == baseline['by_speed']
        assert result['qualified_by_speed'] == baseline['qualified_by_speed']
        assert result['selected_sha256'] == baseline['selected_sha256']
        assert result['source_sha256'] == baseline['source_sha256']
    report = {'baseline': baseline, 'experiments': results}
    (directory / 'report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(json.dumps(report, indent=2), flush=True)


if __name__ == '__main__':
    main()
