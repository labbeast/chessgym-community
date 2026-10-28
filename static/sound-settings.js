import {t} from './i18n.js';
import {esc,fail} from './api.js';
import {soundSettings,configureSound,playSound} from './sound.js';

export function soundSettingsHtml(preferences={}){
 const p=soundSettings(preferences.sound),check=(key,label)=>'<label class="sound-toggle"><input type="checkbox" name="'+key+'" '+(p[key]?'checked':'')+'> '+esc(t(label))+'</label>';
 return '<section class="panel settings-width"><h2>'+t('Sons')+'</h2><form id="sound-preferences">'+check('enabled','Activer les sons')+'<label>'+t('Volume')+' <output data-sound-volume>'+Math.round(p.volume*100)+' %</output><input type="range" name="volume" min="0" max="100" step="1" value="'+Math.round(p.volume*100)+'"></label>'+check('moves','Déplacements, captures et roques')+check('feedback','Réussites, erreurs et exercices terminés')+check('navigation','Sons pendant la navigation dans les coups')+'<p class="hint">'+t('Les aperçus au survol restent silencieux. Ces réglages sont conservés dans ChessGym.')+'</p><div class="sound-examples">'+[['move','Déplacement'],['capture','Capture'],['castle','Roque'],['correct','Bonne réponse'],['incorrect','Erreur'],['complete','Exercice terminé']].map(([key,label])=>'<button type="button" data-sound-preview="'+key+'">▷ '+esc(t(label))+'</button>').join('')+'</div><button type="submit" class="primary">'+t('Enregistrer')+'</button><p data-sound-result role="status" class="hint"></p></form></section>';
}
export function bindSoundSettings(host,{preferencesService,isCurrent=()=>true,onSaved=()=>{}}={}){
 const form=host.querySelector('#sound-preferences');if(!form)return;
 const values=()=>Object.fromEntries(['enabled','moves','feedback','navigation'].map(key=>[key,form.elements[key].checked]).concat([['volume',Number(form.elements.volume.value)/100]]));
 form.elements.volume.oninput=()=>{form.querySelector('[data-sound-volume]').textContent=form.elements.volume.value+' %';};
 form.querySelectorAll('[data-sound-preview]').forEach(button=>button.onclick=()=>{configureSound(values());playSound(button.dataset.soundPreview,{preview:true});configureSound(preferencesService.get());});
 form.onsubmit=async event=>{event.preventDefault();const submit=form.querySelector('[type=submit]');submit.disabled=true;try{const prefs=await preferencesService.patch({sound:values()},{isCurrent});if(!prefs)return;configureSound(prefs);onSaved(prefs);form.querySelector('[data-sound-result]').textContent=t('Réglages sonores enregistrés.');}catch(error){if(isCurrent())fail(error);}finally{if(isCurrent())submit.disabled=false;}};
}
