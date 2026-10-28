"""Optional local setup; pinned dependency files are inputs, never generated outputs."""
from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import platform
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
STOCKFISH_URL = 'https://github.com/official-stockfish/Stockfish/releases/download/sf_18/stockfish-windows-x86-64.zip'
STOCKFISH_SHA256 = '40cc975817e7eee270b03f354810d20956df565420d320f6dd37d454dc81a139'


def download(url: str, target: Path) -> None:
    request = urllib.request.Request(url, headers={'User-Agent': 'ChessGym-local-setup/0.1'})
    temporary = target.with_suffix(target.suffix + '.download')
    try:
        with urllib.request.urlopen(request, timeout=90) as response, temporary.open('wb') as output:
            while chunk := response.read(1024 * 1024):
                output.write(chunk)
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def install_dependencies(root: Path, *, development: bool = False) -> None:
    requirements = root / ('requirements-dev.txt' if development else 'requirements.txt')
    subprocess.run([sys.executable, '-m', 'pip', 'install', '--disable-pip-version-check',
                    '--no-cache-dir', '-r', str(requirements)], check=True)


def prepare_pieces(root: Path) -> None:
    pieces = root / 'static' / 'pieces'
    pieces.mkdir(parents=True, exist_ok=True)
    for color in 'wb':
        for piece in 'KQRBNP':
            name = color + piece + '.svg'
            target = pieces / name
            if not target.exists():
                download('https://raw.githubusercontent.com/lichess-org/lila/master/public/piece/cburnett/' + name, target)
            if '<svg' not in target.read_text(encoding='utf-8'):
                raise RuntimeError('Invalid piece ' + name)


def prepare_engine(root: Path) -> bool:
    # The verified archive below is specific to Windows x86-64. Never install it
    # on another platform or architecture merely because this helper was run.
    if platform.system() != 'Windows' or platform.machine().lower() not in ('amd64', 'x86_64'):
        print('Install a native Stockfish build for your system and set CHESSGYM_ENGINE '
              'to its executable path, or place stockfish on PATH. No engine was downloaded.')
        return False
    temporary = root / '.tmp'
    temporary.mkdir(exist_ok=True)
    archive = temporary / 'stockfish-18.zip'
    if not archive.exists():
        download(STOCKFISH_URL, archive)
    with archive.open('rb') as source:
        actual = hashlib.file_digest(source, 'sha256').hexdigest()
    if actual != STOCKFISH_SHA256:
        raise RuntimeError('Stockfish checksum mismatch; archive was not extracted')
    engines = (root / 'engines').resolve()
    engines.mkdir(exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for member in bundle.infolist():
            if not (engines / member.filename).resolve().is_relative_to(engines):
                raise RuntimeError('Unsafe archive path')
        bundle.extractall(engines)
    print('Verified Stockfish 18 for Windows x86-64 installed.')
    return True


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dev', action='store_true', help='Also install the pinned test dependencies.')
    parser.add_argument('--skip-engine', action='store_true', help='Keep a manually installed engine.')
    parser.add_argument('--skip-dependencies', action='store_true', help='Keep the current Python environment.')
    args = parser.parse_args(argv)
    temporary = ROOT / '.tmp'
    temporary.mkdir(exist_ok=True)
    os.environ['TEMP'] = str(temporary)
    os.environ['TMP'] = str(temporary)
    if not args.skip_dependencies:
        install_dependencies(ROOT, development=args.dev)
    prepare_pieces(ROOT)
    if not args.skip_engine:
        prepare_engine(ROOT)
    print('ChessGym setup complete. Dependency pins were left unchanged; see README.md to start the server.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
