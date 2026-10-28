import test from 'node:test';
import assert from 'node:assert/strict';
import {TrainingToolbarProgress} from '../static/training-toolbar-progress.js';
const run=(duration,progress=[])=>({id:'run-a',duration_ms:duration,native_progress:progress});
const source=(id,ms,programId='run-a')=>({nativeId:id,sourceTool:'color',measurementMs:ms,programId});
const included=(id,ms)=>({tool:'color',source_id:id,duration_ms:ms});
test('reloading a partially credited source only adds unrecorded time',()=>{
 const clock=new TrainingToolbarProgress();
 assert.equal(clock.elapsed(run(16000,[included('first',12000),included('second',4000)]),source('second',7000)),19000);
 assert.equal(clock.elapsed(run(19000,[included('first',12000),included('second',7000)]),source('second',7000)),19000);
});
test('next exercise retains previous live measurement while its receipt is in flight',()=>{
 const clock=new TrainingToolbarProgress();
 assert.equal(clock.elapsed(run(0),source('first',30000)),30000);
 assert.equal(clock.elapsed(run(0),source('second',1000)),31000);
 assert.equal(clock.elapsed(run(30000,[included('first',30000)]),source('second',2000)),32000);
 assert.equal(clock.elapsed(run(32000,[included('first',30000),included('second',2000)]),source('second',2000)),32000);
});
test('unknown clocks and another program cannot fabricate live work',()=>{
 const clock=new TrainingToolbarProgress();
 assert.equal(clock.elapsed(run(12000),source('first',null)),null);
 assert.equal(clock.elapsed(run(12000),source('other',9000,'other-run')),12000);
 assert.equal(clock.samples.size,0);
 assert.equal(clock.elapsed({...run(12000),native_progress:undefined},source('first',20000)),null);
 clock.elapsed(run(0),source('first',5000));
 assert.equal(clock.elapsed({...run(0),id:'run-b'},source('second',1000,'run-b')),1000);
});
