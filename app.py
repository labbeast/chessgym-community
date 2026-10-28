"""ChessGym application composition, lifecycle and shared HTTP protection."""
import asyncio
import hashlib
import re
from contextlib import AsyncExitStack, asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, Depends, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

import db
import reference_queries
from api_common import now, fail
from version import VERSION

# Preserve module-level imports used by existing integrations. Domain modules
# depend on the services below, never on this application composition module.
from library_service import (DEFAULT_SETTINGS, text_field, checked_settings, checked_tags,
                             get_base, verify_folder, make_primary_exclusive)
from accounts_api import require_user, status
from local_access import require_local_request
import remote_access
from entry_content import content_snapshot, entry_revision
from entry_service import (get_entry, check_entry_revision, require_explicit_entry_save,
                           history_state, safe_view_path, save_content, entry_payload, played_game_order, title_for)
from entries_api import (batch_entries, all_entries, import_pgn, export_base, create_entry, read_entry,
                         mark_entry_seen, update_entry, add_move, annotate_node, change_tree,
                         restore_history, undo_entry, redo_entry, delete_entry, add_line)
from reading_api import reading_dashboard, entry_reading, update_entry_reading, mark_base_reading
from board_api import change_free_tree, board, preview_line, move, legal
from workspace_api import list_workspace, read_workspace, write_workspace, delete_workspace
import entries_api
import reading_api
import board_api
import workspace_api

ROOT = Path(__file__).parent


@asynccontextmanager
async def lifespan(app):
    async with AsyncExitStack() as cleanup:
        remote_access.start()
        backup_service.start_guard()
        cleanup.callback(backup_service.close_guard)
        db.init_db()
        resource_policy.set_import_active(reference_library.import_active)
        resource_policy.load()
        import training
        training.init_training()
        guess_move.init_guess_move()
        puzzle_training.init_puzzles()
        training_skills.init_training_skills()
        import repertoire_coverage
        repertoire_coverage.init_coverage()
        import jobs
        import sync
        import game_analysis
        jobs.init_jobs()
        sync.init_sync()
        game_analysis.init_analysis()
        import training_programs
        with db.get_conn() as conn:
            training_programs.init_schema(conn)
            game_report_progress.init_schema(conn)
        jobs.register('sync', sync.sync_account)
        jobs.register('analyse', game_analysis.analyse_game)
        jobs.set_scheduler(sync.schedule_due)
        jobs.set_maintenance(host_maintenance)

        # Register shutdown before starting background work, so a partial startup
        # is cleaned up too. Callbacks run in reverse order, even if one fails;
        # the offline-restore guard remains held until all services have stopped.
        import engine
        import interactive_engine
        import maia_engine
        cleanup.push_async_callback(asyncio.to_thread, maia_engine.shutdown)
        cleanup.push_async_callback(asyncio.to_thread, engine.shutdown)
        cleanup.push_async_callback(asyncio.to_thread, interactive_engine.close)
        cleanup.callback(reference_library.shutdown)
        cleanup.push_async_callback(asyncio.to_thread, reference_queries.close_preparations)
        cleanup.push_async_callback(asyncio.to_thread, resource_setup.close)
        cleanup.push_async_callback(asyncio.to_thread, app_updates.close)
        cleanup.callback(jobs.stop_worker)
        if app_updates.validation_pending():
            async def start_after_update_validation():
                # The supervisor needs HTTP readiness before accepting the new
                # release. Background writes must wait for that acceptance too.
                while app_updates.validation_pending():
                    await asyncio.sleep(.1)
                jobs.start_worker()
                reference_queries.start_preparations()
            deferred = asyncio.create_task(start_after_update_validation())
            async def cancel_deferred_start():
                deferred.cancel()
                with suppress(asyncio.CancelledError):
                    await deferred
            cleanup.push_async_callback(cancel_deferred_start)
        else:
            jobs.start_worker()
            reference_queries.start_preparations()
        yield


app = FastAPI(title='ChessGym', version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware('http')
async def protect_requests(request: Request, call_next):
    pairing_page = False
    try:
        if not remote_access.is_local_request(request):
            remote_access.require_private_request(request)
            if not remote_access.valid_device(request):
                pairing_page = request.method in ('GET', 'HEAD') and request.url.path == '/'
                public_asset = request.method in ('GET', 'HEAD') and request.url.path in remote_access.PUBLIC_ASSETS
                pairing_post = request.method == 'POST' and request.url.path == '/api/private-access/pair'
                if not (pairing_page or public_asset or pairing_post):
                    return JSONResponse({'detail': remote_access.PAIRING_REQUIRED, 'pairing_required': True},
                                        403, headers={'Cache-Control': 'no-store'})
    except HTTPException as exc:
        return JSONResponse({'detail': exc.detail}, exc.status_code, headers={'Cache-Control': 'no-store'})
    if (request.url.path.startswith('/api/') and request.method in ('POST', 'PUT', 'PATCH', 'DELETE')
            and app_updates.validation_pending()):
        return JSONResponse({'detail': 'ChessGym vérifie sa mise à jour. Réessaie dans quelques secondes.'},
                            503, headers={'Retry-After': '2'})
    if request.url.path.startswith('/api/') and not (request.method == 'GET' and request.url.path == '/api/app-updates'):
        app_updates.observe_request()
    if request.url.path.startswith('/api/') and request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
        if request.method != 'DELETE' or request.headers.get('content-length', '0') != '0':
            if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
                return JSONResponse({'detail': 'Un contenu JSON est nécessaire.'}, 415)
        try:
            if int(request.headers.get('content-length', '0')) > 24 * 1024 * 1024:
                return JSONResponse({'detail': 'Envoi limité à 24 Mo.'}, 413)
        except ValueError:
            return JSONResponse({'detail': 'Taille de requête invalide.'}, 400)
    if pairing_page:
        response = FileResponse(ROOT / 'static' / 'private-pair.html', media_type='text/html', headers={'Cache-Control': 'no-store'})
    else:
        response = await call_next(request)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'same-origin'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    if request.url.path.startswith('/api/'):
        response.headers['Cache-Control'] = 'no-store'
    elif request.url.path == '/' or (request.url.path.startswith('/static/') and
                                    request.url.path.endswith(('.html', '.css', '.js', '.webmanifest'))):
        # Revalidate UI code after an update; keep image/font caching unchanged.
        response.headers['Cache-Control'] = 'no-cache'
    return response


@app.exception_handler(RequestValidationError)
async def bad_request(request, exc):
    return JSONResponse({'detail': 'La requête contient des champs manquants ou invalides.'}, 422)


@app.exception_handler(ValueError)
async def invalid_data(request, exc):
    return JSONResponse({'detail': str(exc)}, 400)


from library_api import library, create_folder, rename_folder, create_base, update_base, move_library_base, base_logo, delete_base, base_entries
from preferences_api import preferences, update_preferences
import accounts_api
import library_api
import preferences_api
import backup_api
import backup_service
import resource_setup
import resource_setup_api
import app_updates
import app_updates_api
import remote_access_api


def host_maintenance():
    try:
        backup_service.scheduler_tick()
    finally:
        try:
            resource_setup.scheduler_tick()
        finally:
            app_updates.scheduler_tick()


backup = backup_api.download_backup
app.include_router(accounts_api.router)
app.include_router(remote_access_api.router)
app.include_router(resource_setup_api.router)
app.include_router(app_updates_api.router)
app.include_router(entries_api.router)
app.include_router(reading_api.router)
app.include_router(board_api.router)
app.include_router(workspace_api.router)
app.include_router(library_api.router)
app.include_router(preferences_api.router)
app.include_router(backup_api.router, dependencies=[Depends(require_user)])

import resource_policy
app.include_router(resource_policy.router, dependencies=[Depends(require_user)])
import review_sessions
app.include_router(review_sessions.router, dependencies=[Depends(require_user)])
import training
app.include_router(training.router, dependencies=[Depends(require_user)])
import guess_move
import puzzle_training
import training_skills
app.include_router(guess_move.router, dependencies=[Depends(require_user)])
app.include_router(puzzle_training.router, dependencies=[Depends(require_user)])
app.include_router(training_skills.router, dependencies=[Depends(require_user)])
import training_history
app.include_router(training_history.router, dependencies=[Depends(require_user)])
import training_program_api
app.include_router(training_program_api.router)
import analysis_time
app.include_router(analysis_time.router)

import color_training
app.include_router(color_training.router, dependencies=[Depends(require_user)])

import computer_history_api
app.include_router(computer_history_api.router, dependencies=[Depends(require_user)])

import computer_api
app.include_router(computer_api.router, prefix='/api', dependencies=[Depends(require_user)])
import engine_catalog_api
app.include_router(engine_catalog_api.router, dependencies=[Depends(require_user)])
import reference_library
app.include_router(reference_library.router, dependencies=[Depends(require_user)])
import library_positions
app.include_router(library_positions.router, dependencies=[Depends(require_user)])
import repertoire_coverage
app.include_router(repertoire_coverage.router, dependencies=[Depends(require_user)])
import repertoire_transpositions
app.include_router(repertoire_transpositions.router, dependencies=[Depends(require_user)])
import review_statistics
app.include_router(review_statistics.router, dependencies=[Depends(require_user)])
import explorer
app.include_router(explorer.router, dependencies=[Depends(require_user)])
import explorer_credentials
app.include_router(explorer_credentials.router, dependencies=[Depends(require_user)])
import explorer_evaluations
app.include_router(explorer_evaluations.router, dependencies=[Depends(require_user)])
import jobs
app.include_router(jobs.router, dependencies=[Depends(require_user)])
import sync
app.include_router(sync.router, dependencies=[Depends(require_user)])
import game_analysis
app.include_router(game_analysis.router, dependencies=[Depends(require_user)])
import game_report_progress
app.include_router(game_report_progress.router)
import game_report_repertoire
app.include_router(game_report_repertoire.router, dependencies=[Depends(require_user)])
try:
    import demo
except ModuleNotFoundError as exc:
    if exc.name != 'demo':
        raise
else:
    app.include_router(demo.router, dependencies=[Depends(require_user)])

if (ROOT / 'static').exists():
    app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')


@app.get('/')
def index():
    html = (ROOT / 'static' / 'index.html').read_text(encoding='utf-8')

    def version_asset(match):
        name = match['name']
        digest = hashlib.sha256((ROOT / 'static' / name).read_bytes()).hexdigest()[:16]
        return f'{match["attribute"]}="/static/{name}?v={digest}"'

    # New URLs also bypass stylesheets cached before revalidation was enabled.
    html = re.sub(r'(?P<attribute>href|src)="/static/(?P<name>[^"?]+\.(?:css|js))(?:\?[^"\s]*)?"',
                  version_asset, html)
    return HTMLResponse(html)
