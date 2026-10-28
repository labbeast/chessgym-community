"""Filter a standard Lichess PGN archive without parsing or rewriting moves.

Example (paths are never overwritten):
  python scripts/filter_lichess_archive.py archive.pgn.zst --min-rating 1600 \
      --speeds rapid classical --output selected.pgn.zst --report selected.json

The input is read once. Each selected PGN record is copied byte for byte.
Completion requires a complete Zstandard frame stream, a complete last PGN,
an unchanged source fingerprint, and any supplied official SHA256/game count.
--max-games is a bounded preflight, always marked limited; its temporary output
is deliberately NOT published as a complete archive. No database is opened.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import time

import zstandard

COMPRESSED_CHUNK = 64 * 1024
MAX_RECORD_BYTES = 20 * 1024 * 1024
MAX_DECOMPRESSED_CHUNK = 64 * 1024 * 1024
SPEEDS = ('ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence', 'unknown')
EVENT_START = re.compile(rb'(?m)^[ \t]*\[Event[ \t]+')
HEADER_END = re.compile(rb'\r?\n[ \t]*\r?\n')
FIELDS = re.compile(rb'(?m)^\[(WhiteElo|BlackElo|TimeControl|Result|Variant) "((?:[^"\\\r\n]|\\.)*)"\][ \t]*\r?$')
COMMENTS = re.compile(rb'\{[^}]*\}|;[^\r\n]*|^%[^\r\n]*', re.MULTILINE)
RESULTS = (b'1-0', b'0-1', b'1/2-1/2', b'*')
TIME_CONTROL = re.compile(rb'(\d+)(?:\+(\d+))?\Z')


class Cancelled(Exception):
    pass


def utc():
    return datetime.now(timezone.utc).isoformat()


def fingerprint(stat):
    return {'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns,
            'device': stat.st_dev, 'inode': stat.st_ino}


def speed_of(value):
    """Lichess estimated duration: base + 40 increments, in seconds."""
    if value is None or value in (b'-', b''):
        return 'correspondence'
    match = TIME_CONTROL.fullmatch(value)
    if not match:
        return 'unknown'
    duration = int(match[1]) + 40 * int(match[2] or b'0')
    if duration < 30:
        return 'ultraBullet'
    if duration < 180:
        return 'bullet'
    if duration < 480:
        return 'blitz'
    if duration < 1500:
        return 'rapid'
    if duration < 21600:
        return 'classical'
    return 'correspondence'


def rating_of(value):
    if value and value.isdigit() and len(value) <= 4:
        return int(value)
    return None


def record_info(record, *, final=False):
    """Validate record boundaries/termination only, never chess moves.

    None means a candidate Event line is inside an unfinished brace comment.
    The next candidate is then considered part of this same record.
    """
    if len(record) > MAX_RECORD_BYTES:
        raise ValueError('Une partie dépasse la limite de 20 Mio.')
    start = record.removeprefix(b'\xef\xbb\xbf').lstrip(b' \r\n\t')
    if not start.startswith(b'[Event '):
        raise ValueError('Début de partie Lichess non reconnu (Event absent).')
    separator = HEADER_END.search(record)
    if not separator:
        raise ValueError('Partie incomplète : séparation entre en-têtes et coups absente.')
    body = COMMENTS.sub(b' ', record[separator.end():])
    if b'{' in body:
        if final:
            raise ValueError('Partie incomplète : commentaire non terminé.')
        return None
    if b'}' in body or body.count(b'(') != body.count(b')'):
        raise ValueError('Partie mal formée : délimiteurs de commentaire/variante déséquilibrés.')
    tokens = body.rsplit(None, 1)
    ending = tokens[-1] if tokens else None
    if ending not in RESULTS:
        raise ValueError('Partie incomplète : résultat final absent.')
    fields = {}
    for match in FIELDS.finditer(record, 0, separator.start()):
        tag, value = match.groups()
        if tag in fields:
            raise ValueError('En-tête de filtrage répété : ' + tag.decode('ascii'))
        fields[tag] = value
    if fields.get(b'Result') != ending:
        raise ValueError('Résultat final absent des en-têtes ou contradictoire.')
    if fields.get(b'Variant', b'Standard') != b'Standard':
        raise ValueError('Cette archive contient une variante non standard.')
    return fields


def records(chunks):
    """Split in C-assisted chunks, preserving all original record bytes."""
    pending = b''
    for chunk in chunks:
        data = pending + chunk
        start = 0
        for match in EVENT_START.finditer(data):
            boundary = match.start()
            if boundary == 0 or not data[start:boundary].strip(b'\xef\xbb\xbf \r\n\t'):
                continue
            candidate = data[start:boundary]
            info = record_info(candidate)
            if info is None:  # Event-looking text inside a multiline comment.
                continue
            yield candidate, info
            start = boundary
        pending = data[start:]
        if len(pending) > MAX_RECORD_BYTES:
            raise ValueError('Partie trop grande ou frontières PGN manquantes.')
    if pending.strip(b'\xef\xbb\xbf \r\n\t'):
        yield pending, record_info(pending, final=True)


def decoded_chunks(raw, compressed, state, digest, cancelled):
    """Incremental frame API exposes EOF, unlike stream_reader on truncation.

    read_across_frames=False is intentional: each ordinary or skippable frame
    must terminate. Unused bytes start the next frame. Input chunks and PGN
    buffers are bounded; no frame or archive is held in memory.
    """
    decoder = None
    while True:
        if cancelled():
            raise Cancelled('Arrêt demandé.')
        block = raw.read(COMPRESSED_CHUNK)
        if not block:
            if compressed and decoder is not None:
                raise ValueError('Archive Zstandard incomplète : fin de cadre manquante.')
            state['input_eof'] = True
            state['source_sha256'] = digest.hexdigest()
            return
        digest.update(block)
        state['compressed_bytes_read'] += len(block)
        if not compressed:
            state['decompressed_bytes_read'] += len(block)
            yield block
            continue
        while block:
            if decoder is None:
                decoder = zstandard.ZstdDecompressor(max_window_size=128 * 1024 * 1024).decompressobj()
            decoded = decoder.decompress(block)
            if len(decoded) > MAX_DECOMPRESSED_CHUNK:
                raise ValueError('Bloc décompressé anormalement volumineux.')
            state['decompressed_bytes_read'] += len(decoded)
            if decoder.eof:
                block = decoder.unused_data
                state['zstd_frames'] += 1
                decoder = None
            else:
                block = b''
            if decoded:
                yield decoded


def _publish_no_replace(temporary, target):
    # Same-directory rename refuses an existing target on Windows. On POSIX,
    # hard linking provides the same atomic no-clobber publication guarantee.
    if os.name == 'nt':
        os.rename(temporary, target)
    else:
        os.link(temporary, target)
        os.unlink(temporary)


def scan_archive(source, *, output=None, report=None, min_rating=1600,
                 speeds=('rapid', 'classical'), expected_sha256=None,
                 expected_games=None, max_games=None, progress_seconds=10,
                 cancelled=lambda: False, progress=None, workers=1):
    source = Path(source).resolve()
    output = Path(output).resolve() if output else None
    report = Path(report).resolve() if report else None
    if type(workers) is not int or not 1 <= workers <= 16:
        raise ValueError('Le nombre de processus doit être un entier de 1 à 16.')
    if type(min_rating) is not int or not 0 <= min_rating <= 9999:
        raise ValueError('Le seuil Elo doit être un entier de 0 à 9999.')
    speeds = tuple(dict.fromkeys(speeds))
    if not speeds or any(value not in SPEEDS for value in speeds):
        raise ValueError('Cadences de filtrage invalides.')
    if max_games is not None and (type(max_games) is not int or max_games <= 0):
        raise ValueError('La limite de parties doit être strictement positive.')
    if expected_games is not None and (type(expected_games) is not int or expected_games < 0):
        raise ValueError('Nombre de parties attendu invalide.')
    if expected_sha256 is not None:
        expected_sha256 = expected_sha256.lower()
        if not re.fullmatch(r'[a-f0-9]{64}', expected_sha256):
            raise ValueError('SHA256 attendu invalide.')
    if output and not str(output).lower().endswith('.pgn.zst'):
        raise ValueError('La sortie doit être un nouveau fichier .pgn.zst.')
    if report and report in (source, output):
        raise ValueError('Le rapport doit être distinct du fichier source et de la sortie.')
    initial = fingerprint(source.stat())
    if output == source or (output and output.exists()):
        raise FileExistsError('La sortie existe déjà ou désigne le fichier source.')
    if report and report.exists():
        raise FileExistsError('Le rapport existe déjà; choisir un nouveau nom.')
    for path in (output, report):
        if path:
            path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + f'.partial-{os.getpid()}') if output else None
    state = dict(status='running', source=str(source), output=str(output) if output else None,
                 temporary_output=str(temporary) if temporary else None,
                 started_at=utc(), updated_at=utc(), min_rating=min_rating,
                 selected_speeds=list(speeds), source_fingerprint=initial,
                 expected_sha256=expected_sha256, expected_games=expected_games,
                 total_games=0, qualified_games=0, missing_ratings=0,
                 below_min_rating=0, by_speed={key: 0 for key in SPEEDS},
                 qualified_by_speed={key: 0 for key in SPEEDS},
                 rating_eligible_by_speed={key: 0 for key in SPEEDS},
                 compressed_bytes_read=0, decompressed_bytes_read=0,
                 selected_pgn_bytes=0, output_bytes=0, zstd_frames=0,
                 input_eof=False, integrity_verified=False, source_sha256=None,
                 error=None, max_games=max_games, workers=workers)
    started = time.monotonic()
    last_progress = started

    def notify(force=False):
        nonlocal last_progress
        now = time.monotonic()
        if not force and now - last_progress < progress_seconds:
            return
        last_progress = now
        state['updated_at'] = utc()
        state['elapsed_seconds'] = round(now - started, 3)
        state['games_per_second'] = round(state['total_games'] / max(now - started, .001), 1)
        if temporary and temporary.exists():
            state['output_bytes'] = temporary.stat().st_size
        if report:
            temp_report = report.with_name(report.name + f'.tmp-{os.getpid()}')
            with open(temp_report, 'x', encoding='utf-8') as handle:
                json.dump(state, handle, ensure_ascii=False, indent=2)
                handle.write('\n')
            os.replace(temp_report, report)
        if progress:
            progress(dict(state))

    # Reserve the report exclusively before writing any output. This also stops
    # two jobs from accidentally using one progress-report destination.
    if report:
        with open(report, 'x', encoding='utf-8') as handle:
            json.dump(state, handle, ensure_ascii=False)
    try:
        with ExitStack() as stack:
            raw = stack.enter_context(open(source, 'rb'))
            if fingerprint(os.fstat(raw.fileno())) != initial:
                raise ValueError('Le fichier source a changé avant son ouverture.')
            writer = None
            if temporary:
                destination = stack.enter_context(open(temporary, 'xb'))
                writer = stack.enter_context(zstandard.ZstdCompressor(
                    level=3, write_checksum=True).stream_writer(destination, closefd=False))
            notify(True)
            digest = hashlib.sha256()
            chunks = decoded_chunks(raw, str(source).lower().endswith('.zst'), state, digest, cancelled)
            if workers > 1:
                # Support invocation by script path as well as module import.
                root = str(Path(__file__).resolve().parents[1])
                if root not in sys.path:
                    sys.path.insert(0, root)
                from scripts.filter_lichess_parallel import filtered_batches
                prepared = filtered_batches(chunks, workers=workers, min_rating=min_rating,
                    speeds=speeds, max_games=max_games, cancelled=cancelled, cancellation_error=Cancelled)
                with closing(prepared):
                    for values, selected in prepared:
                        for key, value in values.items():
                            if isinstance(value, dict):
                                for cadence, count in value.items():
                                    state[key][cadence] += count
                            else:
                                state[key] += value
                        if writer and selected:
                            writer.write(selected)
                        notify()
                if max_games is not None and state['total_games'] >= max_games:
                    state['status'] = 'limited'
            else:
                for record, fields in records(chunks):
                    state['total_games'] += 1
                    cadence = speed_of(fields.get(b'TimeControl'))
                    state['by_speed'][cadence] += 1
                    white = rating_of(fields.get(b'WhiteElo'))
                    black = rating_of(fields.get(b'BlackElo'))
                    if white is None or black is None:
                        state['missing_ratings'] += 1
                    elif min(white, black) < min_rating:
                        state['below_min_rating'] += 1
                    else:
                        state['rating_eligible_by_speed'][cadence] += 1
                        if cadence in speeds:
                            state['qualified_games'] += 1
                            state['qualified_by_speed'][cadence] += 1
                            state['selected_pgn_bytes'] += len(record)
                            if writer:
                                writer.write(record)
                    if state['total_games'] % 256 == 0:
                        if cancelled():
                            raise Cancelled('Arrêt demandé.')
                        notify()
                    if max_games is not None and state['total_games'] >= max_games:
                        state['status'] = 'limited'
                        break
            if state['status'] != 'limited':
                if not state['input_eof']:
                    raise ValueError('La lecture ne confirme pas la fin du fichier.')
                if state['total_games'] == 0:
                    raise ValueError('Aucune partie trouvée dans le fichier.')
                if expected_sha256 and state['source_sha256'] != expected_sha256:
                    raise ValueError('Le SHA256 du fichier ne correspond pas au SHA256 attendu.')
                if expected_games is not None and state['total_games'] != expected_games:
                    raise ValueError('Le nombre de parties ne correspond pas au total attendu.')
                if fingerprint(os.fstat(raw.fileno())) != initial or fingerprint(source.stat()) != initial:
                    raise ValueError('Le fichier source a changé pendant la lecture.')
                state['integrity_verified'] = True
                state['status'] = 'verifying_output'
        # ExitStack closes and finalizes the compressed output before publication.
        if state['status'] == 'verifying_output':
            if fingerprint(source.stat()) != initial:
                raise ValueError('Le fichier source a changé avant la finalisation.')
            if temporary:
                with open(temporary, 'rb+') as handle:
                    os.fsync(handle.fileno())
                state['output_bytes'] = temporary.stat().st_size
                _publish_no_replace(temporary, output)
                state['temporary_output'] = None
            state['status'] = 'completed'
    except (Cancelled, KeyboardInterrupt) as exc:
        state['status'] = 'cancelled'
        state['error'] = str(exc) or 'Interruption demandée.'
    except Exception as exc:
        state['status'] = 'failed'
        state['error'] = str(exc)[:1000]
    state['finished_at'] = utc()
    notify(True)
    return state


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('source', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--min-rating', type=int, default=1600)
    parser.add_argument('--speeds', choices=SPEEDS, nargs='+', default=['rapid', 'classical'])
    parser.add_argument('--expected-sha256')
    parser.add_argument('--expected-games', type=int)
    parser.add_argument('--max-games', type=int)
    parser.add_argument('--progress-seconds', type=float, default=10)
    parser.add_argument('--workers', type=int, default=1, help='Processus de validation (1 à 16, défaut 1).')
    parser.add_argument('--cancel-file', type=Path)
    args = parser.parse_args()
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    cancel_file = args.cancel_file
    options = vars(args)
    options.pop('cancel_file')
    try:
        result = scan_archive(**options,
            cancelled=lambda: stopping or bool(cancel_file and cancel_file.exists()),
            progress=lambda state: print(json.dumps(state, ensure_ascii=True), flush=True))
    except Exception as exc:
        print(json.dumps({'status': 'failed', 'error': str(exc)}, ensure_ascii=True), flush=True)
        return 2
    return {'completed': 0, 'limited': 3, 'cancelled': 130}.get(result['status'], 2)


if __name__ == '__main__':
    raise SystemExit(main())
