"""Small, validated account preferences for local sound effects."""
import json
import math

from fastapi import HTTPException

DEFAULT_SOUND = dict(enabled=True, volume=0.35, moves=True, feedback=True, navigation=False)


def read(conn):
    row = conn.execute("SELECT value FROM preferences WHERE key='sound'").fetchone()
    try:
        value = json.loads(row['value']) if row else {}
        return validate(value)
    except (ValueError, TypeError, HTTPException):
        return DEFAULT_SOUND.copy()


def validate(value, current=None):
    if not isinstance(value, dict) or set(value) - set(DEFAULT_SOUND):
        raise HTTPException(400, 'Réglages sonores invalides.')
    result = {**DEFAULT_SOUND, **(current or {})}
    for key, setting in value.items():
        if key == 'volume':
            if type(setting) not in (int, float) or not math.isfinite(setting) or not 0 <= setting <= 1:
                raise HTTPException(400, 'Le volume doit être compris entre 0 et 100 %.')
        elif type(setting) is not bool:
            raise HTTPException(400, 'Les options sonores doivent être activées ou désactivées.')
        result[key] = setting
    return result
