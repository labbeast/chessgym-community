import assert from 'node:assert/strict';
import {EntryTable,visibleEntries} from '../static/entry-table.js';
const entries=[
 {id:1,title:'Finale Échecs',selected:true,created_at:'2026-10-01T10:00:00Z',updated_at:'2026-10-03T10:00:00Z',headers:{Date:'2026.09.12',White:'Alice',Black:'Bob',WhiteElo:'950',BlackElo:'2100',Result:'1-0',Site:'Lichess',TimeControl:'600+5'}},
 {id:2,title:'Sicilienne',selected:false,created_at:'2026-10-02T10:00:00Z',updated_at:'2026-10-01T10:00:00Z',headers:{Date:'2026.10.01',White:'Zoé',Black:'Carole',WhiteElo:'1700',BlackElo:'?',Result:'0-1',Site:'Chess.com',TimeControl:'180+2'}},
 {id:3,title:'Plan classique',selected:true,created_at:'2026-10-02T10:00:00Z',updated_at:'2026-10-02T10:00:00Z',headers:{Date:'????.??.??',White:'Émile',Black:'Alice',WhiteElo:'?',BlackElo:'900',Result:'*'}},
 {id:4,title:'Finale technique',selected:false,created_at:'2026-09-30T10:00:00Z',updated_at:'2026-10-04T10:00:00Z',headers:{Date:'2025.??.??',White:'alice',Black:'David',WhiteElo:'2200',BlackElo:'1800',Site:'Local'}}
];
const ids=items=>items.map(e=>e.id);
import {TestNode as Host,dialogFactory} from './metadata_dom.mjs';
function fixture(options={}){
 const host=new Host(),requests=[],changes=[],notices=[],errors=[],dialogs=[],opened=[],metadata=[];
 const request=options.request||(async(url,settings)=>{requests.push({url,...settings});return {count:settings.body.entry_ids.length,entry_ids:settings.body.entry_ids};});
 const openModal=dialogFactory(dialogs);
 const table=new EntryTable(host,{entries:structuredClone(entries),base:{id:10,name:'Cours <annotés>'},getBases:()=>[{id:10,name:'Cours <annotés>'},{id:20,name:'Exercices'}],onOpenEntry:id=>opened.push(id),onMetadata:id=>metadata.push(id),onChanged:ev=>changes.push(ev),request,openModal,notify:m=>notices.push(m),onError:e=>errors.push(e),...options});
 return {host,table,requests,changes,notices,errors,dialogs,opened,metadata,select(id,checked=true){const n=host.querySelector('[data-et-select="'+id+'"]');n.checked=checked;host.emit('change',n);},selectAll(checked=true){const n=host.querySelector('[data-et-select-all]');n.checked=checked;host.emit('change',n);},filter(query){const n=host.querySelector('[data-et-control="search"]');n.value=query;host.emit('input',n);},click(action){host.emit('click',host.querySelector('[data-et-action="'+action+'"]'));}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const tests={
 new_badge_tracks_server_status_without_changing_selection_or_review_inclusion(){
  const games=entries.map((entry,index)=>({...entry,...(index===0?{is_new:true}:index===1?{is_new:false}:index===2?{is_new:'true'}:{})}));
  const f=fixture({entries:games});
  assert.equal(f.host.querySelectorAll('.entry-new-badge').length,1);
  assert.ok(f.host.querySelector('[data-et-row="1"]').querySelector('.entry-new-badge'));
  assert.match(f.host.querySelector('[data-et-table]').innerHTML,/>Nouveau<\/span>/);
  f.select(1);assert.equal(f.host.querySelectorAll('.entry-new-badge').length,1);
  assert.equal(f.table.entries[0].selected,true);assert.equal(f.requests.length,0);
  f.table.update({entries:games.map(entry=>entry.id===1?{...entry,is_new:false,seen_at:'2026-10-21T15:00:00Z'}:entry)});
  assert.equal(f.host.querySelectorAll('.entry-new-badge').length,0);
  assert.deepEqual(f.table.selectedIds,[1]);assert.equal(f.table.entries[0].selected,true);assert.equal(f.requests.length,0);
 },
 numeric_sort_unknown_last_and_stable(){
  assert.deepEqual(ids(visibleEntries(entries,{sort:'whiteElo',direction:'asc'})),[1,2,4,3]);
  assert.deepEqual(ids(visibleEntries(entries,{sort:'whiteElo',direction:'desc'})),[4,2,1,3]);
  assert.deepEqual(ids(visibleEntries(entries,{sort:'blackElo',direction:'asc'})),[3,4,1,2]);
  assert.deepEqual(ids(visibleEntries(entries,{sort:'white',direction:'asc'})),[1,4,3,2]);
  assert.deepEqual(ids(entries),[1,2,3,4]);
 },
 dates_added_updated_and_unknowns(){
  assert.deepEqual(ids(visibleEntries(entries)),[4,1,2,3]);
  assert.deepEqual(ids(visibleEntries(entries,{sort:'updated'})),[2,3,1,4]);
  assert.deepEqual(ids(visibleEntries(entries,{sort:'date'})),[4,1,2,3]);
  assert.deepEqual(ids(visibleEntries(entries,{sort:'date',direction:'asc'})),[4,1,2,3]);
  assert.deepEqual(ids(visibleEntries(entries,{sort:'date',direction:'desc'})),[2,1,4,3]);
 },
 bases_open_ascending_and_new_sort_columns_start_ascending(){
  const f=fixture();assert.equal(f.table.direction,'asc');assert.deepEqual(ids(f.table.visible),[4,1,2,3]);
  assert.equal(f.host.querySelector('[data-et-action="direction"]').textContent,'↑ Croissant');
  f.click('direction');assert.deepEqual(ids(f.table.visible),[3,2,1,4]);
  for(const key of ['date','updated','whiteElo','blackElo','title','white','black','added']){
   f.table.setSort(key);assert.equal(f.table.direction,'asc',key);
   f.table.setSort(key);assert.equal(f.table.direction,'desc',key);
  }
 },
 search_is_accent_insensitive_multi_field_and_combined_with_inclusion(){
  assert.deepEqual(ids(visibleEntries(entries,{query:'echecs lichess'})),[1]);
  assert.deepEqual(ids(visibleEntries(entries,{query:'alice',inclusion:'excluded'})),[4]);
  assert.deepEqual(ids(visibleEntries(entries,{query:'1700 chess'})),[2]);
  assert.deepEqual(ids(visibleEntries(entries,{inclusion:'included'})),[1,3]);
  assert.equal(visibleEntries(entries,{query:'missing'}).length,0);
 },
 selection_is_distinct_from_review_and_header_is_tristate(){
  const f=fixture();assert.deepEqual(f.table.selectedIds,[]);f.select(2);
  assert.equal(f.table.entries.find(e=>e.id===2).selected,false);assert.equal(f.requests.length,0);
  assert.equal(f.host.querySelector('[data-et-select-all]').indeterminate,true);
  assert.equal(f.host.querySelector('[data-et-select-all]').attrs['aria-checked'],'mixed');
  f.selectAll();assert.deepEqual(f.table.selectedIds,[1,2,3,4]);assert.equal(f.host.querySelector('[data-et-select-all]').checked,true);
  f.selectAll(false);assert.equal(f.table.selectedIds.length,0);assert.equal(f.host.querySelector('.entry-bulk-actions').hidden,true);
 },
 select_all_affects_filtered_rows_and_exposes_hidden_selection(){
  const f=fixture();f.select(2);f.filter('Finale');f.selectAll();assert.deepEqual(f.table.selectedIds,[1,2,4]);
  assert.match(f.host.querySelector('[data-et-selection]').textContent,/3 sélectionnées · dont 1 masquée/);
  f.selectAll(false);assert.deepEqual(f.table.selectedIds,[2]);
  f.filter('nothing');assert.equal(f.host.querySelector('[data-et-select-all]').disabled,true);assert.match(f.host.querySelector('[data-et-selection]').textContent,/1 masquée/);
  f.click('clear');assert.deepEqual(f.table.selectedIds,[]);
 },
 sorting_keeps_selection_and_update_prunes_deleted_ids(){
  const f=fixture();f.select(1);f.select(2);f.filter('alice');f.table.setSort('whiteElo');
  assert.deepEqual(f.table.selectedIds,[1,2]);assert.equal(f.table.direction,'asc');
  f.table.setSort('whiteElo');assert.equal(f.table.direction,'desc');
  f.table.update({entries:entries.filter(e=>e.id!==2)});assert.deepEqual(f.table.selectedIds,[1]);assert.equal(f.table.query,'alice');assert.equal(f.table.sort,'whiteElo');
 },
 delete_requires_concrete_confirmation_and_cancel_does_nothing(){
  const f=fixture();f.select(1);f.select(2);f.table.requestAction('delete',f.table.selectedIds);
  assert.equal(f.requests.length,0);const d=f.dialogs[0];assert.match(d.innerHTML,/2 parties ou exercices/);assert.match(d.innerHTML,/Cours &lt;annotés&gt;/);assert.match(d.innerHTML,/Finale Échecs/);assert.match(d.innerHTML,/Sicilienne/);assert.match(d.innerHTML,/ne peut pas être annulée/);
  d.close();assert.equal(f.requests.length,0);assert.deepEqual(f.table.selectedIds,[1,2]);
 },
 async delete_confirmed_is_atomic_payload_and_prunes_rows(){
  const f=fixture();f.select(1);f.select(2);f.table.requestAction('delete',f.table.selectedIds);await f.dialogs[0].settings.onSubmit();
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/api/bases/10/entries/batch');assert.deepEqual(f.requests[0].body,{action:'delete',entry_ids:[1,2]});
  assert.deepEqual(ids(f.table.entries),[3,4]);assert.deepEqual(f.table.selectedIds,[]);assert.equal(f.changes[0].source_base_id,10);
 },
 async destinations_move_excludes_source_duplicate_includes_it(){
  const f=fixture();f.table.requestAction('move',[1]);let d=f.dialogs.at(-1);assert.doesNotMatch(d.innerHTML,/option value="10"/);assert.match(d.innerHTML,/option value="20"/);assert.match(d.innerHTML,/progression de révision précédente/);
  assert.throws(()=>d.settings.onSubmit(new Map([['target_base_id','10']])),/destination/);assert.equal(f.requests.length,0);
  f.table.requestAction('duplicate',[1]);d=f.dialogs.at(-1);assert.match(d.innerHTML,/option value="10" selected/);await d.settings.onSubmit(new Map([['target_base_id','10']]));
  assert.deepEqual(f.requests[0].body,{action:'duplicate',entry_ids:[1],target_base_id:10});assert.deepEqual(ids(f.table.entries),[1,2,3,4]);
 },
 async batch_review_changes_all_selected_including_hidden_without_changing_selection(){
  const f=fixture();f.select(2);f.select(4);f.filter('sicilienne');f.click('include');await tick();
  assert.deepEqual(f.requests[0].body,{action:'review',entry_ids:[2,4],selected:true});assert.ok(f.table.entries.every(e=>e.selected));assert.deepEqual(f.table.selectedIds,[2,4]);assert.equal(f.changes[0].selected,true);
 },
 async individual_review_is_independent_of_bulk_selection(){
  const f=fixture();f.select(1);f.select(4);const el=f.host.querySelector('[data-et-review="2"]');el.checked=true;f.host.emit('change',el);await tick();
  assert.deepEqual(f.requests[0].body,{action:'review',entry_ids:[2],selected:true});assert.deepEqual(f.table.selectedIds,[1,4]);
 },
 async failed_request_keeps_selection_rows_and_can_retry(){
  let attempts=0;const f=fixture({request:async()=>{if(!attempts++)throw Error('Échec réseau');return {count:1,entry_ids:[1]};}});f.select(1);
  await assert.rejects(f.table.runBatch({action:'delete',entry_ids:[1]}),/réseau/);assert.deepEqual(f.table.selectedIds,[1]);assert.equal(f.table.entries.length,4);assert.equal(f.table.busy,false);assert.equal(f.changes.length,0);
  await f.table.runBatch({action:'delete',entry_ids:[1]});assert.equal(f.changes.length,1);assert.equal(f.table.entries.length,3);
 },
 async busy_prevents_duplicate_submission(){
  let release,count=0;const f=fixture({request:()=>{count++;return new Promise(r=>release=r);}});const pending=f.table.runBatch({action:'delete',entry_ids:[1]});assert.equal(f.table.busy,true);
  assert.equal(await f.table.runBatch({action:'delete',entry_ids:[1]}),false);f.table.requestAction('delete',[2]);assert.equal(f.dialogs.length,0);assert.equal(count,1);
  release({count:1,entry_ids:[1]});await pending;assert.equal(f.table.busy,false);
 },
 async busy_remains_locked_until_owner_finishes_refreshing(){
  let release;const f=fixture({onChanged:()=>new Promise(resolve=>release=resolve)});const pending=f.table.runBatch({action:'review',entry_ids:[2],selected:true});await tick();
  assert.equal(f.table.busy,true);assert.equal(await f.table.runBatch({action:'delete',entry_ids:[1]}),false);assert.equal(f.requests.length,1);
  f.table.update({entries:f.table.entries});assert.equal(f.host.querySelector('[data-et-review="2"]').disabled,true);
  release();await pending;assert.equal(f.table.busy,false);assert.equal(f.host.querySelector('[data-et-review="2"]').disabled,false);
 },
 async disposed_after_request_notifies_owner_without_touching_old_dom(){
  let release;const f=fixture({request:()=>new Promise(r=>release=r)});const pending=f.table.runBatch({action:'move',entry_ids:[1],target_base_id:20});f.table.dispose();const html=f.host.querySelector('[data-et-table]').innerHTML;
  release({count:1,entry_ids:[1]});await pending;assert.equal(f.changes.length,1);assert.equal(f.changes[0].target_base_id,20);assert.equal(f.changes[0].source_base_id,10);assert.equal(f.host.querySelector('[data-et-table]').innerHTML,html);assert.equal(f.notices.length,0);assert.equal(f.host.listeners.size,0);
 },
 async dispose_closes_owned_dialog_and_prevents_pending_confirm(){
  const f=fixture();f.table.requestAction('delete',[1]);const d=f.dialogs[0];f.table.dispose();assert.equal(d.open,false);await d.settings.onSubmit();assert.equal(f.requests.length,0);
 },
 async row_actions_scope_one_entry_and_escape_metadata(){
  const f=fixture();f.select(1);f.select(2);f.table.showRowActions(4);let d=f.dialogs[0];d.querySelector('[data-et-single="include"]').onclick();await tick();assert.deepEqual(f.requests[0].body.entry_ids,[4]);
  f.table.showRowActions(3);d=f.dialogs.at(-1);d.querySelector('[data-et-single="metadata"]').onclick();await tick();assert.deepEqual(f.metadata,[3]);
  f.table.update({entries:[{...entries[0],title:'<img src=x onerror=alert(1)>',headers:{White:'<script>',Site:'a&b'}}]});assert.match(f.host.querySelector('[data-et-table]').innerHTML,/&lt;img/);assert.doesNotMatch(f.host.querySelector('[data-et-table]').innerHTML,/<script>|<img/);
 },
 async batch_start_invalidates_pending_navigation_before_request_and_only_once(){
  const order=[];let release;const f=fixture({onBatchStart:payload=>order.push('start:'+payload.action),request:()=>{order.push('request');return new Promise(resolve=>release=resolve);}});
  const pending=f.table.runBatch({action:'metadata',entry_ids:[1],headers:{Event:'Open'}});assert.deepEqual(order,['start:metadata','request']);await f.table.runBatch({action:'metadata',entry_ids:[2],headers:{Event:'Open'}});assert.equal(order.length,2);
  f.table.dispose();await f.table.runBatch({action:'metadata',entry_ids:[3],headers:{Event:'Open'}});assert.equal(order.length,2);release({count:1,entry_ids:[1],updated_entries:[]});await pending;
  const failed=fixture({onBatchStart:()=>{throw Error('Navigation invalide');}});await assert.rejects(failed.table.runBatch({action:'metadata',entry_ids:[1],headers:{Event:'Open'}}),/Navigation/);assert.equal(failed.requests.length,0);assert.equal(failed.table.busy,false);
 },
 async batch_metadata_five_games_changes_event_only_and_preserves_selection(){
  const games=Array.from({length:5},(_,index)=>({...entries[index%4],id:index+1,headers:{...entries[index%4].headers,Event:'Tournoi '+index}}));
  const f=fixture({entries:games,request:async(url,settings)=>{f.requests.push({url,...settings});return {count:5,entry_ids:games.map(e=>e.id),updated_entries:games.map(e=>({...e,headers:{...e.headers,...settings.body.headers},updated_at:'2026-10-20T10:00:00Z'}))};}});
  f.selectAll();f.filter('Finale');f.table.setSort('whiteElo');f.click('metadata');const d=f.dialogs[0],row=d.querySelector('[data-bm-field="Event"]');
  assert.equal(f.requests.length,0);assert.match(d.innerHTML,/5 parties ou exercices/);assert.match(d.innerHTML,/Cours &lt;annotés&gt;/);
  row.querySelector('[data-bm-action]').value='set';row.querySelector('[data-bm-value]').value='Championnat 2026';
  await d.settings.onSubmit(null,d.querySelector('form'));
  assert.deepEqual(f.requests[0].body,{action:'metadata',entry_ids:[1,2,3,4,5],headers:{Event:'Championnat 2026'}});
  assert.ok(f.table.entries.every(e=>e.headers.Event==='Championnat 2026'));assert.equal(f.table.entries[0].headers.White,'Alice');assert.deepEqual(f.table.selectedIds,[1,2,3,4,5]);assert.equal(f.table.query,'Finale');assert.equal(f.table.sort,'whiteElo');
  assert.equal(f.changes.length,1);assert.equal(f.changes[0].updated_entries.length,5);assert.match(f.notices[0],/5 éléments mis à jour/);
 },
 async batch_metadata_cancel_or_empty_patch_makes_no_request(){
  const f=fixture();f.table.requestAction('metadata',[1]);let d=f.dialogs[0];assert.equal(d.querySelector('[type=submit]').disabled,true);d.close();assert.equal(f.requests.length,0);
  f.table.requestAction('metadata',[1]);d=f.dialogs[1];await assert.rejects(d.settings.onSubmit(null,d.querySelector('form')),/au moins un champ/);assert.equal(f.requests.length,0);
 },
 async batch_metadata_error_keeps_rows_selection_and_unlocks_dialog(){
  const f=fixture({request:async()=>{throw Error('Serveur indisponible');}});f.select(1);f.click('metadata');const d=f.dialogs[0],row=d.querySelector('[data-bm-field="Event"]');row.querySelector('[data-bm-action]').value='set';row.querySelector('[data-bm-value]').value='Open';
  await assert.rejects(d.settings.onSubmit(null,d.querySelector('form')),/indisponible/);assert.equal(f.table.busy,false);assert.equal(f.changes.length,0);assert.deepEqual(f.table.selectedIds,[1]);assert.deepEqual(f.table.entries,entries);assert.equal(d.querySelector('[type=submit]').disabled,false);assert.equal(d.listeners.has('cancel'),false);assert.equal(row.querySelector('[data-bm-value]').disabled,false);
 },
 async batch_metadata_late_success_notifies_owner_without_rendering(){
  let release;const f=fixture({request:()=>new Promise(resolve=>release=resolve)});f.table.requestAction('metadata',[1]);const d=f.dialogs[0],row=d.querySelector('[data-bm-field="Event"]');row.querySelector('[data-bm-action]').value='set';row.querySelector('[data-bm-value]').value='Open';const pending=d.settings.onSubmit(null,d.querySelector('form'));f.table.dispose();const html=f.host.querySelector('[data-et-table]').innerHTML;
  release({count:1,entry_ids:[1],updated_entries:[{...entries[0],headers:{...entries[0].headers,Event:'Open'}}]});await pending;
  assert.equal(d.open,false);assert.equal(f.host.querySelector('[data-et-table]').innerHTML,html);assert.equal(f.notices.length,0);assert.equal(f.changes.length,1);assert.equal(f.changes[0].updated_entries[0].headers.Event,'Open');
 },
 no_other_base_does_not_offer_a_move_to_itself(){
  const f=fixture({getBases:()=>[{id:10,name:'Only'}]});f.table.requestAction('move',[1]);assert.equal(f.dialogs.length,0);assert.equal(f.requests.length,0);assert.match(f.notices[0],/autre base/);
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario],scenario);await tests[scenario]();console.log('ok '+scenario);
