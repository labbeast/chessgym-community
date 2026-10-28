"""Real-browser advanced-search checks on a fresh, isolated database and Edge profile."""
import argparse
import json
import hashlib
import sqlite3
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
    import db, training, reference_library, reference_store
    db.init_db(); training.init_training()
    records = []
    def add(white, black, event, date, white_elo, black_elo, result, eco, opening, round_number):
        headers = {'Event': event, 'Site': 'Québec', 'Date': date, 'Round': str(round_number),
                   'White': white, 'Black': black, 'Result': result, 'WhiteElo': str(white_elo),
                   'BlackElo': str(black_elo), 'ECO': eco, 'Opening': opening, 'TimeControl': '600+5'}
        pgn = '\n'.join(f'[{key} "{value}"]' for key, value in headers.items()) + '\n\n1. e4 {Source préservée.} e5 2. Nf3 Nc6 ' + result
        records.append({'pgn': pgn, 'headers': headers})
    for number in range(1, 55):
        add('Labbé, Élodie', 'Dupont, Jean', 'Tournoi Montréal', '2025.01.12', 2200, 2100, '1-0', 'B12', 'Caro-Kann', number)
    add('Dupont, Jean', 'Élodie Labbé', 'Coupe Québec', '2025-02-03', 2000, 2250, '0-1', 'C45', 'Partie écossaise', 1)
    add('Labbé, Élodie', 'Dupont, Jean', 'Tournoi Montréal', '2024.??.??', 1800, 1900, '1/2-1/2', 'A00', 'Ouverture libre', 1)
    add('Labbé, Marc', 'Martin, Élodie', 'Tournoi Montréal', '2025.01.12', 2200, 2100, '0-1', 'B12', 'Caro-Kann', 55)
    for number in range(1, 52):
        add(f'Visiteur, Alpha {number:02}', f'Visiteur, Beta {number:02}', f'Festival local {number:02}', '2023.07.15', 1500, 1600, '1/2-1/2', 'D00', 'Gambit dame', 1)
    stamp = training.stamp()
    with db.get_conn() as conn:
        bid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
            ('Recherche avancée · parties personnelles', json.dumps({'review_enabled': True, 'type': 'solve', 'played': True}), stamp)).lastrowid
        for record in records:
            record['id'] = conn.execute('INSERT INTO entries(base_id,title,pgn,created_at,updated_at) VALUES(?,?,?,?,?)',
                (bid, record['headers']['Event'] + ' · ' + record['headers']['Round'], record['pgn'], stamp, stamp)).lastrowid
        refid = conn.execute('INSERT INTO bases(name,settings,created_at) VALUES(?,?,?)',
            ('Recherche avancée · référence', '{}', stamp)).lastrowid
        key = 'a' * 32
        source = Path(directory).parent / 'reference-source.pgn'
        source.write_text('\n\n'.join(item['pgn'] for item in records), encoding='utf-8')
        conn.execute('INSERT INTO reference_bases(base_id,storage_key,source,status) VALUES(?,?,?,?)',
            (refid, key, str(source.resolve()), 'completed'))
    cards = training.queue(bid)['cards']
    training.grade_card(cards[0]['id'], training.GradeRequest(grade=2, elapsed_ms=1234, request_id=uuid.uuid4(), content_key=cards[0]['content_key']))
    reference_store.import_file(reference_library.store_path(key), source)
    with db.get_conn() as conn:
        preserved = {table: [dict(row) for row in conn.execute('SELECT * FROM ' + table + ' ORDER BY id')]
                     for table in ('review_cards', 'review_history', 'entry_history')}
    with sqlite3.connect(reference_library.store_path(key)) as ref_conn:
        reference_rows = [(row[0], row[1], hashlib.sha256(row[2]).hexdigest()) for row in ref_conn.execute('SELECT id,headers,pgn FROM games ORDER BY id')]
    fixture = {'reference_rows': reference_rows, 'base': bid, 'reference_base': refid, 'reference_key': key, 'records': records, 'preserved': preserved}
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
    parser.add_argument('--browser-test', choices=['advanced_search_browser.mjs', 'list_views_browser.mjs'], default='advanced_search_browser.mjs')
    args = parser.parse_args()
    if args.serve:
        serve(args.data, args.port)
        return
    dependencies = Path(os.environ.get('CHESSGYM_TEST_RUNTIME', str(Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies')))
    node = Path(os.environ.get('CHESSGYM_TEST_NODE', shutil.which('node') or r'C:\Program Files\nodejs\node.exe'))
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    if not node.is_file() or not browser.is_file():
        raise SystemExit('Set CHESSGYM_TEST_NODE and CHESSGYM_TEST_BROWSER to local runtimes.')
    output = Path(args.output).resolve() if args.output else ROOT / '.tmp' / ('advanced-search-browser-' + uuid.uuid4().hex)
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
            result = subprocess.run([str(node), str(ROOT / 'tests' / args.browser_test)], env=env, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=300, creationflags=flags)
            (output / 'browser.log').write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
            import sqlite3
            fixture = json.loads((output / 'fixture.json').read_text(encoding='utf-8'))
            with sqlite3.connect(data / 'chessgym.sqlite3') as conn:
                conn.row_factory = sqlite3.Row
                stored = {row['id']: row['pgn'] for row in conn.execute('SELECT id,pgn FROM entries')}
                preserved = {table: [dict(row) for row in conn.execute('SELECT * FROM ' + table + ' ORDER BY id')]
                             for table in ('review_cards', 'review_history', 'entry_history')}
            with sqlite3.connect(data / 'references' / (fixture['reference_key'] + '.sqlite3')) as ref_conn:
                reference_rows = [[row[0], row[1], hashlib.sha256(row[2]).hexdigest()] for row in ref_conn.execute('SELECT id,headers,pgn FROM games ORDER BY id')]
            assert reference_rows == fixture['reference_rows'], 'Reference game IDs, headers or original compressed PGN changed'
            assert stored == {item['id']: item['pgn'] for item in fixture['records']}, 'Persisted PGN changed'
            assert preserved == fixture['preserved'], 'Review schedule or history changed while searching'
            print('PASS Study PGN, reference IDs/headers/PGN and review schedules/history remain byte-for-byte unchanged')

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
