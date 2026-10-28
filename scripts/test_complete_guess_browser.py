"""Real-browser game-report checks on a fresh, isolated database and Edge profile."""
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
    import db, training, guess_move
    db.init_db();training.init_training();guess_move.init_guess_move()
    pgn = '[Event "Complete game"]\n[Date "2026.10.18"]\n[White "Alice"]\n[WhiteElo "2486"]\n[Black "Bob"]\n[BlackElo "2432"]\n[TimeControl "600+5"]\n\n1. e4 {First move idea. [%clk 0:09:58]} (1. d4 d5) e5 {Opponent reply idea. [%clk 0:09:55]} 2. Nf3 {[%clk 0:09:50]} Nc6 {[%clk 0:09:48]} *'
    fixture={'pgn':pgn,'sources':[]}
    with db.get_conn() as conn:
        for key,kind in [('game','game'),('opening','moves')]:
            bid=conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
                ('Complete game' if kind=='game' else 'Opening review',json.dumps({'review_enabled':True,'guess_enabled':kind=='game','type':kind,'color':'white','mode':'hybrid'}),training.stamp())).lastrowid
            eid=conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                (bid,'Alice — Bob',pgn,training.stamp(),training.stamp())).lastrowid
            fixture[key+'_base']=bid;fixture[key+'_entry']=eid;fixture['sources'].append(eid)
    Path(directory).parent.joinpath('fixture.json').write_text(json.dumps(fixture,ensure_ascii=False),encoding='utf-8')


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
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('complete-guess-browser-' + uuid.uuid4().hex)
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
            result = subprocess.run([str(node), str(ROOT / 'tests/complete_guess_browser.mjs')], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            # A GET document uses canonical PGN; also verify the byte-for-byte
            # persisted text, independently from that API representation.
            import sqlite3
            fixture = json.loads((output / 'fixture.json').read_text(encoding='utf-8'))
            with sqlite3.connect(data / 'chessgym.sqlite3') as conn:
                stored = [conn.execute('SELECT pgn FROM entries WHERE id=?',(eid,)).fetchone()[0] for eid in fixture['sources']]
            if any(pgn != fixture['pgn'] for pgn in stored):
                raise AssertionError('The browser flow changed the persisted source PGN')
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
