import assert from 'node:assert/strict';
import {DEFAULT_ENGINE_SETTINGS,applyEngineSettings,getEngineSettings,engineSettingsLoaded,engineSearchSettings,loadEngineSettings,saveEngineSettings,openEngineSettings} from '../static/engine-settings.js';
const requests=[];
globalThis.fetch=async(url,options={})=>{const data=await new Promise(resolve=>requests.push({url,options,body:options.body?JSON.parse(options.body):null,resolve}));return {ok:!data.__error,status:data.__error?503:200,headers:{get:()=> 'application/json'},json:async()=>data.__error?{detail:data.__error}:data};};
function dialogMock(){
 const state={};state.open=(title,html,options)=>{
  state.title=title;state.html=html;state.options=options;
  const elements={};for(const name of ['time_seconds','depth'])elements[name]={value:html.match(new RegExp('name="'+name+'"[^>]*value="([^"]*)"'))?.[1]||'',validity:{badInput:false}};
  elements.mode={value:html.match(/<option value="([^"]+)" selected/)?.[1]||'time'};
  state.sections={'[data-engine-duration]':{hidden:false},'[data-engine-depth]':{hidden:false},'[data-engine-unlimited]':{hidden:false}};
  state.form={elements,querySelector:selector=>state.sections[selector]};state.dialog={open:true,querySelector:()=>state.form};return state.dialog;
 };
 state.submit=()=>state.options.onSubmit(new Map([['mode',state.form.elements.mode.value]]),state.form);
 return state;
}
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const tests={
 async lazy_loading_is_shared_and_persisted_settings_control_search(){
  assert.equal(engineSettingsLoaded(),false);assert.equal(requests.length,0);const a=loadEngineSettings(),b=loadEngineSettings();assert.equal(requests.length,1);assert.equal(requests[0].url,'/api/engine/settings');requests[0].resolve({mode:'depth',time_ms:2500,depth:24});await Promise.all([a,b]);assert.deepEqual(engineSearchSettings(),{multipv:3,time_ms:null,depth:24});await loadEngineSettings();assert.equal(requests.length,1);const copy=getEngineSettings();copy.depth=30;assert.equal(getEngineSettings().depth,24);
 },
 async time_dialog_saves_bounds_and_reopens_saved_values(){
  applyEngineSettings();const d=dialogMock(),saved=[];await openEngineSettings({openDialog:d.open,onSaved:settings=>saved.push(settings)});assert.equal(d.title,'Réglages du moteur');assert.equal(d.sections['[data-engine-depth]'].hidden,true);assert.match(d.html,/min="0.1"/);assert.doesNotMatch(d.html,/max="(?:60|30)"/);d.form.elements.time_seconds.value='0.1';const submit=d.submit();assert.deepEqual(requests[0].body,{mode:'time',time_ms:100,depth:18});requests[0].resolve(requests[0].body);await submit;assert.equal(saved.length,1);assert.deepEqual(engineSearchSettings(),{multipv:3,time_ms:100,depth:null});
  const reopen=dialogMock();await openEngineSettings({openDialog:reopen.open});assert.equal(reopen.form.elements.time_seconds.value,'0.1');assert.equal(requests.length,1);reopen.form.elements.time_seconds.value='3600';const last=reopen.submit();requests.at(-1).resolve(requests.at(-1).body);await last;assert.equal(getEngineSettings().time_ms,3600000);
 },
 async depth_dialog_has_no_implicit_time_limit(){
  applyEngineSettings({mode:'time',time_ms:5000,depth:18});const d=dialogMock();await openEngineSettings({openDialog:d.open});d.form.elements.mode.value='depth';d.form.elements.mode.onchange();assert.equal(d.sections['[data-engine-duration]'].hidden,true);assert.equal(d.sections['[data-engine-depth]'].hidden,false);assert.match(d.html,/sans limite de temps/);d.form.elements.depth.value='80';const submit=d.submit();assert.deepEqual(requests[0].body,{mode:'depth',time_ms:5000,depth:80});requests[0].resolve(requests[0].body);await submit;assert.deepEqual(engineSearchSettings(),{multipv:3,time_ms:null,depth:80});
 },
 async infinite_mode_has_no_search_limit_and_preserves_other_choices(){
  applyEngineSettings({mode:'time',time_ms:5000,depth:80});const d=dialogMock();await openEngineSettings({openDialog:d.open});d.form.elements.mode.value='infinite';d.form.elements.mode.onchange();assert.equal(d.sections['[data-engine-duration]'].hidden,true);assert.equal(d.sections['[data-engine-depth]'].hidden,true);assert.equal(d.sections['[data-engine-unlimited]'].hidden,false);assert.match(d.html,/change de position pour arrêter/);const save=d.submit();requests[0].resolve(requests[0].body);await save;assert.deepEqual(getEngineSettings(),{mode:'infinite',time_ms:5000,depth:80});assert.deepEqual(engineSearchSettings(),{multipv:3,time_ms:null,depth:null});
 },
 async invalid_active_values_never_reach_server_and_hidden_values_keep_previous(){
  applyEngineSettings();const d=dialogMock();await openEngineSettings({openDialog:d.open});for(const value of ['', '0', '-1', '9007199254741', 'Infinity','0.099']){d.form.elements.time_seconds.value=value;await assert.rejects(d.submit(),/durée/);}d.form.elements.mode.value='depth';for(const value of ['', '0','2147483648','18.5','Infinity']){d.form.elements.depth.value=value;await assert.rejects(d.submit(),/profondeur/);}assert.equal(requests.length,0);d.form.elements.depth.value='8';d.form.elements.time_seconds.value='';const submit=d.submit();assert.deepEqual(requests[0].body,{mode:'depth',time_ms:1000,depth:8});requests[0].resolve(requests[0].body);await submit;
 },
 async failed_load_retries_and_failed_save_leaves_current_settings(){
  const d=dialogMock(),first=openEngineSettings({openDialog:d.open});requests[0].resolve({__error:'Réglages indisponibles'});await assert.rejects(first,/indisponibles/);assert.equal(d.dialog,undefined);assert.equal(engineSettingsLoaded(),false);const retry=openEngineSettings({openDialog:d.open});requests[1].resolve(DEFAULT_ENGINE_SETTINGS);await retry;d.form.elements.time_seconds.value='5';const save=d.submit();requests[2].resolve({__error:'Sauvegarde refusée'});await assert.rejects(save,/refusée/);assert.deepEqual(getEngineSettings(),DEFAULT_ENGINE_SETTINGS);
 },
 async stale_dialogs_neither_open_nor_submit_and_closed_save_does_not_restart(){
  let active=true,updates=0;const d=dialogMock(),opening=openEngineSettings({openDialog:d.open,isCurrent:()=>active});active=false;requests[0].resolve(DEFAULT_ENGINE_SETTINGS);assert.equal(await opening,null);assert.equal(d.dialog,undefined);
  active=true;await openEngineSettings({openDialog:d.open,isCurrent:()=>active,onSaved:()=>updates++});active=false;await d.submit();assert.equal(requests.length,1);active=true;d.form.elements.time_seconds.value='5';const save=d.submit();d.dialog.open=false;requests.at(-1).resolve(requests.at(-1).body);await save;assert.equal(updates,0);assert.equal(getEngineSettings().time_ms,5000);
 },
 async closed_dialog_saves_are_serialized_and_latest_choice_wins_on_server(){
  applyEngineSettings();const first=dialogMock(),second=dialogMock(),updates=[];let server={...DEFAULT_ENGINE_SETTINGS};
  await openEngineSettings({openDialog:first.open,onSaved:()=>updates.push('first')});first.form.elements.time_seconds.value='2';const old=first.submit();first.dialog.open=false;
  await openEngineSettings({openDialog:second.open,onSaved:()=>updates.push('second')});second.form.elements.mode.value='depth';second.form.elements.time_seconds.value='5';second.form.elements.depth.value='24';const latest=second.submit();
  assert.equal(requests.length,1,'The second PATCH must wait until the first write finishes');await settle();assert.equal(requests.length,1);
  server={...requests[0].body};requests[0].resolve(server);await old;await settle();assert.equal(requests.length,2);assert.deepEqual(getEngineSettings(),DEFAULT_ENGINE_SETTINGS,'The superseded response must not change current settings');
  server={...requests[1].body};requests[1].resolve(server);await latest;assert.deepEqual(server,{mode:'depth',time_ms:5000,depth:24});assert.deepEqual(getEngineSettings(),server);assert.deepEqual(updates,['second']);
 },
 async failed_first_save_allows_queued_save_and_stale_initial_load_is_ignored(){
  const initial=loadEngineSettings();const first=saveEngineSettings({mode:'time',time_ms:2000,depth:18});const rejected=assert.rejects(first,/refusée/);const latest=saveEngineSettings({mode:'depth',time_ms:5000,depth:24});
  assert.equal(requests.length,2);requests[1].resolve({__error:'Sauvegarde refusée'});await rejected;await settle();assert.equal(requests.length,3,'A failed PATCH must not block the next selection');
  requests[0].resolve({mode:'time',time_ms:4000,depth:12});await initial;assert.deepEqual(getEngineSettings(),DEFAULT_ENGINE_SETTINGS,'The initial GET must not apply while newer settings are queued');
  const server={...requests[2].body};requests[2].resolve(server);await latest;assert.deepEqual(getEngineSettings(),server);assert.equal(engineSettingsLoaded(),true);
  const following=saveEngineSettings({mode:'time',time_ms:3000,depth:24});assert.equal(requests.length,4);requests[3].resolve(requests[3].body);await following;assert.equal(getEngineSettings().time_ms,3000);
 },
 async late_initial_load_after_failed_then_successful_queue_keeps_latest_choice(){
  const initial=loadEngineSettings();const first=saveEngineSettings({mode:'time',time_ms:2000,depth:18}),rejected=assert.rejects(first,/refusée/);const latest=saveEngineSettings({mode:'depth',time_ms:5000,depth:24});
  requests[1].resolve({__error:'Sauvegarde refusée'});await rejected;await settle();const server={...requests[2].body};requests[2].resolve(server);await latest;
  requests[0].resolve(DEFAULT_ENGINE_SETTINGS);assert.deepEqual(await initial,server);assert.deepEqual(getEngineSettings(),server);
 },
 async new_load_waits_for_pending_saves_instead_of_reading_older_server_state(){
  const first=saveEngineSettings({mode:'time',time_ms:2000,depth:18}),latest=saveEngineSettings({mode:'depth',time_ms:5000,depth:24});const read=loadEngineSettings();assert.equal(requests.length,1);
  requests[0].resolve(requests[0].body);await first;await settle();assert.equal(requests.length,2);requests[1].resolve(requests[1].body);await latest;assert.deepEqual(await read,{mode:'depth',time_ms:5000,depth:24});assert.equal(requests.length,2,'No stale GET should be sent during a pending settings write');
 },
 async late_load_cannot_overwrite_newly_saved_settings(){
  const old=loadEngineSettings(),save=saveEngineSettings({mode:'depth',time_ms:5000,depth:22});requests[1].resolve(requests[1].body);await save;requests[0].resolve(DEFAULT_ENGINE_SETTINGS);await old;assert.deepEqual(getEngineSettings(),{mode:'depth',time_ms:5000,depth:22});
 },
};
const selected=process.argv[2];assert.ok(tests[selected]);await tests[selected]();console.log(selected+' passed');
