"""Stockfish HTTP API, preferences and cancellable streaming transport.

The engine process itself lives in engine/interactive_engine; this module owns
only request validation and HTTP lifecycle, independently of study scheduling.
"""
from __future__ import annotations

import asyncio
import json
import queue as thread_queue
import threading
import time

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, StrictInt, model_validator

from db import get_conn
import engine
import interactive_engine

router = APIRouter(prefix='/engine')


class AnalysisRequest(BaseModel):
    fen: str
    multipv: int = Field(default=3, ge=1, le=3)
    time_ms: StrictInt = Field(default=1000, ge=interactive_engine.MIN_TIME_MS, le=interactive_engine.MAX_TIME_MS)


class StreamAnalysisRequest(AnalysisRequest):
    time_ms: StrictInt | None = Field(default=1000, ge=interactive_engine.MIN_TIME_MS, le=interactive_engine.MAX_TIME_MS)
    depth: StrictInt | None = Field(default=None, ge=interactive_engine.MIN_DEPTH, le=interactive_engine.MAX_DEPTH)
    refresh: bool = False

    @model_validator(mode='after')
    def depth_without_implicit_time_limit(self):
        if self.depth is not None and 'time_ms' not in self.model_fields_set:
            self.time_ms = None
        return self


class PlayRequest(BaseModel):
    fen: str
    skill: int = Field(default=10, ge=0, le=20)
    time_ms: int = Field(default=500, ge=100, le=2000)
    history: list[str] | None = Field(default=None, max_length=2000)
    initial_fen: str | None = None


@router.get('/status')
def engine_status():
    return engine.status()


@router.post('/analyse')
async def analyse(request: AnalysisRequest, http_request: Request):
    # Long JSON analyses must release the shared engine when their caller leaves.
    cancel = threading.Event()
    worker = asyncio.create_task(asyncio.to_thread(
        engine.analyse, request.fen, request.multipv, request.time_ms, cancel=cancel))
    try:
        while not worker.done():
            if await http_request.is_disconnected():
                raise HTTPException(499, 'L’analyse du moteur a été interrompue. Réessaie dans un instant.')
            await asyncio.wait({worker}, timeout=.05)
        return await worker
    finally:
        cancel.set()
        with anyio.CancelScope(shield=True):
            try:
                await asyncio.shield(worker)
            except Exception:
                pass


ENGINE_SETTINGS_KEY = 'interactive_engine_settings'
ENGINE_DEFAULT_SETTINGS = {'mode': 'time', 'time_ms': 1000, 'depth': 18}


def _validate_engine_settings(patch, current):
    if not isinstance(patch, dict) or set(patch) - ENGINE_DEFAULT_SETTINGS.keys():
        raise HTTPException(400, 'Réglages du moteur non reconnus.')
    settings = {**ENGINE_DEFAULT_SETTINGS, **current, **patch}
    if settings['mode'] not in ('time', 'depth', 'infinite'):
        raise HTTPException(400, 'Choisis une durée ou une profondeur de calcul.')
    if (type(settings['time_ms']) is not int or
            not interactive_engine.MIN_TIME_MS <= settings['time_ms'] <= interactive_engine.MAX_TIME_MS):
        raise HTTPException(400, 'La durée doit être un nombre positif d’au moins 0,1 seconde.')
    if (type(settings['depth']) is not int or
            not interactive_engine.MIN_DEPTH <= settings['depth'] <= interactive_engine.MAX_DEPTH):
        raise HTTPException(400, 'La profondeur doit être un entier positif accepté par le moteur.')
    return settings


def _engine_settings(conn):
    settings = dict(ENGINE_DEFAULT_SETTINGS)
    row = conn.execute('SELECT value FROM preferences WHERE key=?', (ENGINE_SETTINGS_KEY,)).fetchone()
    if row:
        try:
            stored = json.loads(row['value'])
        except (ValueError, TypeError):
            stored = None
        if isinstance(stored, dict):
            # Older partial preferences acquire new defaults. Invalid stored
            # values never escape into a search or prevent opening the dialog.
            for key in ENGINE_DEFAULT_SETTINGS:
                if key in stored:
                    try:
                        settings = _validate_engine_settings({key: stored[key]}, settings)
                    except HTTPException:
                        pass
    return settings


@router.get('/settings')
def get_engine_settings():
    with get_conn() as conn:
        return _engine_settings(conn)


@router.patch('/settings')
def patch_engine_settings(payload: dict):
    with get_conn() as conn:
        settings = _validate_engine_settings(payload, _engine_settings(conn))
        conn.execute('INSERT INTO preferences(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
                     (ENGINE_SETTINGS_KEY, json.dumps(settings)))
        return settings


class _EngineStreamingResponse(StreamingResponse):
    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            # ASGI 2.4 send failures can leave an async iterator suspended at
            # its last yield. Explicitly close it to cancel its engine search.
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()


async def _analysis_stream(http_request: Request, request: StreamAnalysisRequest):
    """A bounded latest-value mailbox keeps slow clients from queuing engine output."""
    messages = thread_queue.Queue(maxsize=1)
    cancel = threading.Event()
    last_update = 0.0

    def publish(kind, payload):
        if cancel.is_set():
            return
        message = json.dumps({**payload, 'type': kind, 'fen': request.fen},
                             ensure_ascii=False, allow_nan=False) + '\n'
        try:
            messages.get_nowait()
        except thread_queue.Empty:
            pass
        messages.put_nowait(message)

    def on_update(payload):
        nonlocal last_update
        tick = time.monotonic()
        if tick - last_update >= .04:
            last_update = tick
            publish('info', payload)

    def run():
        try:
            if cancel.is_set():
                return
            result = interactive_engine.analyse(request.fen, request.multipv, request.time_ms,
                                                depth=request.depth, cancel=cancel, on_update=on_update, force=request.refresh)
            publish('done', result)
        except Exception as exc:
            if not cancel.is_set():
                detail = (exc.detail if isinstance(exc, HTTPException) and isinstance(exc.detail, str)
                          else 'L’analyse du moteur a été interrompue. Réessaie dans un instant.')
                publish('error', {'detail': detail[:512]})

    worker = asyncio.create_task(asyncio.to_thread(run))
    try:
        while not await http_request.is_disconnected():
            try:
                message = messages.get_nowait()
            except thread_queue.Empty:
                if worker.done():
                    break
                await asyncio.sleep(.02)
                continue
            yield message
            if json.loads(message)['type'] in ('done', 'error'):
                break
    finally:
        # Abandoning a board cancels running AND queued searches. Wait for its
        # cooperative worker to release the engine even inside ASGI cancellation.
        cancel.set()
        with anyio.CancelScope(shield=True):
            await asyncio.shield(worker)


@router.post('/analyse/stream')
async def analyse_stream(http_request: Request, request: StreamAnalysisRequest):
    # A streaming response commits its headers before iterating the body.
    # Reject malformed positions with the same HTTP status as the JSON route.
    engine.valid_board(request.fen)
    return _EngineStreamingResponse(_analysis_stream(http_request, request),
                             media_type='application/x-ndjson',
                             headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


@router.post('/play')
def play(request: PlayRequest):
    return engine.play(request.fen,request.skill,request.time_ms,request.history,request.initial_fen)


