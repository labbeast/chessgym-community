"""Download the public Lichess puzzle archive atomically; never alters the bank."""
import argparse
import hashlib
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen
import zstandard

URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst'


def validate_archive(path):
    # Zstandard may start with a skippable metadata frame. Validate through the
    # decoder instead of assuming the first four bytes begin a data frame.
    with Path(path).open('rb') as source, zstandard.ZstdDecompressor().stream_reader(source) as decoded:
        header = decoded.read(256).split(b'\n', 1)[0].strip()
    if not header.startswith(b'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags'):
        raise IOError('The downloaded response is not a Lichess puzzle archive.')


def download(destination):
    destination = Path(destination).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise FileExistsError('An archive already exists; keep it or select another destination.')
    temporary = destination.with_suffix(destination.suffix + '.part')
    count, digest, last = 0, hashlib.sha256(), time.monotonic()
    with urlopen(Request(URL, headers={'User-Agent': 'ChessGym puzzle-bank importer'}), timeout=60) as source, temporary.open('wb') as target:
        total = int(source.headers.get('Content-Length') or 0)
        print(json.dumps({'status': 'downloading', 'total_bytes': total}), flush=True)
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            target.write(chunk);digest.update(chunk);count += len(chunk)
            if time.monotonic() - last >= 10:
                print(json.dumps({'status': 'downloading', 'bytes': count, 'total_bytes': total}), flush=True)
                last = time.monotonic()
    if total and count != total:
        raise IOError('The archive download is incomplete.')
    validate_archive(temporary)
    temporary.replace(destination)
    result = dict(status='downloaded', source=URL, path=str(destination), bytes=count, sha256=digest.hexdigest())
    destination.with_suffix(destination.suffix + '.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'data/puzzles/source/lichess_db_puzzle.csv.zst')
    download(parser.parse_args().output)
