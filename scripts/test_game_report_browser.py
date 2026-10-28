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
    import chess
    import db
    import game_analysis as analysis
    import jobs
    import sync
    import training
    db.init_db()
    analysis.init_analysis()
    jobs.init_jobs()
    sync.init_sync()
    training.init_training()
    pgn = '''[Event "Entraînement du bilan"]
[Site "https://lichess.org/abcdefgh"]
[White "report-tester"]
[Black "Partenaire"]
[WhiteElo "1700"]
[BlackElo "1720"]
[TimeControl "600+5"]
[Result "*"]

1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:40]} Nc6
3. Bc4 {[%clk 0:08:50]} Nf6 4. d3 {Note de la partie enregistrée.} Bc5 5. Nc3 d6 *'''
    with db.get_conn() as conn:
        study = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
            ('Mes parties · bilan', '{}', analysis.stamp())).lastrowid
        opening = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
            ('Espagnole principale', json.dumps({'is_repertoire': True, 'primary': True, 'color': 'white'}), analysis.stamp())).lastrowid
        exercises = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
            ('Mes décisions à revoir', json.dumps({'review_enabled': True, 'type': 'solve', 'mode': 'hybrid'}), analysis.stamp())).lastrowid
        source = conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
            VALUES(?,?,?,?,?)''', (study, 'Italienne · trouver une meilleure décision', pgn, analysis.stamp(), analysis.stamp())).lastrowid
        conn.execute('''INSERT INTO entries(base_id,title,pgn,created_at,updated_at)
            VALUES(?,?,?,?,?)''', (opening, 'Espagnole', '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *', analysis.stamp(), analysis.stamp()))
    sync.create_account({'site': 'lichess', 'username': 'report-tester', 'base_id': study,
                         'enabled': True, 'auto_sync': False, 'auto_analyse': False})
    game, moves, fingerprint = analysis.game_snapshot(pgn)
    scores = [20, 20, 30, -110, 90, -300, -100, -420, -390, -500, -440]
    alternatives = {2: ['f1c4', 'g8f6'], 4: ['f1b5', 'a7a6', 'b5a4'], 6: ['d2d4', 'e5d4']}
    board = game.board()
    with db.get_conn() as conn:
        conn.execute('''INSERT INTO game_analysis_reports(entry_id,fingerprint,settings,status,created_at,updated_at)
            VALUES(?,?,?,?,?,?)''', (source, fingerprint, json.dumps(analysis.DEFAULT_OPTIONS), 'done', analysis.stamp(), analysis.stamp()))
        for ply in range(len(moves) + 1):
            pv = alternatives.get(ply, [moves[ply].uci()] if ply < len(moves) else [next(iter(board.legal_moves)).uci()])
            preview, sans = board.copy(), []
            for uci in pv:
                move = preview.parse_uci(uci)
                sans.append(preview.san(move))
                preview.push(move)
            value = {'cp': scores[ply], 'mate': None, 'winner': None, 'depth': 18,
                     'terminal': False, 'pv': pv, 'pv_san': sans, 'best_uci': pv[0], 'best_san': sans[0]}
            conn.execute('INSERT INTO game_analysis_positions(entry_id,ply,fen,evaluation) VALUES(?,?,?,?)',
                         (source, ply, board.fen(), json.dumps(value)))
            if ply < len(moves):
                board.push(moves[ply])
    result = {'source_id': source, 'study_base': study, 'repertoire_base': opening,
              'exercise_base': exercises, 'pgn': pgn, 'fingerprint': fingerprint,
              'report': analysis.get_analysis(source)}
    Path(directory).parent.joinpath('fixture.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')


def serve(directory, port):
    os.environ['CHESSGYM_DATA_DIR'] = str(Path(directory).resolve())
    sys.path.insert(0, str(ROOT))
    import jobs
    jobs.start_worker = lambda: None
    jobs.stop_worker = lambda: None
    import engine
    engine.binary_path = lambda: None
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
    parser.add_argument('--test-script', default='game_report_browser.mjs')
    args = parser.parse_args()
    if args.serve:
        serve(args.data, args.port)
        return
    test_script = (ROOT / 'tests' / args.test_script).resolve()
    if test_script.parent != (ROOT / 'tests').resolve() or not test_script.is_file() or test_script.suffix != '.mjs':
        raise SystemExit('Choose an existing browser test under tests/.')
    dependencies = Path(os.environ.get('CHESSGYM_TEST_RUNTIME', str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies')))
    node = Path(os.environ.get('CHESSGYM_TEST_NODE', shutil.which('node') or r'C:\Program Files\nodejs\node.exe'))
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    if not node.is_file() or not browser.is_file():
        raise SystemExit('Set CHESSGYM_TEST_NODE and CHESSGYM_TEST_BROWSER to local runtimes.')
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('game-report-browser-' + uuid.uuid4().hex)
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
            result = subprocess.run([str(node), str(test_script)], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            # A GET document uses canonical PGN; also verify the byte-for-byte
            # persisted text, independently from that API representation.
            import sqlite3
            fixture = json.loads((output / 'fixture.json').read_text(encoding='utf-8'))
            with sqlite3.connect(data / 'chessgym.sqlite3') as conn:
                stored = conn.execute('SELECT pgn FROM entries WHERE id=?', (fixture['source_id'],)).fetchone()[0]
            if stored != fixture['pgn']:
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
