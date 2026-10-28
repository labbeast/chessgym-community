"""Local supervisor: graceful app updates keep the launcher process stable."""
import os
import ipaddress
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parent
os.chdir(ROOT)


def local_host():
    """A password-free desktop instance must never listen on the network."""
    host = os.getenv('CHESSGYM_HOST', '127.0.0.1').strip()
    if host.lower() == 'localhost':
        return host
    try:
        if ipaddress.ip_address(host).is_loopback:
            return host
    except ValueError:
        pass
    raise SystemExit('ChessGym est accessible uniquement depuis cet ordinateur. Utilise 127.0.0.1 ou ::1 pour CHESSGYM_HOST.')


def serve():
    host = local_host()
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
