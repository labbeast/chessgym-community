import assert from 'node:assert/strict';
import {cachedAnalysis,clearAnalysisCache,streamAnalysis,ANALYSIS_SETTINGS,applyAnalysisEngine,refreshAnalysisEngine,analysisEngineName} from '../static/engine-analysis.js';
const fen='8/8/8/8/8/8/4k3/6K1 w - - 0 1',line={cp:25,mate:null,depth:12,pv:['g1h1'],san:['Kh1']};
const event=(type='done',extra={})=>({type,fen,engine:'Stockfish',lines:[line],...extra});
function mockChunks(chunks){globalThis.fetch=async()=>({ok:true,body:new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(typeof chunk==='string'?new TextEncoder().encode(chunk):chunk);controller.close();}})});}
const cases={
 async changing_engine_invalidates_completed_and_inflight_analysis(){
  applyAnalysisEngine({name:'First engine',identity:'first'});mockChunks([JSON.stringify(event())]);await streamAnalysis(fen);assert.ok(cachedAnalysis(fen));
  applyAnalysisEngine({name:'Second engine',identity:'second'});assert.equal(cachedAnalysis(fen),null);assert.equal(analysisEngineName(),'Second engine');
  let deliver;globalThis.fetch=async()=>({ok:true,body:{getReader(){return {read:()=>new Promise(resolve=>{deliver=resolve;}),cancel:async()=>{},releaseLock(){}};}}});let count=0;
  const pending=streamAnalysis(fen,{onUpdate:()=>count++});for(let n=0;n<5;n++)await Promise.resolve();
  applyAnalysisEngine({name:'Third engine',identity:'third'});deliver({done:false,value:new TextEncoder().encode(JSON.stringify(event())+'\n')});await assert.rejects(pending,{name:'AbortError'});assert.equal(count,0);assert.equal(cachedAnalysis(fen),null);
 },
 async engine_status_refresh_preserves_cache_unless_identity_changed(){
  const clock=Date.now;let now=10000;Date.now=()=>now;
  try{applyAnalysisEngine({name:'First engine',identity:'first'});mockChunks([JSON.stringify(event())]);await streamAnalysis(fen);let calls=0;
   globalThis.fetch=async(url)=>{calls++;assert.equal(url,'/api/engine/status');return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({name:'First engine',identity:'first'})};};
   assert.equal(await refreshAnalysisEngine(),false);assert.equal(calls,0);now+=5000;assert.equal(await refreshAnalysisEngine(),false);assert.ok(cachedAnalysis(fen));assert.equal(calls,1);
   now+=5000;globalThis.fetch=async()=>({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({name:'Next engine',identity:'next'})});assert.equal(await refreshAnalysisEngine(),true);assert.equal(cachedAnalysis(fen),null);
  }finally{Date.now=clock;applyAnalysisEngine({name:'Stockfish',identity:null});}
 },
 async chunks_utf8_and_final_line_without_newline(){
  const bytes=new TextEncoder().encode(JSON.stringify(event('info',{engine:'Moteur évalué'}))+'\n'+JSON.stringify(event()));const chunks=[];for(let i=0;i<bytes.length;i+=7)chunks.push(bytes.slice(i,i+7));mockChunks(chunks);const received=[];await streamAnalysis(fen,{onUpdate:(result,type)=>received.push({result,type})});assert.deepEqual(received.map(x=>x.type),['info','done']);assert.equal(received[0].result.engine,'Moteur évalué');assert.deepEqual(cachedAnalysis(fen).lines,[line]);
 },
 async only_completed_results_cache_and_mutations_are_isolated(){
  mockChunks([JSON.stringify(event('info'))+'\n']);await assert.rejects(streamAnalysis(fen),/interrompue/);assert.equal(cachedAnalysis(fen),null);
  mockChunks([JSON.stringify(event())]);await streamAnalysis(fen,{onUpdate:result=>{result.lines[0].positionRequest=Promise.resolve();result.lines[0].cp=900;}});assert.equal(cachedAnalysis(fen).lines[0].cp,25);const result=cachedAnalysis(fen);result.lines[0].pv.push('h1h2');assert.deepEqual(cachedAnalysis(fen).lines[0].pv,['g1h1']);
 },
 async cache_is_bounded_expires_and_keys_full_fen_settings(){
  const clock=Date.now;let now=1000;Date.now=()=>now;
  try{mockChunks([JSON.stringify(event())]);await streamAnalysis(fen);assert.equal(cachedAnalysis(fen.replace('0 1','1 1')),null);assert.equal(cachedAnalysis(fen,{...ANALYSIS_SETTINGS,time_ms:500}),null);assert.equal(cachedAnalysis(fen,{...ANALYSIS_SETTINGS,multipv:1}),null);now+=300000;assert.equal(cachedAnalysis(fen),null);
   for(let n=0;n<129;n++){const position=fen.replace('0 1','0 '+(n+1));mockChunks([JSON.stringify(event('done',{fen:position}))]);await streamAnalysis(position);}
   assert.equal(cachedAnalysis(fen),null);assert.ok(cachedAnalysis(fen.replace('0 1','0 129')));
  }finally{Date.now=clock;}
 },
 async rejects_wrong_positions_malformed_events_and_server_errors(){
  for(const [text,pattern] of [[JSON.stringify(event('done',{fen:'wrong'})),/correspond/],['{oops',/illisible/],[JSON.stringify(event('other')),/correspond/],[JSON.stringify({type:'error',detail:'Moteur occupé'}),/Moteur occupé/]]){mockChunks([text]);await assert.rejects(streamAnalysis(fen),pattern);assert.equal(cachedAnalysis(fen),null);}
  globalThis.fetch=async()=>({ok:false,status:422,json:async()=>({detail:'FEN invalide'})});await assert.rejects(streamAnalysis(fen),/FEN invalide/);
 },
 async abort_does_not_store_or_publish_late_result(){
  const controller=new AbortController();let deliver;globalThis.fetch=async()=>({ok:true,body:{getReader(){return {read:()=>new Promise(resolve=>{deliver=resolve;}),cancel:async()=>{},releaseLock(){}};}}});let count=0;const pending=streamAnalysis(fen,{signal:controller.signal,onUpdate:()=>count++});for(let n=0;n<5;n++)await Promise.resolve();controller.abort();deliver({done:false,value:new TextEncoder().encode(JSON.stringify(event())+'\n')});await assert.rejects(pending,{name:'AbortError'});assert.equal(count,0);assert.equal(cachedAnalysis(fen),null);
 },
 async credentials_refresh_and_terminal_empty_result(){
  let options;globalThis.fetch=async(url,request)=>{assert.equal(url,'/api/engine/analyse/stream');options=request;return {ok:true,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify(event('done',{lines:[]}))+'\n'));controller.close();}})};};
  await streamAnalysis(fen,{refresh:true});assert.equal(options.credentials,'same-origin');assert.deepEqual(JSON.parse(options.body),{fen,...ANALYSIS_SETTINGS,refresh:true});assert.deepEqual(cachedAnalysis(fen).lines,[]);
 }
};
const name=process.argv[2];clearAnalysisCache();assert.ok(cases[name]);await cases[name]();console.log(name+' passed');
