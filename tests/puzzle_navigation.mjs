import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';

// Exercise the real navigation methods with deferred network responses. Board
// rendering and dialogs are replaced; their browser behavior has separate tests.
const stubs={
 'training-history.js':`export class TrainingHistoryView{constructor(){}async load(){}dispose(){}};`,
 'api.js':`export const api=(...args)=>globalThis.testApi(...args);export const esc=value=>String(value??'');export const fail=error=>{throw error;};export const modal=()=>{};export const option=()=>'';export const time=value=>String(value);export const notice=()=>{};`,
 'i18n.js':`export const t=value=>value;export const ui=value=>value;export const locale=()=> 'en';`,
 'board.js':`export class Board{};export const makeDoc=()=>({});export const appendLine=()=>({});`,
 'analysis-moves.js':`export const analysisMovesHtml=()=>'';`,
 'sound.js':`export const playSound=()=>{};`,
 'puzzle-feedback.js':`export const puzzleFeedbackHtml=()=>'';export const puzzleResultState=()=>'';export const puzzleResultLabel=()=>'';`,
 'exercise-editor.js':`export const openExerciseEditor=options=>globalThis.testOpenEditor(options);`,
 'storm-results.js':`export const stormResultsHtml=()=>'';`,
};
registerHooks({load(url,context,nextLoad){
 const source=Object.entries(stubs).find(([file])=>url.endsWith('/static/'+file))?.[1];
 return source===undefined?nextLoad(url,context):{format:'module',shortCircuit:true,source};
}});
globalThis.document={createElement:()=>({className:'',innerHTML:''})};
const {PuzzleView}=await import('../static/puzzles.js');
const deferred=()=>{let resolve;const promise=new Promise(yes=>{resolve=yes;});return {promise,resolve};};
const oldAttempt={id:'old-attempt',puzzle_id:'Puzzle1',mode:'storm',session_id:'old-storm',status:'completed',color:'black',rating:1500,events:[{san:'d5',correct:0,elapsed_ms:1000}],pgn:'PGN with wrong branch',solution_pgn:'Exact source PGN'};
const newAttempt={id:'new-attempt',mode:'storm',session_id:'new-storm',status:'active'};
const newStorm={id:'new-storm',status:'active',remaining_ms:180000};
const doc={headers:{PuzzleId:'Puzzle1'},nodes:[{path:'',fen:'source FEN'}]};
let view,shown,events,editors,calls,summaries;
function setup(){
 shown=[];events=[];editors=[];calls=[];summaries=[];
 view=new PuzzleView({querySelector:()=>({append:element=>events.push(element.innerHTML)})});
 view.data={sets:[],profile:{settings:{auto_copy_base_id:3,storm_auto_copy_base_id:8}}};
 view.showingStormResults=true;view.resultSessionId='old-storm';view.storm={id:'old-storm',status:'completed'};
 view.stormResults={attempts:[{id:oldAttempt.id,status:'completed'}]};
 view.showAttempt=function(a){this.attempt=a;shown.push(a.id);};
 view.openStormResults=async id=>{summaries.push(id);};
 globalThis.testOpenEditor=options=>{editors.push(options);return {disposed:false,dialog:{focus(){}}};};
}
function network(handler){globalThis.testApi=(url,options={})=>{calls.push({url,options});return handler(url,options);};}
const restartResponse=()=>({storm:structuredClone(newStorm),attempt:structuredClone(newAttempt)});
function playingStorm({inline=true}={}){
 setup();view.showingStormResults=false;view.tab='play';
 view.attempt={...structuredClone(oldAttempt),status:'active',version:2};
 view.storm={id:'old-storm',status:'active',remaining_ms:120000,inline_next:inline};
}
function transition({failed=false}={}){
 const next={...structuredClone(newAttempt),session_id:'old-storm',version:0,legal:{fen:'next FEN',moves:['e7e5'],game_over:false,result:'*'}};
 return {correct:!failed,attempt:{...structuredClone(oldAttempt),status:failed?'revealed':'completed',failed,copied_entry_id:failed?24:null},next_attempt:next,storm:{id:'old-storm',status:'active',current_attempt:next.id,remaining_ms:110000,inline_next:true}};
}
const tests={
 async bundled_storm_result_displays_only_the_ready_next_attempt(){
  for(const failed of [false,true]){
   playingStorm();const response=transition({failed});
   network((url,options)=>{
    assert.equal(url,'/api/puzzles/attempts/old-attempt/move');
    assert.equal(options.body.advance_storm,true);assert.equal(options.body.version,2);
    assert.equal(options.body.move,'b8c6');assert.ok(options.body.request_id);
    return Promise.resolve(response);
   });
   const started=performance.now();await view.action('move','b8c6');
   assert(performance.now()-started<500,'no artificial feedback delay before the next puzzle');
   assert.deepEqual(shown,['new-attempt'],'the completed puzzle must not flash before the next board');
   assert.equal(view.attempt,response.next_attempt);assert.equal(view.storm.current_attempt,view.attempt.id);
   assert.equal(view.attempt.legal,response.next_attempt.legal);assert.equal(view.busy,false);
   assert.equal(calls.length,1,'the bundled result needs neither /next nor /api/legal');
   const feedback=view.stormLastResultHtml();
   assert.match(feedback,/data-storm-last-result/);assert.match(feedback,failed?/data-state="errors"/:/data-state="success"/);
   assert.match(feedback,failed?/Puzzle précédent : manqué/:/Puzzle précédent : réussi/);
   assert.equal(feedback.includes('Déjà copié'),failed);assert.equal(view.lastStormResult,response.attempt);
  }
 },
 async classic_and_legacy_servers_do_not_request_inline_storm(){
  for(const classic of [false,true]){
   playingStorm({inline:false});if(classic){view.storm=null;view.attempt.mode='classic';}
   network((url,options)=>{assert.equal(options.body.advance_storm,undefined);return Promise.resolve({correct:true,attempt:{...view.attempt,version:3}});});
   await view.action('move','e7e5');assert.equal(calls.length,1);assert.equal(view.attempt.status,'active');
  }
 },
 async legacy_storm_next_runs_without_a_feedback_timeout(){
  playingStorm({inline:false});const response=transition();let requestedNext=false;
  network(url=>{
   if(url==='/api/puzzles/attempts/old-attempt/move')return Promise.resolve({correct:true,attempt:response.attempt,storm:response.storm});
   assert.equal(url,'/api/puzzles/storm/old-storm/next');requestedNext=true;
   return Promise.resolve({storm:response.storm,attempt:response.next_attempt});
  });
  const started=performance.now();await view.action('move','b8c6');
  assert.equal(requestedNext,true);assert(performance.now()-started<500);
  assert.equal(view.attempt.id,'new-attempt');assert.equal(view.lastStormResult.id,'old-attempt');assert.equal(view.busy,false);
 },
 async next_selection_error_does_not_retry_or_create_another_attempt(){
  playingStorm();const response=transition();delete response.next_attempt;
  response.next_error={message:'La sélection a pris trop de temps. Réessaie.'};
  network(()=>Promise.resolve(response));await view.action('move','b8c6');
  assert.deepEqual(shown,['old-attempt']);assert.equal(calls.length,1);assert.equal(view.busy,false);
 },
 async delayed_final_move_cannot_replace_history_or_return(){
  for(const destination of ['history','return']){
   playingStorm();const pending=deferred();network(()=>pending.promise);
   const move=view.action('move','b8c6');assert.equal(view.busy,true);
   view.viewToken++;view.tab=destination==='history'?'history':'play';
   if(destination==='return'){view.attempt=null;view.storm=null;}
   pending.resolve(transition());await move;
   assert.deepEqual(shown,[]);assert.equal(view.tab,destination==='history'?'history':'play');
   assert.equal(view.attempt?.id,destination==='history'?'old-attempt':undefined);
   assert.equal(calls.length,1);assert.equal(view.busy,false);assert.equal(view.lastStormResult,undefined);
  }
 },
 async resume_play_uses_server_current_attempt_after_a_hidden_transition(){
  playingStorm();view.tab='history';const response=transition({failed:true});
  network(url=>{
   if(url==='/api/puzzles/attempts/old-attempt')return Promise.resolve(response.attempt);
   assert.equal(url,'/api/puzzles/storm/old-storm');return Promise.resolve({storm:response.storm,attempt:response.next_attempt});
  });
  await view.resumePlay();assert.deepEqual(shown,['new-attempt']);assert.equal(view.attempt.status,'active');
  assert.equal(view.lastStormResult.id,'old-attempt');assert.equal(view.storm.current_attempt,view.attempt.id);
  assert.equal(calls.length,2,'resuming the server-selected puzzle must not create another one');
 },
 async delayed_resume_cannot_replace_a_new_navigation(){
  playingStorm();const pending=deferred(),restoring=deferred(),response=transition();
  network(url=>{
   if(url==='/api/puzzles/attempts/old-attempt')return Promise.resolve(response.attempt);
   restoring.resolve();return pending.promise;
  });
  const resumed=view.resumePlay();await restoring.promise;view.viewToken++;view.tab='history';
  pending.resolve({storm:response.storm,attempt:response.next_attempt});await resumed;
  assert.deepEqual(shown,[]);assert.equal(view.tab,'history');assert.notEqual(view.attempt.id,'new-attempt');
 },
 async late_review_cannot_replace_storm_before_or_after_restart_response(){
  for(const restartFirst of [false,true]){
   setup();const review=deferred(),restart=deferred();
   network(url=>url==='/api/puzzles/attempts/old-attempt'?review.promise:restart.promise);
   const old=view.openHistory('old-attempt',{stormResultsId:'old-storm'});
   const fresh=view.startStorm();
   if(restartFirst){restart.resolve(restartResponse());await fresh;}
   review.resolve(structuredClone(oldAttempt));await old;
   assert.deepEqual(shown,restartFirst?['new-attempt']:[]);
   if(!restartFirst){restart.resolve(restartResponse());await fresh;}
   assert.equal(view.attempt.id,'new-attempt');assert.equal(view.storm.id,'new-storm');
   assert.equal(view.reviewingStormId,null);assert.deepEqual(events,[]);
  }
 },
 async late_review_cannot_replace_new_classic_puzzle(){
  setup();const review=deferred();
  network(url=>url==='/api/puzzles/attempts/old-attempt'?review.promise:Promise.resolve({id:'new-classic',mode:'classic',status:'active'}));
  const pending=view.openHistory('old-attempt',{stormResultsId:'old-storm'});await view.start();
  review.resolve(structuredClone(oldAttempt));await pending;
  assert.deepEqual(shown,['new-classic']);assert.equal(view.storm,null);assert.equal(view.reviewingStormId,null);
 },
 async late_exercise_lookup_cannot_open_after_restart(){
  setup();const detail=deferred(),button={disabled:false,isConnected:true};
  network(url=>{
   if(url==='/api/puzzles/attempts/old-attempt')return detail.promise;
   if(url==='/api/puzzles/storm')return Promise.resolve(restartResponse());
   if(url==='/api/library')return Promise.resolve({bases:[]});
   if(url==='/api/board')return Promise.resolve(doc);
   throw Error('Unexpected URL '+url);
  });
  const pending=view.createExercise('old-attempt',button);assert.equal(button.disabled,true);
  await view.startStorm();detail.resolve(structuredClone(oldAttempt));await pending;
  assert.equal(editors.length,0);assert.equal(button.disabled,false);assert.equal(view.creatingExercise,false);
  assert.equal(view.attempt.id,'new-attempt');
 },
 async late_exercise_parse_cannot_open_while_restart_request_is_pending(){
  setup();const parsed=deferred(),parsing=deferred(),restart=deferred();
  network(url=>{
   if(url==='/api/puzzles/attempts/old-attempt')return Promise.resolve(structuredClone(oldAttempt));
   if(url==='/api/library')return Promise.resolve({bases:[]});
   if(url==='/api/board'){parsing.resolve();return parsed.promise;}
   if(url==='/api/puzzles/storm')return restart.promise;
   throw Error('Unexpected URL '+url);
  });
  const editor=view.createExercise('old-attempt');await parsing.promise;
  const fresh=view.startStorm();parsed.resolve(doc);await editor;
  assert.equal(editors.length,0,'the new navigation intent invalidates the editor before its request finishes');
  restart.resolve(restartResponse());await fresh;assert.equal(view.attempt.id,'new-attempt');
 },
 async active_storm_history_restores_clock_context_and_keeps_events(){
  setup();const active={...structuredClone(oldAttempt),status:'active'};
  network(url=>url.startsWith('/api/puzzles/attempts/')?Promise.resolve(active):Promise.resolve({storm:{id:'old-storm',status:'active',remaining_ms:120000},attempt:{id:active.id,mode:'storm',session_id:'old-storm',status:'active'}}));
  await view.openHistory(active.id);
  assert.equal(view.storm.id,'old-storm');assert.equal(view.storm.remaining_ms,120000);assert.ok(view.stormReceived>0);
  assert.deepEqual(shown,[active.id]);assert.deepEqual(view.attempt.events,active.events);assert.match(events[0],/d5/);
 },
 async history_restores_different_current_attempt_with_its_own_events(){
  setup();const old={...structuredClone(oldAttempt),status:'active'},current={...structuredClone(oldAttempt),id:'current-attempt',status:'active',events:[{san:'Nf3',correct:1,elapsed_ms:2000}]};
  network(url=>{
   if(url==='/api/puzzles/attempts/old-attempt')return Promise.resolve(old);
   if(url==='/api/puzzles/attempts/current-attempt')return Promise.resolve(current);
   return Promise.resolve({storm:{id:'old-storm',status:'active',remaining_ms:100000},attempt:{id:'current-attempt',status:'active'}});
  });
  await view.openHistory(old.id);
  assert.deepEqual(shown,['current-attempt']);assert.match(events[0],/Nf3/);assert.ok(!events[0].includes('d5'));
 },
 async history_detects_expired_storm_and_opens_results(){
  setup();
  network(url=>url.startsWith('/api/puzzles/attempts/')?Promise.resolve({...structuredClone(oldAttempt),status:'active'}):Promise.resolve({storm:{id:'old-storm',status:'completed'},attempt:{id:'old-attempt',status:'expired'}}));
  await view.openHistory('old-attempt');assert.deepEqual(summaries,['old-storm']);assert.deepEqual(shown,[]);
 },
 async late_storm_restore_cannot_replace_restarted_session(){
  setup();const session=deferred(),restoring=deferred();
  network(url=>{
   if(url==='/api/puzzles/attempts/old-attempt')return Promise.resolve({...structuredClone(oldAttempt),status:'active'});
   if(url==='/api/puzzles/storm/old-storm'){restoring.resolve();return session.promise;}
   if(url==='/api/puzzles/storm')return Promise.resolve(restartResponse());
   throw Error('Unexpected URL '+url);
  });
  const old=view.openHistory('old-attempt');await restoring.promise;await view.startStorm();
  session.resolve({storm:{id:'old-storm',status:'active'},attempt:{id:'old-attempt',status:'active'}});await old;
  assert.deepEqual(shown,['new-attempt']);assert.equal(view.storm.id,'new-storm');
 },
 async exercise_uses_source_solution_and_keeps_the_result_unchanged(){
  setup();const original=JSON.stringify(oldAttempt);
  network((url,options)=>{
   if(url==='/api/puzzles/attempts/old-attempt')return Promise.resolve(oldAttempt);
   if(url==='/api/library')return Promise.resolve({bases:[{id:8,name:'Storm exercises'}]});
   if(url==='/api/board'){assert.equal(options.body.pgn,oldAttempt.solution_pgn);return Promise.resolve(doc);}
   throw Error('Unexpected URL '+url);
  });
  await view.createExercise('old-attempt');assert.equal(editors.length,1);
  assert.equal(editors[0].sourceDoc,doc);assert.equal(editors[0].initialDoc,doc);assert.equal(editors[0].sourcePath,'');
  assert.equal(editors[0].baseId,8);assert.equal(editors[0].flipped,true);assert.equal(JSON.stringify(oldAttempt),original);
  assert.equal(view.showingStormResults,true);assert.equal(view.storm.id,'old-storm');
  assert.ok(calls.every(call=>!call.url.startsWith('/api/entries')),'opening a draft must not save it');
 },
};
const scenario=process.argv[2];assert.ok(tests[scenario],'Unknown scenario '+scenario);
await tests[scenario]();console.log('ok '+scenario);
