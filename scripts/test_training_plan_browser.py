"""Program-to-native journeys on an isolated database and browser profile."""
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


def serve(directory, port):
    os.environ['CHESSGYM_DATA_DIR'] = str(Path(directory).resolve())
    sys.path.insert(0, str(ROOT))
    import db, training, jobs
    db.init_db()
    training.init_training()
    fixture = {'bases': [], 'sources': []}
    for name in ('Calcul personnel', 'Parties à étudier'):
        with db.get_conn() as conn:
            bid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
                (name, json.dumps({'review_enabled': True, 'reading_enabled': True, 'type': 'solve', 'mode': 'manual'}), training.stamp())).lastrowid
            fixture['bases'].append(bid)
            for index in range(3):
                pgn = '[Event "Program test"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 {Keep the original notes.} e5 2. Nf3 *'
                eid = conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                    (bid, f'{name} {index + 1}', pgn, training.stamp(), training.stamp())).lastrowid
                fixture['sources'].append({'id': eid, 'pgn': pgn})
        training.queue(bid)
    Path(directory).parent.joinpath('fixture.json').write_text(json.dumps(fixture, ensure_ascii=False), encoding='utf-8')
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    import uvicorn
    uvicorn.run('app:app', host='127.0.0.1', port=port, log_level='warning')


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
        return serve(args.data, args.port)
    deps = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies'
    node = Path(os.environ.get('CHESSGYM_TEST_NODE', shutil.which('node') or str(deps / 'node/bin/node.exe')))
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    output = Path(args.output).resolve() if args.output else ROOT / 'output' / ('training-plan-browser-' + uuid.uuid4().hex)
    output.mkdir(parents=True, exist_ok=True)
    data = output / 'data'
    if data.exists():
        raise SystemExit('Refusing to reuse a browser test database.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'CHESSGYM_TEST_NODE_MODULES': str(deps / 'node/node_modules'),
           'CHESSGYM_TEST_URL': f'http://127.0.0.1:{port}', 'CHESSGYM_TEST_OUTPUT': str(output), 'CHESSGYM_TEST_BROWSER': str(browser)}
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    with (output / 'server.log').open('w', encoding='utf-8') as log:
        server = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--serve', '--data', str(data), '--port', str(port)],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            import httpx
            deadline = time.monotonic() + 40
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
            result = subprocess.run([str(node), str(ROOT / 'tests/training_plan_browser.mjs')], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=360, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            import sqlite3
            fixture = json.loads((output / 'fixture.json').read_text(encoding='utf-8'))
            with sqlite3.connect(data / 'chessgym.sqlite3') as conn:
                for source in fixture['sources']:
                    assert conn.execute('SELECT pgn FROM entries WHERE id=?', (source['id'],)).fetchone()[0] == source['pgn']
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
