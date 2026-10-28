import {t,ui} from './i18n.js';
import {api,field,fail} from './api.js';

export function reviewDefaults(preferences={}){
 const p=preferences.review_defaults||{};
 return {again:p.again??10,hard:p.hard??2,medium:p.medium??5,easy:p.easy??10};
}
export function reviewMultipliers(preferences={}){const p=preferences.review_multipliers||{};return {hard:p.hard??1.2,medium:p.medium??2,easy:p.easy??3};}
export function reviewPreferencesHtml(preferences={},supported=false,maintenanceSupported=false){
 if(!supported)return '';
 const d=reviewDefaults(preferences),m=reviewMultipliers(preferences),maintenance=preferences.review_maintenance||{};
 const maintenanceHtml=maintenanceSupported?ui('<h3>Entretien des acquis</h3><label class="check"><input type="checkbox" name="maintenance_enabled" ')+(maintenance.enabled!==false?'checked':'')+ui('> Entretenir les cartes maîtrisées</label><div class="fields">')+field(t('Rappel d’entretien · jours'),'maintenance_interval_days',maintenance.interval_days??30,'number','required min="1" max="3650" step="1"')+field(t('Maximum de rappels par jour'),'maintenance_daily_limit',maintenance.daily_limit??5,'number','required min="1" max="100" step="1"')+ui('</div><p class="hint">Les acquis restent conservés. Les premiers rappels des anciennes cartes sont répartis dans le temps, sous ce plafond quotidien. Une erreur remet la carte en apprentissage.</p>'):'';
 return ui('<section class="panel settings-width"><h2>Révisions</h2><form id="review-preferences">')+field(t('Maîtrise automatique · après un intervalle de plus de (jours)'),'auto_mastery_days',preferences.auto_mastery_days??180,'number','required min="1" max="3650" step="1"')+'<p class="hint">'+(maintenanceSupported?t('Les cartes au-delà de ce seuil deviennent maîtrisées. Leur historique est conservé et les rappels suivent les réglages d’entretien ci-dessous.'):t('S’applique à toutes les bases, y compris aux cartes déjà au-delà de ce seuil : elles deviennent immédiatement maîtrisées et ne reviennent plus en révision. Les cartes déjà maîtrisées restent inchangées.'))+'</p>'+maintenanceHtml+ui('<h3>Progression des intervalles</h3><p class="hint">Pour une carte déjà vue, le délai précédent est multiplié selon ta réponse, puis limité par les minimums et le maximum de sa base. Manqué repart du délai court réglé dans la base.</p><div class="fields">')+field(t('Difficile · multiplicateur'),'multiplier_hard',m.hard,'number','required min="0.1" max="10" step="0.1"')+field(t('Bien · multiplicateur'),'multiplier_medium',m.medium,'number','required min="0.1" max="10" step="0.1"')+field(t('Facile · multiplicateur'),'multiplier_easy',m.easy,'number','required min="0.1" max="10" step="0.1"')+ui('</div><details><summary>Valeurs initiales des nouvelles bases</summary><p class="hint">Chaque base conserve ensuite ses propres réglages. Modifier ces valeurs ne change pas les bases existantes.</p><div class="fields">')+field(t('Manqué · minutes'),'again',d.again,'number','required min="1" max="1440"')+field(t('Difficile · minimum en jours'),'hard',d.hard,'number','required min="0.01" max="3650" step="0.01"')+field(t('Bien · minimum en jours'),'medium',d.medium,'number','required min="0.01" max="3650" step="0.01"')+field(t('Facile · minimum en jours'),'easy',d.easy,'number','required min="0.01" max="3650" step="0.01"')+ui('</div></details><div class="actions"><button type="submit" class="primary">Enregistrer les révisions</button></div><p class="hint" data-review-preferences-result role="status"></p></form></section>');
}
export function reviewPreferencesPayload(values){
 const defaults={};
 for(const key of ['again','hard','medium','easy'])defaults[key]=Number(values.get(key));
 return {...(values.get('maintenance_interval_days')!=null?{review_maintenance:{enabled:values.get('maintenance_enabled')==='on',interval_days:Number(values.get('maintenance_interval_days')),daily_limit:Number(values.get('maintenance_daily_limit'))}}:{}),auto_mastery_days:Number(values.get('auto_mastery_days')),review_defaults:defaults,review_multipliers:Object.fromEntries(['hard','medium','easy'].map(key=>[key,Number(values.get('multiplier_'+key))]))};
}
let saveTail=Promise.resolve();
export function bindReviewPreferences(host,{supported=false,onSaved=()=>{},isCurrent=()=>true,canSave=()=>true,request=api}={}){
 const form=supported?host?.querySelector('#review-preferences'):null;if(!form)return;
 let saving=false;
 form.onsubmit=async event=>{
  event.preventDefault();if(saving||!isCurrent())return;
  const payload=reviewPreferencesPayload(new FormData(form));
  const controls=[...form.querySelectorAll('input,button')].map(input=>[input,input.disabled]);
  saving=true;controls.forEach(([input])=>input.disabled=true);form.setAttribute('aria-busy','true');
  const result=form.querySelector('[data-review-preferences-result]');if(result)result.textContent=t('Enregistrement…');
  const task=saveTail.catch(()=>{}).then(()=>canSave()?request('/api/preferences',{method:'PATCH',body:payload}):null);saveTail=task;
  try{const saved=await task;if(saved==null||!canSave())return;onSaved(saved);if(isCurrent()&&result)result.textContent=t('Réglages enregistrés.');}
  catch(error){if(isCurrent()){if(result)result.textContent=t('Échec de l’enregistrement. Tes valeurs restent dans le formulaire.');fail(error);}}
  finally{saving=false;form.removeAttribute('aria-busy');controls.forEach(([input,disabled])=>input.disabled=disabled);}
 };
}
