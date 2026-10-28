"""Host resource onboarding and opt-in maintenance, separate from account backups.

Only the fixed engine/data catalogues can be installed. Each resource commits
independently; retrying a failed batch does not discard successful installations.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import logging
import math
from pathlib import Path
import threading
import time
import uuid

from fastapi import HTTPException

from atomic_files import replace_with_retry
import db
import engine_catalog
import engine_catalog_api

logger = logging.getLogger(__name__)
DEFAULT_SETTINGS = {'automatic_updates': False, 'interval_hours': 168}


def now():
    return datetime.now(timezone.utc).isoformat()


class ResourceSetupManager:
    def __init__(self, data_root, *, engines=None, databases=None, registry=None):
        self.path = Path(data_root) / 'resource-setup.json'
        self.engines = engines
        self.databases = databases
        self.registry = registry or engine_catalog
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.thread = None
        self.state = {'schema': 1, 'setup_complete': False, 'settings': dict(DEFAULT_SETTINGS),
                      'managed': {}, 'job': None, 'last_attempt': None}
        if self.path.exists():
            try:
                if self.path.stat().st_size > 1024 * 1024:
                    raise ValueError('size')
                saved = json.loads(self.path.read_text(encoding='utf-8'))
                if (saved.get('schema') != 1 or not isinstance(saved.get('managed'), dict)
                        or type(saved.get('setup_complete')) is not bool
                        or (saved.get('job') is not None and not isinstance(saved['job'], dict))
                        or (saved.get('last_attempt') is not None and
                            (type(saved['last_attempt']) not in (int, float) or
                             not math.isfinite(saved['last_attempt'])))
                        or type(saved.get('settings', {}).get('automatic_updates')) is not bool
                        or type(saved['settings'].get('interval_hours')) is not int
                        or not 24 <= saved['settings']['interval_hours'] <= 720):
                    raise ValueError('schema')
                self.state.update(saved)
            except (OSError, ValueError, TypeError, AttributeError) as exc:
                raise ValueError('La configuration des ressources est illisible. Vérifie resource-setup.json.') from exc
        if self.state['job'] and self.state['job'].get('state') == 'running':
            self.state['job'].update(state='failed', stage='Installation interrompue',
                                     error='Le serveur a redémarré. Relance l’installation.', finished_at=now())
            self._save()

    def _services(self):
        with self.lock:
            if self.engines is None:
                self.engines = engine_catalog_api.installation_manager()
            if self.databases is None:
                from database_resources import DatabaseResources
                self.databases = DatabaseResources(self.path.parent)

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(self.path.name + '.' + uuid.uuid4().hex + '.tmp')
        try:
            temporary.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding='utf-8')
            replace_with_retry(temporary, self.path)
        finally:
            temporary.unlink(missing_ok=True)

    def catalog(self):
        self._services()
        entries = self.registry.snapshot()['engines']
        result = []
        for item in self.engines.catalog():
            item = dict(item)
            matches = [entry for entry in entries if
                       (entry.get('model') == item['id'] if item['id'].startswith('maia3-') else
                        entry.get('kind') == 'uci' and 'stockfish' in (entry['id'] + entry['name']).lower())]
            item['installed'] = any(entry.get('available', True) for entry in matches)
            item['managed'] = any(entry.get('managed') for entry in matches)
            result.append(item)
        return result + self.databases.catalog()

    def snapshot(self):
        # Local reads only: opening Settings never starts a network request.
        with self.lock:
            result = deepcopy(self.state)
        result['resources'] = self.catalog()
        return result

    def configure(self, patch):
        with self.lock:
            self.state['settings'].update(patch)
            self._save()
        return self.snapshot()

    def complete(self):
        with self.lock:
            self.state['setup_complete'] = True
            self._save()
        return self.snapshot()

    def _progress(self, stage, progress):
        if self.stop.is_set():
            raise InterruptedError('Installation interrompue par l’arrêt du serveur. Relance-la au prochain démarrage.')
        with self.lock:
            self.state['job'].update(stage=stage, progress=round(max(0, min(100, progress)), 1))
            self._save()

    def _update_ids(self):
        known = {item['id']: item for item in self.catalog()
                 if item.get('installation_mode') != 'browser-download'}
        # Unregistering an engine or deleting a reference base is an explicit
        # choice. A scheduled update must not reinstall removed resources.
        ids = [key for key in self.state['managed'] if key in known and known[key].get('installed')]
        for item in known.values():
            if item['id'] not in ids and item.get('installed'):
                ids.append(item['id'])
        return ids

    def start_import(self, resource_id, source_path, *, use_as_masters=False):
        if not isinstance(source_path, str) or not source_path.strip():
            raise ValueError('Indique le chemin de l’archive téléchargée sur le serveur ChessGym.')
        source = Path(source_path.strip()).expanduser()
        if (not source.is_absolute() or source.is_symlink() or
                source.suffix.lower() not in ('.7z', '.pgn') or not source.is_file()):
            raise ValueError('Choisis un fichier .7z ou .pgn présent sur le serveur ChessGym.')
        return self.start([resource_id], local_import={
            'resource_id': resource_id, 'source_path': str(source.resolve()),
            'use_as_masters': bool(use_as_masters)})

    def start(self, resources=None, *, updating=False, automatic=False, local_import=None):
        with self.lock:
            self._services()
            if self.stop.is_set():
                raise RuntimeError('Le serveur est en cours d’arrêt.')
            if (self.thread and self.thread.is_alive()) or self.engines.busy:
                raise RuntimeError('Une installation est déjà en cours.')
            known = {item['id']: item for item in self.catalog()}
            ids = self._update_ids() if updating else resources
            if not isinstance(ids, list) or (not updating and not ids) or len(ids) > len(known):
                raise ValueError('Choisis les ressources à installer.')
            if any(not isinstance(key, str) or key not in known or not known[key]['available'] for key in ids):
                raise ValueError('Cette ressource ne peut pas être installée sur ce serveur.')
            if local_import is not None:
                if (updating or ids != [local_import['resource_id']] or
                        known[ids[0]].get('installation_mode') != 'browser-download'):
                    raise ValueError('Cette ressource ne prend pas en charge l’import d’une archive téléchargée.')
                if local_import.get('use_as_masters'):
                    import explorer
                    current = explorer.get_settings()
                    local_import = {**local_import, 'masters_before': {
                        key: current[key] for key in ('master_source', 'master_base_ids')}}
            elif any(known[key].get('installation_mode') == 'browser-download' for key in ids):
                raise ValueError('Télécharge cette base sur le site officiel, puis importe son archive dans les réglages.')
            if len(set(ids)) != len(ids) or sum(key.startswith('maia3-') for key in ids) > 1 and not updating:
                raise ValueError('Choisis une seule taille de modèle Maia pour la configuration initiale.')
            self.state['job'] = {'id': uuid.uuid4().hex, 'state': 'running', 'stage': 'Préparation',
                                 'progress': 0, 'resources': ids, 'results': [], 'started_at': now(),
                                 'updating': updating, 'automatic': automatic}
            self.state['last_attempt'] = time.time()
            self._save()
            self.thread = threading.Thread(target=self._run, args=(ids, updating, local_import),
                                           name='ChessGym-resources', daemon=True)
            self.thread.start()
            return deepcopy(self.state['job'])

    def _engine(self, resource_id, updating):
        before = self.registry.snapshot()
        role = 'analysis' if resource_id == 'stockfish-latest' else 'maia'
        previous = before['selected'].get(role)
        task = self.engines.start_job(resource_id)
        while True:
            task = self.engines.status(task['id'])
            if task['state'] != 'running':
                break
            # Let the existing engine installer finish its staged operation on
            # shutdown; joining this coordinator keeps the restore guard held.
            with self.lock:
                self.state['job'].update(stage=task['stage'], progress=task['progress'])
                self._save()
            time.sleep(.25)
        if task['state'] != 'completed':
            raise ValueError(task.get('error', 'L’installation du moteur a échoué.'))
        record = task['engine']
        activated = False
        activation_pending = False
        self._progress('Configuration du moteur', 99)
        current = self.registry.snapshot()
        # Preserve user choices made while a download was running, including
        # disabling the role. Updates only follow an already selected family.
        old = next((entry for entry in before['engines'] if entry['id'] == previous), {})
        same_family = (old.get('model') == resource_id if role == 'maia' else
                       old.get('id', '').startswith('stockfish-'))
        reports_active = updating and self._analysis_active()
        if current['selected'].get(role) == previous and (not updating or same_family):
            if reports_active:
                with self.lock:
                    self.state.setdefault('pending_activation', {})[role] = {'previous': previous, 'id': record['id']}
                    self._save()
                activation_pending = True
            else:
                try:
                    self.registry.select({role: record['id']}, current['revision'])
                    activated = True
                except HTTPException as exc:
                    if exc.status_code != 409:
                        raise
        return {'engine_id': record['id'], 'version': record.get('version'), 'activated': activated,
                'activation_pending': activation_pending}

    def _select_imported_masters(self, base_id, previous):
        import explorer
        # The comparison and write share one transaction so another device's
        # preference update cannot land between them and get silently replaced.
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            bases = explorer._bases(conn)
            current = explorer._read_settings(conn, bases)
            if any(current[key] != value for key, value in previous.items()):
                return False
            settings = explorer.validate_settings(
                {'master_source': 'local', 'master_base_ids': [base_id]}, current, bases)
            conn.execute('INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                         (explorer.SETTINGS_KEY, json.dumps(settings)))
        return True

    def _run(self, ids, updating, local_import=None):
        try:
            for resource_id in ids:
                if self.stop.is_set():
                    raise InterruptedError('Installation interrompue par l’arrêt du serveur.')
                try:
                    self._progress('Préparation de ' + resource_id, 0)
                    if resource_id.startswith(('stockfish-', 'maia3-')):
                        result = self._engine(resource_id, updating)
                    elif local_import is not None:
                        result = self.databases.install(resource_id, self._progress,
                                                        source_path=local_import['source_path'])
                        if local_import.get('use_as_masters'):
                            selected = self._select_imported_masters(result['base_id'], local_import['masters_before'])
                            result = {**result, 'masters_selected': selected}
                    else:
                        result = self.databases.install(resource_id, self._progress)
                    with self.lock:
                        self.state['managed'][resource_id] = {**result, 'installed_at': now()}
                        self.state['job']['results'].append({'id': resource_id, 'state': 'completed', **result})
                        self._save()
                except InterruptedError:
                    raise
                except Exception as exc:
                    message = str(exc.detail if isinstance(exc, HTTPException) else exc)[:1000]
                    with self.lock:
                        self.state['job']['results'].append({'id': resource_id, 'state': 'failed', 'error': message})
                        self._save()
            failed = any(item['state'] == 'failed' for item in self.state['job']['results'])
            with self.lock:
                self.state['job'].update(state='failed' if failed else 'completed', progress=100,
                                         stage='Certaines ressources nécessitent une nouvelle tentative.' if failed else
                                         ('Ressources à jour' if updating else 'Installation terminée'), finished_at=now())
                self._save()
        except Exception as exc:
            with self.lock:
                self.state['job'].update(state='failed', error=str(exc)[:1000],
                                         stage='Installation interrompue', finished_at=now())
                self._save()

    def tick(self):
        with self.lock:
            settings = self.state['settings']
            if self.stop.is_set():
                return
            pending = self.state.get('pending_activation', {})
            if pending and not self._analysis_active():
                for role, target in list(pending.items()):
                    current = self.registry.snapshot()
                    if current['selected'].get(role) == target['previous']:
                        try:
                            self.registry.select({role: target['id']}, current['revision'])
                        except HTTPException as exc:
                            if exc.status_code not in (404, 409, 422):
                                raise
                    del pending[role]
                self._save()
            if not settings['automatic_updates']:
                return
            last = self.state.get('last_attempt')
            if last is not None and time.time() - last < settings['interval_hours'] * 3600:
                return
            if self.thread and self.thread.is_alive():
                return
            # Report jobs pin an engine identity across all positions.
            if self._analysis_active():
                return
            try:
                self.start(updating=True, automatic=True)
            except RuntimeError:
                return

    def _analysis_active(self):
        with db.get_conn() as conn:
            return conn.execute("SELECT 1 FROM jobs WHERE kind='analyse' AND status IN ('queued','running') LIMIT 1").fetchone() is not None

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join()


_MANAGER = None
_LOCK = threading.RLock()


def manager():
    global _MANAGER
    with _LOCK:
        if _MANAGER is None:
            _MANAGER = ResourceSetupManager(db.DATA_DIR)
        return _MANAGER


def setup_required():
    try:
        return not manager().state['setup_complete']
    except ValueError:
        # Keep login accessible so the owner can inspect the Settings error.
        return True


def scheduler_tick():
    try:
        manager().tick()
    except Exception:
        logger.exception('Resource maintenance failed')


def close():
    global _MANAGER
    with _LOCK:
        if _MANAGER:
            _MANAGER.close()
            _MANAGER = None
