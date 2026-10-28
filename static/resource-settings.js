import {t,ui} from './i18n.js';
import {api,esc,option,field,fail} from './api.js';

export function resourceSettingsHtml(){return ui('<section class="panel settings-width"><h2>Performance du serveur</h2><div id="resource-settings"><p class="hint">Chargement…</p></div></section>');}
export function resourcePayload(values){return {profile:values.get('profile'),total_threads:Number(values.get('total_threads')),hash_mb:Number(values.get('hash_mb')),import_workers:Number(values.get('import_workers'))};}
const positive=value=>Number.isSafeInteger(value)&&value>0;
export function resourceLimits(data={}){
 const raw=data.limits||{},cpu=positive(data.hardware?.cpu_count)?data.hardware.cpu_count:positive(data.cpu_count)?data.cpu_count:1;
 const bounds=(name,fallback)=>{const max=positive(raw[name]?.max)?raw[name].max:fallback;return {min:Math.min(max,positive(raw[name]?.min)?raw[name].min:1),max};};
 return {total_threads:bounds('total_threads',cpu),hash_mb:bounds('hash_mb',128),import_workers:bounds('import_workers',Math.max(1,cpu-2)),reserved_memory_mb:raw.reserved_memory_mb};
}
export function resourceImportMaximum(threads,limits){return Math.max(1,Math.min(limits.import_workers.max,Math.max(1,Number(threads)-2)||1));}
export function resourceHardwareHtml(data={}){
 const hardware=data.hardware||{},limits=resourceLimits(data),cores=hardware.cpu_count??data.cpu_count??1;
 const cpu=hardware.cpu_known===false?t('Processeur non détecté : le budget est limité à un cœur logique.'):t('Serveur ChessGym : {cores} cœurs logiques utilisables.',{cores});
 const memory=hardware.memory_known&&positive(hardware.memory_mb)?t('RAM détectée : {memory} Mo. Réserve système : {reserve} Mo.',{memory:hardware.memory_mb,reserve:limits.reserved_memory_mb??'—'}):t('RAM non détectée : le cache Stockfish est limité à 128 Mo par prudence.');
 return '<div class="resource-hardware"><p class="hint">'+esc(cpu)+'</p><p class="hint">'+esc(memory)+'</p><p class="hint">'+esc(t('Ces ressources sont celles du serveur ChessGym, pas de l’appareil qui affiche cette page.'))+'</p></div>';
}
export function resourceControlsHtml(data={}){
 const p=data.settings||data,limits=resourceLimits(data),attrs=key=>'min="'+limits[key].min+'" max="'+limits[key].max+'" step="1" required';
 return resourceHardwareHtml(data)+ui('<form><label>Profil<select name="profile">')+[['economy',t('Économe')],['balanced',t('Équilibré (recommandé)')],['custom',t('Personnalisé')]].map(([key,label])=>option(key,label,p.profile)).join('')+ui('</select></label><p class="hint">Les profils recommandés laissent de la capacité pour les autres applications. Choisis Personnalisé pour ajuster les valeurs.</p><div class="fields" data-resource-custom>')+
  field(t('Budget CPU (cœurs logiques)'),'total_threads',p.total_threads,'number',attrs('total_threads'))+
  field(t('Cache mémoire Stockfish total (Mo)'),'hash_mb',p.hash_mb,'number',attrs('hash_mb'))+
  field(t('Processus d’importation'),'import_workers',p.import_workers,'number','min="1" max="'+resourceImportMaximum(p.total_threads,limits)+'" step="1" required')+
  ui('</div><p class="hint" data-resource-preview></p><p class="hint" data-resource-small></p><p class="hint">Le cache mémoire est partagé entre les deux moteurs Stockfish. Ce réglage ne plafonne pas la RAM totale de ChessGym : Maia, les imports et l’interface utilisent aussi de la mémoire.</p><p class="hint">Le budget CPU est partagé entre les calculs et les imports. Les tâches attendent si le budget est déjà utilisé. Les changements s’appliquent aux prochaines tâches.</p>')+
  (data.adjusted_for_hardware?ui('<p class="hint">La configuration enregistrée a été adaptée aux ressources de ce serveur.</p>'):'')+
  ui('<p class="hint" data-resource-effective></p><button type="submit">Enregistrer la performance</button><p class="hint" data-resource-result role="status"></p></form>');
}
export function bindResourceSettings(host,{isCurrent=()=>true,request=api}={}){
 const root=host?.querySelector('#resource-settings');if(!root)return;let disposed=false,busy=false;
 const active=()=>!disposed&&isCurrent();
 const render=data=>{
  if(!active())return;const p=data.settings||data,e=data.effective||p.effective||{},limits=resourceLimits(data);
  root.innerHTML=resourceControlsHtml(data);
  const form=root.querySelector('form'),custom=root.querySelector('[data-resource-custom]'),profile=form.elements.namedItem('profile');
  const input=key=>form.elements.namedItem(key);
  const preview=()=>{
   const maximum=resourceImportMaximum(input('total_threads').value,limits);input('import_workers').max=String(maximum);
   if(Number(input('import_workers').value)>maximum)input('import_workers').value=String(maximum);
   root.querySelector('[data-resource-preview]').textContent=t('Choix : {cores} cœurs logiques, {memory} Mo de cache et {workers} processus d’importation.',{cores:input('total_threads').value,memory:input('hash_mb').value,workers:input('import_workers').value});
   root.querySelector('[data-resource-small]').textContent=Number(input('total_threads').value)<3?t('Avec ce petit budget CPU, certaines analyses et importations se déroulent l’une après l’autre.') : '';
  };
  const toggle=()=>{const recommended=data.recommendations?.[profile.value];if(recommended)for(const key of ['total_threads','hash_mb','import_workers'])input(key).value=String(recommended[key]);custom.querySelectorAll('input').forEach(element=>element.disabled=profile.value!=='custom');preview();};toggle();profile.onchange=toggle;
  custom.oninput=preview;
  root.querySelector('[data-resource-effective]').textContent=t('Configuration active : {threads} cœur(s) et {memory} Mo par moteur; {workers} processus d’importation.',{threads:e.engine_threads??'—',memory:e.engine_hash_mb??'—',workers:e.import_workers??p.import_workers})+(data.pending?' '+t('Le nouveau profil attend la fin des calculs et de l’import en cours.'):'');
  form.onsubmit=async event=>{event.preventDefault();if(busy||!active())return;if(form.reportValidity&&!form.reportValidity())return;const values=new FormData(form),payload=profile.value==='custom'?resourcePayload(values):{profile:profile.value};busy=true;form.querySelector('button').disabled=true;
   try{const saved=await request('/api/resource-settings',{method:'PATCH',body:payload});if(active()){render(saved);root.querySelector('[data-resource-result]').textContent=t('Réglages enregistrés.');}}
   catch(error){if(active()){root.querySelector('[data-resource-result]').textContent=error.message;fail(error);}}
   finally{busy=false;if(active())root.querySelector('button').disabled=false;}
  };
 };
 request('/api/resource-settings').then(render).catch(error=>{if(active())root.textContent=error.message;});
 return ()=>{disposed=true;};
}
