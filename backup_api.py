"""Authenticated backup endpoints; restoration is deliberately offline."""
from pathlib import Path
import tempfile
import sqlite3
import zipfile
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
import backup_service
import db

router = APIRouter(prefix='/api')


@router.get('/backup')
def download_backup(mode: str = 'personal'):
    temporary = tempfile.TemporaryDirectory(prefix='backup-', dir=db.DATA_DIR)
    archive = Path(temporary.name) / 'chessgym-backup.zip'
    try:
        backup_service.build_archive(archive, mode)
    except BaseException:
        temporary.cleanup()
        raise
    return FileResponse(archive, media_type='application/zip', filename='chessgym-backup-' + mode + '.zip',
                        background=BackgroundTask(temporary.cleanup))


@router.get('/backups/settings')
def settings():
    return backup_service.status()


@router.patch('/backups/settings')
def update_settings(payload: dict):
    return backup_service.update_settings(payload)


@router.get('/backups')
def archives():
    return {'archives': backup_service.list_archives(), **backup_service.status()}


@router.post('/backups/create')
def create():
    return backup_service.create_archive()


@router.get('/backups/{name}/download')
def download(name: str):
    path = backup_service.archive_path(name)
    return FileResponse(path, media_type='application/zip', filename=path.name)


@router.post('/backups/{name}/verify')
def verify(name: str):
    path = backup_service.archive_path(name)
    try:
        return backup_service.verify_archive(path)
    except (ValueError, OSError, sqlite3.DatabaseError, zipfile.BadZipFile) as exc:
        raise HTTPException(400, str(exc)) from None
