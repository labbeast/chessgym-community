import assert from 'node:assert/strict';
import {puzzleResultState,puzzleResultLabel,puzzleFeedbackHtml} from '../static/puzzle-feedback.js';
import {setLanguage} from '../static/i18n.js';

setLanguage('fr');
for(const [attempt,state] of [
 [{status:'completed',failed:0,hints:0},'success'],
 [{status:'completed',failed:1,hints:0},'errors'],
 [{status:'completed',failed:1,hints:2},'assisted'],
 [{status:'completed',failed:0,hints:1},'assisted'],
 [{status:'revealed',failed:1,hints:1},'revealed'],
 [{status:'expired',failed:0,hints:0},'expired'],
 [{status:'active',failed:1,hints:1},'active'],
 [{},'active'],
]){
 assert.equal(puzzleResultState(attempt),state);
 const html=puzzleFeedbackHtml(attempt);
 assert.ok(html.includes(`data-state="${state}"`));
 assert.ok(html.includes('role="status"'));
 assert.ok(html.includes('aria-live="polite"'));
 assert.ok(html.includes('aria-atomic="true"'));
}
const success=puzzleFeedbackHtml({status:'completed'},'Bien joué !');
assert.ok(success.includes('aria-hidden="true">✓</span>'));
assert.ok(success.includes('Réussi !'));
assert.ok(!success.includes('Bien joué !'));
assert.ok(puzzleFeedbackHtml({status:'completed',failed:1}).includes('Terminé avec erreurs'));
assert.ok(puzzleFeedbackHtml({status:'completed',hints:1}).includes('Terminé avec aide'));
assert.ok(puzzleFeedbackHtml({status:'revealed'}).includes('À retravailler'));
assert.ok(!puzzleFeedbackHtml({status:'revealed'}).includes('Réponse affichée'));
assert.ok(!puzzleFeedbackHtml({status:'expired'}).includes('✓'));
assert.ok(puzzleFeedbackHtml({status:'active',events:[{correct:0}]}).includes('data-feedback="error"'));
assert.ok(puzzleFeedbackHtml({status:'active'},'Ce n’est pas la solution. Réessaie.').includes('data-feedback="error"'));
const corrected=puzzleFeedbackHtml({status:'active',failed:1,events:[{correct:0},{correct:1}]},'Bien joué !');
assert.ok(!corrected.includes('data-feedback="error"'));
assert.ok(!corrected.includes('Réussi !'));
const escaped=puzzleFeedbackHtml({status:'active'},'<img src=x onerror="bad()">');
assert.ok(!escaped.includes('<img'));
assert.ok(escaped.includes('&lt;img'));
setLanguage('en');
assert.equal(puzzleResultLabel({status:'completed'}),'Success!');
assert.ok(!puzzleFeedbackHtml({status:'completed',failed:1}).includes('À retravailler'));
assert.ok(!puzzleFeedbackHtml({status:'revealed'}).includes('Réponse affichée'));
assert.ok(puzzleFeedbackHtml({status:'active'},'That is not the solution. Try again.').includes('data-feedback="error"'));
console.log('Puzzle result states, feedback, accessibility, escaping and translations passed.');
