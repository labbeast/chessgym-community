import assert from 'node:assert/strict';
import {ComputerHistoryStore} from '../static/computer-history-store.js';
import {makeDoc,appendLine} from '../static/chess-document.js';
import {START} from '../static/api.js';
import {newClock} from '../static/computer-clock.js';
const moves=[{uci:'e2e4',san:'e4',fen:'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'},{uci:'e7e5',san:'e5',fen:'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKB1R w KQkq - 0 2'}];
function game(id='game-one',plies=0){
 const {doc,path}=appendLine(makeDoc(),'',moves.slice(0,plies));return {version:1,mode:'play',config:{provider:'stockfish'},origin:null,displayPath:path,pendingMove:'g1f3',session:{id,side:'white',baseline:0,config:{provider:'stockfish'},headers:{Result:'*'},resigned:false,position:{initial_fen:START,fen:doc.nodes.at(-1).fen,history:moves.slice(0,plies).map(m=>m.uci),doc,path}}};
}
function storage(){const values=new Map();return {values,getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};}
const stores=[];
function store(options){const value=new ComputerHistoryStore({delay:100000,clockDelay:100000,...options});stores.push(value);return value;}
const networkError=(status=503)=>Object.assign(new Error('Offline'),{status});
const cases={
 async untimed_pause_and_resume_are_persisted_without_a_move_or_duration_change(){
  const disk=storage(),writes=[],scheduled=[],value=store({storage:disk,request:async(path,{body})=>{writes.push(structuredClone(body));return {revision:writes.length+1};}});value.open('owner');
  const original=game('first',2);original.session.activity={version:1,elapsed_ms:2500};value.adopt({id:'first',revision:1,snapshot:original});value.schedule=delay=>scheduled.push(delay);
  const paused=structuredClone(original);paused.session.paused=true;value.record(paused);assert.equal(value.info('first').pending,true);assert.equal(scheduled.at(-1),value.delay);
  const outbox=JSON.parse(disk.getItem(value.prefix));assert.equal(outbox.records.first.pending.session.paused,true);
  await value.flush();assert.equal(writes[0].snapshot.session.paused,true);assert.equal(writes[0].snapshot.session.activity.elapsed_ms,2500);
  const resumed=structuredClone(paused);resumed.session.paused=false;value.record(resumed);assert.equal(value.info('first').pending,true);assert.equal(scheduled.at(-1),value.delay);await value.flush();
  assert.equal(writes.length,2);assert.equal(writes[1].snapshot.session.paused,false);assert.deepEqual(writes[1].snapshot.session.position.history,original.session.position.history);assert.equal(writes[1].snapshot.session.activity.elapsed_ms,2500);
 },
 async same_untimed_position_retains_explicit_pause_from_either_device(){
  for(const pausedSide of ['local','remote']){
   const local=game('first',2),remote=game('first',2);(pausedSide==='local'?local:remote).session.paused=true;
   const beforeLocal=structuredClone(local),beforeRemote=structuredClone(remote),value=store({storage:storage(),request:async()=>({id:'first',revision:4,snapshot:remote})});value.open('owner');
   const resumed=await value.prepare(local);assert.equal(resumed.session.paused,true);assert.deepEqual(local,beforeLocal);assert.deepEqual(remote,beforeRemote);
  }
 },
 async active_duration_ticks_are_persisted_and_cross_device_resume_keeps_the_larger_measurement(){
  const local=game('first',2),remote=game('first',2);local.session.activity={version:1,elapsed_ms:1500};remote.session.activity={version:1,elapsed_ms:3400};
  const value=store({storage:storage(),request:async()=>({id:'first',revision:4,snapshot:remote})});value.open('owner');const resumed=await value.prepare(local);assert.equal(resumed.session.activity.elapsed_ms,3400);assert.equal(local.session.activity.elapsed_ms,1500);
  value.record(resumed);assert.equal(value.records.get('first').pending,undefined);resumed.session.activity.elapsed_ms=4500;value.record(resumed);assert.equal(value.records.get('first').pending.session.activity.elapsed_ms,4500);assert.equal(value.records.get('first').revision,4);
 },
 async newer_remote_game_never_discards_already_measured_active_time(){
  const local=game('first',1),remote=game('first',2);local.session.activity={version:1,elapsed_ms:15000};remote.session.activity={version:1,elapsed_ms:3000};
  const value=store({storage:storage(),request:async()=>({id:'first',revision:3,snapshot:remote})});value.open('owner');const resumed=await value.prepare(local);assert.equal(resumed.session.position.history.length,2);assert.equal(resumed.session.activity.elapsed_ms,15000);assert.equal(remote.session.activity.elapsed_ms,3000);
 },
 async same_history_clock_merge_never_returns_time_and_reconciles_takeback_checkpoints(){
  const local=game('first',2),remote=game('first',2);local.session.clock=newClock({time_control:'5+0'});remote.session.clock=newClock({time_control:'5+0'});
  local.session.clock.remaining={white:295000,black:298000};remote.session.clock.remaining={white:297000,black:290000};
  local.session.clock.history.push({ply:1,remaining:{white:298000,black:300000}},{ply:2,remaining:{white:298000,black:298000}});
  remote.session.clock.history.push({ply:1,remaining:{white:297000,black:300000}},{ply:2,remaining:{white:297000,black:290000}});
  local.session.clock.paused=false;local.session.clock.running='white';const original=structuredClone(local),remoteOriginal=structuredClone(remote);
  const value=store({storage:storage(),request:async()=>({id:'first',revision:9,snapshot:remote})});value.open('owner');const resumed=await value.prepare(local);
  assert.deepEqual(resumed.session.clock.remaining,{white:295000,black:290000});assert.deepEqual(resumed.session.clock.history.map(item=>item.ply),[0,1,2]);assert.deepEqual(resumed.session.clock.history[1].remaining,{white:297000,black:300000});assert.deepEqual(resumed.session.clock.history[2].remaining,{white:297000,black:290000});assert(resumed.session.clock.paused);assert.equal(resumed.session.clock.running,null);assert.deepEqual(local,original);assert.deepEqual(remote,remoteOriginal);
 },
 async different_clock_settings_or_engine_config_refuse_automatic_merging(){
  for(const variation of ['initial','increment','untimed','engine']){
   const local=game('first',2),remote=game('first',2);local.session.clock=newClock({time_control:'5+0'});remote.session.clock=newClock({time_control:'5+0'});
   if(variation==='initial')remote.session.clock.initial_ms=600000;if(variation==='increment')remote.session.clock.increment_ms=1000;if(variation==='untimed')remote.session.clock=null;if(variation==='engine')remote.session.config.provider='maia';
   const value=store({storage:storage(),request:async()=>({id:'first',revision:4,snapshot:remote})});value.open('owner');await assert.rejects(value.prepare(local),/suites différentes/);assert(value.info('first').conflict);assert.deepEqual(value.records.get('first').pending.session.clock.remaining,local.session.clock.remaining);
  }
 },
 async terminal_remote_prefix_cannot_be_overwritten_by_longer_local_history(){
  for(const termination of ['resigned','timeout']){
   const local=game('first',2),remote=game('first',1);remote.session[termination]=termination==='resigned'?true:'black';remote.session.headers.Result='1-0';
   const value=store({storage:storage(),request:async()=>({id:'first',revision:11,snapshot:remote})});value.open('owner');await assert.rejects(value.prepare(local),/suites différentes/);assert(value.info('first').conflict);assert.equal(value.records.get('first').pending.session.position.history.length,2);assert.equal(remote.session.position.history.length,1);assert.equal(remote.session.headers.Result,'1-0');
  }
 },
 async prepare_absent_game_seeds_revision_zero_without_overwriting_local(){
  const requests=[],value=store({storage:storage(),request:async(path,options)=>{requests.push(options);if(!options.method)throw Object.assign(new Error('Not found'),{status:404});return {revision:1};}});value.open('owner');const local=game('first',1),original=structuredClone(local);
  assert.equal(await value.prepare(local),local);assert.equal(value.records.get('first').revision,0);assert.deepEqual(local,original);value.record(local);await value.flush();assert.equal(requests[1].body.expected_revision,0);
 },
 async prepare_same_or_older_server_history_adopts_revision_and_keeps_local(){
  for(const plies of [1,2]){
   const requests=[],remote=game('first',plies),local=game('first',2);remote.session.headers.Event='Canonical headers';const document={id:'first',revision:7,snapshot:remote};
   const value=store({storage:storage(),request:async(path,options)=>{requests.push(options);return options.method?{revision:8}:structuredClone(document);}});value.open('owner');assert.equal(await value.prepare(local),local);assert.equal(value.records.get('first').revision,7);
   value.record(local);await value.flush();assert.equal(requests[1].body.expected_revision,7);assert.equal(requests[1].body.snapshot.session.position.history.length,2);assert.equal(local.session.headers.Event,undefined);
  }
 },
 async prepare_newer_server_continuation_restores_it_without_mutating_either_copy(){
  const local=game('first'),remote=game('first',2),before=structuredClone(remote);remote.pendingMove=null;before.pendingMove=null;
  const value=store({storage:storage(),request:async()=>({id:'first',revision:4,snapshot:remote})});value.open('owner');const resumed=await value.prepare(local);
  assert.equal(resumed.session.position.history.length,2);assert.equal(resumed.pendingMove,null);assert.equal(local.session.position.history.length,0);resumed.session.headers.Event='Edited';assert.deepEqual(remote,before);assert.equal(value.records.get('first').revision,4);
 },
 async prepare_divergent_histories_preserves_local_and_refuses_any_write(){
  const local=game('first',1),remote=game('first',1);remote.session.position.history=['d2d4'];let calls=0;
  const value=store({storage:storage(),request:async()=>{calls++;return {id:'first',revision:5,snapshot:remote};}});value.open('owner');await assert.rejects(value.prepare(local),/suites différentes/);assert(value.info('first').conflict);assert.deepEqual(value.records.get('first').pending.session.position.history,['e2e4']);await value.flush();assert.equal(calls,1);assert.deepEqual(remote.session.position.history,['d2d4']);
 },
 async prepare_terminal_server_result_is_not_reopened_with_identical_moves(){
  const local=game('first',1),remote=game('first',1);remote.session.resigned=true;remote.session.headers.Result='0-1';
  const value=store({storage:storage(),request:async()=>({id:'first',revision:8,snapshot:remote})});value.open('owner');const resumed=await value.prepare(local);assert(resumed.session.resigned);assert.equal(resumed.session.headers.Result,'0-1');assert(!local.session.resigned);
  const waiting=game('first',1);waiting.session.timeout='white';const flagged=store({storage:storage(),request:async()=>({id:'first',revision:8,snapshot:remote})});flagged.open('owner');assert.equal((await flagged.prepare(waiting)).session.headers.Result,'0-1');
  const other=store({storage:storage(),request:async()=>({id:'first',revision:8,snapshot:remote})});other.open('owner');local.session.resigned=true;local.session.headers.Result='1-0';await assert.rejects(other.prepare(local),/suites différentes/);
 },
 async prepare_known_records_skip_fetch_and_late_responses_cannot_cross_accounts(){
  const value=store({storage:storage(),request:async()=>{throw Error('Known local game must not refetch');}});value.open('owner');const local=game('first',1);value.record(local);assert.equal(await value.prepare(local),local);
  let deliver;const pendingStore=store({storage:storage(),request:async()=>new Promise(resolve=>{deliver=resolve;})});pendingStore.open('alice');const pending=pendingStore.prepare(local);pendingStore.open('bob');deliver({id:'first',revision:90,snapshot:local});await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(pendingStore.records.size,0);
 },
 async adopt_cannot_discard_pending_or_conflicted_local_games(){
  const local=game('first',2),remote=game('first',1),document={id:'first',revision:5,snapshot:remote};const value=store({storage:storage(),request:async()=>({revision:6})});value.open('owner');value.record(local);await assert.rejects(async()=>value.adopt(document),/copie locale/);assert.equal(value.records.get('first').pending.session.position.history.length,2);
  await value.flush();assert.equal(value.adopt({...document,revision:7,snapshot:local}),true);assert.equal(value.records.get('first').revision,7);
  value.records.get('first').conflict=true;assert.throws(()=>value.adopt(document),/copie locale/);assert.equal(value.records.get('first').revision,7);
 },
 async targeted_archive_rearms_other_games_without_retrying_failures_forever(){
  const sent=[],value=store({storage:storage(),request:async(path)=>{sent.push(path);if(path.endsWith('/first'))throw networkError();return {revision:1};}});value.open('owner');value.record(game('first',1));value.record(game('second',2));await value.flush('second');assert(value.info('first').pending);assert(value.timer!==null);assert.equal(sent.length,1);
  await value.flush();assert.equal(sent.length,2);assert.equal(value.timer,null);assert(value.info('first').pending);
 },
 async insecure_lan_context_still_generates_valid_idempotency_ids(){
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');Object.defineProperty(globalThis,'crypto',{configurable:true,value:undefined});
  try{let body;const value=store({storage:storage(),request:async(path,options)=>{body=options.body;return {revision:1};}});value.open('owner');value.record(game());await value.flush();assert.match(body.mutation_id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert(!value.info('game-one').pending);}
  finally{if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete globalThis.crypto;}
 },
 async unsent_games_survive_close_and_new_games_without_unconfirmed_intent(){
  const disk=storage(),first=store({storage:disk,request:async()=>{throw networkError();}});first.open('owner');
  const a=game('first',1);first.record(a);await first.flush();first.record(game('second',2));a.session.position.history.push('a1a8');first.close();
  const sent=[],second=store({storage:disk,request:async(path,{body})=>{sent.push([path,structuredClone(body)]);return {revision:1};}});second.open('owner');assert.equal(second.records.size,2);await second.flush();
  assert.equal(sent.length,2);assert.deepEqual(sent[0][1].snapshot.session.position.history,['e2e4']);assert.deepEqual(sent[1][1].snapshot.session.position.history,['e2e4','e7e5']);assert(sent.every(([,body])=>body.snapshot.pendingMove===null));assert(!second.info('first').pending);assert(!second.info('second').pending);
 },
 async lost_response_retries_the_same_immutable_mutation_before_newer_position(){
  const disk=storage(),requests=[];let failFirst;
  const value=store({storage:disk,request:async(path,{body})=>{requests.push(structuredClone(body));if(requests.length===1)return new Promise((resolve,reject)=>{failFirst=reject;});return {revision:requests.length-1};}});value.open('owner');value.record(game('first',0));
  const pending=value.flush();await new Promise(resolve=>setImmediate(resolve));value.record(game('first',2));failFirst(networkError());await pending;
  assert(value.info('first').pending);await value.flush();assert.equal(requests.length,3);assert.deepEqual(requests[0],requests[1]);assert.equal(requests[2].expected_revision,1);assert.notEqual(requests[2].mutation_id,requests[1].mutation_id);assert.equal(requests[2].snapshot.session.position.history.length,2);assert(!value.info('first').pending);
 },
 async in_flight_mutation_is_recovered_after_a_closed_browser(){
  const disk=storage();let resolveOld,firstBody;
  const first=store({storage:disk,request:async(path,{body})=>{firstBody=structuredClone(body);return new Promise(resolve=>{resolveOld=resolve;});}});first.open('owner');first.record(game('first',1));const pending=first.flush();await new Promise(resolve=>setImmediate(resolve));first.record(game('first',2));first.close();
  const requests=[],second=store({storage:disk,request:async(path,{body})=>{requests.push(structuredClone(body));return {revision:requests.length};}});second.open('owner');await second.flush();resolveOld({revision:1234});await pending;
  assert.deepEqual(requests[0],firstBody);assert.equal(requests[1].expected_revision,1);assert.equal(requests[1].snapshot.session.position.history.length,2);assert.equal(second.records.get('first').revision,2);
 },
 async compare_and_swap_conflicts_keep_local_game_and_block_replacement(){
  let count=0;const disk=storage(),value=store({storage:disk,request:async()=>{count++;throw Object.assign(new Error('Conflict'),{status:409});}});value.open('owner');const snapshot=game('first',2);
  await assert.rejects(value.archive(snapshot),/Conflict/);assert(value.info('first').pending);assert(value.info('first').conflict);assert.equal(value.records.get('first').pending.session.position.history.length,2);
  await value.flush();assert.equal(count,1);value.close();const reopened=store({storage:disk,request:async()=>{throw Error('Must not overwrite a conflict');}});reopened.open('owner');assert(reopened.info('first').conflict);await assert.rejects(reopened.archive(snapshot),/Conflict/);
 },
 async accounts_and_restore_namespaces_do_not_share_outboxes_or_late_acks(){
  const disk=storage(),sent=[];let oldReply;
  const value=store({storage:disk,request:async(path,{body})=>{sent.push(body);return new Promise(resolve=>{oldReply=resolve;});}});value.open('alice',{namespace:'a'});value.record(game('alice-game',1));const pending=value.flush();await new Promise(resolve=>setImmediate(resolve));value.open('bob',{namespace:'a'});assert.equal(value.records.size,0);value.record(game('bob-game',2));oldReply({revision:99});await pending;assert.equal(value.records.get('bob-game').revision,0);assert(!value.records.has('alice-game'));
  value.open('alice',{namespace:'restored'});assert.equal(value.records.size,0);value.open('alice',{namespace:'a'});assert(value.records.has('alice-game'));assert(!value.records.has('bob-game'));assert.equal(value.records.get('alice-game').revision,0);
 },
 async tick_coalescing_does_not_delay_move_or_final_result(){
  const realNow=Date.now,realSet=setTimeout,realClear=clearTimeout;let now=1000,next=0;const pending=new Map();
  Date.now=()=>now;globalThis.setTimeout=(callback,delay)=>{const id=++next;pending.set(id,{callback,due:now+delay});return id;};globalThis.clearTimeout=id=>pending.delete(id);
  try{
   let revision=0;const value=store({storage:storage(),request:async()=>({revision:++revision}),delay:400,clockDelay:10000});value.open('owner');const initial=game();initial.session.clock=newClock({time_control:'5+0'});initial.session.clock.paused=false;initial.session.clock.running='white';value.record(initial);await value.flush();
   now+=1000;const tick=structuredClone(initial);tick.session.clock.remaining.white-=1000;value.record(tick);assert.equal(value.timerDue,now+10000);const timer=value.timer;
   now+=1000;tick.session.clock.remaining.white-=1000;value.record(tick);assert.equal(value.timer,timer);
   const move=game('game-one',1);move.session.clock=structuredClone(tick.session.clock);move.session.clock.running='black';value.record(move);assert.equal(value.timerDue,now+400);await value.flush();
   now+=1000;move.session.clock.remaining.black-=1000;value.record(move);assert.equal(value.timerDue,now+10000);
   move.session.resigned=true;move.session.headers.Result='0-1';value.record(move);assert.equal(value.timerDue,now+400);await value.flush();assert.equal(revision,3);
  }finally{for(const value of stores)value.close();Date.now=realNow;globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
 },
 async unavailable_storage_reports_error_and_network_failure_preserves_memory(){
  const disk={getItem:()=>null,setItem:()=>{throw new Error('Quota exceeded');}},value=store({storage:disk,request:async()=>{throw networkError();}});value.open('owner');value.record(game());assert.equal(value.info('game-one').error,'Quota exceeded');
  await assert.rejects(value.archive(game()),/Offline/);assert(value.info('game-one').pending);assert.equal(value.records.get('game-one').pending.session.id,'game-one');
 },
 async corrupt_local_storage_is_preserved_and_blocks_replacement(){
  const disk=storage();disk.values.set('chessgym-computer-history-v1:owner:initial','invalid json');const value=store({storage:disk,request:async()=>{throw Error('Must not write corrupt local state');}});value.open('owner');assert(value.corrupt);
  await assert.rejects(value.archive(game()),/illisible/);assert.equal(disk.values.get(value.prefix),'invalid json');assert(value.info('game-one').pending);
 },
 async duplicate_snapshots_do_not_create_new_mutations(){
  let count=0;const value=store({storage:storage(),request:async()=>({revision:++count})});value.open('owner');const snapshot=game();value.record(snapshot);await value.flush();value.record(snapshot);await value.flush();assert.equal(count,1);
  snapshot.displayPath='0';snapshot.pendingMove='a1a8';value.record(snapshot);await value.flush();assert.equal(count,1);
 },
};
const scenario=process.argv[2];assert(cases[scenario]);try{await cases[scenario]();console.log(scenario+' passed');}finally{for(const value of stores)value.close();}
