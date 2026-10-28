"""Opt-in, paired-device access on private networks; never a public proxy mode."""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

from fastapi import HTTPException, Request

import db
from local_access import LOCAL_ONLY, SAME_ORIGIN, is_loopback_address, require_local_request

COOKIE = 'chessgym_device'
MAX_AGE = 30 * 24 * 60 * 60
PAIRING_REQUIRED = 'Associe cet appareil depuis ChessGym sur ton ordinateur.'
INVALID_PAIRING = 'Ce lien d’association est invalide ou a expiré.'
PAIRING_LIMIT = 'Trop de tentatives d’association. Réessaie dans quelques minutes.'
_PRIVATE_V4 = tuple(ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'))
_PRIVATE_V6 = ipaddress.ip_network('fc00::/7')
_TAILSCALE_V4 = ipaddress.ip_network('100.64.0.0/10')
_TAILSCALE_V6 = ipaddress.ip_network('fd7a:115c:a1e0::/48')
_LOCK = threading.RLock()
_RUNTIME = {}
PUBLIC_ASSETS = frozenset(('/static/private-pair.js', '/static/private-pair.css', '/static/private-access-messages.js'))


def _key():
    return str(Path(db.DATA_DIR).resolve())


def _runtime():
    return _RUNTIME.setdefault(_key(), {'listener': None, 'started': False, 'enabled_at_start': False, 'hosts': (), 'attempts': {}})


def _path():
    return Path(db.DATA_DIR) / 'private-access.json'


def _config():
    try:
        value = json.loads(_path().read_text(encoding='utf-8'))
        if (not isinstance(value, dict) or value.get('version') != 1 or type(value.get('enabled')) is not bool
                or any(not isinstance(value.get(key), str) or len(value[key]) != 64
                       or any(char not in '0123456789abcdef' for char in value[key])
                       for key in ('pairing_secret', 'signing_key'))):
            raise ValueError('Invalid private-access configuration')
        return value
    except (OSError, ValueError, TypeError):
        # Missing or damaged configuration must never enable network access.
        return {'version': 1, 'enabled': False}


def enabled():
    with _LOCK:
        return _config()['enabled']


def _write(value):
    directory = Path(db.DATA_DIR)
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / ('.private-access-' + secrets.token_hex(12) + '.tmp')
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, _path())
    finally:
        temporary.unlink(missing_ok=True)


def _address(value):
    if not isinstance(value, str) or '%' in value:
        return None
    try:
        address = ipaddress.ip_address(value)
        return getattr(address, 'ipv4_mapped', None) or address
    except ValueError:
        return None


def is_private_address(value):
    address = _address(value)
    return bool(address and (any(address in network for network in _PRIVATE_V4) if address.version == 4 else address in _PRIVATE_V6))


def detect_addresses():
    """Read assigned interface addresses, with hostname resolution as a fallback."""
    found, preferred = set(), set()
    try:
        found.update(item[4][0] for item in socket.getaddrinfo(socket.gethostname(), None))
    except OSError:
        pass
    try:
        options = {'capture_output': True, 'text': True, 'timeout': 5, 'check': True}
        if os.name == 'nt':
            script = ("$chessGymRoute = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' "
                      "-ErrorAction SilentlyContinue | Sort-Object @{Expression={ $_.RouteMetric + "
                      "(Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4).InterfaceMetric }} "
                      "| Select-Object -First 1; "
                      "if ($chessGymRoute) { Get-NetIPAddress -InterfaceIndex $chessGymRoute.InterfaceIndex "
                      "-AddressFamily IPv4 -AddressState Preferred | ForEach-Object { 'preferred:' + $_.IPAddress } }; "
                      "Get-NetIPAddress -AddressState Preferred | Select-Object -ExpandProperty IPAddress")
            result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0), **options)
            for value in result.stdout.split():
                if value.startswith('preferred:'):
                    preferred.add(value.removeprefix('preferred:'))
                else:
                    found.add(value)
        elif sys.platform.startswith('linux'):
            result = subprocess.run(['ip', '-j', 'address', 'show', 'up'], **options)
            found.update(address['local'] for adapter in json.loads(result.stdout)
                         for address in adapter.get('addr_info', []) if 'local' in address)
        elif sys.platform == 'darwin':
            result = subprocess.run(['/sbin/ifconfig'], **options)
            for line in result.stdout.splitlines():
                fields = line.split()
                if len(fields) > 1 and fields[0] in ('inet', 'inet6'):
                    found.add(fields[1])
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError):
        pass
    addresses = {str(_address(value)) for value in found | preferred if is_private_address(value)}
    def priority(value):
        address = _address(value)
        tailscale = address in (_TAILSCALE_V4 if address.version == 4 else _TAILSCALE_V6)
        return (0 if value in preferred else 1 if tailscale else 2, value)
    return tuple(sorted(addresses, key=priority))


def configure_listener(host):
    with _LOCK:
        _runtime()['listener'] = host


def start():
    with _LOCK:
        state = _runtime()
        listener = state['listener']
        network = listener in ('0.0.0.0', '::') or is_private_address(listener)
        state.update(started=True, enabled_at_start=bool(network and _config()['enabled']), attempts={})
        addresses = detect_addresses() if state['enabled_at_start'] else ()
        if listener == '0.0.0.0':
            addresses = tuple(value for value in addresses if _address(value).version == 4)
        elif listener == '::':
            addresses = tuple(value for value in addresses if _address(value).version == 6)
        elif is_private_address(listener):
            addresses = tuple(value for value in addresses if value == str(_address(listener)))
        state['hosts'] = addresses


def active():
    with _LOCK:
        return bool(_runtime()['enabled_at_start'] and _config()['enabled'])


def _new_config(enabled_value):
    return {'version': 1, 'enabled': enabled_value, 'pairing_secret': secrets.token_hex(32), 'signing_key': secrets.token_hex(32)}


def set_enabled(value):
    with _LOCK:
        config = _config()
        if config['enabled'] != value or 'signing_key' not in config:
            # Both disabling and re-enabling invalidate every previous link/device.
            _write(_new_config(value))
            _runtime()['attempts'] = {}


def rotate():
    with _LOCK:
        _write(_new_config(_config()['enabled']))
        _runtime()['attempts'] = {}


def status(port):
    with _LOCK:
        config, state = _config(), _runtime()
        urls = []
        if config['enabled']:
            addresses = state['hosts'] if state['enabled_at_start'] else detect_addresses()
            # The automatic listener is IPv4; IPv6 is opt-in through CHESSGYM_HOST=::.
            if state['listener'] != '::':
                addresses = tuple(value for value in addresses if _address(value).version == 4)
            for value in addresses:
                address = _address(value)
                host = '[' + value + ']' if address.version == 6 else value
                tailscale = address in (_TAILSCALE_V4 if address.version == 4 else _TAILSCALE_V6)
                urls.append({'label': 'tailscale' if tailscale else 'lan',
                             'url': f'http://{host}:{port}/#pair={config["pairing_secret"]}'})
        return {'enabled': config['enabled'], 'active': active(),
                'restart_required': config['enabled'] != state['enabled_at_start'],
                'pairing_urls': urls, 'expires_days': MAX_AGE // 86400}


def is_local_request(request):
    try:
        require_local_request(request)
        return True
    except HTTPException:
        return False


def require_private_request(request):
    """Validate actual peer, exact assigned IP Host and browser origin before auth."""
    with _LOCK:
        hosts = set(_runtime()['hosts'])
    if not active() or request.client is None or not is_private_address(request.client.host):
        raise HTTPException(403, LOCAL_ONLY)
    if len(request.headers.getlist('host')) != 1:
        raise HTTPException(403, LOCAL_ONLY)
    value = request.headers.get('host', '')
    try:
        if not value or any(character.isspace() for character in value) or any(character in value for character in '/\\?#@'):
            raise ValueError('Invalid authority')
        parsed = urlsplit('//' + value)
        address = _address(parsed.hostname)
        if not address or str(address) not in hosts or parsed.port is not None and not 1 <= parsed.port <= 65535:
            raise ValueError('Unknown interface')
        port = parsed.port or (443 if request.url.scheme == 'https' else 80)
        # The Host must name the listener port, not an arbitrary service/proxy.
        if request.scope.get('server') and port != request.scope['server'][1]:
            raise ValueError('Wrong port')
    except (ValueError, TypeError):
        raise HTTPException(403, LOCAL_ONLY)
    if len(request.headers.getlist('origin')) > 1:
        raise HTTPException(403, SAME_ORIGIN)
    origin = request.headers.get('origin')
    if origin is None and request.method not in ('GET', 'HEAD', 'OPTIONS'):
        raise HTTPException(403, SAME_ORIGIN)
    if origin is not None:
        try:
            other = urlsplit(origin)
            if (other.scheme not in ('http', 'https') or other.path or other.query or other.fragment
                    or other.username is not None or other.password is not None or _address(other.hostname) != address
                    or (other.scheme, other.port or (443 if other.scheme == 'https' else 80)) != (request.url.scheme, port)):
                raise ValueError('Cross-origin request')
        except (ValueError, TypeError):
            raise HTTPException(403, SAME_ORIGIN)
    site = request.headers.get('sec-fetch-site', '').lower()
    linked_home = (request.method in ('GET', 'HEAD') and request.url.path == '/' and origin is None
                   and request.headers.get('sec-fetch-mode', '').lower() == 'navigate')
    if site and site not in ('same-origin', 'none') and not linked_home:
        raise HTTPException(403, SAME_ORIGIN)


def _signature(body, config):
    return hmac.new(bytes.fromhex(config['signing_key']), body.encode('ascii'), hashlib.sha256).hexdigest()


def valid_device(request):
    value = request.cookies.get(COOKIE, '')
    if len(value) > 180:
        return False
    with _LOCK:
        config = _config()
    if not config['enabled']:
        return False
    try:
        stamp, nonce, signature = value.split('.')
        issued = int(stamp)
        now = int(time.time())
        if not 0 <= now - issued <= MAX_AGE or len(nonce) != 32 or any(char not in '0123456789abcdef' for char in nonce):
            return False
        return hmac.compare_digest(signature, _signature(stamp + '.' + nonce, config))
    except (ValueError, TypeError, KeyError, UnicodeError):
        return False


def require_authenticated_request(request):
    if is_local_request(request):
        return
    require_private_request(request)
    if not valid_device(request):
        raise HTTPException(403, PAIRING_REQUIRED)


def pair(request, token):
    require_private_request(request)
    with _LOCK:
        now = time.monotonic()
        attempts = _runtime()['attempts']
        for peer in list(attempts):
            attempts[peer] = [at for at in attempts[peer] if now - at < 300]
            if not attempts[peer]:
                del attempts[peer]
        peer = str(_address(request.client.host))
        if len(attempts.get(peer, [])) >= 10 or sum(map(len, attempts.values())) >= 100:
            raise HTTPException(429, PAIRING_LIMIT, headers={'Retry-After': '300'})
        attempts.setdefault(peer, []).append(now)
        config = _config()
        if (not isinstance(token, str) or len(token) != 64 or any(char not in '0123456789abcdef' for char in token)
                or not hmac.compare_digest(token, config['pairing_secret'])):
            raise HTTPException(403, INVALID_PAIRING)
        body = str(int(time.time())) + '.' + secrets.token_hex(16)
        return body + '.' + _signature(body, config)
