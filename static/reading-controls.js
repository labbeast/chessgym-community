import {t,ui} from './i18n.js';
const STORAGE_KEY='chessgym.reading';
const MOVE_DEFAULTS={evaluationMode:'loss',timeMode:'elapsed',highlightEvaluation:true,highlightTime:true};
const DEFAULTS={toolsCollapsed:false,boardReduced:false,fontSize:13,...MOVE_DEFAULTS};
const MIN_FONT=11,MAX_FONT=18;
const PRESETS={analysis:{...DEFAULTS},reading:{...DEFAULTS,toolsCollapsed:true,boardReduced:true,fontSize:16},repertoire:{...DEFAULTS}};
function layout(value={}){
 return {toolsCollapsed:value.toolsCollapsed===true,boardReduced:value.boardReduced===true,fontSize:typeof value.fontSize==='number'&&Number.isFinite(value.fontSize)?Math.max(MIN_FONT,Math.min(MAX_FONT,Math.round(value.fontSize))):DEFAULTS.fontSize,
  evaluationMode:value.evaluationMode==='position'?'position':'loss',timeMode:value.timeMode==='remaining'?'remaining':'elapsed',
  highlightEvaluation:typeof value.highlightEvaluation==='boolean'?value.highlightEvaluation:true,highlightTime:typeof value.highlightTime==='boolean'?value.highlightTime:true};
}

function loadPreferences(){
 try{
  const value=JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY)||'null');
  if(!value||typeof value!=='object'||Array.isArray(value))return {state:{...DEFAULTS},preset:'analysis',profiles:{},touchComfort:false};
  const profiles={};for(const key of Object.keys(PRESETS))if(value.profiles?.[key]&&typeof value.profiles[key]==='object')profiles[key]=layout(value.profiles[key]);
  return {state:layout(value),preset:Object.hasOwn(PRESETS,value.preset)?value.preset:'analysis',profiles,touchComfort:value.touchComfort===true};
 }catch{return {state:{...DEFAULTS},preset:'analysis',profiles:{},touchComfort:false};}
}

export function applyDisplayPreferences(){
 const preferences=loadPreferences(),root=globalThis.document?.documentElement;
 if(root?.dataset)root.dataset.touchComfort=String(preferences.touchComfort);
 root?.style?.setProperty('--analysis-comment-size',preferences.state.fontSize+'px');
 return preferences.touchComfort;
}

export function getMoveDisplayPreferences(){
 const {state}=loadPreferences();
 return Object.fromEntries(Object.keys(MOVE_DEFAULTS).map(key=>[key,state[key]]));
}

export function readingControlsHtml(){
 return ui('<details class="analysis-reading-controls"><summary title="Adapter l’affichage de l’analyse">Affichage</summary><div class="analysis-reading-options">')+
  ui('<div class="analysis-display-presets" role="group" aria-label="Préréglages d’affichage"><button type="button" data-reading-action="preset-reading" aria-pressed="false">Lecture</button><button type="button" data-reading-action="preset-repertoire" aria-pressed="false">Répertoire</button><button type="button" data-reading-action="preset-analysis" aria-pressed="false">Analyse</button></div>')+
  ui('<fieldset class="analysis-move-display-settings"><legend>Informations des coups</legend><label>Évaluation<select data-reading-setting="evaluationMode"><option value="loss">Écart au meilleur coup</option><option value="position">Évaluation de la position</option></select></label><label>Temps<select data-reading-setting="timeMode"><option value="elapsed">Temps pris pour ce coup</option><option value="remaining">Temps restant</option></select></label><label class="analysis-display-check"><input type="checkbox" data-reading-setting="highlightEvaluation">Accentuer les erreurs d’évaluation</label><label class="analysis-display-check"><input type="checkbox" data-reading-setting="highlightTime">Accentuer les longues réflexions</label><p class="analysis-display-hint">Les accents du temps correspondent à plus de 5 % et 10 % du temps de départ.</p></fieldset>')+
  ui('<button type="button" data-reading-action="tools" aria-pressed="false">Masquer les outils</button>')+
  ui('<button type="button" data-reading-action="board" aria-pressed="false">Réduire l’échiquier</button>')+
  ui('<div class="analysis-reading-font"><span>Texte des annotations</span><div class="actions">')+
  ui('<button type="button" data-reading-action="font-less" aria-label="Réduire le texte des annotations">A−</button>')+
  ui('<output data-reading-size aria-live="polite">13 px</output>')+
  ui('<button type="button" data-reading-action="font-more" aria-label="Agrandir le texte des annotations">A+</button></div></div>')+
  ui('<button type="button" data-reading-action="touch" aria-pressed="false">Confort tactile</button>')+
  ui('<button type="button" data-reading-action="reset">Réinitialiser cet affichage</button></div></details>');
}

export function mountReadingControls(host,{workbench,onLayoutChange,onPresetChange}={}){
 if(!host||!workbench)return null;
 const preferences=loadPreferences();let {state,preset,profiles,touchComfort}=preferences,disposed=false;
 const control=action=>host.querySelector('[data-reading-action="'+action+'"]');
 const setting=key=>host.querySelector('[data-reading-setting="'+key+'"]');
 const persist=()=>{profiles[preset]={...state};try{globalThis.localStorage?.setItem(STORAGE_KEY,JSON.stringify({...state,preset,profiles,touchComfort}));}catch{}};
 const apply=()=>{
  workbench?.classList.toggle('analysis-tools-collapsed',state.toolsCollapsed);
  workbench?.classList.toggle('analysis-board-reduced',state.boardReduced);
  workbench?.style.setProperty('--analysis-comment-size',state.fontSize+'px');
  // Exercise editors share the annotation size without depending on this workspace.
  globalThis.document?.documentElement?.style?.setProperty('--analysis-comment-size',state.fontSize+'px');
  const root=globalThis.document?.documentElement;if(root?.dataset)root.dataset.touchComfort=String(touchComfort);
  for(const key of Object.keys(PRESETS))control('preset-'+key)?.setAttribute('aria-pressed',String(key===preset));
  control('touch')?.setAttribute('aria-pressed',String(touchComfort));
  for(const key of ['evaluationMode','timeMode']){const input=setting(key);if(input)input.value=state[key];}
  for(const key of ['highlightEvaluation','highlightTime']){const input=setting(key);if(input)input.checked=state[key];}
  const tools=control('tools'),board=control('board'),less=control('font-less'),more=control('font-more');
  if(tools){tools.textContent=state.toolsCollapsed?t('Afficher les outils'):t('Masquer les outils');tools.setAttribute('aria-pressed',String(state.toolsCollapsed));}
  if(board){board.textContent=state.boardReduced?t('Agrandir l’échiquier'):t('Réduire l’échiquier');board.setAttribute('aria-pressed',String(state.boardReduced));}
  if(less)less.disabled=state.fontSize<=MIN_FONT;
  if(more)more.disabled=state.fontSize>=MAX_FONT;
  const size=host.querySelector('[data-reading-size]');if(size)size.textContent=state.fontSize+' px';
  if(typeof onLayoutChange==='function')onLayoutChange({...state});
 };
 const update=partial=>{
  if(disposed||!partial||typeof partial!=='object'||Array.isArray(partial))return;
  const next={...state};
  for(const key of ['toolsCollapsed','boardReduced','highlightEvaluation','highlightTime'])if(typeof partial[key]==='boolean')next[key]=partial[key];
  if(['position','loss'].includes(partial.evaluationMode))next.evaluationMode=partial.evaluationMode;
  if(['elapsed','remaining'].includes(partial.timeMode))next.timeMode=partial.timeMode;
  if(typeof partial.fontSize==='number'&&Number.isFinite(partial.fontSize))next.fontSize=Math.max(MIN_FONT,Math.min(MAX_FONT,Math.round(partial.fontSize)));
  if(Object.keys(state).every(key=>state[key]===next[key]))return;
  state=next;
  persist();
  apply();
 };
 const click=event=>{
  if(disposed)return;
  const button=event.target?.closest?.('[data-reading-action]');
  if(!button||!host.contains(button)||button.disabled)return;
  const selected=button.dataset.readingAction?.replace(/^preset-/,'');
  if(Object.hasOwn(PRESETS,selected)){
   profiles[preset]={...state};preset=selected;state={...(profiles[preset]||PRESETS[preset])};persist();apply();
   onPresetChange?.({preset,tool:preset==='repertoire'?'explorer':preset==='analysis'?'analysis':null});return;
  }
  switch(button.dataset.readingAction){
   case 'tools':update({toolsCollapsed:!state.toolsCollapsed});break;
   case 'board':update({boardReduced:!state.boardReduced});break;
   case 'font-less':update({fontSize:state.fontSize-1});break;
   case 'font-more':update({fontSize:state.fontSize+1});break;
   case 'touch':touchComfort=!touchComfort;persist();apply();break;
   case 'reset':update(PRESETS[preset]);break;
  }
 };
 const change=event=>{
  if(disposed)return;
  const input=event.target?.closest?.('[data-reading-setting]');if(!input||!host.contains(input)||input.disabled)return;
  const key=input.dataset.readingSetting;
  if(['evaluationMode','timeMode'].includes(key))update({[key]:input.value});
  else if(['highlightEvaluation','highlightTime'].includes(key))update({[key]:input.checked});
 };
 host.addEventListener('click',click);host.addEventListener('change',change);apply();
 return {get state(){return {...state};},get preset(){return preset;},get touchComfort(){return touchComfort;},update,disconnect(){disposed=true;host.removeEventListener('click',click);host.removeEventListener('change',change);}};
}
