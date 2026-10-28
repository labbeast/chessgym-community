import test from 'node:test';
import assert from 'node:assert/strict';
import {setListOwner,readListState,writeListState,listPaginationHtml,listChipsHtml,listFold} from '../static/list-view.js';
import {gameFilterChips} from '../static/game-search.js';
import {GamePicker} from '../static/game-picker.js';
import {setLanguage} from '../static/i18n.js';

test('navigation state is copied, scoped to a view and cleared on owner or restored database change',()=>{
 setListOwner('alice:epoch1');writeListState('base:1',{filters:{player:'Alice'},offset:50});
 const value=readListState('base:1');value.filters.player='changed';assert.equal(readListState('base:1').filters.player,'Alice');assert.deepEqual(readListState('base:2'),{});
 setListOwner('alice:epoch1');assert.equal(readListState('base:1').offset,50);setListOwner('alice:epoch2');assert.deepEqual(readListState('base:1'),{});writeListState('base:1',{query:'private'});setListOwner('bob');assert.deepEqual(readListState('base:1'),{});
});
test('pagination distinguishes an unknown total, empty results and the last partial page',()=>{
 assert.doesNotMatch(listPaginationHtml({total:null}),/sur 0/);
 assert.match(listPaginationHtml({total:0,count:0}),/0–0 sur 0/);
 const html=listPaginationHtml({offset:50,total:54,count:4,limit:50,previous:'data-prev',next:'data-next',size:'data-size'});assert.match(html,/51–54 sur 54/);assert.match(html,/data-next disabled/);assert.doesNotMatch(html,/data-prev disabled/);assert.match(html,/value="100"/);
});
test('filter chips escape values and labels, keep locked scope visible and translate only interface text',()=>{
 setLanguage('en');const html=listChipsHtml([{key:'q',label:'Rechercher',value:'<img src=x>'},{key:'tool',label:'Outil',value:'Color',locked:true}]);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img/);assert.equal((html.match(/data-list-clear=/g)||[]).length,1);assert.match(html,/Remove filter/);assert.equal(listFold('ÉCossaise'),'ecossaise');assert.deepEqual(gameFilterChips({player:'Labbé',player_color:'black',rating_side:'both'}).map(item=>item.key),['player','player_color']);setLanguage('fr');
 assert.equal(gameFilterChips({player:'black'})[0].value,'black');
});

const pickerHost=()=>{
 const nodes=new Map(['[data-game-search]','[data-picker-chips]','[data-games]'].map(selector=>[selector,{attributes:{},setAttribute(name,value){this.attributes[name]=value;}}]));
 return {querySelector:selector=>nodes.get(selector)||null,addEventListener(){},removeEventListener(){}};
};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const pickerPage={entries:[{id:8,headers:{White:'Alice',Black:'Bob',Result:'1-0'}}],offset:0,total:1};

test('game picker shows search progress until success, stops on error and restarts for retry',async()=>{
 setListOwner('picker-progress');const host=pickerHost(),requests=[];
 const picker=new GamePicker(host,{bases:[{id:12,name:'Reference',reference:true}],request:()=>{const request=deferred();requests.push(request);return request.promise;}}),results=host.querySelector('[data-games]');
 try{
  assert.match(results.innerHTML,/search-progress/);assert.equal(results.attributes['aria-busy'],'true');
  requests[0].resolve(pickerPage);await picker.ready;
  assert.doesNotMatch(results.innerHTML,/search-progress/);assert.match(results.innerHTML,/Alice/);assert.equal(results.attributes['aria-busy'],'false');
  picker.filters.search='Different';const search=picker.load();assert.match(results.innerHTML,/search-progress/);assert.doesNotMatch(results.innerHTML,/Alice/);
  requests[1].reject(Error('Offline'));await search;
  assert.doesNotMatch(results.innerHTML,/search-progress/);assert.match(results.innerHTML,/Offline/);assert.equal(results.attributes['aria-busy'],'false');
  const retry=picker.load();assert.match(results.innerHTML,/search-progress/);assert.doesNotMatch(results.innerHTML,/Offline/);
  requests[2].resolve(pickerPage);await retry;assert.doesNotMatch(results.innerHTML,/search-progress/);
 }finally{picker.dispose();}
});

test('game picker keeps progress during background preparation and stops when automatic checks pause',async()=>{
 const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,originalNow=Date.now;let now=0,waiting;
 globalThis.setTimeout=callback=>{waiting=callback;return 1;};globalThis.clearTimeout=()=>{};Date.now=()=>now;
 setListOwner('picker-preparation-progress');const host=pickerHost(),requests=[];
 const picker=new GamePicker(host,{bases:[{id:12,name:'Reference',reference:true}],request:()=>{const request=deferred();requests.push(request);return request.promise;}}),results=host.querySelector('[data-games]');
 try{
  requests[0].resolve({status:'preparing',retry_after:3});await settle();
  assert.match(results.innerHTML,/search-progress/);assert.match(results.innerHTML,/Préparation de la liste/);assert.equal(results.attributes['aria-busy'],'true');
  waiting();await settle();assert.equal(requests.length,2);assert.match(results.innerHTML,/search-progress/);
  now=300001;requests[1].resolve({status:'preparing',retry_after:3});await picker.ready;
  assert.doesNotMatch(results.innerHTML,/search-progress/);assert.match(results.innerHTML,/La préparation continue sur le serveur/);assert.match(results.innerHTML,/data-picker-action="retry"/);assert.equal(results.attributes['aria-busy'],'false');
 }finally{picker.dispose();globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;Date.now=originalNow;}
});

test('old or disposed picker requests cannot clear a newer search indicator',async()=>{
 setListOwner('picker-stale-progress');const host=pickerHost(),requests=[];
 const picker=new GamePicker(host,{bases:[{id:12,name:'Reference',reference:true}],request:(url,options)=>{const request={...deferred(),options};requests.push(request);return request.promise;}}),results=host.querySelector('[data-games]');
 try{
  const next=picker.load();assert.equal(requests[0].options.signal.aborted,true);
  requests[0].resolve(pickerPage);await picker.ready;assert.match(results.innerHTML,/search-progress/);assert.doesNotMatch(results.innerHTML,/Alice/);
  requests[1].resolve(pickerPage);await next;assert.doesNotMatch(results.innerHTML,/search-progress/);
  const pending=picker.load(),html=results.innerHTML;picker.dispose();assert.equal(requests[2].options.signal.aborted,true);
  requests[2].resolve(pickerPage);await pending;assert.equal(results.innerHTML,html);
 }finally{if(!picker.disposed)picker.dispose();}
});

test('game picker discards an unavailable remembered base before restoring filters and pagination',async()=>{
 setListOwner('picker-associated-base');
 writeListState('guess-picker',{baseId:7});
 writeListState('guess-picker:7',{filters:{player:'Excluded player',sort:'added'},offset:100,limit:100});
 const urls=[],picker=new GamePicker(pickerHost(),{stateKey:'guess-picker',bases:[{id:12,name:'Associated reference',reference:true}],request:async url=>{urls.push(new URL(url,'https://chessgym.test'));return {entries:[],total:0,offset:0};}});
 try{
  await picker.ready;
  assert.equal(urls.length,1);assert.equal(urls[0].pathname,'/api/reference-bases/12/games');
  assert.equal(urls[0].searchParams.get('sort'),'id');assert.equal(urls[0].searchParams.has('player'),false);
  assert.equal(urls[0].searchParams.get('offset'),'0');assert.equal(urls[0].searchParams.get('limit'),'25');
  assert.equal(readListState('guess-picker').baseId,12);
 }finally{picker.dispose();}
});

test('game picker retains the remembered available base and its own filters',async()=>{
 setListOwner('picker-valid-base');
 writeListState('guess-picker',{baseId:'12'});
 writeListState('guess-picker:12',{filters:{player:'Associated player',sort:'white'},offset:50,limit:50});
 const urls=[],picker=new GamePicker(pickerHost(),{stateKey:'guess-picker',bases:[{id:7,name:'First'},{id:12,name:'Associated reference',reference:true}],request:async url=>{urls.push(new URL(url,'https://chessgym.test'));return {entries:[],total:0,offset:50};}});
 try{
  await picker.ready;
  assert.equal(urls.length,1);assert.equal(urls[0].pathname,'/api/reference-bases/12/games');
  assert.equal(urls[0].searchParams.get('sort'),'white');assert.equal(urls[0].searchParams.get('player'),'Associated player');
  assert.equal(urls[0].searchParams.get('offset'),'50');assert.equal(urls[0].searchParams.get('limit'),'50');
 }finally{picker.dispose();}
});

test('game picker does not request an unavailable remembered base when no bases remain',async()=>{
 setListOwner('picker-empty-bases');writeListState('guess-picker',{baseId:7});
 let requests=0;const picker=new GamePicker(pickerHost(),{stateKey:'guess-picker',bases:[],request:async()=>{requests++;return {};}});
 try{await picker.ready;assert.equal(requests,0);assert.equal(picker.baseId,undefined);}finally{picker.dispose();}
});
