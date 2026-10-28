"""Persistent, single-worker background jobs for the local ChessGym server.

Only registered local handlers run; clients cannot submit executable job kinds.
Interrupted work returns to the queue, and handlers checkpoint their own work.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

import db
import engine


router = APIRouter(prefix='/api/jobs')
logger = logging.getLogger(__name__)
_HANDLERS = {}
_SCHEDULER = None
_MAINTENANCE = None
SCHEDULE_INTERVAL = 60.0
SCHEDULE_INITIAL_DELAY = 1.0
_worker = None
_worker_lock = threading.RLock()
ACTIVE = ('queued', 'running')


class JobCancelled(Exception):
    pass


def now():
    return datetime.now(timezone.utc).isoformat()


def init_jobs():
    with db.get_conn() as conn:
        conn.executescript('''
        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY,
            kind TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('queued','running','done','error','cancelled')),
            payload TEXT NOT NULL, result TEXT, error TEXT,
            progress_current INTEGER NOT NULL DEFAULT 0,
            progress_total INTEGER NOT NULL DEFAULT 0,
            message TEXT NOT NULL DEFAULT '',
            cancel_requested INTEGER NOT NULL DEFAULT 0,
            dedupe_key TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS jobs_by_status ON jobs(status,id);
        CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_key ON jobs(dedupe_key)
            WHERE dedupe_key IS NOT NULL AND status IN ('queued','running');
        ''')


def _payload(row):
    if row is None:
        return None
    result = dict(row)
    result['payload'] = json.loads(result['payload'])
    result['result'] = json.loads(result['result']) if result['result'] else None
    result['cancel_requested'] = bool(result['cancel_requested'])
    return result


def get_job(job_id):
    with db.get_conn() as conn:
        row = conn.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
    if row is None:
        raise HTTPException(404, 'Ce traitement est introuvable.')
    return _payload(row)


def latest_for(kind, payload_match):
    with db.get_conn() as conn:
        # Payloads contain only small options and identifiers, not game content.
        rows = conn.execute('SELECT * FROM jobs WHERE kind=? ORDER BY id DESC', (kind,))
        for row in rows:
            job = _payload(row)
            if all(job['payload'].get(key) == value for key, value in payload_match.items()):
                return job
    return None


def register(kind, handler):
    if not isinstance(kind, str) or not callable(handler):
        raise ValueError('Traitement interne invalide.')
    _HANDLERS[kind] = handler


def set_scheduler(callback):
    global _SCHEDULER
    _SCHEDULER = callback


def set_maintenance(callback):
    global _MAINTENANCE
    _MAINTENANCE = callback


def _wake():
    with _worker_lock:
        if _worker is not None:
            _worker.wake.set()


def enqueue(kind, payload, dedupe_key=None):
    if kind not in ('sync', 'analyse') or not isinstance(payload, dict):
        raise ValueError('Type de traitement invalide.')
    encoded = json.dumps(payload, ensure_ascii=False, allow_nan=False)
    if len(encoded) > 8192 or (dedupe_key is not None and
                             (not isinstance(dedupe_key, str) or len(dedupe_key) > 256)):
        raise ValueError('Options de traitement trop volumineuses.')
    stamp = now()
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        existing = conn.execute("SELECT * FROM jobs WHERE dedupe_key=? AND status IN ('queued','running')",
                                (dedupe_key,)).fetchone() if dedupe_key is not None else None
        if existing:
            return _payload(existing)
        cursor = conn.execute('''INSERT INTO jobs(kind,status,payload,dedupe_key,message,created_at,updated_at)
                                 VALUES(?,'queued',?,?,'En attente',?,?)''',
                              (kind, encoded, dedupe_key, stamp, stamp))
        result = _payload(conn.execute('SELECT * FROM jobs WHERE id=?', (cursor.lastrowid,)).fetchone())
    _wake()
    return result


class Context:
    def __init__(self, job_id, cancel_event):
        self.job_id = job_id
        self.cancel_event = cancel_event
        self._next_cancel_check = 0

    def check_cancelled(self):
        if self.cancel_event.is_set():
            raise JobCancelled()
        if time.monotonic() >= self._next_cancel_check:
            self._next_cancel_check = time.monotonic() + 0.25
            with db.get_conn() as conn:
                row = conn.execute('SELECT cancel_requested,status FROM jobs WHERE id=?', (self.job_id,)).fetchone()
            if row is None or row['cancel_requested'] or row['status'] == 'cancelled':
                self.cancel_event.set()
                raise JobCancelled()

    def progress(self, current, total, message=''):
        self.check_cancelled()
        current, total = max(0, int(current)), max(0, int(total))
        if total:
            current = min(current, total)
        with db.get_conn() as conn:
            conn.execute("UPDATE jobs SET progress_current=?,progress_total=?,message=?,updated_at=? WHERE id=? AND status='running'",
                         (current, total, str(message)[:500], now(), self.job_id))


class Worker:
    def __init__(self):
        self.stop_event = threading.Event()
        self.wake = threading.Event()
        self.state_lock = threading.RLock()
        self.active_id = None
        self.active_cancel = None
        self.thread = threading.Thread(target=self.run, name='ChessGym-background', daemon=True)
        self.scheduler_thread = threading.Thread(target=self.schedule, name='ChessGym-scheduler', daemon=True)

    def start(self):
        with db.get_conn() as conn:
            conn.execute("UPDATE jobs SET status='cancelled',message='Annulé',updated_at=? WHERE cancel_requested=1 AND status IN ('queued','running')", (now(),))
            conn.execute("UPDATE jobs SET status='queued',message='Reprise après redémarrage',updated_at=? WHERE status='running'", (now(),))
        self.thread.start()
        self.scheduler_thread.start()

    def cancel(self, job_id):
        with self.state_lock:
            if self.active_id == job_id and self.active_cancel is not None:
                self.active_cancel.set()
        self.wake.set()

    def stop(self):
        self.stop_event.set()
        with self.state_lock:
            if self.active_cancel is not None:
                self.active_cancel.set()
        self.wake.set()
        self.thread.join(timeout=20)
        self.scheduler_thread.join(timeout=5)
        if self.thread.is_alive():
            logger.error('Le traitement en cours termine encore son arrêt.')

    def claim(self):
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute("SELECT * FROM jobs WHERE status='queued' AND cancel_requested=0 ORDER BY CASE kind WHEN 'sync' THEN 0 ELSE 1 END,id LIMIT 1").fetchone()
            if row is None:
                return None
            conn.execute("UPDATE jobs SET status='running',error=NULL,message='Démarrage…',updated_at=? WHERE id=?", (now(), row['id']))
            return _payload(row)

    def finish(self, job_id, status, *, result=None, error=None, message=''):
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT cancel_requested FROM jobs WHERE id=?', (job_id,)).fetchone()
            if row is None:
                return
            if row['cancel_requested']:
                status, message, error = 'cancelled', 'Annulé', None
            conn.execute('UPDATE jobs SET status=?,result=?,error=?,message=?,updated_at=? WHERE id=?',
                         (status, json.dumps(result, ensure_ascii=False) if result is not None else None,
                          error, message, now(), job_id))

    def execute(self, job):
        event = threading.Event()
        with self.state_lock:
            self.active_id, self.active_cancel = job['id'], event
            if self.stop_event.is_set():
                event.set()
        context = Context(job['id'], event)
        try:
            context.check_cancelled()
            handler = _HANDLERS.get(job['kind'])
            if handler is None:
                raise ValueError('Ce traitement n’est pas disponible dans cette version.')
            result = handler(context, job['payload'])
            context.check_cancelled()
            self.finish(job['id'], 'done', result=result, message='Terminé')
        except (JobCancelled, engine.AnalysisCancelled):
            if self.stop_event.is_set():
                self.finish(job['id'], 'queued', message='Reprise au prochain lancement')
            else:
                self.finish(job['id'], 'cancelled', message='Annulé')
        except Exception as exc:
            if self.stop_event.is_set():
                self.finish(job['id'], 'queued', message='Reprise au prochain lancement')
            else:
                message = str(exc.detail) if isinstance(exc, HTTPException) else str(exc) if isinstance(exc, ValueError) else 'Le traitement a échoué. Réessaie dans quelques instants.'
                logger.exception('Échec du traitement %s (%s)', job['id'], job['kind'])
                self.finish(job['id'], 'error', error=message[:500], message='Échec')
        finally:
            with self.state_lock:
                self.active_id = self.active_cancel = None

    def schedule(self):
        if self.stop_event.wait(SCHEDULE_INITIAL_DELAY):
            return
        while not self.stop_event.is_set():
            # Failure in one scheduler must not suppress the other service.
            for label, callback in (('synchronisation', _SCHEDULER), ('maintenance', _MAINTENANCE)):
                if self.stop_event.is_set():
                    return
                if callback is not None:
                    try:
                        callback()
                    except Exception:
                        logger.exception('Échec de planification : %s', label)
            self.stop_event.wait(SCHEDULE_INTERVAL)

    def run(self):
        while not self.stop_event.is_set():
            try:
                job = self.claim()
                if job is not None:
                    self.execute(job)
                    continue
            except Exception:
                logger.exception('La file de traitements réessaiera dans un instant.')
            self.wake.wait(0.5)
            self.wake.clear()


def start_worker():
    global _worker
    with _worker_lock:
        if _worker is not None and (_worker.thread.is_alive() or _worker.scheduler_thread.is_alive()):
            return
        _worker = Worker()
        _worker.start()


def stop_worker():
    global _worker
    with _worker_lock:
        worker = _worker
        if worker is None:
            return
    # Do not hold the registry lock while a handler may enqueue another job.
    worker.stop()
    with _worker_lock:
        if _worker is worker and not worker.thread.is_alive() and not worker.scheduler_thread.is_alive():
            _worker = None


@router.get('')
def list_jobs():
    with db.get_conn() as conn:
        conn.execute('BEGIN')
        active_rows = conn.execute("SELECT * FROM jobs WHERE status IN ('running','queued') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,CASE kind WHEN 'sync' THEN 0 ELSE 1 END,id LIMIT 100").fetchall()
        recent_rows = conn.execute("SELECT * FROM jobs WHERE status NOT IN ('running','queued') ORDER BY id DESC LIMIT 20").fetchall()
        counts = {status: 0 for status in ('running', 'queued', 'done', 'error', 'cancelled')}
        counts.update({row['status']: row['total'] for row in conn.execute('SELECT status,COUNT(*) AS total FROM jobs GROUP BY status')})
    return {'jobs': [_payload(row) for row in [*active_rows, *recent_rows]], 'counts': counts}


@router.post('/{job_id}/cancel')
def cancel_job(job_id: int, payload: dict):
    if payload:
        raise ValueError('L’annulation ne demande aucune option.')
    with db.get_conn() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute('SELECT * FROM jobs WHERE id=?', (job_id,)).fetchone()
        if row is None:
            raise HTTPException(404, 'Ce traitement est introuvable.')
        if row['status'] in ACTIVE:
            status = 'cancelled' if row['status'] == 'queued' else 'running'
            conn.execute('UPDATE jobs SET cancel_requested=1,status=?,message=?,updated_at=? WHERE id=?',
                         (status, 'Annulé' if status == 'cancelled' else 'Arrêt en cours…', now(), job_id))
    with _worker_lock:
        if _worker is not None:
            _worker.cancel(job_id)
    return {'job': get_job(job_id)}


@router.post('/{job_id}/retry')
def retry_job(job_id: int, payload: dict):
    if payload:
        raise ValueError('La reprise ne demande aucune option.')
    job = get_job(job_id)
    if job['status'] not in ('error', 'cancelled'):
        raise HTTPException(409, 'Seul un traitement interrompu ou en erreur peut être repris.')
    # Handler validation checks whether its game or connection still exists.
    return {'job': enqueue(job['kind'], job['payload'], dedupe_key=job['dedupe_key'])}
