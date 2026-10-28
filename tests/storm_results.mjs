import assert from 'node:assert/strict';
import {stormResultsHtml,stormResultRowHtml} from '../static/storm-results.js';

const attempts=[
 {index:3,id:'attempt-3',puzzle_id:'Last3',rating:930,color:'white',status:'expired',failed:0,hints:0,elapsed_ms:1500,outcome:'incomplete'},
 {index:1,id:'attempt-1',puzzle_id:'First',rating:710,color:'white',status:'completed',failed:0,hints:0,elapsed_ms:4500,outcome:'solved'},
 {index:2,id:'attempt-2',puzzle_id:'Miss2',rating:850,color:'white',status:'revealed',failed:1,hints:0,elapsed_ms:6000,outcome:'failed'},
];
const data={storm:{score:1,best_combo:3,mistakes:1,solved_rating:710},attempts,summary:{total:3,solved:1,failed:1,incomplete:1,elapsed_ms:12000}},before=JSON.stringify(data);
const html=stormResultsHtml(data,{name:'Custom <script>unsafe</script>'});
assert.equal(JSON.stringify(data),before);
assert(html.indexOf('data-storm-attempt="attempt-1"')<html.indexOf('data-storm-attempt="attempt-2"'));
assert(html.indexOf('data-storm-attempt="attempt-2"')<html.indexOf('data-storm-attempt="attempt-3"'));
assert(html.includes('aria-pressed="true">Tous'));
assert.equal((html.match(/aria-pressed="true"/g)||[]).length,1);
assert.equal((html.match(/data-storm-review=/g)||[]).length,3);
assert.equal((html.match(/data-storm-exercise=/g)||[]).length,3);
assert(html.includes('data-restart'));assert(html.includes('data-home'));
assert(html.includes('aria-hidden="true">✓'));assert(html.includes('aria-hidden="true">×'));assert(html.includes('aria-hidden="true">—'));
assert(html.includes('Réussi'));assert(html.includes('Manqué'));assert(html.includes('Non terminé'));
assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));
for(const outcome of ['solved','failed','incomplete']){
 const filtered=stormResultsHtml(data,{filter:outcome});
 assert.equal((filtered.match(/data-storm-attempt=/g)||[]).length,1);
 assert(filtered.includes(`data-storm-filter="${outcome}" aria-pressed="true"`));
 assert(filtered.includes(`class="storm-results-row" data-storm-attempt="${attempts.find(a=>a.outcome===outcome).id}" data-outcome="${outcome}"`));
 assert.equal((filtered.match(/class="storm-results-count">1</g)||[]).length,3);
}
const active=stormResultRowHtml({...attempts[0],status:'active'});
assert.equal((active.match(/ disabled>/g)||[]).length,2);
assert.equal((stormResultRowHtml(attempts[0]).match(/ disabled>/g)||[]).length,0);
const malicious=stormResultRowHtml({...attempts[0],id:'" onclick="bad()',puzzle_id:'<img onerror=x>',outcome:'"><script>x</script>'});
assert(!malicious.includes('<img'));assert(!malicious.includes('<script>'));assert(!malicious.includes('" onclick='));
assert(malicious.includes('data-outcome="incomplete"'));
const empty=stormResultsHtml({storm:{},attempts:[],summary:{}});
assert(empty.includes('Aucun puzzle dans cette séance.'));assert(empty.includes('role="status"'));assert(!empty.includes('NaN'));
const noMatching=stormResultsHtml({...data,attempts:[attempts[1]]},{filter:'failed'});
assert(noMatching.includes('Aucun puzzle dans ce filtre.'));
assert(stormResultsHtml(data,{filter:'unexpected'}).includes('data-storm-filter="all" aria-pressed="true"'));
console.log('Storm results order, filters, outcomes, actions, escaping and empty states passed.');
