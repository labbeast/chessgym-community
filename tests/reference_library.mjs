import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({load(url,context,nextLoad){const result=nextLoad(url,context);if(url.endsWith('/static/api.js'))result.source=String(result.source).replace('export function modal(', 'function originalModal(')+'\nexport function modal(title,html,options={}){return {title,html,options};}';return result;}});
const {ReferenceLibrary,referenceStatusHtml,referenceGamesHtml,referenceImportDialog}=await import('../static/reference-library.js');

class Element{
 constructor(){this.children=new Map();this.listeners=new Map();this.innerHTML='';this.dataset={};this.disabled=false;this.attributes={};this.values={search:'',sort:'id',descending:'false',rating_min:'',rating_max:'',speed:''};}
 querySelector(selector){if(!this.children.has(selector))this.children.set(selector,new Element());return this.children.get(selector);}
 addEventListener(type,fn){this.listeners.set(type,fn);}removeEventListener(type,fn){if(this.listeners.get(type)===fn)this.listeners.delete(type);}
 contains(){return true;}setAttribute(key,value){this.attributes[key]=String(value);}reset(){this.values={search:'',sort:'id',descending:'false',rating_min:'',rating_max:'',speed:''};}
}
globalThis.FormData=class{constructor(form){this.values=form.values;}get(key){return this.values[key]??null;}};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function setup(options={}){
 const host=new Element(),calls=[];const panel=new ReferenceLibrary(host,{base:{id:17,reference:true,reference_status:{status:'completed',imported:100}},pollMs:999999,...options,request:(url,settings={})=>{const task=deferred();calls.push({url,settings,...task});return task.promise;}});
 return {panel,host,calls,list:calls[0],status:calls[1]};
}
const game=(id,white='Alice')=>({id,title:'Cours',headers:{White:white,Black:'Bob',WhiteElo:'1900',BlackElo:'1850',Result:'1-0',Date:'2025.01.01',Event:'Tournoi',TimeControl:'600+0'}});
const page=(ids=[1],offset=0,total=120)=>({entries:ids.map(id=>game(id)),offset,limit:50,total,has_more:offset+ids.length<total});
function click(panel,dataset){const button={dataset,closest(){return this;}};return panel.click({target:button});}
async function loaded(options={}){const env=setup(options);env.list.resolve(page());env.status.resolve({status:'completed',imported:100});await env.panel.ready;return env;}
const preparation=(overrides={})=>({status:'preparing',entries:[],total:null,offset:0,limit:50,has_more:false,retry_after:3,message:'Préparation de la recherche… Les résultats apparaîtront automatiquement.',...overrides});
async function withFakeClock(test){
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,realNow=Date.now,timers=[];let now=1000;
 globalThis.setTimeout=(callback,delay=0)=>{const timer={callback,delay:Number(delay),cancelled:false,fired:false};timers.push(timer);return timer;};globalThis.clearTimeout=timer=>{if(timer)timer.cancelled=true;};Date.now=()=>now;
 const clock={timers,active:()=>timers.filter(timer=>!timer.cancelled&&!timer.fired),now:()=>now,fire(timer){assert.ok(timer&&!timer.cancelled&&!timer.fired,'Only a live timer may run');timer.fired=true;now+=timer.delay;return timer.callback();}};
 try{await test(clock);}finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;Date.now=realNow;}
}
async function preparing(){const env=setup();env.list.resolve(preparation());env.status.resolve({status:'completed',imported:100});await env.panel.ready;return env;}
const tests={
 async search_progress_follows_only_the_current_request(){
  const {panel,calls,list,status}=setup();try{
   assert.match(panel.gamesHost.innerHTML,/role="progressbar"/);
   assert.doesNotMatch(panel.gamesHost.innerHTML,/aria-valuenow|value="\d+"|\d+\s*%/);
   assert.equal(panel.gamesHost.attributes['aria-busy'],'true');
   list.resolve(page());status.resolve({status:'completed',imported:100});await panel.ready;
   assert.doesNotMatch(panel.gamesHost.innerHTML,/role="progressbar"/);
   const pagination=click(panel,{referenceAction:'next'}),old=calls.at(-1);
   assert.match(panel.gamesHost.innerHTML,/role="progressbar"/);assert.match(panel.gamesHost.innerHTML,/Alice/);
   panel.form.values.search='Carlsen';const search=panel.applyFilters(),current=calls.at(-1);
   old.resolve(page([51],50));await pagination;
   assert.equal(old.settings.signal.aborted,true);assert.match(panel.gamesHost.innerHTML,/role="progressbar"/);
   assert.doesNotMatch(panel.gamesHost.innerHTML,/Alice/);
   current.reject(new Error('Connexion interrompue'));await search;
   assert.doesNotMatch(panel.gamesHost.innerHTML,/role="progressbar"/);
   assert.equal(panel.gamesHost.attributes['aria-busy'],'false');assert.match(panel.errorHost.textContent,/Connexion interrompue/);
  }finally{panel.dispose();}
 },
 async preparation_progress_is_indeterminate_escaped_and_stops_when_paused(){
  const html=referenceGamesHtml(preparation({message:'Recherche <img src=x> "test"'}));
  assert.match(html,/role="progressbar"/);assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img|aria-valuenow|\d+\s*%/);
  for(const preparationFailed of [false,true]){
   const paused=referenceGamesHtml(preparation(),false,{preparationPaused:true,preparationFailed});
   assert.doesNotMatch(paused,/role="progressbar"/);assert.match(paused,/data-reference-action="refresh"/);
  }
 },
 async advanced_filters_follow_pagination_and_reset_while_old_rows_are_hidden(){
  const {panel,calls}=await loaded();panel.form.values={search:'Sicilian',sort:'date',descending:'true',first_name:' Élodie ',last_name:' Labbé ',player_color:'black',white:'Marc',event:'Montréal',date_from:'2024-01-01',date_to:'2025-12-31',rating_min:'2200',rating_max:'2600',rating_side:'either',result:'0-1',eco:'b90-b99',opening:'Najdorf',speed:'blitz'};
  let task=panel.applyFilters(),params=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(params.get('first_name'),'Élodie');assert.equal(params.get('rating_side'),'either');assert.equal(params.get('eco'),'B90-B99');assert.equal(params.get('date_to'),'2025-12-31');assert.doesNotMatch(panel.gamesHost.innerHTML,/Alice/);calls.at(-1).resolve(page([2],0,60));await task;
  task=click(panel,{referenceAction:'next'});params=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(params.get('offset'),'50');assert.equal(params.get('first_name'),'Élodie');assert.equal(params.get('eco'),'B90-B99');calls.at(-1).resolve(page([51],50,60));await task;
  panel.filters.player_key='opaque key';panel.directoryLabels.player_key='Élodie';task=click(panel,{referenceAction:'reset'});params=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(params.has('first_name'),false);assert.equal(params.has('player_key'),false);assert.equal(params.has('eco'),false);assert.equal(params.get('offset'),'0');calls.at(-1).resolve(page());await task;panel.dispose();
 },
 async advanced_invalid_dates_and_eco_keep_previous_filter(){
  const {panel,calls}=await loaded();const length=calls.length;panel.form.values.date_from='2025-12-01';panel.form.values.date_to='2024-12-01';await assert.rejects(panel.applyFilters(),/date/);assert.equal(calls.length,length);panel.form.values.date_to='2026-12-01';panel.form.values.eco='B99-B00';await assert.rejects(panel.applyFilters(),/ECO/);assert.equal(calls.length,length);assert.equal(panel.filters.eco,undefined);panel.dispose();
 },
 async phase_labels_do_not_confuse_eof_with_completion(){
  const finishing=referenceStatusHtml({status:'running',worker_active:true,phase:'finalizing',bytes_read:100,total_bytes:100,game_count:4});
  assert.match(finishing,/Finalisation sur disque/);assert.match(finishing,/value="100"/);assert.match(finishing,/après 100 %/);assert.doesNotMatch(finishing,/Importation terminée|Poursuivre/);
  const stopping=referenceStatusHtml({status:'running',phase:'committing',pause_requested:true});
  assert.match(stopping,/Mise en pause · enregistrement/);assert.match(stopping,/disabled>Pause demandée/);assert.doesNotMatch(stopping,/Poursuivre/);
  assert.match(referenceStatusHtml({status:'running',phase:'replaying'}),/Relecture de la portion/);
  assert.match(referenceStatusHtml({status:'completed',worker_active:false}),/Importation terminée/);
 },
 async worker_count_is_shown_only_for_active_parallel_imports(){
  for(const status of ['running','queued'])assert.match(referenceStatusHtml({status,workers:4,game_count:100}),/4 cœurs/);
  for(const status of ['paused','completed','limited','error'])assert.doesNotMatch(referenceStatusHtml({status,workers:4}),/cœurs/);
  for(const workers of [undefined,1,0,-1,2.5,'<script>'])assert.doesNotMatch(referenceStatusHtml({status:'running',workers}),/cœurs|<script>/);
 },
 async import_encoding_is_explicit_and_defaults_to_utf8(){
  const oldFetch=globalThis.fetch,calls=[];globalThis.fetch=async(url,settings)=>{calls.push({url,body:JSON.parse(settings.body)});return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({id:17})};};
  try{
   let created;const dialog=referenceImportDialog({onCreated:base=>created=base});assert.match(dialog.html,/<details><summary>Options avancées/);assert.match(dialog.html,/<option value="utf-8-sig" selected/);assert.match(dialog.html,/value="cp1252"/);assert.match(dialog.html,/value="latin-1"/);
   const values={name:'Maîtres',path:'C:\\Bases\\maitres.pgn',max_games:'100000',folder_id:'7'},form={get:key=>values[key]??null};
   await dialog.options.onSubmit(form);assert.equal(calls.at(-1).body.encoding,'utf-8-sig');assert.equal(calls.at(-1).body.max_games,100000);assert.equal(calls.at(-1).body.folder_id,7);assert.equal(created.id,17);
   for(const encoding of ['cp1252','latin-1']){values.encoding=encoding;values.max_games='';await dialog.options.onSubmit(form);assert.equal(calls.at(-1).body.encoding,encoding);assert.equal(Object.hasOwn(calls.at(-1).body,'max_games'),false);}
   values.encoding='auto';const length=calls.length;await assert.rejects(dialog.options.onSubmit(form),/encodage/);assert.equal(calls.length,length);
  }finally{globalThis.fetch=oldFetch;}
 },
 async escaped_rows_status_and_mobile_labels(){
  const html=referenceGamesHtml({entries:[game('1" onclick="evil','<img src=x onerror=x>')],offset:0,total:1,has_more:false});
  assert.doesNotMatch(html,/<img| onclick="evil/);assert.match(html,/&lt;img/);assert.match(html,/data-label="Blancs"/);assert.match(html,/data-label="Date"/);assert.match(html,/aria-label="Page suivante" disabled|disabled aria-label="Page suivante"/);
  const status=referenceStatusHtml({status:'limited',imported:100000,error:'<script>bad</script>'});assert.doesNotMatch(status,/<script>/);assert.match(status,/statistiques portent sur les parties déjà importées/);assert.match(status,/Poursuivre/);
 },
 async unknown_game_date_displays_utc_date_without_changing_headers(){
  const entry=game(1);entry.headers.Date='????.??.??';entry.headers.UTCDate='2012.12.31';let html=referenceGamesHtml({entries:[entry]});assert.match(html,/data-label="Date">2012\.12\.31/);assert.equal(entry.headers.Date,'????.??.??');
  entry.headers.Date='2013.01.01';html=referenceGamesHtml({entries:[entry]});assert.match(html,/data-label="Date">2013\.01\.01/);
 },
 async corpus_count_remains_visible_when_source_import_count_resets(){
  assert.match(referenceStatusHtml({status:'running',game_count:250,imported:0,processed:5}),/250 parties disponibles/);
  assert.match(referenceStatusHtml({status:'running',game_count:0,imported:250}),/0 parties disponibles/);
  assert.match(referenceStatusHtml({status:'running',imported:250}),/250 parties disponibles/);
  const {panel,calls}=await loaded();const polling=panel.poll();calls.at(-1).resolve({status:'completed',game_count:250,imported:100});await polling;assert.match(calls.at(-1).url,/\/status$/);assert.equal(panel.refreshPending,true);const refresh=click(panel,{referenceAction:'refresh'});calls.at(-1).resolve(page([1],0,250));await refresh;assert.equal(panel.data.total,250);assert.match(panel.statusHost.innerHTML,/250 parties disponibles/);panel.dispose();
 },
 async blank_filters_are_omitted_and_new_request_wins(){
  const env=setup();const first=env.list;assert.doesNotMatch(first.url,/rating_min=|rating_max=|speed=/);assert.match(first.url,/descending=false/);
  env.panel.filters.search='Dupont & fils';env.panel.offset=50;const second=env.panel.load(),latest=env.calls.at(-1);assert.equal(first.settings.signal.aborted,true);assert.match(latest.url,/search=Dupont\+%26\+fils/);
  latest.resolve(page([51],50));await second;first.resolve(page([1]));env.status.resolve({status:'completed',imported:100});await env.panel.ready;
  assert.equal(env.panel.data.entries[0].id,51);assert.equal(env.panel.offset,50);env.panel.dispose();
 },
 async filters_reset_offset_and_validate_range(){
  const {panel,calls}=await loaded();panel.offset=100;panel.form.values={search:' Carlsen ',sort:'white_elo',descending:'true',rating_min:'2500',rating_max:'2900',speed:'classical'};
  const filter=panel.applyFilters(),query=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(query.get('offset'),'0');assert.equal(query.get('search'),'Carlsen');assert.equal(query.get('rating_min'),'2500');assert.equal(query.get('descending'),'true');calls.at(-1).resolve(page([2]));await filter;
  panel.form.values.rating_min='3000';const length=calls.length;await assert.rejects(panel.applyFilters(),/minimum/);assert.equal(calls.length,length);panel.dispose();
 },
 async pagination_does_not_load_all_games(){
  const {panel,calls}=await loaded();const next=click(panel,{referenceAction:'next'});assert.match(calls.at(-1).url,/offset=50&limit=50/);calls.at(-1).resolve(page([51],50));await next;assert.equal(panel.offset,50);
  const previous=click(panel,{referenceAction:'previous'});assert.match(calls.at(-1).url,/offset=0&limit=50/);calls.at(-1).resolve(page());await previous;assert.equal(panel.offset,0);panel.dispose();
 },
 async dispose_aborts_both_requests_and_ignores_late_results(){
  let callbacks=0;const {panel,host,list,status}=setup({onStatus:()=>callbacks++});panel.dispose();assert.equal(list.settings.signal.aborted,true);assert.equal(status.settings.signal.aborted,true);list.resolve(page());status.resolve({status:'running',imported:200});await panel.ready;
  assert.equal(panel.data,null);assert.equal(callbacks,0);assert.equal(host.listeners.size,0);assert.equal(panel.form.listeners.size,0);assert.equal(panel.timer,undefined);
 },
 async request_failure_keeps_page_and_can_retry(){
  const {panel,calls}=await loaded();const task=panel.load();calls.at(-1).reject(new Error('Connexion interrompue'));await task;assert.equal(panel.data.entries[0].id,1);assert.equal(panel.errorHost.hidden,false);assert.match(panel.errorHost.textContent,/Connexion/);assert.equal(panel.loading,false);
  const retry=panel.load();calls.at(-1).resolve(page([2]));await retry;assert.equal(panel.data.entries[0].id,2);assert.equal(panel.errorHost.hidden,true);panel.dispose();
 },
 async failed_page_does_not_skip_the_retry_page(){
  const {panel,calls}=await loaded();const next=click(panel,{referenceAction:'next'});calls.at(-1).reject(new Error('Hors connexion'));await next;assert.equal(panel.offset,0);
  const retry=click(panel,{referenceAction:'next'});assert.match(calls.at(-1).url,/offset=50&limit=50/);calls.at(-1).resolve(page([51],50));await retry;assert.equal(panel.offset,50);panel.dispose();
 },
 async final_status_during_list_request_still_refreshes_final_count(){
  const {panel,calls,list,status}=setup();status.resolve({status:'completed',imported:150});await settle();assert.equal(panel.refreshPending,true);assert.equal(calls.length,2);
  list.resolve(page([1],0,100));await panel.ready;assert.equal(calls.length,2);assert.equal(panel.data.total,100);assert.match(panel.statusHost.innerHTML,/Actualiser la liste/);const refresh=click(panel,{referenceAction:'refresh'});calls.at(-1).resolve(page([1],0,150));await refresh;assert.equal(panel.data.total,150);assert.equal(panel.refreshPending,false);panel.dispose();
 },
 async polling_stops_on_terminal_status_and_disposal(){
  const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,scheduled=[],cancelled=[];globalThis.setTimeout=callback=>{const timer={callback};scheduled.push(timer);return timer;};globalThis.clearTimeout=timer=>{if(timer)cancelled.push(timer);};
  let panel;try{const env=await loaded();panel=env.panel;const poll=panel.poll();env.calls.at(-1).resolve({status:'running',imported:100});await poll;assert.equal(scheduled.length,1);
   const complete=panel.poll();env.calls.at(-1).resolve({status:'completed',imported:100});await complete;assert.equal(scheduled.length,1);assert.ok(cancelled.includes(scheduled[0]));panel.dispose();const before=env.calls.length;await scheduled[0].callback();assert.equal(env.calls.length,before);
  }finally{panel?.dispose();globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;}
 },
 async game_open_passes_liveness_and_prevents_double_open(){
  const gate=deferred();let calls=0,isCurrent;const {panel}=await loaded({onOpenGame:(id,options)=>{assert.equal(id,1);calls++;isCurrent=options.isCurrent;return gate.promise;}});
  const opening=click(panel,{referenceGame:'1'});assert.equal(panel.opening,true);await click(panel,{referenceGame:'1'});assert.equal(calls,1);assert.equal(isCurrent(),true);panel.dispose();assert.equal(isCurrent(),false);gate.resolve();await opening;assert.equal(panel.opening,false);
 },
 async changed_status_refreshes_only_current_page(){
  const {panel,calls}=await loaded();panel.offset=50;const polling=panel.poll();calls.at(-1).resolve({status:'completed',imported:200});await polling;assert.match(calls.at(-1).url,/\/status$/);const refresh=click(panel,{referenceAction:'refresh'});assert.match(calls.at(-1).url,/offset=50/);calls.at(-1).resolve(page([51],50,200));await refresh;assert.equal(panel.status.imported,200);assert.equal(panel.data.total,200);panel.dispose();
 },
 async pause_and_resume_use_dedicated_endpoints(){
  const {panel,calls}=await loaded();const pause=click(panel,{referenceAction:'pause'});assert.equal(calls.at(-1).url,'/api/reference-bases/17/cancel');assert.equal(calls.at(-1).settings.method,'POST');calls.at(-1).resolve({status:'paused'});await settle();assert.equal(calls.at(-1).url,'/api/reference-bases/17/status');calls.at(-1).resolve({status:'paused',imported:100});await pause;assert.equal(panel.mutating,false);assert.match(panel.statusHost.innerHTML,/Poursuivre/);
  const resume=click(panel,{referenceAction:'resume'});assert.equal(calls.at(-1).url,'/api/reference-bases/17/resume');calls.at(-1).resolve({});await settle();calls.at(-1).resolve({status:'running',imported:100});await resume;assert.match(panel.statusHost.innerHTML,/Mettre en pause/);panel.dispose();
 },
 async aborting_previous_status_does_not_revert_resume(){
  const {panel,calls}=await loaded();const old=panel.poll(),oldRequest=calls.at(-1);const resume=click(panel,{referenceAction:'resume'});calls.at(-1).resolve({});await settle();const latest=calls.at(-1);assert.equal(oldRequest.settings.signal.aborted,true);latest.resolve({status:'running',imported:100});await resume;oldRequest.resolve({status:'paused',imported:100});await old;assert.equal(panel.status.status,'running');panel.dispose();
 },
 async preparation_is_neutral_and_replaces_itself_with_completed_results(){
  await withFakeClock(async clock=>{const {panel,calls}=await preparing();try{
   assert.match(panel.gamesHost.innerHTML,/Préparation/);assert.match(panel.gamesHost.innerHTML,/role="progressbar"/);assert.doesNotMatch(panel.gamesHost.innerHTML,/Aucune partie|0\s*\/\s*0|reference-error|role="alert"/);assert.equal(panel.errorHost.hidden,true);assert.equal(clock.active().length,1);assert.equal(clock.active()[0].delay,3000);
   const initialUrl=calls[0].url;clock.fire(clock.active()[0]);await settle();assert.equal(calls.at(-1).url,initialUrl);calls.at(-1).resolve(page([7],0,42));await settle();
   assert.equal(panel.data.entries[0].id,7);assert.equal(panel.data.total,42);assert.match(panel.gamesHost.innerHTML,/Alice/);assert.doesNotMatch(panel.gamesHost.innerHTML,/Préparation/);assert.equal(panel.gamesHost.attributes['aria-busy'],'false');assert.equal(clock.active().length,0);assert.equal(panel.errorHost.hidden,true);
  }finally{panel.dispose();}});
 },
 async preparation_backoff_is_bounded_and_manual_refresh_restarts_it(){
  await withFakeClock(async clock=>{const {panel,calls}=await preparing();try{
   const start=clock.now(),delays=[];
   for(let attempt=0;clock.active().length&&attempt<110;attempt++){const timer=clock.active()[0];delays.push(timer.delay);clock.fire(timer);await settle();if(calls.at(-1).url.includes('/games?')){calls.at(-1).resolve(preparation());await settle();}}
   assert.equal(clock.active().length,0,'Automatic polling must stop after its bounded preparation window');assert.ok(delays.length>1&&delays.length<110);assert.equal(delays[0],3000);assert.ok(delays.every(delay=>delay>0&&delay<=15000));assert.ok(delays.slice(0,-1).every(delay=>delay>=3000),'Only the final remaining window may be shorter than the initial interval');assert.ok(delays.some(delay=>delay>delays[0]),'Preparation backs off instead of polling every three seconds forever');assert.ok(clock.now()-start>=300000&&clock.now()-start<=315000);assert.match(panel.gamesHost.innerHTML,/data-reference-action="refresh"/);assert.doesNotMatch(panel.gamesHost.innerHTML,/Aucune partie|0\s*\/\s*0/);
   const before=calls.length,retry=click(panel,{referenceAction:'refresh'});assert.equal(calls.length,before+1);calls.at(-1).resolve(preparation());await retry;assert.equal(clock.active().length,1);assert.equal(clock.active()[0].delay,3000);
  }finally{panel.dispose();}});
 },
 async filters_cancel_preparation_timer_and_late_inflight_response(){
  await withFakeClock(async clock=>{const {panel,calls}=await preparing();try{
   const oldTimer=clock.active()[0];panel.form.values.search='Carlsen';const firstFilter=panel.applyFilters();assert.equal(oldTimer.cancelled,true);assert.match(calls.at(-1).url,/search=Carlsen/);const before=calls.length;oldTimer.callback();await settle();assert.equal(calls.length,before,'A cancelled timer cannot restart the previous query');calls.at(-1).resolve(preparation());await firstFilter;
   clock.fire(clock.active()[0]);await settle();const oldRequest=calls.at(-1);panel.form.values.search='Kasparov';const secondFilter=panel.applyFilters();assert.equal(oldRequest.settings.signal.aborted,true);assert.match(calls.at(-1).url,/search=Kasparov/);calls.at(-1).resolve(page([22],0,1));await secondFilter;oldRequest.resolve(preparation());await settle();
   assert.equal(panel.data.entries[0].id,22);assert.equal(clock.active().length,0);assert.doesNotMatch(panel.gamesHost.innerHTML,/Préparation/);assert.equal(panel.errorHost.hidden,true);
  }finally{panel.dispose();}});
 },
 async new_filter_hides_previous_results_during_preparation(){
  await withFakeClock(async clock=>{const {panel,calls}=await loaded();try{
   assert.match(panel.gamesHost.innerHTML,/Alice/);panel.form.values.search='Nobody';const search=panel.applyFilters();assert.doesNotMatch(panel.gamesHost.innerHTML,/Alice|Aucune partie/,'Previous rows must not appear to match a newly submitted filter');calls.at(-1).resolve(preparation());await search;assert.doesNotMatch(panel.gamesHost.innerHTML,/Alice|Aucune partie|0\s*\/\s*0/);assert.match(panel.gamesHost.innerHTML,/Préparation/);
   clock.fire(clock.active()[0]);await settle();calls.at(-1).resolve(page([],0,0));await settle();assert.match(panel.gamesHost.innerHTML,/Aucune partie disponible avec ces filtres/);assert.match(panel.gamesHost.innerHTML,/0–0 sur 0/);assert.doesNotMatch(panel.gamesHost.innerHTML,/Préparation/);assert.equal(clock.active().length,0);
  }finally{panel.dispose();}});
 },
 async pagination_replaces_preparation_without_replaying_the_old_page(){
  await withFakeClock(async clock=>{const {panel,calls}=await preparing();try{
   const oldTimer=clock.active()[0];panel.offset=50;const nextPage=panel.load();assert.equal(oldTimer.cancelled,true);assert.match(calls.at(-1).url,/offset=50&limit=50/);calls.at(-1).resolve(page([51],50,100));await nextPage;const before=calls.length;oldTimer.callback();await settle();assert.equal(calls.length,before);assert.equal(panel.offset,50);assert.equal(panel.data.entries[0].id,51);assert.equal(clock.active().length,0);
  }finally{panel.dispose();}});
 },
 async disposing_preparation_cancels_timer_and_aborts_inflight_request(){
  await withFakeClock(async clock=>{
   const first=await preparing(),timer=clock.active()[0];first.panel.dispose();assert.equal(timer.cancelled,true);const before=first.calls.length;timer.callback();await settle();assert.equal(first.calls.length,before);
   const second=await preparing();clock.fire(clock.active()[0]);await settle();const request=second.calls.at(-1),html=second.panel.gamesHost.innerHTML;second.panel.dispose();assert.equal(request.settings.signal.aborted,true);request.resolve(page([99]));await settle();assert.equal(second.panel.gamesHost.innerHTML,html);assert.equal(clock.active().length,0);
  });
 },
 async preparation_failure_offers_manual_retry_without_a_false_empty_result(){
  await withFakeClock(async clock=>{const {panel,calls}=await preparing();try{
   clock.fire(clock.active()[0]);await settle();calls.at(-1).reject(new Error('Connexion interrompue'));await settle();assert.equal(clock.active().length,0);assert.equal(panel.errorHost.hidden,false);assert.match(panel.errorHost.textContent,/Connexion interrompue/);assert.match(panel.gamesHost.innerHTML,/data-reference-action="refresh"/);assert.doesNotMatch(panel.gamesHost.innerHTML,/Aucune partie|0\s*\/\s*0/);
   const retry=click(panel,{referenceAction:'refresh'});calls.at(-1).resolve(page([9],0,1));await retry;assert.equal(panel.data.entries[0].id,9);assert.equal(panel.errorHost.hidden,true);assert.equal(clock.active().length,0);
  }finally{panel.dispose();}});
 }
};
const selected=process.argv[2];if(selected){assert.ok(tests[selected]);await tests[selected]();console.log(selected+' passed');}else for(const [name,test] of Object.entries(tests)){await test();console.log(name+' passed');}
