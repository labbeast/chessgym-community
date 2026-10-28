import test from 'node:test';
import assert from 'node:assert/strict';
import {WorkspaceStore} from '../static/workspace-store.js';
import {AnnotationDrafts} from '../static/annotation-drafts.js';
import {SectionNavigation,routeFromHash,routeHash} from '../static/section-navigation.js';
const memory=()=>{const m=new Map();return {getItem:k=>m.get(k)||null,setItem:(k,v)=>m.set(k,v)};};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const store=async(request=async()=>({items:[]}),remote=false,storage=memory())=>{const s=new WorkspaceStore({request,storage,delay:100000});await s.open('alice',{remote});return s;};
test('draft persists synchronously, survives reload and stays isolated per account',async()=>{const storage=memory(),a=await store(undefined,false,storage);a.set('analysis',{doc:{nodes:[{path:'',children:['0','1']},{path:'0'},{path:'1'}]}});const b=await store(undefined,false,storage);assert.deepEqual(b.get('analysis'),a.get('analysis'));await b.open('bob');assert.equal(b.get('analysis'),null);a.close();b.close();});
test('serialized writes retain later edits and use the preceding acknowledged revision',async()=>{const gate=deferred(),calls=[];const a=await store(async(url,opts)=>{if(!opts)return {items:[]};calls.push(opts.body);if(calls.length===1)return gate.promise;return {revision:9};},true);a.set('analysis',{path:'0'});const first=a.flush();await tick();a.set('analysis',{path:'1'});const second=a.flush();assert.equal(calls.length,1);gate.resolve({revision:7});await Promise.all([first,second]);assert.deepEqual(calls.map(c=>c.expected_revision),[0,7]);assert.equal(a.get('analysis').path,'1');assert.equal(a.info('analysis').dirty,false);a.close();});
test('409 preserves both versions and never retries over the other device implicitly',async()=>{let writes=0;const a=await store(async(url,opts)=>{if(url==='/api/workspace')return {items:[]};if(!opts)return {key:'analysis',revision:8,data:{path:'remote'}};writes++;throw Object.assign(Error('conflict'),{status:409});},true);a.set('analysis',{path:'local'});await a.flush();await a.flush();assert.equal(writes,1);assert.equal(a.get('analysis').path,'local');assert.equal(a.info('analysis').conflict.data.path,'remote');await a.resolve('analysis','remote');assert.equal(a.get('analysis').path,'remote');a.close();});
test('failed write can retry and old-account response cannot change the new account',async()=>{const gate=deferred();let n=0;const a=await store(async(url,opts)=>{if(!opts)return {items:[]};if(++n===1)throw Error('offline');return gate.promise;},true);a.set('analysis',{path:'old'});await a.flush();assert.equal(a.info('analysis').dirty,true);const pending=a.flush();await tick();await a.open('bob');a.set('analysis',{path:'bob'});gate.resolve({revision:5});await pending;assert.equal(a.get('analysis').path,'bob');a.close();});
test('initial remote fetch cannot erase a locally dirty version',async()=>{const storage=memory(),a=await store(undefined,false,storage);a.set('analysis',{path:'local'});a.close();const b=await store(async()=>({items:[{key:'analysis',revision:3,data:{path:'remote'}}]}),true,storage);assert.equal(b.get('analysis').path,'local');assert.equal(b.info('analysis').conflict.revision,3);b.close();});
test('annotation drafts retain all nodes, NAGs and PGN directives without mutating source',async()=>{const a=await store(),drafts=new AnnotationDrafts(a),doc={id:4,revision:'old',nodes:[{path:'',fen:'root',uci:null,comment:'hello [%clk 0:03:00]',nags:[10,11]},{path:'0',fen:'child',uci:'e2e4',comment:'',nags:[]}]};const form=(text,nags)=>({querySelector:()=>({value:text}),querySelectorAll:()=>nags.map(value=>({value}))});drafts.capture(doc,'',form('Root',[1]));drafts.capture(doc,'0',form('Child',[5]));const result=drafts.overlay(doc);assert.equal(doc.nodes[0].comment,'hello [%clk 0:03:00]');assert.equal(result.nodes[0].comment,'Root [%clk 0:03:00]');assert.deepEqual(result.nodes[0].nags,[1,11]);assert.equal(result.nodes[1].comment,'Child');drafts.acknowledge(doc,{...result,nodes:[result.nodes[0],doc.nodes[1]]});assert.equal(drafts.get(doc,''),null);assert.equal(drafts.get(doc,'0').comment,'Child');a.close();});
test('annotation revision is retained across stale refresh and only advanced after our accepted mutation',async()=>{const a=await store(),d=new AnnotationDrafts(a),old={id:1,revision:'one',nodes:[{path:'',fen:'root',uci:null,comment:'',nags:[]}]},form={querySelector:()=>({value:'draft'}),querySelectorAll:()=>[]};d.capture(old,'',form);const fresh={...old,revision:'two'};d.capture(fresh,'',form);assert.equal(a.get(d.key(old)).revision,'one');d.advance(fresh,{...fresh,revision:'three'});assert.equal(a.get(d.key(old)).revision,'one');d.advance(old,fresh);assert.equal(a.get(d.key(old)).revision,'two');assert.equal(d.get({...old,nodes:[{...old.nodes[0],fen:'other'}]},''),null);a.close();});
test('section routes round-trip while moves never add a history entry',async()=>{const calls=[],win={location:{hash:''},history:{state:null,pushState(s,_,h){this.state=s;win.location.hash=h;calls.push(['push',h]);},replaceState(s,_,h){this.state=s;win.location.hash=h;calls.push(['replace',h]);}},addEventListener(){},removeEventListener(){}};const nav=new SectionNavigation({window:win,onNavigate:async()=>true});const route={page:'board',entryId:12};nav.start(route);nav.commit({...route,path:'0.0'});assert.equal(calls.length,1);nav.commit({page:'base',baseId:4,tab:'settings'});assert.deepEqual(routeFromHash(win.location.hash),{page:'base',baseId:4,entryId:null,tab:'settings'});win.location.hash='#/board?entry=12';await nav.restore({state:{chessgymIndex:0}});assert.equal(nav.route.entryId,12);assert.equal(calls.filter(c=>c[0]==='push').length,1);assert.equal(routeHash({page:'bad'}),'#/library');});
test('activity routes retain the explicit My Training launch without changing ordinary routes',()=>{
 for(const page of ['board','reading','reviews','puzzles','guess','computer','blindfold','coordinates','color']){
  const ordinary=routeFromHash('#/'+page);
  assert.equal(Object.hasOwn(ordinary,'training'),false);
  assert.deepEqual(routeFromHash(routeHash({page,training:true})),{...ordinary,training:true});
  assert.equal(routeHash({page,training:false}),'#/'+page);
  for(const flag of ['', '0', 'true', 'yes'])assert.deepEqual(routeFromHash('#/'+page+'?training='+flag),ordinary);
 }
 assert.equal(routeHash({page:'board',entryId:12,training:true}),'#/board?entry=12&training=1');
 for(const page of ['library','base','played','repertoire','settings','computer-history','training-history','training-plan','exercises','bad']){
  assert.deepEqual(routeFromHash('#/'+page+'?training=1'),routeFromHash('#/'+page));
  assert.equal(routeHash({page,training:true}),routeHash({page}));
 }
});
test('browser history distinguishes a training launch from ordinary access to the same activity',async()=>{
 const calls=[],restored=[],win={location:{hash:''},history:{state:null,pushState(s,_,h){this.state=s;win.location.hash=h;calls.push(h);},replaceState(s,_,h){this.state=s;win.location.hash=h;}},addEventListener(){},removeEventListener(){}};
 const nav=new SectionNavigation({window:win,onNavigate:async route=>{restored.push(route);return true;}});
 nav.start({page:'board',entryId:12,training:true});
 nav.commit({page:'board',entryId:12});
 assert.deepEqual(calls,['#/board?entry=12']);
 win.location.hash='#/board?entry=12&training=1';await nav.restore({state:{chessgymIndex:0}});
 assert.equal(restored[0].training,true);assert.equal(nav.route.training,true);
 win.location.hash='#/board?entry=12';await nav.restore({state:{chessgymIndex:1}});
 assert.equal(Object.hasOwn(restored[1],'training'),false);assert.equal(Object.hasOwn(nav.route,'training'),false);
});
test('blocked browser navigation restores current route and rapid pop events end at latest route',async()=>{const gate=deferred(),win={location:{hash:'#/board'},history:{state:{chessgymIndex:1},replaceState(s,_,h){win.location.hash=h;},pushState(){}},addEventListener(){},removeEventListener(){}};let first=true;const nav=new SectionNavigation({window:win,onNavigate:async()=>{if(first){first=false;return gate.promise;}return true;}});nav.start({page:'board'});win.location.hash='#/library';const one=nav.restore({state:{chessgymIndex:0}});win.location.hash='#/reviews';await nav.restore({state:{chessgymIndex:2}});gate.resolve(true);await one;assert.equal(nav.route.page,'reviews');nav.onNavigate=async()=>false;win.location.hash='#/settings';await nav.restore({state:{chessgymIndex:3}});assert.equal(win.location.hash,'#/reviews');});

test('conflict arriving after another keystroke is attached to the current draft',async()=>{const gate=deferred();const a=await store(async(url,opts)=>{if(url==='/api/workspace')return {items:[]};if(!opts)return gate.promise;throw Object.assign(Error('conflict'),{status:409});},true);a.set('analysis',{path:'first'});const writing=a.flush();await tick();a.set('analysis',{path:'newest'});gate.resolve({revision:8,data:{path:'remote'}});await writing;assert.equal(a.get('analysis').path,'newest');assert.equal(a.info('analysis').conflict.revision,8);a.close();});
test('resolving a conflict cannot overwrite newer typing or another login',async()=>{const gate=deferred();const a=await store();a.enabled=true;a.set('analysis',{path:'local'});a.items.get('analysis').conflict={revision:3,data:{path:'remote'}};a.request=()=>gate.promise;const resolving=a.resolve('analysis','remote');a.set('analysis',{path:'typed'});gate.resolve({revision:4,data:{path:'remote'}});await assert.rejects(resolving,/changé/);assert.equal(a.get('analysis').path,'typed');const again=deferred();a.request=()=>again.promise;const second=a.resolve('analysis','remote');await a.open('bob');a.set('analysis',{path:'bob'});again.resolve({revision:5,data:{path:'alice'}});await second;assert.equal(a.get('analysis').path,'bob');a.close();});
test('unchanged annotation creates no stale revision and clearing a draft removes its revision',async()=>{const a=await store(),d=new AnnotationDrafts(a),doc={id:1,revision:'one',nodes:[{path:'',fen:'root',uci:null,comment:'',nags:[]}]};const form=text=>({querySelector:()=>({value:text}),querySelectorAll:()=>[]});d.capture(doc,'',form(''));assert.equal(a.get(d.key(doc)),null);d.capture(doc,'',form('draft'));d.capture(doc,'',form(''));assert.equal(a.get(d.key(doc)),null);a.close();});
test('stopping navigation invalidates a pending pop and blocked pop restores original history index',async()=>{const gate=deferred(),calls=[],win={location:{hash:'#/board'},history:{state:{chessgymIndex:3},replaceState(){},pushState(){},go(delta){calls.push(delta);}},addEventListener(){},removeEventListener(){}};const nav=new SectionNavigation({window:win,onNavigate:()=>gate.promise});nav.start({page:'board'});win.location.hash='#/library';const restoring=nav.restore({state:{chessgymIndex:2}});nav.stop();gate.resolve(true);await restoring;assert.equal(nav.route.page,'board');nav.start({page:'board'});nav.onNavigate=async()=>false;await nav.restore({state:{chessgymIndex:2}});assert.deepEqual(calls,[1]);assert.equal(nav.index,3);});


test('explicit discard keeps all local copies on CAS conflict, including acknowledged siblings',async()=>{
 const calls=[],conflict=Object.assign(Error('conflict'),{status:409});
 const a=await store(async(url,opts)=>{
  if(url==='/api/workspace')return {items:[{key:'document:free:a',revision:5,data:{note:'local'}},{key:'annotation:free:a',revision:6,data:{note:'annotation'}}]};
  if(!opts)return {key:'annotation:free:a',revision:9,data:{note:'remote'}};
  calls.push(url);if(url.includes('annotation'))throw conflict;return {revision:0};
 },true);
 await assert.rejects(a.discard(['document:free:a','annotation:free:a']),/conflict/);
 assert.equal(a.get('document:free:a').note,'local');assert.equal(a.get('annotation:free:a').note,'annotation');
 assert.equal(a.info('annotation:free:a').conflict.data.note,'remote');
 await a.flush();assert.equal(calls.length,2,'No automatic resurrection or retry after a deletion conflict');a.close();
});
test('discard removes only selected slots after acknowledgements and is durable locally',async()=>{
 const gate=deferred(),storage=memory(),a=await store(async(url,opts)=>!opts?{items:[]}:gate.promise,true,storage);
 a.set('document:free:a',{note:'draft'});a.set('review',{index:1});const deleting=a.discard(['document:free:a']);await tick();
 assert.equal(a.get('document:free:a').note,'draft');gate.resolve({revision:0});await deleting;
 assert.equal(a.get('document:free:a'),null);assert.equal(a.get('review').index,1);a.close();const b=await store(undefined,false,storage);assert.equal(b.get('document:free:a'),null);assert.equal(b.get('review').index,1);b.close();
});
test('typing or changing workspace during discard preserves the new work',async()=>{
 const gate=deferred(),a=await store(async(url,opts)=>!opts?{items:[]}:gate.promise,true);a.set('analysis',{note:'old'});
 const deleting=a.discard(['analysis']);await tick();a.set('analysis',{note:'new'});gate.resolve({revision:0});await assert.rejects(deleting,/changé/);
 assert.equal(a.get('analysis').note,'new');assert.equal(a.info('analysis').dirty,true);assert.equal(a.items.get('analysis').revision,0);
 const gate2=deferred();a.request=async(url,opts)=>!opts?{items:[]}:gate2.promise;const second=a.discard(['analysis']);await tick();await a.open('bob');a.set('analysis',{note:'bob'});gate2.resolve({revision:0});await assert.rejects(second,{message:'L’espace ouvert a changé.'});assert.equal(a.get('analysis').note,'bob');a.close();
});
test('local-only discard works without any server request and waits behind an existing write',async()=>{
 const a=await store();a.set('a',{note:1});a.set('b',{note:2});await a.discard(['a']);assert.equal(a.get('a'),null);assert.equal(a.get('b').note,2);a.close();
 const gate=deferred(),calls=[],b=await store(async(url,opts)=>{if(!opts)return {items:[]};calls.push({url,method:opts.method});return opts.method==='PUT'?gate.promise:{revision:0};},true);
 b.set('analysis',{note:1});const writing=b.flush();await tick();const deleting=b.discard(['analysis']);assert.equal(calls.length,1);gate.resolve({revision:20});await Promise.all([writing,deleting]);assert.equal(calls[1].url,'/api/workspace/analysis?expected_revision=20');assert.equal(b.get('analysis'),null);b.close();
});

test('a partially deleted local copy cannot be silently replaced by a new remote document',async()=>{
 const storage=memory(),a=await store(async(url,opts)=>{
  if(url==='/api/workspace')return {items:[{key:'document:a',revision:5,data:{note:'local'}},{key:'annotation:a',revision:6,data:{note:'notes'}}]};
  if(url.includes('annotation'))throw Error('offline');return {revision:0};
 },true,storage);
 await assert.rejects(a.discard(['document:a','annotation:a']),/offline/);assert.equal(a.info('document:a').saved,false);assert.match(a.info('document:a').error,/incomplète/);a.close();
 const b=await store(async()=>({items:[{key:'document:a',revision:8,data:{note:'different remote'}},{key:'annotation:a',revision:6,data:{note:'notes'}}]}),true,storage);
 assert.equal(b.get('document:a').note,'local');assert.equal(b.info('document:a').conflict.data.note,'different remote');b.close();
});
