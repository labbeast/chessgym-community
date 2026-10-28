"""Run focused blindfold visualization checks in an isolated local browser."""
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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output')
    args = parser.parse_args()
    runtime = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies'
    output = (Path(args.output).resolve() if args.output else
              ROOT / 'output/blindfold-visualization-20261026' / uuid.uuid4().hex[:10])
    output.mkdir(parents=True, exist_ok=True)
    data = output / 'data'
    if data.exists():
        raise SystemExit('Refusing to reuse existing test data.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    env = {**os.environ, 'CHESSGYM_TEST_NODE_MODULES': str(runtime / 'node/node_modules'),
           'CHESSGYM_TEST_BROWSER': r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
           'CHESSGYM_TEST_URL': f'http://127.0.0.1:{port}', 'CHESSGYM_TEST_OUTPUT': str(output)}
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    with (output / 'server.log').open('w', encoding='utf8') as log:
        process = subprocess.Popen(
            [sys.executable, str(ROOT / 'scripts/test_training_skills_browser.py'),
             '--serve', '--data', str(data), '--port', str(port)],
            cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
        try:
            import httpx
            deadline = time.monotonic() + 120
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
            result = subprocess.run(
                [shutil.which('node') or r'C:\Program Files\nodejs\node.exe',
                 str(ROOT / 'tests/blindfold_visualization_browser.mjs')],
                cwd=ROOT, env=env, capture_output=True, text=True, encoding='utf8',
                errors='replace', timeout=150, creationflags=flags)
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
