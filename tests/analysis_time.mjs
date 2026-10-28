import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AnalysisTimeTracker,boardStudyActivity,flushAnalysisWrites,resetAnalysisContext} from '../static/analysis-time.js';

class Surface {
 constructor(){this.listeners=new Map();this.visibilityState='visible';this.focused=true;}
 hasFocus(){return this.focused;}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
 emit(name){for(const fn of this.listeners.get(name)||[])fn();}
}
function fixture(options={}){
 const page=new Surface(),win=new Surface(),sent=[];let now=0;
 const tracker=new AnalysisTimeTracker({doc:{title:'Free board'},document:page,window:win,now:()=>now,setInterval:()=>1,clearInterval:()=>{},request:async(url,options)=>{sent.push(options.body);return {};},...options});
 return {tracker,page,win,sent,advance:ms=>now+=ms};
}

test('foreground, idle, blur, hidden, pause and disposal measure only active time',async()=>{
 resetAnalysisContext();const f=fixture();
 f.advance(120000);await f.tracker.settle();assert.equal(f.sent.reduce((s,p)=>s+p.duration_ms,0),90000);
 f.page.emit('pointerdown');f.advance(5000);f.win.emit('blur');f.advance(50000);f.page.focused=false;
 await f.tracker.settle();assert.equal(f.tracker.toolbarElapsedMs(),95000);
 f.page.focused=true;f.win.emit('focus');f.advance(2000);await f.tracker.pause();f.advance(10000);await f.tracker.settle();
 assert.equal(f.tracker.toolbarElapsedMs(),97000);f.tracker.resume();f.advance(3000);
 f.page.visibilityState='hidden';f.page.emit('visibilitychange');f.advance(10000);f.tracker.dispose();await flushAnalysisWrites();
 assert.equal(f.sent.reduce((s,p)=>s+p.duration_ms,0),100000);assert.equal(f.tracker.toolbarElapsedMs(),100000);
 assert.ok([...f.page.listeners.values(),...f.win.listeners.values()].every(list=>list.size===0));
});

test('uncertain responses retry the identical receipt across board replacements',async()=>{
 resetAnalysisContext();const sent=[];let fail=true;
 const a=fixture({request:async(url,options)=>{sent.push(options.body);if(fail)throw new Error('Offline');}});
 a.advance(4321);a.tracker.dispose();await flushAnalysisWrites();assert.equal(sent.length,1);
 fail=false;const b=fixture();await b.tracker.settle();
 assert.equal(sent.length,2);assert.deepEqual(sent[1],sent[0]);assert.equal(sent[0].duration_ms,4321);
 b.tracker.dispose();await flushAnalysisWrites();
});

test('context reset drops queued old-account writes and stale failures',async()=>{
 resetAnalysisContext();let release;const gate=new Promise(resolve=>release=resolve),sent=[];
 const a=fixture({request:async(url,options)=>{sent.push(options.body);await gate;throw new Error('Offline');}});
 a.advance(100);a.tracker.flush();a.tracker.tick();a.tracker.flush();await Promise.resolve();
 a.advance(500);a.tracker.dispose();resetAnalysisContext();release();await flushAnalysisWrites();
 const b=fixture();await b.tracker.settle();assert.equal(sent.length,1);assert.equal(b.sent.length,0);b.tracker.dispose();
});

test('reading and analysis attribution are exclusive, including explicit Analyse launch',()=>{
 const bases=[{id:1,settings:{reading_enabled:true}}],doc={id:2,base_id:1};
 assert.equal(boardStudyActivity(doc,bases),'reading');
 assert.equal(boardStudyActivity(doc,bases,{analysisOnly:true}),'analysis');
 assert.equal(boardStudyActivity(doc,bases,{analysisOnly:true,readingRun:true}),'reading');
 assert.equal(boardStudyActivity({title:'Unsaved'},bases),'analysis');
 assert.equal(boardStudyActivity({title:'Reference game'},bases),'analysis');
 assert.equal(boardStudyActivity({...doc,reading:{enabled:true}},[]),'reading');
});
