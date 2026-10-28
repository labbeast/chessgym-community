"""Isolated real-browser checks for coordinate and blindfold training."""
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
PGN = '[Event "Visualisation"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 *'


def serve(directory, port):
    os.environ['CHESSGYM_DATA_DIR'] = str(Path(directory).resolve())
    os.environ['CHESSGYM_PUZZLE_BANK'] = str(Path(directory).resolve() / 'puzzles' / 'bank.sqlite3')
    sys.path.insert(0, str(ROOT))
    import chess
    import db
    import jobs
    import engine
    import puzzle_store
    import training_skills
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    engine.binary_path = lambda: None
    db.init_db()
    training_skills.init_training_skills()
    with db.get_conn() as conn:
        bid = conn.execute("INSERT INTO bases(name,created_at) VALUES('Visualisation','today')").lastrowid
        eid = conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                           (bid, 'Espagnole', PGN, 'today', 'today')).lastrowid
        conn.execute('INSERT INTO skill_source_games(game_id,pgn,fetched_at,retry_after) VALUES(?,?,?,0)', ('abcdefgh', PGN, time.time()))
    board = chess.Board()
    for move in ['e2e4', 'e7e5', 'g1f3']:
        board.push_uci(move)
    with puzzle_store.bank_connection(write=True) as conn:
        puzzle_store.init_bank(conn)
        conn.execute('INSERT INTO puzzles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                     ('abc12', board.fen(), 'b8c6 f1b5 a7a6 b5a4', 1400, 60, 90, 100, 'opening',
                      'https://lichess.org/abcdefgh#3', 'Ruy_Lopez', 'white', 3, 4, 32))
        board.push_uci('b8c6');board.push_uci('f1b5')
        conn.execute('INSERT INTO puzzles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                     ('RatedOpen', board.fen(), 'a7a6 b5a4 g8f6 e1g1', 800, 50, 90, 100, 'opening',
                      'https://lichess.org/abcdefgh#5', 'Ruy_Lopez', 'white', 3, 6, 32))
        for ident in ('RatedMate1','RatedMate2'):
            conn.execute('INSERT INTO puzzles VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                         (ident, '8/5K1k/6Q1/8/8/8/8/8 b - - 0 1', 'h7h8 g6g7',
                          900, 50, 90, 100, 'mateIn1', 'https://lichess.org/abcdefgh#0', '', 'white', 1, 1, 3))
    Path(directory).parent.joinpath('fixture.json').write_text(json.dumps({'base_id': bid, 'entry_id': eid, 'pgn': PGN}), encoding='utf8')
    import uvicorn
    uvicorn.run('app:app', host='127.0.0.1', port=port, log_level='warning')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--serve', action='store_true')
    parser.add_argument('--data')
    parser.add_argument('--port', type=int)
    parser.add_argument('--output')
    args = parser.parse_args()
    if args.serve:
        return serve(args.data, args.port)
    runtime = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies'
    node = shutil.which('node') or r'C:\Program Files\nodejs\node.exe'
    browser = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('skills-browser-' + uuid.uuid4().hex)
    output.mkdir(parents=True, exist_ok=True)
    data = output / 'data'
    if data.exists():
        raise SystemExit('Refusing to reuse existing test data.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'CHESSGYM_TEST_NODE_MODULES': str(runtime / 'node/node_modules'),
           'CHESSGYM_TEST_BROWSER': browser, 'CHESSGYM_TEST_URL': f'http://127.0.0.1:{port}',
           'CHESSGYM_TEST_OUTPUT': str(output)}
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    with (output / 'server.log').open('w', encoding='utf8') as log:
        process = subprocess.Popen([sys.executable, __file__, '--serve', '--data', str(data), '--port', str(port)],
                                   cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            import httpx
            deadline = time.monotonic() + 30
            while True:
                if process.poll() is not None:
                    raise RuntimeError('Test server failed: ' + str(output / 'server.log'))
                try:
                    if httpx.get(env['CHESSGYM_TEST_URL'] + '/api/status', timeout=1).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                if time.monotonic() > deadline:
                    raise TimeoutError('Isolated server did not start')
                time.sleep(.1)
            result = subprocess.run([node, str(ROOT / 'tests/training_skills_browser.mjs')], cwd=ROOT, env=env,
                                    capture_output=True, text=True, encoding='utf8', errors='replace', timeout=180, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf8')
            print(json.dumps({'output': str(output), 'exit_code': result.returncode}))
            print(result.stdout)
            if result.returncode:
                print(result.stderr)
                raise SystemExit(result.returncode)
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


if __name__ == '__main__':
    main()
