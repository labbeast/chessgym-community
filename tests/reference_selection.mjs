import assert from 'node:assert/strict';
import {ReferenceLibrary,referenceGamesHtml} from '../static/reference-library.js';
import {TestNode,dialogFactory} from './metadata_dom.mjs';

const game=id=>({id,title:'Partie '+id,headers:{White:'Blanc '+id,Black:'Noir '+id,Event:'Tournoi',Date:'2026.10.27',Result:'1-0'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
async function fixture(options={}){
 const host=new TestNode(),calls=[],dialogs=[],changes=[],notices=[],opened=[];
 let games=Array.from({length:102},(_,index)=>game(index+1));
 const request=async(url,settings={})=>{
  const call={url,...settings};calls.push(call);
  if(settings.method==='POST'){
   if(options.onPost)return options.onPost(call);
   const ids=settings.body.game_ids;
   if(['delete','move'].includes(settings.body.action))games=games.filter(entry=>!ids.includes(entry.id));
   return {count:ids.length,game_ids:[...ids]};
  }
  if(url.endsWith('/status'))return {status:'completed',game_count:games.length,imported:102};
  const params=new URL(url,'http://local').searchParams,offset=Number(params.get('offset')||0),limit=Number(params.get('limit')||50);
  const matches=params.get('search')==='Last'?games.filter(entry=>entry.id>100):games;
  return {status:'ok',entries:matches.slice(offset,offset+limit),offset,limit,total:matches.length,has_more:offset+limit<matches.length};
 };
 const panel=new ReferenceLibrary(host,{base:{id:17,name:'Mega <Database>',reference:true,reference_status:{status:'completed',game_count:102}},request,
  getBases:()=>[{id:17,name:'Mega <Database>',reference:true},{id:20,name:'Étude',reference:false},{id:30,name:'Autre référence',reference:true}],
  openModal:dialogFactory(dialogs),notify:message=>notices.push(message),onChanged:change=>changes.push(change),onOpenGame:id=>opened.push(id),...options});
 await panel.ready;
 return {host,panel,calls,dialogs,changes,notices,opened,
  posts:()=>calls.filter(call=>call.method==='POST'),
  select(id,checked=true){const node=host.querySelector('[data-reference-select="'+id+'"]');assert.ok(node,'Selectable row '+id);node.checked=checked;host.emit('change',node);},
  selectAll(checked=true){const node=host.querySelector('[data-reference-select-all]');assert.ok(node);node.checked=checked;host.emit('change',node);},
  click(action){const node=host.querySelector('[data-reference-action="'+action+'"]');assert.ok(node,'Action '+action);return panel.click({target:node});},
  async page(offset){panel.offset=offset;await panel.load();},
  async filter(search){panel.filters.search=search;panel.offset=0;await panel.load();},
 };
}
const cases={
 renderer_selection_is_optional_and_escapes_labels(){
  const entry=game(1);entry.headers.White='<img src=x onerror=bad>';const page={entries:[entry],offset:0,total:1,has_more:false};
  const plain=referenceGamesHtml(page);assert.doesNotMatch(plain,/data-reference-select|data-reference-menu/);
  const html=referenceGamesHtml(page,false,{selection:new Set([1])}),host=new TestNode();host.innerHTML=html;
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.ok(host.querySelector('[data-reference-select="1"]').checked);
  assert.ok(host.querySelector('[data-reference-select-all]'));assert.ok(host.querySelector('[data-reference-menu="1"]'));
  assert.match(html,/class="reference-selected"/);assert.match(html,/aria-label="Sélectionner/);
  host.innerHTML=referenceGamesHtml(page,true,{selection:new Set()});
  assert.ok(host.querySelector('[data-reference-select="1"]').disabled);assert.ok(host.querySelector('[data-reference-menu="1"]').disabled);
 },
 async page_selection_keeps_hidden_rows_and_does_not_mutate_games(){
  const f=await fixture();try{
   f.select(1);assert.deepEqual(f.panel.selectedIds,[1]);assert.equal(f.posts().length,0);
   let all=f.host.querySelector('[data-reference-select-all]');assert.equal(all.checked,false);assert.equal(all.indeterminate,true);assert.equal(all.getAttribute('aria-checked'),'mixed');
   await f.page(50);assert.deepEqual(f.panel.selectedIds,[1]);assert.match(f.host.querySelector('[data-reference-selection]').innerHTML,/1 masquée/);
   f.selectAll();assert.equal(f.panel.selection.size,51);assert.ok(f.panel.selection.has(1));assert.ok(f.panel.selection.has(100));assert.ok(!f.panel.selection.has(101));
   all=f.host.querySelector('[data-reference-select-all]');assert.equal(all.checked,true);assert.equal(all.indeterminate,false);
   f.selectAll(false);assert.deepEqual(f.panel.selectedIds,[1]);
   await f.filter('Last');assert.deepEqual(f.panel.selectedIds,[1]);assert.match(f.host.querySelector('[data-reference-selection]').innerHTML,/1 masquée/);
   f.select(101);await f.click('clear');assert.equal(f.panel.selection.size,0);assert.equal(f.panel.selectedEntries.size,0);assert.equal(f.host.querySelector('[data-reference-selection]').hidden,true);
   assert.equal(f.posts().length,0);assert.equal(f.opened.length,0);
  }finally{f.panel.dispose();}
 },
 async duplicate_confirmation_freezes_cross_page_selection_and_validates_destination(){
  const f=await fixture();try{
   f.select(1);await f.page(50);f.select(51);await f.click('duplicate');assert.equal(f.posts().length,0);
   const dialog=f.dialogs.at(-1),select=dialog.querySelector('[name="target_base_id"]');
   assert.deepEqual(select.nodes.map(node=>Number(node.value)),[17,20,30]);assert.equal(select.value,'17');
   assert.match(dialog.innerHTML,/Mega &lt;Database&gt;/);assert.match(dialog.innerHTML,/Blanc 1/);assert.match(dialog.innerHTML,/Blanc 51/);
   assert.throws(()=>dialog.settings.onSubmit({get:()=>999}),/destination/);assert.equal(f.posts().length,0);
   f.panel.selection.clear();f.panel.selectedEntries.clear();
   await dialog.settings.onSubmit({get:()=>20});
   assert.equal(f.posts().length,1);assert.equal(f.posts()[0].url,'/api/reference-bases/17/games/batch');
   assert.deepEqual(f.posts()[0].body,{action:'duplicate',game_ids:[1,51],target_base_id:20});
   assert.equal(f.changes.length,1);assert.equal(f.changes[0].source_base_id,17);assert.equal(f.changes[0].action,'duplicate');
  }finally{f.panel.dispose();}
 },
 async move_excludes_current_base_and_changes_only_selected_ids(){
  const f=await fixture();try{
   f.select(1);f.select(2);await f.click('move');const dialog=f.dialogs.at(-1);
   assert.deepEqual(dialog.querySelector('[name="target_base_id"]').nodes.map(node=>Number(node.value)),[20,30]);
   assert.equal(f.posts().length,0);await dialog.settings.onSubmit({get:()=>30});
   assert.deepEqual(f.posts()[0].body,{action:'move',game_ids:[1,2],target_base_id:30});
   assert.equal(f.panel.selection.size,0);assert.equal(f.panel.selectedEntries.size,0);
   assert.equal(f.panel.data.total,100);assert.ok(!f.panel.data.entries.some(entry=>entry.id===1||entry.id===2));
   assert.equal(f.panel.status.game_count,100);assert.equal(f.changes[0].action,'move');assert.equal(f.notices.length,1);
  }finally{f.panel.dispose();}
 },
 async row_menu_uses_its_own_game_without_changing_other_selection(){
  const f=await fixture();try{
   f.select(1);const menuButton=f.host.querySelector('[data-reference-menu="2"]');await f.panel.click({target:menuButton});
   const menu=f.dialogs.at(-1);menu.querySelector('[data-reference-single="delete"]').onclick();assert.equal(menu.open,false);
   const confirmation=f.dialogs.at(-1);assert.match(confirmation.innerHTML,/Blanc 2/);assert.doesNotMatch(confirmation.innerHTML,/Blanc 1 contre/);
   assert.equal(f.posts().length,0);await confirmation.settings.onSubmit();
   assert.deepEqual(f.posts()[0].body,{action:'delete',game_ids:[2]});assert.deepEqual(f.panel.selectedIds,[1]);
   assert.ok(f.panel.data.entries.some(entry=>entry.id===1));assert.ok(!f.panel.data.entries.some(entry=>entry.id===2));
  }finally{f.panel.dispose();}
 },
 async delete_requires_confirmation_and_empty_last_page_returns_to_available_page(){
  const f=await fixture();try{
   await f.page(100);f.selectAll();await f.click('delete');assert.equal(f.posts().length,0);
   const dialog=f.dialogs.at(-1);assert.match(dialog.innerHTML,/fichier PGN original est conservé/);
   await dialog.settings.onSubmit();assert.deepEqual(f.posts()[0].body,{action:'delete',game_ids:[101,102]});
   assert.equal(f.panel.offset,50);assert.equal(f.panel.data.total,100);assert.equal(f.panel.data.entries.length,50);
   assert.equal(f.panel.selection.size,0);assert.equal(f.panel.status.game_count,100);
  }finally{f.panel.dispose();}
 },
 async pending_mutation_blocks_double_submit_selection_navigation_and_row_actions(){
  const pending=deferred(),f=await fixture({onPost:()=>pending.promise});try{
   f.select(1);const task=f.panel.runBatch({action:'delete',game_ids:[1]});await settle();
   assert.equal(f.panel.batchBusy,true);assert.equal(f.posts().length,1);
   f.select(2);await f.click('next');f.panel.showRowActions(2);f.panel.requestAction('duplicate',[1]);
   assert.equal(await f.panel.runBatch({action:'delete',game_ids:[1]}),false);
   assert.deepEqual(f.panel.selectedIds,[1]);assert.equal(f.panel.offset,0);assert.equal(f.dialogs.length,0);assert.equal(f.posts().length,1);
   assert.ok(f.host.querySelector('[data-reference-select="2"]').disabled);
   pending.reject(new Error('Écriture refusée'));await assert.rejects(task,/Écriture refusée/);
   assert.equal(f.panel.batchBusy,false);assert.deepEqual(f.panel.selectedIds,[1]);assert.ok(f.panel.data.entries.some(entry=>entry.id===1));assert.equal(f.changes.length,0);assert.equal(f.notices.length,0);
  }finally{f.panel.dispose();}
 },
 async failed_mutation_keeps_the_confirmed_selection_for_retry(){
  let attempts=0;const f=await fixture({onPost:async()=>{if(!attempts++)throw new Error('La sélection a changé');return {count:1,game_ids:[1]};}});try{
   f.select(1);await f.click('duplicate');const dialog=f.dialogs.at(-1),values={get:()=>20};
   await assert.rejects(dialog.settings.onSubmit(values),/sélection a changé/);assert.equal(f.panel.batchBusy,false);assert.deepEqual(f.panel.selectedIds,[1]);
   await dialog.settings.onSubmit(values);assert.equal(f.posts().length,2);assert.equal(f.changes.length,1);assert.deepEqual(f.panel.selectedIds,[1]);
  }finally{f.panel.dispose();}
 },
 async loading_and_disposal_prevent_new_mutations_and_close_owned_dialog(){
  const f=await fixture();try{
   f.select(1);f.panel.loading=true;f.panel.requestAction('delete',[1]);f.panel.showRowActions(1);f.select(2);
   assert.equal(f.dialogs.length,0);assert.deepEqual(f.panel.selectedIds,[1]);assert.equal(await f.panel.runBatch({action:'delete',game_ids:[1]}),false);
   f.panel.loading=false;await f.click('delete');const dialog=f.dialogs.at(-1);assert.equal(dialog.open,true);
   f.panel.dispose();assert.equal(dialog.open,false);assert.equal(await dialog.settings.onSubmit(),false);assert.equal(f.posts().length,0);
   assert.equal(f.host.listeners.size,0);
  }finally{if(!f.panel.disposed)f.panel.dispose();}
 },
 async completed_mutation_notifies_owner_after_navigation_without_refreshing_old_view(){
  const pending=deferred(),f=await fixture({onPost:()=>pending.promise});
  f.select(1);const task=f.panel.runBatch({action:'duplicate',game_ids:[1],target_base_id:20});await settle();
  const calls=f.calls.length,html=f.panel.gamesHost.innerHTML;f.panel.dispose();pending.resolve({count:1,game_ids:[1]});await task;
  assert.equal(f.changes.length,1);assert.equal(f.changes[0].action,'duplicate');assert.equal(f.calls.length,calls);assert.equal(f.notices.length,0);assert.equal(f.panel.gamesHost.innerHTML,html);
 },
};
const selected=process.argv[2];
if(selected){assert.ok(cases[selected]);await cases[selected]();console.log(selected+' passed');}
else for(const [name,test] of Object.entries(cases)){await test();console.log(name+' passed');}
