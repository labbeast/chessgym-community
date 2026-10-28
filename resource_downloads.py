"""Verified, staged downloads of the public Lichess training resources.

Puzzle history belongs to the personal database and is never changed here.
Tournament archives are individual reference bases, one per published month.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request

import zstandard

import db
import puzzle_store
import reference_library
import reference_store
import resource_policy

ORIGIN = 'https://database.lichess.org/'
PUZZLES_URL = ORIGIN + 'lichess_db_puzzle.csv.zst'
BROADCAST_LIST = ORIGIN + 'broadcast/list.txt'
BROADCAST_HASHES = ORIGIN + 'broadcast/sha256sums.txt'
MAX_TEXT = 256 * 1024
GIB = 1024 ** 3
LIMITS = {'lichess-puzzles': (GIB, 24 * GIB), 'lichess-games': (256 * 1024 ** 2, 8 * GIB)}
_MONTH_URL = re.compile(r'https://database\.lichess\.org/broadcast/lichess_db_broadcast_(20\d\d-(?:0[1-9]|1[0-2]))\.pgn\.zst')


def _safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname != 'database.lichess.org'
            or parsed.username or parsed.password or parsed.port not in (None, 443)
            or parsed.query or parsed.fragment):
        raise ValueError('Adresse de téléchargement Lichess non reconnue.')
    return url


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        _safe_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def _open(url, *, method='GET'):
    request = urllib.request.Request(_safe_url(url), method=method,
                                     headers={'User-Agent': 'ChessGym-Resources/1.0'})
    return urllib.request.build_opener(_OfficialRedirect()).open(request, timeout=45)


def _text(url):
    with _open(url) as response:
        value = response.read(MAX_TEXT + 1)
    if len(value) > MAX_TEXT:
        raise ValueError('Le catalogue Lichess dépasse la taille autorisée.')
    return value.decode('utf-8')


def _metadata(url, limit):
    with _open(url, method='HEAD') as response:
        headers = response.headers
        try:
            size = int(headers.get('Content-Length', '0'))
        except ValueError:
            size = 0
        if not 0 < size <= limit:
            raise ValueError('La taille du téléchargement Lichess est absente ou dépasse la limite prévue.')
        etag = str(headers.get('ETag', ''))[:250]
        modified = str(headers.get('Last-Modified', ''))[:250]
        if not etag and not modified:
            raise ValueError('Lichess ne fournit pas de date ni de version pour cette archive.')
        return {'download_bytes': size, 'etag': etag, 'last_modified': modified}


def _free_space(path, required):
    path = Path(path)
    while not path.exists():
        path = path.parent
    if shutil.disk_usage(path).free < required:
        raise ValueError(f'Espace disque insuffisant : prévoir au moins {required / GIB:.1f} Gio libres pour cet import.')


def _download(spec, target, progress):
    digest, count, started = hashlib.sha256(), 0, time.monotonic()
    with _open(spec['source_url']) as response, target.open('xb') as output:
        # A changed archive between HEAD and GET must be checked again.
        for key, header in (('etag', 'ETag'), ('last_modified', 'Last-Modified')):
            actual = response.headers.get(header)
            if spec.get(key) and actual and spec[key] != actual:
                raise ValueError('L’archive Lichess a changé. Relance la vérification des mises à jour.')
        for chunk in iter(lambda: response.read(1024 * 1024), b''):
            count += len(chunk)
            if count > spec['download_bytes'] or time.monotonic() - started > 3600:
                raise ValueError('Le téléchargement dépasse la taille ou la durée autorisée.')
            _free_space(target.parent, 256 * 1024 ** 2)
            output.write(chunk)
            digest.update(chunk)
            progress('Téléchargement de l’archive Lichess', 5 + 35 * count / spec['download_bytes'])
    actual_hash = digest.hexdigest()
    if count != spec['download_bytes'] or (spec.get('sha256') and actual_hash != spec['sha256']):
        raise ValueError('L’archive Lichess est incomplète ou son empreinte SHA-256 est incorrecte.')
    return actual_hash


def _validate_archive(path, resource_id, progress):
    count, first = 0, True
    with path.open('rb') as source, zstandard.ZstdDecompressor().stream_reader(source) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            if first:
                first = False
                prefix = chunk.lstrip(b'\xef\xbb\xbf\r\n \t')
                valid = (prefix.startswith(b'PuzzleId,FEN,Moves,Rating,') if resource_id == 'lichess-puzzles'
                         else prefix.startswith(b'['))
                if not valid:
                    raise ValueError('Le contenu téléchargé ne correspond pas à la base Lichess attendue.')
            count += len(chunk)
            if count > LIMITS[resource_id][1]:
                raise ValueError('Le contenu décompressé dépasse la taille autorisée.')
            progress('Vérification de l’archive Lichess', 42)
    if first:
        raise ValueError('L’archive Lichess est vide.')


def _integrity(path):
    with closing(sqlite3.connect(path)) as conn:
        if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('La base importée n’a pas passé la vérification d’intégrité.')
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')


def _stage_puzzles(source, target, progress):
    """The existing parser runs in an isolated process with its own bank path."""
    environment = dict(os.environ, CHESSGYM_PUZZLE_BANK=str(target), PYTHONIOENCODING='utf-8')
    command = [sys.executable, '-X', 'utf8', '-u', str(Path(__file__).parent / 'scripts' / 'import_puzzle_bank.py'),
               str(source), '--cache-mb', '128']
    with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          stdin=subprocess.DEVNULL, text=True, encoding='utf-8', env=environment,
                          cwd=Path(__file__).parent,
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0) as process:
        tail, messages, stopping = [], queue.Queue(maxsize=64), threading.Event()
        def enqueue(value):
            while not stopping.is_set():
                try:
                    messages.put(value, timeout=1)
                    return
                except queue.Full:
                    pass
        def read_output():
            try:
                for line in iter(lambda: process.stdout.readline(2048), ''):
                    if stopping.is_set():
                        break
                    enqueue(line)
            finally:
                enqueue(None)
        reader = threading.Thread(target=read_output, name='chessgym-puzzle-output', daemon=True)
        reader.start()
        started, processed = time.monotonic(), 0
        try:
            while True:
                progress(f'Préparation de la banque : {processed:,} puzzles', 55)
                if time.monotonic() - started > 12 * 3600:
                    raise TimeoutError('L’import des puzzles a dépassé le délai de douze heures.')
                try:
                    line = messages.get(timeout=1)
                except queue.Empty:
                    continue
                if line is None:
                    break
                tail.append(line.rstrip()[:1000])
                tail = tail[-5:]
                _free_space(target.parent, 512 * 1024 ** 2)
                try:
                    value = json.loads(line)
                except ValueError:
                    continue
                processed = value.get('processed', 0)
            if process.wait(timeout=30) != 0:
                raise ValueError('L’import de la banque Lichess a échoué : ' + ' '.join(tail)[-500:])
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            raise
        finally:
            stopping.set()
            reader.join(timeout=2)
    _integrity(target)


def _publish_puzzles(staged, progress):
    """Refresh puzzle data atomically, retaining IDs no longer in the export."""
    with closing(sqlite3.connect(staged)) as source:
        count = source.execute('SELECT COUNT(*) FROM puzzles').fetchone()[0]
        meta = dict(source.execute('SELECT key,value FROM bank_meta'))
    if not count or json.loads(meta.get('status', 'null')) != 'ready':
        raise ValueError('La nouvelle banque de puzzles ne contient aucun puzzle valide.')
    target = puzzle_store.bank_path()
    _free_space(target.parent, staged.stat().st_size * 3 + 512 * 1024 ** 2)
    progress('Actualisation de la banque de puzzles', 90)
    with puzzle_store.bank_connection(True) as conn:
        puzzle_store.init_bank(conn)
        conn.commit()
        conn.execute('ATTACH DATABASE ? AS incoming', (str(staged),))
        conn.execute('BEGIN IMMEDIATE')
        try:
            # Content and solutions of existing IDs remain stable for an active
            # exercise. Ratings and descriptive metadata can safely be refreshed.
            conn.execute('''INSERT INTO puzzles SELECT * FROM incoming.puzzles WHERE true
                ON CONFLICT(id) DO UPDATE SET rating=excluded.rating,
                rating_deviation=excluded.rating_deviation, popularity=excluded.popularity,
                nb_plays=excluded.nb_plays, themes=excluded.themes, opening_tags=excluded.opening_tags''')
            conn.execute("INSERT INTO puzzle_search(puzzle_search) VALUES('rebuild')")
            meta['count'] = json.dumps(conn.execute('SELECT COUNT(*) FROM puzzles').fetchone()[0])
            conn.executemany('INSERT OR REPLACE INTO bank_meta(key,value) VALUES(?,?)', list(meta.items()))
            progress('Finalisation de la banque de puzzles', 97)
            conn.commit()
        except BaseException:
            conn.rollback()
            raise
    return {'count': json.loads(meta['count'])}


class LichessResources:
    def __init__(self, data_root):
        self.data_root = Path(data_root).resolve()
        self.root = self.data_root / 'resources' / 'lichess'
        self._checked = {}

    def _records(self):
        try:
            path = self.root / 'installed.json'
            if path.stat().st_size <= MAX_TEXT:
                value = json.loads(path.read_text(encoding='utf-8'))
                if isinstance(value, dict):
                    return {key: record for key, record in value.items()
                            if key in LIMITS and isinstance(record, dict)}
        except (OSError, ValueError):
            pass
        return {}

    def _installed(self, resource_id, record):
        if resource_id == 'lichess-puzzles':
            try:
                return puzzle_store.bank_stats().get('count', 0) > 0
            except (sqlite3.Error, OSError):
                return False
        if not isinstance(record, dict):
            return False
        with db.get_conn() as conn:
            row = conn.execute('SELECT storage_key FROM reference_bases WHERE base_id=?',
                               (record.get('base_id'),)).fetchone()
        return bool(row and reference_library.store_path(row['storage_key']).is_file())

    def catalog(self):
        records = self._records()
        result = []
        for identity, name, description, license_name in (
            ('lichess-puzzles', 'Puzzles Lichess', 'Banque complète de puzzles. Prévoir plusieurs Gio et du temps pour l’indexation.', 'CC0'),
            ('lichess-games', 'Parties de tournois Lichess', 'Dernier mois publié des tournois diffusés sur Lichess, ajouté comme base de référence. Chaque nouveau mois conserve les précédents.', 'CC-BY-SA-4.0')):
            record = records.get(identity, {})
            result.append({'id': identity, 'name': name, 'description': description,
                           'license': license_name, 'source_url': ORIGIN + ('#puzzles' if identity == 'lichess-puzzles' else '#broadcasts'),
                           'available': True, 'installed': self._installed(identity, record),
                           'version': record.get('version'),
                           'download_bytes': self._checked.get(identity, {}).get('download_bytes')})
        return result

    def check(self, resource_id):
        if resource_id not in LIMITS:
            raise ValueError('Ressource Lichess inconnue.')
        spec = {'id': resource_id, 'available': True}
        if resource_id == 'lichess-games':
            choices = [(match[1], match[0]) for line in _text(BROADCAST_LIST).splitlines()
                       if (match := _MONTH_URL.fullmatch(line.strip()))]
            if not choices:
                raise ValueError('Aucun mois de tournois Lichess publié n’a été trouvé.')
            month, url = max(choices)
            filename = url.rsplit('/', 1)[-1]
            hashes = dict((parts[1].lstrip('*'), parts[0]) for line in _text(BROADCAST_HASHES).splitlines()
                          if len(parts := line.split()) == 2 and re.fullmatch('[0-9a-f]{64}', parts[0]))
            if filename not in hashes:
                raise ValueError('L’empreinte officielle de cette archive Lichess est absente.')
            spec.update(source_url=url, month=month, sha256=hashes[filename])
        else:
            spec['source_url'] = PUZZLES_URL
        spec.update(_metadata(spec['source_url'], LIMITS[resource_id][0]))
        spec['version'] = (spec['month'] + ':' + spec['sha256'][:12] if resource_id == 'lichess-games'
                           else (spec['etag'] or spec['last_modified']) + ':' + str(spec['download_bytes']))
        record = self._records().get(resource_id, {})
        spec['installed'] = self._installed(resource_id, record)
        spec['update_available'] = not spec['installed'] or record.get('version') != spec['version']
        self._checked[resource_id] = spec
        return dict(spec)

    def _publish_games(self, staged, archive, spec, progress):
        import library_service
        # Reuse an already published copy only when its exact immutable source
        # is identical. Revised archives get new base IDs: changing storage for
        # an existing base could invalidate saved references to its game IDs.
        with db.get_conn() as conn:
            existing = conn.execute('SELECT base_id,storage_key FROM reference_bases WHERE source=?',
                                    (str(archive),)).fetchone()
        if existing:
            old_path = reference_library.store_path(existing['storage_key'])
            old_status = reference_store.status(old_path) if old_path.is_file() else {}
            if old_status.get('status') == 'completed' and old_status.get('game_count'):
                return {'base_id': existing['base_id'], 'archive_path': str(archive), 'count': old_status['game_count']}
        key = secrets.token_hex(16)
        target = reference_library.store_path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        _integrity(staged)
        progress('Ajout des parties de tournois à la bibliothèque', 96)
        staged.replace(target)
        try:
            with db.get_conn() as conn:
                conn.execute('BEGIN IMMEDIATE')
                previous = self._records().get('lichess-games', {})
                name = 'Lichess — tournois ' + spec['month']
                if previous.get('month') == spec['month']:
                    name += ' · révision ' + spec['sha256'][:8]
                base_id = conn.execute('INSERT INTO bases(name,tags,settings,created_at) VALUES(?,?,?,?)',
                    (name, json.dumps(['Lichess', 'CC-BY-SA-4.0']),
                     json.dumps(library_service.DEFAULT_SETTINGS), library_service.now())).lastrowid
                conn.execute("INSERT INTO reference_bases(base_id,storage_key,source,status) VALUES(?,?,?,'paused')",
                             (base_id, key, str(archive)))
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return {'base_id': base_id, 'archive_path': str(archive), 'count': reference_store.status(target)['game_count']}

    def install(self, resource_id, progress=lambda stage, percent: None):
        progress('Vérification de la publication Lichess', 1)
        spec = self.check(resource_id)
        if not spec['update_available']:
            progress('Cette base Lichess est déjà à jour', 100)
            return self._records().get(resource_id, {})
        self.root.mkdir(parents=True, exist_ok=True)
        multiplier = 48 if resource_id == 'lichess-puzzles' else 100
        _free_space(self.root, spec['download_bytes'] * multiplier + GIB)
        with tempfile.TemporaryDirectory(prefix='.staging-', dir=self.root) as temporary:
            stage = Path(temporary)
            downloaded = stage / Path(urllib.parse.urlsplit(spec['source_url']).path).name
            digest = _download(spec, downloaded, progress)
            _validate_archive(downloaded, resource_id, progress)
            staged = stage / 'bank.sqlite3'
            if resource_id == 'lichess-puzzles':
                _stage_puzzles(downloaded, staged, progress)
                details = _publish_puzzles(staged, progress)
            else:
                # Reserve the same gate as manual reference imports before any
                # parsing. No incomplete reference is exposed in the library.
                with reference_library.managed_import(), resource_policy.import_reservation(1):
                    # Existing bases keep their exact source even when a revised
                    # archive for the same month fails validation or import.
                    archive = self.root / (downloaded.name.removesuffix('.pgn.zst') + '-' + digest[:12] + '.pgn.zst')
                    existing_digest = None
                    if archive.exists():
                        with archive.open('rb') as stream:
                            existing_digest = hashlib.file_digest(stream, 'sha256').hexdigest()
                    if existing_digest != digest:
                        downloaded.replace(archive)
                    def report(value):
                        _free_space(stage, 512 * 1024 ** 2)
                        progress(f"Indexation : {value.get('game_count', 0):,} parties", 45 + 45 * value.get('bytes_read', 0) / max(1, value.get('total_bytes', 1)))
                    state = reference_store.import_file(staged, archive, progress=report, workers=1, cache_mib=64)
                    if state.get('status') != 'completed' or not state.get('game_count'):
                        raise ValueError(state.get('error') or 'L’import des parties Lichess n’est pas terminé.')
                    details = self._publish_games(staged, archive, spec, progress)
            record = {**spec, **details, 'sha256': digest, 'installed': True,
                      'update_available': False, 'installed_at': datetime.now(timezone.utc).isoformat()}
            records = self._records()
            records[resource_id] = record
            pending = self.root / 'installed.json.part'
            pending.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
            pending.replace(self.root / 'installed.json')
        progress('Base Lichess disponible', 100)
        return record
