"""Owner-only onboarding and host resource maintenance."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from engine_catalog_api import require_owner
import resource_setup

router = APIRouter(prefix='/api/setup-resources', dependencies=[Depends(require_owner)])


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    automatic_updates: StrictBool | None = None
    interval_hours: StrictInt | None = Field(default=None, ge=24, le=720)


class Install(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resources: list[str] = Field(min_length=1, max_length=10)


class ImportArchive(BaseModel):
    model_config = ConfigDict(extra='forbid')
    resource_id: str = Field(min_length=1, max_length=100)
    source_path: str = Field(min_length=1, max_length=4096)
    use_as_masters: StrictBool = False


@router.get('')
def snapshot():
    return resource_setup.manager().snapshot()


@router.patch('/settings')
def settings(request: Settings):
    patch = request.model_dump(exclude_unset=True)
    if not patch or any(value is None for value in patch.values()):
        raise HTTPException(422, 'Indique un réglage de mise à jour valide.')
    return resource_setup.manager().configure(patch)


@router.post('/complete')
def complete():
    return resource_setup.manager().complete()


def start(resources=None, *, updating=False):
    try:
        return resource_setup.manager().start(resources, updating=updating)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post('/install')
def install(request: Install):
    return start(request.resources)


@router.post('/update')
def update():
    return start(updating=True)


@router.post('/import')
def import_archive(request: ImportArchive):
    try:
        return resource_setup.manager().start_import(
            request.resource_id, request.source_path, use_as_masters=request.use_as_masters)
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc
