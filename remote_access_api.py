"""Private-device pairing and local-only administration."""
import json
from fastapi import APIRouter, HTTPException, Request, Response

from local_access import require_local_request
import remote_access

router = APIRouter(prefix='/api/private-access')


def _status(request):
    return remote_access.status(request.scope.get('server', ('127.0.0.1', 8765))[1])


@router.get('')
def status(request: Request):
    require_local_request(request)
    return _status(request)


@router.patch('')
def configure(payload: dict, request: Request):
    require_local_request(request)
    if set(payload) != {'enabled'} or type(payload['enabled']) is not bool:
        raise HTTPException(400, 'Choisis si l’accès privé est activé.')
    remote_access.set_enabled(payload['enabled'])
    return _status(request)


@router.post('/rotate')
def rotate(request: Request):
    require_local_request(request)
    remote_access.rotate()
    return _status(request)


@router.post('/pair')
async def pair(request: Request, response: Response):
    # This is the only unauthenticated write endpoint. Bound the actual stream,
    # including chunked requests, before JSON parsing rather than trusting length.
    remote_access.require_private_request(request)
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > 1024:
            raise HTTPException(413, 'Lien d’association trop long.')
        body.extend(chunk)
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeError):
        payload = None
    token = payload.get('token') if isinstance(payload, dict) and set(payload) == {'token'} else None
    cookie = remote_access.pair(request, token)
    response.set_cookie(remote_access.COOKIE, cookie, max_age=remote_access.MAX_AGE, httponly=True,
                        secure=request.url.scheme == 'https', samesite='strict', path='/')
    return {'paired': True}
