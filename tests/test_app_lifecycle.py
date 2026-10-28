"""Lifecycle failures must release every service before the restore guard."""
import asyncio
from contextlib import nullcontext
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import app
import engine
import interactive_engine
import maia_engine
import training_programs


CLOSE_ORDER = ['jobs', 'preparations', 'references', 'interactive', 'engine', 'maia', 'guard']


@pytest.fixture
def lifecycle(monkeypatch):
    events = []

    def noop(*args, **kwargs):
        pass

    for module, names in (
        (app.db, ('init_db',)),
        (app.resource_policy, ('set_import_active', 'load')),
        (app.training, ('init_training',)),
        (app.guess_move, ('init_guess_move',)),
        (app.puzzle_training, ('init_puzzles',)),
        (app.training_skills, ('init_training_skills',)),
        (app.repertoire_coverage, ('init_coverage',)),
        (app.jobs, ('init_jobs', 'register', 'set_scheduler', 'set_maintenance')),
        (app.sync, ('init_sync',)),
        (app.game_analysis, ('init_analysis',)),
        (training_programs, ('init_schema',)),
        (app.game_report_progress, ('init_schema',)),
    ):
        for name in names:
            monkeypatch.setattr(module, name, noop)
    monkeypatch.setattr(app.db, 'get_conn', lambda: nullcontext(None))
    monkeypatch.setattr(app.backup_service, 'start_guard', lambda: events.append('start_guard'))
    monkeypatch.setattr(app.jobs, 'start_worker', lambda: events.append('start_jobs'))
    monkeypatch.setattr(app.reference_queries, 'start_preparations', lambda: events.append('start_preparations'))
    closers = (
        (app.jobs, 'stop_worker'),
        (app.reference_queries, 'close_preparations'),
        (app.reference_library, 'shutdown'),
        (interactive_engine, 'close'),
        (engine, 'shutdown'),
        (maia_engine, 'shutdown'),
        (app.backup_service, 'close_guard'),
    )
    for label, (module, name) in zip(CLOSE_ORDER, closers):
        monkeypatch.setattr(module, name, lambda label=label: events.append(label))
    return events, closers


def run_lifespan(events, *, fail_inside=False):
    async def run():
        async with app.lifespan(app.app):
            events.append('serving')
            if fail_inside:
                raise RuntimeError('request failure')
    asyncio.run(run())


def test_services_close_in_dependency_order(lifecycle):
    events, _ = lifecycle
    run_lifespan(events)
    assert events == ['start_guard', 'start_jobs', 'start_preparations', 'serving', *CLOSE_ORDER]


@pytest.mark.parametrize('starter', ['start_worker', 'start_preparations'])
def test_partial_startup_closes_services(lifecycle, monkeypatch, starter):
    events, _ = lifecycle

    def broken_start():
        events.append('partial_start')
        raise RuntimeError('startup failure')

    module = app.jobs if starter == 'start_worker' else app.reference_queries
    monkeypatch.setattr(module, starter, broken_start)
    with pytest.raises(RuntimeError, match='startup failure'):
        run_lifespan(events)
    assert 'serving' not in events
    assert events[-len(CLOSE_ORDER):] == CLOSE_ORDER


@pytest.mark.parametrize('failed', range(len(CLOSE_ORDER)))
def test_cleanup_failure_does_not_skip_other_services(lifecycle, monkeypatch, failed):
    events, closers = lifecycle

    def broken_close():
        events.append(CLOSE_ORDER[failed])
        raise RuntimeError('shutdown failure')

    module, name = closers[failed]
    monkeypatch.setattr(module, name, broken_close)
    with pytest.raises(RuntimeError, match='shutdown failure'):
        run_lifespan(events)
    assert events[-len(CLOSE_ORDER):] == CLOSE_ORDER


def test_application_error_still_closes_services(lifecycle):
    events, _ = lifecycle
    with pytest.raises(RuntimeError, match='request failure'):
        run_lifespan(events, fail_inside=True)
    assert events[-len(CLOSE_ORDER):] == CLOSE_ORDER


@pytest.mark.parametrize('module,name', [
    (app.db, 'init_db'),
    (training_programs, 'init_schema'),
    (app.game_report_progress, 'init_schema'),
])
def test_initialization_failure_releases_guard(lifecycle, monkeypatch, module, name):
    events, _ = lifecycle

    def broken_init(*args, **kwargs):
        raise RuntimeError('schema failure')

    monkeypatch.setattr(module, name, broken_init)
    with pytest.raises(RuntimeError, match='schema failure'):
        run_lifespan(events)
    assert events == ['start_guard', 'guard']
