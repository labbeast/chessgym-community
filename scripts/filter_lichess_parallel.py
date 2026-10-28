"""Optional bounded, ordered metadata workers for the archive filter."""
from collections import deque
import itertools
import multiprocessing

from reference_parallel import parsing_pool
from scripts import filter_lichess_archive as scanner

BATCH_BYTES = 2 * 1024 * 1024
BATCH_GAMES = 1024
MAX_PENDING_BYTES = 32 * 1024 * 1024


def _inside_comment(record):
    separator = scanner.HEADER_END.search(record)
    if separator is None:
        scanner.record_info(record)  # Raise the same incomplete-header error.
    body = record[separator.end():]
    if b';' in body or body.startswith(b'%') or b'\n%' in body:
        return b'{' in scanner.COMMENTS.sub(b' ', body)
    # Only brace comments carry across lines in this ordinary PGN case. This
    # answers boundary framing only; workers still run the complete validator.
    return body.rfind(b'{') > body.rfind(b'}')


def raw_records(chunks):
    pending = b''
    for chunk in chunks:
        data = pending + chunk
        start = 0
        for match in scanner.EVENT_START.finditer(data):
            boundary = match.start()
            if boundary == 0 or not data[start:boundary].strip(b'\xef\xbb\xbf \r\n\t'):
                continue
            candidate = data[start:boundary]
            if _inside_comment(candidate):
                continue
            yield candidate
            start = boundary
        pending = data[start:]
        if len(pending) > scanner.MAX_RECORD_BYTES:
            raise ValueError('Partie trop grande ou frontières PGN manquantes.')
    if pending.strip(b'\xef\xbb\xbf \r\n\t'):
        yield pending


def prepare_batch(records, min_rating, speeds):
    values = dict(total_games=0, qualified_games=0, missing_ratings=0, below_min_rating=0,
                  selected_pgn_bytes=0, by_speed={key: 0 for key in scanner.SPEEDS},
                  qualified_by_speed={key: 0 for key in scanner.SPEEDS},
                  rating_eligible_by_speed={key: 0 for key in scanner.SPEEDS})
    selected = []
    for record in records:
        fields = scanner.record_info(record, final=True)
        values['total_games'] += 1
        cadence = scanner.speed_of(fields.get(b'TimeControl'))
        values['by_speed'][cadence] += 1
        white = scanner.rating_of(fields.get(b'WhiteElo'))
        black = scanner.rating_of(fields.get(b'BlackElo'))
        if white is None or black is None:
            values['missing_ratings'] += 1
        elif min(white, black) < min_rating:
            values['below_min_rating'] += 1
        else:
            values['rating_eligible_by_speed'][cadence] += 1
            if cadence in speeds:
                values['qualified_games'] += 1
                values['qualified_by_speed'][cadence] += 1
                values['selected_pgn_bytes'] += len(record)
                selected.append(record)
    return values, b''.join(selected)


def _batches(records):
    batch, size = [], 0
    for record in records:
        if batch and (size + len(record) > BATCH_BYTES or len(batch) >= BATCH_GAMES):
            yield batch, size
            batch, size = [], 0
        batch.append(record)
        size += len(record)
    if batch:
        yield batch, size


def filtered_batches(chunks, *, workers, min_rating, speeds, max_games, cancelled,
                     cancellation_error=scanner.Cancelled):
    """A sole coordinator owns source/output; children only return validated data.

    Queue <=2 batches per worker and <=32 MiB inputs, plus one held batch.
    A single oversized record is bounded by the existing 20 MiB PGN limit.
    Closing this generator on error/cancellation terminates all pending workers.
    """
    framed = raw_records(chunks)
    if max_games is not None:
        framed = itertools.islice(framed, max_games)
    batches = iter(_batches(framed))
    try:
        with parsing_pool(workers) as pool:
            originals = tuple(pool._pool)
            pending = deque()
            inflight = 0
            held = None
            exhausted = False
            while pending or not exhausted:
                if cancelled():
                    raise cancellation_error('Arrêt demandé.')
                while not exhausted and len(pending) < workers * 2:
                    if held is None:
                        held = next(batches, None)
                    if held is None:
                        exhausted = True
                        break
                    batch, size = held
                    if pending and inflight + size > MAX_PENDING_BYTES:
                        break
                    pending.append((pool.apply_async(prepare_batch, (batch, min_rating, speeds)), size))
                    inflight += size
                    held = None
                if not pending:
                    break
                result, size = pending[0]
                while True:
                    if cancelled():
                        raise cancellation_error('Arrêt demandé.')
                    try:
                        prepared = result.get(timeout=.1)
                        break
                    except multiprocessing.TimeoutError:
                        if any(process.exitcode is not None for process in originals):
                            raise RuntimeError('Un processus de filtrage a été interrompu.')
                pending.popleft()
                inflight -= size
                yield prepared
    finally:
        batches.close()
        chunks.close()
