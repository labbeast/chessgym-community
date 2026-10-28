"""Personal backup rotation and offline restore, isolated from reference imports."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import time
import uuid
import zipfile

from fastapi import HTTPException
import db

log = logging.getLogger(__name__)
_BUILD = threading.Lock()
_THREAD = None
_GUARD = None
MAX_PERSONAL_BYTES = 1024 * 1024 * 1024
ARCHIVE_NAME = re.compile(r'chessgym-(auto|personal)-\d{8}T\d{12}Z-[a-f0-9]{8}\.zip\Z')


def now():
    return datetime.now(timezone.utc).isoformat()


def _preference(key, default=None):
    with db.get_conn() as conn:
        row = conn.execute('SELECT value FROM preferences WHERE key=?', (key,)).fetchone()
    try:
        return json.loads(row['value']) if row else default
    except (TypeError, ValueError):
        return default


def settings():
    defaults = {'enabled': False, 'interval_hours': 24, 'keep': 7,
                'destination': str(Path(db.DATA_DIR).resolve() / 'backups' / 'automatic')}
    saved = _preference('backup_settings', {})
    return {**defaults, **(saved if isinstance(saved, dict) else {})}


def update_settings(patch):
    if not isinstance(patch, dict) or set(patch) - {'enabled', 'interval_hours', 'keep', 'destination'}:
        raise HTTPException(400, 'Réglages de sauvegarde inconnus.')
    value = {**settings(), **patch}
    if type(value['enabled']) is not bool:
        raise HTTPException(400, 'Choisis si les sauvegardes automatiques sont activées.')
    for key, minimum, maximum in [('interval_hours', 1, 720), ('keep', 1, 90)]:
        if type(value[key]) is not int or not minimum <= value[key] <= maximum:
            raise HTTPException(400, 'Fréquence ou conservation des sauvegardes hors limites.')
    destination = value['destination']
    if not isinstance(destination, str) or not destination.strip() or len(destination) > 1000:
        raise HTTPException(400, 'Indique un dossier de sauvegarde absolu sur le serveur.')
    path = Path(destination).expanduser()
    if not path.is_absolute() or (path.exists() and not path.is_dir()):
        raise HTTPException(400, 'Indique un dossier de sauvegarde absolu sur le serveur.')
    value['destination'] = str(path.resolve())
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                     ('backup_settings', json.dumps(value)))
    return status()


def _record(value):
    with db.get_conn() as conn:
        conn.execute('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                     ('backup_last_run', json.dumps(value)))


def _owner_id():
    with db.get_conn() as conn:
        conn.execute("INSERT OR IGNORE INTO preferences VALUES('backup_owner',?)", (json.dumps(uuid.uuid4().hex),))
        return json.loads(conn.execute("SELECT value FROM preferences WHERE key='backup_owner'").fetchone()[0])


def status():
    return {'settings': settings(), 'last_run': _preference('backup_last_run'), 'running': _BUILD.locked()}


def build_archive(archive_path, mode='personal'):
    """Build an archive using a consistent SQLite snapshot, never live file copies."""
    if mode not in ('personal', 'full'):
        raise HTTPException(400, 'Choisis une sauvegarde personnelle ou complète.')
    owner = _owner_id()
    from puzzle_store import bank_path
    puzzle_path = bank_path()
    puzzle_present = puzzle_path.is_file()
    archive_path = Path(archive_path)
    with tempfile.TemporaryDirectory(prefix='snapshot-', dir=archive_path.parent) as temporary:
        snapshot_path = Path(temporary) / 'chessgym.sqlite3'
        with sqlite3.connect(snapshot_path, factory=db.ManagedConnection) as snapshot:
            snapshot.row_factory = sqlite3.Row
            with db.get_conn() as source:
                source.backup(snapshot, pages=1024)
            snapshot.execute('PRAGMA journal_mode=DELETE')
            snapshot.commit()
            references = [dict(row) for row in snapshot.execute('SELECT * FROM reference_bases')]
            bases = [dict(row) for row in snapshot.execute('SELECT * FROM bases')]
            metadata = {'version': '0.1.0', 'created_at': now(),
                        'folders': [dict(row) for row in snapshot.execute('SELECT * FROM folders')],
                        'bases': bases, 'reference_bases': references,
                        'backup': {'schema_version': 1, 'owner': owner, 'mode': mode, 'personal_data_included': True,
                                   'reference_stores_included': mode == 'full',
                                   'puzzle_bank_included': mode == 'full' and puzzle_present,
                                   'omitted_puzzle_bank': 'puzzles/bank.sqlite3' if mode == 'personal' and puzzle_present else None,
                                   'omitted_reference_stores': ([{**row, 'archive_path': 'references/' + row['storage_key'] + '.sqlite3'} for row in references] if mode == 'personal' else [])}}
            with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as archive:
                archive.write(snapshot_path, 'chessgym.sqlite3')
                reference_ids = {row['base_id'] for row in references}
                for base in bases:
                    if base['id'] in reference_ids:
                        continue
                    with archive.open('pgn/base-' + str(base['id']) + '.pgn', 'w', force_zip64=True) as output:
                        first = True
                        for row in snapshot.execute('SELECT pgn FROM entries WHERE base_id=? ORDER BY id', (base['id'],)):
                            output.write(('' if first else '\n\n').encode('utf-8'))
                            output.write(row['pgn'].encode('utf-8'))
                            first = False
                if mode == 'full':
                    import reference_library
                    for row in references:
                        source_path = reference_library.store_path(row['storage_key'])
                        if not source_path.is_file():
                            raise HTTPException(409, 'Le fichier de la grande base est absent : restaure-le avant de créer une sauvegarde complète.')
                        copy = Path(temporary) / source_path.name
                        with sqlite3.connect(source_path.resolve().as_uri() + '?mode=ro', uri=True, factory=db.ManagedConnection) as source:
                            with sqlite3.connect(copy, factory=db.ManagedConnection) as target:
                                source.backup(target, pages=1024)
                                target.execute('PRAGMA journal_mode=DELETE')
                        archive.write(copy, 'references/' + copy.name)
                        copy.unlink()
                    if puzzle_present:
                        copy = Path(temporary) / 'puzzle-bank.sqlite3'
                        with sqlite3.connect(puzzle_path.resolve().as_uri() + '?mode=ro', uri=True, factory=db.ManagedConnection) as source:
                            with sqlite3.connect(copy, factory=db.ManagedConnection) as target:
                                source.backup(target, pages=1024)
                                target.execute('PRAGMA journal_mode=DELETE')
                        archive.write(copy, 'puzzles/bank.sqlite3')
                        copy.unlink()
                archive.writestr('metadata.json', json.dumps(metadata, ensure_ascii=False, indent=2))
                archive.writestr('LIRE-MOI.txt',
                    'Sauvegarde privée ChessGym : compte, parties, réglages, brouillons et progression.\n'
                    'Pour restaurer : arrêter ChessGym puis lancer Restaurer ChessGym.cmd, ou utiliser scripts/restore_backup.py.\n'
                    'Une sauvegarde personnelle exclut les grandes références et la banque publique de puzzles : conserver les dossiers references/ et puzzles/ existants. Les tentatives et progrès personnels sont inclus.\n'
                    'Le lanceur restaure les données personnelles. Pour une sauvegarde complète, transférer aussi references/ et puzzles/bank.sqlite3 séparément si nécessaire.\n'
                    'Le fichier PGN source reste nécessaire pour reprendre une importation inachevée.\n')


def _safe_members(archive):
    names = set()
    for info in archive.infolist():
        path = PurePosixPath(info.filename)
        if info.filename in names or path.is_absolute() or '..' in path.parts or '\\' in info.filename or ':' in info.filename:
            raise ValueError('Chemin invalide dans la sauvegarde.')
        if stat.S_ISLNK(info.external_attr >> 16):
            raise ValueError('Lien symbolique interdit dans la sauvegarde.')
        names.add(info.filename)
    if not {'chessgym.sqlite3', 'metadata.json'} <= names:
        raise ValueError('Cette archive ne contient pas une sauvegarde ChessGym.')


def _extract_personal(archive_path, directory):
    with zipfile.ZipFile(archive_path) as archive:
        _safe_members(archive)
        if archive.getinfo('metadata.json').file_size > 4 * 1024 * 1024 or archive.getinfo('chessgym.sqlite3').file_size > MAX_PERSONAL_BYTES:
            raise ValueError('La sauvegarde personnelle dépasse la limite de restauration de 1 Go.')
        metadata = json.loads(archive.read('metadata.json'))
        if metadata.get('backup', {}).get('schema_version') != 1:
            raise ValueError('Version de sauvegarde non prise en charge.')
        target = Path(directory) / 'chessgym.sqlite3'
        with archive.open('chessgym.sqlite3') as source, target.open('wb') as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
    with sqlite3.connect(target.resolve().as_uri() + '?mode=ro', uri=True, factory=db.ManagedConnection) as conn:
        if conn.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('La sauvegarde SQLite est endommagée.')
        tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {'users', 'preferences', 'entries', 'bases', 'folders'} <= tables:
            raise ValueError('La sauvegarde ne contient pas les données personnelles attendues.')
        if conn.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise ValueError('La sauvegarde contient des liens invalides.')
        counts = {'bases': conn.execute('SELECT count(*) FROM bases').fetchone()[0],
                  'entries': conn.execute('SELECT count(*) FROM entries').fetchone()[0]}
    return target, metadata, counts


def verify_archive(path):
    Path(db.DATA_DIR).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='verify-backup-', dir=db.DATA_DIR) as temporary:
        _, metadata, counts = _extract_personal(path, temporary)
    return {'valid': True, 'created_at': metadata.get('created_at'), 'mode': metadata['backup'].get('mode'),
            **counts, 'reference_stores_included': metadata['backup'].get('reference_stores_included', False)}


def archive_path(name, *, root=None):
    if not isinstance(name, str) or not ARCHIVE_NAME.fullmatch(name):
        raise HTTPException(404, 'Sauvegarde introuvable.')
    root = Path(root if root is not None else settings()['destination']).resolve()
    path = root / name
    if path.is_symlink() or path.resolve().parent != root or not path.is_file():
        raise HTTPException(404, 'Sauvegarde introuvable.')
    return path


def list_archives(*, root=None):
    root = Path(root if root is not None else settings()['destination'])
    if not root.is_dir():
        return []
    result = []
    for path in root.iterdir():
        if ARCHIVE_NAME.fullmatch(path.name) and path.is_file() and not path.is_symlink():
            item = path.stat()
            result.append({'id': path.name, 'bytes': item.st_size,
                           'created_at': datetime.fromtimestamp(item.st_mtime, timezone.utc).isoformat(),
                           'automatic': path.name.startswith('chessgym-auto-')})
    return sorted(result, key=lambda item: item['id'], reverse=True)


def create_archive(*, automatic=False):
    if not _BUILD.acquire(blocking=False):
        raise HTTPException(409, 'Une sauvegarde est déjà en cours.')
    temporary = None
    try:
        config = settings()
        root = Path(config['destination']).resolve()
        root.mkdir(parents=True, exist_ok=True)
        name = 'chessgym-' + ('auto' if automatic else 'personal') + '-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '-' + uuid.uuid4().hex[:8] + '.zip'
        temporary = root / ('.' + name + '.partial')
        build_archive(temporary)
        verify_archive(temporary)
        final = root / name
        os.replace(temporary, final)
        _record({'status': 'done', 'at': now(), 'id': name, 'destination': str(root), 'automatic': automatic})
        if automatic:
            # Scope retention to this backup's original directory and installation,
            # even if preferences change while its snapshot is being created.
            owner = _owner_id()
            candidates = []
            for item in list_archives(root=root):
                if not item['automatic']:
                    continue
                try:
                    with zipfile.ZipFile(archive_path(item['id'], root=root)) as archive:
                        if archive.getinfo('metadata.json').file_size > 4 * 1024 * 1024:
                            continue
                        if json.loads(archive.read('metadata.json')).get('backup', {}).get('owner') == owner:
                            candidates.append(item)
                except (OSError, ValueError, KeyError, zipfile.BadZipFile):
                    continue
            for item in candidates[config['keep']:]:
                archive_path(item['id'], root=root).unlink()
        return {'id': name, 'bytes': final.stat().st_size, 'created_at': now()}
    except Exception as exc:
        _record({'status': 'error', 'at': now(), 'error': str(exc)[:400], 'automatic': automatic})
        raise
    finally:
        if temporary is not None and temporary.is_file():
            temporary.unlink()
        _BUILD.release()


def scheduler_tick():
    global _THREAD
    config = settings()
    if not config['enabled'] or _BUILD.locked() or (_THREAD is not None and _THREAD.is_alive()):
        return
    last = _preference('backup_last_run') or {}
    try:
        elapsed = time.time() - datetime.fromisoformat(last['at']).timestamp()
    except (KeyError, TypeError, ValueError):
        elapsed = float('inf')
    # A failed destination is retried hourly, without a tight retry loop.
    wait_hours = config['interval_hours'] if last.get('status') == 'done' else 1
    if elapsed < wait_hours * 3600:
        return
    def work():
        try:
            create_archive(automatic=True)
        except Exception:
            log.exception('La sauvegarde automatique n’a pas pu être créée.')
    _THREAD = threading.Thread(target=work, name='ChessGym-backup', daemon=True)
    _THREAD.start()


@contextmanager
def offline_guard():
    path = Path(db.DATA_DIR) / '.application.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open('a+b')
    try:
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            if path.stat().st_size == 0:
                handle.write(b'0'); handle.flush(); handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        handle.close()
        raise RuntimeError('Arrête ChessGym avant de restaurer une sauvegarde.') from None
    try:
        yield
    finally:
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def start_guard():
    global _GUARD
    if _GUARD is None:
        _GUARD = offline_guard()
        try:
            _GUARD.__enter__()
        except Exception:
            _GUARD = None
            raise


def close_guard():
    global _GUARD
    if _THREAD is not None and _THREAD.is_alive():
        _THREAD.join(timeout=30)
        if _THREAD.is_alive():
            return  # Keep the offline-restore lock until the process really exits.
    if _GUARD is not None:
        _GUARD.__exit__(None, None, None)
        _GUARD = None


def restore_offline(path, *, confirm=False):
    """Restore personal data while preserving separately managed reference stores."""
    if not confirm:
        raise ValueError('Confirme la restauration après avoir vérifié la sauvegarde.')
    source_path = Path(path).resolve()
    with offline_guard(), tempfile.TemporaryDirectory(prefix='restore-', dir=db.DATA_DIR) as temporary:
        restored, metadata, counts = _extract_personal(source_path, temporary)
        # References are never silently overwritten: the personal restore keeps
        # existing stores, and the manifest identifies separately missing stores.
        rollback = Path(db.DATA_DIR) / 'backups' / ('before-restore-' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.sqlite3')
        rollback.parent.mkdir(parents=True, exist_ok=True)
        existed = Path(db.DB_PATH).exists()
        if existed:
            with db.get_conn() as current, sqlite3.connect(rollback, factory=db.ManagedConnection) as copy:
                current.backup(copy)
                copy.execute('PRAGMA journal_mode=DELETE')
        with sqlite3.connect(restored, factory=db.ManagedConnection) as conn:
            conn.execute('DELETE FROM sessions')
            conn.execute('INSERT INTO preferences VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                         ('workspace_epoch', json.dumps(uuid.uuid4().hex)))
            conn.commit()
        # SQLite backup writes through its transaction machinery, including any
        # existing journal files, instead of replacing a live-WAL main file.
        with sqlite3.connect(restored, factory=db.ManagedConnection) as source, sqlite3.connect(db.DB_PATH, factory=db.ManagedConnection) as destination:
            source.backup(destination)
            destination.execute('PRAGMA journal_mode=DELETE')
        missing = []
        for row in metadata.get('reference_bases', []):
            key = row.get('storage_key', '')
            if not re.fullmatch('[a-f0-9]{32}', key) or not (Path(db.DATA_DIR) / 'references' / (key + '.sqlite3')).is_file():
                missing.append(row.get('base_id'))
        return {'restored': True, **counts, 'rollback': str(rollback) if existed else None, 'missing_reference_ids': missing,
                'reference_stores_restored': False}
