import assert from 'node:assert/strict';
import {ComputerPlayView,computerOrigin} from '../static/computer-play.js';
import {makeDoc,appendLine} from '../static/chess-document.js';
import {ComputerActivity,newComputerActivity} from '../static/computer-activity.js';
import {ComputerClock,newClock} from '../static/computer-clock.js';
import {START} from '../static/api.js';

const e4={uci:'e2e4',san:'e4',fen:'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'};
const e5={uci:'e7e5',san:'e5',fen:'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'};
const nf3={uci:'g1f3',san:'Nf3',fen:'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'};
const nc6={uci:'b8c6',san:'Nc6',fen:'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3'};
const all=[e4,e5,nf3,nc6];
function state(count=0){
 const applied=appendLine(makeDoc(),'',all.slice(0,count));
 const fen=applied.doc.nodes.at(-1).fen;
 return {initial_fen:START,history:all.slice(0,count).map(move=>move.uci),fen,turn:count%2?'black':'white',game_over:false,result:'*',reason:null,check:false,doc:applied.doc,path:applied.path,legalState:{fen,moves:all[count]?[all[count].uci]:[],game_over:false,result:'*'},san:all[count-1]?.san};
}
function view(){
 const instance=new ComputerPlayView({innerHTML:'',classList:{add(){},remove(){}}});
 instance.renderPlay=()=>{instance.renderedBusy=instance.busy;};instance.renderSetup=()=>{};
 instance.session={position:state(2),side:'white',baseline:0,start:{initial_fen:START,history:[]},config:structuredClone(instance.config),resigned:false,headers:{Result:'*'}};
 instance.mode='play';return instance;
}
const reply=value=>({ok:true,status:200,headers:new Headers({'Content-Type':'application/json'}),json:async()=>value});
const cases={
 async statistics_pauses_active_game_without_reset_and_resumes_only_untimed(){
  for(const timed of [false,true]){
   const instance=view(),before=structuredClone(instance.session.position);let now=0,replies=0;
   instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});
   if(timed){instance.session.clock=newClock({time_control:'5+0'});instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});instance.clock.start('white');}
   instance.startActivity();now=1500;instance.engineReply=async()=>{replies++;};
   const dialog=new EventTarget();dialog.open=true;dialog.close=()=>{dialog.open=false;dialog.dispatchEvent(new Event('close'));};instance.onStatistics=async()=>dialog;
   const pending=instance.showStatistics();await new Promise(resolve=>setTimeout(resolve,0));
   assert.equal(instance.activity.running,false);if(timed)assert.equal(instance.clock.state.paused,true);assert.equal(instance.session.activity.elapsed_ms,1500);
   now=30000;dialog.close();await pending;assert.deepEqual(instance.session.position,before);assert.equal(instance.session.activity.elapsed_ms,1500);
   assert.equal(replies,timed?0:1);if(timed)assert.equal(instance.clock.state.paused,true);else assert.equal(instance.activity.running,true);instance.dispose();
  }
 },
 async late_statistics_dialog_is_closed_after_navigation(){
  const instance=view();let resolve,closed=0;instance.onStatistics=()=>new Promise(done=>{resolve=done;});
  const pending=instance.showStatistics();instance.dispose();resolve({close(){closed++;}});await pending;
  assert.equal(closed,1);assert.equal(instance.statisticsDialog,null);
 },

 async active_duration_keeps_measuring_after_illegal_input(){
  for(const timed of [false,true]){
   const instance=view();let now=0;instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});
   if(timed){instance.session.clock=newClock({time_control:'5+0'});instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});instance.clock.start('white');}
   instance.startActivity();now=1000;instance.request=async()=>{throw Object.assign(new Error('Illegal'),{status:400});};await instance.humanMove('g1f3');assert.equal(instance.error,'Illegal');assert(instance.activity.running);now=6000;assert.equal(instance.snapshot().session.activity.elapsed_ms,6000);if(timed)assert.equal(instance.clock.state.running,'white');instance.dispose();
  }
 },
 async active_duration_pauses_closes_and_resumes_without_offline_time(){
  const instance=view();let now=0;instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});instance.startActivity();
  now=2400;assert.equal(instance.snapshot().session.activity.elapsed_ms,2400);instance.pauseGame({render:false,explicit:false});now=999999;assert.equal(instance.snapshot().session.activity.elapsed_ms,2400);
  const saved=instance.snapshot();instance.dispose();const restored=view();restored.request=async path=>path==='/opponents'?{engines:[]}:state(2);await restored.load(saved);
  assert.equal(restored.session.activity.elapsed_ms>=2400,true);assert.equal(restored.session.activity.elapsed_ms<2600,true);assert(restored.activity.running);restored.dispose();
 },
 async untimed_explicit_pause_locks_play_and_survives_reload_until_resume(){
  const instance=view();let now=0,calls=0;instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});instance.startActivity();
  instance.request=async()=>{calls++;return state(3);};now=2400;instance.pauseGame();assert(instance.paused());assert.equal(instance.status().className,'paused');
  await instance.humanMove('g1f3');assert.equal(calls,0);assert.equal(instance.pendingMove,null);assert.equal(instance.session.position.history.length,2);
  instance.session.position=state(3);await instance.engineReply();assert.equal(calls,0);
  now=900000;const saved=instance.snapshot();assert.equal(saved.session.paused,true);assert.equal(saved.session.activity.elapsed_ms,2400);instance.dispose();
  const restored=view(),paths=[];restored.request=async path=>{paths.push(path);return path==='/opponents'?{engines:[]}:path==='/move'?state(4):state(3);};await restored.load(saved);
  assert(restored.paused());assert.equal(restored.activity.running,false);assert.equal(restored.session.activity.elapsed_ms,2400);assert.deepEqual(paths,['/opponents','/position']);
  await restored.resume();assert.equal(restored.paused(),false);assert.equal(restored.session.paused,false);assert.equal(restored.activity.running,true);assert.equal(restored.session.position.history.length,4);assert.equal(paths.filter(path=>path==='/move').length,1);restored.dispose();
 },
 async untimed_explicit_pause_is_not_cleared_by_statistics_or_visibility(){
  const previousDocument=globalThis.document;globalThis.document={hidden:false,querySelector:()=>null};
  try{
   const instance=view();instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity);instance.startActivity();instance.pauseGame();
   const dialog=new EventTarget();dialog.close=()=>dialog.dispatchEvent(new Event('close'));instance.onStatistics=async()=>dialog;
   const pending=instance.showStatistics();await new Promise(resolve=>setTimeout(resolve,0));dialog.close();await pending;
   assert(instance.paused());assert.equal(instance.activity.running,false);
   globalThis.document.hidden=true;instance.onHidden();globalThis.document.hidden=false;
   instance.request=async()=>state(2);await instance.resume({explicit:false});assert(instance.paused());assert.equal(instance.activity.running,false);
   await instance.restart();assert.equal(instance.paused(),false);assert.equal(instance.session.paused,false);assert(instance.activity.running);instance.dispose();
  }finally{globalThis.document=previousDocument;}
 },
 async untimed_explicit_pause_aborts_pending_engine_and_ignores_late_reply(){
  const instance=view();instance.session.position=state(3);let now=0,deliver;instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});
  globalThis.fetch=async()=>new Promise(resolve=>{deliver=resolve;});const pending=instance.engineReply();now=1500;instance.pauseGame();now=999999;deliver(reply(state(4)));await pending;
  assert.equal(instance.session.position.history.length,3);assert.equal(instance.snapshot().session.activity.elapsed_ms,1500);assert.equal(instance.activity.running,false);assert(instance.paused());instance.dispose();
 },
 async active_duration_stops_at_game_end_and_restart_begins_at_zero(){
  const instance=view();let now=0;instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});instance.startActivity();now=5000;
  instance.resign();assert.equal(instance.snapshot().session.activity.elapsed_ms,5000);now=80000;assert.equal(instance.snapshot().session.activity.elapsed_ms,5000);assert.equal(instance.activityTimer,null);
  instance.request=async()=>state();instance.engineReply=async()=>{};await instance.restart();assert(instance.session.activity.elapsed_ms<100);assert(instance.activity.running);instance.dispose();
 },
 async legacy_games_remain_unmeasured_and_new_games_get_active_duration(){
  const legacy=view(),saved=legacy.snapshot();legacy.request=async()=>state(2);await legacy.resume();assert.equal(legacy.snapshot().session.activity,undefined);legacy.dispose();
  const current=view();current.opponents=[{id:'stockfish',available:true}];current.request=async()=>state();current.engineReply=async()=>{};await current.start();assert.equal(current.session.activity.version,1);assert(current.activity.running);assert.equal(saved.session.activity,undefined);current.dispose();
 },
 async active_duration_excludes_hidden_views_and_timed_pauses(){
  const previousDocument=globalThis.document;globalThis.document={hidden:false,querySelector:()=>null};
  try{
   const instance=view();let now=0;instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});instance.startActivity();now=1000;globalThis.document.hidden=true;instance.onHidden();now=500000;
   assert.equal(instance.snapshot().session.activity.elapsed_ms,1000);assert.equal(instance.activity.running,false);
   instance.session.clock=newClock({time_control:'5+0'});instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});globalThis.document.hidden=false;instance.startActivity();now+=10000;assert.equal(instance.snapshot().session.activity.elapsed_ms,1000);
   instance.clock.start('white');instance.startActivity();now+=2000;instance.pauseGame({render:false});assert.equal(instance.snapshot().session.activity.elapsed_ms,3000);instance.dispose();
  }finally{globalThis.document=previousDocument;}
 },
 async active_duration_keeps_elapsed_time_when_a_move_is_taken_back(){
  const instance=view();let now=0;instance.session.activity=newComputerActivity();instance.activity=new ComputerActivity(instance.session.activity,{now:()=>now});instance.startActivity();now=3000;
  instance.request=async()=>state();instance.engineReply=async()=>{};await instance.undo();assert.equal(instance.snapshot().session.activity.elapsed_ms,3000);assert(instance.activity.running);instance.dispose();
 },
 async clocks_exclude_human_validation_latency_and_commit_increment_once(){
  const instance=view();let now=0;instance.session.clock=newClock({time_control:'custom',clock_minutes:1,clock_increment:2},2);instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});instance.clock.start('white');
  now=3000;instance.request=async()=>{now=53000;return state(3);};instance.engineReply=async()=>{};
  await instance.humanMove('g1f3');assert.equal(instance.session.clock.remaining.white,59000);assert.equal(instance.session.clock.remaining.black,60000);assert.equal(instance.session.clock.history.length,2);
  assert.equal(instance.session.clock.history.at(-1).ply,3);assert.equal(instance.clock.state.running,'black');instance.dispose();
 },
 async rejected_moves_receive_no_increment_and_resume_the_same_clock(){
  const instance=view();let now=0;instance.session.clock=newClock({time_control:'custom',clock_minutes:1,clock_increment:2},2);instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});instance.clock.start('white');now=3000;
  instance.request=async()=>{now=53000;const error=new Error('Illegal');error.status=400;throw error;};await instance.humanMove('g1f3');
  assert.equal(instance.clock.state.remaining.white,57000);assert.equal(instance.clock.state.history.length,1);assert.equal(instance.clock.state.running,'white');assert.equal(instance.pendingMove,null);instance.dispose();
 },
 async timed_reloads_stay_paused_until_explicit_resume(){
  const source=view();source.session.position=state(3);source.session.clock=newClock({time_control:'3+0'},3);source.clock=new ComputerClock(source.session.clock);source.clock.start('black');const saved=source.snapshot();source.dispose();
  const instance=view(),calls=[];instance.request=async(path,body)=>{calls.push(path);return path==='/opponents'?{engines:[]}:path==='/move'?state(4):state(3);};
  await instance.load(saved);assert(instance.paused());assert.deepEqual(calls,['/opponents','/position']);const initial=instance.clock.state.remaining.black;
  assert.equal(instance.session.position.history.length,3);await instance.resume();assert.equal(instance.session.position.history.length,4);assert(!instance.paused());assert.equal(calls.filter(path=>path==='/move').length,1);assert(instance.clock.state.remaining.black<=initial);instance.dispose();
 },
 async timed_takeback_restores_per_move_clocks_and_pgn_annotations(){
  const instance=view();let now=0;instance.session.position=state(2);instance.session.clock=newClock({time_control:'custom',clock_minutes:1,clock_increment:2},2);instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});instance.clock.start('white');
  now=5000;instance.accept(state(3));now=8000;instance.accept(state(4));assert.equal(instance.clock.state.remaining.white,57000);assert.equal(instance.clock.state.remaining.black,59000);
  assert.match(instance.gameDoc().pgn,/\[%clk 0:00:57\]/);assert.match(instance.gameDoc().pgn,/\[%clk 0:00:59\]/);
  instance.request=async()=>state(2);instance.engineReply=async()=>{};await instance.undo();assert.deepEqual(instance.clock.state.remaining,{white:60000,black:60000});assert.equal(instance.clock.state.history.length,1);assert.equal(instance.clock.state.running,'white');instance.dispose();
 },
 async pause_aborts_engine_and_ignores_a_reply_after_time_has_stopped(){
  const instance=view();instance.session.position=state(3);let now=0,deliver;instance.session.clock=newClock({time_control:'3+0'},3);instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});instance.clock.start('black');
  globalThis.fetch=async()=>new Promise(resolve=>{deliver=resolve;});const pending=instance.engineReply();now=1500;instance.pauseGame();const remaining=instance.clock.state.remaining.black;now=999999;deliver(reply(state(4)));await pending;
  assert.equal(instance.session.position.history.length,3);assert.equal(instance.clock.read().remaining.black,remaining);assert(instance.paused());instance.dispose();
 },
 async flag_fall_uses_server_result_and_cancels_pending_engine(){
  const instance=view();instance.session.position=state(3);let now=0;instance.session.clock=newClock({time_control:'custom',clock_minutes:.1,clock_increment:0},3);instance.clock=new ComputerClock(instance.session.clock,{now:()=>now});instance.clock.start('black');now=7000;instance.clock.read();
  instance.request=async(path,body)=>{assert.equal(path,'/timeout');assert.equal(body.loser,'black');return {...state(3),game_over:true,result:'1/2-1/2',reason:'timeout'};};
  await instance.timeout('black');assert(instance.finished());assert.equal(instance.session.headers.Result,'1/2-1/2');assert.equal(instance.session.timeout,'black');assert.equal(instance.clock.state.remaining.black,0);assert.equal(instance.status().className,'draw');instance.dispose();
 },
 async replacement_archives_before_creating_a_new_identity_and_failure_keeps_game(){
  const instance=view();const first=instance.snapshot(),archived=[];instance.onArchive=async snapshot=>{archived.push(snapshot);};instance.request=async()=>state();instance.engineReply=async()=>{};
  await instance.restart();assert.equal(archived.length,1);assert.equal(archived[0].session.id,first.session.id);assert.equal(archived[0].session.position.history.length,2);assert.notEqual(instance.session.id,first.session.id);
  const old=instance.snapshot();instance.onArchive=async()=>{throw new Error('Storage unavailable');};await assert.rejects(()=>instance.restart(),/Storage/);assert.equal(instance.session.id,old.session.id);assert.deepEqual(instance.session.position,old.session.position);instance.dispose();
 },
 native_engine_names_and_strength_follow_the_active_opponent(){
  const instance=view();instance.opponents=[{id:'stockfish',name:'My native engine',skills:[20],default_skill:20}];
  assert.equal(instance.engineName(),'My native engine');assert(instance.normalizeSetupStrength());assert.equal(instance.config.skill,20);
  instance.opponents[0].skills=[0,1,2,3];instance.opponents[0].default_skill=2;assert(instance.normalizeSetupStrength());assert.equal(instance.config.skill,2);
  assert.equal(instance.engineName(instance.config),'My native engine · Niveau 2');
 },
 origin_follows_selected_branch_without_mutating_saved_game(){
  const main=appendLine(makeDoc(),'',all),branched=appendLine(main.doc,'0',[{uci:'c7c5',san:'c5',fen:'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2'}]);
  branched.doc.id=123;branched.doc.base_id=9;const original=JSON.stringify(branched.doc);
  assert.deepEqual(computerOrigin(branched.doc,branched.path),{initial_fen:START,history:['e2e4','c7c5'],fen:branched.doc.nodes.at(-1).fen});
  assert.deepEqual(computerOrigin(branched.doc,''),{initial_fen:START,history:[],fen:START});
  assert.equal(JSON.stringify(branched.doc),original);assert.throws(()=>computerOrigin(branched.doc,'unknown'));
  branched.doc.nodes.find(node=>node.path===branched.path).parent='missing';assert.throws(()=>computerOrigin(branched.doc,branched.path));
 },
 educational_null_moves_start_from_current_diagram_without_masking_broken_history(){
  const diagram=appendLine(makeDoc(),'',[{uci:'0000',san:'--',fen:START.replace(' w ',' b ')},e5]);
  const original=JSON.stringify(diagram.doc),fen=diagram.doc.nodes.at(-1).fen;
  assert.deepEqual(computerOrigin(diagram.doc,diagram.path),{initial_fen:fen,history:[],fen});
  assert.equal(JSON.stringify(diagram.doc),original);
  diagram.doc.nodes[1].parent='missing';assert.throws(()=>computerOrigin(diagram.doc,diagram.path));
 },
 async late_results_cannot_change_disposed_or_restarted_games(){
  let deliver,request;
  globalThis.fetch=async(url,options)=>{request=options;return new Promise(resolve=>{deliver=resolve;});};
  const first=view(),pending=first.request('/position',first.stateBody());
  first.cancelPending();assert(request.signal.aborted);deliver(reply(state(3)));assert.equal(await pending,null);assert.equal(first.session.position.history.length,2);
  const second=view(),disposed=second.request('/move',second.stateBody());second.dispose();deliver(reply(state(4)));assert.equal(await disposed,null);
 },
 async newer_request_wins_even_if_an_old_response_arrives_later(){
  const responses=[];globalThis.fetch=async()=>new Promise(resolve=>responses.push(resolve));
  const instance=view(),old=instance.request('/position',instance.stateBody()),latest=instance.request('/position',instance.stateBody());
  responses[1](reply(state(3)));assert.deepEqual((await latest).history,['e2e4','e7e5','g1f3']);responses[0](reply(state()));assert.equal(await old,null);
 },
 async takeback_keeps_launch_history_and_removes_human_plus_reply(){
  for(const [count,baseline,expected] of [[4,0,2],[3,0,2],[4,2,2],[3,2,2]]){
   const instance=view();instance.session.position=state(count);instance.session.baseline=baseline;instance.session.start={initial_fen:START,history:all.slice(0,baseline).map(move=>move.uci),fen:state(baseline).fen};
   let body;instance.request=async(path,value)=>{body=value;return state(expected);};instance.engineReply=async()=>{};
   await instance.undo();assert.deepEqual(body.history,all.slice(0,expected).map(move=>move.uci));assert.equal(instance.session.position.history.length,expected);
  }
  const black=view();black.session.side='black';black.session.position=state(1);assert.equal(black.canUndo(),false);
  black.session.position=state(2);assert.equal(black.canUndo(),true);
  let body;black.request=async(path,value)=>{body=value;return state(1);};black.engineReply=async()=>{};await black.undo();assert.deepEqual(body.history,['e2e4']);
 },
 snapshots_and_analysis_copies_do_not_share_mutable_state(){
  const instance=view();instance.session.position.doc.id=73;instance.session.position.doc.base_id=8;
  const snapshot=instance.snapshot(),doc=instance.gameDoc();snapshot.session.position.history.pop();snapshot.config.skill=0;doc.nodes[0].children=[];
  assert.equal(instance.session.position.history.length,2);assert.equal(instance.config.skill,10);assert.equal(instance.session.position.doc.nodes[0].children.length,1);
  assert.equal(doc.id,undefined);assert.equal(doc.base_id,undefined);assert.equal(instance.session.position.doc.id,73);
 },
 partial_model_installation_keeps_visible_selection_and_request_consistent(){
  const instance=view();instance.opponents=[{id:'maia',levels:[1100,1200],default_level:1500}];instance.config.provider='maia';
  assert(instance.normalizeSetupStrength());assert.equal(instance.config.level,1100);assert.equal(instance.normalizeSetupStrength(),false);
  instance.config.level=1200;assert.equal(instance.normalizeSetupStrength(),false);assert.equal(instance.config.level,1200);
  instance.opponents[0].levels=[];assert.equal(instance.normalizeSetupStrength(),false);
 },
 maia3_level_range_comes_from_opponent_api(){
  const instance=view();instance.config.provider='maia';instance.opponents=[{id:'maia',levels:Array.from({length:21},(_,i)=>600+i*100),default_level:1500}];
  for(const level of [600,1500,1900,2600]){instance.config.level=level;assert.equal(instance.normalizeSetupStrength(),false);assert.equal(instance.config.level,level);}
  instance.config.level=500;assert.equal(instance.normalizeSetupStrength(),true);assert.equal(instance.config.level,1500);
  instance.opponents[0].levels=[700,800];instance.opponents[0].default_level=800;assert.equal(instance.normalizeSetupStrength(),true);assert.equal(instance.config.level,800);
 },
 async maia3_restores_legacy_games_without_losing_history_or_strength(){
  for(const side of ['white','black']){
   const source=view();source.session.side=side;source.session.config={...source.config,provider:'maia',level:1700};source.session.position=state(side==='white'?2:3);
   const opponent=side==='white'?'Black':'White';source.session.headers[opponent]='Maia 1700';
   const saved=source.snapshot(),original=JSON.stringify(saved),resumed=view();resumed.request=async path=>path==='/opponents'?{engines:[]}:structuredClone(source.session.position);
   await resumed.load(saved);assert.equal(JSON.stringify(saved),original);assert.equal(resumed.session.side,side);assert.equal(resumed.session.config.provider,'maia');assert.equal(resumed.session.config.level,1700);
   assert.deepEqual(resumed.session.position.history,source.session.position.history);assert.equal(resumed.engineName(),'Maia 3 · 1700');assert.equal(resumed.gameDoc().headers[opponent],'Maia 3 · 1700');
   saved.session.headers[opponent]='My named opponent';await resumed.load(saved);assert.equal(resumed.gameDoc().headers[opponent],'My named opponent');
  }
 },
 async restoration_revalidates_position_locked_and_resumes_engine_once(){
  const source=view();source.session.position=state(3);const saved=source.snapshot();
  const instance=view(),calls=[];let engineReplies=0;
  instance.request=async(path,body)=>{calls.push([path,body,instance.busy]);return path==='/opponents'?{engines:[]}:state(3);};
  instance.engineReply=async()=>{engineReplies++;};
  await instance.load(saved);assert.equal(calls[1][0],'/position');assert.equal(calls[1][2],true);assert.equal(engineReplies,1);assert.equal(instance.session.position.history.length,3);
 },
 async navigation_or_availability_failure_during_resume_preserves_game_immediately(){
  const source=view();source.displayPath=source.session.position.path;source.config.provider='maia';const saved=source.snapshot();
  let deliver;globalThis.fetch=async()=>new Promise(resolve=>{deliver=resolve;});
  const instance=view();instance.session=null;instance.mode='setup';const pending=instance.load(saved);
  assert.deepEqual(instance.snapshot(),saved);instance.dispose();deliver(reply({engines:[]}));await pending;assert.deepEqual(instance.snapshot(),saved);
  const failed=view();failed.session=null;failed.mode='setup';globalThis.fetch=async()=>{throw new Error('Connexion interrompue');};
  await failed.load(saved);assert.deepEqual(failed.snapshot(),saved);assert.equal(failed.error,'Connexion interrompue');
 },
 async restored_resignation_stays_finished_and_does_not_restart_engine(){
  const source=view();source.resign();assert.equal(source.session.headers.Result,'0-1');
  const instance=view();instance.request=async path=>path==='/opponents'?{engines:[]}:state(2);
  instance.engineReply=async()=>{throw new Error('Unexpected engine request after resignation');};
  await instance.load(source.snapshot());assert(instance.finished());assert.equal(instance.session.headers.Result,'0-1');assert.equal(instance.status().className,'lost');
 },
 async failed_restore_validation_does_not_leave_game_locked(){
  const source=view(),instance=view();instance.request=async path=>{if(path==='/opponents')return {engines:[]};throw new Error('Connexion interrompue');};
  await instance.load(source.snapshot());assert.equal(instance.busy,false);assert.equal(instance.error,'Connexion interrompue');assert.equal(instance.session.position.history.length,2);assert(instance.humanTurn());
 },
 async pending_engine_response_is_ignored_after_resignation(){
  const instance=view();instance.session.position=state(3);let deliver;
  globalThis.fetch=async()=>new Promise(resolve=>{deliver=resolve;});
  const pending=instance.engineReply();assert(instance.busy);instance.resign();deliver(reply(state(4)));await pending;
  assert(instance.finished());assert.equal(instance.session.position.history.length,3);assert.equal(instance.session.headers.Result,'0-1');
 },
 async computer_first_move_and_completed_positions_do_not_accept_human_moves(){
  const instance=view();instance.session.side='black';instance.session.position=state();let count=0;
  instance.request=async()=>{count++;return state(1);};await instance.humanMove('e2e4');assert.equal(count,0);
  await instance.engineReply();assert.equal(count,1);assert(instance.humanTurn());
  instance.resign();await instance.humanMove('e7e5');await instance.engineReply();assert.equal(count,1);
 },
 async pending_human_move_is_durable_before_network_and_replayed_once(){
  const original=view(),changes=[];original.onChange=snapshot=>changes.push(snapshot);let deliver;
  globalThis.fetch=async()=>new Promise(resolve=>{deliver=resolve;});
  const pending=original.humanMove('g1f3');
  assert.equal(changes.length,1);assert.equal(changes[0].pendingMove,'g1f3');assert.equal(changes[0].session.position.history.length,2);
  const saved=original.snapshot();original.dispose();deliver(reply(state(3)));await pending;
  const resumed=view(),calls=[];resumed.request=async(path,body)=>{calls.push([path,body]);return path==='/opponents'?{engines:[]}:path==='/move'?state(4):body.move?state(3):state(2);};
  await resumed.load(saved);
  assert.deepEqual(calls.map(([path,body])=>[path,body?.move]),[['/opponents',undefined],['/position',undefined],['/position','g1f3'],['/move',undefined]]);
  assert.equal(resumed.pendingMove,null);assert.equal(resumed.session.position.history.length,4);
 },
 async restoration_keeps_move_intent_until_confirmation_and_network_failure(){
  const source=view();source.pendingMove='g1f3';const saved=source.snapshot();
  const resumed=view(),changes=[];resumed.onChange=snapshot=>changes.push(snapshot);
  resumed.request=async(path,body)=>{if(path==='/opponents')return {engines:[]};if(body.move)throw new Error('Offline');return state(2);};
  await resumed.load(saved);
  assert.equal(resumed.pendingMove,'g1f3');assert.equal(resumed.error,'Offline');
  assert(changes.length>=2);assert(changes.every(snapshot=>snapshot.pendingMove==='g1f3'));
  assert.equal(resumed.session.position.history.length,2);
 },
 async rejected_saved_intent_is_cleared_without_engine_request(){
  const source=view();source.pendingMove='a1a8';const resumed=view(),changes=[];
  resumed.onChange=snapshot=>changes.push(snapshot);resumed.request=async(path,body)=>{
   if(path==='/opponents')return {engines:[]};assert.notEqual(path,'/move');
   if(body.move){const error=new Error('Coup illégal');error.status=400;throw error;}return state(2);
  };
  await resumed.load(source.snapshot());assert.equal(resumed.pendingMove,null);assert.equal(changes.at(-1).pendingMove,null);assert.equal(resumed.error,'Coup illégal');
 },
 async old_snapshots_acquire_frozen_config_and_preserve_human_side(){
  const source=view();delete source.session.config;source.config={...source.config,provider:'maia',level:1700,side:'random'};source.session.side='black';
  source.session.position=state(3);const resumed=view();resumed.request=async path=>path==='/opponents'?{engines:[]}:state(3);
  await resumed.load(source.snapshot());assert.equal(resumed.session.config.provider,'maia');assert.equal(resumed.session.config.level,1700);assert.equal(resumed.session.side,'black');assert.equal(resumed.config.side,'random');
  resumed.config.level=1100;assert.equal(resumed.session.config.level,1700);
 },
 async setup_changes_cannot_change_active_engine_or_resumed_strength(){
  const instance=view();instance.session.config={...instance.config,provider:'maia',level:1800};instance.session.position=state(3);
  instance.mode='setup';instance.config={...instance.config,provider:'stockfish',skill:0,side:'black',start:'fen',fen:e4.fen};
  const calls=[];instance.request=async(path,body)=>{calls.push([path,body]);return path==='/move'?state(4):state(3);};
  await instance.resume();assert.equal(instance.mode,'play');assert.equal(instance.session.side,'white');assert.equal(instance.config.provider,'maia');assert.equal(instance.config.level,1800);
  assert.equal(calls[1][1].provider,'maia');assert.equal(calls[1][1].level,1800);assert.equal(instance.engineName(),'Maia 3 · 1800');
  instance.config.provider='stockfish';assert.equal(instance.engineName(),'Maia 3 · 1800');
 },
 async starting_game_freezes_its_own_settings(){
  const instance=view();instance.mode='setup';instance.opponents=[{id:'maia',available:true}];instance.config={...instance.config,provider:'maia',level:1600,side:'black'};
  instance.request=async()=>state();instance.engineReply=async()=>{};await instance.start();
  assert.equal(instance.session.config.provider,'maia');assert.equal(instance.session.config.level,1600);assert.equal(instance.session.headers.White,'Maia 3 · 1600');
  instance.config.level=1900;assert.equal(instance.session.config.level,1600);assert.equal(instance.engineName(),'Maia 3 · 1600');
 },
 async explicit_cancellation_clears_pending_intent_before_undo_restart_or_resign(){
  for(const action of ['undo','restart','resign']){
   const instance=view(),changes=[];instance.pendingMove='g1f3';instance.onChange=snapshot=>changes.push(snapshot);
   instance.request=async()=>state();instance.engineReply=async()=>{};await instance[action]();
   assert.equal(instance.pendingMove,null,action);assert.equal(changes[0].pendingMove,null,action);
  }
 },
};
const name=process.argv[2];assert(cases[name],name);await cases[name]();console.log(name+' passed');
