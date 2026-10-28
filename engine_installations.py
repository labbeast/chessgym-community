"""Owner-triggered installations from a small, verified engine catalogue.

Downloads are staged and checked before a registry callback publishes them.
No job selects an engine, edits an existing installation, or writes a PGN base.
Maia updates stay pinned to the source/checkpoints reviewed by ChessGym.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import tarfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
import zipfile

import chess
import chess.engine

from scripts import install_maia


STOCKFISH_RELEASE = 'https://api.github.com/repos/official-stockfish/Stockfish/releases/latest'
STOCKFISH_REPOSITORY = 'https://github.com/official-stockfish/Stockfish'
MAIA_COMMIT = 'https://api.github.com/repos/CSSLab/maia3/commits/main'
MAX_DOWNLOAD = 300 * 1024 * 1024
MAX_EXPANDED = 1024 * 1024 * 1024
MAX_ENTRIES = 12000
_DOWNLOAD_HOSTS = frozenset(('github.com', 'api.github.com', 'huggingface.co', 'objects.githubusercontent.com',
                              'release-assets.githubusercontent.com'))


def _now():
    return datetime.now(timezone.utc).isoformat()


def _digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def _safe_url(url):
    parsed = urllib.parse.urlsplit(url)
    if (parsed.scheme != 'https' or parsed.hostname not in _DOWNLOAD_HOSTS
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise ValueError('Adresse de téléchargement officielle non reconnue.')
    return url


class _OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        _safe_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def _open(url, *, timeout=30):
    request = urllib.request.Request(_safe_url(url), headers={
        'User-Agent': 'ChessGym-Engine-Manager/1.0', 'Accept': 'application/vnd.github+json'})
    return urllib.request.build_opener(_OfficialRedirect()).open(request, timeout=timeout)


def _json(url):
    with _open(url) as response:
        data = response.read(1024 * 1024 + 1)
    if len(data) > 1024 * 1024:
        raise ValueError('La réponse du catalogue est trop volumineuse.')
    result = json.loads(data)
    if not isinstance(result, dict):
        raise ValueError('Réponse du catalogue non reconnue.')
    return result


def _platform_asset():
    machine = platform.machine().lower()
    system = platform.system().lower()
    arch = {'amd64': 'x86-64', 'x86_64': 'x86-64', 'aarch64': 'arm64',
            'arm64': 'arm64', 'riscv64': 'riscv64'}.get(machine)
    if system == 'darwin' and arch in ('x86-64', 'arm64'):
        return 'stockfish-macos-universal.tar.gz'
    if system in ('windows', 'linux') and arch in ('x86-64', 'arm64'):
        extension = 'zip' if system == 'windows' else 'tar.gz'
        return f'stockfish-{system}-{arch}-universal.{extension}'
    if system == 'linux' and arch == 'riscv64':
        return 'stockfish-linux-riscv64-universal.tar.gz'
    return None


def _stockfish_release():
    release = _json(STOCKFISH_RELEASE)
    tag = release.get('tag_name', '')
    version = re.fullmatch(r'sf_([0-9]+(?:\.[0-9]+)?)', tag) if isinstance(tag, str) else None
    if release.get('draft') or release.get('prerelease') or not version:
        raise ValueError('Aucune version stable de Stockfish reconnue.')
    expected_name = _platform_asset()
    asset = next((item for item in release.get('assets', [])
                  if isinstance(item, dict) and item.get('name') == expected_name), None)
    if asset is None:
        raise ValueError('Aucun paquet Stockfish compatible avec ce serveur dans cette version.')
    expected_url = f'{STOCKFISH_REPOSITORY}/releases/download/{tag}/{expected_name}'
    digest = asset.get('digest', '')
    size = asset.get('size')
    if (asset.get('browser_download_url') != expected_url
            or not isinstance(digest, str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', digest)
            or not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_DOWNLOAD):
        raise ValueError('Le paquet Stockfish ne fournit pas les garanties de vérification attendues.')
    return {'version': version[1], 'tag': tag, 'name': expected_name,
            'url': expected_url, 'sha256': digest[7:], 'bytes': size,
            'release_url': f'{STOCKFISH_REPOSITORY}/releases/tag/{tag}',
            'published_at': release.get('published_at')}


def _download(spec, destination, progress):
    """No partially downloaded archive is ever made available to extraction."""
    destination = Path(destination)
    temporary = destination.with_suffix(destination.suffix + '.part')
    total, hasher, started = 0, hashlib.sha256(), time.monotonic()
    try:
        with _open(spec['url'], timeout=45) as response, temporary.open('xb') as stream:
            while data := response.read(1024 * 1024):
                total += len(data)
                if total > spec['bytes'] or total > MAX_DOWNLOAD:
                    raise ValueError('Le téléchargement dépasse la taille attendue.')
                if time.monotonic() - started > 900:
                    raise TimeoutError('Le téléchargement a dépassé le délai disponible.')
                hasher.update(data)
                stream.write(data)
                progress(total / spec['bytes'])
        if total != spec['bytes'] or hasher.hexdigest() != spec['sha256']:
            raise ValueError('L’empreinte SHA-256 du téléchargement ne correspond pas au paquet officiel.')
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def _archive_target(root, name):
    """Reject traversal, Windows aliases/ADS, symlinks and ambiguous members."""
    path = PurePosixPath(name)
    if (not name or '\\' in name or ':' in name or '\x00' in name or path.is_absolute()
            or any(part in ('', '.', '..') for part in name.rstrip('/').split('/'))
            or any(part.endswith((' ', '.')) for part in path.parts)
            or any(part.split('.')[0].upper() in {'CON', 'PRN', 'AUX', 'NUL',
                    *('COM' + str(n) for n in range(1, 10)),
                    *('LPT' + str(n) for n in range(1, 10))} for part in path.parts)):
        raise ValueError('Chemin non sûr dans le paquet du moteur.')
    target = (root / Path(*path.parts)).resolve()
    if target == root or not target.is_relative_to(root):
        raise ValueError('Le paquet sort du dossier d’installation.')
    return target


def _extract(archive, destination):
    """Validate the whole archive before writing; never use extractall."""
    root = Path(destination).resolve()
    found, seen, total = [], set(), 0

    def accept(name, size, directory=False, mode=0):
        nonlocal total
        target = _archive_target(root, name)
        key = str(target).casefold()
        if key in seen:
            raise ValueError('Fichier dupliqué dans le paquet du moteur.')
        seen.add(key)
        total += size
        if size < 0 or total > MAX_EXPANDED or len(seen) > MAX_ENTRIES:
            raise ValueError('Le contenu du paquet dépasse la taille autorisée.')
        return target

    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as bundle:
            for item in bundle.infolist():
                mode = item.external_attr >> 16
                if (stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR))
                        or item.flag_bits & 1):
                    raise ValueError('Type de fichier non autorisé dans le paquet du moteur.')
                target = accept(item.orig_filename, item.file_size)
                if not item.is_dir():
                    found.append((item, target))
            for item, target in found:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
    else:
        with tarfile.open(archive, 'r:gz') as bundle:
            for item in bundle:
                if not (item.isfile() or item.isdir()):
                    raise ValueError('Liens et fichiers spéciaux interdits dans le paquet du moteur.')
                target = accept(item.name, item.size)
                if item.isfile():
                    found.append((item, target))
            for item, target in found:
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(item) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output, 1024 * 1024)
                target.chmod(item.mode & 0o755)
    if not found:
        raise ValueError('Le paquet du moteur est vide.')
    return [target for _, target in found]


def _probe_stockfish(path):
    with chess.engine.SimpleEngine.popen_uci(str(path), timeout=20) as engine:
        if 'Stockfish' not in engine.id.get('name', ''):
            raise ValueError('Le paquet ne se présente pas comme Stockfish.')
        options = engine.options
        required = {'Skill Level', 'MultiPV', 'Threads', 'Hash'}
        if not required.issubset(options):
            raise ValueError('Ce moteur ne fournit pas les options attendues par ChessGym.')
        engine.configure({'Threads': 1, 'Hash': 16})
        board = chess.Board()
        response = engine.play(board, chess.engine.Limit(time=.05))
        if response.move not in board.legal_moves:
            raise ValueError('Le moteur n’a pas renvoyé un coup légal.')
        return {'name': engine.id['name'], 'move': response.move.uci()}


def _probe_maia(root, model):
    arguments = [str(install_maia.python_path(root)), '-I', '-u', '-m', 'maia3.uci',
                 '--model', model, '--checkpoint-path', str(root / 'models' / f'{model}.pt'),
                 '--device', 'cpu', '--no-use-amp', '--use-uci-history', '--local-files-only',
                 '--multipv', '1', '--temperature', '1', '--top-p', '1', '--seed', '0']
    with chess.engine.SimpleEngine.popen_uci(arguments, timeout=90,
                                           env=install_maia.runtime_environment()) as engine:
        if 'Elo' not in engine.options:
            raise ValueError('Maia 3 ne fournit pas l’option de niveau attendue.')
        engine.configure({'Elo': 1500})
        board = chess.Board()
        answer = engine.play(board, chess.engine.Limit(nodes=1))
        if answer.move not in board.legal_moves:
            raise ValueError('Maia 3 n’a pas renvoyé un coup légal.')
        return {'name': engine.id.get('name', 'Maia 3'), 'move': answer.move.uci()}


def _link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError:
        shutil.copy2(source, target)
    return target


class EngineInstallationManager:
    def __init__(self, project_root, *, register=None):
        self.project_root = Path(project_root).resolve()
        self.root = self.project_root / 'engines' / 'managed'
        self.register = register or (lambda value: value)
        self._lock = threading.RLock()
        self._job = None
        self._thread = None
        self._updates = None
        # A process restart cannot safely continue a half-finished installation.
        try:
            record = self.root / 'install-job.json'
            if record.stat().st_size <= 64 * 1024:
                value = json.loads(record.read_text(encoding='utf-8'))
                if isinstance(value, dict) and value.get('state') in ('running', 'completed', 'failed'):
                    self._job = value
                    if value['state'] == 'running':
                        value.update(state='failed', stage='Installation interrompue',
                                     error='Le serveur a redémarré. Relancez l’installation.', finished_at=_now())
        except (OSError, ValueError):
            pass

    @property
    def busy(self):
        with self._lock:
            return bool(self._job and self._job['state'] == 'running')

    def catalog(self):
        return [
            {'id': 'stockfish-latest', 'name': 'Stockfish', 'kind': 'uci',
             'version': (self._updates or {}).get('stockfish', {}).get('version', '19'),
             'available': _platform_asset() is not None,
             'description': 'Dernière version stable officielle, adaptée au serveur.',
             'source_url': STOCKFISH_REPOSITORY, 'license': 'GPL-3.0'},
            *({'id': alias, 'name': 'Maia 3 · ' + alias.removeprefix('maia3-').upper(),
               'kind': 'maia3', 'model': alias, 'version': install_maia.SOURCE_COMMIT[:8],
               'available': True, 'download_bytes': info['bytes'],
               'description': 'Modèle officiel validé. Réutilise les fichiers locaux vérifiés lorsqu’ils existent.',
               'source_url': 'https://huggingface.co/' + info['repo'], 'license': info['license']}
              for alias, info in install_maia.MODELS.items()),
        ]

    def check_updates(self):
        result = {'checked_at': _now(), 'errors': []}
        try:
            release = _stockfish_release()
            result['stockfish'] = {'version': release['version'], 'release_url': release['release_url'],
                                   'available': True, 'download_bytes': release['bytes'],
                                   'sha256': release['sha256']}
        except Exception as error:
            result['errors'].append({'engine': 'stockfish', 'message': str(error)[:500]})
        maia = {'version': install_maia.SOURCE_COMMIT[:8], 'source_commit': install_maia.SOURCE_COMMIT,
                'automatic_update_supported': False, 'models': []}
        try:
            commit = _json(MAIA_COMMIT).get('sha', '')
            if not re.fullmatch('[0-9a-f]{40}', commit):
                raise ValueError('Révision Maia 3 non reconnue.')
            maia.update(upstream_commit=commit, new_upstream=commit != install_maia.SOURCE_COMMIT)
        except Exception as error:
            result['errors'].append({'engine': 'maia3', 'message': str(error)[:500]})
        for alias, info in install_maia.MODELS.items():
            # Compare upstream revisions without downloading/executing new weights.
            model = {'id': alias, 'revision': info['revision'], 'sha256': info['sha256']}
            try:
                upstream = _json('https://huggingface.co/api/models/' + info['repo']).get('sha', '')
                if not re.fullmatch('[0-9a-f]{40}', upstream):
                    raise ValueError('Révision du modèle Maia 3 non reconnue.')
                model.update(upstream_revision=upstream, new_upstream=upstream != info['revision'])
                maia['new_upstream'] = maia.get('new_upstream', False) or model['new_upstream']
            except Exception as error:
                result['errors'].append({'engine': alias, 'message': str(error)[:500]})
            maia['models'].append(model)
        maia['description'] = ('Une révision plus récente existe. Elle doit être validée avant d’être proposée ici.'
                               if maia.get('new_upstream') else 'Les modèles proposés utilisent la révision validée de Maia 3.')
        result['maia3'] = maia
        with self._lock:
            self._updates = result
        return json.loads(json.dumps(result))

    def status(self, job_id=None):
        with self._lock:
            if not self._job or (job_id and self._job.get('id') != job_id):
                return None
            return json.loads(json.dumps(self._job))

    def _update(self, **values):
        with self._lock:
            self._job.update(values)
            self.root.mkdir(parents=True, exist_ok=True)
            temporary = self.root / 'install-job.json.part'
            temporary.write_text(json.dumps(self._job, ensure_ascii=False, indent=2), encoding='utf-8')
            temporary.replace(self.root / 'install-job.json')

    def start_job(self, catalog_id):
        known = {entry['id']: entry for entry in self.catalog()}
        if not isinstance(catalog_id, str) or catalog_id not in known:
            raise ValueError('Choisissez un moteur dans le catalogue officiel.')
        if not known[catalog_id]['available']:
            raise ValueError('Ce moteur ne peut pas être installé automatiquement sur ce serveur.')
        with self._lock:
            if self.busy:
                raise RuntimeError('Une installation de moteur est déjà en cours.')
            self._job = {'id': uuid.uuid4().hex, 'catalog_id': catalog_id, 'state': 'running',
                         'stage': 'Préparation', 'progress': 0, 'started_at': _now()}
            self._update()
            self._thread = threading.Thread(target=self._run, args=(catalog_id,),
                                            name='chessgym-engine-install', daemon=True)
            self._thread.start()
            return self.status()

    def _run(self, catalog_id):
        stage = self.root / ('.staging-' + self._job['id'])
        try:
            stage.mkdir(parents=True)
            spec = self._install_stockfish(stage) if catalog_id == 'stockfish-latest' else self._install_maia(stage, catalog_id)
            self._update(stage='Ajout aux moteurs disponibles', progress=98)
            record = self.register(spec)
            self._update(state='completed', stage='Moteur installé', progress=100,
                         engine=record, finished_at=_now())
        except Exception as error:
            self._update(state='failed', stage='Échec de l’installation', error=str(error)[:1000], finished_at=_now())
        finally:
            # Only this generated staging directory is eligible for cleanup.
            if stage.exists() and stage.resolve().parent == self.root.resolve() and stage.name.startswith('.staging-'):
                shutil.rmtree(stage)

    def _install_stockfish(self, stage):
        self._update(stage='Vérification de la version officielle', progress=2)
        release = _stockfish_release()
        identity = f"stockfish-{release['version']}-{release['sha256'][:12]}"
        final = self.root / identity
        if final.exists():
            # A local manifest is not a trust anchor. Re-check existing files
            # against the archive hash supplied by the official release API.
            source = _archive_target(final.resolve(), release['name'])
            if not source.is_file() or _digest(source) != release['sha256']:
                raise ValueError('L’archive Stockfish conservée ne correspond plus au paquet officiel.')
            verification = stage / 'verification'
            verified = _extract(source, verification)
            for path in verified:
                existing = _archive_target((final / 'package').resolve(), path.relative_to(verification).as_posix())
                if not existing.is_file() or _digest(existing) != _digest(path):
                    raise ValueError('Un fichier Stockfish installé diffère du paquet officiel.')
            spec = self._existing(final, identity, probe=False)
            executable = Path(spec['path']).resolve()
            trusted = {(final / 'package' / path.relative_to(verification)).resolve() for path in verified}
            if (executable not in trusted or not executable.name.startswith('stockfish-')
                    or (executable.suffix.lower() != '.exe' if os.name == 'nt' else '.' in executable.name)):
                raise ValueError('L’exécutable Stockfish ne provient pas du paquet officiel.')
            _probe_stockfish(executable)
            return spec
        archive = stage / release['name']
        self._update(stage='Téléchargement de Stockfish', progress=5)
        _download(release, archive, lambda amount: self._update(progress=round(5 + amount * 65, 1)))
        self._update(stage='Vérification et extraction', progress=72)
        files = _extract(archive, stage / 'package')
        executables = [path for path in files if path.name.startswith('stockfish-')
                       and (path.suffix.lower() == '.exe' if os.name == 'nt' else '.' not in path.name)]
        if len(executables) != 1:
            raise ValueError('Le paquet ne contient pas un exécutable Stockfish unique.')
        if not any(path.name.lower() in ('copying', 'license', 'copying.txt', 'license.txt') for path in files):
            raise ValueError('La licence de Stockfish est absente du paquet.')
        self._update(stage='Test du moteur sur une position réelle', progress=85)
        result = _probe_stockfish(executables[0])
        relative = executables[0].relative_to(stage)
        spec = {'id': identity, 'name': result['name'], 'kind': 'uci', 'version': release['version'],
                'path': str(final / relative), 'managed_root': str(final),
                'capabilities': {'analysis': True, 'play': True, 'strength': True},
                'source_url': release['release_url'], 'sha256': _digest(executables[0])}
        manifest = {'schema': 1, 'installed_at': _now(), 'engine': spec, 'archive': release,
                    'files': {path.relative_to(stage).as_posix(): _digest(path) for path in files}, 'test': result}
        self._publish(stage, final, manifest)
        return spec

    def _existing(self, final, identity, *, probe=True):
        manifest = json.loads((final / 'installation.json').read_text(encoding='utf-8'))
        spec = manifest.get('engine', {})
        if spec.get('id') != identity or spec.get('managed_root') != str(final):
            raise ValueError('Ce dossier contient une installation qui ne correspond pas au catalogue.')
        executable = Path(spec.get('path', '')).resolve()
        if not executable.is_relative_to(final.resolve()):
            raise ValueError('Le chemin du moteur sort de son installation.')
        for name, expected in manifest.get('files', {}).items():
            target = _archive_target(final.resolve(), name)
            if not target.is_file() or _digest(target) != expected:
                raise ValueError('Un fichier du moteur installé a été modifié. Conservez cette version et choisissez un autre dossier.')
        if not manifest.get('files'):
            raise ValueError('L’installation n’a pas de manifeste de vérification.')
        if spec.get('kind') == 'uci':
            if probe:
                _probe_stockfish(spec['path'])
        else:
            install_maia.verify(final)
            _probe_maia(final, spec['model'])
        return spec

    def _publish(self, stage, final, manifest):
        (stage / 'installation.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
        stage.rename(final)

    def _install_maia(self, stage, model):
        info = install_maia.MODELS[model]
        identity = f"{model}-{install_maia.SOURCE_COMMIT[:8]}-{info['revision'][:8]}"
        final = self.root / identity
        self._update(stage='Vérification des fichiers Maia 3 locaux', progress=5)
        if final.exists():
            return self._existing(final, identity)
        current = self.project_root / 'engines' / 'maia3'
        current_valid = False
        try:
            install_maia.verify(current)
            current_valid = True
        except Exception:
            # Existing unverified files are never reused or repaired in place.
            pass
        if current_valid:
            manifest = json.loads((current / 'manifest.json').read_text(encoding='utf-8'))
            if model in manifest['models']:
                self._update(stage='Test de Maia 3 sur une position réelle', progress=85)
                _probe_maia(current, model)
                return {'id': identity, 'name': 'Maia 3 · ' + model.removeprefix('maia3-').upper(),
                        'kind': 'maia3', 'version': install_maia.SOURCE_COMMIT[:8],
                        'path': str(current), 'model': model, 'managed_root': None,
                        'capabilities': {'analysis': False, 'play': True, 'strength': True},
                        'source_url': 'https://huggingface.co/' + info['repo'], 'sha256': info['sha256']}
            # Only a byte-verified identical runtime is shared through immutable
            # hardlinks. No pip operation is ever run against this cloned runtime.
            self._update(stage='Réutilisation du runtime Maia 3 vérifié', progress=12)
            shutil.copytree(current / 'runtime', stage / 'runtime', copy_function=_link_or_copy, symlinks=True)
            _link_or_copy(current / 'maia3-source.zip', stage / 'maia3-source.zip')
        self._update(stage='Installation du modèle Maia 3', progress=20)
        install_maia.install(stage, model=model, models_only=current_valid)
        self._update(stage='Vérification de Maia 3 et du modèle', progress=85)
        install_maia.verify(stage)
        result = _probe_maia(stage, model)
        # The isolated venv is relocatable for Python -I -m, which is the only
        # invocation used by ChessGym. Generated console scripts are not used.
        spec = {'id': identity, 'name': 'Maia 3 · ' + model.removeprefix('maia3-').upper(),
                'kind': 'maia3', 'version': install_maia.SOURCE_COMMIT[:8], 'path': str(final),
                'model': model, 'managed_root': str(final),
                'capabilities': {'analysis': False, 'play': True, 'strength': True},
                'source_url': 'https://huggingface.co/' + info['repo'], 'sha256': info['sha256']}
        manifest = json.loads((stage / 'manifest.json').read_text(encoding='utf-8'))
        self._publish(stage, final, {'schema': 1, 'installed_at': _now(), 'engine': spec,
                                    'files': {name: value['sha256'] for name, value in manifest['files'].items()},
                                    'test': result})
        try:
            install_maia.verify(final)
        except Exception:
            # The new directory has not been registered. Put it back in this
            # job's staging area so failed relocation can be retried cleanly.
            final.rename(stage)
            raise
        return spec
