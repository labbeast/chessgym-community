"""Completion journeys for all native tools and programme assistance."""
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
    os.environ['CHESSGYM_PUZZLE_BANK'] = str(Path(directory).resolve() / 'puzzles' / 'bank.sqlite3')
    sys.path.insert(0, str(ROOT))
    import chess
    import db, training, jobs, puzzle_store, puzzle_training, training_skills
    db.init_db(); training.init_training(); puzzle_training.init_puzzles(); training_skills.init_training_skills()
    fixture = {'sources': []}
    pgn = '[Event "Programme completion"]\n[White "Alice"]\n[Black "Bob"]\n\n1. e4 {Original annotation.} e5 2. Nf3 *'
    with db.get_conn() as conn:
        bid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
            ('Parties du programme', json.dumps({'review_enabled': True, 'reading_enabled': True, 'guess_enabled': True, 'type': 'solve', 'mode': 'manual'}), training.stamp())).lastrowid
        eid = conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
            (bid, 'Alice — Bob', pgn, training.stamp(), training.stamp())).lastrowid
        fixture.update(base_id=bid, entry_id=eid)
        fixture['sources'].append({'id': eid, 'pgn': pgn})
    with puzzle_store.bank_connection(write=True) as conn:
        puzzle_store.init_bank(conn)
        for index in range(40):
            conn.execute('INSERT INTO puzzles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                ('ProgramMate' + str(index), '8/5K1k/6Q1/8/8/8/8/8 b - - 0 1', 'h7h8 g6g7',
                 800 + index, 50, 90, 100, 'mateIn1', 'https://lichess.org/abcdefgh#0', '', 'white', 1, 1, 3))
    Path(directory).parent.joinpath('fixture.json').write_text(json.dumps(fixture, ensure_ascii=False), encoding='utf-8')
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    import app as application
    from fastapi import HTTPException, Depends
    from accounts_api import require_user

    # Fixture clock control exists only in this runner's isolated application.
    @application.app.post('/__test/{tool}/{identity}/expire', include_in_schema=False)
    def expire(tool: str, identity: str, user=Depends(require_user)):
        assert db.DB_PATH.resolve().parent == Path(directory).resolve()
        with db.get_conn() as conn:
            if tool == 'storm':
                changed = conn.execute("UPDATE puzzle_storm SET deadline_ms=? WHERE id=? AND status='active'", (int(time.time()*1000)-1, identity)).rowcount
            elif tool == 'color':
                changed = conn.execute('UPDATE color_sessions SET started_at=?-duration-1 WHERE id=? AND user_id=? AND finished_at IS NULL', (time.time(), identity, user['id'])).rowcount
            elif tool == 'coordinates':
                changed = conn.execute("UPDATE skill_sessions SET started_at=?-json_extract(config,'$.duration')-1 WHERE id=? AND user_id=? AND kind='coordinates' AND finished_at IS NULL", (time.time(), identity, user['id'])).rowcount
            else:
                raise HTTPException(404, 'Unknown fixture timer')
            if not changed:
                raise HTTPException(404, 'No active isolated session')
        return {'ok': True}
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
    args = parser.parse_args()
    if args.serve:
        return serve(args.data, args.port)
    deps = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies'
    node = Path(os.environ.get('CHESSGYM_TEST_NODE', shutil.which('node') or str(deps / 'node/bin/node.exe')))
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    output = Path(args.output).resolve() if args.output else ROOT / 'output' / ('training-completion-browser-' + uuid.uuid4().hex)
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
            result = subprocess.run([str(node), str(ROOT / 'tests/training_completion_browser.mjs')], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=420, creationflags=flags)
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
