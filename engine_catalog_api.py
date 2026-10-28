"""Owner-only local engine management; no account-library writes."""
from __future__ import annotations

from typing import Annotated
import threading

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints

from accounts_api import require_user
import engine_catalog


def require_owner(user=Depends(require_user)):
    if user.get('id') != 1:
        raise HTTPException(403, 'Seul le propriétaire du serveur peut gérer les moteurs.')
    return user


router = APIRouter(prefix='/api/engines', dependencies=[Depends(require_owner)])
_MANAGER = None
_MANAGER_LOCK = threading.Lock()


def set_installation_manager(manager):
    global _MANAGER
    with _MANAGER_LOCK:
        _MANAGER = manager


def installation_manager():
    global _MANAGER
    with _MANAGER_LOCK:
        if _MANAGER is None:
            from engine_installations import EngineInstallationManager
            _MANAGER = EngineInstallationManager(engine_catalog.ROOT, register=engine_catalog.register_managed)
        return _MANAGER


Name = Annotated[str, StringConstraints(min_length=1, max_length=120)]
LocalPath = Annotated[str, StringConstraints(min_length=1, max_length=4096)]
EngineId = Annotated[str, StringConstraints(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9_.-]+$')]


class Mutation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: StrictInt | None = Field(default=None, ge=0)


class AddRequest(Mutation):
    name: Name
    path: LocalPath


class EditRequest(Mutation):
    name: Name | None = None
    path: LocalPath | None = None


class SelectRequest(Mutation):
    analysis: EngineId | None = None
    maia: EngineId | None = None


class InstallRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    catalog_id: EngineId


def _catalog(state=None):
    manager = installation_manager()
    return {**(state or engine_catalog.snapshot()), 'catalog': manager.catalog(), 'job': manager.status()}


@router.get('/catalog')
def catalog():
    return _catalog()


@router.post('')
def add(request: AddRequest):
    return _catalog(engine_catalog.add(request.name, request.path, request.expected_revision))


# Static routes precede parameterized routes.
@router.patch('/selection')
def select(request: SelectRequest):
    patch = request.model_dump(exclude_unset=True, exclude={'expected_revision'})
    if not patch:
        raise HTTPException(422, 'Choisis le rôle du moteur à modifier.')
    return _catalog(engine_catalog.select(patch, request.expected_revision))


@router.post('/install')
def install(request: InstallRequest):
    try:
        return installation_manager().start_job(request.catalog_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('/jobs/{job_id}')
def job(job_id: EngineId):
    result = installation_manager().status(job_id)
    if result is None:
        raise HTTPException(404, 'Installation introuvable.')
    return result


@router.post('/updates')
def updates():
    return installation_manager().check_updates()


@router.patch('/{engine_id}')
def edit(engine_id: EngineId, request: EditRequest):
    patch = request.model_dump(exclude_unset=True, exclude={'expected_revision'})
    if not patch:
        raise HTTPException(422, 'Indique une modification du moteur.')
    return _catalog(engine_catalog.edit(engine_id, patch, request.expected_revision))


@router.post('/{engine_id}/test')
def test(engine_id: EngineId):
    return engine_catalog.test(engine_id)


@router.delete('/{engine_id}')
def delete(engine_id: EngineId, expected_revision: int | None = None):
    return _catalog(engine_catalog.unregister(engine_id, expected_revision))
