import test from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage} from '../static/i18n.js';
import {engineManagerSettingsHtml,engineEntryPayload,engineSelectionPayload,engineRolesHtml,installedEnginesHtml,engineCatalogHtml,engineJobHtml,engineUpdatesHtml,bindEngineManager} from '../static/engine-manager.js';
import {globalSettingsHtml} from '../static/settings-page.js';

const native={id:'sf',name:'Stockfish 18',kind:'uci',path:'C:/engines/sf.exe',available:true,active:['analysis'],managed:false,version:'18'};
const human={id:'m3',name:'Maia 3',kind:'maia',available:true,active:['maia'],managed:true};
const catalog={engines:[native,human],selected:{analysis:'sf',maia:'m3'},catalog:[{id:'stockfish-latest',name:'Stockfish',available:true,version:'18',description:'Official',license:'GPL-3.0'}],job:null};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function host(){
 const parts=new Map();
 const part=selector=>{if(!parts.has(selector))parts.set(selector,{innerHTML:'',textContent:'',disabled:false,classList:{toggle(){}},querySelector:child=>part(selector+' '+child)});return parts.get(selector);};
 const root={innerHTML:'',querySelector:part,querySelectorAll:()=>[],closest:()=>({hidden:false})};
 return {root,parts,querySelector:()=>root};
}

test('engine management is a capability-gated settings tab',()=>{
 setLanguage('fr');assert.match(engineManagerSettingsHtml(),/id="engine-manager-settings"/);
 assert.doesNotMatch(globalSettingsHtml(),/data-settings-tab="engines"/);
 assert.match(globalSettingsHtml({status:{capabilities:{engine_management:true}}}),/data-settings-tab="engines"/);
 setLanguage('en');assert.match(engineManagerSettingsHtml(),/>Engines</);setLanguage('fr');
});
test('paths are values, never shell commands, and disabled roles are explicit',()=>{
 const path=' C:/my engine/tool.exe ';
 assert.deepEqual(engineEntryPayload(new Map([['name',' Engine '],['path',path]])),{name:'Engine',path:path.trim()});
 assert.deepEqual(engineSelectionPayload(new Map([['analysis','sf'],['maia','']])),{analysis:'sf',maia:null});
});
test('role selectors separate native analysis from human models and disable missing choices',()=>{
 const html=engineRolesHtml({...catalog,engines:[...catalog.engines,{id:'missing',name:'Lost',kind:'uci',available:false}]});
 const [analysis,maia]=html.split('</label>');assert.match(analysis,/value="sf" selected/);assert.doesNotMatch(analysis,/value="m3"/);assert.match(analysis,/value="missing" disabled/);
 assert.match(maia,/value="m3" selected/);assert.doesNotMatch(maia,/value="sf"/);
});
test('active engine removal is blocked, inactive removal requires confirmation and keeps files',()=>{
 const active=installedEnginesHtml([native]);assert.match(active,/data-engine-remove="sf" disabled/);assert.match(active,/data-engine-confirm="sf" hidden/);assert.match(active,/fichiers restent sur le disque/);
 const inactive=installedEnginesHtml([{...native,active:[]}]);assert.doesNotMatch(inactive,/data-engine-remove="sf" disabled/);assert.match(inactive,/data-engine-delete="sf"/);
});
test('user-defined engine names and paths stay escaped and untranslated',()=>{
 setLanguage('en');const html=installedEnginesHtml([{...native,name:'Moteurs <img src=x>',path:'C:/"<script>evil'}]);
 assert.match(html,/Moteurs &lt;img src=x&gt;/);assert.match(html,/C:\/&quot;&lt;script&gt;evil/);assert.doesNotMatch(html,/<img|<script/);assert.match(html,/Analysis and classic play/);setLanguage('fr');
});
test('managed installations rename without exposing a replaceable binary path',()=>{
 assert.match(installedEnginesHtml([native]),/name="path"/);
 assert.doesNotMatch(installedEnginesHtml([{...native,managed:true}]),/name="path"/);
 assert.doesNotMatch(installedEnginesHtml([human]),/name="path"/);
});
test('catalogue prevents overlapping installations and escapes external metadata',()=>{
 const html=engineCatalogHtml([{id:'a',name:'<bad>',available:true,description:'<script>not HTML</script>',download_bytes:2097152,license:'GPL'}],{state:'running'});
 assert.match(html,/data-engine-install="a" disabled/);assert.match(html,/&lt;bad&gt;/);assert.match(html,/2 Mo à télécharger/);assert.doesNotMatch(html,/<script>/);
 assert.match(engineCatalogHtml([{id:'off',name:'Off',available:false}]),/data-engine-install="off" disabled/);
});
test('job states show bounded progress, completion activation hint, and escaped failure',()=>{
 assert.match(engineJobHtml({state:'running',progress:150,stage:'<download>'}),/value="100"/);
 assert.match(engineJobHtml({state:'running',progress:-5}),/value="0"/);
 assert.match(engineJobHtml({state:'completed'}),/Sélectionne-le/);
 assert.match(engineJobHtml({state:'failed',error:'<bad>'}),/&lt;bad&gt;/);
 assert.doesNotMatch(engineJobHtml({state:'failed'}),/<progress/);
});
test('updates distinguish validated catalogue from upstream Maia changes',()=>{
 setLanguage('en');const html=engineUpdatesHtml({stockfish:{version:'19'},maia3:{version:'79M',new_upstream:true},errors:['<timeout>']});
 assert.match(html,/versions validated for ChessGym/);assert.match(html,/&lt;timeout&gt;/);setLanguage('fr');
});
test('dispose aborts loading and ignores late catalogue responses',async()=>{
 const page=host();let resolve,signal;const binding=bindEngineManager(page,{request:async(url,options)=>{signal=options.signal;return new Promise(done=>resolve=done);}});
 const html=page.root.innerHTML;binding.dispose();assert(signal.aborted);resolve(catalog);await tick();assert.equal(page.root.innerHTML,html);assert.equal(page.parts.get('[data-engine-list]'),undefined);assert.equal(page.root.onclick,null);
});
test('installation polling stops on disposal without erasing forms',async()=>{
 const page=host();let releaseJob,jobStarted;const started=new Promise(resolve=>jobStarted=resolve),calls=[];let changes=0;
 const binding=bindEngineManager(page,{pollMs:1,onChanged:()=>changes++,request:async(url)=>{calls.push(url);if(url.endsWith('/catalog'))return {...catalog,job:{id:'j',state:'running',progress:10}};jobStarted();return new Promise(resolve=>releaseJob=resolve);}});
 await started;const html=page.root.innerHTML;binding.dispose();releaseJob({id:'j',state:'completed'});await tick();assert.equal(page.root.innerHTML,html);assert.equal(changes,0);assert.deepEqual(calls,['/api/engines/catalog','/api/engines/jobs/j']);
});
test('leaving the settings page blocks stale callbacks even before disposal',async()=>{
 const page=host();let resolve,current=true;bindEngineManager(page,{isCurrent:()=>current,request:()=>new Promise(done=>resolve=done)});
 current=false;resolve(catalog);await tick();assert.equal(page.parts.get('[data-engine-list]'),undefined);
});
test('an asynchronous engine-status refresh failure is handled without an unhandled rejection',async()=>{
 const page=host();let loads=0,changed;const notified=new Promise(resolve=>changed=resolve);
 const binding=bindEngineManager(page,{pollMs:1,onChanged:async()=>{changed();throw new Error('Status temporarily unavailable');},request:async url=>url.endsWith('/catalog')?{...catalog,job:{id:'j',state:loads++?'completed':'running'}}:{id:'j',state:'completed'}});
 await notified;await tick();assert.equal(page.parts.get('[data-engine-result]').textContent,'Status temporarily unavailable');binding.dispose();
});
