import {CollectionList} from './list-view.js';
import {t,ui} from './i18n.js';
import {api,esc,option,field} from './api.js';

const endpoint='/api/engines';
const running=job=>job?.state==='running';
const roleLabel=role=>t(role==='maia'?'Jeu humain':'Analyse et jeu classique');
const shortVersion=value=>/^[a-f0-9]{32,64}$/i.test(value||'')?value.slice(0,8):value;
const sourceLink=item=>{try{const url=new URL(item.source_url);return url.protocol==='https:'&&['github.com','huggingface.co'].includes(url.hostname)?'<a href="'+esc(url.href)+'" target="_blank" rel="noopener noreferrer">'+t('Source et licence')+'</a>':'';}catch{return '';}};
export const engineEntryPayload=values=>({name:String(values.get('name')||'').trim(),path:String(values.get('path')||'').trim()});
export const engineSelectionPayload=values=>({analysis:values.get('analysis')||null,maia:values.get('maia')||null});

export function engineManagerSettingsHtml(){return ui('<section class="panel engine-manager-panel"><h2>Moteurs</h2><div id="engine-manager-settings"><p class="hint">Chargement…</p></div></section>');}

export function engineRolesHtml(data,selection=data.selected||{}){
 return ['analysis','maia'].map(role=>{
  const engines=(data.engines||[]).filter(engine=>role==='maia'?engine.kind==='maia':engine.kind==='uci');
  return '<label>'+esc(roleLabel(role))+'<select name="'+role+'">'+option('',t('Aucun moteur'),selection[role]||'')+engines.map(engine=>'<option value="'+esc(engine.id)+'"'+(engine.id===selection[role]?' selected':'')+(!engine.available&&engine.id!==selection[role]?' disabled':'')+'>'+esc(engine.name+(engine.available?'':' · '+t('Indisponible')))+'</option>').join('')+'</select></label>';
 }).join('');
}

export function installedEnginesHtml(engines=[]){
 if(!engines.length)return ui('<p class="hint">Aucun moteur installé.</p>');
 return engines.map(engine=>{
  const roles=engine.active||[],active=roles.length>0,id=esc(engine.id);
  return '<article class="engine-card" data-engine-card="'+id+'"><div class="engine-card-title"><strong>'+esc(engine.name)+'</strong><span class="engine-state '+(engine.available?'ready':'missing')+'">'+esc(t(engine.available?'Disponible':'Indisponible'))+'</span></div><div class="engine-card-meta">'+
   (engine.version?'<span title="'+esc(engine.version)+'">'+esc(shortVersion(engine.version))+'</span>':'')+'<span>'+esc(engine.kind==='maia'?t('Modèle humain'):'UCI')+'</span>'+(engine.managed?'<span>'+esc(t('Géré par ChessGym'))+'</span>':'')+'</div>'+
   (roles.length?'<div class="engine-role-tags">'+roles.map(role=>'<span>'+esc(roleLabel(role))+'</span>').join('')+'</div>':'')+
   (engine.path?'<p class="engine-path" title="'+esc(engine.path)+'">'+esc(engine.path)+'</p>':'')+
   '<div class="actions"><button type="button" data-engine-test="'+id+'">'+t('Tester')+'</button><button type="button" data-engine-remove="'+id+'"'+(active?' disabled title="'+esc(t('Choisis d’abord un autre moteur pour ce rôle.'))+'"':'')+'>'+t('Retirer…')+'</button></div>'+
   (active?ui('<p class="hint engine-active-note">Pour le retirer, sélectionne d’abord un autre moteur ci-dessus.</p>'):'')+
   '<details data-engine-edit-details="'+id+'"><summary>'+t('Modifier')+'</summary><form data-engine-edit="'+id+'">'+field(t('Nom du moteur'),'name',engine.name,'text','required maxlength="100"')+
   (engine.kind==='uci'&&!engine.managed?field(t('Fichier exécutable sur le serveur'),'path',engine.path,'text','required spellcheck="false"'):'')+
   '<button type="submit">'+t('Enregistrer')+'</button></form></details><div class="engine-remove-confirm" data-engine-confirm="'+id+'" hidden><p>'+esc(t('Retirer {name} de ChessGym ? Ses fichiers restent sur le disque.',{name:engine.name}))+'</p><div class="actions"><button type="button" data-engine-delete="'+id+'">'+t('Retirer le moteur')+'</button><button type="button" data-engine-cancel="'+id+'">'+t('Annuler')+'</button></div></div></article>';
 }).join('');
}

export function engineCatalogHtml(catalog=[],job=null){
 return catalog.map(item=>'<article class="engine-card engine-catalog-card"><div class="engine-card-title"><strong>'+esc(item.name)+'</strong>'+(item.version?'<span class="muted" title="'+esc(item.version)+'">'+esc(shortVersion(item.version))+'</span>':'')+'</div>'+
  (item.description?'<p class="hint">'+esc(t(item.description))+'</p>':'')+'<div class="engine-card-meta">'+(Number(item.download_bytes)>0?'<span>'+esc(t('{size} Mo à télécharger',{size:Math.round(item.download_bytes/1048576)}))+'</span>':'')+sourceLink(item)+'</div><button type="button" data-engine-install="'+esc(item.id)+'"'+(!item.available||running(job)?' disabled':'')+'>'+t('Installer une version')+'</button></article>').join('');
}

export function engineJobHtml(job){
 if(!job)return '';
 const percent=Math.max(0,Math.min(100,Number(job.progress)||0)),title=t(job.state==='completed'?'Installation terminée':job.state==='failed'?'Installation interrompue':'Installation en cours…');
 return '<div class="engine-job '+esc(job.state)+'" role="status"><strong>'+esc(title)+'</strong>'+(running(job)?'<progress max="100" value="'+percent+'" aria-label="'+esc(title)+'"></progress>':'')+
  (job.stage?'<span>'+esc(t(job.stage))+'</span>':'')+(job.error?'<p class="engine-manager-error">'+esc(t(job.error))+'</p>':'')+(job.state==='completed'?ui('<p class="hint">Le moteur a été ajouté. Sélectionne-le ci-dessus pour l’utiliser.</p>'):'')+'</div>';
}

export function engineUpdatesHtml(data){
 if(!data)return '';
 const rows=[];
 if(data.stockfish)rows.push('<li><strong>Stockfish</strong> · '+esc(data.stockfish.version||'—')+(data.stockfish.description?' — '+esc(t(data.stockfish.description)):'')+'</li>');
 if(data.maia3)rows.push('<li><strong>Maia 3</strong> · '+esc(data.maia3.version||'—')+(data.maia3.new_upstream?' — '+esc(t('Des changements sont disponibles en amont. Le catalogue présente les versions validées pour ChessGym.')):'')+(data.maia3.description?' — '+esc(t(data.maia3.description)):'')+'</li>');
 for(const error of data.errors||[])rows.push('<li class="engine-manager-error">'+esc(typeof error==='string'?t(error):error.message||JSON.stringify(error))+'</li>');
 return '<ul class="engine-updates">'+rows.join('')+'</ul>';
}

// Settings tabs keep this host mounted. Refresh only the catalogue and job areas;
// add/edit/selection drafts survive polling and tab navigation.
export function bindEngineManager(host,{isCurrent=()=>true,request=api,onChanged=null,pollMs=1500}={}){
 const root=host?.querySelector('#engine-manager-settings');if(!root)return {dispose(){}};
 let engineList=null;
 let disposed=false,busy=false,timer=null,data=null,selectionDirty=false,job=null;
 const controller=new AbortController(),active=()=>!disposed&&isCurrent();
 const changed=async()=>{if(active())await onChanged?.();};
 const query=selector=>root.querySelector(selector);
 root.innerHTML=ui('<p class="hint">Ces moteurs fonctionnent sur la machine qui héberge ChessGym. Le choix s’applique aux prochains calculs.</p><form data-engine-roles><div class="engine-role-selects" data-engine-role-fields></div><button type="submit">Appliquer les moteurs</button></form><p class="engine-manager-result" data-engine-result role="status" aria-live="polite"></p><div data-engine-job></div><h3>Moteurs installés</h3><div class="engine-card-grid" data-engine-list></div><details class="engine-add"><summary>Ajouter un moteur UCI local</summary><form data-engine-add><div class="fields">')+field(t('Nom du moteur'),'name','','text','required maxlength="100"')+field(t('Fichier exécutable sur le serveur'),'path','','text','required spellcheck="false" placeholder="C:\\Moteurs\\engine.exe"')+ui('</div><p class="hint">Indique le chemin d’un moteur déjà présent sur le PC ou serveur de ChessGym. Le fichier est testé avant son ajout.</p><button type="submit">Ajouter le moteur</button></form></details><div class="engine-catalog-heading"><h3>Catalogue officiel</h3><button type="button" data-engine-updates>Vérifier les mises à jour</button></div><p class="hint">L’installation ajoute une version séparée. Le moteur actif reste en place jusqu’à ce que tu changes la sélection.</p><div data-engine-updates-result></div><div class="engine-card-grid" data-engine-catalog></div>');
 const result=(message,error=false)=>{if(!active())return;const target=query('[data-engine-result]');target.textContent=message;target.classList.toggle('engine-manager-error',error);};
 const call=(path,options={})=>request(endpoint+path,{...options,signal:controller.signal});
 const revision=payload=>Number.isInteger(data?.revision)?{...payload,expected_revision:data.revision}:payload;
 const lock=value=>{busy=value;if(!active())return;root.querySelectorAll('button').forEach(button=>{if(value){button.dataset.engineWasDisabled=String(button.disabled);button.disabled=true;}else if(button.dataset.engineWasDisabled!==undefined){button.disabled=button.dataset.engineWasDisabled==='true';delete button.dataset.engineWasDisabled;}});};
 const render=value=>{
  if(!active()||(Number.isInteger(data?.revision)&&Number.isInteger(value?.revision)&&value.revision<data.revision))return;data=value;job=value.job??job;
  const roles=query('[data-engine-roles]'),draft=selectionDirty?engineSelectionPayload(new FormData(roles)):value.selected;
  query('[data-engine-role-fields]').innerHTML=engineRolesHtml(value,draft);roles.querySelector('button').disabled=busy;
  const edits=[...root.querySelectorAll('[data-engine-edit]')].map(form=>({id:form.dataset.engineEdit,values:engineEntryPayload(new FormData(form)),open:form.parentElement.open}));
  engineList?.dispose();query('[data-engine-list]').innerHTML=installedEnginesHtml(value.engines);
  if(root.ownerDocument&&value.engines?.length){const list=query('[data-engine-list]');engineList=new CollectionList(list,{stateKey:'engines',placeholder:'Rechercher un moteur…',items:[...list.querySelectorAll('[data-engine-card]')].map(node=>{const engine=value.engines.find(item=>String(item.id)===node.dataset.engineCard);return {node,text:[engine.name,engine.version,engine.kind].join(' '),values:{available:engine.available?'yes':'no',kind:engine.kind},sort:{name:engine.name}};}),filters:[{key:'available',label:'Disponibilité',options:[['yes','Disponible'],['no','Indisponible']]},{key:'kind',label:'Type',advanced:true,options:[['uci','UCI'],['maia','Maia']]}]});}
  for(const edit of edits){const form=[...root.querySelectorAll('[data-engine-edit]')].find(item=>item.dataset.engineEdit===edit.id);if(!form)continue;form.parentElement.open=edit.open;for(const [key,val] of Object.entries(edit.values)){const input=form.elements.namedItem(key);if(input)input.value=val;}}
  query('[data-engine-catalog]').innerHTML=engineCatalogHtml(value.catalog,job);query('[data-engine-job]').innerHTML=engineJobHtml(job);schedule();
 };
 const load=async()=>{const value=await call('/catalog');if(active())render(value);return value;};
 function schedule(){clearTimeout(timer);timer=null;if(active()&&running(job))timer=setTimeout(poll,pollMs);}
 async function poll(){
  if(!active())return;
  if(root.closest?.('[data-settings-panel]')?.hidden){schedule();return;}
  try{const value=await call('/jobs/'+encodeURIComponent(job.id));if(!active())return;job=value.job||value;query('[data-engine-job]').innerHTML=engineJobHtml(job);if(!running(job)){await load();await changed();}else schedule();}
  catch(error){if(active()&&error.name!=='AbortError'){result(error.message,true);schedule();}}
 }
 async function perform(action,success){
  if(busy||!active())return;lock(true);result('');
  try{await action();if(!active())return;if(success)result(t(success));}
  catch(error){if(active()&&error.name!=='AbortError'){if(error.status===409){try{await load();}catch{}}result(error.message,true);}}
  finally{lock(false);}
 }
 root.oninput=event=>{if(event.target.closest?.('[data-engine-roles]'))selectionDirty=true;};
 root.onsubmit=event=>{
  const form=event.target;if(!form.matches?.('[data-engine-roles],[data-engine-add],[data-engine-edit]'))return;event.preventDefault();
  if(form.matches('[data-engine-roles]'))void perform(async()=>{const value=await call('/selection',{method:'PATCH',body:revision(engineSelectionPayload(new FormData(form)))});selectionDirty=false;render(value);await changed();},'Moteurs sélectionnés.');
  else if(form.matches('[data-engine-add]'))void perform(async()=>{const value=await call('',{method:'POST',body:revision(engineEntryPayload(new FormData(form)))});if(active()){form.reset();render(value);await changed();}},'Moteur ajouté et testé.');
  else void perform(async()=>{const payload=engineEntryPayload(new FormData(form));if(!form.elements.namedItem('path'))delete payload.path;const value=await call('/'+encodeURIComponent(form.dataset.engineEdit),{method:'PATCH',body:revision(payload)});render(value);await changed();},'Moteur mis à jour.');
 };
 root.onclick=event=>{
  const button=event.target.closest?.('button');if(!button||button.disabled||!active())return;const attr=button.dataset;
  if(attr.engineTest)void perform(async()=>{const value=await call('/'+encodeURIComponent(attr.engineTest)+'/test',{method:'POST',body:{}});await load();if(value.ok)result(t('Moteur testé : {name}',{name:value.engine?.name||''}));});
  else if(attr.engineRemove){const target=[...root.querySelectorAll('[data-engine-confirm]')].find(item=>item.dataset.engineConfirm===attr.engineRemove);if(target)target.hidden=false;}
  else if(attr.engineCancel){const target=button.closest('[data-engine-confirm]');if(target)target.hidden=true;}
  else if(attr.engineDelete)void perform(async()=>{render(await call('/'+encodeURIComponent(attr.engineDelete)+(Number.isInteger(data?.revision)?'?expected_revision='+data.revision:''),{method:'DELETE'}));await changed();},'Moteur retiré. Ses fichiers sont conservés.');
  else if(attr.engineInstall)void perform(async()=>{const value=await call('/install',{method:'POST',body:{catalog_id:attr.engineInstall}});job=value.job||value;query('[data-engine-job]').innerHTML=engineJobHtml(job);query('[data-engine-catalog]').innerHTML=engineCatalogHtml(data?.catalog,job);schedule();});
  else if(Object.hasOwn(attr,'engineUpdates'))void perform(async()=>{const value=await call('/updates',{method:'POST',body:{}});if(active())query('[data-engine-updates-result]').innerHTML=engineUpdatesHtml(value);await load();},'Vérification terminée.');
 };
 query('[data-engine-roles]').querySelector('button').disabled=true;
 load().catch(error=>{if(active()&&error.name!=='AbortError')result(error.message,true);});
 return {refresh:load,dispose(){engineList?.dispose();disposed=true;clearTimeout(timer);controller.abort();root.onclick=null;root.onsubmit=null;root.oninput=null;}};
}
