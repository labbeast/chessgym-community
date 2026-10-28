import {t,ui} from './i18n.js';
import {api,option} from './api.js';

export const FONT_SCALES=Object.freeze([100,110,125,150]);

export function fontScale(preferences={}){
 return FONT_SCALES.includes(preferences?.font_scale)?preferences.font_scale:100;
}

export function applyTextSize(preferences={}){
 const value=fontScale(preferences);
 globalThis.document?.documentElement?.style.setProperty('--ui-font-scale',String(value/100));
 return value;
}

export function textSizeSettingsHtml(preferences={}){
 const value=fontScale(preferences);
 return ui('<section class="panel settings-width text-size-settings" data-text-size-settings><h2>Taille du texte</h2><label for="interface-font-scale">Taille du texte dans toute l’interface</label>')+
  '<select id="interface-font-scale" aria-describedby="interface-font-scale-hint">'+FONT_SCALES.map(scale=>option(scale,scale===100?t('100 % · Normale'):scale+' %',value)).join('')+'</select>'+
  ui('<p class="hint" id="interface-font-scale-hint">Agrandit les menus, boutons, listes et annotations. Ce choix est enregistré dans ChessGym.</p><div class="text-size-preview"><strong>Aperçu du texte</strong><p>Étudie tes parties et retrouve tes annotations confortablement.</p><small>Les petits textes sont agrandis eux aussi.</small></div><p class="appearance-status" data-text-size-status role="status" aria-live="polite"></p></section>');
}

export function bindTextSizeSettings(host,{preferencesService,isCurrent=()=>true,canSave=isCurrent,onSaved}={}){
 const select=host.querySelector('#interface-font-scale');
 if(!select)return;
 const status=host.querySelector('[data-text-size-status]');
 let current=fontScale({font_scale:Number(select.value)}),saving=false;
 select.onchange=async()=>{
  const next=fontScale({font_scale:Number(select.value)});
  if(saving||!isCurrent()||next===current)return;
  saving=true;select.disabled=true;status.classList.remove('error');status.textContent=t('Enregistrement…');
  try{
   const change={font_scale:next};
   const prefs=preferencesService?await preferencesService.patch(change,{isCurrent:canSave}):await api('/api/preferences',{method:'PATCH',body:change});
   if(!prefs||!isCurrent())return;
   current=applyTextSize(prefs);select.value=String(current);
   status.textContent=t('Taille du texte enregistrée.');
   onSaved?.(prefs);
  }catch(error){
   if(!isCurrent())return;
   select.value=String(current);status.classList.add('error');status.textContent=error.message||t('Impossible d’enregistrer ce choix.');
  }finally{saving=false;select.disabled=false;}
 };
}
