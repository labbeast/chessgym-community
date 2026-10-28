import hashlib
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest
import zstandard

from scripts import filter_lichess_archive as scanner
from scripts import filter_lichess_parallel as parallel


def game(number):
    return (f'[Event "game{number}"]\n[Result "1-0"]\n[WhiteElo "1600"]\n'
            '[BlackElo "1700"]\n[TimeControl "600"]\n\n1. e4 {clock} e5 1-0\n\n').encode()


def source(tmp_path, count=5):
    path = tmp_path / 'source.pgn.zst'
    content = b''.join(game(number) for number in range(count))
    path.write_bytes(zstandard.ZstdCompressor(write_checksum=True).compress(content))
    return path, content


def delayed_first(records, min_rating, speeds):
    if b'[Event "game0"]' in records[0]:
        time.sleep(.3)
    return parallel.prepare_batch(records, min_rating, speeds)


def sleeping_batch(records, min_rating, speeds):
    time.sleep(10)
    return parallel.prepare_batch(records, min_rating, speeds)


def crashing_batch(records, min_rating, speeds):
    os._exit(42)


def test_out_of_order_workers_keep_exact_source_order(tmp_path, monkeypatch):
    path, content = source(tmp_path, 6)
    output = tmp_path / 'result.pgn.zst'
    monkeypatch.setattr(parallel, 'BATCH_GAMES', 1)
    monkeypatch.setattr(parallel, 'prepare_batch', delayed_first)
    result = scanner.scan_archive(path, output=output, workers=2)
    assert result['status'] == 'completed', result
    with open(output, 'rb') as raw, zstandard.ZstdDecompressor().stream_reader(raw) as reader:
        assert reader.read() == content


def test_cancel_while_waiting_terminates_pending_workers(tmp_path, monkeypatch):
    path, _ = source(tmp_path)
    output = tmp_path / 'result.pgn.zst'
    monkeypatch.setattr(parallel, 'prepare_batch', sleeping_batch)
    started = time.monotonic()
    result = scanner.scan_archive(path, output=output, workers=2,
        cancelled=lambda: time.monotonic() - started > .7)
    assert result['status'] == 'cancelled', result
    assert result['total_games'] == 0 and not output.exists()
    assert time.monotonic() - started < 5


def test_crashed_worker_fails_without_hanging_or_publication(tmp_path, monkeypatch):
    path, _ = source(tmp_path)
    output = tmp_path / 'result.pgn.zst'
    monkeypatch.setattr(parallel, 'prepare_batch', crashing_batch)
    started = time.monotonic()
    result = scanner.scan_archive(path, output=output, workers=2)
    assert result['status'] == 'failed', result
    assert 'interrompu' in result['error'] and not output.exists()
    assert time.monotonic() - started < 10


def test_script_cli_parallel_and_cancel_status(tmp_path):
    path, _ = source(tmp_path)
    marker = tmp_path / 'cancel'
    marker.write_text('cancel')
    result = subprocess.run([sys.executable, 'scripts/filter_lichess_archive.py', str(path),
                             '--workers', '2', '--cancel-file', str(marker)],
                            cwd=Path(__file__).resolve().parents[1], capture_output=True, timeout=10,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    assert result.returncode == 130, result.stdout.decode()
    assert b'"status": "cancelled"' in result.stdout


@pytest.mark.parametrize('value', [0, 17, True, '2'])
def test_invalid_workers_rejected_before_output(tmp_path, value):
    path, _ = source(tmp_path)
    with pytest.raises(ValueError):
        scanner.scan_archive(path, workers=value)
