"""Fetch missing public SVGs and licences without replacing recorded resources.

Run with --verify-only to check the complete collection offline. New resources
use immutable upstream revisions; older provenance and checksums are preserved.
"""
import argparse
from pathlib import Path
import hashlib
import json
import re
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
LICHESS_REVISION = '9b7a53ab3e3e113d67a2b7a3a8a96555281b6e19'
SOURCE = f'https://raw.githubusercontent.com/lichess-org/lila/{LICHESS_REVISION}/'
SETS = ('merida', 'chessnut', 'celtic', 'fantasy', 'shapes', 'pirouetti', 'spatial')
MANIFEST = ROOT / 'licenses' / 'piece-sets-sources.json'
LICENSES = {
    # Keep the original licence snapshots and their recorded provenance intact.
    'Lichess-COPYING.md': SOURCE + 'COPYING.md',
    'Chessnut-Apache-2.0.txt':
        'https://raw.githubusercontent.com/LexLuengas/chessnut-pieces/master/LICENSE.txt',
    'Lichess-COPYING-9b7a53a.md': SOURCE + 'COPYING.md',
    'AGPL-3.0.txt': SOURCE + 'LICENSE',
    'Maurizio-Monge-MIT.txt':
        'https://raw.githubusercontent.com/maurimo/chess-art/'
        'd8705d8bc9879fef44208de19e2a20c937409e1f/LICENSE',
    'CC-BY-SA-4.0.txt': 'https://creativecommons.org/licenses/by-sa/4.0/legalcode.txt',
}


def download(url: str) -> bytes:
    request = Request(url, headers={'User-Agent': 'ChessGym-local-installer/0.1'})
    with urlopen(request, timeout=30) as response:
        return response.read()


def validate_svg(data: bytes, source: str) -> None:
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', data, flags=re.I):
        raise RuntimeError('Unexpected SVG document declaration: ' + source)
    svg = ET.fromstring(data)
    if svg.tag != '{http://www.w3.org/2000/svg}svg':
        raise RuntimeError('Not an SVG: ' + source)
    for node in svg.iter():
        if node.tag.rsplit('}', 1)[-1].lower() in {
            'script', 'foreignobject', 'iframe', 'object', 'embed',
        }:
            raise RuntimeError('Unexpected executable SVG content: ' + source)
        for key, value in node.attrib.items():
            attribute = key.rsplit('}', 1)[-1].lower()
            if attribute.startswith('on'):
                raise RuntimeError('Unexpected SVG event handler: ' + source)
            if attribute in {'href', 'src'} and not value.startswith('#'):
                raise RuntimeError('Unexpected external SVG reference: ' + source)
        # Gradient/filter references within the same SVG are allowed.
        css = ' '.join(node.attrib.values()) + ' ' + (node.text or '')
        if re.search(r'@import\b', css, flags=re.I):
            raise RuntimeError('Unexpected SVG stylesheet import: ' + source)
        for reference in re.findall(r'url\(\s*[\'"]?([^\)\'\"]+)', css, flags=re.I):
            if not reference.strip().startswith('#'):
                raise RuntimeError('Unexpected external SVG URL: ' + source)


def ensure_resource(path: str, source: str, records: dict, verify_only: bool) -> None:
    target = ROOT / path
    previous = records.get(path)
    if target.exists() and previous:
        data = target.read_bytes()
        if hashlib.sha256(data).hexdigest() != previous['sha256']:
            raise RuntimeError('Recorded resource has changed; refusing to replace: ' + path)
    elif verify_only:
        raise RuntimeError('Missing resource or provenance: ' + path)
    else:
        source = previous['source'] if previous else source
        data = download(source)
        digest = hashlib.sha256(data).hexdigest()
        if previous and digest != previous['sha256']:
            raise RuntimeError('Upstream resource differs from recorded checksum: ' + path)
        if path.endswith('.svg'):
            validate_svg(data, source)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        records[path] = {'path': path, 'source': source, 'sha256': digest}
    if path.endswith('.svg'):
        validate_svg(data, path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true', help='Validate without network or writes')
    args = parser.parse_args()
    original = json.loads(MANIFEST.read_text(encoding='utf-8')) if MANIFEST.exists() else []
    records = {record['path']: record for record in original}
    for style in SETS:
        digests = set()
        for color in 'wb':
            for piece in 'KQRBNP':
                name = color + piece + '.svg'
                url = SOURCE + 'public/piece/' + style + '/' + name
                path = f'static/pieces/{style}/{name}'
                ensure_resource(path, url, records, args.verify_only)
                digests.add(records[path]['sha256'])
        if len(digests) != 12:
            raise RuntimeError('Duplicate pieces in set: ' + style)
        print(style + ': 12 distinct SVG pieces verified.', flush=True)
    for filename, url in LICENSES.items():
        ensure_resource('licenses/' + filename, url, records, args.verify_only)
    updated = list(records.values())
    if not args.verify_only and updated != original:
        MANIFEST.write_text(json.dumps(updated, indent=2) + '\n', encoding='utf-8')
    print('Upstream licences and source checksums verified.', flush=True)


if __name__ == '__main__':
    main()
