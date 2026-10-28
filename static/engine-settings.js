import {t,ui,locale} from './i18n.js';
import {api,field,select,modal} from './api.js';

export const DEFAULT_ENGINE_SETTINGS=Object.freeze({mode:'time',time_ms:1000,depth:18});
export const MAX_ENGINE_TIME_MS=Number.MAX_SAFE_INTEGER;
export const MAX_ENGINE_DEPTH=2147483647;
let current={...DEFAULT_ENGINE_SETTINGS},loaded=false,pending=null,saveTail=null,revision=0;

export function validateEngineSettings(settings){
 if(!settings||!['time','depth','infinite'].includes(settings.mode))throw new Error(t('Choisis une durée, une profondeur cible ou un calcul sans limite.'));
 if(!Number.isSafeInteger(settings.time_ms)||settings.time_ms<100||settings.time_ms>MAX_ENGINE_TIME_MS)throw new Error(t('La durée doit être un nombre positif d’au moins 0,1 seconde.'));
 if(!Number.isInteger(settings.depth)||settings.depth<1||settings.depth>MAX_ENGINE_DEPTH)throw new Error(t('La profondeur doit être un entier positif accepté par le moteur.'));
 return {mode:settings.mode,time_ms:settings.time_ms,depth:settings.depth};
}
export function applyEngineSettings(settings=DEFAULT_ENGINE_SETTINGS){current=validateEngineSettings(settings);loaded=true;revision++;return {...current};}
export function getEngineSettings(){return {...current};}
export function engineSettingsLoaded(){return loaded;}
export function engineSearchSettings(settings=current){return {multipv:3,time_ms:settings.mode==='time'?settings.time_ms:null,depth:settings.mode==='depth'?settings.depth:null};}
export async function loadEngineSettings(){
 if(loaded)return getEngineSettings();
 if(saveTail){try{await saveTail;}catch{}return loadEngineSettings();}
 if(pending)return pending;
 const version=revision;
 const request=api('/api/engine/settings').then(settings=>version===revision?applyEngineSettings(settings):getEngineSettings());
 pending=request;
 try{return await request;}finally{if(pending===request)pending=null;}
}
export async function saveEngineSettings(settings){
 const next=validateEngineSettings(settings),version=++revision;
 const write=async()=>{
  try{const saved=validateEngineSettings(await api('/api/engine/settings',{method:'PATCH',body:next}));return version===revision?applyEngineSettings(saved):getEngineSettings();}
  catch(error){if(version===revision)loaded=false;throw error;}
 };
 // Keep server writes in selection order, including when a closed dialog is still saving.
 const request=saveTail?saveTail.then(write,write):write();saveTail=request;
 try{return await request;}finally{if(saveTail===request)saveTail=null;}
}

export async function openEngineSettings({isCurrent=()=>true,onSaved=()=>{},openDialog=modal}={}){
 const saved=await loadEngineSettings();if(!isCurrent())return null;
 let dialog,form;
 const owns=()=>isCurrent()&&dialog?.open&&dialog.querySelector('form')===form;
 dialog=openDialog(t('Réglages du moteur'),select('Arrêter le calcul selon','mode',[['time',t('Durée de calcul')],['depth',t('Profondeur cible')],['infinite',t('Sans limite')]],saved.mode)+'<div data-engine-duration>'+field(t('Durée par position · secondes'),'time_seconds',saved.time_ms/1000,'number','min="0.1" step="0.1" inputmode="decimal"')+'</div><div data-engine-depth>'+field(t('Profondeur cible'),'depth',saved.depth,'number','min="1" step="1" inputmode="numeric"')+ui('<p class="hint">Le calcul vise cette profondeur sans limite de temps. La profondeur atteignable dépend du moteur.</p></div><p class="hint" data-engine-unlimited>Désactive le moteur ou change de position pour arrêter le calcul.</p>'),{
  submit:t('Appliquer'),onSubmit:async(data,submitted)=>{
   if(submitted!==form||!owns())return;
   const mode=String(data.get('mode')),duration=String(form.elements.time_seconds.value).trim(),depth=String(form.elements.depth.value).trim();
   const milliseconds=duration===String(saved.time_ms/1000)?saved.time_ms:Number(duration)*1000,target=Number(depth);
   const validTime=duration!==''&&!form.elements.time_seconds.validity?.badInput&&Number.isSafeInteger(milliseconds)&&milliseconds>=100&&milliseconds<=MAX_ENGINE_TIME_MS;
   const validDepth=depth!==''&&!form.elements.depth.validity?.badInput&&Number.isInteger(target)&&target>=1&&target<=MAX_ENGINE_DEPTH;
   if(mode==='time'&&!validTime)throw new Error(t('La durée doit être un nombre positif d’au moins 0,1 seconde.'));
   if(mode==='depth'&&!validDepth)throw new Error(t('La profondeur doit être un entier positif accepté par le moteur.'));
   const next=await saveEngineSettings({mode,time_ms:validTime?milliseconds:saved.time_ms,depth:validDepth?target:saved.depth});
   if(owns())await onSaved(next);
  }
 });
 form=dialog.querySelector('form');form.noValidate=true;
 const toggle=()=>{form.querySelector('[data-engine-duration]').hidden=form.elements.mode.value!=='time';form.querySelector('[data-engine-depth]').hidden=form.elements.mode.value!=='depth';form.querySelector('[data-engine-unlimited]').hidden=form.elements.mode.value!=='infinite';};
 form.elements.mode.onchange=toggle;toggle();return dialog;
}
