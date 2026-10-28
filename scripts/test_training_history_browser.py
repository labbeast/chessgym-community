"""Unified training history and reading visits in an isolated browser and database."""
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
    import jobs
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    import db, training, puzzle_training, guess_move, training_skills, color_training
    db.init_db();db.ensure_local_owner();training.init_training();puzzle_training.init_puzzles();guess_move.init_guess_move();training_skills.init_training_skills();color_training.init_color_training()
    sys.path.insert(0,str(ROOT/'tests'))
    from test_training_history import seed_all, seed_color
    source='[Event "History course"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 {Original note.} e5 2. Nf3 Nc6 *'
    with db.get_conn() as conn:
        conn.execute('INSERT INTO bases(id,name,settings,created_at) VALUES(1,?,?,?)',('History course',json.dumps({'reading_enabled':True}),'2026-10-24'))
        conn.execute('INSERT INTO entries(id,base_id,title,pgn,created_at,updated_at) VALUES(1,1,?,?,?,?)',('Alice — Bob',source,'2026-10-24','2026-10-24'))
        seed_all(conn)
        for i in range(30):seed_color(conn,identity='page-'+str(i))
        state=json.loads(conn.execute("SELECT state FROM color_sessions WHERE id='color'").fetchone()[0])
        state['events']=[{'square':'a1','color':'black','correct':True,'elapsed_ms':i*100} for i in range(103)]
        conn.execute("UPDATE color_sessions SET state=? WHERE id='color'",(json.dumps(state),))
    Path(directory).parent.joinpath('fixture.json').write_text(json.dumps({'pgn':source}),encoding='utf-8')
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
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('training-history-browser-' + uuid.uuid4().hex)
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
            result = subprocess.run([str(node), str(ROOT / 'tests/training_history_browser.mjs')], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            import sqlite3
            fixture=json.loads((output/'fixture.json').read_text(encoding='utf-8'))
            with sqlite3.connect(data/'chessgym.sqlite3') as conn:
                assert conn.execute('SELECT pgn FROM entries WHERE id=1').fetchone()[0]==fixture['pgn'], 'Source PGN changed'
                assert conn.execute('SELECT COUNT(*) FROM entries').fetchone()[0]==1
                if result.returncode==0:
                    assert conn.execute('SELECT COUNT(*) FROM reading_visits').fetchone()[0]>=2
                    assert conn.execute('SELECT COUNT(*) FROM color_sessions').fetchone()[0]==31
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
