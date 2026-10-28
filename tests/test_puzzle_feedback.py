import json
import subprocess
import pytest
from test_board_interactions import ROOT, node_binary
from test_puzzle_training import store, start, action
import puzzle_training as puzzles


def test_puzzle_result_feedback():
    result = subprocess.run(
        [node_binary(), str(ROOT / 'tests/puzzle_feedback.mjs')],
        capture_output=True, text=True, encoding='utf-8', timeout=20,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )
    assert result.returncode == 0, result.stderr + result.stdout


@pytest.mark.parametrize('scenario,expected_state',[
    ('storm_mistake','errors'),
    ('abandoned','errors'),
    ('abandoned_after_hint','revealed'),
    ('revealed_solution','revealed'),
])
def test_server_terminal_attempt_feedback(store,scenario,expected_state):
    if scenario=='storm_mistake':
        session=puzzles.start_storm(puzzles.StormRequest(filters=puzzles.Filters(color='black')))
        attempt=action(session['attempt'],'d7d5')['attempt']
    else:
        attempt=start()
        if scenario=='revealed_solution':
            attempt=puzzles.reveal(attempt['id'],puzzles.Action(request_id='reveal-001',version=attempt['version']))['attempt']
        else:
            if scenario=='abandoned_after_hint':
                attempt=puzzles.get_hint(attempt['id'],puzzles.Action(request_id='hint-00001',version=attempt['version']))['attempt']
            puzzles.start_attempt(puzzles.StartAttempt(puzzle_id='White1'))
            attempt=puzzles.attempt_detail(attempt['id'])
    assert attempt['status']=='revealed'
    script="""
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {puzzleResultState,puzzleResultLabel,puzzleFeedbackHtml} from './static/puzzle-feedback.js';
const {attempt,expected}=JSON.parse(readFileSync(0,'utf8'));
assert.equal(puzzleResultState(attempt),expected);
assert.equal(puzzleResultLabel(attempt),'À retravailler');
const html=puzzleFeedbackHtml(attempt);
assert.ok(!html.includes('Réponse affichée'));
assert.ok(!html.includes('Réussi !'));
assert.ok(html.includes(`data-state="${expected}"`));
assert.ok(!html.includes('data-state="active"'));
"""
    result=subprocess.run(
        [node_binary(),'--input-type=module','-e',script],cwd=ROOT,
        input=json.dumps({'attempt':attempt,'expected':expected_state}),
        capture_output=True,text=True,encoding='utf-8',timeout=20,
        creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0),
    )
    assert result.returncode==0,result.stderr+result.stdout
