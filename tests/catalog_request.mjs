import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForRetry,requestPreparedCatalog} from '../static/catalog-request.js';

const preparing=retryAfter=>Object.assign(Error('Preparing'),{status:503,reason:'catalog-preparing',retryAfter});

test('catalog preparation retries with bounded backoff and preserves request cancellation',async()=>{
 const controller=new AbortController(),waits=[],requests=[];let hints=0;
 const result=await requestPreparedCatalog(async(url,options)=>{
  requests.push({url,options});
  if(requests.length<4)throw preparing([0,.1,10][requests.length-1]);
  return {entries:[{id:12}]};
 },'/entries',{signal:controller.signal,onPreparing:()=>hints++,wait:async(ms,signal)=>{waits.push(ms);assert.equal(signal,controller.signal);}});
 assert.deepEqual(result,{entries:[{id:12}]});assert.deepEqual(waits,[1000,500,2000]);assert.equal(hints,3);
 assert(requests.every(r=>r.url==='/entries'&&r.options.signal===controller.signal));
});

test('catalog retries are finite and unrelated failures are never retried',async()=>{
 for(const error of [Object.assign(Error('Offline'),{status:503}),Object.assign(Error('Unauthorized'),{status:401}),Error('Network')]){
  let requests=0;await assert.rejects(requestPreparedCatalog(async()=>{requests++;throw error;},'/entries',{wait:()=>assert.fail('Unexpected retry')}),value=>value===error);assert.equal(requests,1);
 }
 let requests=0;const error=preparing(1);
 await assert.rejects(requestPreparedCatalog(async()=>{requests++;throw error;},'/entries',{wait:async()=>{}}),value=>value===error);
 assert.equal(requests,4);
});

test('abort before or during preparation prevents later requests',async()=>{
 const stopped=new AbortController();stopped.abort();
 await assert.rejects(requestPreparedCatalog(()=>assert.fail('Already aborted'),'/entries',{signal:stopped.signal}),{name:'AbortError'});
 const controller=new AbortController();let requests=0;
 const result=requestPreparedCatalog(async()=>{requests++;throw preparing(1);},'/entries',{signal:controller.signal,wait:(ms,signal)=>{const waiting=waitForRetry(10000,signal);controller.abort();return waiting;}});
 await assert.rejects(result,{name:'AbortError'});assert.equal(requests,1);
 const duringHint=new AbortController();
 await assert.rejects(requestPreparedCatalog(async()=>{throw preparing(1);},'/entries',{signal:duringHint.signal,onPreparing:()=>duringHint.abort(),wait:()=>assert.fail('Aborted during callback')}),{name:'AbortError'});
});

test('retry timers release their abort listener after resolution or cancellation',async()=>{
 for(const cancel of [false,true]){
  const listeners=new Set();const signal={aborted:false,addEventListener(type,fn){listeners.add(fn);},removeEventListener(type,fn){listeners.delete(fn);}};
  const waiting=waitForRetry(cancel?10000:0,signal);assert.equal(listeners.size,1);
  if(cancel){signal.aborted=true;for(const fn of listeners)fn();await assert.rejects(waiting,{name:'AbortError'});}else await waiting;
  assert.equal(listeners.size,0);
 }
});
