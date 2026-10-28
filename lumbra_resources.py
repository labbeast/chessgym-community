"""Install locally downloaded Lumbra archives as immutable reference bases.

Lumbra requires its browser download and licence confirmation. This module does
not request download URLs or automate that flow. Only the owner-selected local
PGN/7z is read; archive members are streamed, never extracted to their paths.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time

from atomic_files import replace_with_retry
import db
import library_service
import reference_library
import reference_store
import reference_worker
import resource_policy

MIB = 1024 ** 2
GIB = 1024 ** 3
DOWNLOAD_PAGE = 'https://lumbrasgigabase.com/en/download-area-en/'
LICENSE_URL = 'https://creativecommons.org/licenses/by-nc/4.0/'
PUBLISHED_VERSION = '2026-10-20'
MAX_LISTING_BYTES = MIB
MAX_RECORD_BYTES = MIB
MAX_MEMBERS = 1000
SPECS = {
    'lumbra-otb-elite': {
        'name': 'Lumbra OTB Elite — maîtres 2400+',
        'description': 'Parties sur échiquier entre deux joueurs classés au moins 2400 Elo. Télécharge l’archive officielle, puis importe-la ici.',
        'download_url': 'https://lumbrasgigabase.com/lgb-file/11049/',
        'estimated_download_bytes': round(196.27 * MIB),
        'archive_limit': 2 * GIB, 'pgn_limit': 12 * GIB,
    },
    'lumbra-otb-complete': {
        'name': 'Lumbra Gigabase OTB — complète',
        'description': 'Collection complète des parties sur échiquier. L’import et l’indexation peuvent prendre plusieurs heures et beaucoup d’espace disque.',
        'download_url': 'https://lumbrasgigabase.com/lgb-file/11047/',
        'estimated_download_bytes': round(2.35 * GIB),
        'archive_limit': 8 * GIB, 'pgn_limit': 80 * GIB,
    },
}


def _spec(resource_id):
    if resource_id not in SPECS:
        raise ValueError('Base Lumbra inconnue.')
    return SPECS[resource_id]


def _free_space(path, required):
    parent = Path(path)
    while not parent.exists():
        parent = parent.parent
    if shutil.disk_usage(parent).free < required:
        raise ValueError(f'Espace disque insuffisant : prévoir au moins {required / GIB:.1f} Gio libres pour cet import.')


def _seven_zip():
    """Use an installed 7-Zip, without downloading or executing archive content."""
    candidates = []
    if os.name == 'nt':
        for variable in ('ProgramFiles', 'ProgramFiles(x86)'):
            if os.environ.get(variable):
                candidates.append(Path(os.environ[variable]) / '7-Zip' / '7z.exe')
    for command in ('7zz', '7z', '7za'):
        executable = shutil.which(command)
        if executable:
            candidates.append(Path(executable))
    return next((str(path.resolve()) for path in candidates if path.is_file()), None)


def _local_source(value, spec):
    if not isinstance(value, (str, Path)) or not str(value).strip() or len(str(value)) > 4096:
        raise ValueError('Télécharge la base sur le site officiel Lumbra, puis indique le chemin du fichier .7z ou .pgn sur ce serveur.')
    source = Path(str(value).strip()).expanduser()
    if not source.is_absolute() or source.is_symlink() or not source.is_file():
        raise ValueError('Choisis un fichier local existant, avec son chemin complet, et non un lien symbolique.')
    suffix = source.suffix.lower()
    if suffix not in ('.7z', '.pgn'):
        raise ValueError('La base Lumbra doit être un fichier .7z ou .pgn.')
    limit = spec['archive_limit'] if suffix == '.7z' else spec['pgn_limit']
    if not 0 < source.stat().st_size <= limit:
        raise ValueError('Le fichier Lumbra est vide ou dépasse la taille autorisée.')
    return source.resolve(), suffix, limit


def _copy_source(source, target, limit, progress):
    before = source.stat()
    digest, count, reported = hashlib.sha256(), 0, 0
    with source.open('rb') as incoming, target.open('xb') as output:
        for block in iter(lambda: incoming.read(MIB), b''):
            count += len(block)
            if count > limit or count > before.st_size:
                raise ValueError('Le fichier Lumbra a changé ou dépasse la taille autorisée.')
            _free_space(target.parent, 512 * MIB)
            output.write(block)
            digest.update(block)
            if time.monotonic() - reported >= .5 or count == before.st_size:
                progress('Vérification et copie de l’archive Lumbra', 2 + 10 * count / before.st_size)
                reported = time.monotonic()
    after = source.stat()
    if count != before.st_size or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError('Le fichier Lumbra a changé pendant la copie. Attends la fin du téléchargement puis réessaie.')
    return digest.hexdigest()


def _digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def _save_immutable(staged, target, digest):
    if target.exists():
        if not target.is_file() or _digest(target) != digest:
            raise ValueError('Une source Lumbra conservée a été modifiée. Elle n’a pas été remplacée.')
    else:
        replace_with_retry(staged, target)


def _command_output(command, output, *, maximum, timeout, progress, stage):
    """Bound output, cancellation latency and time for 7-Zip's stdout stream."""
    messages, stopping = queue.Queue(maxsize=8), threading.Event()
    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    def reader():
        try:
            while not stopping.is_set():
                block = process.stdout.read(64 * 1024)
                while not stopping.is_set():
                    try:
                        messages.put(block, timeout=.2)
                        break
                    except queue.Full:
                        continue
                if not block:
                    break
        except (OSError, ValueError):
            pass

    thread = threading.Thread(target=reader, name='ChessGym-Lumbra-extract', daemon=True)
    thread.start()
    started, count, reported = time.monotonic(), 0, 0
    try:
        while True:
            if time.monotonic() - reported >= .5:
                progress(stage, 15 if maximum == MAX_LISTING_BYTES else 16 + 18 * count / max(1, maximum))
                reported = time.monotonic()
            if time.monotonic() - started > timeout:
                raise ValueError('La lecture de l’archive Lumbra a dépassé le délai autorisé.')
            try:
                block = messages.get(timeout=.25)
            except queue.Empty:
                if not thread.is_alive():
                    raise ValueError('La lecture de l’archive Lumbra a été interrompue.')
                continue
            if not block:
                break
            count += len(block)
            if count > maximum:
                raise ValueError('Le contenu de l’archive Lumbra dépasse la taille autorisée.')
            output.write(block)
        if process.wait(timeout=5) != 0:
            raise ValueError('L’archive Lumbra est endommagée, protégée par mot de passe ou illisible par 7-Zip.')
    finally:
        stopping.set()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        process.stdout.close()
        thread.join(timeout=2)
    return count


def _safe_member_name(name):
    # Also reject Windows drive names, device names, alternate data streams and
    # wildcard syntax. Names are passed as one argument with wildcard matching off.
    if not isinstance(name, str) or not name or len(name) > 1024 or re.search(r'[\x00-\x1f\x7f:*?"<>|]', name):
        raise ValueError('L’archive Lumbra contient un nom de fichier non pris en charge.')
    normalized = name.replace('\\', '/')
    path = PurePosixPath(normalized)
    parts = normalized.split('/')
    if path.is_absolute() or any(part in ('', '.', '..') or part.endswith((' ', '.')) for part in parts):
        raise ValueError('L’archive Lumbra contient un chemin de fichier non sûr.')
    if any(re.fullmatch(r'(?i)(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?', part) for part in parts):
        raise ValueError('L’archive Lumbra contient un nom de fichier réservé.')
    return name


def _pgn_member(listing, limit):
    """Require one regular, unencrypted PGN and reject special archive entries."""
    entries, current = [], {}
    for line in listing.splitlines() + ['']:
        if not line.strip():
            if current:
                entries.append(current)
                current = {}
                if len(entries) > MAX_MEMBERS:
                    raise ValueError('L’archive Lumbra contient trop de fichiers.')
            continue
        key, separator, value = line.partition(' = ')
        if not separator or key in current:
            raise ValueError('Le catalogue de l’archive Lumbra est ambigu ou invalide.')
        current[key] = value
    candidates, total = [], 0
    for entry in entries:
        name = _safe_member_name(entry.get('Path'))
        if (entry.get('Encrypted', '-') != '-' or entry.get('Symbolic Link')
                or entry.get('Hard Link') or entry.get('Reparse')
                or entry.get('Anti', '-') != '-'):
            raise ValueError('Les archives chiffrées et les liens ne sont pas pris en charge.')
        attributes = entry.get('Attributes', '')
        mode = attributes.split()[-1] if attributes else ''
        if len(mode) == 10 and mode[0] not in ('-', 'd'):
            raise ValueError('L’archive Lumbra contient un fichier spécial non pris en charge.')
        folder = entry.get('Folder') == '+' or 'D' in attributes.split(' ')[0] or mode.startswith('d')
        try:
            size = int(entry.get('Size', '0'))
        except ValueError as exc:
            raise ValueError('La taille d’un fichier de l’archive Lumbra est invalide.') from exc
        if size < 0:
            raise ValueError('La taille d’un fichier de l’archive Lumbra est invalide.')
        total += size
        if total > limit:
            raise ValueError('Le contenu décompressé dépasse la taille autorisée.')
        if name.lower().endswith('.pgn') and not folder:
            if size == 0:
                raise ValueError('Le PGN de l’archive Lumbra est vide.')
            candidates.append((name, size))
    if len(candidates) != 1:
        raise ValueError('Choisis une archive Lumbra contenant exactement un fichier PGN.')
    return candidates[0]


def _extract_pgn(archive, target, limit, progress):
    executable = _seven_zip()
    if not executable:
        raise ValueError('Installe 7-Zip sur le serveur, ou décompresse l’archive et importe directement son fichier PGN.')
    listing = io.BytesIO()
    _command_output([executable, 'l', '-slt', '-ba', '-sccUTF-8', '--', str(archive)], listing,
        maximum=MAX_LISTING_BYTES, timeout=60, progress=progress, stage='Lecture de l’archive Lumbra')
    try:
        member, size = _pgn_member(listing.getvalue().decode('utf-8-sig'), limit)
    except UnicodeError as exc:
        raise ValueError('Le catalogue de l’archive Lumbra n’est pas un texte valide.') from exc
    _free_space(target.parent, size * 5 + GIB)
    digest = hashlib.sha256()

    class HashOutput:
        def __init__(self, output):
            self.output = output
            self.checked = 0

        def write(self, block):
            if time.monotonic() - self.checked >= .5:
                _free_space(target.parent, 512 * MIB)
                self.checked = time.monotonic()
            self.output.write(block)
            digest.update(block)

    with target.open('xb') as output:
        count = _command_output([executable, 'x', '-so', '-spd', '-y', '-bd', '--', str(archive), member],
            HashOutput(output), maximum=size, timeout=6 * 3600, progress=progress, stage='Décompression du PGN Lumbra')
    if count != size:
        raise ValueError('Le PGN extrait est incomplet.')
    return digest.hexdigest()


def _validate_pgn(path, limit):
    size = path.stat().st_size
    if not 0 < size <= limit:
        raise ValueError('Le fichier PGN Lumbra est vide ou trop volumineux.')
    with path.open('rb') as source:
        prefix = source.read(4096).lstrip(b'\xef\xbb\xbf\r\n \t')
    if not prefix.startswith(b'[') or b'\x00' in prefix:
        raise ValueError('Le fichier téléchargé ne contient pas un PGN attendu.')


def _integrity(path):
    with closing(sqlite3.connect(path)) as conn:
        if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('La base Lumbra importée n’a pas passé la vérification d’intégrité.')
        conn.execute('PRAGMA wal_checkpoint(TRUNCATE)')


class LumbraResources:
    def __init__(self, data_root):
        self.data_root = Path(data_root).resolve()
        self.root = self.data_root / 'resources' / 'lumbra'
        self.lock = threading.RLock()

    def _records(self):
        path = self.root / 'installed.json'
        if not path.exists():
            return {}
        try:
            if path.stat().st_size > MAX_RECORD_BYTES:
                raise ValueError('size')
            records = json.loads(path.read_text(encoding='utf-8'))
            if not isinstance(records, dict) or any(key not in SPECS or not isinstance(value, dict) for key, value in records.items()):
                raise ValueError('schema')
            return records
        except (OSError, ValueError, TypeError) as exc:
            raise ValueError('Le registre des bases Lumbra est illisible. Vérifie resources/lumbra/installed.json.') from exc

    def _installed(self, record):
        if not record:
            return False
        with db.get_conn() as conn:
            row = conn.execute('SELECT storage_key,source FROM reference_bases WHERE base_id=?', (record.get('base_id'),)).fetchone()
        # SQLite can reuse a deleted base's integer ID. Its replacement must not
        # be mistaken for this resource or returned by the idempotent install.
        if not row or row['source'] != record.get('pgn_path'):
            return False
        path = reference_library.store_path(row['storage_key'])
        if not path.is_file():
            return False
        state = reference_store.status(path)
        return state.get('status') == 'completed' and state.get('game_count', 0) > 0

    def catalog(self):
        records = self._records()
        return [{
            'id': identity, 'name': spec['name'], 'description': spec['description'],
            'category': 'database', 'installation_mode': 'browser-download',
            'source_url': DOWNLOAD_PAGE, 'download_page': DOWNLOAD_PAGE,
            'download_url': spec['download_url'], 'license': 'CC BY-NC 4.0',
            'license_url': LICENSE_URL, 'attribution': 'Lumbra’s Gigabase — Michael Jansen',
            'license_notice': 'Gratuit avec attribution pour un usage non commercial. Une licence distincte est nécessaire pour un usage commercial.',
            'available': True, 'installed': self._installed(records.get(identity)),
            'managed': identity in records, 'published_version': PUBLISHED_VERSION,
            'version': records.get(identity, {}).get('version'),
            'download_bytes': spec['estimated_download_bytes'],
            'estimated_download_bytes': spec['estimated_download_bytes'],
            'download_size_is_estimate': True,
            'seven_zip_available': _seven_zip() is not None,
        } for identity, spec in SPECS.items()]

    def _write_record(self, resource_id, record):
        records = self._records()
        records[resource_id] = record
        temporary = self.root / ('installed.' + secrets.token_hex(8) + '.tmp')
        try:
            temporary.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding='utf-8')
            replace_with_retry(temporary, self.root / 'installed.json')
        finally:
            temporary.unlink(missing_ok=True)

    def _existing(self, pgn):
        with db.get_conn() as conn:
            rows = conn.execute('SELECT base_id,storage_key FROM reference_bases WHERE source=?', (str(pgn),)).fetchall()
        for row in rows:
            path = reference_library.store_path(row['storage_key'])
            if path.is_file():
                state = reference_store.status(path)
                if state.get('status') == 'completed' and state.get('game_count', 0):
                    return {'base_id': row['base_id'], 'count': state['game_count']}
        return None

    def _publish(self, staged, pgn, resource_id, digest, progress):
        existing = self._existing(pgn)
        if existing:
            return existing
        _integrity(staged)
        key = secrets.token_hex(16)
        target = reference_library.store_path(key)
        target.parent.mkdir(parents=True, exist_ok=True)
        progress('Ajout de la base Lumbra à la bibliothèque', 97)
        staged.replace(target)
        try:
            with db.get_conn() as conn:
                conn.execute('BEGIN IMMEDIATE')
                name = SPECS[resource_id]['name']
                prior = self._records().get(resource_id)
                if prior and prior.get('sha256') != digest:
                    name += ' · ' + digest[:8]
                base_id = conn.execute('INSERT INTO bases(name,tags,settings,created_at) VALUES(?,?,?,?)',
                    (name, json.dumps(['Lumbra', resource_id, 'CC BY-NC 4.0']),
                     json.dumps(library_service.DEFAULT_SETTINGS), library_service.now())).lastrowid
                conn.execute("INSERT INTO reference_bases(base_id,storage_key,source,status) VALUES(?,?,?,'paused')",
                    (base_id, key, str(pgn)))
        except BaseException:
            target.unlink(missing_ok=True)
            raise
        return {'base_id': base_id, 'count': reference_store.status(target)['game_count']}

    def install(self, resource_id, progress=lambda stage, percent: None, *, source_path=None):
        spec = _spec(resource_id)
        source, suffix, limit = _local_source(source_path, spec)
        if suffix == '.7z' and not _seven_zip():
            raise ValueError('Installe 7-Zip sur le serveur, ou décompresse l’archive et importe directement son fichier PGN.')
        with self.lock, reference_library.managed_import():
            progress('Préparation de la base Lumbra', 1)
            self.root.mkdir(parents=True, exist_ok=True)
            _free_space(self.root, source.stat().st_size + GIB)
            records = self._records()
            with tempfile.TemporaryDirectory(prefix='.staging-', dir=self.root) as temporary:
                stage = Path(temporary)
                copied = stage / ('source' + suffix)
                digest = _copy_source(source, copied, limit, progress)
                saved = records.get(resource_id, {})
                if saved.get('sha256') == digest and self._installed(saved):
                    # The immutable source remains recoverable even if the user
                    # deletes the original file from their Downloads directory.
                    progress('Cette base Lumbra est déjà installée', 100)
                    return dict(saved)
                directory = self.root / resource_id / digest
                directory.mkdir(parents=True, exist_ok=True)
                archive = directory / ('source' + suffix)
                _save_immutable(copied, archive, digest)
                pgn = archive if suffix == '.pgn' else directory / 'games.pgn'
                existing = self._existing(pgn)
                if suffix == '.7z' and not existing:
                    extracted = stage / 'games.pgn'
                    pgn_digest = _extract_pgn(archive, extracted, spec['pgn_limit'], progress)
                    _validate_pgn(extracted, spec['pgn_limit'])
                    _save_immutable(extracted, pgn, pgn_digest)
                else:
                    _validate_pgn(pgn, spec['pgn_limit'])
                    pgn_digest = digest if suffix == '.pgn' else _digest(pgn)
                if existing:
                    details = existing
                else:
                    _free_space(stage, pgn.stat().st_size * 4 + GIB)
                    # Keep committed checkpoints next to this immutable source.
                    # A retry resumes the potentially hours-long import rather
                    # than discarding its progress with the temporary download.
                    staged = directory / 'import.sqlite3'

                    def report(state):
                        _free_space(stage, 512 * MIB)
                        progress(f"Indexation : {state.get('game_count', 0):,} parties", 35 + 60 * state.get('bytes_read', 0) / max(1, state.get('total_bytes', 1)))

                    with resource_policy.import_reservation(reference_worker.default_import_workers()) as workers:
                        state = reference_store.import_file(staged, pgn, progress=report, workers=workers,
                            cache_mib=reference_worker.default_import_cache_mib(),
                            sort_positions=reference_worker.default_sort_positions())
                    if state.get('status') != 'completed' or not state.get('game_count'):
                        raise ValueError(state.get('error') or 'L’import de la base Lumbra n’est pas terminé.')
                    details = self._publish(staged, pgn, resource_id, digest, progress)
                record = {**details, 'id': resource_id, 'version': 'sha256:' + digest[:12],
                    'sha256': digest, 'pgn_sha256': pgn_digest, 'archive_path': str(archive),
                    'pgn_path': str(pgn), 'source_url': DOWNLOAD_PAGE, 'license': 'CC BY-NC 4.0',
                    'license_url': LICENSE_URL, 'installed': True,
                    'installed_at': datetime.now(timezone.utc).isoformat()}
                self._write_record(resource_id, record)
            progress('Base Lumbra disponible', 100)
            return record
