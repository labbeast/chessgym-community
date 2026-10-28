"""Real-browser terminal-comment checks on a fresh, isolated database and Edge profile."""
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


def seed(directory):
    import db, training
    db.init_db(); training.init_training()
    fixture = {'bases': [], 'sources': []}
    definitions = [
        ('Opening terminal comment', 'moves', '', '1. e4 {TERMINAL_MOVES: Le pion central contrôle d5 et f5.} *'),
        ('White alternative solution', 'solve', '', '1. e4 e5 2. Nf3 {MAIN_WHITE: Développer le cavalier.} (2. Bc4 {VARIANT_WHITE: Le fou vise f7 après cette solution.}) *'),
        ('Black alternative solution', 'solve', '0', '1. e4 c5 {MAIN_BLACK: Défense sicilienne.} (1... e5 {VARIANT_BLACK: Réponse symétrique au centre.}) *'),
    ]
    for title, kind, start_path, moves in definitions:
        pgn = f'[Event "{title}"]\n[White "Test White"]\n[Black "Test Black"]\n[Result "*"]\n\n{moves}'
        stamp = training.stamp()
        with db.get_conn() as conn:
            bid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
                (title, json.dumps({'review_enabled': True, 'type': kind, 'mode': 'manual', 'color': 'white'}), stamp)).lastrowid
            eid = conn.execute('INSERT INTO entries(base_id,title,pgn,start_path,created_at,updated_at) VALUES(?,?,?,?,?,?)',
                (bid, title, pgn, start_path, stamp, stamp)).lastrowid
        cards = training.queue(bid)['cards']
        assert cards, title
        fixture['bases'].append({'id': bid, 'type': kind, 'cards': cards})
        fixture['sources'].append({'id': eid, 'pgn': pgn})
    with db.get_conn() as conn:
        fixture['preserved'] = {table: [dict(row) for row in conn.execute('SELECT * FROM ' + table + ' ORDER BY id')]
                                for table in ('review_cards', 'review_history', 'entry_history')}
    Path(directory).parent.joinpath('fixture.json').write_text(json.dumps(fixture, ensure_ascii=False), encoding='utf-8')


def serve(directory, port):
    os.environ['CHESSGYM_DATA_DIR'] = str(Path(directory).resolve())
    sys.path.insert(0, str(ROOT))
    import jobs
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    seed(directory)
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
        serve(args.data, args.port)
        return
    dependencies = Path(os.environ.get('CHESSGYM_TEST_RUNTIME', str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies')))
    node = Path(os.environ.get('CHESSGYM_TEST_NODE', shutil.which('node') or r'C:\Program Files\nodejs\node.exe'))
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    if not node.is_file() or not browser.is_file():
        raise SystemExit('Set CHESSGYM_TEST_NODE and CHESSGYM_TEST_BROWSER to local runtimes.')
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('review-comments-browser-' + uuid.uuid4().hex)
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
            result = subprocess.run([str(node), str(ROOT / 'tests/review_comments_browser.mjs')], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            import sqlite3
            fixture = json.loads((output / 'fixture.json').read_text(encoding='utf-8'))
            with sqlite3.connect(data / 'chessgym.sqlite3') as conn:
                conn.row_factory = sqlite3.Row
                stored = {row['id']: row['pgn'] for row in conn.execute('SELECT id,pgn FROM entries')}
                preserved = {table: [dict(row) for row in conn.execute('SELECT * FROM ' + table + ' ORDER BY id')]
                             for table in ('review_cards', 'review_history', 'entry_history')}
            assert stored == {item['id']: item['pgn'] for item in fixture['sources']}, 'Source PGN changed'
            assert preserved == fixture['preserved'], 'Displaying comments, revealing or resuming changed scheduling/history'
            print('PASS Source PGN and review schedules/history remain unchanged')
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
