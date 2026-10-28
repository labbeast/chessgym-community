"""Owner-controlled application releases; all network work runs in a worker."""
from __future__ import annotations

from copy import deepcopy
import logging
import os
from pathlib import Path
import threading
import time
import uuid

import db
import app_update_worker as worker
from version import VERSION

ROOT = Path(__file__).resolve().parent
DEFAULTS = {'automatic_updates': False, 'interval_hours': 168}
log = logging.getLogger(__name__)
_RESTART = None
_LAST_ACTIVITY = time.monotonic()
_MANAGER = None
_LOCK = threading.RLock()


def set_restart_callback(callback):
    global _RESTART
    _RESTART = callback


def observe_request():
    global _LAST_ACTIVITY
    _LAST_ACTIVITY = time.monotonic()


def validation_pending():
    """Keep autosaves out until the supervisor accepts the new server."""
    return bool(os.environ.get('CHESSGYM_UPDATE_VALIDATING') and
                (Path(db.DATA_DIR) / 'app-updates' / 'pending.json').is_file())


def background_busy():
    import backup_service
    import engine_catalog_api
    import reference_library
    import resource_setup
    if backup_service.status()['running'] or reference_library.import_active():
        return True
    if engine_catalog_api.installation_manager().busy:
        return True
    resources = resource_setup._MANAGER
    if resources and resources.thread and resources.thread.is_alive():
        return True
    with db.get_conn() as conn:
        return conn.execute("SELECT 1 FROM jobs WHERE status IN ('queued','running') LIMIT 1").fetchone() is not None


class AppUpdateManager:
    def __init__(self, root, data_root):
        self.root = Path(root).resolve()
        self.data_root = Path(data_root).resolve()
        self.path = self.data_root / 'app-updates' / 'settings.json'
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = None
        self.state = {'schema': 1, 'settings': dict(DEFAULTS), 'available': None, 'job': None,
                      'last_checked': None, 'restart_required': False}
        self._reload()
        if self.state['job'] and self.state['job'].get('state') in ('checking', 'running'):
            self.state['job'].update(state='failed', stage='Préparation interrompue. Relance la mise à jour.')
            self._save()

    def _reload(self):
        saved = worker.read_json(self.path)
        if saved is not None:
            if (not isinstance(saved, dict) or saved.get('schema') != 1
                    or type(saved.get('settings', {}).get('automatic_updates')) is not bool
                    or type(saved['settings'].get('interval_hours')) is not int
                    or not 24 <= saved['settings']['interval_hours'] <= 720
                    or saved.get('job') is not None and not isinstance(saved['job'], dict)):
                raise ValueError('Les réglages de mise à jour de ChessGym sont invalides.')
            self.state.update(saved)

    def _save(self):
        worker.write_json(self.path, self.state)

    def snapshot(self):
        with self.lock:
            if not self.thread or not self.thread.is_alive():
                self._reload()
            result = deepcopy(self.state)
        supported = worker.installation(self.root)
        launcher = _RESTART is not None and os.environ.get('CHESSGYM_SUPERVISED') == '1'
        result.update(current_version=VERSION, supported=bool(supported['supported'] and launcher), restart_supported=launcher,
                      reason=supported['reason'] if not supported['supported'] else
                      (None if launcher else 'Redémarre ChessGym avec son lanceur pour activer les mises à jour de l’application.'))
        return result

    def configure(self, patch):
        if (not patch or set(patch) - {'automatic_updates', 'interval_hours'}
                or 'automatic_updates' in patch and type(patch['automatic_updates']) is not bool
                or 'interval_hours' in patch and (type(patch['interval_hours']) is not int or not 24 <= patch['interval_hours'] <= 720)):
            raise ValueError('Réglages de mise à jour invalides.')
        with self.lock:
            self.state['settings'].update(patch)
            self._save()
        return self.snapshot()

    def _progress(self, stage, progress):
        if self.stop.is_set():
            raise InterruptedError('Préparation interrompue par l’arrêt de ChessGym.')
        with self.lock:
            self.state['job'].update(stage=stage, progress=progress)
            self._save()

    def start(self, *, install=False, automatic=False):
        with self.lock:
            if self.stop.is_set():
                raise RuntimeError('ChessGym est en cours d’arrêt.')
            if self.thread and self.thread.is_alive():
                raise RuntimeError('Une mise à jour de ChessGym est déjà en cours.')
            if self.state['restart_required']:
                raise RuntimeError('Une version est déjà prête. Redémarre ChessGym pour l’appliquer.')
            status = self.snapshot()
            if not status['supported']:
                raise ValueError(status['reason'])
            self.state['job'] = {'id': uuid.uuid4().hex, 'state': 'running' if install else 'checking',
                                 'stage': 'Vérification des versions de ChessGym', 'progress': 0,
                                 'automatic': automatic, 'started_at': time.time()}
            self.state['last_checked'] = time.time()
            self._save()
            self.thread = threading.Thread(target=self._run, args=(install,), name='ChessGym-app-update', daemon=True)
            self.thread.start()
        return self.snapshot()

    def _run(self, install):
        try:
            release = worker.latest_release(self.root, VERSION)
            with self.lock:
                self.state['available'] = release
                self._save()
            if install and release:
                self._progress('Préparation de ChessGym', 5)
                plan = worker.prepare(self.root, self.data_root, release, self._progress)
                self._progress('Sauvegarde personnelle avant mise à jour', 95)
                import backup_service
                destination = self.path.parent / 'backups' / plan['id']
                destination.mkdir(parents=True, exist_ok=True)
                archive = destination / 'personal.zip'
                backup_service.build_archive(archive)
                backup_service.verify_archive(archive)
                worker.write_json(self.path.parent / 'pending.json', plan)
                with self.lock:
                    self.state['restart_required'] = True
                    self.state['job'].update(state='ready', progress=100, stage='Mise à jour prête. Redémarrage nécessaire.')
                    self._save()
            else:
                with self.lock:
                    self.state['job'].update(state='completed', progress=100,
                                             stage='Une nouvelle version de ChessGym est disponible.' if release else 'ChessGym est à jour.')
                    self._save()
        except Exception as exc:
            with self.lock:
                self.state['job'].update(state='failed', stage='La mise à jour de ChessGym a échoué.', error=str(exc)[:1000])
                self._save()

    def restart(self, *, automatic=False):
        with self.lock:
            if not self.state['restart_required']:
                raise ValueError('Aucune mise à jour de ChessGym n’est prête.')
            if not _RESTART or os.environ.get('CHESSGYM_SUPERVISED') != '1':
                raise ValueError('Redémarre ChessGym avec son lanceur pour appliquer cette mise à jour.')
            plan = worker._plan(self.data_root)
            worker.require_installation(self.root, plan['previous_commit'])
            if background_busy():
                raise RuntimeError('Attends la fin des analyses, imports et sauvegardes avant de redémarrer ChessGym.')
            if automatic and time.monotonic() - _LAST_ACTIVITY < 300:
                return self.snapshot()
            self.state['job'].update(state='restarting', stage='ChessGym redémarre pour appliquer la mise à jour.', progress=100)
            self._save()
            result = self.snapshot()
            _RESTART()
            return result

    def tick(self):
        with self.lock:
            if self.stop.is_set() or self.thread and self.thread.is_alive():
                return
            self._reload()
            settings = self.state['settings']
            if not settings['automatic_updates']:
                return
            if self.state['restart_required']:
                try:
                    self.restart(automatic=True)
                except (ValueError, RuntimeError):
                    pass
                return
            checked = self.state['last_checked']
            if checked is not None and time.time() - checked < settings['interval_hours'] * 3600:
                return
            if background_busy():
                return
            try:
                self.start(install=True, automatic=True)
            except (ValueError, RuntimeError) as exc:
                self.state['last_checked'] = time.time()
                self.state['job'] = {'id': uuid.uuid4().hex, 'state': 'failed', 'stage': 'Mise à jour automatique en attente.',
                                     'progress': 0, 'error': str(exc), 'automatic': True}
                self._save()

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join()


def manager():
    global _MANAGER
    with _LOCK:
        if _MANAGER is None:
            _MANAGER = AppUpdateManager(ROOT, db.DATA_DIR)
        return _MANAGER


def scheduler_tick():
    try:
        manager().tick()
    except Exception:
        log.exception('Application update scheduling failed')


def close():
    global _MANAGER
    with _LOCK:
        if _MANAGER is not None:
            _MANAGER.close()
            _MANAGER = None
