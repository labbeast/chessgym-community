"""Local supervisor: graceful app updates keep the launcher process stable."""
import os
import ipaddress
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parent
os.chdir(ROOT)


def local_host():
    """Use private-network listening only after explicit local activation."""
    import remote_access
    private = remote_access.enabled()
    host = os.getenv('CHESSGYM_HOST', '0.0.0.0' if private else '127.0.0.1').strip()
    if host.lower() == 'localhost':
        return host
    try:
        if ipaddress.ip_address(host).is_loopback:
            return host
    except ValueError:
        pass
    if private and (host in ('0.0.0.0', '::') or remote_access.is_private_address(host)):
        return host
    raise SystemExit('ChessGym est accessible uniquement depuis cet ordinateur. Active l’accès privé dans les réglages pour utiliser une adresse réseau privée.')


def serve():
    host = local_host()
    import remote_access
    remote_access.configure_listener(host)
    import uvicorn
    import app_updates
    from app_update_worker import RESTART_EXIT
    server = uvicorn.Server(uvicorn.Config('app:app', host=host,
                                         port=int(os.getenv('CHESSGYM_PORT', '8765')), access_log=False, proxy_headers=False))
    restarting = False
    def restart():
        nonlocal restarting
        restarting = True
        server.should_exit = True
    if os.environ.get('CHESSGYM_SUPERVISED') == '1':
        app_updates.set_restart_callback(restart)
    server.run()
    return RESTART_EXIT if restarting else 0


if __name__=='__main__':
    if sys.argv[1:] == ['--serve']:
        raise SystemExit(serve())
    if sys.argv[1:]:
        raise SystemExit('Argument de lancement inconnu.')
    from app_update_worker import supervise
    raise SystemExit(supervise(ROOT))
