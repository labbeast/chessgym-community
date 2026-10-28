import assert from 'node:assert/strict';
import {makeEntryNavigation,entryNavigationState,entryNavigationHtml} from '../static/entry-navigation.js';

const tests={
 displayed_sort_and_filter_order_is_preserved(){
  const displayed=Object.freeze([Object.freeze({id:37}),Object.freeze({id:12}),Object.freeze({id:91})]);
  const context=makeEntryNavigation(4,displayed,12);
  assert.deepEqual(context,{baseId:4,ids:[37,12,91]});
  assert.deepEqual(entryNavigationState(context,{id:12,base_id:4}),{index:1,total:3,previousId:37,nextId:91});
  assert.equal(entryNavigationState(context,{id:40,base_id:4}),null,'An entry outside the filtered set has no misleading counter');
  assert.notEqual(context.ids,displayed,'Navigation keeps its own snapshot of the order');
 },
 mixed_entries_are_normalized_deduplicated_without_reordering(){
  const context=makeEntryNavigation('4',[7,{id:'3'},'7',{id:5},3,' 9 '],'5');
  assert.deepEqual(context,{baseId:4,ids:[7,3,5,9]});
  assert.deepEqual(entryNavigationState(context,{id:'5',base_id:'4'}),{index:2,total:4,previousId:3,nextId:9});
 },
 first_and_last_entries_never_wrap(){
  const context=makeEntryNavigation(4,[7,3,5],7);
  assert.deepEqual(entryNavigationState(context,{id:7,base_id:4}),{index:0,total:3,previousId:null,nextId:3});
  assert.deepEqual(entryNavigationState(context,{id:5,base_id:4}),{index:2,total:3,previousId:3,nextId:null});
  assert.deepEqual(entryNavigationState(makeEntryNavigation(4,[7],7),{id:7,base_id:4}),{index:0,total:1,previousId:null,nextId:null});
 },
 unrelated_free_and_unsaved_documents_have_no_navigation(){
  const context=makeEntryNavigation(4,[7,3,5],7);
  for(const doc of [null,{}, {id:7},{base_id:4},{id:7,base_id:8},{id:99,base_id:4},{id:null,base_id:4}]){
   assert.equal(entryNavigationState(context,doc),null);
   assert.equal(entryNavigationHtml(context,doc),'');
  }
  assert.equal(entryNavigationState(null,{id:7,base_id:4}),null);
  assert.equal(entryNavigationState({},{}),null);
 },
 invalid_identifiers_cannot_create_a_navigation_context(){
  const invalid=[null,undefined,0,-1,1.2,NaN,Infinity,true,false,'',' ','1.2','1e2','0x10','<script>',Number.MAX_SAFE_INTEGER+1,{},[]];
  for(const id of invalid){
   assert.equal(makeEntryNavigation(id,[1],1),null,`Invalid base ${String(id)}`);
   assert.equal(makeEntryNavigation(1,[1,id],id),null,`Invalid current entry ${String(id)}`);
  }
  assert.deepEqual(makeEntryNavigation(4,[...invalid,7,{id:8},{id:'9'},7],7),{baseId:4,ids:[7,8,9]});
  for(const entries of [null,{},'7',[]])assert.equal(makeEntryNavigation(4,entries,7),null);
  assert.equal(makeEntryNavigation(4,[7,8],9),null);
 },
 context_and_document_are_not_mutated(){
  const context=Object.freeze({baseId:4,ids:Object.freeze([9,7,3])});
  const doc=Object.freeze({id:7,base_id:4,title:'My game',pgn:'1. e4 *'});
  const before=JSON.stringify({context,doc});
  entryNavigationState(context,doc);entryNavigationHtml(context,doc);entryNavigationHtml(context,doc,{mobile:true});
  assert.equal(JSON.stringify({context,doc}),before);
 },
 markup_has_accessible_labels_and_boundary_disabled_buttons(){
  const context=makeEntryNavigation(4,Array.from({length:100},(_,index)=>index+1),5);
  const html=entryNavigationHtml(context,{id:5,base_id:4});
  assert.match(html,/<nav class="analysis-entry-navigation analysis-entry-navigation-desktop" aria-label="Parties de la base">/);
  assert.match(html,/<button type="button" data-action="entry-prev" aria-label="Partie précédente" title="Partie précédente">←<\/button>/);
  assert.match(html,/<output class="analysis-entry-counter" aria-live="polite" aria-label="Partie 5 sur 100">5 \/ 100<\/output>/);
  assert.match(html,/<button type="button" data-action="entry-next" aria-label="Partie suivante" title="Partie suivante">→<\/button>/);
  assert.doesNotMatch(html,/disabled/);
  const first=entryNavigationHtml(context,{id:1,base_id:4},{mobile:true});
  assert.match(first,/analysis-entry-navigation-mobile/);
  assert.match(first,/data-action="entry-prev"[^>]* disabled>/);
  assert.doesNotMatch(first,/data-action="entry-next"[^>]* disabled>/);
  const last=entryNavigationHtml(context,{id:100,base_id:4});
  assert.doesNotMatch(last,/data-action="entry-prev"[^>]* disabled>/);
  assert.match(last,/data-action="entry-next"[^>]* disabled>/);
  const single=entryNavigationHtml(makeEntryNavigation(4,[1],1),{id:1,base_id:4});
  assert.equal((single.match(/ disabled/g)||[]).length,2);
 },
 untrusted_metadata_cannot_inject_markup(){
  const unsafe='1"><script>alert(1)</script>';
  assert.equal(entryNavigationHtml({baseId:4,ids:[unsafe]},{id:unsafe,base_id:4}),'');
  assert.equal(entryNavigationHtml({baseId:unsafe,ids:[1]},{id:1,base_id:unsafe}),'');
  const html=entryNavigationHtml({baseId:'4',ids:['7',unsafe,'9']},{id:'7',base_id:'4',title:unsafe});
  assert.match(html,/1 \/ 2/);
  assert.doesNotMatch(html,/script|alert/);
 }
};

const requested=process.argv[2];
if(requested){assert.ok(tests[requested],`Unknown scenario: ${requested}`);tests[requested]();}
else for(const test of Object.values(tests))test();
