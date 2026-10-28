"""Access boundary for a local, single-user application without a login screen."""
from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

LOCAL_ONLY = 'ChessGym est accessible uniquement depuis cet ordinateur.'
SAME_ORIGIN = 'Cette requête doit provenir de ChessGym.'


def is_loopback_address(value):
    try:
        address = ipaddress.ip_address(value)
        mapped = getattr(address, 'ipv4_mapped', None)
        return address.is_loopback or bool(mapped and mapped.is_loopback)
    except (ValueError, TypeError):
        return False


def is_local_host(value):
    return isinstance(value, str) and (value.lower() in ('localhost', 'localhost.') or is_loopback_address(value))


def _authority(value):
    # Do not accept URL credentials, paths, whitespace or malformed IPv6 as Host.
    if not value or any(character.isspace() for character in value) or any(character in value for character in '/\\?#@'):
        raise ValueError('Invalid local authority')
    parsed = urlsplit('//' + value)
    if not is_local_host(parsed.hostname):
        raise ValueError('Non-local authority')
    port = parsed.port
    if port is not None and not 1 <= port <= 65535:
        raise ValueError('Invalid port')
    return parsed.hostname.lower(), port


def require_local_request(request: Request):
    """Reject network access, DNS rebinding and requests from another website.

    Direct local tools may omit browser headers. Browser navigations to the app
    from a normal link remain usable, while cross-origin API calls are rejected.
    No proxy or forwarded-host header can widen the accepted local authority.
    """
    if request.client is None or not is_loopback_address(request.client.host):
        raise HTTPException(403, LOCAL_ONLY)
    if len(request.headers.getlist('host')) != 1:
        raise HTTPException(403, LOCAL_ONLY)
    try:
        hostname, port = _authority(request.headers.get('host', ''))
    except (ValueError, TypeError):
        raise HTTPException(403, LOCAL_ONLY)

    origin = request.headers.get('origin')
    if origin is not None:
        try:
            parsed = urlsplit(origin)
            origin_hostname, origin_port = _authority(parsed.netloc)
            if (parsed.scheme not in ('http', 'https') or parsed.path or parsed.query or parsed.fragment or
                    (parsed.scheme, origin_hostname, origin_port or (443 if parsed.scheme == 'https' else 80)) !=
                    (request.url.scheme, hostname, port or (443 if request.url.scheme == 'https' else 80))):
                raise ValueError('Cross-origin request')
        except (ValueError, TypeError):
            raise HTTPException(403, SAME_ORIGIN)

    site = request.headers.get('sec-fetch-site', '').lower()
    linked_home = (request.method in ('GET', 'HEAD') and request.url.path == '/' and origin is None and
                   request.headers.get('sec-fetch-mode', '').lower() == 'navigate')
    if site and site not in ('same-origin', 'none') and not linked_home:
        raise HTTPException(403, SAME_ORIGIN)
