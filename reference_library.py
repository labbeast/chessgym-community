"""Authenticated library adapter and one resource-bounded reference importer.

Reference PGNs live in independent, portable SQLite files. The importer runs in
a separate Python process; it never holds the study database open while parsing.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from contextlib import contextmanager

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import db
import pgnlib
import reference_store
import reference_phase

router = APIRouter(prefix='/api/reference-bases')
_lock = threading.RLock()
_processes = {}
_managed_import_active = False


def import_active():
    # Resource-policy callbacks must not acquire the worker lock: callers can
    # already hold the resource-policy lock while an importer starts.
    return _managed_import_active or any(p.poll() is None for p in list(_processes.values()))


@contextmanager
def managed_import():
    """Reserve the manual-import gate without locking library UI for minutes."""
    global _managed_import_active
    with _lock:
        if import_active():
            raise HTTPException(409, 'Un import de grande base est déjà en cours. Réessaie après sa fin.')
        _managed_import_active = True
    try:
        yield
    finally:
        with _lock:
            _managed_import_active = False


def store_path(storage_key):
    if not isinstance(storage_key, str) or len(storage_key) != 32 or any(c not in '0123456789abcdef' for c in storage_key):
        raise ValueError('Identifiant de stockage invalide.')
    return db.DATA_DIR / 'references' / (storage_key + '.sqlite3')


def reference_row(conn, base_id):
    row = conn.execute('SELECT * FROM reference_bases WHERE base_id=?', (base_id,)).fetchone()
    return dict(row) if row else None


def require_reference(base_id):
    with db.get_conn() as conn:
        row = reference_row(conn, base_id)
    if row is None:
        raise HTTPException(404, 'Cette grande base est introuvable.')
    return row


def require_study_base(conn, base_id):
    if reference_row(conn, base_id):
        raise ValueError('Choisis une base d’étude pour sauvegarder ou réviser cette partie. La grande base conserve son import original.')


def source_path(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 4096:
        raise ValueError('Indique le chemin complet du PGN sur la machine qui héberge ChessGym.')
    path = Path(value.strip()).expanduser()
    if not path.is_absolute() or not path.is_file() or not path.name.lower().endswith(('.pgn', '.pgn.zst')):
        raise ValueError('Choisis un fichier local existant .pgn ou .pgn.zst, avec son chemin complet.')
    return path.resolve()


def status_for(row):
    path = store_path(row['storage_key'])
    if not path.is_file():
        return dict(status='error', imported=0, game_count=0, processed=0, rejected=0,
                    duplicates=0, bytes_read=0, total_bytes=0, source=row['source'],
                    error=row.get('error') or 'Le fichier de cette grande base est absent. Restaure le dossier data/references ou relance son import.')
    key = (str(db.DB_PATH.resolve()), row['base_id'])
    # Never acquire the worker lock here: callers can hold the study write lock.
    process = _processes.get(key)
    active = process is not None and process.poll() is None
    phase_data = reference_phase.read(path, getattr(process, '_chessgym_run_id', None),
                                      row['source'], getattr(process, '_chessgym_started_ns', 0)) if active else None
    # During long commits/close, read only the worker's last committed counters.
    # A different/stale run never replaces database truth.
    result = (dict(phase_data['snapshot']) if phase_data and phase_data['snapshot']
              else reference_store.status(path))
    raw = result.get('status', 'idle')
    result['status'] = {'importing': 'running', 'failed': 'error', 'idle': 'paused'}.get(raw, raw)
    if active and raw in ('idle', 'paused', 'completed'):
        result['status'] = 'running'
    elif not active and result['status'] == 'running':
        result['status'] = 'paused'
    if row.get('error') and not active and raw != 'failed':
        result.update(status='error', error=row['error'])
    if result.get('limit_reached') and not active and result['status'] != 'error':
        result['status'] = 'limited'
    pause_requested = active and path.with_suffix('.cancel').exists()
    phase = phase_data['phase'] if phase_data else None
    if active and phase == 'finished':
        phase = 'finalizing'  # The actual process exit, not EOF, ends the job.
    if active and not phase:
        phase = 'finalizing' if raw == 'completed' else 'stopping' if pause_requested else 'processing'
    return {**result, 'source': row['source'], 'max_games': row['max_games'],
            'encoding': row.get('encoding', 'utf-8-sig'), 'worker_active': active,
            'pause_requested': pause_requested, 'phase': phase,
            'phase_tracked': phase_data is not None,
            'phase_updated_at': (datetime.fromtimestamp(phase_data['updated_ns'] / 1e9, timezone.utc).isoformat()
                                 if phase_data else None),
            'progress_kind': 'source_bytes'}


def enrich_base(conn, result):
    row = reference_row(conn, result['id'])
    if row:
        details = status_for(row)
        result.update(reference=True, reference_status=details,
                      entry_count=details.get('game_count', details.get('imported', 0)))
    return result


def _finish(key, process, database, base_id, storage_key, log_handle):
    code = process.wait()
    log_handle.close()
    # The application's DB_PATH may have changed in a test. Never redirect a
    # completed child into another account/database.
    import sqlite3
    try:
        with sqlite3.connect(database, timeout=20, factory=db.ManagedConnection) as conn:
            conn.execute('UPDATE reference_bases SET status=?,error=? WHERE base_id=? AND storage_key=?',
                         ('paused' if code == 0 else 'error', '' if code == 0 else 'L’import a été interrompu. Consulte le bilan puis reprends-le.', base_id, storage_key))
    finally:
        with _lock:
            if _processes.get(key) is process:
                _processes.pop(key, None)


def start_import(base_id):
    from reference_worker import default_import_workers
    import resource_policy
    key = (str(db.DB_PATH.resolve()), base_id)
    with _lock:
        row = require_reference(base_id)
        source = source_path(row['source'])
        path = store_path(row['storage_key'])
        if import_active():
            raise HTTPException(409, 'Un import de grande base est déjà en cours. Termine-le ou mets-le en pause avant d’en lancer un autre.')
        baseline = reference_store.init_store(path)
        run_id, started_ns = secrets.token_hex(16), time.time_ns()
        reference_phase.Publisher(path, run_id, source, baseline).publish('preparing')
        cancel = path.with_suffix('.cancel')
        cancel.unlink(missing_ok=True)
        with resource_policy.import_reservation(default_import_workers()) as workers:
            command = [sys.executable, '-X', 'utf8', str(Path(__file__).with_name('reference_worker.py')),
                       '--store', str(path.resolve()), '--source', str(source), '--cancel', str(cancel.resolve()),
                       '--encoding', row.get('encoding', 'utf-8-sig'), '--parent-pid', str(os.getpid()),
                       '--workers', str(workers), '--run-id', run_id]
            if row['max_games'] is not None:
                command += ['--max-games', str(row['max_games'])]
            log = path.with_suffix('.log').open('wb')
            try:
                process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                           cwd=Path(__file__).parent,
                                           creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
            except BaseException:
                log.close()
                raise
            process._chessgym_run_id = run_id
            process._chessgym_started_ns = started_ns
            _processes[key] = process
        with db.get_conn() as conn:
            conn.execute("UPDATE reference_bases SET status='running',error='' WHERE base_id=?", (base_id,))
        threading.Thread(target=_finish, args=(key, process, str(db.DB_PATH.resolve()), base_id,
                                              row['storage_key'], log), daemon=True).start()
    return status_for({**row, 'status': 'running', 'error': ''})


def stop_import(base_id):
    row = require_reference(base_id)
    store_path(row['storage_key']).with_suffix('.cancel').write_text('pause', encoding='ascii')
    return status_for(row)


def ensure_deletable(base_id):
    key = (str(db.DB_PATH.resolve()), base_id)
    with _lock:
        process = _processes.get(key)
        if process and process.poll() is None:
            raise HTTPException(409, 'Mets l’import en pause avant de supprimer cette base.')


@contextmanager
def deletion_guard(base_id):
    """Serialize deletion with starting an import, including the metadata write."""
    with _lock:
        ensure_deletable(base_id)
        yield


def shutdown():
    with _lock:
        active = list(_processes.items())
    for (database, base_id), process in active:
        if database != str(db.DB_PATH.resolve()):
            continue
        try:
            stop_import(base_id)
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            process.wait(timeout=5)
        except HTTPException:
            pass


@router.post('')
def create_reference(payload: dict):
    import library_service
    if set(payload) - {'name', 'folder_id', 'path', 'max_games', 'encoding'}:
        raise ValueError('Option d’import inconnue.')
    source = source_path(payload.get('path'))
    maximum = payload.get('max_games')
    if maximum is not None and (type(maximum) is not int or not 1 <= maximum <= 1_000_000_000):
        raise ValueError('La limite doit être un nombre entier de parties, ou vide pour tout importer.')
    name = library_service.text_field(payload.get('name'), 'Le nom')
    encoding = payload.get('encoding', 'utf-8-sig')
    if encoding not in ('utf-8-sig', 'utf-8', 'cp1252', 'latin-1'):
        raise ValueError('Choisis un encodage PGN pris en charge.')
    storage_key = secrets.token_hex(16)
    with _lock:
        if import_active():
            raise HTTPException(409, 'Un import est déjà en cours. Mets-le en pause avant de créer le suivant.')
        with db.get_conn() as conn:
            library_service.verify_folder(conn, payload.get('folder_id'))
            base_id = conn.execute('INSERT INTO bases(name,folder_id,tags,settings,created_at) VALUES(?,?,?,?,?)',
                                   (name, payload.get('folder_id'), '[]', json.dumps(library_service.DEFAULT_SETTINGS), library_service.now())).lastrowid
            conn.execute('INSERT INTO reference_bases(base_id,storage_key,source,max_games,encoding) VALUES(?,?,?,?,?)',
                         (base_id, storage_key, str(source), maximum, encoding))
        try:
            start_import(base_id)
        except Exception as exc:
            with db.get_conn() as conn:
                conn.execute("UPDATE reference_bases SET status='error',error=? WHERE base_id=?", (str(exc), base_id))
        with db.get_conn() as conn:
            return library_service.get_base(conn, base_id)


@router.get('/{base_id}/status')
def get_status(base_id: int):
    return status_for(require_reference(base_id))


@router.post('/{base_id}/cancel')
def cancel(base_id: int):
    return stop_import(base_id)


@router.post('/{base_id}/resume')
def resume(base_id: int):
    return start_import(base_id)


@router.get('/{base_id}/games')
async def games(request: Request, base_id: int, offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=100),
          search: str = Query('', max_length=200), sort: str = 'id', descending: bool = False,
          rating_min: int | None = Query(None, ge=0, le=4000), rating_max: int | None = Query(None, ge=0, le=4000),
          speed: str | None = None):
    row = require_reference(base_id)
    import reference_queries
    import game_search
    # Preserve the existing errors for legacy list options before parsing the
    # new filters or scheduling any background work.
    reference_store.validate_list_query(search=search, sort=sort, rating_min=rating_min,
        rating_max=rating_max, speed=speed)
    advanced = game_search.parse_query(request)
    # A short unfiltered page uses existing covering indexes and the stored
    # corpus count. Keep it available while Explorer prepares a large position.
    short_page = (offset <= 500 and sort in ('id', 'date') and not search
                  and not advanced.active)
    reference_store.validate_list_query(search=search, sort=sort, advanced=advanced)
    path = store_path(row['storage_key'])
    profile = ('game-list-v4', offset, limit, search, sort, descending,
               json.dumps(advanced.model_dump(), sort_keys=True, ensure_ascii=False))
    def compute():
        return {'status': 'ok', **reference_store.list_games(path,
            offset=offset, limit=limit, search=search, sort=sort, descending=descending,
            advanced=advanced)}
    def query():
        if short_page:
            return reference_queries.exclusive(compute, short_page=True)
        # Exact completed pages may take longer on a cold large archive. A
        # single bounded background worker finishes them; polling never starts
        # duplicate scans. Existing metadata indexes are sufficient for lists.
        return reference_queries.bounded([path], profile, compute, persistent=True,
            prepare=True, prepare_indexes=False)
    try:
        return await reference_queries.run(request, query)
    except reference_queries.QueryStopped as exc:
        if exc.reason == 'preparing':
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=202, content={'status': 'preparing',
                'entries': [], 'total': None, 'offset': offset, 'limit': limit,
                'has_more': False, 'retry_after': 3,
                'message': 'Préparation de la recherche… Les résultats apparaîtront automatiquement.'})
        message = {
            'timeout': 'La recherche a dépassé le délai disponible. Précise le nom du joueur ou du tournoi, puis réessaie.',
            'cooldown': 'Cette recherche est trop large. Précise le nom du joueur ou du tournoi, ou réessaie dans une minute.',
        }.get(exc.reason, reference_queries.unavailable(exc.reason)['message'])
        raise HTTPException(503, message, headers={'Retry-After':'2'}) from exc


@router.get('/{base_id}/directory')
async def directory(request: Request, base_id: int, kind: str = 'players', search: str = Query('', max_length=200),
                    offset: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                    sort: str = 'name', descending: bool = False,
                    player_key: str = Query('', max_length=2000), event_key: str = Query('', max_length=6000)):
    import game_directory
    import reference_queries
    game_directory.validate(kind, search, offset, limit, sort, descending, player_key, event_key)
    row = require_reference(base_id)
    path = store_path(row['storage_key'])
    profile = ('directory-v1', kind, search, offset, limit, sort, descending, player_key, event_key)
    def compute():
        return {'status': 'ok', **game_directory.reference_directory(path, kind=kind, search=search,
            offset=offset, limit=limit, sort=sort, descending=descending, player_key=player_key, event_key=event_key)}
    def query():
        return reference_queries.bounded([path], profile, compute, persistent=True,
            prepare=True, prepare_indexes=False)
    try:
        return await reference_queries.run(request, query)
    except reference_queries.QueryStopped as exc:
        if exc.reason == 'preparing':
            from fastapi.responses import JSONResponse
            return JSONResponse(status_code=202, content={'status': 'preparing', 'kind': kind,
                'items': [], 'total': None, 'offset': offset, 'limit': limit, 'has_more': False,
                'retry_after': 3, 'message': 'Préparation de la liste…'})
        raise HTTPException(503, 'La liste ne peut pas encore être affichée. Réessaie dans un instant.',
                            headers={'Retry-After': '3'}) from exc


@router.post('/{base_id}/games/batch')
def batch_games(base_id: int, payload: dict):
    import reference_actions
    return reference_actions.batch(base_id, payload)


@router.get('/{base_id}/games/{game_id}')
def game(base_id: int, game_id: int):
    row = require_reference(base_id)
    try:
        found = reference_store.read_game(store_path(row['storage_key']), game_id)
    except ValueError as exc:
        raise HTTPException(404, 'Cette partie est introuvable.') from exc
    parsed = pgnlib.load_game(found['pgn'])
    return {**pgnlib.game_payload(parsed), 'title': found['title'],
            'reference_source': {'base_id': base_id, 'game_id': game_id}, 'start_path': ''}


@router.get('/{base_id}/export')
def export_pgn(base_id: int):
    row = require_reference(base_id)
    path = store_path(row['storage_key'])
    def chunks():
        for pgn in reference_store.iter_pgn(path):
            yield (pgn + '\n\n').encode('utf-8')
    return StreamingResponse(chunks(), media_type='application/x-chess-pgn',
                             headers={'Content-Disposition': f'attachment; filename="chessgym-reference-{base_id}.pgn"'})
