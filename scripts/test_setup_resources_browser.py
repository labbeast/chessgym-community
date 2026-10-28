"""Verify onboarding, localization and analysis settings in an isolated real app.

Only engine discovery and downloads are disabled. Automatic local profile creation, resource
settings/completion, persistence, app routing and HTTP endpoints remain real.
The analysis scenario substitutes long-search transports in the browser.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def serve(output, port):
    output = Path(output).resolve()
    os.environ['CHESSGYM_DATA_DIR'] = str(output / 'data')
    os.environ['CHESSGYM_MAIA3_ROOT'] = str(output / 'no-maia-models')
    sys.path.insert(0, str(ROOT))
    import db, jobs, engine_catalog, engine_catalog_api, engine_installations, resource_setup
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    engine_catalog.native_discovery = lambda: None
    db.init_db()
    installer = engine_installations.EngineInstallationManager(output, register=engine_catalog.register_managed)
    def no_download(*args, **kwargs):
        raise AssertionError('This onboarding test must never download resources.')
    installer.start_job = no_download
    engine_catalog_api.set_installation_manager(installer)
    manager = resource_setup.manager()
    manager._services()
    manager.databases.install = no_download
    import uvicorn
    uvicorn.run('app:app', host='127.0.0.1', port=port, log_level='warning')


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--output')
    parser.add_argument('--port', type=int)
    parser.add_argument('--scenario', choices=('setup_resources', 'languages', 'analysis_limits'), default='setup_resources')
    parser.add_argument('--panels-only', action='store_true', help='Check only translated Installation panels in the languages scenario')
    args = parser.parse_args()
    if args.serve:
        return serve(args.output, args.port)
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('resource-onboarding-browser-' + uuid.uuid4().hex)
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'data').exists():
        raise SystemExit('Refusing to reuse a test database.')
    dependencies = Path(os.environ.get('CHESSGYM_TEST_RUNTIME', str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies')))
    node = os.environ.get('CHESSGYM_TEST_NODE', shutil.which('node') or r'C:\Program Files\nodejs\node.exe')
    browser = os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files\Google\Chrome\Application\chrome.exe')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'CHESSGYM_TEST_NODE_MODULES': str(dependencies / 'node/node_modules'),
           'CHESSGYM_TEST_URL': f'http://127.0.0.1:{port}', 'CHESSGYM_TEST_OUTPUT': str(output), 'CHESSGYM_TEST_BROWSER': browser,
           'CHESSGYM_TEST_LANGUAGE_PANELS_ONLY': '1' if args.panels_only else '0'}
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    with (output / 'server.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--serve', '--output', str(output), '--port', str(port)], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            import httpx
            deadline = time.monotonic() + 60
            while True:
                if server.poll() is not None:
                    raise RuntimeError('Isolated server failed; inspect server.log')
                try:
                    if httpx.get(env['CHESSGYM_TEST_URL'] + '/api/status', timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                if time.monotonic() > deadline:
                    raise TimeoutError('Isolated server startup timed out')
                time.sleep(.1)
            result = subprocess.run([node, str(ROOT / 'tests' / (args.scenario + '_browser.mjs'))], env=env, cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            if not result.returncode:
                settings = json.loads((output / 'data' / 'resource-setup.json').read_text(encoding='utf-8'))
                assert settings['setup_complete'] is True
                assert settings['managed'] == {}, 'Skipping onboarding downloaded resources'
                assert settings['settings']['automatic_updates'] is False
            print(json.dumps({'output': str(output), 'exit_code': result.returncode}, ensure_ascii=False))
            print(result.stdout)
            if result.returncode:
                print(result.stderr)
                raise SystemExit(result.returncode)
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=5)


if __name__ == '__main__':
    main()
