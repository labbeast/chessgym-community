import {t,ui} from './i18n.js';
import {api,esc} from './api.js';

const endpoint='/api/app-updates';
export const appUpdateRunning=job=>['running','checking','preparing','installing','restarting'].includes(job?.state);
export function appUpdatesSettingsHtml(){return ui('<section class="panel settings-width app-updates-panel"><h2>Mise à jour de ChessGym</h2><div id="app-updates-settings"><p class="hint">Chargement…</p></div></section>');}

export function appUpdateStatusHtml(data){
 const job=data.job,percent=Math.max(0,Math.min(100,Number(job?.progress)||0));
 const versionLabel=(label,value)=>esc(t(label)).replace(/\{version\}/g,()=>'<bdi dir="ltr">'+esc(value||'—')+'</bdi>');
 return '<div class="app-update-versions"><p>'+versionLabel('Version installée : {version}',data.current_version)+'</p>'+
  (data.available?'<p class="app-update-available">'+versionLabel('Version disponible : {version}',data.available.version||data.available.tag)+'</p>':'')+'</div>'+
  (!data.supported?'<p class="hint">'+esc(t(data.reason||'La mise à jour automatique n’est pas disponible pour cette installation.'))+'</p>':'')+
  (job?'<div class="app-update-job" role="status" aria-live="polite">'+(job.stage?'<p>'+esc(t(job.stage))+'</p>':'')+(appUpdateRunning(job)?'<progress max="100" value="'+percent+'" aria-label="'+esc(t('Progression de la mise à jour'))+'"></progress>':'')+(job.error?'<p class="error-text">'+esc(t(job.error))+'</p>':'')+'</div>':'')+
  (data.restart_required?ui('<p class="hint">La nouvelle version est prête. Le redémarrage applique la mise à jour et conserve tes données.</p>'):'');
}

export function bindAppUpdates(host,{request=api,isCurrent=()=>true,beforeRestart=null,onRestarted=()=>globalThis.location?.reload(),pollMs=2000}={}){
 const root=host?.querySelector('#app-updates-settings');if(!root)return {dispose(){}};
 const controller=new AbortController();let disposed=false,data=null,busy=false,timer=null,reconnecting=false,dirty=false,misses=0,mutationAttempted=false;
 const active=()=>!disposed&&isCurrent(),query=selector=>root.querySelector(selector);
 const call=(path='',options={})=>{if(options.method&&options.method!=='GET')mutationAttempted=true;return request(endpoint+path,{...options,signal:controller.signal});};
 root.innerHTML=ui('<div data-app-update-status></div><div class="actions app-update-actions"><button type="button" data-app-update-check disabled>Vérifier les nouvelles versions</button><button type="button" class="primary" data-app-update-install disabled hidden>Préparer la mise à jour</button><button type="button" class="primary" data-app-update-restart hidden>Redémarrer et mettre à jour</button></div><p data-app-update-message role="status" aria-live="polite"></p><details class="app-update-automation" data-app-update-automation><summary>Mises à jour automatiques</summary><form data-app-update-settings><label class="checkbox"><input type="checkbox" name="automatic_updates" disabled> Mettre ChessGym à jour automatiquement chaque semaine</label><p class="hint">La mise à jour prépare une sauvegarde et redémarre le serveur après une période d’inactivité. Les modifications locales du code sont préservées.</p><button type="submit" disabled>Enregistrer la mise à jour de ChessGym</button></form></details>');
 function message(value,error=false){if(!active())return;query('[data-app-update-message]').textContent=value;query('[data-app-update-message]').classList.toggle('error-text',error);}
 function lock(){
  if(!active())return;const working=busy||reconnecting||appUpdateRunning(data?.job),supported=!!data?.supported;
  query('[data-app-update-check]').disabled=working||!supported;
  query('[data-app-update-install]').hidden=!data?.available||!!data?.restart_required||reconnecting;
  query('[data-app-update-install]').disabled=working||!supported||!data?.available||!!data?.restart_required;
  query('[data-app-update-restart]').hidden=!data?.restart_required&&!reconnecting;
  query('[data-app-update-restart]').disabled=working||!data?.restart_required;
  query('[name="automatic_updates"]').disabled=busy||!data||(!supported&&!data.settings?.automatic_updates);
  query('[type="submit"]').disabled=busy||!data||(!supported&&!data.settings?.automatic_updates);
 }
 function schedule(){clearTimeout(timer);timer=null;if(active()&&(!data||reconnecting||appUpdateRunning(data?.job)||data?.restart_required||data?.settings?.automatic_updates))timer=setTimeout(poll,pollMs);}
 function render(value){if(!active())return;const firstLoad=!data;data=value;if(value.job?.state==='restarting')reconnecting=true;query('[data-app-update-status]').innerHTML=appUpdateStatusHtml(value);if(!dirty)query('[name="automatic_updates"]').checked=!!value.settings?.automatic_updates;if(firstLoad)query('[data-app-update-automation]').open=!!value.settings?.automatic_updates;lock();schedule();}
 async function poll(){
  if(!active())return;
  try{const value=await call();if(!active())return;const terminal=!value.restart_required&&!appUpdateRunning(value.job),changed=!!data?.current_version&&!!value.current_version&&data.current_version!==value.current_version;
   const resumed=terminal&&value.job?.state==='completed'&&(reconnecting||changed),failed=terminal&&value.job?.state==='failed'&&reconnecting;
   const stillReady=reconnecting&&value.restart_required&&value.job?.state==='ready',recovered=misses>0;if(resumed||failed||stillReady)reconnecting=false;render(value);misses=0;
   if(failed)message(t(value.job.error||value.job.stage||'La mise à jour de ChessGym a échoué.'),true);
   else if(resumed){try{await beforeRestart?.();if(!active())return;message(t('ChessGym a redémarré. Actualisation de l’interface…'));await onRestarted?.();}catch(error){if(active()&&error.name!=='AbortError')message(error.message,true);}}
   else if(stillReady)message(t('Mise à jour prête. Redémarrage nécessaire.'));
   else if(recovered)message('');}
  catch(error){if(active()&&error.name!=='AbortError'){misses++;message(t(reconnecting?'Redémarrage en cours. La reconnexion est automatique.':'Connexion temporairement indisponible.'),!reconnecting);if(misses>=150){reconnecting=false;message(t('La reconnexion prend plus de temps que prévu. Relance ChessGym, puis actualise cette page.'),true);lock();return;}}}
  schedule();
 }
 async function perform(action){if(!active()||busy)return;busy=true;mutationAttempted=false;lock();message('');try{await action();}catch(error){if(active()&&error.name!=='AbortError'){if(reconnecting){message(t('Redémarrage en cours. La reconnexion est automatique.'));schedule();}else{if(mutationAttempted){try{render(await call());}catch{}}message(error.message,true);}}}finally{busy=false;lock();}}
 root.onclick=event=>{
  const button=event.target.closest?.('button');if(!button||button.disabled||!active())return;
  if(Object.hasOwn(button.dataset,'appUpdateCheck'))void perform(async()=>render(await call('/check',{method:'POST',body:{}})));
  else if(Object.hasOwn(button.dataset,'appUpdateInstall'))void perform(async()=>render(await call('/install',{method:'POST',body:{}})));
  else if(Object.hasOwn(button.dataset,'appUpdateRestart'))void perform(async()=>{
   await beforeRestart?.();if(!active())return;reconnecting=true;misses=0;
   try{render(await call('/restart',{method:'POST',body:{}}));}catch(error){if(error.status){reconnecting=false;throw error;}throw error;}
   message(t('Redémarrage en cours. La reconnexion est automatique.'));schedule();
  });
 };
 root.onchange=event=>{if(event.target.name==='automatic_updates')dirty=true;};
 root.onsubmit=event=>{if(!event.target.matches?.('[data-app-update-settings]'))return;event.preventDefault();void perform(async()=>{
  const automatic_updates=!!query('[name="automatic_updates"]').checked;
  const value=await call('/settings',{method:'PATCH',body:{automatic_updates,interval_hours:168}});dirty=false;render(value);message(t('Mise à jour automatique de ChessGym enregistrée.'));
 });};
 call().then(render).catch(error=>{if(active()&&error.name!=='AbortError'){misses++;message(error.message,true);schedule();}});
 return {dispose(){disposed=true;clearTimeout(timer);controller.abort();root.onclick=null;root.onchange=null;root.onsubmit=null;}};
}
