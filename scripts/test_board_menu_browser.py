"""Exercise the Board menu in an isolated database and fresh browser profile."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def serve(directory, port):
    os.environ['CHESSGYM_DATA_DIR'] = str(Path(directory).resolve())
    sys.path.insert(0, str(ROOT))
    import db
    import jobs
    import engine
    db.init_db()
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    engine.binary_path = lambda: None
    import app
    from fastapi import Depends
    from accounts_api import require_user
    saved_identity = {}

    # The application has one owner per database. This route exists only in
    # this isolated server and simulates a restored database on the same URL.
    @app.app.post('/__test__/workspace-identity')
    def switch_test_identity(payload: dict, user=Depends(require_user)):
        with db.get_conn() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if payload.get('other'):
                saved_identity['name'] = conn.execute('SELECT username FROM users WHERE id=1').fetchone()[0]
                saved_identity['epoch'] = conn.execute("SELECT value FROM preferences WHERE key='workspace_epoch'").fetchone()
                saved_identity['items'] = [tuple(row) for row in conn.execute('SELECT * FROM user_workspaces WHERE user_id=1')]
                conn.execute('DELETE FROM user_workspaces WHERE user_id=1')
                conn.execute("UPDATE users SET username='board-other-test' WHERE id=1")
                conn.execute("INSERT INTO preferences(key,value) VALUES('workspace_epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps('board-menu-other-fixture'),))
            else:
                conn.execute('DELETE FROM user_workspaces WHERE user_id=1')
                conn.executemany('INSERT INTO user_workspaces VALUES(?,?,?,?,?,?)', saved_identity['items'])
                conn.execute('UPDATE users SET username=? WHERE id=1', (saved_identity['name'],))
                if saved_identity['epoch']:
                    conn.execute("UPDATE preferences SET value=? WHERE key='workspace_epoch'", (saved_identity['epoch'][0],))
                else:
                    conn.execute("DELETE FROM preferences WHERE key='workspace_epoch'")
        return {'ok': True}
    import uvicorn
    uvicorn.run(app.app, host='127.0.0.1', port=port, log_level='warning')


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--data')
    parser.add_argument('--port', type=int)
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.serve:
        serve(args.data, args.port)
        return
    dependencies = Path(os.environ.get('CHESSGYM_TEST_RUNTIME', str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies')))
    node = Path(os.environ.get('CHESSGYM_TEST_NODE', str(dependencies / 'node/bin/node.exe')))
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    if not node.is_file() or not browser.is_file():
        raise SystemExit('Set CHESSGYM_TEST_NODE and CHESSGYM_TEST_BROWSER to local runtimes.')
    output = Path(args.output).resolve() if args.output else ROOT / 'output' / ('board-menu-browser-' + uuid.uuid4().hex)
    output.mkdir(parents=True, exist_ok=True)
    data = output / 'data'
    if data.exists():
        raise SystemExit('Refusing to reuse an existing test database directory.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'CHESSGYM_TEST_NODE_MODULES': str(dependencies / 'node/node_modules'),
           'CHESSGYM_TEST_URL': f'http://127.0.0.1:{port}', 'CHESSGYM_TEST_OUTPUT': str(output),
           'CHESSGYM_TEST_BROWSER': str(browser)}
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    with (output / 'server.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--serve', '--data', str(data), '--port', str(port)],
                                  cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            import httpx
            deadline = time.monotonic() + 30
            while True:
                if server.poll() is not None:
                    raise RuntimeError('Isolated server failed; inspect ' + str(output / 'server.log'))
                try:
                    if httpx.get(env['CHESSGYM_TEST_URL'] + '/api/status', timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                if time.monotonic() > deadline:
                    raise TimeoutError('Isolated server startup timed out')
                time.sleep(.1)
            result = subprocess.run([str(node), str(ROOT / 'tests/board_menu_browser.mjs')], env=env, cwd=ROOT,
                                    capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=240, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
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
