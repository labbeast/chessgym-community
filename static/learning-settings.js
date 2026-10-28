import {t,ui} from './i18n.js';
import {api,esc,field,modal,fail} from './api.js';
import {preferencesService as sharedPreferences} from './preferences-store.js';

export function learningSettingsHtml(preferences={},bases=[]){
 const day=preferences.study_day||{timezone:'UTC',start_hour:0},goal=preferences.review_session_defaults||{};
 return ui('<section class="panel settings-width"><h2>Journée d’étude et séances</h2><form id="learning-preferences"><div class="fields">')+field(t('Fuseau horaire'),'timezone',day.timezone,'text','required list="study-timezones"')+'<datalist id="study-timezones">'+['UTC','America/Toronto','America/Montreal','Europe/Paris','Europe/Brussels','Europe/Zurich'].map(zone=>'<option value="'+zone+'">').join('')+'</datalist>'+field(t('Début de journée (heure locale)'),'start_hour',day.start_hour,'number','min="0" max="23" step="1" required')+ui('</div><button type="button" data-study-local>Utiliser le fuseau de cet appareil</button><p class="hint">Le calendrier et les séries de jours utilisent la même journée d’étude.</p><div class="fields">')+field(t('Objectif de séance (minutes)'),'minutes',goal.minutes??'','number',ui('min="1" max="480" step="1" placeholder="Sans limite"'))+field(t('Objectif de séance (cartes)'),'cards',goal.cards??'','number',ui('min="1" max="100000" step="1" placeholder="Sans limite"'))+ui('</div><p class="hint">Ces objectifs proposent une pause sans modifier les échéances. Tu peux les adapter au lancement.</p><button type="submit">Enregistrer la planification</button><p class="hint" data-learning-result role="status"></p></form><details><summary>Appliquer les valeurs initiales à des bases existantes</summary><p class="hint">Choisis les bases à mettre à jour avec les valeurs globales Manqué, Difficile, Bien et Facile. Les échéances et l’historique restent conservés.</p><div class="settings-base-selection">')+bases.filter(base=>!base.reference&&!base.reference_status).map(base=>'<label class="checkbox"><input type="checkbox" data-default-base="'+Number(base.id)+'"> '+esc(base.name)+'</label>').join('')+ui('</div><button type="button" data-defaults-preview>Voir les changements…</button></details></section>');
}
export function learningPayload(values){const number=name=>String(values.get(name)??'').trim()===''?null:Number(values.get(name));return {study_day:{timezone:String(values.get('timezone')||'').trim(),start_hour:Number(values.get('start_hour'))},review_session_defaults:{minutes:number('minutes'),cards:number('cards')}};}
export function bindLearningSettings(host,{preferencesService=sharedPreferences,onSaved=()=>{},isCurrent=()=>true,request=api}={}){
 const form=host?.querySelector('#learning-preferences');if(!form)return;let saving=false;
 form.querySelector('[data-study-local]').onclick=()=>{try{form.elements.namedItem('timezone').value=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{}};
 form.onsubmit=async event=>{event.preventDefault();if(saving||!isCurrent())return;saving=true;const result=form.querySelector('[data-learning-result]'),button=form.querySelector('[type="submit"]');button.disabled=true;
  try{const saved=await preferencesService.patch(learningPayload(new FormData(form)),{isCurrent});if(isCurrent()){onSaved(saved);result.textContent=t('Réglages enregistrés.');}}
  catch(error){if(isCurrent())result.textContent=error.message;}finally{saving=false;button.disabled=false;}
 };
 const preview=host.querySelector('[data-defaults-preview]');if(!preview)return;
 preview.onclick=async()=>{
  if(saving||!isCurrent())return;const base_ids=[...host.querySelectorAll('[data-default-base]:checked')].map(input=>Number(input.dataset.defaultBase));if(!base_ids.length){form.querySelector('[data-learning-result]').textContent=t('Choisis au moins une base.');return;}
  saving=true;preview.disabled=true;
  try{const result=await request('/api/preferences/review-defaults/apply',{method:'POST',body:{base_ids,preview:true}});if(!isCurrent())return;
   const labels={again:t('Manqué · minutes'),hard:t('Difficile · jours'),medium:t('Bien · jours'),easy:t('Facile · jours')},display=value=>value==null?t('Illimité'):String(value);
   modal(t('Appliquer les valeurs initiales'),'<div>'+result.bases.map(base=>'<p><strong>'+esc(base.name)+'</strong></p><ul>'+Object.entries(base.changes||{}).map(([key,change])=>'<li>'+esc(labels[key]||key)+' : '+esc(display(change.before))+' → '+esc(display(change.after))+'</li>').join('')+'</ul>').join('')+'</div>',{submit:t('Appliquer aux bases sélectionnées'),onSubmit:async()=>{if(!isCurrent())return;const saved=await request('/api/preferences/review-defaults/apply',{method:'POST',body:{base_ids,preview:false,expected_revision:result.revision}});if(isCurrent()){form.querySelector('[data-learning-result]').textContent=t('Valeurs appliquées. Les échéances existantes sont conservées.');onSaved(preferencesService.get(),saved);}}});
  }catch(error){if(isCurrent())fail(error);}finally{saving=false;preview.disabled=false;}
 };
}
