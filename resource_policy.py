"""Capacity-aware CPU/cache budgets shared by engines and reference imports.

Saved plans change only between tasks. Weighted reservations serialize work on
small CPUs; setting a one-core budget never promises three concurrent workers.
The memory setting is Stockfish's combined hash cache, not all application RAM.
"""
from __future__ import annotations

from copy import deepcopy
from contextlib import contextmanager
import json
import math
import os
import threading
import time

from fastapi import APIRouter, HTTPException

from db import get_conn
from resource_hardware import snapshot as hardware_snapshot

router = APIRouter(prefix='/api/resource-settings')
_FIELDS = {'profile', 'total_threads', 'hash_mb', 'import_workers'}


def limits(hardware=None):
    hardware = hardware or hardware_snapshot()
    cpus = max(1, hardware['cpu_count'])
    memory = hardware.get('memory_mb')
    if memory is None:
        reserve, maximum = None, 128
    else:
        # Keep at least 2 GiB or 20% for the OS and other work. On exceptionally
        # small hosts retain everything except the two minimum 1 MiB caches.
        reserve = min(max(0, memory - 2), max(2048, math.ceil(memory * .2)))
        maximum = max(2, memory - reserve)
    return {'total_threads': {'min': 1, 'max': cpus},
            'hash_mb': {'min': min(32, maximum), 'max': maximum},
            'import_workers': {'min': 1, 'max': min(64, max(1, cpus - 2))},
            'reserved_memory_mb': reserve}


def recommendations(hardware=None):
    hardware = hardware or hardware_snapshot()
    bound = limits(hardware)
    cpus = bound['total_threads']['max']
    memory = hardware.get('memory_mb')
    result = {}
    for name, fraction, cap in (('economy', .25, 4), ('balanced', .5, 8)):
        total = min(cpus, max(min(3, cpus), min(cap, math.ceil(cpus * fraction))))
        workers = max(1, min(bound['import_workers']['max'], total // 4, max(1, total - 2)))
        cache = 128 if name == 'economy' else min(1024, (memory // 16) if memory else 128)
        cache = max(bound['hash_mb']['min'], min(bound['hash_mb']['max'], cache))
        result[name] = {'profile': name, 'total_threads': total, 'hash_mb': cache, 'import_workers': workers}
    return result


def defaults():
    hardware = hardware_snapshot()
    bound = limits(hardware)
    configured = os.environ.get('CHESSGYM_IMPORT_WORKERS', '').strip()
    if configured.isascii() and configured.isdecimal() and 1 <= int(configured) <= 16:
        workers = int(configured)
    else:
        workers = min(4, max(1, hardware['cpu_count'] - 2))
    workers = min(workers, bound['import_workers']['max'])
    return {'profile': 'custom', 'total_threads': min(hardware['cpu_count'], workers + 2),
            'hash_mb': min(128, bound['hash_mb']['max']), 'import_workers': workers}


DEFAULT = defaults()
_LOCK = threading.RLock()
_CHANGED = threading.Condition(_LOCK)
_DESIRED = dict(DEFAULT)
_CURRENT = dict(DEFAULT)
_ACTIVE = 0
_ACTIVE_THREADS = 0
_STARTING_IMPORT = 0
_RESERVED_IMPORT_THREADS = 0
_WAITING_IMPORTS = 0
_IMPORT_ACTIVE = None
_ADJUSTED_FOR_HARDWARE = False


def validate(patch, current=None):
    if not isinstance(patch, dict) or set(patch) - _FIELDS:
        raise HTTPException(400, 'Profil de ressources inconnu.')
    hardware = hardware_snapshot()
    bound = limits(hardware)
    result = {**defaults(), **(current or {}), **patch}
    if result['profile'] not in ('economy', 'balanced', 'custom'):
        raise HTTPException(400, 'Profil de ressources invalide.')
    if result['profile'] != 'custom':
        result = recommendations(hardware)[result['profile']]
    for key in ('total_threads', 'hash_mb', 'import_workers'):
        if type(result[key]) is not int or not bound[key]['min'] <= result[key] <= bound[key]['max']:
            messages = {
                'total_threads': 'Choisis un nombre de cœurs compris dans les limites de ce serveur.',
                'hash_mb': 'Choisis une quantité de mémoire cache comprise dans les limites de ce serveur.',
                'import_workers': 'Choisis un nombre de processus d’importation compris dans les limites de ce serveur.',
            }
            raise HTTPException(400, messages[key])
    if result['import_workers'] > max(1, result['total_threads'] - 2):
        raise HTTPException(400, 'Le nombre de processus d’importation dépasse le budget CPU choisi.')
    return result


def _fit_saved(saved):
    if not isinstance(saved, dict) or set(saved) - _FIELDS:
        return defaults()
    if saved.get('profile') in ('economy', 'balanced'):
        return validate({'profile': saved['profile']})
    result = {**defaults(), **saved}
    if result.get('profile') != 'custom' or any(type(result[key]) is not int for key in ('total_threads', 'hash_mb', 'import_workers')):
        return defaults()
    bound = limits()
    for key in ('total_threads', 'hash_mb', 'import_workers'):
        result[key] = max(bound[key]['min'], min(bound[key]['max'], result[key]))
    result['import_workers'] = min(result['import_workers'], max(1, result['total_threads'] - 2))
    return validate(result)


def effective(plan):
    return {'engine_threads': max(1, (plan['total_threads'] - plan['import_workers']) // 2),
            'engine_hash_mb': max(1, plan['hash_mb'] // 2), 'import_workers': plan['import_workers'],
            'total_threads': plan['total_threads'], 'hash_mb': plan['hash_mb']}


def set_import_active(callback):
    global _IMPORT_ACTIVE
    _IMPORT_ACTIVE = callback


def _import_busy():
    try:
        return bool(_IMPORT_ACTIVE and _IMPORT_ACTIVE())
    except Exception:
        return True


def _apply_if_idle():
    global _CURRENT
    if not _ACTIVE and not _STARTING_IMPORT and not _import_busy():
        _CURRENT = dict(_DESIRED)


def load():
    global _CURRENT, _DESIRED, _ADJUSTED_FOR_HARDWARE
    with get_conn() as conn:
        row = conn.execute("SELECT value FROM preferences WHERE key='resource_settings'").fetchone()
    original = None
    try:
        original = json.loads(row['value']) if row else None
        saved = _fit_saved(original) if row else defaults()
    except (HTTPException, ValueError, TypeError):
        saved = defaults()
    with _LOCK:
        _ADJUSTED_FOR_HARDWARE = bool(row and original != saved)
        _DESIRED = saved
        _apply_if_idle()
        _CHANGED.notify_all()


def settings():
    with _LOCK:
        _apply_if_idle()
        return effective(_CURRENT)


class Lease:
    def __init__(self, config):
        self.config = config
        self.released = False

    def release(self):
        global _ACTIVE, _ACTIVE_THREADS
        with _LOCK:
            if not self.released:
                self.released = True
                _ACTIVE -= 1
                _ACTIVE_THREADS -= self.config['engine_threads']
                _apply_if_idle()
                _CHANGED.notify_all()


def _check_wait(cancel, deadline):
    if cancel is not None and cancel.is_set():
        # Delayed import avoids a module initialization cycle. Callers retain
        # their existing cancellation contract, including queued requests.
        from engine import AnalysisCancelled
        raise AnalysisCancelled()
    if deadline is not None and time.monotonic() >= deadline:
        raise HTTPException(503, 'Le moteur est occupé. Réessayez dans quelques instants.')


def acquire(cancel=None, timeout=15):
    global _ACTIVE, _ACTIVE_THREADS
    deadline = None if timeout is None else time.monotonic() + max(0, timeout)
    with _CHANGED:
        while True:
            _check_wait(cancel, None)
            _apply_if_idle()
            config = effective(_CURRENT)
            imports = max(_RESERVED_IMPORT_THREADS, _CURRENT['import_workers'] if _import_busy() else 0)
            if not _WAITING_IMPORTS and _ACTIVE_THREADS + imports + config['engine_threads'] <= config['total_threads']:
                _ACTIVE += 1
                _ACTIVE_THREADS += config['engine_threads']
                return Lease(config)
            _check_wait(cancel, deadline)
            _CHANGED.wait(.05)


def import_workers(requested):
    return max(1, min(int(requested), settings()['import_workers']))


@contextmanager
def import_reservation(requested, *, cancel=None, timeout=15):
    """Reserve CPU before launching an importer, including on one-core hosts.

    The shared import gate prevents simultaneous reference imports. Its busy
    callback can already be true for this same managed import, so only running
    engine leases and explicit startup reservations participate in this wait.
    """
    global _STARTING_IMPORT, _RESERVED_IMPORT_THREADS, _WAITING_IMPORTS
    deadline = None if timeout is None else time.monotonic() + max(0, timeout)
    with _CHANGED:
        _WAITING_IMPORTS += 1
        try:
            while True:
                _check_wait(cancel, None)
                _apply_if_idle()
                workers = max(1, min(int(requested), _CURRENT['import_workers']))
                if _ACTIVE_THREADS + _RESERVED_IMPORT_THREADS + workers <= _CURRENT['total_threads']:
                    _STARTING_IMPORT += 1
                    _RESERVED_IMPORT_THREADS += workers
                    break
                _check_wait(cancel, deadline)
                _CHANGED.wait(.05)
        finally:
            _WAITING_IMPORTS -= 1
            _CHANGED.notify_all()
    try:
        yield workers
    finally:
        with _CHANGED:
            _STARTING_IMPORT -= 1
            _RESERVED_IMPORT_THREADS -= workers
            _apply_if_idle()
            _CHANGED.notify_all()


def _response():
    with _LOCK:
        _apply_if_idle()
        hardware = hardware_snapshot()
        return {**deepcopy(_DESIRED), 'effective': effective(_CURRENT),
                'pending': _CURRENT != _DESIRED, 'active_searches': _ACTIVE,
                'active_threads': _ACTIVE_THREADS,
                'import_active': bool(_STARTING_IMPORT or _import_busy()),
                'cpu_count': hardware['cpu_count'], 'hardware': hardware,
                'limits': limits(hardware), 'recommendations': recommendations(hardware),
                'adjusted_for_hardware': _ADJUSTED_FOR_HARDWARE,
                'applies_to': 'next_tasks'}


@router.get('')
def get_settings():
    return _response()


@router.patch('')
def patch_settings(payload: dict):
    global _DESIRED, _ADJUSTED_FOR_HARDWARE
    with _LOCK:
        value = validate(payload, _DESIRED)
        with get_conn() as conn:
            conn.execute("INSERT INTO preferences(key,value) VALUES('resource_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(value),))
        _DESIRED = value
        _ADJUSTED_FOR_HARDWARE = False
        _CHANGED.notify_all()
        return _response()
