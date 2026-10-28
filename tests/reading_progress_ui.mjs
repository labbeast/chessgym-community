import assert from 'node:assert/strict';
import {ReadingTracker,flushReadingWrites,resetReadingContext,mainlineNodes,savedReadingNode,readingPercent,readingTime,readingSettingsHtml,readingDashboardHtml,readingStripHtml} from '../static/reading-progress.js';
import {analysisMovesHtml} from '../static/analysis-moves.js';

const pathFor=n=>Array(n).fill('0').join('.');
function documentFixture(id=7){return {id,base_id:2,pgn:'1. e4 e5 2. Nf3 *',headers:{Event:'Cours'},reading:{enabled:true,entry_id:id,base_id:2,bookmark_path:'',read_moves:0,total_moves:3,percent:0,active_seconds:0,completed:false,visited:false,content_key:'saved-version',revision:0},nodes:[
 {path:'',parent:null,children:['0','1'],fen:'root w - - 0 1',comment:'Introduction'},
 {path:'0',parent:'',children:['0.0'],san:'e4',fen:'e4 b - - 0 1',comment:'Un plan',nags:[1]},
 {path:'0.0',parent:'0',children:['0.0.0'],san:'e5',fen:'e5 w - - 0 2'},
 {path:'0.0.0',parent:'0.0',children:[],san:'Nf3',fen:'nf3 b - - 1 2'},
 {path:'1',parent:'',children:['1.0'],san:'d4',fen:'d4 b - - 0 1'},
 {path:'1.0',parent:'1',children:[],san:'d5',fen:'d5 w - - 0 2'}
]};}
class Surface{
 constructor(){this.listeners=new Map();}
 addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
 removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
 emit(type){for(const fn of this.listeners.get(type)||[])fn({type,target:this});}
 count(){return [...this.listeners.values()].reduce((n,set)=>n+set.size,0);}
}
class Clock{
 constructor(){this.value=0;this.next=1;this.timers=new Map();}
 now=()=>this.value;
 every=(fn,ms)=>this.add(fn,ms,ms);
 later=(fn,ms)=>this.add(fn,ms,0);
 stop=id=>this.timers.delete(id);
 add(fn,ms,repeat){const id=this.next++;this.timers.set(id,{fn,at:this.value+ms,repeat});return id;}
 jump(ms){this.value+=ms;}
 async advance(ms){
  const target=this.value+ms;let turns=0;
  while(true){
   const next=[...this.timers.entries()].filter(([,v])=>v.at<=target).sort((a,b)=>a[1].at-b[1].at)[0];
   if(!next)break;assert.ok(++turns<10000,'timer loop');const [id,timer]=next;this.value=timer.at;
   if(timer.repeat)timer.at+=timer.repeat;else this.timers.delete(id);
   timer.fn();await flushReadingWrites();
  }
  this.value=target;
 }
}
function fixture({id=7,path='',training_run_id=null,requestHook}={}){
 const doc=documentFixture(id),page=new Surface(),win=new Surface(),clock=new Clock(),calls=[],updates=[],errors=[],receipts=new Set();
 page.visibilityState='visible';page.focused=true;page.hasFocus=()=>page.focused;
 const server={state:structuredClone(doc.reading),posts:0};
 async function dispatch(url,options={}){
  assert.equal(url,'/api/entries/'+id+'/reading');
  if(!options.method)return structuredClone(server.state);
  const body=structuredClone(options.body);calls.push(body);server.posts++;
  if(receipts.has(body.request_id))return structuredClone(server.state);
  if(body.content_key!==server.state.content_key||body.revision!==server.state.revision){const e=Error('Concurrent change');e.status=409;throw e;}
  assert.ok(mainlineNodes(doc).some(node=>node.path===body.path),'main line payload');
  assert.match(body.request_id,/^[A-Za-z0-9_-]{8,100}$/);
  const plies=body.path?body.path.split('.').length:0;
  server.state.read_moves=body.mode==='bookmark'?plies:Math.max(server.state.read_moves,plies);
  if(body.mode==='bookmark')server.state.revision++;
  server.state.bookmark_path=pathFor(server.state.read_moves);server.state.percent=server.state.read_moves/3*100;
  server.state.visited=true;server.state.completed=server.state.read_moves===3;server.state.active_seconds+=body.active_seconds;
  receipts.add(body.request_id);return structuredClone(server.state);
 }
 const request=(url,options)=>requestHook?requestHook({url,options,dispatch,server,calls}):dispatch(url,options);
 const tracker=new ReadingTracker({doc,path,training_run_id,request,onUpdate:r=>updates.push(r),onError:e=>errors.push(e),document:page,window:win,now:clock.now,setInterval:clock.every,clearInterval:clock.stop,setTimeout:clock.later,clearTimeout:clock.stop});
 return {doc,page,win,clock,server,calls,updates,errors,tracker,async dispose(){tracker.dispose();await flushReadingWrites();}};
}
const tests={
 async toolbar_disposal_restores_workbench_before_failed_action_remount(){
  const board={inert:false},notebook={inert:false},alreadyLocked={inert:true};let removed=0;
  const attachOverlay=tracker=>{tracker.toolbarPauseRegions=[board,notebook,alreadyLocked].map(node=>({node,inert:node.inert}));for(const {node} of tracker.toolbarPauseRegions)node.inert=true;tracker.toolbarPauseOverlay={remove(){removed++;}};};
  const first=fixture();await first.tracker.pause();attachOverlay(first.tracker);await first.dispose();
  assert.equal(removed,1);assert.equal(board.inert,false);assert.equal(notebook.inert,false);assert.equal(alreadyLocked.inert,true);
  assert.equal(first.tracker.toolbarPauseOverlay,null);assert.deepEqual(first.tracker.toolbarPauseRegions,[]);
  const replacement=fixture();await replacement.tracker.pause();attachOverlay(replacement.tracker);await replacement.dispose();
  assert.equal(removed,2);assert.equal(board.inert,false);assert.equal(notebook.inert,false);assert.equal(alreadyLocked.inert,true);
  replacement.tracker.dispose();assert.equal(removed,2,'repeated disposal is harmless');
 },
 async toolbar_elapsed_survives_heartbeats_and_pause_excludes_all_inactive_time(){
  const f=fixture();f.clock.jump(5250);
  assert.equal(f.tracker.toolbarElapsedMs(),5250);assert.equal(f.tracker.toolbarRecordedMs(),0);
  await f.tracker.pause();assert.equal(f.tracker.paused,true);assert.equal(f.tracker.toolbarRecordedMs(),5000);
  assert.equal(f.server.state.active_seconds,5);const calls=f.calls.length;
  f.clock.jump(30000);f.page.emit('pointerdown');f.tracker.visit(f.doc,'0.0');f.win.emit('focus');f.tracker.tick();await f.tracker.flush();
  assert.equal(f.tracker.toolbarElapsedMs(),5250);assert.equal(f.calls.length,calls);assert.equal(f.server.state.read_moves,0);
  f.tracker.resume();f.clock.jump(1750);f.tracker.tick();await f.tracker.flush();
  assert.equal(f.tracker.toolbarElapsedMs(),7000);assert.equal(f.tracker.toolbarRecordedMs(),7000);assert.equal(f.server.state.active_seconds,7);
  f.page.visibilityState='hidden';f.page.emit('visibilitychange');f.clock.jump(10000);assert.equal(f.tracker.toolbarElapsedMs(),7000);
  f.page.visibilityState='visible';f.page.emit('visibilitychange');f.clock.jump(1000);assert.equal(f.tracker.toolbarElapsedMs(),8000);await f.dispose();
 },
 async toolbar_recorded_time_waits_for_receipt_confirmation_and_never_counts_retry_twice(){
  let lose=true;const f=fixture({requestHook:async({url,options,dispatch})=>{const result=await dispatch(url,options);if(lose){lose=false;throw Error('Response lost');}return result;}});
  f.clock.jump(5000);f.tracker.tick();await f.tracker.flush();
  assert.equal(f.tracker.toolbarElapsedMs(),5000);assert.equal(f.tracker.toolbarRecordedMs(),0);assert.equal(f.server.state.active_seconds,5);
  await f.tracker.retry();assert.equal(f.tracker.toolbarRecordedMs(),5000);await f.tracker.retry();assert.equal(f.tracker.toolbarRecordedMs(),5000);
  assert.equal(f.server.state.active_seconds,5);await f.dispose();
 },
 async training_context_exists_before_first_write_and_survives_visit_changes(){
  const run='22222222-2222-4222-8222-222222222222',f=fixture({training_run_id:run});
  await f.clock.advance(300);assert.equal(f.calls[0].training_run_id,run);assert.equal(f.calls[0].active_seconds,0);
  const firstVisit=f.calls[0].visit_id;f.clock.jump(5000);f.page.visibilityState='hidden';f.page.emit('visibilitychange');await flushReadingWrites();
  f.page.visibilityState='visible';f.win.emit('focus');f.clock.jump(3000);f.tracker.tick();await f.tracker.flush();
  assert.notEqual(f.calls.at(-1).visit_id,firstVisit);assert.ok(f.calls.every(call=>call.training_run_id===run));
  assert.equal(f.tracker.training_run_id,run);await f.dispose();
  const free=fixture({id:8});await free.tracker.flush();assert.equal('training_run_id' in free.calls[0],false);await free.dispose();
 },
 async training_retry_retains_original_run_and_receipt(){
  let loseResponse=true;const sent=[],run='22222222-2222-4222-8222-222222222222';
  const f=fixture({training_run_id:run,requestHook:async({url,options,dispatch})=>{
   if(options?.body)sent.push(structuredClone(options.body));const result=await dispatch(url,options);
   if(loseResponse){loseResponse=false;throw Error('Response lost');}return result;
  }});
  f.clock.jump(5000);f.tracker.tick();await f.tracker.flush();assert.equal(f.server.state.active_seconds,5);
  assert.equal(await f.tracker.retry(),true);assert.deepEqual(sent[1],sent[0]);assert.equal(sent[1].training_run_id,run);
  assert.equal(f.server.state.active_seconds,5);await f.dispose();
 },
 async rereading_earlier_move_retains_exact_viewed_path_on_heartbeat(){
  const f=fixture();f.tracker.visit(f.doc,'0.0.0');await f.tracker.flush();
  f.tracker.visit(f.doc,'0');await f.tracker.flush();assert.equal(f.server.state.read_moves,3);
  f.clock.jump(5000);f.tracker.tick();await f.tracker.flush();
  assert.equal(f.calls.at(-1).path,'0.0.0','furthest bookmark is retained');
  assert.equal(f.calls.at(-1).visit_path,'0','journal records the position actually being read');
  assert.equal(f.calls.at(-1).visit_fen,'e4 b - - 0 1');
  await f.dispose();
 },
 async debounce_tracks_last_viewed_position_independently_of_furthest(){
  const f=fixture();f.tracker.visit(f.doc,'0.0.0');f.tracker.visit(f.doc,'0');await f.clock.advance(300);
  assert.equal(f.calls[0].path,'0.0.0');assert.equal(f.calls[0].visit_path,'0');assert.equal(f.server.state.read_moves,3);
  await f.dispose();
 },
 async hidden_and_reopened_reading_uses_distinct_visit_id(){
  const f=fixture();await f.tracker.flush();const first=f.calls[0].visit_id;
  f.clock.jump(2000);f.page.visibilityState='hidden';f.page.emit('visibilitychange');await flushReadingWrites();
  const closed=f.calls.at(-1);assert.equal(closed.visit_id,first);assert.equal(closed.visit_end,true);
  const count=f.calls.length;f.win.emit('blur');await flushReadingWrites();assert.equal(f.calls.length,count,'duplicate hide does not create a visit');
  f.page.visibilityState='visible';f.win.emit('focus');f.clock.jump(3000);f.tracker.tick();await f.tracker.flush();
  assert.notEqual(f.calls.at(-1).visit_id,first);assert.equal(f.calls.at(-1).visit_sequence,1);
  assert.equal(f.server.state.active_seconds,5);await f.dispose();
 },
 async account_reset_discards_queued_writes_and_stale_response_updates(){
  let release;const gate=new Promise(resolve=>release=resolve);
  const old=fixture({requestHook:async({url,options,dispatch})=>{await gate;return dispatch(url,options);}});
  const queued=fixture({id:8});const one=old.tracker.flush();const two=queued.tracker.flush();
  await Promise.resolve();await Promise.resolve();resetReadingContext();release();await Promise.all([one,two]);
  assert.equal(old.updates.length,0);assert.equal(queued.calls.length,0);
  old.tracker.visit(old.doc,'0.0');await old.tracker.flush();assert.equal(old.calls.length,1);
  const fresh=fixture({id:9});await fresh.tracker.flush();assert.equal(fresh.calls.length,1);
  await old.dispose();await queued.dispose();await fresh.dispose();
 },
 async default_browser_timers_keep_the_host_receiver(){
  const originals=Object.fromEntries(['setTimeout','clearTimeout','setInterval','clearInterval'].map(name=>[name,globalThis[name]]));
  const clock=new Clock(),page=new Surface(),win=new Surface(),doc=documentFixture(987),calls=[],timerCalls=[];
  page.visibilityState='visible';page.hasFocus=()=>true;let tracker,state=structuredClone(doc.reading);
  // Browser timer methods brand-check their receiver. Arrow-function clocks
  // passed directly to ReadingTracker conceal an Illegal invocation failure.
  // Leave every timer argument OMITTED here, exercising production defaults.
  for(const [name,delegate] of [['setTimeout',clock.later],['clearTimeout',clock.stop],['setInterval',clock.every],['clearInterval',clock.stop]]){
   globalThis[name]=function(...args){assert.equal(this,globalThis,name+' must be called on its native host');timerCalls.push(name);return delegate(...args);};
  }
  try{
   tracker=new ReadingTracker({doc,document:page,window:win,now:clock.now,request:async(url,options)=>{
    assert.equal(url,'/api/entries/987/reading');const body=options.body;calls.push(structuredClone(body));
    const plies=body.path?body.path.split('.').length:0;state.read_moves=body.mode==='bookmark'?plies:Math.max(state.read_moves,plies);
    state.bookmark_path=pathFor(state.read_moves);state.visited=true;state.active_seconds+=body.active_seconds;
    if(body.mode==='bookmark')state.revision++;return structuredClone(state);
   }});
   await clock.advance(300);assert.equal(calls.length,1);assert.equal(calls[0].path,'','initial position auto-recorded');
   tracker.visit(doc,'0.0');await clock.advance(300);assert.equal(state.read_moves,2);
   assert.equal(await tracker.bookmark('0'),true);assert.equal(state.read_moves,1);
   await clock.advance(15000);assert.equal(state.read_moves,1,'timer heartbeat retains manual rewind');
   tracker.dispose();await flushReadingWrites();assert.equal(page.count()+win.count(),0);assert.equal(clock.timers.size,0);
   for(const name of Object.keys(originals))assert.ok(timerCalls.includes(name),name+' exercised');
  }finally{
   tracker?.dispose();await flushReadingWrites();Object.assign(globalThis,originals);
  }
 },
 mainline_and_markup_are_escaped_and_explicit(){
  const doc=documentFixture();assert.deepEqual(mainlineNodes(doc).map(n=>n.path),['','0','0.0','0.0.0']);
  assert.deepEqual(mainlineNodes(null),[]);
  assert.equal(readingPercent(150),'100 %');assert.equal(readingPercent(-1),'0 %');assert.equal(readingTime(null),'À estimer');assert.equal(readingTime(0),'0 s');assert.equal(readingTime(3601),'1 h 00');
  assert.match(readingDashboardHtml([]),/Aucune lecture/);
  const html=readingDashboardHtml([{base_id:2,name:'<img src=x onerror="bad">',percent:50,total_entries:10,completed_entries:5,active_seconds:60,remaining_seconds:null,last_entry_id:7,continue_entry_id:8}]);
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/À estimer/);
  for(const attribute of ['data-reading-continue="2"','data-reading-bookmark="2"','data-base="2"'])assert.ok(html.includes(attribute));
  assert.match(readingSettingsHtml({settings:{reading_enabled:true}}),/name="reading_enabled" checked/);
  assert.equal(readingStripHtml({enabled:false}),'');assert.match(readingStripHtml({...doc.reading,completed:true}),/Terminée/);
 },
 async debounce_preserves_furthest_mainline_and_ignores_variations(){
  const f=fixture();f.tracker.visit(f.doc,'0');f.tracker.visit(f.doc,'0.0.0');f.tracker.visit(f.doc,'0');f.tracker.visit(f.doc,'1.0');
  await f.clock.advance(300);assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'0.0.0');assert.equal(f.server.state.read_moves,3);
  f.tracker.visit(f.doc,'1');await f.clock.advance(400);assert.equal(f.calls.length,1);
  f.tracker.visit(f.doc,'0');await f.clock.advance(300);assert.equal(f.server.state.read_moves,3);
  await f.dispose();
 },
 async writes_are_serialized_across_tracker_replacement(){
  let release;const gate=new Promise(resolve=>release=resolve),order=[];
  const a=fixture({id:7,requestHook:async({url,options,dispatch})=>{order.push('first-start');await gate;const result=await dispatch(url,options);order.push('first-end');return result;}});
  const b=fixture({id:8,requestHook:async({url,options,dispatch})=>{order.push('second-start');return dispatch(url,options);}});
  a.tracker.visit(a.doc,'0.0');const one=a.tracker.flush();b.tracker.visit(b.doc,'0');const two=b.tracker.flush();
  await Promise.resolve();await Promise.resolve();assert.deepEqual(order,['first-start']);release();await Promise.all([one,two]);
  assert.deepEqual(order,['first-start','first-end','second-start']);assert.equal(a.server.state.read_moves,2);assert.equal(b.server.state.read_moves,1);
  await a.dispose();await b.dispose();
 },
 async manual_rewind_survives_later_heartbeats(){
  const f=fixture();f.tracker.visit(f.doc,'0.0.0');await f.tracker.flush();assert.equal(f.server.state.read_moves,3);
  assert.equal(await f.tracker.bookmark('0'),true);assert.equal(f.server.state.read_moves,1);
  const revision=f.server.state.revision;await f.clock.advance(15000);
  assert.equal(f.server.state.read_moves,1);assert.equal(f.calls.at(-1).path,'0');assert.equal(f.calls.at(-1).revision,revision);
  assert.equal(await f.tracker.bookmark('1'),false);
  f.tracker.visit(f.doc,'0.0');await f.tracker.flush();assert.equal(f.server.state.read_moves,2);
  await f.dispose();
 },
 async active_time_excludes_hidden_blurred_and_idle_periods(){
  const f=fixture();await f.clock.advance(10000);f.page.visibilityState='hidden';f.page.emit('visibilitychange');await flushReadingWrites();
  assert.equal(f.server.state.active_seconds,10);
  await f.clock.advance(120000);assert.equal(f.server.state.active_seconds,10);
  f.page.visibilityState='visible';f.page.emit('visibilitychange');await f.clock.advance(5000);f.page.focused=false;f.win.emit('blur');await flushReadingWrites();
  assert.equal(f.server.state.active_seconds,15);
  await f.clock.advance(60000);assert.equal(f.server.state.active_seconds,15);
  f.page.focused=true;f.win.emit('focus');await f.clock.advance(120000);await f.tracker.flush();
  assert.equal(f.server.state.active_seconds,105,'idle stops after 90 active seconds');
  f.page.emit('pointerdown');await f.clock.advance(5000);f.tracker.tick();await f.tracker.flush();assert.equal(f.server.state.active_seconds,110);
  await f.dispose();
 },
 async disposal_flushes_once_and_removes_every_listener(){
  const f=fixture();f.tracker.visit(f.doc,'0.0');f.clock.jump(2000);assert.ok(f.page.count()+f.win.count()>0);
  await f.dispose();assert.equal(f.server.state.read_moves,2);assert.equal(f.server.state.active_seconds,2);
  assert.equal(f.page.count()+f.win.count(),0);assert.equal(f.clock.timers.size,0);
  const count=f.calls.length,updates=f.updates.length;f.tracker.dispose();f.tracker.visit(f.doc,'0.0.0');await f.clock.advance(90000);
  assert.equal(f.calls.length,count);assert.equal(f.updates.length,updates);
 },
 async unknown_response_retry_reuses_receipt_and_never_double_counts(){
  let fail=true;
  const f=fixture({requestHook:async({url,options,dispatch})=>{const value=await dispatch(url,options);if(options?.method&&fail){fail=false;throw Error('Network response lost');}return value;}});
  f.tracker.visit(f.doc,'0.0');f.clock.jump(4000);f.tracker.tick();await f.tracker.flush();assert.equal(f.errors.length,1);assert.equal(f.server.state.active_seconds,4);
  assert.equal(await f.tracker.retry(),true);assert.equal(f.server.state.active_seconds,4);assert.equal(f.calls.length,2);assert.equal(f.calls[0].request_id,f.calls[1].request_id);
  assert.equal(f.tracker.reading.read_moves,2);await f.dispose();
 },
 async conflict_refresh_preserves_remote_manual_bookmark(){
  const f=fixture();f.tracker.visit(f.doc,'0.0.0');await f.tracker.flush();
  Object.assign(f.server.state,{read_moves:1,bookmark_path:'0',revision:1,percent:100/3,completed:false});
  f.tracker.visit(f.doc,'0.0');await f.tracker.flush();assert.equal(f.errors.length,1);assert.equal(f.server.state.read_moves,1);
  assert.equal(await f.tracker.retry(),true);assert.equal(f.tracker.reading.bookmark_path,'0');assert.equal(f.tracker.reading.revision,1);assert.equal(f.tracker.failed.length,0);
  await f.clock.advance(15000);assert.equal(f.server.state.read_moves,1);await f.dispose();
 },
 async failed_navigation_settlement_keeps_payload_until_recovery(){
  let offline=true;
  const f=fixture({requestHook:async({url,options,dispatch})=>{if(offline)throw Error('Offline');return dispatch(url,options);}});
  f.tracker.visit(f.doc,'0.0');f.clock.jump(5000);
  await assert.rejects(f.tracker.settle(),/lecture.*enregistré/);
  assert.ok(f.tracker.failed.length>0);assert.equal(f.server.state.active_seconds,0);
  offline=false;await f.tracker.settle();
  assert.equal(f.tracker.failed.length,0);assert.equal(f.server.state.read_moves,2);assert.equal(f.server.state.active_seconds,5);
  await f.dispose();
 },
 async failed_payload_survives_tracker_replacement(){
  const first=fixture({requestHook:async()=>{throw Error('Offline');}});
  first.tracker.visit(first.doc,'0.0');await first.tracker.flush();const id=first.tracker.failed[0].request_id;
  await first.dispose();const next=fixture();assert.equal(next.tracker.failed[0].request_id,id);
  assert.equal(await next.tracker.retry(),true);assert.equal(next.server.state.read_moves,2);assert.equal(next.calls[0].request_id,id);
  assert.equal(first.tracker.failed.length,0);await next.dispose();
 },
 async saved_content_change_discards_old_pending_paths(){
  const f=fixture();f.tracker.visit(f.doc,'0.0.0');
  f.doc.reading={...f.doc.reading,content_key:'new-content',revision:1,total_moves:1};f.doc.nodes=f.doc.nodes.filter(n=>['','0'].includes(n.path));f.doc.nodes[1].children=[];
  Object.assign(f.server.state,f.doc.reading);f.tracker.visit(f.doc,'0');await f.tracker.flush();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'0');assert.equal(f.calls[0].content_key,'new-content');assert.equal(f.calls[0].revision,1);
  await f.dispose();
 },
 async temporary_moves_and_promotions_never_advance_saved_reading(){
  const f=fixture();f.doc.analysis_source_line=mainlineNodes(f.doc).map(({path,fen})=>({path,fen}));
  f.tracker.visit(f.doc,'0');await f.tracker.flush();const count=f.calls.length;
  const draft=structuredClone(f.doc),end=draft.nodes.find(n=>n.path==='0.0.0');
  end.children=['0.0.0.0'];draft.nodes.push({path:'0.0.0.0',parent:end.path,children:[],fen:'new w - - 2 3'});
  f.tracker.visit(draft,'0.0.0.0');await f.tracker.flush();assert.equal(f.calls.length,count);
  assert.equal(await f.tracker.bookmark('0.0.0.0'),false);assert.equal(f.calls.length,count);
  draft.nodes.find(n=>n.path==='0').fen='d4 b - - 0 1';
  f.tracker.visit(draft,'0');await f.tracker.flush();assert.equal(f.calls.length,count);
  assert.equal(await f.tracker.bookmark('0'),false);
  // Even reconvergence to an original FEN does not restore an edited prefix.
  f.tracker.visit(draft,'0.0');await f.tracker.flush();assert.equal(f.calls.length,count);
  assert.equal(await f.tracker.bookmark('0.0'),false);
  assert.equal(f.server.state.read_moves,1);await f.dispose();
 },
 async draft_heartbeats_use_saved_bookmark_and_fen(){
  const f=fixture();f.doc.analysis_source_line=mainlineNodes(f.doc).map(({path,fen})=>({path,fen}));
  f.tracker.visit(f.doc,'0.0');await f.tracker.flush();
  const draft=structuredClone(f.doc);draft.nodes.find(n=>n.path==='0').fen='new b - - 0 1';draft.nodes.find(n=>n.path==='0.0').fen='changed w - - 0 2';
  f.tracker.visit(draft,'0.0');f.clock.jump(4000);f.tracker.tick();await f.tracker.flush();
  assert.equal(f.calls.at(-1).path,'0.0');assert.equal(f.calls.at(-1).fen,'e5 w - - 0 2');
  assert.equal(f.server.state.read_moves,2);assert.equal(f.server.state.active_seconds,4);assert.equal(f.errors.length,0);
  await f.dispose();
 },
 async explicit_save_refreshes_the_readable_source_line(){
  const f=fixture();f.doc.analysis_source_line=mainlineNodes(f.doc).map(({path,fen})=>({path,fen}));
  await f.tracker.flush();const saved=structuredClone(f.doc);
  saved.nodes.find(n=>n.path==='0').fen='new b - - 0 1';
  saved.analysis_source_line=mainlineNodes(saved).map(({path,fen})=>({path,fen}));
  saved.reading={...saved.reading,content_key:'explicit-save',revision:1};Object.assign(f.server.state,saved.reading);
  f.tracker.visit(saved,'0');await f.tracker.flush();
  assert.equal(f.calls.at(-1).path,'0');assert.equal(f.calls.at(-1).fen,'new b - - 0 1');
  assert.equal(f.calls.at(-1).content_key,'explicit-save');assert.equal(f.errors.length,0);await f.dispose();
 },
 saved_mainline_comparison_stops_at_first_changed_ancestor(){
  const doc=documentFixture(),original=mainlineNodes(doc).map(({path,fen})=>({path,fen}));doc.analysis_source_line=original;
  assert.equal(savedReadingNode(doc,'0.0').index,2);
  doc.nodes.find(n=>n.path==='0').fen='changed';assert.equal(savedReadingNode(doc,'0.0'),null);
  doc.analysis_source_line=[];assert.equal(savedReadingNode(doc,''),null);
 },
 move_marker_does_not_modify_content_or_mark_untracked_games(){
  const doc=documentFixture(),before=structuredClone(doc),reading={...doc.reading,visited:true,bookmark_path:'0.0',read_moves:2};
  const html=analysisMovesHtml(doc,'0',null,null,reading);
  assert.equal((html.match(/class="reading-bookmark-icon" aria-hidden="true">/g)||[]).length,1);assert.match(html,/reading-bookmark" data-path="0\.0"/);assert.match(html,/Signet de lecture/);
  assert.deepEqual(doc,before);const untracked=analysisMovesHtml(doc,'0',null,null,{...reading,enabled:false});assert.doesNotMatch(untracked,/class="reading-bookmark-icon" aria-hidden="true">/);assert.doesNotMatch(untracked,/reading-bookmark" data-path=/);
 }
};
const selected=process.argv[2];assert.ok(tests[selected],selected);await tests[selected]();console.log(selected+' passed');
