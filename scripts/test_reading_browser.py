"""Real native-browser regression using a fresh profile and a fake reading API."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import html
import json
import os
import re
import subprocess
import threading
import uuid

ROOT = Path(__file__).resolve().parents[1]


class QuietHandler(SimpleHTTPRequestHandler):
    def do_GET(self):
        target = Path(self.translate_path(self.path)).resolve()
        if target != ROOT / 'tests' / 'reading_browser.html' and not target.is_relative_to(ROOT / 'static'):
            self.send_error(404)
            return
        super().do_GET()

    def log_message(self, *_):
        pass


def main():
    browser = Path(os.environ.get('CHESSGYM_TEST_BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'))
    if not browser.is_file():
        raise SystemExit('Set CHESSGYM_TEST_BROWSER to an installed Chromium browser.')
    output = ROOT / '.tmp' / ('reading-browser-' + uuid.uuid4().hex)
    output.mkdir(parents=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        args = [str(browser), '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
                '--disable-extensions', '--user-data-dir=' + str(output / 'profile'),
                '--virtual-time-budget=2000', '--dump-dom',
                f'http://127.0.0.1:{server.server_port}/tests/reading_browser.html']
        result = subprocess.run(args, capture_output=True, encoding='utf-8', errors='replace', timeout=40,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        (output / 'result.html').write_text(result.stdout, encoding='utf-8')
        match = re.search(r'<pre id="result">(.*?)</pre>', result.stdout, re.S)
        report = json.loads(html.unescape(match.group(1))) if match else {'status': 'failed', 'error': 'No browser result'}
        print(json.dumps(report, ensure_ascii=False))
        if result.returncode or report.get('status') != 'passed':
            raise SystemExit(1)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
