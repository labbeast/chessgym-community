import {t,ui} from './i18n.js';
import {api,esc} from './api.js';

const endpoint='/api/setup-resources';
const running=job=>job?.state==='running';
const defaultIds=new Set(['stockfish-latest']);
const exampleActivities=[
 {key:'repertoire',page:'repertoire',name:'Répertoire',description:'Apprendre une ouverture avec quelques lignes commentées.'},
 {key:'guess',page:'guess',name:'Guess the Move',description:'Retrouver les coups d’une courte partie pédagogique.'},
 {key:'reading',page:'reading',name:'Lecture',description:'Lire une partie commentée et retrouver ta progression.'},
];
const sources=new Set(['github.com','huggingface.co','database.lichess.org','lichess.org','lumbrasgigabase.com']);
const browserDownload=item=>item?.installation_mode==='browser-download';
function officialUrl(value,hosts=sources){
 try{const url=new URL(value);return url.protocol==='https:'&&hosts.has(url.hostname)&&!url.username&&!url.password&&(!url.port||url.port==='443')?url.href:'';}catch{return '';}
}
const resourceName=(id,resources=[])=>t(resources.find(item=>item.id===id)?.name||id);
function stageLabel(stage,resources){
 const resource=String(stage).match(/^Préparation de (.+)$/);if(resource&&resources.some(item=>item.id===resource[1]))return t('Préparation de {name}',{name:resourceName(resource[1],resources)});
 const puzzles=String(stage).match(/^Préparation de la banque : (.+) puzzles$/);if(puzzles)return t('Préparation de la banque : {count} puzzles',{count:puzzles[1]});
 const games=String(stage).match(/^Indexation : (.+) parties$/);return games?t('Indexation : {count} parties',{count:games[1]}):t(stage);
}
function resultLabel(result){return t(result.state==='failed'?'Échec':result.state==='skipped'?'Déjà à jour':result.activation_pending?'Installé · activation après le calcul en cours':result.engine_id&&result.activated===false?'Installé · sélection actuelle conservée':'Prêt');}
export function setupResourceSelection(resources=[]){
 return resources.filter(item=>!browserDownload(item)&&defaultIds.has(item.id)&&item.available&&!item.installed).map(item=>item.id);
}
export function setupResourcePayload(values){return {resources:[...new Set(values.getAll('resource').map(String))]};}
export function setupReferenceImportPayload(resourceId,sourcePath,useAsMasters=false){return {resource_id:String(resourceId),source_path:String(sourcePath||'').trim(),use_as_masters:!!useAsMasters};}
export function setupResourcesSettingsHtml(){return ui('<section class="panel setup-resources-panel"><h2>Moteurs et bases</h2><p class="muted">Commence avec les exemples, puis ajoute les ressources qui te sont utiles.</p><div id="setup-resources-settings"><p class="hint">Chargement…</p></div></section>');}
export function setupExamplesHtml(data=null,error=''){
 const example=key=>data?.examples?.find(item=>item.key===key&&Number.isSafeInteger(item.base_id)&&item.base_id>0);
 const ready=key=>!!example(key);
 const complete=exampleActivities.every(item=>ready(item.key));
 return ui('<section class="setup-examples"><h3>Essayer ChessGym en quelques minutes</h3><p class="hint">Trois petites bases incluses, utilisables sans téléchargement. Leurs lignes et commentaires pédagogiques sont proposés sous CC0.</p>')+
  '<div class="setup-examples-grid">'+exampleActivities.map(item=>'<article><h4>'+esc(t(item.name))+'</h4><p>'+esc(t(item.description))+'</p>'+(ready(item.key)?'<button type="button" data-setup-example="'+(example(item.key).mode_enabled===false?'library':item.page)+'">'+esc(example(item.key).mode_enabled===false?t('Bibliothèque'):t('Ouvrir {activity}',{activity:t(item.name)}))+'</button>':'')+'</article>').join('')+'</div>'+
  (error?'<p class="error-text" role="alert">'+esc(error)+'</p>'+ui('<button type="button" data-setup-examples-retry>Réessayer</button>'):data?(complete?ui('<p class="hint">Tes bases d’exemples sont prêtes. Tes modifications et ta progression sont conservées.</p>'):ui('<button type="button" class="primary" data-setup-examples-add>Ajouter les bases d’exemples</button>')):ui('<p class="hint">Chargement…</p>'))+
  ui('<p class="hint">Stockfish est nécessaire pour noter les coups dans Guess the Move. Le répertoire et la lecture sont disponibles sans moteur.</p></section>');
}
export function setupResourceCardsHtml(resources=[],selected=[],locked=false,drafts=new Map(),compact=false){
 return resources.map(item=>{
  const sourceUrl=officialUrl(item.source_url),source=sourceUrl?'<a href="'+esc(sourceUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(t('Source officielle'))+'</a>':'';
  const size=Number(item.download_bytes),external=browserDownload(item),isDatabase=item.category==='database'||item.id.startsWith('lichess-')||item.id.startsWith('lumbra-');
  const hint=item.id==='lichess-puzzles'&&!item.description?'La banque complète de problèmes peut occuper plusieurs Go après import.':item.id==='lichess-games'&&!item.description?'Parties de tournois du dernier mois publié, ajoutées à une base de référence.':item.id.startsWith('maia3-')&&!compact?'Choisis un modèle Maia. Le modèle 5M est plus léger, le modèle 79M plus complet.':null;
  const title='<span><strong>'+esc(t(item.name))+'</strong><span class="setup-resource-state">'+esc(t(item.installed?'Déjà installé':isDatabase?'Base facultative':item.id==='stockfish-latest'?'Recommandé pour commencer':item.id.startsWith('maia3-')?'Facultatif · adversaire au style humain':'Moteur'))+'</span></span>';
  const choice=external?'<div class="setup-resource-choice">'+title+'</div>':'<label class="setup-resource-choice"><input type="checkbox" name="resource" value="'+esc(item.id)+'"'+(selected.includes(item.id)?' checked':'')+(!item.available||locked?' disabled':'')+'>'+title+'</label>';
  const licenseUrl=officialUrl(item.license_url,new Set(['creativecommons.org']));
  const license=item.license?'<p class="hint">'+esc(t('Licence : {license}',{license:item.license}))+(licenseUrl?' · <a href="'+esc(licenseUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(t('Conditions de licence'))+'</a>':'')+'</p>':'';
  const description=item.description?'<p class="hint">'+esc(t(item.description))+'</p>':'',engineDetails=compact&&!isDatabase?description:'';
  let controls='';
  if(external){
   const downloadUrl=officialUrl(item.download_page||item.download_url||item.source_url,new Set(['lumbrasgigabase.com'])),draft=drafts.get(item.id)||{},disabled=locked||!item.available?' disabled':'';
   controls='<p class="hint">'+esc(t('Par Michael Jansen. Usage non commercial avec attribution; une licence distincte est nécessaire pour un usage commercial.'))+'</p><p class="hint">'+esc(t('Télécharge cette édition sur le site Lumbra, accepte sa licence, puis indique le fichier .7z ou .pgn présent sur le PC ou serveur de ChessGym.'))+'</p>'+(downloadUrl?'<p><a href="'+esc(downloadUrl)+'" target="_blank" rel="noopener noreferrer">'+esc(t('Télécharger sur Lumbra'))+'</a></p>':'')+'<label>'+esc(t('Chemin du fichier téléchargé sur le serveur'))+'<input type="text" data-lumbra-path="'+esc(item.id)+'" value="'+esc(draft.source_path||'')+'" placeholder="'+esc(t('Ex. C:\\Téléchargements\\Lumbra.7z'))+'"'+disabled+'></label>'+(item.id==='lumbra-otb-elite'?'<label class="checkbox"><input type="checkbox" data-lumbra-masters="'+esc(item.id)+'"'+(draft.use_as_masters?' checked':'')+disabled+'> '+esc(t('Utiliser comme référence de maîtres'))+'</label>':'')+'<button type="button" data-setup-import="'+esc(item.id)+'"'+disabled+'>'+esc(t('Importer la base téléchargée'))+'</button><p class="hint">'+esc(t('Les nouvelles éditions Lumbra se téléchargent sur leur site; les mises à jour automatiques ne les remplacent pas.'))+'</p>';
   if(item.seven_zip_available===false)controls+='<p class="hint">'+esc(t('7-Zip n’est pas détecté sur le serveur. Installe-le pour importer une archive .7z, ou fournis un PGN déjà extrait.'))+' <a href="https://www.7-zip.org/" target="_blank" rel="noopener noreferrer">7-Zip</a></p>';
  }
  return '<article class="setup-resource-card'+(!item.available?' unavailable':'')+(item.installed?' installed':'')+'">'+choice+(engineDetails?'':description)+(hint?'<p class="hint">'+esc(t(hint))+'</p>':'')+'<div class="setup-resource-meta">'+(size>0?'<span>'+esc(t(item.id.startsWith('maia3-')?'{size} Mo pour le modèle; composants supplémentaires au besoin':external?'Taille de l’archive : environ {size} Mo':'{size} Mo à télécharger',{size:Math.max(1,Math.round(size/1048576))}))+'</span>':'')+'</div>'+(external?source+license+controls:(source||license||engineDetails?'<details class="setup-resource-details" data-setup-disclosure="resource-'+esc(item.id)+'"><summary>'+esc(t('Détails de la ressource'))+'</summary>'+engineDetails+source+license+'</details>':''))+(!item.available?'<p class="hint">'+esc(t(item.unavailable_reason||'Indisponible sur cette machine.'))+'</p>':'')+'</article>';
 }).join('');
}
export function setupResourceGroupsHtml(resources=[],selected=[],locked=false,drafts=new Map()){
 const manual=resources.filter(browserDownload),automatic=resources.filter(item=>!browserDownload(item));
 const database=item=>item.category==='database'||item.id.startsWith('lichess-');
 const engines=automatic.filter(item=>!database(item)),databases=automatic.filter(database);
 const cards=items=>'<div class="setup-resource-grid">'+setupResourceCardsHtml(items,selected,locked,drafts,true)+'</div>';
 const group=(id,title,items)=>items.length?'<details class="setup-resource-group" data-setup-disclosure="'+id+'"><summary><span>'+esc(t(title))+'</span><span class="setup-resource-count">'+items.length+'</span></summary>'+cards(items)+'</details>':'';
 return (engines.length?'<section class="setup-resource-engines"><h3>'+esc(t('Moteurs de jeu et d’analyse'))+'</h3>'+ui('<p class="hint">Stockfish active l’analyse et Guess the Move. Maia est facultatif pour jouer contre un adversaire au style humain. Aucun téléchargement ne commence avant ton choix.</p>')+(engines.some(item=>item.id.startsWith('maia3-'))?ui('<p class="hint">Choisis un modèle Maia. Le modèle 5M est plus léger, le modèle 79M plus complet.</p>'):'')+cards(engines)+'</section>':'')+
  group('databases','Bases en téléchargement direct',databases)+
  ui('<form data-setup-install class="setup-install-actions"><div><strong>Téléchargements sélectionnés</strong><span class="hint" data-setup-selection-count></span></div><button type="submit" class="primary" data-setup-install-button disabled>Télécharger et configurer</button></form>')+
  (manual.length?'<details class="setup-resource-group setup-resource-manual" data-setup-disclosure="manual"><summary><span>'+esc(t('Bases Lumbra · import manuel'))+'</span><span class="setup-resource-count">'+manual.length+'</span></summary><p class="hint">'+esc(t('Ouvre une édition pour télécharger son fichier et l’importer dans ChessGym.'))+'</p>'+manual.map(item=>'<details class="setup-manual-edition" data-setup-disclosure="edition-'+esc(item.id)+'"><summary>'+esc(t(item.name))+'<span class="setup-resource-state">'+esc(t(item.installed?'Déjà installé':'Base facultative'))+'</span></summary>'+setupResourceCardsHtml([item],[],locked,drafts)+'</details>').join('')+'</details>':'');
}
export function setupResourceJobHtml(job,resources=[]){
 if(!job)return '';
 const state=job.state,percent=Math.max(0,Math.min(100,Number(job.progress)||0));
 const title=t(state==='completed'?'Préparation terminée':state==='failed'?'Préparation à vérifier':'Préparation en cours…');
 return '<div class="setup-resource-job '+esc(state)+'" role="status" aria-live="polite"><strong>'+esc(title)+'</strong>'+(running(job)?'<progress max="100" value="'+percent+'" aria-label="'+esc(title)+'"></progress>':'')+(job.stage?'<span>'+esc(stageLabel(job.stage,resources))+'</span>':'')+(job.error?'<p class="error-text">'+esc(t(job.error))+'</p>':'')+((job.results||[]).length?'<ul>'+job.results.map(result=>'<li><strong>'+esc(resourceName(result.id,resources))+'</strong> · '+esc(resultLabel(result))+(result.error?' — '+esc(t(result.error)):'')+'</li>').join('')+'</ul>':'')+'</div>';
}
export function bindSetupResources(host,{isCurrent=()=>true,request=api,onChanged=null,onComplete=null,pollMs=1500}={}){
 const root=host?.querySelector('#setup-resources-settings');if(!root)return {dispose(){}};
 let disposed=false,busy=false,data=null,job=null,timer=null,selection=null,settingsDirty=false,examples=null,examplesError='',examplesGeneration=0,examplesInstalling=false;
 const importDrafts=new Map();
 const controller=new AbortController(),active=()=>!disposed&&isCurrent(),query=selector=>root.querySelector(selector);
 const call=(path='',options={})=>request(endpoint+path,{...options,signal:controller.signal});
 const demo=(options={})=>request('/api/demo',{...options,signal:controller.signal});
 root.innerHTML='<div data-setup-job></div><div data-setup-resources>'+setupResourceGroupsHtml()+'</div>'+ui('<p class="setup-resource-result" data-setup-result role="status" aria-live="polite"></p><section class="setup-resource-maintenance"><h3>Entretien des ressources</h3><p class="hint">Ces mises à jour concernent les moteurs et les bases installées.</p><button type="button" data-setup-update disabled>Mettre à jour les éléments installés</button><details class="setup-resource-automation"><summary>Mises à jour automatiques</summary><form data-setup-settings><label class="checkbox"><input type="checkbox" name="automatic_updates"> Mettre à jour automatiquement chaque semaine</label><p class="hint">Quand ChessGym est ouvert, les versions compatibles des moteurs et les bases installées compatibles sont vérifiées puis actualisées. Les éditions Lumbra se téléchargent séparément sur leur site. Les téléchargements peuvent être volumineux.</p><button type="submit" disabled>Enregistrer les mises à jour</button></form></details></section><div data-setup-onboarding><div class="actions setup-resource-continue"><button type="button" data-setup-complete disabled>Continuer vers ma bibliothèque</button></div><p class="hint">Tu peux passer cette étape et y revenir dans Réglages → Installation.</p></div>');
 root.innerHTML='<div data-setup-examples>'+setupExamplesHtml()+'</div>'+root.innerHTML;
 const message=(text,error=false)=>{if(!active())return;const target=query('[data-setup-result]');target.textContent=text;target.classList.toggle('error-text',error);};
 const automaticResource=id=>data?.resources?.find(item=>item.id===id&&item.available&&!browserDownload(item));
 const selected=()=>[...(root.querySelectorAll('input[name="resource"]:checked')||[])].map(input=>input.value).filter(automaticResource);
 function lock(){
  if(!active())return;
  const pending=busy||running(job)||!data;
  root.querySelectorAll('input[name="resource"]').forEach(input=>input.disabled=pending||!automaticResource(input.value));
  root.querySelectorAll('[data-lumbra-path],[data-lumbra-masters],[data-setup-import]').forEach(input=>{const id=input.dataset?.lumbraPath||input.dataset?.lumbraMasters||input.dataset?.setupImport;if(id)input.disabled=pending||!data?.resources?.find(item=>item.id===id)?.available;});
  query('[data-setup-install-button]').disabled=pending||!selection?.length;
  query('[data-setup-selection-count]').textContent=t('{count} sélectionné(s)',{count:selection?.length||0});
  query('[data-setup-update]').disabled=pending||!data?.resources?.some(item=>item.installed&&!browserDownload(item));
  query('[data-setup-settings] button').disabled=busy||!data;
  query('[data-setup-settings] input').disabled=busy||!data;
  query('[data-setup-complete]').disabled=busy||!data;
  root.querySelectorAll('[data-setup-examples-add],[data-setup-examples-retry],[data-setup-example]').forEach(button=>button.disabled=busy);
 }
 function renderExamples(){if(!active())return;query('[data-setup-examples]').innerHTML=setupExamplesHtml(examples,examplesError);lock();}
 async function loadExamples(){
  if(examplesInstalling)return;
  const generation=++examplesGeneration;
  try{const value=await demo();if(!active()||generation!==examplesGeneration)return;examples=value;examplesError='';}
  catch(error){if(!active()||generation!==examplesGeneration||error.name==='AbortError')return;examplesError=error.message;}
  renderExamples();
 }
 function render(value){
  if(!active())return;
  const firstLoad=!data;
  data=value;job=value.job||null;
  if(selection===null)selection=setupResourceSelection(value.resources);
  selection=selection.filter(automaticResource);
  // Polling must preserve the sections a person opened and any import drafts.
  const disclosures=new Map([...root.querySelectorAll('[data-setup-disclosure]')].map(item=>[item.dataset.setupDisclosure,item.open]));
  query('[data-setup-resources]').innerHTML=setupResourceGroupsHtml(value.resources,selection,busy||running(job),importDrafts);
  root.querySelectorAll('[data-setup-disclosure]').forEach(item=>{if(disclosures.has(item.dataset.setupDisclosure))item.open=disclosures.get(item.dataset.setupDisclosure);});
  query('[data-setup-onboarding]').hidden=value.setup_complete===true;
  if(firstLoad&&value.settings?.automatic_updates)query('.setup-resource-automation').open=true;
  if(!settingsDirty)query('[data-setup-settings] input').checked=!!value.settings?.automatic_updates;
  query('[data-setup-job]').innerHTML=setupResourceJobHtml(job,value.resources);
  lock();schedule();
 }
 async function load(){const value=await call();if(active())render(value);return value;}
 function schedule(){clearTimeout(timer);timer=null;if(active()&&running(job))timer=setTimeout(poll,pollMs);}
 async function poll(){
  if(!active())return;
  try{const wasRunning=running(job);await load();if(active()&&wasRunning&&!running(job)){selection=[];render(data);await onChanged?.();}}
  catch(error){if(active()&&error.name!=='AbortError'){message(error.message,true);schedule();}}
 }
 async function acceptJob(value){
  if(!active())return;job=value.job||value;query('[data-setup-job]').innerHTML=setupResourceJobHtml(job,data.resources);
  if(running(job))schedule();else{await load();if(active())await onChanged?.();}
 }
 async function perform(action){
  if(busy||!active())return;busy=true;lock();message('');
  try{await action();}catch(error){if(active()&&error.name!=='AbortError'){try{await load();}catch{}message(error.message,true);}}finally{busy=false;lock();}
 }
 function saveImportDraft(target){
  const id=target.dataset?.lumbraPath||target.dataset?.lumbraMasters;if(!id)return;
  const draft={...(importDrafts.get(id)||{})};
  if(target.dataset.lumbraPath)draft.source_path=target.value;else draft.use_as_masters=!!target.checked;
  importDrafts.set(id,draft);
 }
 root.oninput=event=>saveImportDraft(event.target);
 root.onchange=event=>{
  saveImportDraft(event.target);
  if(event.target.name==='resource'){
   if(event.target.checked&&event.target.value.startsWith('maia3-'))root.querySelectorAll('input[name="resource"]').forEach(input=>{if(input!==event.target&&input.value.startsWith('maia3-'))input.checked=false;});
   selection=selected();lock();
  }else if(event.target.name==='automatic_updates')settingsDirty=true;
 };
 root.onsubmit=event=>{
  const form=event.target;if(!form.matches?.('[data-setup-install],[data-setup-settings]'))return;event.preventDefault();
  if(form.matches('[data-setup-install]')){if(running(job)||!selection?.length)return;void perform(async()=>{const value=await call('/install',{method:'POST',body:{resources:selection}});await acceptJob(value);});}
  else void perform(async()=>{const automatic_updates=!!query('[data-setup-settings] input').checked;await call('/settings',{method:'PATCH',body:{automatic_updates,interval_hours:168}});if(!active())return;settingsDirty=false;await load();message(t('Mises à jour enregistrées.'));});
 };
 root.onclick=event=>{
  const button=event.target.closest?.('button');if(!button||button.disabled||!active())return;
  if(Object.hasOwn(button.dataset,'setupImport')){
   if(running(job))return;const resource=data?.resources?.find(item=>item.id===button.dataset.setupImport&&item.available&&browserDownload(item));if(!resource)return;
   const path=query('[data-lumbra-path="'+resource.id+'"]'),masters=resource.id==='lumbra-otb-elite'?query('[data-lumbra-masters="'+resource.id+'"]'):null;
   const payload=setupReferenceImportPayload(resource.id,path?.value,masters?.checked);if(!payload.source_path){message(t('Indique le chemin du fichier Lumbra téléchargé.'),true);path?.focus?.();return;}
   importDrafts.set(resource.id,{source_path:payload.source_path,use_as_masters:payload.use_as_masters});
   void perform(async()=>{const value=await call('/import',{method:'POST',body:payload});await acceptJob(value);});
  }
  else if(Object.hasOwn(button.dataset,'setupUpdate'))void perform(async()=>{const value=await call('/update',{method:'POST',body:{}});await acceptJob(value);});
  else if(Object.hasOwn(button.dataset,'setupExamplesRetry'))void perform(loadExamples);
  else if(Object.hasOwn(button.dataset,'setupExamplesAdd'))void perform(async()=>{
   ++examplesGeneration;examplesInstalling=true;
   try{const value=await demo({method:'POST',body:{}});if(!active())return;examples=value;examplesError='';renderExamples();await onChanged?.();message(t('Exemples ajoutés. Choisis une activité pour commencer.'));}
   finally{examplesInstalling=false;}
  });
  else if(Object.hasOwn(button.dataset,'setupExample')&&(button.dataset.setupExample==='library'||exampleActivities.some(item=>item.page===button.dataset.setupExample)))void perform(async()=>{
   await call('/complete',{method:'POST',body:{}});if(active())await onComplete?.(button.dataset.setupExample);
  });
  else if(Object.hasOwn(button.dataset,'setupComplete'))void perform(async()=>{await call('/complete',{method:'POST',body:{}});if(active())await onComplete?.();});
 };
 load().catch(error=>{if(active()&&error.name!=='AbortError')message(error.message,true);});
 void loadExamples();
 return {refresh:async()=>{const value=await load();await loadExamples();return value;},dispose(){disposed=true;clearTimeout(timer);controller.abort();root.onclick=null;root.onsubmit=null;root.onchange=null;root.oninput=null;}};
}
