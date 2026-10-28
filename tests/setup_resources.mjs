import test from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage} from '../static/i18n.js';
import {globalSettingsHtml} from '../static/settings-page.js';
import {setupResourceSelection,setupResourcePayload,setupReferenceImportPayload,setupResourcesSettingsHtml,setupResourceCardsHtml,setupResourceJobHtml,setupExamplesHtml,bindSetupResources as bindResources} from '../static/setup-resources.js';

const resources=[
 {id:'stockfish-latest',name:'Stockfish',available:true,installed:false,source_url:'https://github.com/official-stockfish/Stockfish',download_bytes:10485760},
 {id:'maia3-79m',name:'Maia 3 · 79M',available:true,installed:false},
 {id:'maia3-5m',name:'Maia 3 · 5M',available:true,installed:false},
 {id:'lichess-puzzles',name:'Problèmes Lichess',available:true,installed:false},
 {id:'lichess-games',name:'Parties de tournois Lichess',available:true,installed:false},
];
const snapshot={resources,settings:{automatic_updates:false,interval_hours:168},setup_complete:false,job:null};
const lumbra=[
 {id:'lumbra-otb-elite',name:'Lumbra OTB Elite — maîtres 2400+',category:'database',installation_mode:'browser-download',available:true,installed:false,source_url:'https://lumbrasgigabase.com/lgb-file/11049/',download_page:'https://lumbrasgigabase.com/en/download-area-en/',license:'CC BY-NC 4.0',license_url:'https://creativecommons.org/licenses/by-nc/4.0/',download_bytes:196.27*1048576},
 {id:'lumbra-otb-complete',name:'Lumbra Gigabase OTB — complète',category:'database',installation_mode:'browser-download',available:true,installed:false,source_url:'https://lumbrasgigabase.com/lgb-file/11047/',download_page:'https://lumbrasgigabase.com/en/download-area-en/',license:'CC BY-NC 4.0'},
];
const examples={ok:true,installed:false,bases:[],examples:['repertoire','guess','reading'].map(key=>({key,base_id:null})),license:'CC0-1.0'};
const readyExamples={...examples,installed:true,bases:[1,2,3],examples:examples.examples.map((item,i)=>({...item,base_id:i+1}))};
const bindSetupResources=(page,options={})=>bindResources(page,{...options,request:(url,init)=>url==='/api/demo'?Promise.resolve(examples):options.request(url,init)});
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function host(){
 const parts=new Map(),inputs=[];
 const part=selector=>{if(!parts.has(selector))parts.set(selector,{innerHTML:'',textContent:'',disabled:false,checked:false,classList:{toggle(){}},querySelector:child=>part(selector+' '+child)});return parts.get(selector);};
 const root={innerHTML:'',querySelector:part,querySelectorAll:selector=>selector.includes(':checked')?inputs.filter(input=>input.checked):inputs};
 return {root,parts,inputs,querySelector:()=>root};
}
function submit(page,selector){let prevented=false;page.root.onsubmit({target:{matches:value=>value.split(',').includes(selector)},preventDefault(){prevented=true;}});assert(prevented);}
function click(page,key){page.root.onclick({target:{closest:()=>({disabled:false,dataset:{[key]:''}})}});}
function importClick(page,id){page.root.onclick({target:{closest:()=>({disabled:false,dataset:{setupImport:id}})}});}

test('setup is exposed through the owner capability without forcing all accounts into installation',()=>{
 assert.doesNotMatch(globalSettingsHtml(),/data-settings-tab="installation"/);
 assert.match(globalSettingsHtml({status:{capabilities:{setup_resources:true}}}),/data-settings-tab="installation"/);
});
test('first setup selects only missing Stockfish, leaving Maia and databases optional',()=>{
 assert.deepEqual(setupResourceSelection(resources),['stockfish-latest']);
 assert.deepEqual(setupResourceSelection(resources.map(item=>({...item,installed:item.id==='maia3-5m'}))),['stockfish-latest']);
 assert.deepEqual(setupResourceSelection(resources.map(item=>({...item,installed:item.id==='stockfish-latest',available:item.id!=='maia3-79m'}))),[]);
 assert.deepEqual(setupResourcePayload({getAll:()=>['lichess-puzzles','lichess-puzzles','maia3-5m']}),{resources:['lichess-puzzles','maia3-5m']});
});
test('cards escape metadata and source URLs and show optional database storage cost',()=>{
 const html=setupResourceCardsHtml([...resources,{id:'bad',name:'<script>bad</script>',description:'<img src=x>',available:false,source_url:'javascript:alert(1)'}],['stockfish-latest']);
 assert.match(html,/value="stockfish-latest" checked/);assert.match(html,/10 Mo à télécharger/);assert.match(html,/plusieurs Go/);assert.match(html,/base de référence/);
 assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.match(html,/value="bad" disabled/);assert.doesNotMatch(html,/<script>|<img|javascript:/);
 assert.match(setupResourceCardsHtml(resources,[],true),/value="maia3-79m" disabled/);
});
test('progress and partial errors are bounded, escaped, and attributed to their resource',()=>{
 assert.match(setupResourceJobHtml({state:'running',progress:400,stage:'<download>'}),/value="100"/);
 const html=setupResourceJobHtml({state:'failed',error:'<failure>',results:[{id:'lichess-puzzles',state:'failed',error:'<offline>'},{id:'stockfish-latest',state:'completed'}]},resources);
 assert.match(html,/Problèmes Lichess/);assert.match(html,/&lt;offline&gt;/);assert.match(html,/Stockfish/);assert.doesNotMatch(html,/<progress|<failure>/);
});
test('setup and weekly automation are bilingual',async()=>{
 setLanguage('en');assert.match(setupResourcesSettingsHtml(),/Engines and databases/);
 const page=host(),binding=bindSetupResources(page,{request:async()=>snapshot});await tick();
 assert.match(page.root.innerHTML,/Update automatically every week/);assert.match(page.root.innerHTML,/Download and configure/);assert.match(setupResourceCardsHtml(resources),/several GB/);binding.dispose();setLanguage('fr');
});
test('installation submits the selected engines and polls the shared server job through completion',async()=>{
 const page=host(),calls=[];let loads=0,changes=0;
 const binding=bindSetupResources(page,{pollMs:1,onChanged:()=>changes++,request:async(url,options)=>{
  calls.push({url,options});
  if(url.endsWith('/install'))return {id:'j',state:'running',progress:0};
  loads++;return loads===1?snapshot:{...snapshot,job:{id:'j',state:'completed',results:[{id:'stockfish-latest',state:'completed'}]}};
 }});
 await tick();submit(page,'[data-setup-install]');await new Promise(resolve=>setTimeout(resolve,15));
 assert.deepEqual(calls.find(item=>item.url.endsWith('/install')).options.body,{resources:['stockfish-latest']});
 assert.equal(changes,1);assert.match(page.parts.get('[data-setup-job]').innerHTML,/Préparation terminée/);assert.equal(page.parts.get('[data-setup-install-button]').disabled,true);binding.dispose();
});
test('choosing a lighter Maia deselects the other model without dropping the database choice',async()=>{
 const page=host(),calls=[],binding=bindSetupResources(page,{request:async(url,options)=>{calls.push({url,options});return url.endsWith('/install')?{id:'j',state:'running'}:snapshot;}});
 await tick();page.inputs.push({name:'resource',value:'maia3-79m',checked:true},{name:'resource',value:'maia3-5m',checked:true},{name:'resource',value:'lichess-puzzles',checked:true});
 page.root.onchange({target:page.inputs[1]});assert.equal(page.inputs[0].checked,false);submit(page,'[data-setup-install]');await tick();
 assert.deepEqual(calls.find(item=>item.url.endsWith('/install')).options.body,{resources:['maia3-5m','lichess-puzzles']});binding.dispose();
});
test('automatic updates require an explicit save and retain edited preference through polling',async()=>{
 const page=host(),calls=[];let loads=0;
 const binding=bindSetupResources(page,{pollMs:1,request:async(url,options)=>{calls.push({url,options});if(url.endsWith('/settings'))return {automatic_updates:true};return {...snapshot,settings:{...snapshot.settings,automatic_updates:loads>1},job:loads++===0?{id:'j',state:'running'}:null};}});
 await tick();const checkbox=page.parts.get('[data-setup-settings] input');checkbox.checked=true;page.root.onchange({target:{name:'automatic_updates'}});
 await new Promise(resolve=>setTimeout(resolve,10));assert.equal(checkbox.checked,true);assert(!calls.some(item=>item.url.endsWith('/settings')));
 submit(page,'[data-setup-settings]');await tick();assert.deepEqual(calls.find(item=>item.url.endsWith('/settings')).options.body,{automatic_updates:true,interval_hours:168});binding.dispose();
});
test('update and skip are separate actions and skipping launches no downloads',async()=>{
 const page=host(),calls=[];let completed=0;
 const binding=bindSetupResources(page,{request:async(url,options)=>{calls.push({url,options});return snapshot;},onComplete:()=>completed++});
 await tick();click(page,'setupComplete');await tick();assert.equal(completed,1);assert.deepEqual(calls.map(item=>item.url),['/api/setup-resources','/api/setup-resources/complete']);binding.dispose();
});
test('disposing aborts requests and ignores late loading and completion callbacks',async()=>{
 const page=host();let resolve,signal;
 const binding=bindSetupResources(page,{request:async(url,options)=>{signal=options.signal;return new Promise(done=>resolve=done);}});
 const markup=page.root.innerHTML;binding.dispose();resolve(snapshot);await tick();assert(signal.aborted);assert.equal(page.root.innerHTML,markup);assert.equal(page.parts.get('[data-setup-resources]'),undefined);assert.equal(page.root.onclick,null);
});
test('a failed start refreshes server state so an already accepted job can continue polling',async()=>{
 const page=host();let loads=0;
 const binding=bindSetupResources(page,{pollMs:1000,request:async url=>{if(url.endsWith('/install'))throw new Error('Connection interrupted');return loads++?{...snapshot,job:{id:'j',state:'running'}}:snapshot;}});
 await tick();submit(page,'[data-setup-install]');await tick();assert.match(page.parts.get('[data-setup-job]').innerHTML,/Préparation en cours/);assert.equal(page.parts.get('[data-setup-install-button]').disabled,true);assert.equal(page.parts.get('[data-setup-result]').textContent,'Connection interrupted');binding.dispose();
});
test('engine activation deferrals and preserved choices are explicit in installation results',()=>{
 const pending=setupResourceJobHtml({state:'completed',results:[{id:'stockfish-latest',state:'completed',engine_id:'sf',activation_pending:true}]},resources);
 const preserved=setupResourceJobHtml({state:'completed',results:[{id:'maia3-79m',state:'completed',engine_id:'maia',activated:false}]},resources);
 assert.match(pending,/activation après le calcul/);assert.match(preserved,/sélection actuelle conservée/);
 setLanguage('en');assert.match(setupResourceJobHtml({state:'running',stage:'Préparation de stockfish-latest'},resources),/Preparing Stockfish/);assert.match(setupResourceJobHtml({state:'running',stage:'Indexation : 3,000 parties'},resources),/Indexing: 3,000 games/);setLanguage('fr');
});
test('Maia model size explicitly excludes the separately installed runtime components',()=>{
 const cards=[{id:'maia3-79m',name:'Maia',available:true,download_bytes:10485760}];
 assert.match(setupResourceCardsHtml(cards),/10 Mo pour le modèle; composants supplémentaires au besoin/);
 setLanguage('en');assert.match(setupResourceCardsHtml(cards),/10 MB for the model; additional components may be needed/);setLanguage('fr');
});

test('Lumbra cards provide an official browser download and separate reference import with its license',()=>{
 const html=setupResourceCardsHtml(lumbra,['lumbra-otb-elite']);
 assert.match(html,/Base facultative/);assert.doesNotMatch(html,/name="resource"|Base facultative[^]*Moteur/);
 assert.match(html,/href="https:\/\/lumbrasgigabase.com\/en\/download-area-en\/"/);
 assert.match(html,/Télécharger sur Lumbra/);assert.match(html,/CC BY-NC 4.0/);assert.match(html,/Michael Jansen/);
 assert.match(html,/href="https:\/\/creativecommons.org\/licenses\/by-nc\/4.0\/"/);
 assert.match(html,/data-lumbra-path="lumbra-otb-elite"/);assert.match(html,/data-setup-import="lumbra-otb-complete"/);
 assert.match(html,/data-lumbra-masters="lumbra-otb-elite">/);assert.doesNotMatch(html,/data-lumbra-masters="lumbra-otb-complete"| checked/);
 assert.match(html,/environ 196 Mo/);assert.match(html,/mises à jour automatiques ne les remplacent pas/);
 const noExtractor=setupResourceCardsHtml([{...lumbra[0],seven_zip_available:false}]);assert.match(noExtractor,/7-Zip n’est pas détecté/);assert.doesNotMatch(noExtractor,/ disabled/);
 setLanguage('en');const translated=setupResourceCardsHtml(lumbra);assert.match(translated,/Import downloaded database/);assert.match(translated,/Use as the master reference database/);setLanguage('fr');
});

test('external download links reject credentials, lookalike domains, script URLs, and arbitrary license origins',()=>{
 for(const url of ['javascript:alert(1)','https://lumbrasgigabase.com.evil.test/file','https://user:secret@lumbrasgigabase.com/file','https://lumbrasgigabase.com:444/file']){
  const html=setupResourceCardsHtml([{...lumbra[0],source_url:url,download_page:url,license_url:url,license:'<img src=x>'}]);
  assert.doesNotMatch(html,/<a |<img|secret|javascript:|evil\.test/);assert.match(html,/&lt;img src=x&gt;/);
 }
});

test('Lumbra never enters grouped engine installation even with a stale checked input',async()=>{
 const page=host(),calls=[],binding=bindSetupResources(page,{request:async(url,options)=>{calls.push({url,options});return url.endsWith('/install')?{state:'running'}:{...snapshot,resources:[...resources,...lumbra]};}});
 await tick();page.inputs.push({name:'resource',value:'lumbra-otb-elite',checked:true},{name:'resource',value:'stockfish-latest',checked:true});
 page.root.onchange({target:page.inputs[0]});submit(page,'[data-setup-install]');await tick();
 assert.deepEqual(calls.find(item=>item.url.endsWith('/install')).options.body,{resources:['stockfish-latest']});binding.dispose();
});

test('reference import requires a file and only sets masters when explicitly checked',async()=>{
 assert.deepEqual(setupReferenceImportPayload('lumbra-otb-elite','  C:\\Downloads\\elite.7z  '),{resource_id:'lumbra-otb-elite',source_path:'C:\\Downloads\\elite.7z',use_as_masters:false});
 for(const useMasters of [false,true]){
  const page=host(),calls=[],binding=bindSetupResources(page,{request:async(url,options)=>{calls.push({url,options});return url.endsWith('/import')?{state:'running'}:{...snapshot,resources:lumbra};}});
  await tick();importClick(page,'lumbra-otb-elite');await tick();assert(!calls.some(item=>item.url.endsWith('/import')));assert.match(page.parts.get('[data-setup-result]').textContent,/chemin du fichier/);
  page.parts.get('[data-lumbra-path="lumbra-otb-elite"]').value='  C:\\Downloads\\elite.7z  ';
  page.parts.get('[data-lumbra-masters="lumbra-otb-elite"]').checked=useMasters;
  importClick(page,'lumbra-otb-elite');await tick();
  assert.deepEqual(calls.find(item=>item.url.endsWith('/import')).options.body,{resource_id:'lumbra-otb-elite',source_path:'C:\\Downloads\\elite.7z',use_as_masters:useMasters});
  importClick(page,'lumbra-otb-elite');await tick();assert.equal(calls.filter(item=>item.url.endsWith('/import')).length,1);binding.dispose();
 }
});

test('Lumbra file selection survives refresh and automatic update excludes browser-only installations',async()=>{
 const page=host(),binding=bindSetupResources(page,{request:async()=>({...snapshot,resources:lumbra.map(item=>({...item,installed:true}))})});
 await tick();assert.equal(page.parts.get('[data-setup-update]').disabled,true);
 page.root.oninput({target:{dataset:{lumbraPath:'lumbra-otb-elite'},value:'C:\\My files\\elite.7z'}});
 page.root.onchange({target:{dataset:{lumbraMasters:'lumbra-otb-elite'},checked:true}});
 await binding.refresh();const html=page.parts.get('[data-setup-resources]').innerHTML;
 assert.match(html,/value="C:\\My files\\elite.7z"/);assert.match(html,/data-lumbra-masters="lumbra-otb-elite" checked/);binding.dispose();
});

test('starter examples display available activities and escape failed request text',()=>{
 const empty=setupExamplesHtml(examples);assert.match(empty,/data-setup-examples-add/);assert.doesNotMatch(empty,/data-setup-example=/);
 const ready=setupExamplesHtml(readyExamples);assert.doesNotMatch(ready,/data-setup-examples-add/);
 for(const page of ['repertoire','guess','reading'])assert.match(ready,new RegExp('data-setup-example="'+page+'"'));
 assert.match(ready,/Stockfish est nécessaire/);assert.match(ready,/CC0/);
 assert.doesNotMatch(setupExamplesHtml(null,'<img src=x>'),/<img/);
 setLanguage('en');assert.match(setupExamplesHtml(readyExamples),/Try ChessGym in a few minutes/);assert.match(setupExamplesHtml(readyExamples),/Open Reading/);setLanguage('fr');
});

test('examples load read-only, install explicitly, refresh the library and open the chosen activity',async()=>{
 const page=host(),calls=[];let changes=0,destination=null;
 const binding=bindResources(page,{onChanged:()=>changes++,onComplete:page=>destination=page,request:async(url,options)=>{
  calls.push({url,options});if(url==='/api/demo')return options.method==='POST'?readyExamples:examples;return snapshot;
 }});
 await tick();assert(calls.every(call=>!call.options.method));assert.match(page.parts.get('[data-setup-examples]').innerHTML,/data-setup-examples-add/);
 click(page,'setupExamplesAdd');await tick();assert.equal(changes,1);assert.equal(calls.filter(call=>call.url==='/api/demo'&&call.options.method==='POST').length,1);
 assert.match(page.parts.get('[data-setup-examples]').innerHTML,/data-setup-example="reading"/);
 page.root.onclick({target:{closest:()=>({disabled:false,dataset:{setupExample:'reading'}})}});await tick();
 assert.equal(destination,'reading');assert(calls.some(call=>call.url.endsWith('/complete')));assert(!calls.some(call=>call.url.endsWith('/install')));binding.dispose();
});

test('unavailable examples can be retried without disabling resource setup',async()=>{
 const page=host();let attempts=0;
 const binding=bindResources(page,{request:async url=>{if(url==='/api/demo'){if(!attempts++)throw Error('Examples unavailable');return examples;}return snapshot;}});
 await tick();assert.match(page.parts.get('[data-setup-examples]').innerHTML,/Examples unavailable/);assert.equal(page.parts.get('[data-setup-install-button]').disabled,false);
 click(page,'setupExamplesRetry');await tick();assert.match(page.parts.get('[data-setup-examples]').innerHTML,/data-setup-examples-add/);assert.equal(attempts,2);binding.dispose();
});

test('an older examples read cannot overwrite a successful installation',async()=>{
 const page=host();let reads=0,finishStaleRead;
 const binding=bindResources(page,{request:async(url,options)=>{
  if(url!=='/api/demo')return snapshot;
  if(options.method==='POST')return readyExamples;
  if(++reads===1)return examples;
  return new Promise(resolve=>{finishStaleRead=resolve;});
 }});
 await tick();const refresh=binding.refresh();await tick();assert.equal(typeof finishStaleRead,'function');
 click(page,'setupExamplesAdd');await tick();assert.match(page.parts.get('[data-setup-examples]').innerHTML,/data-setup-example="reading"/);
 finishStaleRead(examples);await refresh;
 assert.match(page.parts.get('[data-setup-examples]').innerHTML,/data-setup-example="reading"/);assert.doesNotMatch(page.parts.get('[data-setup-examples]').innerHTML,/data-setup-examples-add/);binding.dispose();
});

test('disabled example activities open the library without offering to reinstall them',async()=>{
 const disabled={...readyExamples,examples:readyExamples.examples.map(item=>({...item,mode_enabled:false}))};
 const html=setupExamplesHtml(disabled);assert.doesNotMatch(html,/data-setup-example="(?:reading|guess|repertoire)"|data-setup-examples-add/);
 assert.equal((html.match(/data-setup-example="library"/g)||[]).length,3);
 const page=host();let destination=null;
 const binding=bindResources(page,{onComplete:value=>destination=value,request:async url=>url==='/api/demo'?disabled:snapshot});
 await tick();page.root.onclick({target:{closest:()=>({disabled:false,dataset:{setupExample:'library'}})}});await tick();assert.equal(destination,'library');binding.dispose();
});
