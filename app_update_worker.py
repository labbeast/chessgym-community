"""Release preparation and offline switch used by the local launcher.

Git operations are confined to the application checkout. Versioned runtimes,
database snapshots and the journal live in the host data directory. Nothing in
this module runs automatically merely by being imported.
"""
from __future__ import annotations

import ast
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import uuid

REPOSITORY = 'https://github.com/labbeast/chessgym-community.git'
RELEASE = re.compile(r'v?(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+))?\Z')
COMMIT = re.compile(r'[a-f0-9]{40}\Z')
PROTECTED = {'.git', '.venv', 'data', 'engines', 'output', '.tmp', '.env', 'backups', 'node_modules'}
MAX_SOURCE_BYTES = 512 * 1024 * 1024
MAX_SOURCE_FILES = 15000
RESTART_EXIT = 75


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding='utf-8')
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    if path.stat().st_size > 1024 * 1024:
        raise ValueError('Le journal de mise à jour est trop volumineux.')
    return json.loads(path.read_text(encoding='utf-8'))


def version_key(value):
    match = RELEASE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError('Version ChessGym non reconnue.')
    return tuple(map(int, match.group(1, 2, 3))) + ({'alpha': 0, 'beta': 1, 'rc': 2, None: 3}[match[4]], int(match[5] or 0))


def _run(arguments, *, cwd, timeout=90, environment=None):
    env = dict(os.environ, GIT_TERMINAL_PROMPT='0', GCM_INTERACTIVE='Never',
               GIT_SSH_COMMAND='ssh -o BatchMode=yes', PYTHONIOENCODING='utf-8')
    if environment:
        env.update(environment)
    result = subprocess.run(arguments, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            encoding='utf-8', errors='replace', timeout=timeout,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        # Credential helpers can print secrets: never publish their stderr.
        raise RuntimeError('La commande de mise à jour a échoué. Vérifie l’accès au dépôt et les dépendances du serveur.')
    return result.stdout.strip()


def git(root, *arguments, timeout=90):
    executable = shutil.which('git')
    if not executable:
        raise ValueError('Git est nécessaire pour mettre ChessGym à jour automatiquement.')
    return _run([executable, '-c', 'core.hooksPath=' + os.devnull,
                 '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never',
                 *arguments], cwd=root, timeout=timeout)


def installation(root):
    root = Path(root).resolve()
    try:
        top = Path(git(root, 'rev-parse', '--show-toplevel')).resolve()
        if top != root:
            raise ValueError('Ce dossier doit être une installation Git de ChessGym.')
        _origin(root)
        git(root, 'symbolic-ref', '--quiet', 'HEAD')
        if git(root, 'status', '--porcelain=v1', '--untracked-files=normal'):
            raise ValueError('Des fichiers locaux ont été modifiés. Enregistre ces changements avant de mettre ChessGym à jour.')
        head = git(root, 'rev-parse', 'HEAD')
        if not COMMIT.fullmatch(head):
            raise ValueError('La révision locale de ChessGym est invalide.')
        return {'supported': True, 'reason': None, 'commit': head}
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return {'supported': False, 'reason': str(exc) if isinstance(exc, ValueError) else
                'Cette installation doit provenir du dépôt Git officiel, avec une branche propre et Git disponible.'}


def _origin(root):
    remote = git(root, 'remote', 'get-url', 'origin')
    if remote not in (REPOSITORY, REPOSITORY.removesuffix('.git'),
                      'git@github.com:labbeast/chessgym-community.git'):
        raise ValueError('La mise à jour exige le dépôt officiel de ChessGym comme origine.')
    return remote


def require_installation(root, expected=None):
    result = installation(root)
    if not result['supported']:
        raise ValueError(result['reason'])
    if expected and result['commit'] != expected:
        raise ValueError('La version locale a changé pendant la préparation. Vérifie à nouveau les mises à jour.')
    return result['commit']


def latest_release(root, current_version):
    require_installation(root)
    lines = git(root, 'ls-remote', '--tags', '--refs', _origin(root), timeout=90).splitlines()
    current = version_key(current_version)
    preview = current[3] < 3
    candidates = []
    for line in lines:
        parts = line.split()
        if len(parts) != 2 or not COMMIT.fullmatch(parts[0]) or not parts[1].startswith('refs/tags/'):
            continue
        tag = parts[1].removeprefix('refs/tags/')
        if not RELEASE.fullmatch(tag):
            continue
        key = version_key(tag)
        if key > current and (preview or key[3] == 3):
            candidates.append((key, tag, parts[0]))
    if not candidates:
        return None
    _, tag, object_id = max(candidates)
    return {'version': tag.removeprefix('v'), 'tag': tag, 'object_id': object_id,
            'url': REPOSITORY.removesuffix('.git') + '/releases/tag/' + tag}


def python_path(runtime):
    return Path(runtime) / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def _extract_archive(archive, target):
    target = Path(target).resolve()
    total, members, seen = 0, [], set()
    with tarfile.open(archive, 'r:') as bundle:
        for item in bundle:
            parts = PurePosixPath(item.name).parts
            path = target.joinpath(*parts).resolve()
            if (not parts or PurePosixPath(item.name).is_absolute() or not path.is_relative_to(target)
                    or path == target or '\\' in item.name or ':' in item.name
                    or any(part in ('.', '..') or part.endswith((' ', '.')) for part in parts)
                    or parts[0].casefold() in PROTECTED or parts[0].casefold().startswith('.env')
                    or not (item.isfile() or item.isdir()) or str(path).casefold() in seen):
                raise ValueError('La version publiée contient un chemin ou un fichier non pris en charge.')
            seen.add(str(path).casefold())
            total += item.size
            if total > MAX_SOURCE_BYTES or len(seen) > MAX_SOURCE_FILES:
                raise ValueError('Les sources dépassent la taille maximale de mise à jour.')
            members.append((item, path))
        for item, path in members:
            if item.isdir():
                path.mkdir(parents=True, exist_ok=True)
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(item) as source, path.open('xb') as output:
                    shutil.copyfileobj(source, output)


def _source_version(source):
    tree = ast.parse((Path(source) / 'version.py').read_text(encoding='utf-8'))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == 'VERSION' for target in node.targets):
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                version_key(node.value.value)
                return node.value.value
    raise ValueError('La version publiée ne fournit pas son numéro de version.')


def _validate_requirements(source):
    for filename in ('requirements.txt', 'requirements.lock.txt'):
        path = Path(source) / filename
        if not path.is_file() or path.stat().st_size > 128 * 1024:
            raise ValueError('Les dépendances de cette version sont absentes ou invalides.')
        for raw in path.read_text(encoding='utf-8').splitlines():
            line = raw.strip()
            if not line or line.startswith('#') or filename == 'requirements.txt' and line == '-c requirements.lock.txt':
                continue
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*==[A-Za-z0-9][A-Za-z0-9.+_-]*', line):
                raise ValueError('Cette version ne fournit pas des dépendances figées compatibles avec la mise à jour automatique.')


def validate_changed_paths(root, data_root, paths):
    root, data_root = Path(root).resolve(), Path(data_root).resolve()
    protected = [data_root]
    for name in ('CHESSGYM_ENGINE', 'CHESSGYM_MAIA3_ROOT', 'CHESSGYM_MAIA3_PYTHON',
                 'CHESSGYM_MAIA3_CHECKPOINT', 'CHESSGYM_PUZZLE_BANK'):
        if os.environ.get(name):
            value = Path(os.environ[name]).expanduser()
            protected.append((value if value.is_absolute() else root / value).resolve())
    for value in paths:
        parts = PurePosixPath(value).parts
        path = root.joinpath(*parts).resolve()
        if (not parts or not path.is_relative_to(root) or parts[0].casefold() in PROTECTED
                or parts[0].casefold().startswith('.env')
                or any(path == target or path.is_relative_to(target) or target.is_relative_to(path) for target in protected)):
            raise ValueError('Cette version tente de modifier les données ou les environnements locaux.')


def prepare(root, data_root, release, progress):
    root, data_root = Path(root).resolve(), Path(data_root).resolve()
    previous = require_installation(root)
    if not isinstance(release, dict) or not RELEASE.fullmatch(release.get('tag', '')) or not COMMIT.fullmatch(release.get('object_id', '')):
        raise ValueError('La version à installer n’est pas valide.')
    progress('Téléchargement de la version ChessGym', 10)
    # Fetch only the selected tag, without modifying the working tree or branches.
    git(root, 'fetch', '--no-tags', _origin(root), 'refs/tags/' + release['tag'], timeout=180)
    fetched = git(root, 'rev-parse', 'FETCH_HEAD')
    if fetched != release['object_id']:
        raise ValueError('La version publiée a changé. Relance la vérification.')
    commit = git(root, 'rev-parse', 'FETCH_HEAD^{commit}')
    if not COMMIT.fullmatch(commit):
        raise ValueError('La révision téléchargée est invalide.')
    git(root, 'merge-base', '--is-ancestor', previous, commit)
    changed = git(root, 'diff', '--name-only', previous, commit).splitlines()
    validate_changed_paths(root, data_root, changed)
    base = data_root / 'app-updates'
    base.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(base).free < 2 * 1024 ** 3:
        raise ValueError('La mise à jour de ChessGym demande au moins 2 Gio libres.')
    identity = uuid.uuid4().hex
    stage = base / ('release-' + identity)
    stage.mkdir()
    archive = stage / 'source.tar'
    git(root, 'archive', '--format=tar', '--output=' + str(archive), commit)
    source = stage / 'source'
    _extract_archive(archive, source)
    archive.unlink()
    if _source_version(source) != release['version']:
        raise ValueError('Le numéro de version ne correspond pas à la version publiée.')
    for filename in ('run.py', 'app.py', 'app_update_worker.py', 'app_updates.py'):
        if not (source / filename).is_file():
            raise ValueError('Cette version ne prend pas en charge la mise à jour automatique.')
    _validate_requirements(source)
    progress('Préparation des dépendances de ChessGym', 35)
    runtime = base / 'runtimes' / identity
    runtime.parent.mkdir(exist_ok=True)
    _run([sys.executable, '-m', 'venv', str(runtime)], cwd=root, timeout=180)
    interpreter = python_path(runtime)
    _run([str(interpreter), '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
          '--no-input', '-r', str(source / 'requirements.txt')], cwd=source, timeout=1200)
    progress('Vérification de la nouvelle application', 80)
    test_data = stage / 'validation-data'
    _run([str(interpreter), '-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import app, uvicorn; print(app.VERSION)', str(source)],
         cwd=source, timeout=120, environment={'CHESSGYM_DATA_DIR': str(test_data)})
    require_installation(root, previous)
    progress('Version prête à installer au redémarrage', 90)
    return {'id': identity, 'version': release['version'], 'tag': release['tag'], 'commit': commit,
            'previous_commit': previous, 'python': str(interpreter), 'source': str(source),
            'prepared_at': time.time(), 'phase': 'prepared'}


def _plan(data_root):
    base = Path(data_root).resolve() / 'app-updates'
    plan = read_json(base / 'pending.json')
    if not isinstance(plan, dict) or not re.fullmatch('[0-9a-f]{32}', plan.get('id', '')):
        raise ValueError('Le plan de mise à jour est absent ou invalide.')
    if any(not COMMIT.fullmatch(plan.get(key, '')) for key in ('commit', 'previous_commit')):
        raise ValueError('Le plan de mise à jour contient une révision invalide.')
    expected = python_path(base / 'runtimes' / plan['id']).resolve()
    if Path(plan.get('python', '')).resolve() != expected or not expected.is_file():
        raise ValueError('Le nouvel environnement Python est absent ou invalide.')
    version_key(plan.get('version'))
    return plan


def _snapshot_database(data_root, destination):
    source = Path(data_root) / 'chessgym.sqlite3'
    if not source.exists():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True)) as incoming:
        with closing(sqlite3.connect(destination)) as outgoing:
            incoming.backup(outgoing)
            if outgoing.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('La sauvegarde avant mise à jour n’a pas passé la vérification.')
    return True


def apply_pending(root, data_root):
    """Called only after the serving process has fully exited."""
    root, data_root = Path(root).resolve(), Path(data_root).resolve()
    plan = _plan(data_root)
    validate_changed_paths(root, data_root, git(root, 'diff', '--name-only', plan['previous_commit'], plan['commit']).splitlines())
    head = require_installation(root)
    if head == plan['commit'] and plan.get('phase') in ('applying', 'applied'):
        # Recover a supervisor interruption after source replacement, without
        # overwriting the pre-migration database snapshot.
        write_json(data_root / 'app-updates' / 'runtime.json', {'id': plan['id'], 'python': plan['python']})
        return plan
    if head != plan['previous_commit']:
        raise ValueError('La version locale a changé pendant la préparation. Vérifie à nouveau les mises à jour.')
    import backup_service
    with backup_service.offline_guard():
        backup = data_root / 'app-updates' / 'backups' / plan['id'] / 'chessgym.sqlite3'
        plan['database_backup'] = str(backup) if _snapshot_database(data_root, backup) else None
        plan['previous_runtime'] = read_json(data_root / 'app-updates' / 'runtime.json')
        plan['phase'] = 'applying'
        write_json(data_root / 'app-updates' / 'pending.json', plan)
        try:
            git(root, 'merge', '--ff-only', '--no-overwrite-ignore', plan['commit'], timeout=120)
            write_json(data_root / 'app-updates' / 'runtime.json', {'id': plan['id'], 'python': plan['python']})
            plan['phase'] = 'applied'
            write_json(data_root / 'app-updates' / 'pending.json', plan)
        except Exception:
            # Only code and the runtime pointer have changed at this stage.
            # The serving process has not been restarted or migrated any data.
            if git(root, 'rev-parse', 'HEAD') == plan['commit']:
                git(root, 'reset', '--keep', plan['previous_commit'])
            write_json(data_root / 'app-updates' / 'runtime.json', plan.get('previous_runtime'))
            raise
    return plan


def rollback(root, data_root, plan):
    """Never erase concurrent edits: reset --keep fails if they conflict."""
    root, data_root = Path(root).resolve(), Path(data_root).resolve()
    if git(root, 'rev-parse', 'HEAD') != plan['commit']:
        raise ValueError('La version locale a changé; le retour automatique est suspendu.')
    if git(root, 'status', '--porcelain=v1', '--untracked-files=normal'):
        raise ValueError('Des modifications locales empêchent le retour automatique à la version précédente.')
    validate_runtime(data_root, plan.get('previous_runtime'))
    backup = plan.get('database_backup')
    expected = data_root / 'app-updates' / 'backups' / plan['id'] / 'chessgym.sqlite3'
    if backup:
        if Path(backup).resolve() != expected.resolve() or not expected.is_file():
            raise ValueError('La sauvegarde de retour est absente ou invalide.')
        with closing(sqlite3.connect(expected.resolve().as_uri() + '?mode=ro', uri=True)) as incoming:
            if incoming.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                raise ValueError('La sauvegarde de retour est absente ou invalide.')
    import backup_service
    with backup_service.offline_guard():
        git(root, 'reset', '--keep', plan['previous_commit'])
        if backup:
            # No server remains alive. Use SQLite backup so sidecar files never
            # replace or corrupt the restored database.
            with closing(sqlite3.connect(expected)) as incoming:
                with closing(sqlite3.connect(data_root / 'chessgym.sqlite3')) as outgoing:
                    incoming.backup(outgoing)
                    outgoing.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        write_json(data_root / 'app-updates' / 'runtime.json', plan.get('previous_runtime'))


def selected_python(data_root, fallback):
    base = Path(data_root).resolve() / 'app-updates'
    saved = read_json(base / 'runtime.json')
    return validate_runtime(data_root, saved) or str(fallback)


def validate_runtime(data_root, saved):
    base = Path(data_root).resolve() / 'app-updates'
    if saved is None:
        return None
    if not isinstance(saved, dict) or not re.fullmatch('[0-9a-f]{32}', saved.get('id', '')):
        raise ValueError('L’environnement ChessGym enregistré est invalide.')
    expected = python_path(base / 'runtimes' / saved['id']).resolve()
    if expected != Path(saved.get('python', '')).resolve() or not expected.is_file():
        raise ValueError('L’environnement ChessGym enregistré est introuvable.')
    return str(expected)


def _record_result(data_root, state, stage, error=None, *, preserve_pending=False):
    path = Path(data_root) / 'app-updates' / 'settings.json'
    saved = read_json(path, {})
    job = saved.get('job') or {}
    job.update(state=state, stage=stage, progress=100, error=error, finished_at=time.time())
    saved.update(job=job, restart_required=False, recovery_required=preserve_pending)
    if state == 'completed':
        saved['available'] = None
    write_json(path, saved)
    if not preserve_pending:
        (Path(data_root) / 'app-updates' / 'pending.json').unlink(missing_ok=True)


def _wait_healthy(process, port, version, timeout=60):
    deadline = time.monotonic() + timeout
    # This request is a parent-to-child local readiness check, never a download.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        try:
            with opener.open(f'http://127.0.0.1:{port}/api/status', timeout=1) as response:
                value = json.loads(response.read(65536))
            return value.get('version') == version and 'setup_required' in value
        except (OSError, ValueError, urllib.error.URLError):
            time.sleep(.25)
    return False


def stop_child(child):
    if child.poll() is not None:
        return
    if os.name == 'nt':
        # The Windows venv redirector can have a child interpreter. Terminate
        # only this supervisor-owned process tree before restoring its database.
        taskkill = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32' / 'taskkill.exe'
        subprocess.run([str(taskkill), '/PID', str(child.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        child.terminate()
    try:
        child.wait(timeout=30)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=10)


def _old_installation_intact(root, data_root):
    try:
        plan = _plan(data_root)
        return (git(root, 'rev-parse', 'HEAD') == plan['previous_commit'] and
                read_json(Path(data_root) / 'app-updates' / 'runtime.json') == plan.get('previous_runtime'))
    except Exception:
        return False


def supervise(root):
    root = Path(root).resolve()
    data_root = Path(os.environ.get('CHESSGYM_DATA_DIR', root / 'data')).resolve()
    os.environ['CHESSGYM_DATA_DIR'] = str(data_root)
    port = int(os.environ.get('CHESSGYM_PORT', '8765'))
    fallback = sys.executable
    pending_plan = None
    settings = read_json(data_root / 'app-updates' / 'settings.json', {})
    if settings.get('recovery_required'):
        # A failed rollback may have left a mixed code/schema state. Preserve
        # its journal and backup for repair instead of guessing on another run.
        print('La mise à jour demande une intervention. Consulte data/app-updates/settings.json.', file=sys.stderr)
        return 1
    if settings.get('restart_required') and (data_root / 'app-updates' / 'pending.json').is_file():
        try:
            pending_plan = apply_pending(root, data_root)
        except Exception as exc:
            intact = _old_installation_intact(root, data_root)
            _record_result(data_root, 'failed', 'La mise à jour n’a pas pu être appliquée.', str(exc), preserve_pending=not intact)
            if not intact:
                return 1
    while True:
        interpreter = selected_python(data_root, fallback)
        environment = dict(os.environ, CHESSGYM_SUPERVISED='1',
                           CHESSGYM_UPDATE_VALIDATING=pending_plan['id'] if pending_plan else '')
        child = subprocess.Popen([interpreter, str(root / 'run.py'), '--serve'], cwd=root, env=environment,
                                 creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        if pending_plan:
            if _wait_healthy(child, port, pending_plan['version']):
                _record_result(data_root, 'completed', 'ChessGym a été mis à jour et redémarré.')
                pending_plan = None
            else:
                stop_child(child)
                try:
                    rollback(root, data_root, pending_plan)
                except Exception as exc:
                    _record_result(data_root, 'failed', 'Intervention nécessaire pour redémarrer ChessGym.', str(exc), preserve_pending=True)
                    return 1
                _record_result(data_root, 'failed', 'La version précédente a été restaurée.',
                               'La nouvelle version n’a pas démarré correctement. Les données précédentes ont été restaurées.')
                pending_plan = None
                continue
        try:
            code = child.wait()
        except KeyboardInterrupt:
            stop_child(child)
            return 0
        if code != RESTART_EXIT:
            return code
        try:
            pending_plan = apply_pending(root, data_root)
        except Exception as exc:
            intact = _old_installation_intact(root, data_root)
            _record_result(data_root, 'failed', 'La mise à jour n’a pas pu être appliquée.', str(exc), preserve_pending=not intact)
            if not intact:
                return 1
            pending_plan = None
            # The serving process was stopped intentionally: relaunch the
            # unchanged current version after a failed preflight.
