"""Private credentials for the public opening explorer.

Tokens are stored in the owner's local SQLite database, not browser-readable
preferences. This is private application storage, not encrypted secret storage;
portable private backups include this table. Environment configuration wins.
"""
from datetime import datetime, timezone
import os
import re

from fastapi import APIRouter, HTTPException

import db


router = APIRouter(prefix='/api/explorer')
SERVICE = 'lichess_explorer'
ENVIRONMENT_KEY = 'CHESSGYM_LICHESS_TOKEN'
TOKEN_PATTERN = re.compile(r'[!-~]{8,2048}')


def _valid_token(token):
    return isinstance(token, str) and TOKEN_PATTERN.fullmatch(token) is not None


def _environment_value():
    # Empty/unset environment configuration allows the local owner setting.
    return os.environ.get(ENVIRONMENT_KEY) or None


def get_token():
    """Read the active token only for server-side requests; never serialize it."""
    environment = _environment_value()
    if environment is not None:
        # Invalid configuration must never become an HTTP header or silently
        # fall back to a different local account. Connection reports this state.
        return environment if _valid_token(environment) else None
    with db.get_conn() as conn:
        row = conn.execute('SELECT token FROM service_credentials WHERE service=?', (SERVICE,)).fetchone()
    return row['token'] if row and _valid_token(row['token']) else None


@router.get('/connection')
def connection():
    environment = _environment_value()
    if environment is not None:
        return {'configured': _valid_token(environment), 'source': 'environment'}
    configured = get_token() is not None
    return {'configured': configured, 'source': 'local' if configured else None}


@router.patch('/connection')
def set_connection(payload: dict):
    if set(payload) != {'token'}:
        raise ValueError('Le réglage de connexion doit contenir uniquement le champ token.')
    if _environment_value() is not None:
        raise HTTPException(409, 'Le jeton Lichess est défini dans la configuration du serveur. Modifie cette configuration pour le remplacer ou le retirer.')
    token = payload['token']
    if not isinstance(token, str) or token != '' and not _valid_token(token):
        raise ValueError('Le jeton doit contenir de 8 à 2 048 caractères ASCII, sans espaces ni caractères de contrôle.')
    with db.get_conn() as conn:
        if token == '':
            conn.execute('DELETE FROM service_credentials WHERE service=?', (SERVICE,))
        else:
            conn.execute('INSERT INTO service_credentials(service,token,updated_at) VALUES(?,?,?) ON CONFLICT(service) DO UPDATE SET token=excluded.token,updated_at=excluded.updated_at',
                         (SERVICE, token, datetime.now(timezone.utc).isoformat()))
    return connection()
