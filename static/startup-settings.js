import {t,ui} from './i18n.js';
import {option} from './api.js';

const KEY='chessgym.startup.v1';
export function startupPreferences(storage){
 let value={};try{storage??=globalThis.localStorage;value=JSON.parse(storage?.getItem(KEY)||'{}')||{};}catch{}
 return {page:['library','board','reviews','training-plan'].includes(value.page)?value.page:'library',resume:value.resume==='auto'?'auto':'never'};
}
export function saveStartupPreferences(value,storage=globalThis.localStorage){
 const clean={page:['library','board','reviews','training-plan'].includes(value.page)?value.page:'library',resume:value.resume==='auto'?'auto':'never'};
 if(!storage)throw new Error('Storage unavailable');storage.setItem(KEY,JSON.stringify(clean));return clean;
}
export function startupSettingsHtml(){
 const p=startupPreferences();
 return ui('<section class="panel settings-width"><h2>Au démarrage · cet appareil</h2><form id="startup-preferences"><label>Écran initial<select name="page">')+[['library',t('Bibliothèque')],['board',t('Échiquier d’analyse')],['reviews',t('Révisions')],['training-plan',t('Mon entraînement')]].map(([key,label])=>option(key,label,p.page)).join('')+ui('</select></label><label>Travail en cours<select name="resume">')+[['auto',t('Reprendre automatiquement')],['never',t('Ouvrir l’écran initial')]].map(([key,label])=>option(key,label,p.resume)).join('')+ui('</select></label><p class="hint">Ce choix reste propre à cet appareil. Les brouillons et séances restent disponibles même sans reprise au démarrage.</p><button type="submit">Enregistrer cet appareil</button><p class="hint" data-startup-result role="status"></p></form></section>');
}
export function bindStartupSettings(host){
 const form=host?.querySelector('#startup-preferences');if(!form)return;
 form.onsubmit=event=>{event.preventDefault();const data=new FormData(form),result=form.querySelector('[data-startup-result]');try{saveStartupPreferences(Object.fromEntries(data));result.textContent=t('Préférences de cet appareil enregistrées.');}catch{result.textContent=t('Le stockage de cet appareil est indisponible.');}};
}
