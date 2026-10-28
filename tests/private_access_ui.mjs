import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {bindPrivatePair,consumePairingToken,mountPrivatePair} from '../static/private-pair.js';
import {privatePairingLinks,bindPrivateAccess,copyPrivateLink} from '../static/private-access.js';
import {PRIVATE_ACCESS_MESSAGES,PRIVATE_ACCESS_LANGUAGES,privateAccessLanguage,watchPrivatePairingLinks} from '../static/private-access-messages.js';
import {setLanguage,t} from '../static/i18n.js';

const token='a'.repeat(64),other='b'.repeat(64);
const link=(value=token,host='192.168.21.199')=>'http://'+host+':8765/#pair='+value;
const ready=(value=token)=>({enabled:true,restart_required:false,pairing_urls:[{label:'lan',url:link(value)}]});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const reply=(status=200,value={paired:true})=>({status,ok:status>=200&&status<300,json:async()=>value});
function element(){
 return {innerHTML:'',textContent:'',hidden:false,disabled:false,value:'',dataset:{},children:[],attributes:{},
  classList:{toggle(){}},setAttribute(name,value){this.attributes[name]=value;},appendChild(child){this.children.push(child);}};
}
function pairRoot(){
 const nodes=new Map(['title','language-label','language','status','retry'].map(name=>['[data-pair-'+name+']',element()]));
 return {nodes,ownerDocument:{documentElement:{},createElement:()=>element()},querySelector:selector=>nodes.get(selector)};
}
function locationState(hash='#pair='+token){
 const location={hash,pathname:'/',search:''},events=[];
 const history={state:{existing:true},replaceState(state,title,value){events.push('clear');assert.deepEqual(state,{existing:true});location.hash='';location.restored=value;}};
 return {location,history,events};
}
function accessRoot(){
 const nodes=new Map(['[data-private-access-status]','[data-private-access-links]','[data-private-access-revoke]','[data-private-access-message]','[data-private-action="toggle"]','[data-private-action="refresh"]','[data-private-action="rotate"]'].map(selector=>[selector,element()]));
 const root=element();root.querySelector=selector=>nodes.get(selector);root.querySelectorAll=()=>[];
 const host={querySelector:selector=>selector==='#private-access-settings'?root:null};
 function click(action,index){const button={disabled:false,dataset:{privateAction:action,privateLink:String(index??0)}};root.onclick({target:{closest:()=>button}});}
 return {root,host,nodes,click};
}

test('private links accept detected IPv4 and ULA, and reject public or credential-bearing URLs',()=>{
 const accepted=['10.0.0.2','172.16.1.2','172.31.255.254','192.168.1.2','100.64.0.1','100.127.255.254','[fc00::1]','[fd7a:115c:a1e0::2a33:9118]'];
 for(const host of accepted)assert.equal(privatePairingLinks({enabled:true,pairing_urls:[{label:'lan',url:link(token,host)}]}).length,1,host);
 for(const host of ['127.0.0.1','0.0.0.0','8.8.8.8','100.63.0.1','100.128.0.1','172.32.0.1','192.169.1.1','localhost','private.example','[2001:4860::1]','[fe80::1]','[::1]','[::ffff:192.168.1.2]','[fc::1]'])assert.deepEqual(privatePairingLinks({enabled:true,pairing_urls:[{label:'lan',url:link(token,host)}]}),[],host);
 for(const url of [link().replace('http:','https:'),link().replace('192.168.','user@192.168.'),link().replace('/#','/path#'),link().replace('/#','/?leak=yes#'),link()+'&x=y',link('short')])assert.deepEqual(privatePairingLinks({enabled:true,pairing_urls:[{label:'lan',url}]}),[]);
 assert.deepEqual(privatePairingLinks({...ready(),enabled:false}),[]);
 assert.deepEqual(privatePairingLinks({enabled:true,pairing_urls:[{label:'public',url:link()}]}),[]);
});

test('pairing clears valid, invalid and duplicate secret fragments, preserving unrelated fragments',()=>{
 for(const hash of ['#pair='+token,'#pair=bad','#pair='+token+'&pair='+other]){
  const state=locationState(hash);const result=consumePairingToken(state.location,state.history);
  assert.equal(state.location.hash,'');assert.equal(state.location.restored,'/');
  assert.equal(result.error,hash==='#pair='+token?null:'invalid');
 }
 const state=locationState('#review');assert.deepEqual(consumePairingToken(state.location,state.history),{token:'',error:'missing'});assert.equal(state.location.hash,'#review');
});

test('a paired app reopen also consumes the secret before normal app initialization',async()=>{
 const source=await readFile(new URL('../static/app.js',import.meta.url),'utf8');
 assert(source.indexOf('watchPrivatePairingLinks(globalThis.location,globalThis.history);')<source.indexOf('let status;'));
 const state=locationState();consumePairingToken(state.location,state.history);assert.equal(state.location.hash,'');
});

test('pairing posts only after clearing the URL and navigates after an acknowledged cookie response',async()=>{
 const root=pairRoot(),state=locationState(),calls=[];
 const binding=bindPrivatePair(root,{...state,language:'en-CA',request:async(url,options)=>{state.events.push('request');assert.equal(state.location.hash,'');calls.push({url,options});return reply();},navigate:()=>state.events.push('navigate')});
 await tick();
 assert.deepEqual(state.events,['clear','request','navigate']);
 assert.equal(calls[0].url,'/api/private-access/pair');assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.referrerPolicy,'no-referrer');assert.deepEqual(JSON.parse(calls[0].options.body),{token});
 assert.equal(root.ownerDocument.documentElement.lang,'en');
 assert.equal(root.nodes.get('[data-pair-status]').attributes['data-state'],'success');
 binding.dispose();
});

test('missing or malformed pairing links never send a request',async()=>{
 for(const hash of ['', '#pair=wrong', '#pair='+token+'&pair='+other]){
  const root=pairRoot(),state=locationState(hash);let called=false;
  const binding=bindPrivatePair(root,{...state,request:()=>{called=true;},navigate:()=>assert.fail('unexpected navigation')});
  await tick();assert.equal(called,false);binding.dispose();
 }
});

test('a revoked link cannot be retried, while network or rate failures allow an explicit retry',async()=>{
 for(const status of [403,429,503]){
  const root=pairRoot(),state=locationState();let calls=0,navigated=false;
  const binding=bindPrivatePair(root,{...state,request:async()=>++calls===1?reply(status):reply(),navigate:()=>{navigated=true;}});
  await tick();assert.equal(navigated,false);
  assert.equal(root.nodes.get('[data-pair-retry]').hidden,status===403);
  root.nodes.get('[data-pair-retry]').onclick();await tick();
  assert.equal(calls,status===403?1:2);assert.equal(navigated,status!==403);binding.dispose();
 }
});

test('disposing the pairing page aborts and ignores a late successful response',async()=>{
 const root=pairRoot(),state=locationState(),wait=deferred();let signal,navigated=false;
 const binding=bindPrivatePair(root,{...state,request:async(url,options)=>{signal=options.signal;return wait.promise;},navigate:()=>{navigated=true;}});
 binding.dispose();wait.resolve(reply());await tick();assert(signal.aborted);assert.equal(navigated,false);
});

test('settings mask tokens until requested, copy without revealing, and replace revoked links',async()=>{
 setLanguage('en');const ui=accessRoot(),calls=[],copies=[];let current=token;
 const binding=bindPrivateAccess(ui.host,{request:async(path,options)=>{calls.push({path,options});if(path.endsWith('/rotate'))current=other;return ready(current);},copy:async value=>copies.push(value)});
 await tick();const links=ui.nodes.get('[data-private-access-links]');
 assert(!links.innerHTML.includes(token));assert(links.innerHTML.includes('192.168.21.199'));
 ui.click('copy');await tick();assert.deepEqual(copies,[link()]);assert(!links.innerHTML.includes(token));
 ui.click('reveal');assert(links.innerHTML.includes(token));
 ui.click('rotate');await tick();assert(!links.innerHTML.includes(token));assert(!links.innerHTML.includes(other));
 ui.click('copy');await tick();assert.equal(copies[1],link(other));assert.equal(calls.find(x=>x.path.endsWith('/rotate')).options.method,'POST');
 binding.dispose();assert.equal(ui.root.innerHTML,'');setLanguage('fr');
});

test('failed mutation refreshes authoritative settings, and disposal ignores a late initial read',async()=>{
 const ui=accessRoot();let enabled=false,count=0;
 const binding=bindPrivateAccess(ui.host,{request:async(path,options)=>{count++;if(options.method==='PATCH'){enabled=true;throw Error('response lost');}return {...ready(),enabled};}});
 await tick();ui.click('toggle');await tick();assert.equal(count,3);assert.equal(ui.nodes.get('[data-private-access-revoke]').hidden,false);binding.dispose();
 const otherUI=accessRoot(),wait=deferred();let signal;
 const later=bindPrivateAccess(otherUI.host,{request:async(path,options)=>{signal=options.signal;return wait.promise;}});
 later.dispose();wait.resolve(ready());await tick();assert(signal.aborted);assert.equal(otherUI.root.innerHTML,'');
});

test('copy fallback always removes and clears its temporary textarea',async()=>{
 const field={style:{},setAttribute(){},select(){},remove(){this.removed=true;}};
 const doc={body:{appendChild(){}},createElement:()=>field,execCommand:()=>false};
 await assert.rejects(copyPrivateLink(link(),{clipboard:{writeText:async()=>{throw Error('unavailable');}},document:doc}));
 assert.equal(field.value,'');assert.equal(field.removed,true);
});

test('all private messages are translated in all twelve languages and pairing never accesses storage',async()=>{
 assert.equal(Object.keys(PRIVATE_ACCESS_LANGUAGES).length,12);
 for(const [code,messages] of Object.entries(PRIVATE_ACCESS_MESSAGES)){
  assert.deepEqual(Object.keys(messages),Object.keys(PRIVATE_ACCESS_MESSAGES.fr));
  for(const [source,value] of Object.entries(messages)){assert(value.trim(),code+source);setLanguage(code);assert.equal(t(source),value);}
 }
 assert.equal(privateAccessLanguage('zh-Hans'),'zh-CN');assert.equal(privateAccessLanguage('pt-BR'),'pt');assert.equal(privateAccessLanguage('unknown'),'en');
 const source=await readFile(new URL('../static/private-pair.js',import.meta.url),'utf8');assert(!/localStorage|sessionStorage|console\./.test(source));setLanguage('fr');
});

function eventHub(){
 const handlers=new Map();
 return {addEventListener(name,fn){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);},removeEventListener(name,fn){handlers.get(name)?.delete(fn);},dispatch(name){for(const fn of [...(handlers.get(name)||[])])fn();}};
}
test('opening a pairing fragment after the bare address starts pairing without reloading',async()=>{
 const root=pairRoot(),state=locationState(''),events=eventHub();let calls=0,navigations=0;
 const binding=mountPrivatePair(root,{...state,events,request:async()=>{calls++;assert.equal(state.location.hash,'');return reply();},navigate:()=>navigations++});
 assert.equal(calls,0);assert.equal(root.nodes.get('[data-pair-status]').attributes['data-state'],'missing');
 state.location.hash='#pair='+token;events.dispatch('hashchange');await tick();
 assert.equal(calls,1);assert.equal(navigations,1);assert.equal(state.location.hash,'');binding.dispose();
});
test('changing the pairing link aborts the older attempt and ignores its late response',async()=>{
 const root=pairRoot(),state=locationState(),events=eventHub(),first=deferred(),second=deferred(),calls=[];let navigations=0;
 const binding=mountPrivatePair(root,{...state,events,request:async(url,options)=>{calls.push(options);return calls.length===1?first.promise:second.promise;},navigate:()=>navigations++});
 state.location.hash='#pair='+other;events.dispatch('hashchange');
 assert.equal(calls.length,2);assert.equal(calls[0].signal.aborted,true);assert.equal(calls[1].signal.aborted,false);
 assert.equal(JSON.parse(calls[1].body).token,other);
 first.resolve(reply());await tick();assert.equal(navigations,0);assert.equal(root.nodes.get('[data-pair-status]').attributes['data-state'],'pairing');
 second.resolve(reply());await tick();assert.equal(navigations,1);binding.dispose();
 state.location.hash='#pair='+token;events.dispatch('hashchange');assert.equal(calls.length,2);
});
test('a paired app scrubs repeated links on hashchange while preserving ordinary app routes',()=>{
 const state=locationState('#/board?entry=1'),events=eventHub();
 const binding=watchPrivatePairingLinks(state.location,state.history,events);
 assert.equal(state.location.hash,'#/board?entry=1');
 state.location.hash='#pair='+token;events.dispatch('hashchange');assert.equal(state.location.hash,'');
 state.location.hash='#/settings';events.dispatch('hashchange');assert.equal(state.location.hash,'#/settings');
 binding.dispose();state.location.hash='#pair='+token;events.dispatch('hashchange');assert.equal(state.location.hash,'#pair='+token);
});
