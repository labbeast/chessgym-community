import assert from 'node:assert/strict';
import {OpeningExplorer,ExplorerConnection,explorerRowsHtml,explorerSettingsHtml,resultsHtml} from '../static/explorer.js';
import {setLanguage} from '../static/i18n.js';
const defaults={source:'lichess',base_ids:[],speeds:['rapid'],ratings:[1600,1800],master_source:'masters',master_base_ids:[],engine_depth:null,repertoire_color:'white',show_probability:true};
const dataset={status:'ok',label:'Joueurs Lichess',total:100,white:50,draws:10,black:40,unknown:0,cached:false,stale:false};
function data(fen='start',extra={}){return {fen,settings:{...defaults},primary:{...dataset},masters:{...dataset,label:'Maîtres Lichess'},moves:[{uci:'e2e4',san:'e4',total:60,frequency:60,white:30,draws:6,black:24,unknown:0,master_total:40,master_frequency:40}],...extra};}
const settle=async()=>{for(let i=0;i<25;i++)await Promise.resolve();};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Host{
 constructor(){this.innerHTML='';this.handlers={};this.classList={add(){}};}
 set innerHTML(value){
  this.html=value;this.renders=(this.renders||0)+1;
  this.cells=[...value.matchAll(/data-explorer-evaluation="([^"]+)" data-state="([^"]+)" title="([^"]*)">([^<]*)/g)].map(m=>({dataset:{explorerEvaluation:m[1],state:m[2]},title:m[3],textContent:m[4]}));
  this.evaluationButton={textContent:'',attributes:{},setAttribute(name,value){this.attributes[name]=value;}};this.evaluationStatus={textContent:''};this.table={scrollTop:0};this.moveButton={focused:false};
 }
 get innerHTML(){return this.html;}
 querySelectorAll(selector){return selector==='[data-explorer-evaluation]'?this.cells:[];}
 querySelector(selector){return selector==='[data-explorer-action="evaluation"]'?this.evaluationButton:selector==='[data-explorer-evaluation-status]'?this.evaluationStatus:null;}
 addEventListener(type,fn){this.handlers[type]=fn;}
 removeEventListener(type,fn){if(this.handlers[type]===fn)delete this.handlers[type];}
 contains(){return true;}
}
class ConnectionHost extends Host{
 set innerHTML(value){this.html=value;this.input=value.includes('data-explorer-token')?{value:'',disabled:false}:null;this.errorElement={textContent:'',hidden:true};this.buttons=[...value.matchAll(/data-connection-action="([^"]+)"/g)].map(m=>({dataset:{connectionAction:m[1]},disabled:false}));}
 get innerHTML(){return this.html;}
 querySelector(selector){return selector==='[data-explorer-token]'?this.input:selector==='[data-connection-error]'?this.errorElement:null;}
 querySelectorAll(){return [...this.buttons,...(this.input?[this.input]:[])];}
}
const requests=[],evaluationRequests=[];let manualEvaluations=false;
globalThis.fetch=async(url,options={})=>{
 if(url==='/api/explorer/evaluate'){
  const body=JSON.parse(options.body),payload=manualEvaluations?await new Promise(resolve=>evaluationRequests.push({url,options,resolve})): {...body,cp:25,mate:null,depth:15,engine:'Stockfish 18',cached:false};
  return {ok:!payload.error,status:payload.error?(payload.status||503):200,headers:{get:()=> 'application/json'},json:async()=>payload.error?{detail:payload.error}:payload};
 }
 if(url==='/api/explorer/settings'&&options.method!=='PATCH')return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>structuredClone(defaults)};
 const payload=await new Promise(resolve=>requests.push({url,options,resolve}));
 return {ok:!payload.error,status:payload.error?503:200,headers:{get:()=> 'application/json'},json:async()=>payload.error?{detail:payload.error}:payload};
};
async function create(options={}){const host=new Host(),board={fen:'start',busy:false,inputLocked:false,disposed:false,legal:['e2e4'],calls:[],node(){return {fen:this.fen};},async tryMove(...args){this.calls.push(args);return true;}};const explorer=new OpeningExplorer(host,{board,...options});await explorer.ready;await settle();return {host,board,explorer};}
async function createConnection(metadata={configured:false,source:null},options={}){
 const host=new ConnectionHost(),connection=new ExplorerConnection(host,options),pending=requests.at(-1);assert.equal(pending.url,'/api/explorer/connection');pending.resolve(metadata);await connection.ready;return {host,connection};
}

function installSettingsDialog(){
 const notices=[];
 class Dialog{
  constructor(){this.open=false;this.listeners=[];this.classList={toggle(){}};}
  set innerHTML(value){
   this.html=value;const connectionHost=new ConnectionHost(),submit={disabled:false},depthLabel={hidden:false};
   const selected=name=>new RegExp('<select name="'+name+'">([\\s\\S]*?)</select>').exec(value)?.[1].match(/<option value="([^"]+)" selected>/)?.[1];
   const input=/<input type="number" name="engine_depth"[^>]*value="([^"]+)"/.exec(value)?.[1];
   this.form={elements:{source:{value:selected('source')},master_source:{value:selected('master_source')},engine_mode:{value:selected('engine_mode')},engine_depth:{value:input},show_probability:{value:value.includes('name="show_probability" checked')?'on':null}},depthLabel,submit,querySelector:selector=>selector==='[data-explorer-connection]'?connectionHost:selector==='[type=submit]'?submit:null,querySelectorAll:selector=>selector==='[data-engine-depth]'?[depthLabel]:[]};
   this.form.checks={};for(const input of value.matchAll(/<input\b[^>]*>/g)){const name=input[0].match(/name="([^"]+)"/)?.[1],content=input[0].match(/value="([^"]*)"/)?.[1]??'';if(!name)continue;if(input[0].includes('type="checkbox"')){this.form.checks[name]??=[];if(/\bchecked\b/.test(input[0]))this.form.checks[name].push(content);}else if(input[0].includes('type="number"'))this.form.elements[name]={value:content};}
   this.form.groups=[...value.matchAll(/data-(source|reference)-settings="([^"]+)"/g)].map(match=>({dataset:{[match[1]+'Settings']:match[2]},hidden:false}));
   this.form.querySelectorAll=selector=>selector==='[data-engine-depth]'?[depthLabel]:selector==='[data-source-settings]'?this.form.groups.filter(group=>group.dataset.sourceSettings):selector==='[data-reference-settings]'?this.form.groups.filter(group=>group.dataset.referenceSettings):[];
  }
  querySelector(selector){return selector==='form'?this.form:selector==='[type=submit]'?this.form.submit:null;}
  querySelectorAll(){return [];}
  addEventListener(type,fn){if(type==='close')this.listeners.push(fn);}
  showModal(){this.open=true;}
  close(){this.open=false;const listeners=this.listeners;this.listeners=[];listeners.forEach(fn=>fn());}
 }
 const dialog=new Dialog();
 globalThis.document={body:{append(){}},getElementById:id=>id==='modal'?dialog:id==='notices'?{append:n=>notices.push(n.textContent)}:null,createElement:()=>({remove(){}})};
 globalThis.FormData=class{constructor(form){this.form=form;}get(key){const input=this.form.elements[key];return !input||input.disabled?null:input.value;}getAll(key){return this.form.checks[key]||[];}};
 return {dialog,notices};
}
async function openSettings(explorer,dialog){explorer.openSettings();requests.at(-1).resolve({configured:false,source:null});await explorer.connection.ready;assert.equal(dialog.open,true);return dialog.form;}
async function withPreparationClock(run){
 const original={timeout:globalThis.setTimeout,clear:globalThis.clearTimeout,now:Date.now,document:globalThis.document},timers=new Map();let now=1000,id=0;
 const handlers=new Map();globalThis.document={visibilityState:'visible',addEventListener:(name,fn)=>handlers.set(name,fn),removeEventListener:(name,fn)=>{if(handlers.get(name)===fn)handlers.delete(name);}};
 Date.now=()=>now;globalThis.setTimeout=(fn,delay)=>{timers.set(++id,{fn,at:now+delay});return id;};globalThis.clearTimeout=key=>timers.delete(key);
 try{await run({async tick(ms){now+=ms;for(const [key,value] of [...timers])if(value.at<=now){timers.delete(key);value.fn();await settle();}},async visibility(value){document.visibilityState=value;handlers.get('visibilitychange')?.();await settle();},timers,handlers});}
 finally{globalThis.setTimeout=original.timeout;globalThis.clearTimeout=original.clear;Date.now=original.now;globalThis.document=original.document;}
}
const preparingData=(fen='start',extra={})=>data(fen,{masters:{status:'preparing',reason:'preparing',retry_after:3,total:null,moves:[]},...extra});

const tests={
 async search_progress_tracks_loading_preparation_pause_retry_and_completion(){
  await withPreparationClock(async clock=>{
   const {host,explorer}=await create({settingsOverride:{show_probability:false}});
   assert.match(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/Recherche à cette position/);assert.match(host.innerHTML,/aria-busy="true"/);
   requests.at(-1).resolve(preparingData());await settle();
   assert.match(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/60 %/);assert.match(host.innerHTML,/aria-busy="true"/);
   await clock.tick(300000);
   assert.doesNotMatch(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/aria-busy="false"/);assert.match(host.innerHTML,/data-explorer-action="preparation-refresh"/);
   const refresh=explorer.refreshPreparation();assert.match(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/aria-busy="true"/);
   requests.at(-1).resolve(data());await refresh;
   assert.doesNotMatch(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/aria-busy="false"/);assert.match(host.innerHTML,/60 %/);explorer.dispose();
  });
 },
 async search_progress_clears_on_failure_and_hidden_view(){
  await withPreparationClock(async clock=>{
   const {host,explorer}=await create({settingsOverride:{show_probability:false}});
   requests.at(-1).resolve({error:'Unavailable'});await settle();
   assert.doesNotMatch(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/aria-busy="false"/);assert.match(host.innerHTML,/Réessayer/);
   explorer.update({immediate:true,force:true});requests.at(-1).resolve(preparingData());await settle();
   await clock.tick(3000);requests.at(-1).resolve({error:'Unavailable'});await settle();
   assert.doesNotMatch(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/aria-busy="false"/);assert.match(host.innerHTML,/Actualisation interrompue/);
   const refresh=explorer.refreshPreparation();requests.at(-1).resolve(preparingData());await refresh;
   assert.match(host.innerHTML,/class="search-progress/);explorer.setVisible(false);
   assert.doesNotMatch(host.innerHTML,/class="search-progress/);assert.match(host.innerHTML,/aria-busy="false"/);explorer.setVisible(true);
   assert.match(host.innerHTML,/class="search-progress/);explorer.dispose();
  });
 },
 async importing_frequency_rows_do_not_claim_unknown_outcomes(){
  const {host,explorer}=await create();const result=data();result.primary={...result.primary,complete:false,results_available:false,message:'Fréquences exactes des parties déjà importées. Les résultats de cette position très fréquente seront disponibles après la fin de l’importation.'};result.moves=result.moves.map(move=>({...move,white:0,draws:0,black:0,unknown:0,results_available:false}));requests.at(-1).resolve(result);await settle();assert.match(host.innerHTML,/class="explorer-frequency"[^>]*>60 %/);assert.match(host.innerHTML,/Résultats indisponibles pendant l’importation/);assert.doesNotMatch(host.innerHTML,/Aucun résultat connu|sans résultat|class="explorer-results"/);assert.match(host.innerHTML,/Fréquences exactes des parties déjà importées/);assert.match(host.innerHTML,/>Actualiser</);explorer.dispose();
 },
 async preparing_refresh_preserves_primary_and_scores_then_evaluates_added_moves(){
  await withPreparationClock(async clock=>{
   manualEvaluations=true;const {host,explorer}=await create({settingsOverride:{show_probability:false}});requests.at(-1).resolve(preparingData());await settle();assert.equal(evaluationRequests.length,1);evaluationRequests[0].resolve({uci:'e2e4',cp:31,mate:null,depth:18});await settle();const score=explorer.evaluations.get('e2e4'),sequence=explorer.sequence;
   assert.match(host.innerHTML,/explorer-preparing/);assert.doesNotMatch(host.innerHTML,/explorer-warning|Aucun résultat disponible/);assert.match(host.innerHTML,/60 %/);await clock.tick(3000);assert.equal(requests.filter(r=>r.url==='/api/explorer').length,2);assert.equal(explorer.data.primary.total,100);assert.equal(explorer.loading,false);assert.equal(explorer.evaluations.get('e2e4'),score);
   const complete=data();complete.moves.push({...complete.moves[0],uci:'d2d4',san:'d4',frequency:40,master_frequency:60});requests.at(-1).resolve(complete);await settle();assert.equal(explorer.sequence,sequence);assert.equal(explorer.evaluations.get('e2e4'),score);assert.equal(evaluationRequests.length,2);assert.equal(JSON.parse(evaluationRequests[1].options.body).uci,'d2d4');assert.doesNotMatch(host.innerHTML,/explorer-preparing/);const before=requests.length;await clock.tick(60000);assert.equal(requests.length,before);explorer.dispose();
  });
 },
 async preparing_primary_has_no_empty_result_and_failure_remains_distinct(){
  await withPreparationClock(async clock=>{
   const {host,explorer}=await create({settingsOverride:{show_probability:false}});requests.at(-1).resolve(preparingData('start',{primary:{status:'preparing',retry_after:3,total:null,moves:[]},moves:[]}));await settle();assert.doesNotMatch(host.innerHTML,/Aucun résultat|Aucun coup|explorer-warning/);assert.match(host.innerHTML,/Préparation des statistiques exactes/);
   await clock.tick(3000);requests.at(-1).resolve(data('start',{primary:{status:'unavailable',message:'Délai dépassé'},masters:{status:'disabled'},moves:[]}));await settle();assert.match(host.innerHTML,/explorer-warning/);assert.match(host.innerHTML,/Délai dépassé/);assert.match(host.innerHTML,/>Réessayer</);const before=requests.length;await clock.tick(60000);assert.equal(requests.length,before);explorer.dispose();
  });
 },
 async preparing_reference_does_not_claim_empty_and_translates_status(){
  await withPreparationClock(async()=>{
   setLanguage('en');const {host,explorer}=await create({settingsOverride:{show_probability:false}});requests.at(-1).resolve(preparingData('start',{primary:{...dataset,total:0},masters:{status:'preparing',retry_after:3,total:null,message:'Préparation des statistiques exactes de cette position. Elles apparaîtront automatiquement dès que le calcul sera terminé.'},moves:[]}));await settle();assert.doesNotMatch(host.innerHTML,/No results|No moves|Aucun résultat|Aucun coup|explorer-warning/);assert.match(host.innerHTML,/Preparing the exact statistics/);explorer.dispose();setLanguage('fr');
  });
 },
 async preparing_poll_stops_on_navigation_settings_collapse_hide_dispose(){
  for(const mode of ['navigation','settings','collapse','hide','dispose'])await withPreparationClock(async clock=>{
   const {board,explorer}=await create({settingsOverride:{show_probability:false}});requests.at(-1).resolve(preparingData());await settle();await clock.tick(3000);const stale=requests.at(-1);
   if(mode==='navigation'){board.fen='next';explorer.update({immediate:true});}
   else if(mode==='settings'){explorer.settings={...explorer.settings,ratings:[2200]};explorer.update({immediate:true});}
   else if(mode==='collapse')await explorer.click({target:{closest:selector=>selector==='[data-explorer-action]'?{dataset:{explorerAction:'collapse'}}:null}});
   else if(mode==='hide')explorer.setVisible(false);else explorer.dispose();
   assert.equal(stale.options.signal.aborted,true);const before=requests.length;stale.resolve(data('start',{primary:{...dataset,total:9999}}));await settle();assert.notEqual(explorer.data?.primary?.total,9999);await clock.tick(60000);assert.equal(requests.length,before);explorer.dispose();
  });
 },
 async preparing_browser_hidden_cancels_and_resumes_without_late_response(){
  await withPreparationClock(async clock=>{
   const {explorer}=await create({settingsOverride:{show_probability:false}});requests.at(-1).resolve(preparingData());await settle();await clock.tick(3000);const stale=requests.at(-1),before=requests.length;await clock.visibility('hidden');assert.equal(stale.options.signal.aborted,true);await clock.tick(20000);assert.equal(requests.length,before);await clock.visibility('visible');stale.resolve(data('start',{primary:{...dataset,total:9999}}));await settle();assert.equal(explorer.data.primary.total,100);await clock.tick(4500);assert.equal(requests.length,before+1);requests.at(-1).resolve(data());await settle();explorer.dispose();assert.equal(clock.handlers.size,0);
  });
 },
 async preparing_budget_pauses_and_manual_refresh_keeps_existing_data(){
  await withPreparationClock(async clock=>{
   const {host,explorer}=await create({settingsOverride:{show_probability:false}});requests.at(-1).resolve(preparingData());await settle();const score=explorer.evaluations.get('e2e4'),before=requests.length;await clock.tick(300000);assert.equal(requests.length,before);assert.equal(explorer.preparationPaused,true);assert.match(host.innerHTML,/La préparation continue sur le serveur/);assert.match(host.innerHTML,/data-explorer-action="preparation-refresh"/);assert.equal(explorer.evaluations.get('e2e4'),score);await clock.tick(60000);assert.equal(requests.length,before);
   const refreshed=explorer.click({target:{closest:selector=>selector==='[data-explorer-action]'?{dataset:{explorerAction:'preparation-refresh'}}:null}});assert.equal(requests.length,before+1);assert.equal(explorer.data.primary.total,100);assert.equal(explorer.evaluations.get('e2e4'),score);requests.at(-1).resolve(data());await refreshed;assert.equal(explorer.preparationPaused,false);explorer.dispose();
  });
 },
 async preparing_network_failure_retains_results_without_poll_loop(){
  await withPreparationClock(async clock=>{
   const {host,explorer}=await create({settingsOverride:{show_probability:false}});requests.at(-1).resolve(preparingData());await settle();await clock.tick(3000);requests.at(-1).resolve({error:'Unavailable'});await settle();assert.equal(explorer.data.primary.total,100);assert.match(host.innerHTML,/Actualisation interrompue/);assert.match(host.innerHTML,/60 %/);assert.doesNotMatch(host.innerHTML,/explorer-warning/);const before=requests.length;await clock.tick(60000);assert.equal(requests.length,before);explorer.dispose();
  });
 },
 async independent_local_filters_survive_source_switch_save_and_reopen(){
  const initial={...defaults,source:'local',base_ids:[7],master_source:'local',master_base_ids:[10],local_filters:{rating_min:1600,rating_max:1900,speeds:['rapid']},master_local_filters:{rating_min:2400,rating_max:null,speeds:['classical','unknown']},master_ratings:[2200],master_speeds:['blitz']};
  const {dialog}=installSettingsDialog(),{explorer}=await create({settingsOverride:initial,getBases:()=>[{id:7,name:'Parties'},{id:10,name:'Mega'}]});requests.at(-1).resolve(data('start',{settings:initial}));await settle();let form=await openSettings(explorer,dialog);
  assert.equal(form.elements.local_rating_min.value,'1600');assert.equal(form.elements.master_local_rating_min.value,'2400');assert.deepEqual(form.checks.local_speeds,['rapid']);assert.deepEqual(form.checks.master_local_speeds,['classical','unknown']);
  form.elements.local_rating_max.value='2000';form.elements.master_local_rating_min.value='2500';form.elements.source.value='masters';form.elements.master_source.value='lichess';form.elements.source.onchange();assert.equal(form.groups.find(g=>g.dataset.sourceSettings==='local').hidden,true);assert.equal(form.groups.find(g=>g.dataset.referenceSettings==='lichess').hidden,false);assert.equal(form.elements.local_rating_max.value,'2000');assert.equal(form.elements.master_local_rating_min.value,'2500');
  form.elements.master_source.value='none';form.elements.master_source.onchange();assert.ok(form.groups.filter(g=>g.dataset.referenceSettings).every(g=>g.hidden));assert.equal(form.elements.master_local_rating_min.value,'2500');
  form.elements.source.value='local';form.elements.master_source.value='local';form.elements.master_source.onchange();assert.equal(form.groups.find(g=>g.dataset.referenceSettings==='local').hidden,false);
  const submit=form.onsubmit({preventDefault(){},currentTarget:form}),patch=requests.at(-1),payload=JSON.parse(patch.options.body);assert.equal(patch.url,'/api/explorer/settings');assert.deepEqual(payload.local_filters,{rating_min:1600,rating_max:2000,speeds:['rapid']});assert.deepEqual(payload.master_local_filters,{rating_min:2500,rating_max:null,speeds:['classical','unknown']});assert.deepEqual(payload.master_ratings,[2200]);assert.deepEqual(payload.master_speeds,['blitz']);patch.resolve({...initial,...payload});await submit;
  const query=JSON.parse(requests.at(-1).options.body);assert.deepEqual(query.settings.local_filters,payload.local_filters);assert.deepEqual(query.settings.master_local_filters,payload.master_local_filters);requests.at(-1).resolve(data('start',{settings:explorer.settings}));await settle();form=await openSettings(explorer,dialog);assert.equal(form.elements.local_rating_max.value,'2000');assert.equal(form.elements.master_local_rating_min.value,'2500');assert.deepEqual(form.checks.master_local_speeds,['classical','unknown']);explorer.dispose();
 },
 async lichess_comparison_uses_own_ratings_speeds_and_reference_label(){
  const initial={...defaults,source:'local',base_ids:[7],master_source:'lichess',master_ratings:[2200],master_speeds:['blitz']};const {dialog}=installSettingsDialog(),{host,explorer}=await create({settingsOverride:initial,getBases:()=>[{id:7,name:'Local'}]});requests.at(-1).resolve(data('start',{settings:initial}));await settle();assert.match(host.innerHTML,/>Réf\.<\/th>/);assert.match(host.innerHTML,/href="https:\/\/lichess.org\/analysis"/);
  const form=await openSettings(explorer,dialog);form.checks.master_ratings=['2000','2200'];form.checks.master_speeds=['bullet','blitz'];const submit=form.onsubmit({preventDefault(){},currentTarget:form}),patch=requests.at(-1),payload=JSON.parse(patch.options.body);assert.deepEqual(payload.ratings,[1600,1800]);assert.deepEqual(payload.speeds,['rapid']);assert.deepEqual(payload.master_ratings,[2000,2200]);assert.deepEqual(payload.master_speeds,['bullet','blitz']);patch.resolve({...initial,...payload});await submit;requests.at(-1).resolve(data('start',{settings:explorer.settings}));await settle();explorer.dispose();
 },
 async local_empty_filters_mean_all_and_unknown_cadence_is_explicit(){
  const initial={...defaults,source:'local',base_ids:[7],master_source:'local',master_base_ids:[10]};const {dialog}=installSettingsDialog(),{explorer}=await create({settingsOverride:initial,getBases:()=>[{id:7,name:'Local'},{id:10,name:'Mega'}]});requests.at(-1).resolve(data('start',{settings:initial}));await settle();const form=await openSettings(explorer,dialog);assert.match(dialog.html,/Aucune coche = toutes les cadences/);assert.match(dialog.html,/name="master_local_speeds" value="unknown"/);assert.match(dialog.html,/Sans Elo, une partie est exclue/);assert.match(dialog.html,/cadence non renseignée ou non reconnue/);form.checks.master_local_speeds=['unknown'];
  const submit=form.onsubmit({preventDefault(){},currentTarget:form}),patch=requests.at(-1),payload=JSON.parse(patch.options.body);assert.deepEqual(payload.local_filters,{rating_min:null,rating_max:null,speeds:[]});assert.deepEqual(payload.master_local_filters,{rating_min:null,rating_max:null,speeds:['unknown']});patch.resolve({...initial,...payload});await submit;explorer.dispose();
 },
 async invalid_local_bounds_and_empty_lichess_reference_are_rejected(){
  const {dialog,notices}=installSettingsDialog(),{explorer}=await create();requests.at(-1).resolve(data());await settle();const form=await openSettings(explorer,dialog),before=requests.length,oldTimeout=globalThis.setTimeout,oldError=console.error;globalThis.setTimeout=callback=>{callback();return 0;};console.error=()=>{};
  try{
   for(const value of ['-1','4001','1800.5','1e3','abc']){form.elements.local_rating_min.value=value;await form.onsubmit({preventDefault(){},currentTarget:form});assert.equal(requests.length,before);assert.match(notices.at(-1),/Base locale.*Elo entier/);}
   form.elements.local_rating_min.value='2000';form.elements.local_rating_max.value='1800';await form.onsubmit({preventDefault(){},currentTarget:form});assert.equal(requests.length,before);assert.match(notices.at(-1),/minimum Elo/);form.elements.local_rating_min.value='';form.elements.local_rating_max.value='';
   form.elements.master_local_rating_max.value='4001';await form.onsubmit({preventDefault(){},currentTarget:form});assert.equal(requests.length,before);assert.match(notices.at(-1),/Référence locale/);form.elements.master_local_rating_max.value='';form.elements.master_source.value='lichess';form.checks.master_speeds=[];await form.onsubmit({preventDefault(){},currentTarget:form});assert.equal(requests.length,before);assert.match(notices.at(-1),/Référence Lichess.*cadence/);assert.equal(dialog.open,true);
  }finally{globalThis.setTimeout=oldTimeout;console.error=oldError;explorer.dispose();}
 },
 async remote_masters_has_note_instead_of_filter_controls(){
  const html=explorerSettingsHtml({...defaults,source:'masters',master_source:'masters'},[]);for(const prefix of ['source','reference']){const section=html.match(new RegExp('<div data-'+prefix+'-settings="masters">([\\s\\S]*?)</div>'))?.[1];assert.ok(section);assert.match(section,/ne propose pas de filtre par Elo ou cadence/);assert.match(section,/Mega Database/);assert.doesNotMatch(section,/<input|<select/);}
 },
 async partial_reference_is_labelled_and_manual_refresh_reads_new_counts(){
  const settings={...defaults,ratings:[1800],master_source:'local',master_base_ids:[10]}, {host,explorer}=await create({settingsOverride:settings});
  const result=data('start',{settings,masters:{...dataset,label:'Mega Database',complete:false,message:'Statistiques des parties déjà importées. Une grande base est encore partielle.'}});requests.at(-1).resolve(result);await settle();
  assert.match(host.innerHTML,/Référence : Statistiques des parties déjà importées/);assert.match(host.innerHTML,/>Réf\.</);assert.match(host.innerHTML,/class="explorer-masters"[^>]*>40 %/);assert.match(host.innerHTML,/data-explorer-action="retry"[^>]*>Actualiser/);
  const before=requests.filter(r=>r.url==='/api/explorer').length;await delay(300);assert.equal(requests.filter(r=>r.url==='/api/explorer').length,before,'No automatic polling during an import');
  const refresh={dataset:{explorerAction:'retry'}};await explorer.click({target:{closest:selector=>selector==='[data-explorer-action]'?refresh:null}});const request=requests.at(-1),body=JSON.parse(request.options.body);assert.equal(request.url,'/api/explorer');assert.equal(requests.filter(r=>r.url==='/api/explorer').length,before+1);assert.equal(body.settings.source,'lichess');assert.deepEqual(body.settings.ratings,[1800]);assert.deepEqual(body.settings.master_base_ids,[10]);
  const complete=data('start',{settings,masters:{...dataset,label:'Mega Database',complete:true}});complete.moves[0].master_frequency=55;request.resolve(complete);await settle();assert.match(host.innerHTML,/class="explorer-masters"[^>]*>55 %/);assert.doesNotMatch(host.innerHTML,/Statistiques des parties déjà importées|>Actualiser</);assert.equal(explorer.data,complete);explorer.dispose();
 },
 async partial_dataset_without_message_uses_clear_fallback_and_escapes_details(){
  const {host,explorer}=await create();requests.at(-1).resolve(data('start',{primary:{...dataset,complete:false},masters:{...dataset,complete:false,message:'Import <script>bad</script>'}}));await settle();
  assert.match(host.innerHTML,/Base : Statistiques partielles à cette position/);assert.match(host.innerHTML,/Référence : Import &lt;script&gt;/);assert.doesNotMatch(host.innerHTML,/<script>/);assert.equal((host.innerHTML.match(/>Actualiser</g)||[]).length,1);explorer.dispose();
 },
 async coverage_profile_overrides_only_this_explorer(){
  const override={source:'lichess',ratings:[1400],speeds:['blitz'],repertoire_color:'black',show_probability:true};
  const first=await create({settingsOverride:override});
  const request=requests.at(-1),body=JSON.parse(request.options.body);
  assert.equal(body.settings.repertoire_color,'black');assert.deepEqual(body.settings.ratings,[1400]);
  assert.deepEqual(body.settings.speeds,['blitz']);assert.equal(defaults.repertoire_color,'white');
  assert.equal(requests.filter(r=>r.url==='/api/explorer/settings'&&r.options.method==='PATCH').length,0);
  first.explorer.dispose();
  const second=await create();assert.deepEqual(second.explorer.settings.ratings,[1600,1800]);assert.equal(second.explorer.settings.repertoire_color,'white');second.explorer.dispose();
 },
 async probability_same_position_branch_change_preserves_table_and_ignores_stale(){
  const {host,board,explorer}=await create();requests.at(-1).resolve(data());await settle();
  board.path='0';board.doc={nodes:[{path:'',parent:null,fen:'root'},{path:'0',parent:'',uci:'e2e4',fen:'same'},{path:'1',parent:'',uci:'d2d4',fen:'same'}]};board.node=function(){return this.doc.nodes.find(n=>n.path===this.path);};explorer.probability.delay=0;explorer.update({immediate:true});requests.at(-1).resolve(data('same'));await settle();await delay(5);const first=requests.at(-1);assert.equal(first.url,'/api/explorer/probability');assert.deepEqual(JSON.parse(first.options.body).moves,['e2e4']);const stats=explorer.data,sequence=explorer.sequence,renders=host.renders;
  board.path='1';explorer.update({immediate:true});assert.equal(explorer.sequence,sequence);assert.equal(first.options.signal.aborted,true);await delay(5);const latest=requests.at(-1);assert.equal(latest.url,'/api/explorer/probability');assert.deepEqual(JSON.parse(latest.options.body).moves,['d2d4']);first.resolve({status:'ok',probability:.9,repertoire_color:'white'});await settle();assert.equal(explorer.probability.state.value,null);latest.resolve({status:'ok',probability:.1,repertoire_color:'white'});await settle();assert.equal(explorer.probability.state.value.probability,.1);assert.equal(explorer.data,stats);assert.equal(host.renders,renders);explorer.dispose();
 },
 async probability_side_is_saved_without_restarting_statistics_or_engine(){
  manualEvaluations=true;const {host,explorer}=await create();requests.at(-1).resolve(data());await settle();assert.match(host.innerHTML,/Mon camp/);assert.match(host.innerHTML,/<option value="white" selected>/);const stats=explorer.data,evaluations=evaluationRequests.length;
  const change=explorer.setRepertoireColor('black'),request=requests.at(-1);assert.equal(request.url,'/api/explorer/settings');assert.deepEqual(JSON.parse(request.options.body),{repertoire_color:'black'});assert.equal(explorer.settings.repertoire_color,'black');assert.equal(explorer.colorSaving,true);request.resolve({...defaults,repertoire_color:'black'});await change;assert.equal(explorer.colorSaving,false);assert.equal(explorer.data,stats);assert.equal(evaluationRequests.length,evaluations);assert.match(host.innerHTML,/<option value="black" selected>/);
  const back=explorer.setRepertoireColor('white');requests.at(-1).resolve({error:'Unavailable'});await back;assert.equal(explorer.settings.repertoire_color,'black');assert.match(host.innerHTML,/Impossible d’enregistrer ton camp/);explorer.dispose();
 },
 async probability_setting_can_hide_and_preserve_color_depth(){
  const {dialog}=installSettingsDialog(),{host,explorer}=await create();requests.at(-1).resolve(data());await settle();explorer.settings.repertoire_color='black';const form=await openSettings(explorer,dialog);assert.equal(form.elements.show_probability.value,'on');form.elements.show_probability.value=null;form.elements.engine_mode.value='depth';form.elements.engine_mode.onchange();form.elements.engine_depth.value='22';
  const submit=form.onsubmit({preventDefault(){},currentTarget:form}),patch=requests.at(-1),payload=JSON.parse(patch.options.body);assert.equal(payload.show_probability,false);assert.equal(payload.repertoire_color,'black');assert.equal(payload.engine_depth,22);patch.resolve({...defaults,...payload});await submit;requests.at(-1).resolve(data('start',{settings:explorer.settings}));await settle();assert.doesNotMatch(host.innerHTML,/data-explorer-color|data-explorer-probability/);explorer.dispose();
 },
 async probability_retry_does_not_reload_move_statistics(){
  const {explorer}=await create();requests.at(-1).resolve(data());await settle();let retry=null;explorer.probability.update=options=>retry=options;const before=requests.length;await explorer.click({target:{closest:selector=>selector==='[data-explorer-action]'?{dataset:{explorerAction:'probability-retry'}}:null}});assert.deepEqual(retry,{force:true,immediate:true});assert.equal(requests.length,before);explorer.dispose();
 },
 async hidden_tab_suspends_statistics_and_engine_until_visible(){
  manualEvaluations=true;const {board,explorer}=await create({visible:false});assert.equal(requests.length,0);assert.equal(evaluationRequests.length,0);
  board.fen='second';explorer.update({immediate:true});assert.equal(requests.length,0);explorer.setVisible(true);assert.equal(requests.length,1);assert.equal(JSON.parse(requests[0].options.body).fen,'second');
  requests[0].resolve(data('second'));await settle();assert.equal(evaluationRequests.length,1);const running=evaluationRequests[0];explorer.setVisible(false);assert.equal(running.options.signal.aborted,true);running.resolve({uci:'e2e4',cp:900,mate:null,depth:20});await settle();assert.equal(explorer.evaluations.size,0);
  board.fen='third';explorer.update({immediate:true});assert.equal(requests.length,1);explorer.setVisible(true);assert.equal(requests.length,2);assert.equal(JSON.parse(requests[1].options.body).fen,'third');requests[1].resolve(data('third'));await settle();assert.equal(evaluationRequests.length,2);explorer.dispose();
 },
 async hiding_tab_ignores_late_statistics_and_preserves_manual_pause(){
  manualEvaluations=true;const {explorer}=await create(),first=requests[0];explorer.setVisible(false);assert.equal(first.options.signal.aborted,true);first.resolve(data());await settle();assert.equal(explorer.data,null);assert.equal(evaluationRequests.length,0);
  explorer.setVisible(true);requests.at(-1).resolve(data());await settle();assert.equal(evaluationRequests.length,1);explorer.toggleEvaluations();assert.equal(explorer.evaluationEnabled,false);
  const count=requests.length;explorer.setVisible(false);explorer.setVisible(true);await settle();assert.equal(requests.length,count);assert.equal(evaluationRequests.length,1);assert.equal(explorer.evaluationEnabled,false);explorer.dispose();
 },
 async settings_depth_modes_saved_and_reopened(){
  manualEvaluations=true;const {dialog}=installSettingsDialog(),{host,explorer}=await create();requests.at(-1).resolve(data());await settle();
  assert.equal(explorer.settings.engine_depth,null);let form=await openSettings(explorer,dialog);assert.equal(form.elements.engine_mode.value,'quick');assert.equal(form.elements.engine_depth.value,'18');assert.equal(form.elements.engine_depth.disabled,true);assert.equal(form.depthLabel.hidden,true);
  form.elements.engine_mode.value='depth';form.elements.engine_mode.onchange();assert.equal(form.elements.engine_depth.disabled,false);assert.equal(form.elements.engine_depth.required,true);assert.equal(form.depthLabel.hidden,false);form.elements.engine_depth.value='64';
  const submit=form.onsubmit({preventDefault(){},currentTarget:form}),patch=requests.at(-1),payload=JSON.parse(patch.options.body);assert.equal(patch.url,'/api/explorer/settings');assert.equal(payload.engine_depth,64);assert.equal(typeof payload.engine_depth,'number');assert.equal(payload.engine_mode,undefined);patch.resolve({...defaults,engine_depth:64});await submit;assert.equal(explorer.settings.engine_depth,64);assert.equal(dialog.open,false);
  requests.at(-1).resolve(data('start',{settings:explorer.settings}));await settle();assert.equal(JSON.parse(evaluationRequests.at(-1).options.body).depth,64);assert.match(host.innerHTML,/profondeur cible 64/);assert.doesNotMatch(host.innerHTML,/~250 ms/);
  form=await openSettings(explorer,dialog);assert.equal(form.elements.engine_mode.value,'depth');assert.equal(form.elements.engine_depth.value,'64');assert.equal(form.elements.engine_depth.disabled,false);form.elements.engine_mode.value='quick';form.elements.engine_mode.onchange();assert.equal(form.elements.engine_depth.disabled,true);assert.equal(form.elements.engine_depth.required,false);assert.equal(form.depthLabel.hidden,true);form.elements.engine_depth.value='invalid-ignored-while-disabled';
  const quick=form.onsubmit({preventDefault(){},currentTarget:form}),quickPatch=requests.at(-1);assert.equal(JSON.parse(quickPatch.options.body).engine_depth,null);quickPatch.resolve({...defaults});await quick;assert.equal(explorer.settings.engine_depth,null);requests.at(-1).resolve(data());await settle();assert.equal(JSON.parse(evaluationRequests.at(-1).options.body).depth,null);explorer.dispose();
 },
 async settings_invalid_depth_rejected_without_request(){
  const {dialog,notices}=installSettingsDialog(),{explorer}=await create();requests.at(-1).resolve(data());await settle();const form=await openSettings(explorer,dialog);form.elements.engine_mode.value='depth';form.elements.engine_mode.onchange();
  const before=requests.length,oldTimeout=globalThis.setTimeout,oldError=console.error;globalThis.setTimeout=callback=>{callback();return 0;};console.error=()=>{};
  try{for(const invalid of ['', '0','2147483648','18.5','1e1','NaN','abc',' 18','Infinity']){form.elements.engine_depth.value=invalid;await form.onsubmit({preventDefault(){},currentTarget:form});assert.equal(requests.length,before);assert.equal(dialog.open,true);assert.equal(form.submit.disabled,false);assert.match(notices.at(-1),/profondeur entière positive/);assert.equal(explorer.settings.engine_depth,null);}}
  finally{globalThis.setTimeout=oldTimeout;console.error=oldError;explorer.dispose();}
 },
 async evaluations_depth_change_cancels_old_and_preserves_pause(){
  manualEvaluations=true;const {host,explorer}=await create();requests.at(-1).resolve(data());await settle();const quick=evaluationRequests.at(-1);assert.equal(JSON.parse(quick.options.body).depth,null);
  explorer.settings.engine_depth=22;explorer.update({immediate:true});assert.equal(quick.options.signal.aborted,true);requests.at(-1).resolve(data('start',{settings:explorer.settings}));await settle();const custom=evaluationRequests.at(-1);assert.equal(JSON.parse(custom.options.body).depth,22);
  quick.resolve({uci:'e2e4',cp:999,mate:null,depth:15,requested_depth:null,depth_reached:true});await settle();assert.equal(explorer.evaluations.size,0);assert.equal(host.cells[0].textContent,'…');
  explorer.toggleEvaluations();assert.equal(custom.options.signal.aborted,true);explorer.settings.engine_depth=30;explorer.update({immediate:true});requests.at(-1).resolve(data('start',{settings:explorer.settings}));await settle();assert.equal(explorer.evaluationEnabled,false);assert.equal(evaluationRequests.length,2);assert.equal(host.cells[0].textContent,'—');
  custom.resolve({uci:'e2e4',cp:888,mate:null,depth:22,requested_depth:22,depth_reached:true});await settle();assert.equal(explorer.evaluations.size,0);explorer.toggleEvaluations();assert.equal(JSON.parse(evaluationRequests.at(-1).options.body).depth,30);evaluationRequests.at(-1).resolve({uci:'e2e4',cp:46,mate:null,depth:20,requested_depth:30,depth_reached:false,engine:'Stockfish 18'});await settle();assert.equal(host.cells[0].textContent,'≈ +0,46');assert.equal(host.cells[0].dataset.state,'approximate');assert.match(host.cells[0].title,/Profondeur 20.*Cible 30 non atteinte/);assert.doesNotMatch(host.cells[0].title,/~250 ms/);explorer.dispose();
 },
 async evaluations_depth_labels_exact_terminal_and_quick(){
  const value={status:'ok',cp:46,mate:null,depth:22,requested_depth:22,depth_reached:true,engine:'Stockfish 18',cached:true},render=v=>explorerRowsHtml(data(),{evaluations:new Map([['e2e4',v]])});
  const target=render(value);assert.match(target,/Profondeur 22 · Cible 22 atteinte/);assert.match(target,/Évaluation en cache/);assert.ok(target.includes('>+0,46</td>'));assert.doesNotMatch(target,/≈|~250 ms/);
  const limited=render({...value,depth:18,depth_reached:false});assert.match(limited,/≈ \+0,46/);assert.match(limited,/Cible 22 non atteinte/);assert.doesNotMatch(limited,/~250 ms/);
  const terminal=render({...value,engine:'Règles des échecs',depth:0,cp:0,depth_reached:true});assert.match(terminal,/Position finale · Évaluation exacte/);assert.doesNotMatch(terminal,/≈|Cible 22|~250 ms/);assert.ok(terminal.includes('>0,00</td>'));
  const quick=render({...value,requested_depth:null,depth:16});assert.ok(quick.includes('Analyse rapide (~250 ms) · Profondeur 16'));assert.doesNotMatch(quick,/≈|Cible 22/);
  const defaultsHtml=explorerSettingsHtml(defaults,[]);assert.match(defaultsHtml,/<option value="quick" selected>/);assert.match(defaultsHtml,/min="1" step="1" value="18" disabled/);const depthHtml=explorerSettingsHtml({...defaults,engine_depth:30},[]);assert.match(depthHtml,/<option value="depth" selected>/);assert.match(depthHtml,/value="30" required/);assert.match(depthHtml,/sans limite de temps ajoutée/);assert.doesNotMatch(depthHtml,/max="30"|10 secondes par coup/);
 },

 async evaluations_all_rows_progressively_preserve_interaction(){
  manualEvaluations=true;const {host,board,explorer}=await create();
  const result=data('canonical-fen');result.moves=[...result.moves,{...result.moves[0],uci:'d2d4',san:'d4',total:0,frequency:0},{...result.moves[0],uci:'g1f3',san:'Nf3'},{...result.moves[0],uci:'g2g3',san:'g3'}];requests.at(-1).resolve(result);await settle();
  assert.equal(evaluationRequests.length,1);assert.match(host.innerHTML,/class="explorer-evaluation-heading"/);assert.match(host.innerHTML,/du point de vue des Blancs/);assert.match(host.innerHTML,/~250 ms/);
  const table=host.table,button=host.moveButton,renders=host.renders,cells=[...host.cells];table.scrollTop=123;button.focused=true;
  const scores=[{cp:34,mate:null},{cp:-72,mate:null},{cp:null,mate:-3},{cp:null,mate:5}];
  for(let i=0;i<4;i++){
   const pending=evaluationRequests.at(-1),body=JSON.parse(pending.options.body);assert.deepEqual(body,{fen:'start',uci:result.moves[i].uci,depth:null});assert.equal(evaluationRequests.length,i+1);
   pending.resolve({...body,fen:'canonical-fen',...scores[i],depth:18,engine:'Stockfish 18',cached:i===1});await settle();
  }
  assert.deepEqual(host.cells.map(c=>c.textContent),['+0,34','−0,72','#-3','#+5']);assert.match(host.cells[0].title,/Profondeur 18/);assert.match(host.cells[1].title,/en cache/);assert.equal(host.evaluationStatus.textContent,'4/4');
  assert.equal(host.renders,renders);assert.equal(host.table,table);assert.equal(table.scrollTop,123);assert.equal(host.moveButton,button);assert.equal(button.focused,true);assert.deepEqual(host.cells,cells);
  await explorer.click({target:{closest:selector=>selector==='[data-explorer-move]'?{dataset:{explorerMove:'d2d4'}}:null}});assert.deepEqual(board.calls,[['d2','d4','d2d4']]);explorer.dispose();
 },
 async evaluations_pause_resume_and_review_guard(){
  manualEvaluations=true;const {host,explorer}=await create();explorer.toggleEvaluations();requests.at(-1).resolve(data());await settle();assert.equal(evaluationRequests.length,0);assert.match(host.innerHTML,/aria-pressed="false"/);assert.equal(host.cells[0].textContent,'—');
  explorer.toggleEvaluations();const first=evaluationRequests.at(-1);assert.equal(evaluationRequests.length,1);assert.equal(host.evaluationButton.attributes['aria-pressed'],'true');
  explorer.toggleEvaluations();assert.equal(first.options.signal.aborted,true);first.resolve({uci:'e2e4',cp:100,mate:null,depth:10});await settle();assert.equal(explorer.evaluations.size,0);assert.equal(evaluationRequests.length,1);assert.equal(host.cells[0].textContent,'—');
  explorer.toggleEvaluations();evaluationRequests.at(-1).resolve({uci:'e2e4',cp:0,mate:null,depth:12});await settle();assert.equal(host.cells[0].textContent,'0,00');explorer.dispose();
  const review=await create();review.board.training=true;requests.at(-1).resolve(data());await settle();assert.equal(evaluationRequests.length,2);review.explorer.dispose();
 },
 async evaluations_navigation_settings_collapse_dispose_ignore_late(){
  manualEvaluations=true;const {host,board,explorer}=await create();requests.at(-1).resolve(data());await settle();const initial=evaluationRequests.at(-1);
  board.fen='black-to-move';explorer.update({immediate:true});assert.equal(initial.options.signal.aborted,true);requests.at(-1).resolve(data('black-to-move'));await settle();const second=evaluationRequests.at(-1);
  initial.resolve({uci:'e2e4',cp:999,mate:null,depth:12});await settle();assert.equal(explorer.evaluations.size,0);assert.equal(host.cells[0].textContent,'…');
  explorer.settings.ratings=[1800];explorer.update({immediate:true});assert.equal(second.options.signal.aborted,true);requests.at(-1).resolve(data('black-to-move',{settings:explorer.settings}));await settle();const third=evaluationRequests.at(-1);
  second.resolve({uci:'e2e4',cp:888,mate:null,depth:12});await settle();assert.equal(explorer.evaluations.size,0);
  await explorer.click({target:{closest:()=>({dataset:{explorerAction:'collapse'}})}});assert.equal(third.options.signal.aborted,true);third.resolve({uci:'e2e4',cp:777,mate:null,depth:12});await settle();assert.equal(explorer.evaluations.size,0);
  await explorer.click({target:{closest:()=>({dataset:{explorerAction:'collapse'}})}});requests.at(-1).resolve(data('black-to-move',{settings:explorer.settings}));await settle();const final=evaluationRequests.at(-1),renders=host.renders;
  explorer.dispose();assert.equal(final.options.signal.aborted,true);final.resolve({uci:'e2e4',cp:666,mate:null,depth:12});await settle();assert.equal(host.renders,renders);assert.equal(explorer.evaluations.size,0);
 },
 async evaluations_failure_retry_retains_statistics_and_scores(){
  manualEvaluations=true;const {host,explorer}=await create(),result=data();result.moves.push({...result.moves[0],uci:'d2d4',san:'d4'},{...result.moves[0],uci:'g1f3',san:'Nf3'});requests.at(-1).resolve(result);await settle();
  evaluationRequests.at(-1).resolve({uci:'e2e4',cp:42,mate:null,depth:14});await settle();evaluationRequests.at(-1).resolve({error:'Stockfish unavailable',status:503});await settle();
  assert.equal(evaluationRequests.length,2);assert.deepEqual(host.cells.map(c=>c.textContent),['+0,42','—','—']);assert.equal(host.evaluationButton.attributes['aria-label'],'Réessayer les évaluations Stockfish');assert.equal(host.evaluationStatus.textContent,'Stockfish indisponible');
  const statistics=requests.length,table=host.table;explorer.toggleEvaluations();assert.equal(requests.length,statistics);assert.equal(host.table,table);assert.equal(JSON.parse(evaluationRequests.at(-1).options.body).uci,'d2d4');
  evaluationRequests.at(-1).resolve({uci:'d2d4',cp:-20,mate:null,depth:14});await settle();evaluationRequests.at(-1).resolve({uci:'g1f3',cp:10,mate:null,depth:14});await settle();assert.deepEqual(host.cells.map(c=>c.textContent),['+0,42','−0,20','+0,10']);assert.equal(host.evaluationStatus.textContent,'3/3');explorer.dispose();
 },
 async evaluations_row_failure_continues_then_retries_only_failed(){
  manualEvaluations=true;const {host,explorer}=await create(),result=data();result.moves.push({...result.moves[0],uci:'d2d4',san:'d4'});requests.at(-1).resolve(result);await settle();evaluationRequests.at(-1).resolve({error:'Move unavailable',status:400});await settle();assert.equal(evaluationRequests.length,2);
  evaluationRequests.at(-1).resolve({uci:'d2d4',cp:-55,mate:null,depth:14});await settle();assert.equal(host.evaluationStatus.textContent,'Évaluations incomplètes');assert.equal(host.evaluationButton.attributes['aria-label'],'Réessayer les évaluations Stockfish');explorer.toggleEvaluations();assert.equal(JSON.parse(evaluationRequests.at(-1).options.body).uci,'e2e4');evaluationRequests.at(-1).resolve({uci:'e2e4',cp:24,mate:null,depth:14});await settle();assert.equal(evaluationRequests.length,3);assert.deepEqual(host.cells.map(c=>c.textContent),['+0,24','−0,55']);explorer.dispose();
 },
 async rate_limit_wait_is_visible_without_auto_retry(){
  const {host,explorer}=await create();requests.at(-1).resolve(data('start',{primary:{...dataset,status:'rate_limited',retry_after:90,message:'Trop de demandes.'}}));await settle();assert.match(host.innerHTML,/Réessaie dans 2 min/);assert.match(host.innerHTML,/data-explorer-action="retry"/);const before=requests.length;await delay(285);assert.equal(requests.length,before);
  explorer.update({force:true,immediate:true});requests.at(-1).resolve(data('start',{primary:{...dataset,status:'rate_limited',retry_after:17,message:'Trop de demandes.'}}));await settle();assert.match(host.innerHTML,/Réessaie dans 17 s/);explorer.dispose();
 },
 async late_settings_save_preserves_new_modal(){
  class Dialog{
   constructor(){this.open=false;this.listeners=[];this.classList={toggle(){}};}
   set innerHTML(value){this.html=value;const connectionHost=new ConnectionHost(),submit={disabled:false};this.form={elements:{source:{value:'lichess'},master_source:{value:'masters'},engine_mode:{value:'quick'},engine_depth:{value:'18'}},querySelector:selector=>selector==='[data-explorer-connection]'?connectionHost:selector==='[type=submit]'?submit:null,querySelectorAll:()=>[]};}
   querySelector(selector){return selector==='form'?this.form:null;}
   querySelectorAll(){return [];}
   addEventListener(type,fn){if(type==='close')this.listeners.push(fn);}
   showModal(){this.open=true;}
   close(){this.open=false;const listeners=this.listeners;this.listeners=[];listeners.forEach(fn=>fn());}
  }
  const dialog=new Dialog();globalThis.document={body:{append(){}},getElementById:id=>{assert.equal(id,'modal');return dialog;}};
  globalThis.FormData=class{get(key){return {source:'lichess',master_source:'masters',engine_mode:'quick'}[key];}getAll(key){return {speeds:['blitz'],ratings:['1800'],base_ids:[],master_base_ids:[]}[key]||[];}};
  const {explorer}=await create();requests.at(-1).resolve(data());await settle();explorer.openSettings();requests.at(-1).resolve({configured:false,source:null});await explorer.connection.ready;
  const oldForm=dialog.form,submission=oldForm.onsubmit({preventDefault(){},currentTarget:oldForm}),patch=requests.at(-1);assert.equal(patch.url,'/api/explorer/settings');assert.equal(patch.options.method,'PATCH');dialog.close();explorer.openSettings();const newForm=dialog.form;requests.at(-1).resolve({configured:false,source:null});await explorer.connection.ready;
  patch.resolve({...defaults,speeds:['blitz'],ratings:[1800]});await submission;assert.equal(dialog.open,true);assert.equal(dialog.form,newForm);assert.deepEqual(explorer.settings.speeds,['rapid']);assert.equal(explorer.connection.disposed,false);explorer.dispose();
 },
 async settings_modal_connects_and_clears_on_close(){
  class Dialog{
   constructor(){this.open=false;this.listeners=[];this.classList={toggle(){}};}
   set innerHTML(value){this.html=value;const connectionHost=new ConnectionHost();this.form={elements:{source:{value:'lichess'},master_source:{value:'masters'},engine_mode:{value:'quick'},engine_depth:{value:'18'}},querySelector:selector=>selector==='[data-explorer-connection]'?connectionHost:null,querySelectorAll:()=>[]};this.connectionHost=connectionHost;}
   querySelector(selector){return selector==='form'?this.form:null;}
   querySelectorAll(){return [];}
   addEventListener(type,fn){if(type==='close')this.listeners.push(fn);}
   showModal(){this.open=true;}
   close(){this.open=false;const listeners=this.listeners;this.listeners=[];listeners.forEach(fn=>fn());}
  }
  const dialog=new Dialog();globalThis.document={body:{append(){}},getElementById:id=>{assert.equal(id,'modal');return dialog;}};
  const {explorer}=await create();requests.at(-1).resolve(data());await settle();const event={target:{closest:()=>({dataset:{explorerAction:'settings'}})}};await explorer.click(event);
  const first=requests.at(-1);assert.equal(first.url,'/api/explorer/connection');first.resolve({configured:false,source:null});await explorer.connection.ready;assert.equal(dialog.open,true);const input=dialog.connectionHost.input;input.value='unsaved-secret-token';dialog.close();assert.equal(input.value,'');assert.equal(explorer.connection.disposed,true);
  explorer.openSettings();const late=requests.at(-1),host=dialog.connectionHost;dialog.close();assert.equal(late.options.signal.aborted,true);const before=host.innerHTML;late.resolve({configured:true,source:'local'});await explorer.connection.ready;assert.equal(host.innerHTML,before);explorer.dispose();
 },
 async connection_save_delete_and_private_payload(){
  const {explorer}=await create();requests.at(-1).resolve(data());await settle();
  const {host,connection}=await createConnection(undefined,{onChanged:()=>explorer.update({force:true,immediate:true})});
  assert.match(host.innerHTML,/type="password"/);assert.match(host.innerHTML,/sans cocher de permissions/);assert.match(host.innerHTML,/https:\/\/lichess.org\/account\/oauth\/token\/create\?description=ChessGym/);assert.doesNotMatch(host.innerHTML,/name="token"|value="/);
  host.input.value='private-token-123';const input=host.input,save=connection.save(),request=requests.at(-1),before=requests.length;assert.equal(input.disabled,true);assert.deepEqual(JSON.parse(request.options.body),{token:'private-token-123'});assert.equal(request.url,'/api/explorer/connection');assert.equal(request.options.method,'PATCH');assert.equal(await connection.save(),false);assert.equal(requests.length,before);
  request.resolve({configured:true,source:'local'});assert.equal(await save,true);assert.equal(input.value,'');assert.equal(host.input.value,'');assert.match(host.innerHTML,/Jeton enregistré/);assert.doesNotMatch(host.innerHTML,/private-token|Connexion vérifiée/);
  const query=requests.at(-1);assert.equal(query.url,'/api/explorer');assert.deepEqual(JSON.parse(query.options.body),{fen:'start',settings:defaults});query.resolve(data());await settle();
  const remove=connection.save(true),deletion=requests.at(-1);assert.deepEqual(JSON.parse(deletion.options.body),{token:''});deletion.resolve({configured:false,source:null});assert.equal(await remove,true);assert.match(host.innerHTML,/Aucun jeton enregistré/);assert.doesNotMatch(host.innerHTML,/data-connection-action="remove"/);requests.at(-1).resolve(data());await settle();connection.dispose();explorer.dispose();
 },
 async connection_validation_environment_and_cleanup(){
  const {host,connection}=await createConnection();const before=requests.length;
  for(const token of ['short','white space token','éabcdefgh']){host.input.value=token;assert.equal(await connection.save(),false);assert.equal(requests.length,before);assert.match(host.errorElement.textContent,/sans espaces/);}
  host.input.value='never-echo-token';const save=connection.save(),request=requests.at(-1);request.resolve({error:'Server returned secret never-echo-token'});assert.equal(await save,false);assert.match(host.errorElement.textContent,/Impossible de modifier/);assert.doesNotMatch(host.errorElement.textContent,/never-echo-token/);const oldInput=host.input;connection.dispose();assert.equal(oldInput.value,'');assert.equal(host.handlers.click,undefined);
  for(const configured of [true,false]){const env=await createConnection({configured,source:'environment'});assert.doesNotMatch(env.host.innerHTML,/type="password"|data-connection-action="remove"/);assert.match(env.host.innerHTML,configured?/Jeton fourni par le serveur/:/Configuration du serveur à corriger/);const n=requests.length;assert.equal(await env.connection.save(true),false);assert.equal(requests.length,n);env.connection.dispose();}
 },
 async connection_late_completion_after_close(){
  const {host,connection}=await createConnection();host.input.value='private-close-token';const input=host.input,save=connection.save(),request=requests.at(-1),html=host.innerHTML;connection.dispose();assert.equal(input.value,'');assert.equal(request.options.signal.aborted,true);request.resolve({configured:true,source:'local'});assert.equal(await save,false);assert.equal(host.innerHTML,html);assert.equal(input.value,'');
  let active=true;const pendingHost=new ConnectionHost(),late=new ExplorerConnection(pendingHost,{isActive:()=>active});const loading=requests.at(-1);active=false;const prior=pendingHost.innerHTML;loading.resolve({configured:true,source:'local'});await late.ready;assert.equal(pendingHost.innerHTML,prior);late.dispose();
 },
 async auth_required_preserves_local_and_no_retry_loop(){
  const {host,explorer}=await create();const auth={...dataset,status:'auth_required',total:null,message:'Connecte un jeton Lichess.'};requests.at(-1).resolve(data('start',{masters:auth}));await settle();assert.match(host.innerHTML,/data-explorer-move="e2e4"/);assert.match(host.innerHTML,/Connecter Lichess/);assert.match(host.innerHTML,/class="explorer-masters"[^>]*>—/);assert.doesNotMatch(host.innerHTML,/data-explorer-action="retry"/);
  explorer.update({force:true,immediate:true});requests.at(-1).resolve(data('start',{primary:auth,masters:auth,moves:[]}));await settle();assert.equal((host.innerHTML.match(/Connecte un jeton Lichess/g)||[]).length,1);assert.match(host.innerHTML,/Connecter Lichess/);assert.doesNotMatch(host.innerHTML,/data-explorer-action="retry"/);explorer.dispose();
 },
 async rare_and_truncated_move_statistics(){
  const rare=data();rare.moves[0].frequency=.0001;rare.moves[0].master_frequency=.005;const html=explorerRowsHtml(rare);assert.equal((html.match(/&lt; 0,01 %/g)||[]).length,2);assert.doesNotMatch(html,/>0 %/);
  const truncated=data();truncated.primary.complete=false;truncated.masters.complete=false;Object.assign(truncated.moves[0],{total:0,frequency:null,white:0,black:0,draws:0,master_total:null,master_frequency:null});const missing=explorerRowsHtml(truncated);assert.match(missing,/Fréquence inconnue pour ce coup/);assert.match(missing,/Fréquence de référence inconnue/);assert.doesNotMatch(missing,/>0<\/small>|0 partie|>0 %/);
 },
 async inline_percentages_and_result_semantics(){
  const html=explorerRowsHtml(data());assert.match(html,/<tr[^>]*e2e4[\s\S]*e4[\s\S]*60 %/);assert.match(html,/class="explorer-masters"[^>]*>40 %/);assert.match(html,/Blancs : 30 \(50 %\)/);assert.match(html,/Nulles : 6 \(10 %\)/);assert.match(html,/Noirs : 24 \(40 %\)/);
  const unknown=resultsHtml({white:4,draws:1,black:5,unknown:90});assert.match(unknown,/Blancs : 4 \(40 %\)/);assert.match(unknown,/90 sans résultat/);assert.doesNotMatch(unknown,/4 %/);
  const noResults=resultsHtml({white:0,draws:0,black:0,unknown:7});assert.match(noResults,/7 sans résultat/);assert.doesNotMatch(noResults,/result-draw/);
  const absent=data();absent.moves[0].master_frequency=null;absent.moves[0].master_total=null;assert.match(explorerRowsHtml(absent),/class="explorer-masters"[^>]*>—/);
  absent.settings.master_source='none';assert.doesNotMatch(explorerRowsHtml(absent),/class="explorer-masters"/);
  absent.moves[0].san='<img src=x onerror=x>';assert.doesNotMatch(explorerRowsHtml(absent),/<img/);assert.match(explorerRowsHtml(absent),/&lt;img/);
 },
 async compact_settings_and_source_labels(){
  const html=explorerSettingsHtml(defaults,[{id:7,name:'Répertoire <test>'}]);assert.match(html,/name="ratings" value="1600" checked/);assert.match(html,/name="ratings" value="1800" checked/);assert.match(html,/name="speeds" value="rapid" checked/);assert.match(html,/moyen des deux joueurs/);assert.match(html,/sans équivalence directe/);assert.match(html,/Répertoire &lt;test&gt;/);assert.match(html,/name="master_base_ids" value="7"/);
  const {host,explorer}=await create();const result=data();result.settings.master_source='local';explorer.settings.master_source='local';requests.at(-1).resolve(result);await settle(); // Changed configuration invalidates the in-flight result.
  assert.equal(explorer.data,null);explorer.update({force:true,immediate:true});requests.at(-1).resolve(result);await settle();assert.match(host.innerHTML,/>Réf\.<\/th>/);assert.doesNotMatch(host.innerHTML,/name="ratings"/);explorer.dispose();
 },
 async debounce_and_out_of_order_responses(){
  const {host,board,explorer}=await create();const first=requests.at(-1),before=requests.length;
  board.fen='second';explorer.update();board.fen='third';explorer.update();assert.equal(requests.length,before);assert.match(host.innerHTML,/Recherche à cette position/);
  first.resolve(data('start'));await settle();assert.equal(explorer.data,null);assert.doesNotMatch(host.innerHTML,/data-explorer-move/);
  await delay(285);assert.equal(requests.length,before+1);const latest=requests.at(-1);assert.equal(JSON.parse(latest.options.body).fen,'third');latest.resolve(data('third'));await settle();assert.equal(explorer.data.fen,'third');assert.match(host.innerHTML,/data-explorer-move="e2e4"/);explorer.dispose();
 },
 async disposal_cancels_pending_updates(){
  const {host,explorer}=await create();const pending=requests.at(-1),before=host.innerHTML;explorer.dispose();assert.equal(pending.options.signal.aborted,true);assert.equal(host.handlers.click,undefined);pending.resolve(data());await settle();assert.equal(host.innerHTML,before);assert.equal(explorer.data,null);
 },
 async partial_failure_and_stale_results(){
  const {host,explorer}=await create();const partial=data('start',{primary:{...dataset,status:'unavailable',total:null,white:null,draws:null,black:null,unknown:null,message:'Serveur joueur indisponible'},masters:{...dataset,label:'Maîtres Lichess'}});requests.at(-1).resolve(partial);await settle();assert.match(host.innerHTML,/Serveur joueur indisponible/);assert.match(host.innerHTML,/class="explorer-frequency"[^>]*>—/);assert.match(host.innerHTML,/class="explorer-masters"[^>]*>40 %/);
  explorer.update({force:true,immediate:true});const stale=data('start',{primary:{...dataset,status:'rate_limited',stale:true,message:'Limite temporaire'}});requests.at(-1).resolve(stale);await settle();assert.match(host.innerHTML,/Dernières données connues affichées/);assert.match(host.innerHTML,/class="explorer-frequency"[^>]*>60 %/);explorer.dispose();
 },
 async exact_move_and_stale_click_guards(){
  const {board,explorer}=await create();const result=data('canonical-fen');result.moves=[{...result.moves[0],uci:'a7a8n',san:'a8=N'}];requests.at(-1).resolve(result);await settle();assert.ok(explorer.data); // The server can canonicalize an en-passant FEN.
  await explorer.play('a7a8n');assert.deepEqual(board.calls,[['a7','a8','a7a8n']]);await explorer.play('d2d4');assert.equal(board.calls.length,1);
  board.busy=true;await explorer.play('a7a8n');assert.equal(board.calls.length,1);board.busy=false;board.fen='changed';await explorer.play('a7a8n');assert.equal(board.calls.length,1);explorer.dispose();
 },
 async unavailable_empty_and_retry(){
  const {host,explorer}=await create();requests.at(-1).resolve({error:'Service hors ligne'});await settle();assert.match(host.innerHTML,/Explorateur indisponible/);assert.match(host.innerHTML,/data-explorer-action="retry"/);assert.doesNotMatch(host.innerHTML,/data-explorer-move/);
  explorer.update({force:true,immediate:true});requests.at(-1).resolve(data('start',{moves:[],primary:{...dataset,total:0}}));await settle();assert.match(host.innerHTML,/Aucun coup trouvé/);assert.match(host.innerHTML,/0 partie/);explorer.dispose();
 },
 async collapse_cancels_and_reopens(){
  const {host,explorer}=await create();const first=requests.at(-1);const toggle={dataset:{explorerAction:'collapse'}};const event={target:{closest:selector=>selector==='[data-explorer-action]'?toggle:null}};
  await explorer.click(event);assert.equal(first.options.signal.aborted,true);assert.match(host.innerHTML,/aria-expanded="false"/);first.resolve(data());await settle();assert.equal(explorer.data,null);
  const before=requests.length;await explorer.click(event);assert.equal(requests.length,before+1);requests.at(-1).resolve(data());await settle();assert.match(host.innerHTML,/aria-expanded="true"/);assert.match(host.innerHTML,/data-explorer-move/);explorer.dispose();
 }
};
const selected=process.argv[2];assert.ok(tests[selected],'unknown test '+selected);await tests[selected]();console.log(selected+' passed');
