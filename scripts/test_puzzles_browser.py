"""Real-browser puzzle checks on a fresh, isolated database and Edge profile."""
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
    import csv
    import io
    import chess
    import db
    import puzzle_store
    import puzzle_training
    db.init_db(); puzzle_training.init_puzzles()
    with db.get_conn() as conn:
        conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)',('Puzzle failures',puzzle_training.stamp()))
        conn.execute('INSERT INTO bases(name,created_at) VALUES(?,?)',('Storm failures',puzzle_training.stamp()))
    source=Path(directory)/'puzzles.csv'
    with source.open('w',encoding='utf-8',newline='') as stream:
        writer=csv.writer(stream)
        writer.writerow(['PuzzleId','FEN','Moves','Rating','Themes','GameUrl','OpeningTags'])
        for n in range(20):
            writer.writerow(['Black'+str(n),chess.STARTING_FEN,'e2e4 e7e5 g1f3 b8c6',1050 if n<10 else 1500,'opening fork','https://lichess.org/abcdefgh#1','Italian_Game'])
            b=chess.Board();b.push_uci('e2e4')
            writer.writerow(['White'+str(n),b.fen(),'e7e5 g1f3 b8c6 f1b5',1050 if n<10 else 1500,'opening fork','https://lichess.org/abcdefgh#2','Italian_Game'])
    puzzle_store.import_bank(source)


def serve(directory, port):
    os.environ['CHESSGYM_DATA_DIR'] = str(Path(directory).resolve())
    os.environ['CHESSGYM_PUZZLE_BANK'] = str(Path(directory).resolve() / 'puzzles' / 'bank.sqlite3')
    sys.path.insert(0, str(ROOT))
    import jobs
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    import engine
    engine.binary_path = lambda: None
    seed(directory)
    import app as application
    import db
    from fastapi import HTTPException

    # Registered only in this temporary runner, never in the production app.
    @application.app.post('/__test/storm/{session_id}/expire', include_in_schema=False)
    def expire_test_storm(session_id: str):
        assert db.DB_PATH.resolve().parent == Path(directory).resolve()
        with db.get_conn() as conn:
            changed=conn.execute("UPDATE puzzle_storm SET deadline_ms=? WHERE id=? AND status='active'",
                                 (int(time.time()*1000)-1,session_id)).rowcount
            if not changed:
                raise HTTPException(404,'No active isolated Storm session')
        return {'ok':True}

    import uvicorn
    uvicorn.run(application.app, host='127.0.0.1', port=port, log_level='warning')


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--data')
    parser.add_argument('--port', type=int)
    parser.add_argument('--output')
    parser.add_argument('--storm-only', action='store_true')
    args = parser.parse_args()
    if args.serve:
        serve(args.data, args.port)
        return
    dependencies = Path(os.environ.get('CHESSGYM_TEST_RUNTIME', str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies')))
    node = Path(os.environ.get('CHESSGYM_TEST_NODE', shutil.which('node') or r'C:\Program Files\nodejs\node.exe'))
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    if not node.is_file() or not browser.is_file():
        raise SystemExit('Set CHESSGYM_TEST_NODE and CHESSGYM_TEST_BROWSER to local runtimes.')
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('puzzles-browser-' + uuid.uuid4().hex)
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
            scenario = 'storm_rules_browser.mjs' if args.storm_only else 'puzzles_browser.mjs'
            result = subprocess.run([str(node), str(ROOT / 'tests' / scenario)], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300, creationflags=flags)
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
