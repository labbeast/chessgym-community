"""Archive extraction has no application/database dependencies."""
import hashlib
import io
import json
from pathlib import Path
import struct

import pytest
import zstandard as zstd

from scripts import filter_lichess_archive as scan


def game(number=1, white='1600', black='1600', clock='600+0', body=None, newline='\n'):
    tags = [('Event', 'Rated game'), ('Site', f'https://lichess.org/{number}'),
            ('Result', '1-0'), ('WhiteElo', white), ('BlackElo', black), ('TimeControl', clock)]
    headers = newline.join(f'[{key} "{value}"]' for key, value in tags if value is not None)
    return (headers + newline * 2 + (body or '1. e4 {[%clk 0:10:00]} e5 2. Nf3 1-0')
            + newline * 2).encode('utf-8')


def source(tmp_path, content, *, suffix='.pgn.zst'):
    path = tmp_path / ('source' + suffix)
    path.write_bytes(zstd.ZstdCompressor(write_checksum=True).compress(content)
                     if suffix.endswith('.zst') else content)
    return path


def unpack(path):
    with open(path, 'rb') as raw, zstd.ZstdDecompressor().stream_reader(raw) as reader:
        return reader.read()


@pytest.mark.parametrize('workers', [1, 2])
def test_filter_preserves_exact_bytes_counts_and_hash(tmp_path, workers):
    selected = [game(1), game(2, clock='1500', newline='\r\n')]
    content = selected[0] + game(3, white='1599') + selected[1] + game(4, clock='300') + game(5, black='?')
    path = source(tmp_path, content)
    output, report = tmp_path / 'chosen.pgn.zst', tmp_path / 'report.json'
    result = scan.scan_archive(path, output=output, report=report, expected_games=5, workers=workers,
                               expected_sha256=hashlib.sha256(path.read_bytes()).hexdigest())
    assert result['status'] == 'completed', result
    assert result['integrity_verified'] and result['input_eof']
    assert result['total_games'] == 5 and result['qualified_games'] == 2
    assert result['missing_ratings'] == result['below_min_rating'] == 1
    assert result['by_speed']['rapid'] == 3
    assert result['qualified_by_speed']['rapid'] == result['qualified_by_speed']['classical'] == 1
    assert unpack(output) == b''.join(selected)
    assert json.loads(report.read_text('utf-8'))['status'] == 'completed'
    assert path.read_bytes() == zstd.ZstdCompressor(write_checksum=True).compress(content)
    assert not list(tmp_path.glob('*.partial-*'))


@pytest.mark.parametrize(('clock', 'speed'), [
    (b'29', 'ultraBullet'), (b'30', 'bullet'), (b'179', 'bullet'),
    (b'180', 'blitz'), (b'479', 'blitz'), (b'480', 'rapid'),
    (b'300+5', 'rapid'), (b'1499', 'rapid'), (b'1500', 'classical'),
    (b'21599', 'classical'), (b'21600', 'correspondence'),
    (b'-', 'correspondence'), (None, 'correspondence'), (b'?', 'unknown'),
    (b'600+abc', 'unknown'),
])
def test_speed_boundaries(clock, speed):
    assert scan.speed_of(clock) == speed


@pytest.mark.parametrize('workers', [1, 2])
def test_embedded_event_comments_and_small_chunks(tmp_path, monkeypatch, workers):
    monkeypatch.setattr(scan, 'COMPRESSED_CHUNK', 7)
    first = game(body='1. e4 {Comment\n\n[Event "Fake game"]\n\nNo chess here\n} e5 ; {ignored\n2. Nf3 1-0')
    content = b'\xef\xbb\xbf' + first + game(2)
    path = source(tmp_path, content)
    output = tmp_path / 'selected.pgn.zst'
    result = scan.scan_archive(path, output=output, workers=workers)
    assert result['status'] == 'completed', result
    assert result['total_games'] == 2
    assert unpack(output) == content


@pytest.mark.parametrize('workers', [1, 2])
def test_concatenated_normal_and_skippable_frames(tmp_path, monkeypatch, workers):
    monkeypatch.setattr(scan, 'COMPRESSED_CHUNK', 11)
    skip = struct.pack('<II', 0x184D2A50, 4) + b'test'
    content = game(1) + game(2)
    compressed = skip + zstd.ZstdCompressor(write_checksum=True).compress(game(1))
    compressed += skip + zstd.ZstdCompressor(write_checksum=True).compress(game(2)) + skip
    path = tmp_path / 'source.pgn.zst'
    path.write_bytes(compressed)
    output = tmp_path / 'selected.pgn.zst'
    result = scan.scan_archive(path, output=output, workers=workers)
    assert result['status'] == 'completed', result
    assert result['zstd_frames'] == 5 and result['total_games'] == 2
    assert unpack(output) == content


@pytest.mark.parametrize('damage', ['truncated', 'checksum', 'trailing', 'skip_truncated'])
@pytest.mark.parametrize('workers', [1, 2])
def test_incomplete_or_corrupt_compression_never_publishes(tmp_path, damage, workers):
    path = source(tmp_path, game())
    data = path.read_bytes()
    if damage == 'truncated':
        data = data[:-1]
    elif damage == 'checksum':
        data = data[:-1] + bytes([data[-1] ^ 1])
    elif damage == 'trailing':
        data += b'not a frame'
    else:
        data += struct.pack('<II', 0x184D2A50, 10) + b'abc'
    path.write_bytes(data)
    output = tmp_path / 'selected.pgn.zst'
    result = scan.scan_archive(path, output=output, workers=workers)
    assert result['status'] == 'failed', result
    assert not output.exists() and not result['integrity_verified']


@pytest.mark.parametrize('body', ['1. e4', '1. e4 {unfinished 1-0', '1. e4 0-1'])
@pytest.mark.parametrize('workers', [1, 2])
def test_complete_compression_but_incomplete_pgn_fails(tmp_path, body, workers):
    result = scan.scan_archive(source(tmp_path, game(body=body)), workers=workers)
    assert result['status'] == 'failed', result


@pytest.mark.parametrize('expected', [{'expected_games': 2}, {'expected_sha256': '0' * 64}])
def test_official_expectations_required_before_publication(tmp_path, expected):
    path = source(tmp_path, game())
    output = tmp_path / 'selected.pgn.zst'
    result = scan.scan_archive(path, output=output, **expected)
    assert result['status'] == 'failed' and not output.exists()


@pytest.mark.parametrize('workers', [1, 2])
def test_limit_is_not_completion_and_never_publishes(tmp_path, workers):
    path = source(tmp_path, game(1) + game(2))
    output = tmp_path / 'selected.pgn.zst'
    result = scan.scan_archive(path, output=output, max_games=1, workers=workers)
    assert result['status'] == 'limited' and result['total_games'] == 1
    assert not result['integrity_verified'] and not output.exists()
    assert unpack(Path(result['temporary_output'])) == game(1)


def test_cancelled_scan_never_publishes(tmp_path):
    path = source(tmp_path, game())
    output = tmp_path / 'selected.pgn.zst'
    result = scan.scan_archive(path, output=output, cancelled=lambda: True)
    assert result['status'] == 'cancelled' and not output.exists()


def test_source_fingerprint_change_rejected(tmp_path):
    path = source(tmp_path, game())
    output = tmp_path / 'selected.pgn.zst'
    def mutate(state):
        if state['status'] == 'running':
            import os
            info = path.stat()
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns + 1000000))
    result = scan.scan_archive(path, output=output, progress=mutate)
    assert result['status'] == 'failed' and not output.exists()
    assert 'changé' in result['error']


def test_never_overwrite_output_report_or_source(tmp_path):
    path = source(tmp_path, game())
    output = tmp_path / 'selected.pgn.zst'
    output.write_bytes(b'keep')
    with pytest.raises(FileExistsError):
        scan.scan_archive(path, output=output)
    with pytest.raises(FileExistsError):
        scan.scan_archive(path, report=output)
    with pytest.raises(FileExistsError):
        scan.scan_archive(path, output=path)
    assert output.read_bytes() == b'keep'


def test_destination_created_during_scan_never_replaced(tmp_path):
    path = source(tmp_path, game())
    output = tmp_path / 'selected.pgn.zst'
    def create_existing(state):
        if state['status'] == 'running':
            output.write_bytes(b'other job')
    result = scan.scan_archive(path, output=output, progress=create_existing)
    assert result['status'] == 'failed' and output.read_bytes() == b'other job'


def test_missing_either_rating_excluded_even_with_low_threshold(tmp_path):
    path = source(tmp_path, game(1, white=None) + game(2, black=None) + game(3, white='?', black='?'))
    result = scan.scan_archive(path, min_rating=0)
    assert result['status'] == 'completed' and result['qualified_games'] == 0
    assert result['missing_ratings'] == 3
