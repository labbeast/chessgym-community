import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mutateTrainingRun,prepareTrainingReview,readingLaunchTarget,conflictingReview,scopedReviewSnapshot} from '../static/training-plan-launch.js';
import {routeFromHash,routeHash} from '../static/section-navigation.js';
import {startupPreferences,saveStartupPreferences} from '../static/startup-settings.js';
const storage=()=>{const data=new Map();return {get:key=>data.get(key),set:(key,value)=>data.set(key,structuredClone(value)),remove:key=>data.delete(key)};};

test('lost finish response replays the same receipt and original revision before reading',async()=>{
 const store=storage(),writes=[];let reads=0;
 const request=async(url,options)=>{if(!options){reads++;return {revision:4};}writes.push(structuredClone(options.body));if(writes.length===1)throw Error('Disconnected');return {id:'run',state:'completed',revision:5};};
 await assert.rejects(mutateTrainingRun('run','finish',{request,store}),/Disconnected/);
 assert.equal((await mutateTrainingRun('run','finish',{request,store})).state,'completed');
 assert.equal(reads,1);assert.deepEqual(writes[0],writes[1]);assert.equal(writes[0].expected_revision,4);
});

test('finishing a block without randomUUID keeps its UUID receipt across a lost response',async context=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto'),source=globalThis.crypto;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues:bytes=>source.getRandomValues(bytes)}});
 context.after(()=>Object.defineProperty(globalThis,'crypto',original));
 const store=storage(),writes=[];let reads=0;
 const request=async(url,options)=>{
  if(!options){reads++;return {revision:7};}
  writes.push(structuredClone(options.body));
  if(writes.length===1)throw Error('Disconnected');
  return {id:'run',state:'completed',revision:8};
 };
 await assert.rejects(mutateTrainingRun('run','finish',{request,store}),/Disconnected/);
 assert.equal((await mutateTrainingRun('run','finish',{request,store})).state,'completed');
 assert.match(writes[0].mutation_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
 assert.equal(reads,1);assert.deepEqual(writes[0],writes[1]);
});
test('definitive conflict allows a refreshed explicit retry',async()=>{
 const store=storage();let reads=0;
 const request=async(url,options)=>{if(!options)return {revision:++reads};if(reads===1)throw Object.assign(Error('Conflict'),{status:409});return options.body;};
 await assert.rejects(mutateTrainingRun('run','pause',{request,store}),/Conflict/);
 assert.equal((await mutateTrainingRun('run','pause',{request,store})).expected_revision,2);
});
test('resume acknowledges an uncertain pause before applying the opposite action',async()=>{
 const store=storage(),receipts=new Map(),writes=[];let state='active',revision=1,lose=true;
 const request=async(url,options)=>{
  if(!options)return {id:'run',state,revision};
  const body=options.body;writes.push(structuredClone(body));
  if(receipts.has(body.mutation_id))return receipts.get(body.mutation_id);
  assert.equal(body.expected_revision,revision);state=body.action==='pause'?'paused':'active';revision++;
  const result={id:'run',state,revision};receipts.set(body.mutation_id,result);
  if(lose){lose=false;throw Error('Lost reply');}return result;
 };
 await assert.rejects(mutateTrainingRun('run','pause',{request,store}),/Lost reply/);
 assert.equal((await mutateTrainingRun('run','resume',{request,store})).state,'active');
 assert.deepEqual(writes.map(w=>w.action),['pause','pause','resume']);
 assert.equal(writes[0].mutation_id,writes[1].mutation_id);
 assert.equal(store.get('training-run-write:run:pause'),undefined);
 assert.equal((await mutateTrainingRun('run','pause',{request,store})).state,'paused');
 assert.notEqual(writes.at(-1).mutation_id,writes[0].mutation_id);
 assert.equal(state,'paused');
});
test('review launch binds one immutable native receipt and a single resource',async()=>{
 const calls=[],run={id:crypto.randomUUID(),block:{metric:'quantity',unit:'cards',target:6},launch:{base_id:7,minutes:15}};
 const result=await prepareTrainingReview(run,{request:async(url,options)=>{calls.push({url,...options});return url.endsWith('daily-preview')?{total:6}:{session_id:'native'};}});
 assert.equal(result.session_id,'native');assert.deepEqual(calls[1].body.base_ids,[7]);assert.equal(calls[1].body.training_run_id,run.id);assert.equal(calls[1].body.request_id,run.id);assert.equal(calls[1].body.goal.cards,6);
 assert.equal(conflictingReview({session_id:'elsewhere',training_run_id:'other'},run.id),true);
 assert.equal(conflictingReview({session_id:'same',training_run_id:run.id},run.id),false);
});
test('existing native session resumes without another create and empty preview creates nothing',async()=>{
 const paths=[];
 await prepareTrainingReview({native_ref:{id:'saved'}},{request:async path=>{paths.push(path);return {};}});
 assert.deepEqual(paths,['/api/review-sessions/saved?offset=0&limit=100']);
 await assert.rejects(prepareTrainingReview({block:{},launch:{base_id:1}},{request:async path=>{assert(path.endsWith('daily-preview'));return {total:0};}}),/Aucune carte/);
});

test('scoped review creation retains all available exercises and lets the server set the exact goal',async()=>{
 const calls=[],run={id:'period-run',block:{metric:'quantity',unit:'cards',target:20},launch:{base_id:7,goal:{scope:'today',metric:'minutes',remaining:.25}}};
 await prepareTrainingReview(run,{request:async(url,options)=>{calls.push({url,...options});return url.endsWith('daily-preview')?{total:50}:{session_id:'native'};}});
 assert.deepEqual(calls.map(call=>call.body.goal),[{minutes:null,cards:null},{minutes:null,cards:null}]);
 assert.equal(calls[1].body.training_run_id,'period-run');
});

test('scoped review resume changes only the stop goal and preserves the exact attempt and counters',()=>{
 const saved={session_id:'native',cards:[{id:'card'}],index:0,attempt:{ply:2,elapsedMs:1500},completed:4,sessionElapsedMs:120000,goal:{minutes:3,cards:5},goalReached:true,toolbarTargetMs:180000};
 const original=structuredClone(saved),run={launch:{goal:{scope:'week'},review_goal:{minutes:2.25,cards:null}}};
 const resumed=scopedReviewSnapshot(saved,run);
 assert.deepEqual(resumed.goal,{minutes:2.25,cards:null});assert.equal(resumed.toolbarTargetMs,135000);assert.equal(resumed.goalReached,false);
 for(const key of ['session_id','cards','index','attempt','completed','sessionElapsedMs'])assert.deepEqual(resumed[key],saved[key]);
 assert.deepEqual(saved,original);
 const quantity=scopedReviewSnapshot(saved,{launch:{goal:{scope:'today'},review_goal:{minutes:null,cards:11}}});
 assert.equal(quantity.toolbarTargetMs,null);assert.equal(quantity.goal.cards,11);
 assert.equal(scopedReviewSnapshot(saved,{launch:{minutes:15}}),saved);
});
test('reading continuation respects base and bookmark fallback',()=>{
 assert.deepEqual(readingLaunchTarget({bases:[{base_id:2,continue_entry_id:4,continue_path:'0.0'}]},2),{entryId:4,path:'0.0'});
 assert.deepEqual(readingLaunchTarget({bases:[{base_id:2,last_entry_id:5,last_path:'0'}]},2),{entryId:5,path:'0'});
 assert.throws(()=>readingLaunchTarget({bases:[]},2),/indisponible/);
});
test('program tabs and optional startup retain a safe today default',()=>{
 for(const view of ['today','week','program','statistics'])assert.equal(routeFromHash(routeHash({page:'training-plan',view})).view,view);
 assert.equal(routeFromHash('#/training-plan?view=unknown').view,'today');assert.equal(routeFromHash('#/training-plan?view=summary').view,'statistics');
 let raw=null;const local={getItem:()=>raw,setItem:(key,value)=>{raw=value;}};
 saveStartupPreferences({page:'training-plan',resume:'ask'},local);assert.equal(startupPreferences(local).page,'training-plan');
});

 test('free review creation and resumption clear old minute and exercise limits',async()=>{
 const calls=[],run={id:'free-run',block:{metric:'quantity',unit:'cards',target:20,session_minutes:20},launch:{free:true,base_id:7}};
 await prepareTrainingReview(run,{request:async(url,options)=>{calls.push({url,...options});return url.endsWith('daily-preview')?{total:50}:{session_id:'native'};}});
 assert.deepEqual(calls.map(call=>call.body.goal),[{minutes:null,cards:null},{minutes:null,cards:null}]);
 const snapshot={session_id:'native',goal:{minutes:20,cards:10},goalReached:true,toolbarTargetMs:1200000,completed:8};
 const result=scopedReviewSnapshot(snapshot,{launch:{free:true,review_goal:{minutes:null,cards:null}}});
 assert.deepEqual(result.goal,{minutes:null,cards:null});assert.equal(result.goalReached,false);assert.equal(result.toolbarTargetMs,null);assert.equal(result.completed,8);
 });
