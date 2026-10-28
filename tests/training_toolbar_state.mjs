import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeToolbarState,programToolbarState} from '../static/training-toolbar-state.js';
import {ComputerActivity,newComputerActivity} from '../static/computer-activity.js';
import {ComputerClock,newClock} from '../static/computer-clock.js';

test('server deadlines survive clock skew and do not offer a fake pause',()=>{
 const view={session:{id:'color',deadline:130,config:{duration:30},index:1},offset:900};
 const color=nativeToolbarState(view,{activity:'color',nowMs:1010000});
 assert.equal(color.remainingMs,20000);assert.equal(color.elapsedMs,10000);assert.equal(color.measurementMs,10000);assert.equal(color.canPause,false);
 const coordinates=nativeToolbarState(view,{activity:'coordinates',nowMs:1130000});
 assert.equal(coordinates.remainingMs,0);assert.equal(coordinates.elapsedMs,30000);assert.equal(coordinates.progress,1);
});

test('Color waits for the first answer without consuming the budget',()=>{
 const value=nativeToolbarState({session:{id:'c',deadline:null,config:{duration:60},index:0}},{activity:'color',nowMs:9000000});
 assert.equal(value.waiting,true);assert.equal(value.remainingMs,60000);assert.equal(value.elapsedMs,0);assert.equal(value.measurementMs,0);
});

test('Storm keeps accepted bonuses and penalties and waits for its first move',()=>{
 const view={tab:'play',stormReceived:1000,storm:{id:'s',status:'active',clock_started:false,remaining_ms:180000,started_ms:5000,deadline_ms:185000}};
 assert.equal(nativeToolbarState(view,{activity:'puzzles',nowMs:80000}).remainingMs,180000);
 view.storm.clock_started=true;view.storm.remaining_ms=173000;view.storm.deadline_ms=188000;
 const bonus=nativeToolbarState(view,{activity:'puzzles',nowMs:3000});
 assert.equal(bonus.remainingMs,171000);assert.equal(bonus.elapsedMs,12000);assert.equal(bonus.sourceTool,'storm');assert.equal(bonus.measurementMs,null);assert.equal(bonus.canPause,false);
 view.storm.remaining_ms=163000;view.storm.deadline_ms=178000;
 const penalty=nativeToolbarState(view,{activity:'puzzles',nowMs:3000});
 assert.equal(penalty.remainingMs,161000);assert.equal(penalty.elapsedMs,12000);
});

test('computer uses actual active time independently of chess clocks without mutating either',()=>{
 let now=1000;const activity=new ComputerActivity(newComputerActivity(),{now:()=>now});
 const clock=new ComputerClock(newClock({time_control:'15+10'}),{now:()=>now});
 activity.start();clock.start('white');now=6000;
 const session={id:'game',side:'white',position:{game_over:false},activity:activity.state,clock:clock.state};
 const view={mode:'play',session,activity,clock},before=JSON.stringify(session);
 const value=nativeToolbarState(view,{activity:'computer'});
 assert.equal(value.elapsedMs,5000);assert.equal(value.measurementMs,5000);assert.equal(value.remainingMs,null);assert.equal(value.clockType,'elapsed');assert.equal(value.clockLabel,'Temps actif');assert.equal(value.canPause,true);assert.equal(value.paused,false);assert.equal(JSON.stringify(session),before);
 clock.commit('white',1);now=9000;
 assert.equal(nativeToolbarState(view,{activity:'computer'}).measurementMs,8000,'increments and opponent turns do not change total practice time');
 clock.pause();activity.pause();now=20000;
 const paused=nativeToolbarState(view,{activity:'computer'});assert.equal(paused.paused,true);assert.equal(paused.elapsedMs,8000);assert.equal(paused.remainingMs,null);
});

test('untimed computer respects explicit pause rather than a temporarily idle activity counter',()=>{
 const view={mode:'play',session:{id:'game',position:{},activity:{elapsed_ms:2000},paused:false},paused:()=>true};
 assert.equal(nativeToolbarState(view,{activity:'computer'}).paused,true);
 view.paused=()=>false;assert.equal(nativeToolbarState(view,{activity:'computer'}).paused,false);
 delete view.paused;view.session.paused=true;assert.equal(nativeToolbarState(view,{activity:'computer'}).paused,true);
});

test('legacy untimed games have unknown activity duration, never time since opening',()=>{
 const value=nativeToolbarState({mode:'play',session:{id:'old',started_at:'2000-01-01',side:'white',position:{}}},{activity:'computer'});
 assert.equal(value.elapsedMs,null);assert.equal(value.measurementMs,null);assert.equal(value.clockType,'unknown');
});

test('guess counts saved reflection plus the current proposal, excluding feedback and engine wait',()=>{
 const view={startedAt:1000,session:{id:'g',attempts:[{elapsed_ms:3000},{elapsed_ms:2000}]}};
 assert.equal(nativeToolbarState(view,{activity:'guess',nowMs:5000}).measurementMs,9000);
 view.session.awaiting_continue=true;assert.equal(nativeToolbarState(view,{activity:'guess',nowMs:5000}).measurementMs,5000);
 view.session.awaiting_continue=false;view.busy=true;assert.equal(nativeToolbarState(view,{activity:'guess',nowMs:5000}).measurementMs,5000);
 view.busy=false;view.session.pending=true;assert.equal(nativeToolbarState(view,{activity:'guess',nowMs:5000}).measurementMs,5000);
});


test('Blindfold never relabels frozen preparation as total solve time',()=>{
 const view={preparationReceivedAt:100,session:{id:'b',preparation_ms:3000,started:false}};
 const preparing=nativeToolbarState(view,{activity:'blindfold',performanceNow:2100});
 assert.equal(preparing.elapsedMs,5000);assert.equal(preparing.measurementMs,5000);
 view.session.started=true;
 const solving=nativeToolbarState(view,{activity:'blindfold',performanceNow:20000});
 assert.equal(solving.elapsedMs,3000);assert.equal(solving.measurementMs,null);assert.equal(solving.clockLabel,'Temps de visualisation');
});

test('finished free exercises hide while only the matching open programme keeps controls',()=>{
 const view={session:{id:'c',training_run_id:'r',finished:true,config:{duration:30},index:2,deadline:100,result:{duration:30}},offset:0};
 assert.equal(nativeToolbarState(view,{activity:'color'}),null);
 view.trainingRun={id:'other',state:'active',activity:'color',block:{title:'Other'}};
 assert.equal(nativeToolbarState(view,{activity:'color'}),null);
 view.trainingRun={id:'r',state:'active',activity:'color',block:{title:'Daily drill'}};
 const value=nativeToolbarState(view,{nowMs:100000});assert.equal(value.active,false);assert.equal(value.programId,'r');assert.equal(value.nativeId,'c');assert.equal(value.title,'Daily drill');
 view.trainingRun.state='completed';assert.equal(nativeToolbarState(view),null);
});

test('setup, disposed views, and puzzle statistics do not activate the toolbar',()=>{
 assert.equal(nativeToolbarState({},{activity:'color'}),null);
 assert.equal(nativeToolbarState({disposed:true,session:{id:'c'}},{activity:'color'}),null);
 assert.equal(nativeToolbarState({mode:'setup',session:{id:'g',position:{}}},{activity:'computer'}),null);
 assert.equal(nativeToolbarState({tab:'stats',attempt:{id:'p',status:'active'}},{activity:'puzzles'}),null);
});

test('classic puzzles show the known native measurement without inventing a live timer',()=>{
 const value=nativeToolbarState({attempt:{id:'p',status:'active',elapsed_ms:1700,started_at:'2000-01-01'}},{activity:'puzzles'});
 assert.equal(value.elapsedMs,1700);assert.equal(value.measurementMs,1700);assert.equal(value.clockLabel,'Temps enregistré');assert.equal(value.canPause,false);
});

test('programme targets the session allocation, never the weekly target or opening timestamp',()=>{
 const run={id:'r',activity:'puzzles',state:'active',duration_ms:120000,started_at:'2000-01-01',launch:{minutes:15},block:{target:200,session_minutes:30,title:'Tactics'}};
 const recorded=programToolbarState(run);assert.equal(recorded.targetMs,900000);assert.equal(recorded.remainingMs,780000);assert.equal(recorded.clockLabel,'Temps enregistré');
 const live=programToolbarState(run,{elapsedMs:925000});assert.equal(live.remainingMs,0);assert.equal(live.progress,1);assert.equal(live.clockLabel,'Temps restant');assert.equal(run.state,'active');
 assert.equal(programToolbarState({...run,state:'completed'}),null);
 const unknown=programToolbarState({...run,duration_ms:null,launch:{minutes:null},block:{metric:'quantity',target:100}});
 assert.equal(unknown.elapsedMs,null);assert.equal(unknown.targetMs,null);assert.equal(unknown.remainingMs,null);assert.equal(unknown.clockType,'unknown');
});

test('scoped minute goals start from the selected remainder and subtract only new run work',()=>{
 const run={id:'scoped',activity:'review',state:'paused',duration_ms:180000,launch:{minutes:17,goal:{scope:'today',metric:'minutes',unit:'cards',remaining:17,baseline_duration_ms:180000}},block:{session_minutes:20,target:20}};
 const original=structuredClone(run),today=programToolbarState(run);
 assert.equal(today.targetMs,17*60000);assert.equal(today.elapsedMs,0);assert.equal(today.remainingMs,17*60000);assert.equal(today.goalScope,'today');
 const working=programToolbarState(run,{elapsedMs:210000,paused:false});assert.equal(working.elapsedMs,30000);assert.equal(working.remainingMs,16.5*60000);
 const week=programToolbarState({...run,duration_ms:210000,launch:{minutes:11,goal:{...run.launch.goal,scope:'week',remaining:11,baseline_duration_ms:210000}}});
 assert.equal(week.remainingMs,11*60000);assert.equal(week.elapsedMs,0);assert.equal(week.goalScope,'week');assert.deepEqual(run,original);
 const fresh=programToolbarState({...run,duration_ms:null,launch:{goal:{...run.launch.goal,baseline_duration_ms:0}}});assert.equal(fresh.remainingMs,17*60000);
});

test('scoped quantity goals have no inherited time limit and count accepted units beyond their baseline',()=>{
 const run={id:'quantity',activity:'puzzles',state:'active',duration_ms:180000,quantity:10,launch:{minutes:null,goal:{scope:'week',metric:'quantity',unit:'positions',remaining:13,baseline_duration_ms:120000,baseline_quantity:7}},block:{metric:'quantity',unit:'positions',target:20,session_minutes:30}};
 const view=programToolbarState(run);
 assert.equal(view.clockType,'quantity');assert.equal(view.targetMs,null);assert.equal(view.remainingMs,null);assert.equal(view.elapsedMs,60000);
 assert.equal(view.targetQuantity,13);assert.equal(view.completedQuantity,3);assert.equal(view.remainingQuantity,10);assert.equal(view.progress,3/13);
 const completed=programToolbarState(run,{quantity:24});assert.equal(completed.remainingQuantity,0);assert.equal(completed.completedQuantity,17);assert.equal(completed.progress,1);
});

test('scoped session goals retain an episode timer and the explicit remaining session count',()=>{
 const run={id:'sessions',activity:'reading',state:'active',duration_ms:120000,sessions:1,launch:{minutes:15,goal:{scope:'today',metric:'sessions',unit:'games',remaining:2,baseline_duration_ms:120000,baseline_sessions:1}},block:{metric:'sessions',session_minutes:15,target:3}};
 const view=programToolbarState(run);assert.equal(view.clockType,'countdown');assert.equal(view.remainingMs,900000);assert.equal(view.remainingQuantity,2);assert.equal(view.quantityUnit,'sessions');
 const later=programToolbarState(run,{elapsedMs:180000});assert.equal(later.remainingMs,840000);assert.equal(later.remainingQuantity,2);
});

test('free categories and existing runs resumed freely do not inherit a timer or unit target',()=>{
 for(const session_minutes of [null,20]){
  const run={id:'free',activity:'coordinates',state:'active',duration_ms:120000,quantity:12,
   launch:{free:true,minutes:null},block:{metric:'minutes',target:20,session_minutes}};
  const value=programToolbarState(run,{elapsedMs:125000});
  assert.equal(value.clockType,'elapsed');assert.equal(value.elapsedMs,125000);
  assert.equal(value.targetMs,null);assert.equal(value.remainingMs,null);assert.equal(value.targetQuantity,null);assert.equal(value.progress,null);
  const stale=programToolbarState({...run,launch:{free:true,minutes:20,goal:{scope:'today',metric:'quantity',remaining:5}}});
  assert.equal(stale.clockType,'elapsed');assert.equal(stale.targetMs,null);assert.equal(stale.targetQuantity,null);
 }
});
