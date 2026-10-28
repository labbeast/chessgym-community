from pathlib import Path
import shutil
import subprocess

import zstandard
import pytest
from scripts.download_puzzle_bank import validate_archive

ROOT = Path(__file__).resolve().parents[1]


def test_sound_categories_and_training_routes():
    node = shutil.which('node') or r'C:\Program Files\nodejs\node.exe'
    result = subprocess.run([node, str(ROOT / 'tests/training_navigation_sound.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    assert result.returncode == 0, result.stderr + result.stdout


def test_download_accepts_valid_zstandard_with_skippable_metadata_frame(tmp_path):
    archive = tmp_path / 'bank.csv.zst'
    header = b'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags,DailyDate\n'
    # Real public Lichess archives can begin with Zstandard skippable frames.
    archive.write_bytes(bytes.fromhex('502a4d18') + (4).to_bytes(4, 'little') + b'meta' + zstandard.ZstdCompressor().compress(header))
    validate_archive(archive)


def test_download_rejects_compressed_unrelated_content(tmp_path):
    archive = tmp_path / 'bank.csv.zst'
    archive.write_bytes(zstandard.ZstdCompressor().compress(b'<html>Proxy error</html>'))
    with pytest.raises(IOError, match='not a Lichess puzzle archive'):
        validate_archive(archive)
