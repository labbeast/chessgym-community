"""Resource installation tests use tiny archives and isolated databases only."""
import csv
import hashlib
import io
import json
from pathlib import Path
import sqlite3

import chess
import pytest
import zstandard
from fastapi import HTTPException

import db
import puzzle_store
import reference_library
import reference_store
import resource_downloads as resources


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DATA_DIR', tmp_path)
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'personal.sqlite3')
    monkeypatch.setenv('CHESSGYM_PUZZLE_BANK', str(tmp_path / 'puzzles' / 'bank.sqlite3'))
    monkeypatch.setattr(resources, '_free_space', lambda *args: None)
    db.init_db()
    return resources.LichessResources(tmp_path)


class Response(io.BytesIO):
    def __init__(self, content, *, size=None, etag='"v1"'):
        super().__init__(content)
        self.headers = {'Content-Length': str(len(content) if size is None else size), 'ETag': etag}


def fake_download(monkeypatch, content, *, month='2026-09', size=None, etag='"v1"'):
    url = resources.ORIGIN + f'broadcast/lichess_db_broadcast_{month}.pgn.zst'
    digest = hashlib.sha256(content).hexdigest()
    def open_response(request_url, *, method='GET'):
        if request_url == resources.BROADCAST_LIST:
            return Response((url + '\nhttps://evil.example/broadcast/lichess_db_broadcast_2099-01.pgn.zst').encode())
        if request_url == resources.BROADCAST_HASHES:
            return Response((digest + '  ' + url.rsplit('/', 1)[-1]).encode())
        assert request_url in (url, resources.PUZZLES_URL)
        return Response(b'' if method == 'HEAD' else content, size=len(content) if size is None else size, etag=etag)
    monkeypatch.setattr(resources, '_open', open_response)
    return url


def puzzle_archive(rows):
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(['PuzzleId','FEN','Moves','Rating','RatingDeviation','Popularity','NbPlays','Themes','GameUrl','OpeningTags'])
    for identity, rating, theme in rows:
        writer.writerow([identity, chess.STARTING_FEN, 'e2e4 e7e5', rating, 50, 80, 20, theme, 'https://lichess.org/abcdefgh#1', 'Italian_Game'])
    return zstandard.ZstdCompressor().compress(output.getvalue().encode())


def games_archive():
    text = '[Event "Test tournament"]\n[White "Alpha"]\n[Black "Beta"]\n[Result "1-0"]\n\n1. e4 e5 2. Nf3 Nc6 1-0\n'
    return zstandard.ZstdCompressor().compress(text.encode())


def test_official_url_only():
    for url in ('http://database.lichess.org/file', 'https://database.lichess.org.evil.test/file',
                'https://user@database.lichess.org/file', 'https://database.lichess.org:123/file'):
        with pytest.raises(ValueError):
            resources._safe_url(url)
    assert resources._safe_url(resources.PUZZLES_URL) == resources.PUZZLES_URL


def test_latest_published_month_and_checksum(isolated, monkeypatch):
    fake_download(monkeypatch, games_archive())
    spec = isolated.check('lichess-games')
    assert spec['month'] == '2026-09'
    assert spec['sha256'] == hashlib.sha256(games_archive()).hexdigest()
    assert spec['update_available']


def test_games_are_complete_before_publication_and_repeated_install_is_noop(isolated, monkeypatch):
    fake_download(monkeypatch, games_archive())
    result = isolated.install('lichess-games')
    row = reference_library.require_reference(result['base_id'])
    state = reference_store.status(reference_library.store_path(row['storage_key']))
    assert state['status'] == 'completed'
    assert state['game_count'] == 1
    assert isolated.check('lichess-games')['update_available'] is False
    assert isolated.install('lichess-games')['base_id'] == result['base_id']
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 1


def test_new_month_preserves_previous_reference_base(isolated, monkeypatch):
    fake_download(monkeypatch, games_archive(), month='2026-08')
    old = isolated.install('lichess-games')
    fake_download(monkeypatch, games_archive(), month='2026-09')
    new = isolated.install('lichess-games')
    assert old['base_id'] != new['base_id']
    assert reference_library.get_status(old['base_id'])['game_count'] == 1


def test_failed_same_month_revision_keeps_previous_source(isolated, monkeypatch):
    fake_download(monkeypatch, games_archive())
    old = isolated.install('lichess-games')
    old_row = reference_library.require_reference(old['base_id'])
    original = Path(old_row['source']).read_bytes()
    revised = zstandard.ZstdCompressor().compress(b'[Invalid PGN content]\n')
    fake_download(monkeypatch, revised, etag='"v2"')
    with pytest.raises(ValueError):
        isolated.install('lichess-games')
    assert reference_library.require_reference(old['base_id'])['source'] == old_row['source']
    assert Path(old_row['source']).read_bytes() == original


def test_same_month_revision_preserves_old_base_game_ids_and_source(isolated, monkeypatch):
    fake_download(monkeypatch, games_archive())
    old = isolated.install('lichess-games')
    old_row = reference_library.require_reference(old['base_id'])
    original = Path(old_row['source']).read_bytes()
    revised = zstandard.ZstdCompressor().compress(zstandard.ZstdDecompressor().decompress(original).replace(b'Test tournament', b'Revised tournament'))
    fake_download(monkeypatch, revised, etag='"v2"')
    new = isolated.install('lichess-games')
    assert new['base_id'] != old['base_id']
    assert reference_library.require_reference(old['base_id'])['storage_key'] == old_row['storage_key']
    assert Path(old_row['source']).read_bytes() == original
    assert reference_library.get_status(old['base_id'])['game_count'] == 1
    assert reference_library.get_status(new['base_id'])['game_count'] == 1


def test_managed_import_gate_rejects_manual_import_without_holding_lock(isolated):
    source = isolated.data_root / 'manual.pgn'
    source.write_text('[Event "Manual"]\n\n1. e4 *\n', encoding='utf-8')
    with reference_library.managed_import():
        assert reference_library.import_active()
        with pytest.raises(HTTPException) as error:
            reference_library.create_reference({'name': 'Manual', 'path': str(source)})
        assert error.value.status_code == 409
    assert not reference_library.import_active()


def test_failed_download_does_not_publish_bank_or_version(isolated, monkeypatch):
    data = puzzle_archive([('new', 1200, 'fork')])
    fake_download(monkeypatch, data, size=len(data) + 5)
    with pytest.raises(ValueError, match='incomplète'):
        isolated.install('lichess-puzzles')
    assert not puzzle_store.bank_path().exists()
    assert not (isolated.root / 'installed.json').exists()
    assert not list(isolated.root.glob('.staging-*'))


def test_puzzle_update_refreshes_metadata_preserves_removed_ids_and_history(isolated, monkeypatch):
    fake_download(monkeypatch, puzzle_archive([('old', 800, 'fork'), ('retired', 900, 'pin')]))
    first = isolated.install('lichess-puzzles')
    assert first['count'] == 2
    with db.get_conn() as conn:
        conn.execute('CREATE TABLE fixture_history(puzzle_id TEXT, solved INTEGER)')
        conn.execute("INSERT INTO fixture_history VALUES('old', 1)")
    fake_download(monkeypatch, puzzle_archive([('old', 1400, 'mate'), ('new', 1000, 'fork')]), etag='"v2"')
    second = isolated.install('lichess-puzzles')
    assert second['count'] == 3
    assert puzzle_store.get_puzzle('old')['rating'] == 1400
    assert puzzle_store.get_puzzle('old')['themes'] == ['mate']
    assert puzzle_store.get_puzzle('retired') is not None
    with db.get_conn() as conn:
        assert tuple(conn.execute('SELECT * FROM fixture_history').fetchone()) == ('old', 1)
    with puzzle_store.bank_connection() as conn:
        assert conn.execute("SELECT COUNT(*) FROM puzzle_search WHERE puzzle_search MATCH 'themes : mate'").fetchone()[0] == 1


def test_cancel_before_puzzle_commit_rolls_back(isolated, monkeypatch):
    fake_download(monkeypatch, puzzle_archive([('old', 800, 'fork')]))
    isolated.install('lichess-puzzles')
    fake_download(monkeypatch, puzzle_archive([('old', 1400, 'mate'), ('new', 1000, 'fork')]), etag='"v2"')
    def cancel(stage, percent):
        if stage == 'Finalisation de la banque de puzzles':
            raise InterruptedError('Stopped')
    with pytest.raises(InterruptedError):
        isolated.install('lichess-puzzles', cancel)
    assert puzzle_store.get_puzzle('old')['rating'] == 800
    assert puzzle_store.get_puzzle('new') is None
    assert isolated.check('lichess-puzzles')['update_available']


def test_download_hash_mismatch_never_publishes(isolated, monkeypatch):
    fake_download(monkeypatch, games_archive())
    original = resources._text
    monkeypatch.setattr(resources, '_text', lambda url: ('0' * 64 + '  lichess_db_broadcast_2026-09.pgn.zst')
                        if url == resources.BROADCAST_HASHES else original(url))
    with pytest.raises(ValueError, match='SHA-256'):
        isolated.install('lichess-games')
    with db.get_conn() as conn:
        assert conn.execute('SELECT COUNT(*) FROM bases').fetchone()[0] == 0


def test_insufficient_space_prevents_download(isolated, monkeypatch):
    fake_download(monkeypatch, games_archive())
    monkeypatch.setattr(resources, '_free_space', lambda *args: (_ for _ in ()).throw(ValueError('Espace disque insuffisant')))
    with pytest.raises(ValueError, match='Espace disque'):
        isolated.install('lichess-games')
    assert not (isolated.root / 'installed.json').exists()
