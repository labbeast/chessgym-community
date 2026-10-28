"""Owner-only application version controls."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from engine_catalog_api import require_owner
import app_updates

router = APIRouter(prefix='/api/app-updates', dependencies=[Depends(require_owner)])


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid')
    automatic_updates: StrictBool | None = None
    interval_hours: StrictInt | None = Field(default=None, ge=24, le=720)


def action(callback):
    try:
        return callback()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('')
def status():
    return action(lambda: app_updates.manager().snapshot())


@router.patch('/settings')
def settings(request: Settings):
    return action(lambda: app_updates.manager().configure(request.model_dump(exclude_unset=True)))


@router.post('/check')
def check():
    return action(lambda: app_updates.manager().start())


@router.post('/install')
def install():
    return action(lambda: app_updates.manager().start(install=True))


@router.post('/restart')
def restart():
    return action(lambda: app_updates.manager().restart())
