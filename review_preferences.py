"""Validated global review preferences; each new base stores its own snapshot."""
from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException


DEFAULT_AUTO_MASTERY_DAYS = 180
DEFAULT_REVIEW_MULTIPLIERS = {'hard': 1.2, 'medium': 2, 'easy': 3}
DEFAULT_REVIEW_SETTINGS = {'again': 10, 'hard': 2, 'medium': 5, 'easy': 10, 'new_limit': None}
DEFAULT_SESSION = {'minutes': None, 'cards': None}
DEFAULT_STUDY_DAY = {'timezone': 'UTC', 'start_hour': 0}
DEFAULT_MAINTENANCE = {'enabled': True, 'interval_days': 30, 'daily_limit': 5}

REVIEW_LIMITS = {'again': (1, 1440), 'hard': (0.01, 3650), 'medium': (0.01, 3650), 'easy': (0.01, 3650), 'new_limit': (0, 1000)}


def checked_auto_mastery(value):
    if type(value) is not int or not 1 <= value <= 3650:
        raise HTTPException(400, 'Le seuil de maîtrise doit être un entier de 1 à 3 650 jours.')
    return value


def checked_review_defaults(patch, current=None):
    if not isinstance(patch, dict) or set(patch) - DEFAULT_REVIEW_SETTINGS.keys():
        raise HTTPException(400, 'Réglages de révision par défaut inconnus.')
    result = {**DEFAULT_REVIEW_SETTINGS, **(current or {}), **patch}
    if result['new_limit'] == '':
        result['new_limit'] = None
    for key, (low, high) in REVIEW_LIMITS.items():
        value = result[key]
        if key == 'new_limit' and value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise HTTPException(400, 'Valeur de révision par défaut hors limites : ' + key)
        if key == 'new_limit':
            if int(value) != value:
                raise HTTPException(400, 'La limite de nouvelles cartes doit être un entier ou rester vide.')
            result[key] = int(value)
    return result


def checked_review_multipliers(patch, current=None):
    if not isinstance(patch, dict) or set(patch) - DEFAULT_REVIEW_MULTIPLIERS.keys():
        raise HTTPException(400, 'Multiplicateurs de révision inconnus.')
    result = {**DEFAULT_REVIEW_MULTIPLIERS, **(current or {}), **patch}
    for key, value in result.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not .1 <= value <= 10:
            raise HTTPException(400, 'Le multiplicateur doit être un nombre de 0,1 à 10 : ' + key)
    return result


PREFERENCE_KEYS = ('auto_mastery_days', 'review_defaults', 'review_multipliers',
                   'review_session_defaults', 'study_day', 'review_maintenance')


def _stored_many(conn, keys):
    """Read a coherent preference snapshot in one query, without caching edits."""
    try:
        rows = conn.execute('SELECT key,value FROM preferences WHERE key IN (' +
                            ','.join('?' for _ in keys) + ')', keys).fetchall()
    except sqlite3.OperationalError as error:
        # Training migrations may run before the legacy preferences table exists.
        # Schema corruption and locking failures must still surface.
        if str(error) == 'no such table: preferences':
            return {}
        raise
    values = {}
    for key, raw in rows:
        try:
            values[key] = json.loads(raw)
        except (ValueError, TypeError):
            pass
    return values


def _stored(conn, key):
    return _stored_many(conn, (key,)).get(key)


def read(conn):
    stored = _stored_many(conn, PREFERENCE_KEYS)
    try:
        threshold = checked_auto_mastery(stored.get('auto_mastery_days'))
    except HTTPException:
        threshold = DEFAULT_AUTO_MASTERY_DAYS
    defaults = dict(DEFAULT_REVIEW_SETTINGS)
    saved = stored.get('review_defaults')
    if isinstance(saved, dict):
        # Preserve valid saved fields if an old/manual preference contains a bad field.
        for key in DEFAULT_REVIEW_SETTINGS:
            if key in saved:
                try:
                    defaults = checked_review_defaults({key: saved[key]}, defaults)
                except HTTPException:
                    pass
    multipliers = dict(DEFAULT_REVIEW_MULTIPLIERS)
    saved_multipliers = stored.get('review_multipliers')
    if isinstance(saved_multipliers, dict):
        for key in DEFAULT_REVIEW_MULTIPLIERS:
            if key in saved_multipliers:
                try:
                    multipliers = checked_review_multipliers({key: saved_multipliers[key]}, multipliers)
                except HTTPException:
                    pass
    session = checked_session_defaults({})
    day = dict(DEFAULT_STUDY_DAY)
    for key, checker in (('review_session_defaults', checked_session_defaults), ('study_day', checked_study_day)):
        value = stored.get(key)
        if isinstance(value, dict):
            try:
                result = checker(value)
                if key == 'study_day': day = result
                else: session = result
            except HTTPException:
                pass
    maintenance = dict(DEFAULT_MAINTENANCE)
    saved_maintenance = stored.get('review_maintenance')
    if isinstance(saved_maintenance, dict):
        for key in DEFAULT_MAINTENANCE:
            if key in saved_maintenance:
                try:
                    maintenance = checked_maintenance({key: saved_maintenance[key]}, maintenance)
                except HTTPException:
                    pass
    return {'auto_mastery_days': threshold, 'review_defaults': defaults, 'review_multipliers': multipliers,
            'review_session_defaults': session, 'study_day': day, 'review_maintenance': maintenance}



def checked_session_defaults(patch, current=None):
    if not isinstance(patch, dict) or set(patch) - DEFAULT_SESSION.keys():
        raise HTTPException(400, 'Objectif de séance inconnu.')
    result = {**DEFAULT_SESSION, **(current or {}), **patch}
    for key, maximum in (('minutes', 480), ('cards', 100000)):
        value = result[key]
        if value in (None, ''):
            result[key] = None
        elif type(value) is not int or not 1 <= value <= maximum:
            raise HTTPException(400, 'L’objectif doit être un entier positif ou rester vide : ' + key)
    return result


def checked_maintenance(patch, current=None):
    if not isinstance(patch, dict) or set(patch) - DEFAULT_MAINTENANCE.keys():
        raise HTTPException(400, 'Réglage d’entretien des acquis inconnu.')
    result = {**DEFAULT_MAINTENANCE, **(current or {}), **patch}
    if type(result['enabled']) is not bool:
        raise HTTPException(400, 'L’entretien doit être activé ou désactivé.')
    for key, maximum in (('interval_days', 3650), ('daily_limit', 100)):
        if type(result[key]) is not int or not 1 <= result[key] <= maximum:
            raise HTTPException(400, 'Valeur d’entretien hors limites : ' + key)
    return result


def checked_study_day(patch, current=None):
    if not isinstance(patch, dict) or set(patch) - DEFAULT_STUDY_DAY.keys():
        raise HTTPException(400, 'Réglage de journée d’étude inconnu.')
    result = {**DEFAULT_STUDY_DAY, **(current or {}), **patch}
    if type(result['start_hour']) is not int or not 0 <= result['start_hour'] <= 23:
        raise HTTPException(400, 'Le début de journée doit être compris entre 0 et 23 heures.')
    try:
        if not isinstance(result['timezone'], str) or not 1 <= len(result['timezone']) <= 100:
            raise ValueError()
        ZoneInfo(result['timezone'])
    except (ValueError, ZoneInfoNotFoundError):
        raise HTTPException(400, 'Le fuseau horaire est invalide.')
    return result


def validate_patch(patch, current):
    """Validated review preference subset, ready for the owner's transaction."""
    checkers = {'auto_mastery_days': lambda value, _: checked_auto_mastery(value),
                'review_defaults': checked_review_defaults, 'review_multipliers': checked_review_multipliers,
                'review_session_defaults': checked_session_defaults, 'study_day': checked_study_day,
                'review_maintenance': checked_maintenance}
    if not isinstance(patch, dict) or set(patch) - checkers.keys():
        raise HTTPException(400, 'Réglages de révision inconnus.')
    return {key: checkers[key](value, current.get(key)) for key, value in patch.items()}


def day_bounds(current, settings):
    """Local study-date and UTC boundaries; handles 23/25-hour DST days."""
    zone = ZoneInfo(settings['timezone'])
    local = current.astimezone(zone)
    date = local.date()
    if local.hour < settings['start_hour']:
        date -= timedelta(days=1)
    def boundary(date):
        return datetime.combine(date, time(settings['start_hour']), zone).astimezone(timezone.utc)
    return date, boundary(date), boundary(date + timedelta(days=1))


def study_date(current, settings):
    return day_bounds(current, settings)[0]
