import assert from 'node:assert/strict';
import {progressCounts,reviewProgressHtml} from '../static/review-progress.js';
import {reviewBasesTableHtml} from '../static/review-bases.js';

const row={base_id:7,name:'Mes tactiques',type:'solve',total:31,unseen:13,learning:7,learned:11,mastered:3,due:5};
const parts=html=>html.split('<div class="review-bases-list"');
const tests={
 exclusive_progress_is_accessible_and_identical_on_desktop_and_phone(){
  const progress_counts={mastered:3,learned:6,due:5,unlearned:17};
  for(const html of parts(reviewBasesTableHtml([{...row,progress_counts}],[]))){
   assert.match(html,/class="review-progress-track" role="img"/);assert.match(html,/Maîtrisés : 3 · Appris : 6 · À réviser : 5 · Non appris : 17/);
   for(const [key,value]of Object.entries(progress_counts)){assert.match(html,new RegExp('class="review-progress-'+key+'" style="width:'));assert.ok(html.includes(value+' / 31'));}
  }
  assert.equal(reviewProgressHtml(row),'','legacy overlapping counts cannot create a truthful bar');assert.equal(progressCounts({...row,progress_counts:{...progress_counts,due:10}}),null,'reject inconsistent totals');assert.equal(progressCounts({...row,progress_counts:{...progress_counts,due:-1}}),null);assert.equal(progressCounts({...row,progress_counts:{...progress_counts,due:Infinity}}),null);
  const empty=reviewProgressHtml({total:0,progress_counts:{mastered:0,learned:0,due:0,unlearned:0}},{legend:true});assert.match(empty,/data-empty="true"/);assert.doesNotMatch(empty,/NaN|Infinity/);assert.match(empty,/États de progression/);
 },
 desktop_and_mobile_keep_counts_and_actions(){
  const [desktop,mobile]=parts(reviewBasesTableHtml([row],[{id:7,tags:['Calcul','Finales']} ]));
  for(const html of [desktop,mobile]){
   for(const value of [31,13,11,5])assert.match(html,new RegExp('>'+value+'(?:<|$)'));
   assert.match(html,/dont 3 maîtrisés/);assert.match(html,/Résoudre une position · Calcul · Finales/);
   assert.match(html,/data-base="7"/);assert.match(html,/data-review="7">Réviser · 5/);assert.match(html,/data-learn="7">Apprendre · 13/);
  }
  for(const label of ['Total','Nouveaux','Appris','À réviser'])assert.ok(mobile.includes('<dt>'+label+'</dt>'));
  assert.match(mobile,/class="review-base-stat review-base-due"/);assert.doesNotMatch(mobile,/En apprentissage|En cours/);
 },
 mastered_and_empty_bases_do_not_offer_unavailable_sessions(){
  for(const changes of [{total:3,mastered:3,learned:3,due:0,unseen:0},{total:0,mastered:0,learned:0,due:0,unseen:0}]){
   for(const html of parts(reviewBasesTableHtml([{...row,...changes}],[]))){
    assert.match(html,/data-review="7" disabled>Réviser · 0/);
    assert.match(html,/data-learn="7" disabled>Apprendre · 0/);
   }
  }
 },
 play_and_new_labels_keep_engine_settings_and_defaults(){
  const rows=[{...row,base_id:7,type:'play',due:0},{...row,base_id:8,type:'play'},{...row,base_id:9,due:0}];
  for(const html of parts(reviewBasesTableHtml(rows,[{id:7,settings:{skill:0}}]))){
   assert.match(html,/Stockfish · force 0 \/ 20/);assert.match(html,/Stockfish · force 10 \/ 20/);
   assert.match(html,/data-review="7" disabled>Réviser/);assert.match(html,/data-review="8">Réviser/);assert.match(html,/data-learn="9">Apprendre/);
  }
 },
 names_tags_and_unknown_categories_are_text(){
  for(const html of parts(reviewBasesTableHtml([{...row,name:'<img onerror="bad">',type:'<script>bad</script>'}],[{id:7,tags:['<svg>','A & B']}]))){
   assert.doesNotMatch(html,/<img|<script|<svg/);
   assert.match(html,/&lt;img onerror=&quot;bad&quot;&gt;/);assert.match(html,/&lt;svg&gt; · A &amp; B/);
  }
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario],scenario);tests[scenario]();
