"""Exercise the actual browser serializer as a pure Node module, then parse again.

Run: python -m pytest tests/test_frontend_pgn.py -q
Node is discovered from CHESSGYM_NODE, PATH, or Codex's bundled runtime.
No browser, DOM, server, or user data is used.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess

import pytest

from pgnlib import game_payload, load_game

ROOT = Path(__file__).resolve().parents[1]


def _node_binary():
    candidates = [
        os.environ.get('CHESSGYM_NODE'),
        shutil.which('node'),
        Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe',
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    pytest.skip('Node is required for the frontend serializer regression test')


def _serialize(payload, mutation=''):
    module_url = (ROOT / 'static/board.js').as_uri()
    script = (
        'import {serialize} from ' + json.dumps(module_url) + ';'
        'let raw="";for await (const chunk of process.stdin)raw+=chunk;'
        'const document=JSON.parse(raw);' + mutation +
        'process.stdout.write(serialize(document));'
    )
    result = subprocess.run(
        [_node_binary(), '--input-type=module', '-e', script],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True, text=True, encoding='utf-8', timeout=15,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def _tree_signature(payload):
    # FEN paths and SAN cover every main-line and nested-variation move.
    # Raw comments include unknown machine tags; sorted NAGs include unexposed $22.
    fields = ('path', 'parent', 'fen', 'san', 'uci', 'comment',
              'starting_comment', 'nags', 'clock', 'elapsed', 'children')
    return [(node['path'], {key: node[key] for key in fields})
            for node in payload['nodes']]


ANNOTATED = r'''
[Event "Étude annotée"]
[Site "Local"]
[Date "2026.10.19"]
[Round "1"]
[White "Blancs"]
[Black "Noirs"]
[Result "*"]
[TimeControl "300+2"]
[Source "Notes personnelles"]

{Commentaire initial}
1. e4 $1 $22 {Pression centrale [%clk 0:05:01] [%emt 0:00:01] [%eval 0.24,18]}
({Départ alternatif} 1. d4 d5 ( {Une défense indienne} 1... Nf6 $5 {Flexible [%eval 0.10]} ) 2. c4)
1... e5 {Symétrie [%clk 0:05:00] [%emt 0:00:02]}
2. Nf3 Nc6 ( {Défense russe} 2... Nf6 3. Nxe5 $6 {Pion central [%csl Ge5]} )
3. Bb5 a6 *
'''

PROMOTION = r'''
[Event "Promotion et sous-promotion"]
[Site "Local"]
[Date "2026.10.19"]
[Round "?"]
[White "Blancs"]
[Black "Noirs"]
[Result "*"]
[SetUp "1"]
[FEN "7k/P7/8/8/8/8/8/K7 w - - 0 1"]

{Choix de la pièce}
1. a8=Q+ $3 {Promotion [%eval #8,20]}
( {Une tour suffit} 1. a8=R+ $22 Kg7 {Prudence [%emt 0:00:03.5]} )
( {Sous-promotion} 1. a8=N Kh7 {Cavalier [%clk 0:02:00]} )
1... Kh7 2. Qa7+ Kg6 *
'''


@pytest.mark.parametrize('source', [
    ANNOTATED,
    PROMOTION,
    '[White "Introduction"]\n[PlyCount "1"]\n\n{Initial note} 1. Z0 {Chapter text [%csl Ge4]} *',
], ids=['nested-annotations', 'promotion', 'text-chapter'])
def test_browser_serializer_preserves_complete_pgn_tree(source):
    original = game_payload(load_game(source))
    serialized = _serialize(original)
    restored = game_payload(load_game(serialized))
    assert restored['headers'] == original['headers']
    assert _tree_signature(restored) == _tree_signature(original)


def test_browser_comment_edit_preserves_tags_and_unknown_nags():
    original = game_payload(load_game(ANNOTATED))
    # Same merge used by app.js for an unsaved board's comment/NAG editor.
    mutation = r'''
    const node=document.nodes.find(n=>n.path==='0');
    const supported=[1,2,3,4,5,6,10,14,15,16,17,18,19];
    node.comment=['Nouvelle idée',...(node.comment||'').match(/\[%[^\]]+\]/g)||[]].filter(Boolean).join(' ');
    node.nags=[3,...node.nags.filter(n=>!supported.includes(n))];
    '''
    restored = game_payload(load_game(_serialize(original, mutation)))
    node = next(n for n in restored['nodes'] if n['path'] == '0')
    assert node['nags'] == [3, 22]
    assert node['comment'] == 'Nouvelle idée [%clk 0:05:01] [%emt 0:00:01] [%eval 0.24,18]'
    assert node['clock'] == 301
    assert node['elapsed'] == 1
    for old, new in zip(original['nodes'], restored['nodes']):
        if old['path'] != '0':
            assert new == old
