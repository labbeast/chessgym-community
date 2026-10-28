import assert from 'node:assert/strict';
import {PositionPanel,positionBasesHtml,positionMatchesHtml} from '../static/position-panel.js';

const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const NEXT='rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const requests=[],timers=new Map();let timerId=0;
globalThis.setTimeout=(callback,delay)=>{timers.set(++timerId,{callback,delay});return timerId;};
globalThis.clearTimeout=id=>timers.delete(id);
globalThis.fetch=async(url,options={})=>{
 const data=await new Promise(resolve=>requests.push({url,options,resolve}));
 return {ok:!data.__error,status:data.status||200,headers:{get:()=> 'application/json'},json:async()=>data.__error?{detail:data.__error}:data};
};
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
class Host{constructor(){this.innerHTML='';this.handlers={};}addEventListener(name,fn){this.handlers[name]=fn;}removeEventListener(name,fn){if(this.handlers[name]===fn)delete this.handlers[name];}contains(){return true;}}
const match=(id=7)=>({entry_id:id,entry_title:'Alice — Bob',base_id:2,base_name:'Ouvertures',folder_path:'Cours / Italiens',headers:{White:'Alice',Black:'Bob',WhiteElo:'1801',BlackElo:'1795',Result:'1-0',Date:'2026.10.22'},occurrence_count:2,occurrences:[{path:'',fen:START,label:'Position initiale',variation:false},{path:'0.0.1',fen:START,label:'2. Nf3',variation:true}]});
const group=(id=2)=>({base_id:id,base_name:id===2?'Ouvertures':'Maîtres',folder_path:'Cours / Italiens',total_entries:100,total_occurrences:150,reference:id!==2,complete:true});
const result=(matches=[match()],extra={})=>({fen:START,position_key:START.split(' ').slice(0,4).join(' '),total_entries:matches.length,total_occurrences:matches.reduce((sum,m)=>sum+m.occurrence_count,0),offset:0,limit:50,has_more:false,matches,skipped_entries:0,complete:true,...extra});
const summary=(bases=[group()],extra={})=>({...result([]),bases,total_entries:bases.reduce((sum,b)=>sum+b.total_entries,0),total_occurrences:bases.reduce((sum,b)=>sum+b.total_occurrences,0),...extra});
const query=request=>new URL(request.url,'http://local').searchParams;
function board(){return {path:'',fen:START,doc:{id:5,base_id:2},busy:false,inputLocked:false,disposed:false,node(){return {fen:this.fen};}};}
function event(action,index=0,occurrenceIndex=0){return {target:{closest:()=>({dataset:{positionAction:action,baseIndex:String(index),entryIndex:String(index),occurrenceIndex:String(occurrenceIndex)},disabled:false})}};}
async function create(options={},data=summary()){
 const host=new Host(),source=options.board||board(),panel=new PositionPanel(host,{board:source,...options});
 if(options.visible!==false)requests.at(-1).resolve(data);await panel.ready;return {host,board:source,panel};
}
async function openBase(panel,data=result(),index=0){const opening=panel.click(event('base',index));requests.at(-1).resolve(data);await opening;}
async function createMatches(options={},data=result()){const context=await create(options);await openBase(context.panel,data);return context;}
const tests={
 async summary_lists_bases_and_exact_counts_before_any_games(){
  let external=0;const {panel,host,board}=await create({onOpenBase:async()=>external++},summary([group(),group(8)]));
  assert.equal(query(requests[0]).get('summary'),'true');assert.equal(query(requests[0]).get('fen'),START);assert.equal(query(requests[0]).has('base_id'),false);
  assert.match(host.innerHTML,/2 bases · 200 parties ou exercices · 300 occurrences/);assert.match(host.innerHTML,/Cours \/ Italiens/);assert.match(host.innerHTML,/Ouvertures/);assert.match(host.innerHTML,/Maîtres/);assert.doesNotMatch(host.innerHTML,/Alice|Bob|position-game-link/);
  const opening=panel.click(event('base',1));assert.equal(query(requests.at(-1)).get('base_id'),'8');assert.equal(query(requests.at(-1)).has('summary'),false);requests.at(-1).resolve(result([{...match('reference:8:7'),base_id:8}]));await opening;
  assert.equal(external,0,'Choosing a base stays in the analysis panel');assert.equal(board.path,'');assert.equal(board.doc.id,5);assert.match(host.innerHTML,/Alice/);panel.dispose();
 },
 async base_shows_players_ratings_result_date_and_exact_root_and_variation_links(){
  const opened=[],{panel,host}=await createMatches({onOpenEntry:async(id,context)=>opened.push({id,context})},result([{...match('reference:2:7'),headers:{...match().headers,Date:'????.??.??',UTCDate:'2026.10.21'}}]));
  assert.equal(query(requests[1]).get('base_id'),'2');assert.equal(query(requests[1]).get('limit'),'50');assert.equal(query(requests[1]).get('offset'),'0');
  for(const text of ['Alice','Bob','1801','1795','1-0','2026.10.21','2 occurrences'])assert.ok(host.innerHTML.includes(text),text);
  await panel.click(event('open',0,0));await panel.click(event('open',0,1));
  assert.equal(opened[0].id,'reference:2:7');assert.equal(opened[0].context.path,'');assert.equal(opened[1].context.path,'0.0.1');assert.equal(opened[1].context.fen,START);assert.equal(opened[1].context.isCurrent(),true);assert.equal(requests.length,2);panel.dispose();
 },
 async back_reuses_summary_without_changing_the_board(){
  const {panel,host,board}=await createMatches();await panel.click(event('back'));
  assert.equal(requests.length,2);assert.equal(panel.selectedBase,null);assert.match(host.innerHTML,/100 parties ou exercices/);assert.doesNotMatch(host.innerHTML,/Alice/);assert.equal(board.fen,START);assert.equal(board.path,'');
  await openBase(panel);assert.equal(requests.length,3,'Reopening a base refreshes its matches');panel.dispose();
 },
 async hidden_panel_does_not_search_and_aborts_on_hide(){
  const {panel,board,host}=await create({visible:false});assert.equal(requests.length,0);board.fen=NEXT;await panel.update({force:true,immediate:true});assert.equal(requests.length,0);
  let load=panel.setVisible(true),pending=requests.at(-1);assert.equal(query(pending).get('fen'),NEXT);await panel.setVisible(false);assert.equal(pending.options.signal.aborted,true);pending.resolve(summary());await load;assert.equal(panel.data,null);assert.doesNotMatch(host.innerHTML,/Ouvertures/);
  load=panel.setVisible(true);requests.at(-1).resolve(summary());await load;assert.match(host.innerHTML,/Ouvertures/);panel.dispose();
 },
 async movement_debounces_resets_selected_base_and_only_latest_response_survives(){
  const {panel,board,host}=await createMatches();board.fen=NEXT;board.path='0';await panel.update();assert.equal(requests.length,2);assert.equal(timers.size,1);assert.equal([...timers.values()][0].delay,250);assert.doesNotMatch(host.innerHTML,/Alice/);assert.equal(panel.selectedBase,null);
  board.fen=START;board.path='';await panel.update();assert.equal(timers.size,1);const timer=[...timers.values()][0];timers.clear();timer.callback();await settle();const old=requests.at(-1);
  board.fen=NEXT;board.path='0';const newest=panel.update({immediate:true});assert.equal(old.options.signal.aborted,true);requests.at(-1).resolve(summary([{...group(),base_name:'Nouvelle position'}]));await newest;
  old.resolve(summary([{...group(),base_name:'Ancienne position'}]));await settle();assert.match(host.innerHTML,/Nouvelle position/);assert.doesNotMatch(host.innerHTML,/Ancienne position/);panel.dispose();
 },
 async same_position_clock_changes_reuse_search_refresh_preserves_base_scope(){
  const {panel,board,host}=await createMatches();board.fen=START.replace('0 1','8 19');board.path='0.0';await panel.update();assert.equal(requests.length,2);
  const refresh=panel.click(event('refresh'));assert.equal(requests.length,3);assert.equal(query(requests.at(-1)).get('fen'),board.fen);assert.equal(query(requests.at(-1)).get('base_id'),'2');requests.at(-1).resolve(result());await refresh;assert.match(host.innerHTML,/Alice/);
  const back=panel.click(event('back'));assert.equal(query(requests.at(-1)).get('summary'),'true');requests.at(-1).resolve(summary([{...group(),total_entries:101}]));await back;assert.match(host.innerHTML,/101 parties ou exercices/);panel.dispose();
 },
 async pagination_append_deduplicates_entries_and_retries_in_place(){
  const {panel,host}=await createMatches({},result([match(1)],{total_entries:3,has_more:true}));
  let more=panel.more(),pending=requests.at(-1);assert.equal(query(pending).get('offset'),'1');assert.equal(query(pending).get('base_id'),'2');await panel.more();assert.equal(requests.length,3);
  pending.resolve({__error:'Service indisponible',status:503});await more;assert.equal(panel.data.matches.length,1);assert.match(host.innerHTML,/Service indisponible/);assert.match(host.innerHTML,/Alice/);
  more=panel.more();pending=requests.at(-1);assert.equal(query(pending).get('offset'),'1');pending.resolve(result([match(1),match(2)],{total_entries:3,has_more:true,offset:1}));await more;assert.deepEqual(panel.data.matches.map(m=>m.entry_id),[1,2]);assert.equal(panel.nextOffset,3);
  more=panel.more();requests.at(-1).resolve(result([],{total_entries:3,has_more:true,offset:3}));await more;assert.equal(panel.data.has_more,false);panel.dispose();
 },
 async returning_during_base_load_aborts_and_late_results_cannot_replace_next_base(){
  const {panel,host}=await create({},summary([group(),group(8)]));const first=panel.click(event('base')),old=requests.at(-1);await panel.click(event('back'));assert.equal(old.options.signal.aborted,true);assert.equal(requests.length,2);
  const second=panel.click(event('base',1));requests.at(-1).resolve(result([{...match('reference:8:9'),entry_title:'Carol — Dan',headers:{White:'Carol',Black:'Dan'}}]));await second;
  old.resolve(result());await first;assert.match(host.innerHTML,/Carol/);assert.doesNotMatch(host.innerHTML,/Alice/);assert.equal(panel.selectedBase.base_id,8);assert.equal(panel.loading,false);panel.dispose();
 },
 async search_errors_retry_and_partial_results_are_honest(){
  const host=new Host(),panel=new PositionPanel(host,{board:board()});requests.at(-1).resolve({__error:'Erreur <test>',status:500});await panel.ready;assert.match(host.innerHTML,/Erreur &lt;test&gt;/);assert.equal(panel.loading,false);
  const refresh=panel.update({force:true,immediate:true});requests.at(-1).resolve(summary([],{complete:false,skipped_entries:2}));await refresh;assert.match(host.innerHTML,/Aucune correspondance.*parmi les parties vérifiées/);assert.match(host.innerHTML,/2 parties n’ont pas pu être vérifiées/);assert.doesNotMatch(host.innerHTML,/Erreur/);panel.dispose();
 },
 async partial_bases_show_scope_and_failed_detail_keeps_a_way_back(){
  const {panel,host}=await create({},summary([{...group(),complete:false}],{complete:false}));assert.match(host.innerHTML,/Recherche partielle/);assert.match(host.innerHTML,/ligne principale seulement/);
  const open=panel.click(event('base'));requests.at(-1).resolve({__error:'Base indisponible',status:404});await open;assert.match(host.innerHTML,/Base indisponible/);assert.match(host.innerHTML,/data-position-action="back"/);await panel.click(event('back'));assert.match(host.innerHTML,/100 parties ou exercices/);assert.doesNotMatch(host.innerHTML,/indisponible/);panel.dispose();
 },
 async unsafe_metadata_names_labels_and_errors_are_escaped(){
  const unsafe='<img src=x onerror=alert(1)>',data=result([{...match(),entry_title:unsafe,headers:{White:unsafe,Black:unsafe,WhiteElo:unsafe,Result:unsafe,Date:unsafe},occurrence_count:99,occurrences:[{path:'" onmouseover="bad',fen:START,label:unsafe,variation:true}]}]);
  const html=positionMatchesHtml(data);assert.doesNotMatch(html,/<img|onmouseover=/);assert.match(html,/&lt;img/);assert.match(html,/1 sur 99/);assert.match(html,/Var\./);
  const groups=summary([{...group(),base_name:unsafe,folder_path:unsafe}]);assert.doesNotMatch(positionBasesHtml(groups),/<img/);assert.match(positionBasesHtml(groups),/&lt;img/);const {panel,host}=await create({},groups);assert.doesNotMatch(host.innerHTML,/<img/);panel.dispose();
 },
 async exercise_titles_and_single_position_remain_clickable_without_metadata(){
  const opened=[],entry={...match(9),entry_title:'Finale de tours à défendre',headers:{White:'?',Black:'?',Date:'????.??.??'},occurrence_count:1,occurrences:[{path:'0.0',fen:START,label:'2. Nf3',variation:false}]};
  const {panel,host}=await createMatches({onOpenEntry:async(id,args)=>opened.push({id,args})},result([entry]));
  assert.match(host.innerHTML,/Finale de tours à défendre/);assert.doesNotMatch(host.innerHTML,/class="position-occurrences"/);assert.match(host.innerHTML,/data-position-action="open"/);await panel.click(event('open'));assert.equal(opened[0].id,9);assert.equal(opened[0].args.path,'0.0');panel.dispose();
 },
 async source_changes_locks_and_stale_clicks_block_navigation(){
  let opened=0;const {panel,board}=await createMatches({onOpenEntry:async()=>opened++});board.inputLocked=true;await panel.click(event('open'));board.inputLocked=false;board.busy=true;await panel.click(event('open'));board.busy=false;assert.equal(opened,0);
  board.fen=NEXT;const click=panel.click(event('open'));assert.equal(opened,0);assert.equal(query(requests.at(-1)).get('summary'),'true');requests.at(-1).resolve(summary([]));await click;
  board.doc={id:99,base_id:3};const changed=panel.update({immediate:true});requests.at(-1).resolve(summary());await changed;assert.equal(requests.length,4);panel.dispose();
 },
 async asynchronous_open_guard_survives_quicksave_but_not_navigation_or_hide(){
  let context,finish;const {panel,board}=await createMatches({onOpenEntry:async(id,options)=>{context=options;await new Promise(resolve=>finish=resolve);}});
  const opening=panel.click(event('open',0,1));assert.equal(context.isCurrent(),true);board.doc={...board.doc,headers:{Event:'New annotation saved'}};assert.equal(context.isCurrent(),true);await panel.click(event('back'));assert.equal(panel.selectedBase.base_id,2);await panel.click(event('open'));assert.equal(panel.opening,true);
  board.path='0';assert.equal(context.isCurrent(),false);board.path='';assert.equal(context.isCurrent(),true);await panel.setVisible(false);assert.equal(context.isCurrent(),false);finish();await opening;assert.equal(panel.opening,false);panel.dispose();
 },
 async failed_open_keeps_results_and_can_be_retried(){
  let attempts=0;const {panel,host}=await createMatches({onOpenEntry:async()=>{attempts++;if(attempts===1)throw new Error('La partie a été supprimée.');}});await panel.click(event('open'));assert.match(host.innerHTML,/La partie a été supprimée/);assert.match(host.innerHTML,/Alice/);assert.equal(panel.opening,false);await panel.click(event('open'));assert.equal(attempts,2);assert.doesNotMatch(host.innerHTML,/supprimée/);panel.dispose();
 },
 async dispose_cancels_request_and_prevents_late_render_and_navigation(){
  const {panel,host}=await create();const load=panel.click(event('base')),pending=requests.at(-1);panel.dispose();assert.equal(pending.options.signal.aborted,true);host.innerHTML='Autre page';pending.resolve(result());await load;await panel.click(event('open'));assert.equal(host.innerHTML,'Autre page');assert.equal(Object.keys(host.handlers).length,0);
 },
 async training_or_disposed_board_does_not_fetch(){
  for(const flag of ['training','disposed']){const source=board();source[flag]=true;const panel=new PositionPanel(new Host(),{board:source});await panel.ready;assert.equal(requests.length,0);panel.dispose();}
 },
};
const scenario=process.argv[2];assert.ok(tests[scenario],'Unknown scenario '+scenario);await tests[scenario]();console.log(scenario+' passed');
