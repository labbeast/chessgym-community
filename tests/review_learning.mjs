import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingOptionsHtml,setTrainingOption,trainingOptionsSummary} from '../static/training-options.js';
import {prepareTrainingReview} from '../static/training-plan-launch.js';
import {reviewBasesTableHtml} from '../static/review-bases.js';
import {setLanguage} from '../static/i18n.js';
import {reviewAllActionsHtml,prepareAllReviews} from '../static/review-all.js';

test('training blocks expose and save all three choices with bilingual summaries',()=>{
 const block={activity:'review',resource:{type:'base',id:1}};
 const html=trainingOptionsHtml(block);
 for(const value of ['review','learn','both'])assert.match(html,new RegExp('value="'+value+'"'));
 assert.match(html,/value="both" selected/);
 assert.equal(trainingOptionsSummary(block),'Réviser + Apprendre');
 assert.equal(setTrainingOption(block,'selection','learn'),true);
 assert.deepEqual(block.options,{selection:'learn'});
 assert.equal(trainingOptionsSummary(block),'Apprendre seulement');
 setLanguage('en');assert.equal(trainingOptionsSummary(block),'Learn only');
 assert.match(trainingOptionsHtml(block),/Review only/);setLanguage('fr');
});

test('training launch sends the immutable mode to preview and creation without a quota',async()=>{
 for(const selection of ['review','learn','both']){
  const calls=[],run={id:crypto.randomUUID(),block:{metric:'quantity',unit:'cards',target:20,options:{selection:'review'}},launch:{base_id:1,options:{selection}}};
  await prepareTrainingReview(run,{request:async(url,options)=>{calls.push(options.body);return url.endsWith('daily-preview')?{total:20}:{session_id:'session'};}});
  assert.equal(calls[0].selection,selection);assert.equal(calls[1].selection,selection);
  assert.equal(calls[0].goal.cards,20);assert.equal('new_limit' in calls[0],false);
 }
});

test('base actions distinguish new cards from previously attempted cards',()=>{
 const html=reviewBasesTableHtml([{base_id:1,name:'Cards',type:'moves',total:10,unseen:3,learning:5,learned:2,due:2,maintenance_due:1}],[]);
 assert.match(html,/data-review="1">Réviser · 3/);assert.match(html,/data-learn="1">Apprendre · 3/);
 assert.doesNotMatch(html,/data-practice|Libre/);
 const empty=reviewBasesTableHtml([{base_id:1,name:'Empty',type:'solve',total:0}],[]);
 assert.match(empty,/data-review="1" disabled/);assert.match(empty,/data-learn="1" disabled/);
});

test('a timed training block has no unrelated card allowance',async()=>{
 let options;
 const run={id:crypto.randomUUID(),block:{metric:'minutes',session_minutes:45},launch:{base_id:1,minutes:45,options:{selection:'learn'}}};
 await prepareTrainingReview(run,{defaults:{cards:3},request:async(url,request)=>{options=request.body;return url.endsWith('daily-preview')?{total:100}:{session_id:'timed'};}});
 assert.deepEqual(options.goal,{minutes:45,cards:null});
});

const memoryStore=()=>{const data=new Map();return {get:key=>data.get(key),set:(key,value)=>data.set(key,structuredClone(value)),remove:key=>data.delete(key)};};
test('all-base buttons count eligible cards including maintenance and exclude reference bases',()=>{
 const bases=[{id:1,settings:{review_enabled:true}},{id:2,settings:{review_enabled:false}},{id:3,reference:true,settings:{review_enabled:true}}];
 const rows=[{base_id:1,due:4,maintenance_due:2,unseen:8},{base_id:2,due:100,unseen:100},{base_id:3,due:100,unseen:100}];
 const html=reviewAllActionsHtml(rows,bases);assert.match(html,/data-review-all="review">Tout réviser · 6/);assert.match(html,/data-review-all="learn">Tout apprendre · 8/);
 setLanguage('en');assert.match(reviewAllActionsHtml(rows,bases),/Review all · 6/);assert.match(reviewAllActionsHtml(rows,bases),/Learn all · 8/);setLanguage('fr');
 assert.match(reviewAllActionsHtml([],bases),/data-review-all="review" disabled/);assert.match(reviewAllActionsHtml([],bases),/data-review-all="learn" disabled/);
});
test('Review all and Learn all cover all enabled bases without a manual session goal',async()=>{
 for(const selection of ['review','learn']){
  let body;await prepareAllReviews(selection,{request:async(url,options)=>{assert.equal(url,'/api/review-sessions/daily');body=options.body;return {selection};}});
  assert.equal(body.base_ids,null);assert.equal(body.selection,selection);assert.deepEqual(body.goal,{minutes:null,cards:null});assert.ok(body.request_id);assert.equal('training_run_id' in body,false);
 }
});
test('all-base launch recovers the same receipt after a lost response and rejects a different pending mode',async()=>{
 const store=memoryStore(),bodies=[];const request=async(url,options)=>{bodies.push(structuredClone(options.body));if(bodies.length===1)throw Error('Lost response');return {session_id:'saved'};};
 await assert.rejects(prepareAllReviews('learn',{request,store}),/Lost response/);
 await assert.rejects(prepareAllReviews('review',{request,store}),/même choix/);
 assert.equal((await prepareAllReviews('learn',{request,store})).session_id,'saved');assert.deepEqual(bodies[0],bodies[1]);assert.equal(store.get('review-all-create'),undefined);
});
test('definitive rejection clears pending launch and a changed owner cannot clear another account',async()=>{
 const store=memoryStore();await assert.rejects(prepareAllReviews('learn',{store,request:async()=>{throw Object.assign(Error('Unavailable'),{status:409});}}),/Unavailable/);assert.equal(store.get('review-all-create'),undefined);
 await prepareAllReviews('review',{store,isCurrent:()=>false,request:async()=>({session_id:'old-account'})});assert.equal(store.get('review-all-create').selection,'review');
});
