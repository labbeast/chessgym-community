"""Host-local engine registrations, separate from portable account preferences.

Discovery is a one-time seed. Once a catalogue exists, a disabled or removed
engine never comes back through an implicit fallback. All writes are atomic and
serialized; slow executable validation happens before a short commit lock.
"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import uuid

import chess
import chess.engine
from fastapi import HTTPException

import db

ROOT = Path(__file__).resolve().parent
_LOCK = threading.RLock()
_CACHE = None


def catalog_path():
    return Path(db.DATA_DIR) / 'engine-catalog.json'


def native_discovery():
    configured = os.environ.get('CHESSGYM_ENGINE')
    if configured:
        value = Path(configured).expanduser()
        return str(value.resolve()) if value.is_file() else None
    root = ROOT / 'engines'
    bundled = root / 'stockfish'
    preferred = ([p for p in bundled.glob('stockfish*.exe') if p.is_file()] if os.name == 'nt' else
                 [p for p in bundled.glob('stockfish*') if p.is_file() and p.suffix.lower() != '.exe' and os.access(p, os.X_OK)])
    if preferred:
        return str(sorted(preferred)[0].resolve())
    candidates = list(root.rglob('stockfish*.exe')) if os.name == 'nt' and root.exists() else []
    if os.name != 'nt' and root.exists():
        candidates += [p for p in root.rglob('stockfish*') if p.is_file() and p.suffix.lower() != '.exe' and os.access(p, os.X_OK)]
    # Fresh downloaded packages are not selected by discovery before registration.
    candidates = [p for p in candidates if 'managed' not in p.relative_to(root).parts]
    if candidates:
        return str(sorted(candidates)[0].resolve())
    return shutil.which('stockfish') or ('/usr/games/stockfish' if Path('/usr/games/stockfish').is_file() else None)


def default_maia_root():
    return Path(os.environ.get('CHESSGYM_MAIA3_ROOT', ROOT / 'engines' / 'maia3')).expanduser().resolve()


def _manifest(root):
    try:
        file = Path(root) / 'manifest.json'
        if file.stat().st_size > 256 * 1024:
            return {}
        value = json.loads(file.read_text(encoding='utf-8'))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _capabilities(skill=False):
    return {'analysis': True, 'play': True, 'skill': skill, 'skills': list(range(21)) if skill else [20]}


def _seed():
    entries = []
    native = native_discovery()
    if native:
        entries.append({'id': 'stockfish-default', 'name': 'Stockfish', 'kind': 'uci', 'path': native,
                        'version': '', 'managed': False, 'capabilities': _capabilities(True)})
    root = default_maia_root()
    manifest = _manifest(root)
    models = manifest.get('models', {})
    for model in ('maia3-5m', 'maia3-23m', 'maia3-79m'):
        spec = models.get(model, {}) if isinstance(models, dict) else {}
        path = root / spec.get('path', f'models/{model}.pt') if isinstance(spec, dict) else root / '__missing__'
        if path.is_file() and path.resolve().is_relative_to(root):
            entries.append({'id': model, 'name': 'Maia 3 · ' + model.split('-')[-1].upper(), 'kind': 'maia',
                            'path': str(root), 'model': model, 'version': manifest.get('source', {}).get('commit', ''),
                            'managed': True, 'managed_root': str(root),
                            'capabilities': {'analysis': False, 'play': True, 'skill': False, 'skills': []}})
    preferred = os.environ.get('CHESSGYM_MAIA3_MODEL', manifest.get('default_model', 'maia3-5m'))
    return {'version': 1, 'revision': 0, 'engines': entries,
            'selected': {'analysis': 'stockfish-default' if native else None,
                         'maia': preferred if any(x['id'] == preferred for x in entries) else None}}


def _read(*, initialize=False):
    global _CACHE
    file = catalog_path()
    if not file.exists():
        if not initialize:
            return None
        state = _seed()
        _write(state)
        return state
    try:
        stat = file.stat()
        key = (str(file.resolve()), stat.st_mtime_ns, stat.st_size)
        if _CACHE and _CACHE[0] == key:
            return deepcopy(_CACHE[1])
        if stat.st_size > 1024 * 1024:
            raise ValueError('size')
        state = json.loads(file.read_text(encoding='utf-8'))
        if (not isinstance(state, dict) or state.get('version') != 1 or
                not isinstance(state.get('engines'), list) or not isinstance(state.get('selected'), dict) or
                type(state.get('revision')) is not int):
            raise ValueError('schema')
        ids = set()
        for entry in state['engines']:
            if (not isinstance(entry, dict) or entry.get('kind') not in ('uci', 'maia') or
                    not isinstance(entry.get('id'), str) or entry['id'] in ids or
                    not isinstance(entry.get('path'), str) or not Path(entry['path']).is_absolute()):
                raise ValueError('entry')
            ids.add(entry['id'])
        if any(value is not None and value not in ids for value in state['selected'].values()):
            raise ValueError('selection')
        _CACHE = key, deepcopy(state)
        return state
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise HTTPException(503, 'Le catalogue local des moteurs est illisible. Restaure son fichier de configuration.') from exc


def _write(state):
    global _CACHE
    file = catalog_path()
    file.parent.mkdir(parents=True, exist_ok=True)
    tmp = file.with_name(file.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with tmp.open('w', encoding='utf-8') as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, file)
        _CACHE = None
    except OSError as exc:
        raise HTTPException(503, 'Impossible de conserver les réglages des moteurs.') from exc
    finally:
        tmp.unlink(missing_ok=True)


def _entry(state, engine_id):
    for item in state['engines']:
        if item['id'] == engine_id:
            return item
    raise HTTPException(404, 'Moteur introuvable.')


def _check_revision(state, expected_revision):
    if expected_revision is not None and state['revision'] != expected_revision:
        raise HTTPException(409, 'Les moteurs ont changé. Actualise les réglages avant de réessayer.')


def _available(item):
    path = Path(item['path'])
    if item['kind'] == 'uci':
        return path.is_file()
    manifest = _manifest(path)
    models = manifest.get('models', {})
    spec = models.get(item.get('model'), {}) if isinstance(models, dict) else {}
    if not isinstance(spec, dict):
        return False
    model_path = path / spec.get('path', f'models/{item.get("model")}.pt')
    python_path = path / manifest.get('python', 'runtime/Scripts/python.exe' if os.name == 'nt' else 'runtime/bin/python')
    return bool(model_path.is_file() and model_path.resolve().is_relative_to(path.resolve()) and
                Path(os.path.abspath(python_path)).is_relative_to(path.resolve()) and python_path.is_file())


def _public(state):
    value = deepcopy(state)
    for item in value['engines']:
        item['available'] = _available(item)
        item['active'] = [role for role, current in state['selected'].items() if current == item['id']]
        item.setdefault('model', None)
        item.setdefault('version', '')
    return value


def snapshot():
    with _LOCK:
        return _public(_read(initialize=True))


def configuration_lock():
    return _LOCK


def selection(role):
    """Return (catalogue exists, selected record); None means explicitly disabled."""
    with _LOCK:
        state = _read()
        if state is None:
            return False, None
        value = state['selected'].get(role)
        return True, deepcopy(_entry(state, value)) if value else None


def fingerprint(path):
    try:
        stat = Path(path).stat()
        value = f'{Path(path).resolve()}:{stat.st_mtime_ns}:{stat.st_size}'
    except (OSError, TypeError):
        value = str(path)
    return hashlib.sha256(value.encode()).hexdigest()[:24]


def _native_path(path):
    if not isinstance(path, str) or not path or len(path) > 4096 or any(ord(c) < 32 for c in path):
        raise HTTPException(422, 'Indique le chemin absolu du fichier exécutable du moteur.')
    value = Path(path)
    if not value.is_absolute() or not value.is_file():
        raise HTTPException(422, 'Le fichier du moteur doit exister sur ce serveur, avec un chemin absolu.')
    if os.name == 'nt' and value.suffix.lower() != '.exe':
        raise HTTPException(422, 'Choisis un exécutable UCI .exe, sans commande ni arguments.')
    if os.name != 'nt' and not os.access(value, os.X_OK):
        raise HTTPException(422, 'Le fichier du moteur doit être exécutable.')
    return str(value.resolve())


def probe_native(path):
    """Explicit bounded UCI handshake and legal move; never launches a shell."""
    path = _native_path(path)
    runtime = None
    try:
        kwargs = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
        runtime = chess.engine.SimpleEngine.popen_uci([path], timeout=4, **kwargs)
        options = runtime.options
        config = {name: value for name, value in {'Threads': 1, 'Hash': 16}.items() if name in options}
        if config:
            runtime.configure(config)
        board = chess.Board()
        reply = runtime.play(board, chess.engine.Limit(time=.05))
        if reply.move not in board.legal_moves:
            raise ValueError('illegal move')
        return {'name': str(runtime.id.get('name') or Path(path).stem)[:120],
                'version': str(runtime.id.get('name') or '')[:160],
                'capabilities': _capabilities('Skill Level' in options)}
    except (OSError, ValueError, TimeoutError, chess.engine.EngineError) as exc:
        raise HTTPException(422, 'Ce fichier ne répond pas comme un moteur UCI valide, ou n’a pas fourni de coup légal.') from exc
    finally:
        if runtime is not None:
            runtime.close()


def _name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 120 or any(ord(c) < 32 for c in value):
        raise HTTPException(422, 'Le nom du moteur doit contenir de 1 à 120 caractères.')
    return value.strip()


def add(name, path, expected_revision=None):
    name, path = _name(name), _native_path(path)
    metadata = probe_native(path)
    with _LOCK:
        state = _read(initialize=True)
        _check_revision(state, expected_revision)
        if any(item['kind'] == 'uci' and os.path.normcase(item['path']) == os.path.normcase(path) for item in state['engines']):
            raise HTTPException(409, 'Ce moteur est déjà présent dans la liste.')
        state['engines'].append({**metadata, 'id': 'uci-' + uuid.uuid4().hex[:16], 'name': name,
                                 'kind': 'uci', 'path': path, 'managed': False})
        state['revision'] += 1
        _write(state)
        return _public(state)


def edit(engine_id, patch, expected_revision=None):
    with _LOCK:
        state = _read(initialize=True)
        before = deepcopy(_entry(state, engine_id))
        _check_revision(state, expected_revision)
    changes = {}
    if 'name' in patch:
        changes['name'] = _name(patch['name'])
    if 'path' in patch:
        if before['kind'] != 'uci' or before.get('managed'):
            raise HTTPException(422, 'Le chemin d’un moteur installé par ChessGym ne peut pas être modifié.')
        changes['path'] = _native_path(patch['path'])
        changes.update(probe_native(changes['path']))
        changes['name'] = _name(patch.get('name', before['name']))
    with _LOCK:
        state = _read(initialize=True)
        current = _entry(state, engine_id)
        _check_revision(state, expected_revision)
        if current != before:
            raise HTTPException(409, 'Ce moteur a été modifié pendant sa vérification. Réessaie.')
        if 'path' in changes and any(item['id'] != engine_id and item['kind'] == 'uci' and os.path.normcase(item['path']) == os.path.normcase(changes['path']) for item in state['engines']):
            raise HTTPException(409, 'Ce moteur est déjà présent dans la liste.')
        current.update(changes)
        state['revision'] += 1
        _write(state)
        return _public(state)


def select(patch, expected_revision=None):
    with _LOCK:
        state = _read(initialize=True)
        _check_revision(state, expected_revision)
        for role, engine_id in patch.items():
            if role not in ('analysis', 'maia'):
                raise HTTPException(422, 'Rôle de moteur inconnu.')
            if engine_id is not None:
                item = _entry(state, engine_id)
                if item['kind'] != ('uci' if role == 'analysis' else 'maia'):
                    raise HTTPException(422, 'Ce moteur ne convient pas à ce rôle.')
                if not _available(item):
                    raise HTTPException(422, 'Ce moteur n’est pas disponible sur ce serveur.')
            state['selected'][role] = engine_id
        state['revision'] += 1
        _write(state)
        return _public(state)


def unregister(engine_id, expected_revision=None):
    with _LOCK:
        state = _read(initialize=True)
        _check_revision(state, expected_revision)
        _entry(state, engine_id)
        if engine_id in state['selected'].values():
            raise HTTPException(409, 'Choisis un autre moteur ou désactive son rôle avant de le retirer.')
        state['engines'] = [item for item in state['engines'] if item['id'] != engine_id]
        state['revision'] += 1
        _write(state)
        return _public(state)


def register_managed(spec):
    """Installer-only callback; called after staged files and checksums pass."""
    item = {key: deepcopy(spec[key]) for key in ('id', 'name', 'kind', 'path', 'model', 'version', 'capabilities', 'managed_root') if key in spec}
    if item.get('kind') == 'maia3':
        item['kind'] = 'maia'
    if item.get('kind') not in ('uci', 'maia') or not Path(item.get('path', '')).is_absolute():
        raise ValueError('Invalid managed engine')
    item['managed'] = True
    if item['kind'] == 'uci':
        item['capabilities'] = _capabilities(item.get('capabilities', {}).get('skill', item.get('capabilities', {}).get('strength', True)))
    else:
        item['capabilities'] = {'analysis': False, 'play': True, 'skill': False, 'skills': []}
    with _LOCK:
        state = _read(initialize=True)
        existing = next((entry for entry in state['engines'] if entry['id'] == item['id']), None)
        if existing:
            existing.update(item)
        else:
            state['engines'].append(item)
        state['revision'] += 1
        _write(state)
        return deepcopy(item)


def test(engine_id):
    with _LOCK:
        state = _read(initialize=True)
        item = deepcopy(_entry(state, engine_id))
    if item['kind'] == 'maia':
        if not _available(item):
            raise HTTPException(422, 'Ce modèle Maia n’est pas disponible sur ce serveur.')
        # Model inference is tested in its independent worker, without changing
        # the selected model or touching an ongoing game.
        import maia_engine
        maia_engine.test_installation(item['path'], item['model'])
        metadata = {}
    else:
        metadata = probe_native(item['path'])
    with _LOCK:
        state = _read(initialize=True)
        current = _entry(state, engine_id)
        if current != item:
            raise HTTPException(409, 'Ce moteur a changé pendant sa vérification. Réessaie.')
        if metadata:
            current.update({key: value for key, value in metadata.items() if key != 'name'})
            state['revision'] += 1
            _write(state)
        return {'ok': True, 'engine': next(entry for entry in _public(state)['engines'] if entry['id'] == engine_id)}
