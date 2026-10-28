import assert from 'node:assert/strict';
import {LibraryDirectory} from '../static/library-directory.js';
import {TestNode} from './metadata_dom.mjs';

const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture(){
 const host=new TestNode(),calls=[],directory=new LibraryDirectory(host,{endpoint:'/api/reference-bases/7/directory',request:(url,options)=>{const task=deferred();calls.push({url,options,...task});return task.promise;}});
 return {host,calls,directory,html:()=>host.querySelector('[data-directory-results]').innerHTML};
}
const page=(name='Alice',offset=0)=>({status:'ok',items:[{key:name,name,games:12,white_games:7,black_games:5}],offset,total:70,has_more:offset===0});
const preparing=()=>({status:'preparing',items:[],total:null,retry_after:3});
const assertProgress=html=>{assert.match(html,/role="progressbar"/);assert.doesNotMatch(html,/aria-valuenow=|Aucun résultat/);};
const assertStopped=html=>assert.doesNotMatch(html,/role="progressbar"/);
async function withClock(test){
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,realNow=Date.now,timers=[];let now=0;
 globalThis.setTimeout=(callback,delay)=>{const timer={callback,delay,cancelled:false,fired:false};timers.push(timer);return timer;};
 globalThis.clearTimeout=timer=>{if(timer)timer.cancelled=true;};Date.now=()=>now;
 const clock={active:()=>timers.filter(timer=>!timer.cancelled&&!timer.fired),advance(value){now+=value;},fire(timer){assert.ok(timer&&!timer.cancelled&&!timer.fired);timer.fired=true;now+=timer.delay;return timer.callback();}};
 try{await test(clock);}finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;Date.now=realNow;}
}

const tests={
 async pending_search_is_visible_until_results_arrive(){
  const f=fixture();try{
   const task=f.directory.show('players');assertProgress(f.html());assert.equal(f.directory.loading,true);
   f.calls.at(-1).resolve(page());await task;assert.match(f.html(),/Alice/);assertStopped(f.html());assert.equal(f.directory.loading,false);
  }finally{f.directory.dispose();}
 },
 async background_preparation_remains_visible_between_polls(){
  await withClock(async clock=>{const f=fixture();try{
   const task=f.directory.show('events');f.calls.at(-1).resolve(preparing());await settle();
   assertProgress(f.html());assert.match(f.html(),/Préparation/);assert.equal(clock.active().length,1);assert.equal(f.calls.length,1);
   clock.fire(clock.active()[0]);await settle();assertProgress(f.html());assert.equal(f.calls.length,2);
   f.calls.at(-1).resolve(page('Open de Montréal'));await task;assertStopped(f.html());assert.match(f.html(),/Open de Montréal/);assert.equal(clock.active().length,0);
  }finally{f.directory.dispose();}});
 },
 async pagination_keeps_previous_rows_and_shows_progress(){
  const f=fixture();try{
   let task=f.directory.show('players');f.calls.at(-1).resolve(page());await task;
   f.directory.state.offset=50;task=f.directory.load();assert.match(f.html(),/Alice/);assertProgress(f.html());
   assert.equal(new URL(f.calls.at(-1).url,'http://local').searchParams.get('offset'),'50');
   f.calls.at(-1).resolve(page('Boris',50));await task;assertStopped(f.html());assert.match(f.html(),/Boris/);assert.doesNotMatch(f.html(),/Alice/);
  }finally{f.directory.dispose();}
 },
 async failure_stops_progress_without_losing_previous_page(){
  const f=fixture();try{
   let task=f.directory.show('players');f.calls.at(-1).resolve(page());await task;
   f.directory.state.offset=50;task=f.directory.load();assertProgress(f.html());f.calls.at(-1).reject(new Error('Connexion interrompue'));await task;
   assertStopped(f.html());assert.match(f.html(),/Alice/);assert.match(f.html(),/Connexion interrompue/);assert.equal(f.directory.state.offset,0);
   task=f.directory.load();assertProgress(f.html());f.calls.at(-1).resolve(page('Boris'));await task;assertStopped(f.html());assert.doesNotMatch(f.html(),/Connexion interrompue/);
  }finally{f.directory.dispose();}
 },
 async superseded_response_cannot_clear_new_search_progress(){
  const f=fixture();try{
   const oldTask=f.directory.show('players'),old=f.calls.at(-1);
   f.directory.state.search='Boris';const newTask=f.directory.load(),latest=f.calls.at(-1);assert.equal(old.options.signal.aborted,true);
   old.resolve(page('Alice'));await oldTask;assertProgress(f.html());assert.doesNotMatch(f.html(),/Alice/);assert.equal(f.directory.loading,true);
   latest.resolve(page('Boris'));await newTask;assertStopped(f.html());assert.match(f.html(),/Boris/);
  }finally{f.directory.dispose();}
 },
 async automatic_poll_limit_stops_bar_and_allows_manual_refresh(){
  await withClock(async clock=>{const f=fixture();try{
   let task=f.directory.show('players');f.calls.at(-1).resolve(preparing());await settle();assertProgress(f.html());
   clock.advance(300001);clock.fire(clock.active()[0]);await settle();f.calls.at(-1).resolve(preparing());await task;
   assertStopped(f.html());assert.match(f.html(),/Actualiser/);assert.doesNotMatch(f.html(),/Aucun résultat/);assert.equal(clock.active().length,0);
   task=f.directory.load();assertProgress(f.html());f.calls.at(-1).resolve(page());await task;assertStopped(f.html());assert.match(f.html(),/Alice/);
  }finally{f.directory.dispose();}});
 },
 async preparation_failure_stops_bar_and_navigation_cancels_polling(){
  await withClock(async clock=>{const f=fixture();try{
   let task=f.directory.show('players');f.calls.at(-1).resolve(preparing());await settle();clock.fire(clock.active()[0]);await settle();
   f.calls.at(-1).reject(new Error('Hors connexion'));await task;assertStopped(f.html());assert.match(f.html(),/Hors connexion/);assert.match(f.html(),/Actualiser/);
   task=f.directory.load();f.calls.at(-1).resolve(preparing());await settle();assertProgress(f.html());const timer=clock.active()[0],count=f.calls.length;
   f.directory.hide();await task;assert.equal(timer.cancelled,true);assert.equal(f.calls.at(-1).options.signal.aborted,true);assert.equal(f.calls.length,count);
   task=f.directory.show('events');assertProgress(f.html());f.calls.at(-1).resolve(page('Open'));await task;assertStopped(f.html());assert.match(f.html(),/Open/);
  }finally{f.directory.dispose();}});
 },
 async catalog_retry_shows_preparation_and_disposal_ignores_late_results(){
  await withClock(async clock=>{const f=fixture();try{
   const task=f.directory.show('players');f.calls.at(-1).reject(Object.assign(new Error('Preparing'),{status:503,reason:'catalog-preparing',retryAfter:1}));await settle();
   assertProgress(f.html());assert.match(f.html(),/Préparation/);clock.fire(clock.active()[0]);await settle();
   const request=f.calls.at(-1),html=f.html();f.directory.dispose();request.resolve(page('Late result'));await task;
   assert.equal(request.options.signal.aborted,true);assert.equal(f.html(),html);assert.equal(f.directory.data,null);assert.equal(clock.active().length,0);
  }finally{f.directory.dispose();}});
 }
};
for(const[name,test]of Object.entries(tests)){await test();console.log('ok '+name);}
