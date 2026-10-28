import {bindTrainingTabs,setupSummaryHtml} from './exercise-tabs.js';
import {t,ui,locale} from './i18n.js';
import {api,esc,fail,modal,option,time,notice} from './api.js';
import {Board,makeDoc,appendLine} from './board.js';
import {analysisMovesHtml} from './analysis-moves.js';
import {playSound} from './sound.js';
import {puzzleFeedbackHtml,puzzleResultLabel} from './puzzle-feedback.js';
import {openExerciseEditor} from './exercise-editor.js';
import {stormResultsHtml} from './storm-results.js';
import {stormComboHtml} from './storm-combo.js';
import {TrainingHistoryView} from './training-history.js';
import {nativeProgramRequest,acceptedProgramCreation} from './training-native.js';

const requestId=()=>globalThis.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2);
const number=value=>Math.round(value||0).toLocaleString(locale());
const post=(path,body={})=>api('/api/puzzles'+path,{method:'POST',body});
const resultLabel=puzzleResultLabel;
const DEFAULT_FILTERS={rating_min:0,rating_max:4000,themes:[],opening:'',color:'any',solution_min:1,solution_max:100,history:'all'};

export class PuzzleView {
 constructor(container,{initialSettings=null,onSettingsChange=null}={}){this.host=container;this.onSettingsChange=onSettingsChange;this.savedSettings=initialSettings;this.filters={...DEFAULT_FILTERS,...(initialSettings?.filters||{})};this.selection=initialSettings?.selection||'standard';this.rated=initialSettings?.rated!==false;this.page=0;this.mode=initialSettings?.mode==='storm'?'storm':'classic';this.tab='play';this.disposed=false;this.busy=false;this.viewToken=0;this.stormResults=null;this.stormResultFilter='all';this.showingStormResults=false;this.reviewingStormId=null;}
 async mount(){await this.load();return this;}
 dispose(){this.disposed=true;this.historyView?.dispose();this.exerciseEditor?.close();this.board?.dispose();clearInterval(this.timer);clearTimeout(this.poll);this.host.classList.remove('puzzle-page');}
 async load(){const token=this.viewToken;const data=await api('/api/puzzles/overview');if(this.disposed||token!==this.viewToken)return;this.data=data;if(this.selection!=='standard'&&this.selection!=='custom'&&!data.sets.some(set=>String(set.id)===this.selection))this.selection='custom';this.render();}
 shell(content){
  this.historyView?.dispose();this.historyView=null;
  this.host.classList.add('puzzle-page');
  this.host.innerHTML=`<header class="puzzle-header training-header"><div><h1>${esc(t('Puzzles'))}</h1><span class="muted">${number(this.data.bank.count)} ${esc(t('positions'))} · Lichess CC0</span></div><div class="puzzle-header-tools"><nav class="tabs training-tabs" aria-label="${esc(t('Puzzles'))}">${[['play','Jouer'],['history','Historique'],['stats','Statistiques'],['settings','Réglages']].map(([id,label])=>`<button data-tab="${id}" ${id!=='play'&&this.storm?.status==='active'?'disabled':''} aria-pressed="${this.tab===id}" class="${this.tab===id?'active':''}">${esc(t(label))}</button>`).join('')}</nav></div></header>${content}`;
  bindTrainingTabs(this.host,{active:this.tab==='stats'?'statistics':this.tab});
  this.host.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{if(this.storm?.status==='active')return;clearInterval(this.timer);clearTimeout(this.poll);if(this.tab==='settings'&&b.dataset.tab!=='settings')this.restoreSetup();else this.captureSetup();this.viewToken++;this.tab=b.dataset.tab;const action=this.tab==='history'?this.history():this.tab==='stats'?this.statistics():this.tab==='settings'?this.showSettings():this.resumePlay();void action.catch(fail);});
 }
 async resumePlay(){
  if(this.showingStormResults&&this.resultSessionId)return this.openStormResults(this.resultSessionId);
  const token=this.viewToken;
  if(this.attempt){
   const a=await api('/api/puzzles/attempts/'+this.attempt.id);if(this.disposed||token!==this.viewToken)return;this.attempt=a;
   if(this.storm){const r=await api('/api/puzzles/storm/'+this.storm.id);if(this.disposed||token!==this.viewToken)return;this.storm=r.storm;this.stormReceived=Date.now();if(r.storm.status==='completed')return this.openStormResults(r.storm.id);if(r.attempt){if(r.attempt.id!==a.id&&a.status!=='active')this.lastStormResult=a;this.attempt=r.attempt;}}
   this.render();
  }else await this.load();
 }
 render(){if(this.disposed)return;if(this.tab==='settings'){void this.showSettings().catch(fail);return;}this.board?.dispose();clearInterval(this.timer);clearTimeout(this.poll);if(this.showingStormResults&&this.stormResults?.storm.id===this.resultSessionId){this.renderStormResults();return;}if(this.attempt){this.showAttempt(this.attempt);return;}this.shell(this.setupHtml());this.bindSetup();if(this.data.bank.status==='importing')this.poll=setTimeout(()=>{this.captureSetup();this.load().catch(fail);},5000);}
 selectedName(){return this.selection==='standard'?t('Standard'):this.data.sets.find(s=>String(s.id)===this.selection)?.name||t('Personnalisée');}
 filterKey(filters){const f={...DEFAULT_FILTERS,...filters};f.themes=[...new Set(f.themes)].sort();f.opening=f.opening.trim();return JSON.stringify(Object.keys(DEFAULT_FILTERS).map(key=>f[key]));}
 stormRecord(){return this.selection==='standard'?this.data.storm.best:(this.data.storm.records||[]).find(r=>r.key!=='standard'&&this.filterKey(r.filters)===this.filterKey(this.filters))?.best||0;}
 stormName(storm=this.storm){return storm?.custom?(storm.name==='Personnalisée'?t('Personnalisée'):storm.name):t('Standard');}
 saveSetup(){if(this.tab==='settings')return;this.onSettingsChange?.({selection:this.selection,filters:structuredClone(this.filters),mode:this.mode,rated:this.rated!==false});}
 restoreSetup(){if(this.settingsSnapshot){Object.assign(this,structuredClone(this.settingsSnapshot));this.settingsSnapshot=null;}}
 async showSettings(){
  clearTimeout(this.poll);if(!this.settingsSnapshot)this.settingsSnapshot={selection:this.selection,filters:structuredClone(this.filters),mode:this.mode,rated:this.rated!==false};
  this.tab='settings';this.shell(this.settingsHtml());this.bindSetup();
  const host=this.host.querySelector('[data-copy-settings-host]');if(host)await this.copySettings(host);
  if(!this.disposed&&host?.isConnected&&this.data.bank.status==='importing')this.poll=setTimeout(()=>{this.captureSetup();void this.load().catch(fail);},5000);
 }
 setupHtml(){
  const d=this.data,storm=this.mode==='storm',custom=this.selection!=='standard';
  const f=this.filters,description=custom?[this.selectedName(),f.rating_min+'–'+f.rating_max,...f.themes,f.opening,f.color==='any'?'':t(f.color==='white'?'Blancs':'Noirs')].filter(Boolean).join(' · '):t('Tous les thèmes et ouvertures, sans filtre personnalisé.');
  return `<section class="puzzle-dashboard exercise-launch"><div class="puzzle-modes">${[['classic','Classique / Calcul'],['storm','Puzzle Storm']].map(([id,label])=>`<button data-mode="${id}" aria-pressed="${this.mode===id}" class="${this.mode===id?'primary':''}">${esc(t(label))}</button>`).join('')}</div><div class="puzzle-profile"><strong data-profile-value>${number(storm?this.stormRecord():d.profile.rating)}</strong><span>${esc(t(storm?'Record de cette sélection':d.profile.provisional?'Cote personnelle provisoire':'Cote personnelle'))}</span></div><form data-filters>${setupSummaryHtml(description+' · '+t(storm?'3 minutes':this.rated!==false?'Exercice classé':'Non coté'))}<input hidden type="checkbox" name="rated" ${this.rated!==false?'checked':''}>${custom?`<button type="button" class="exercise-customize" data-standard-selection>${esc(t('Revenir au standard'))}</button>`:''}<div class="puzzle-actions"><button class="primary" type="submit">${esc(t(storm?'Démarrer Storm':'Commencer'))}</button>${!storm&&d.active?`<button type="button" data-resume>${esc(t('Reprendre le puzzle'))}</button>`:''}</div></form>${!d.bank.count?`<p class="muted">${esc(t('Aucune banque importée.'))} <button class="exercise-customize" data-exercise-bank>${esc(t('Banque de puzzles'))}</button></p>`:''}</section>`;
 }
 settingsHtml(){
  const d=this.data,custom=this.selection!=='standard',saved=d.sets.some(s=>String(s.id)===this.selection),storm=this.mode==='storm';
  return `<div class="puzzle-dashboard"><section class="panel puzzle-setup"><div class="puzzle-modes">${[['classic','Classique / Calcul'],['storm','Puzzle Storm']].map(([id,label])=>`<button data-mode="${id}" class="${this.mode===id?'primary':''}">${esc(t(label))}</button>`).join('')}</div>
   <div class="puzzle-profile"><strong data-profile-value>${number(storm?this.stormRecord():d.profile.rating)}</strong><span>${esc(t(storm?'Record de cette sélection':d.profile.provisional?'Cote personnelle provisoire':'Cote personnelle'))}</span></div>
   <form data-filters><label class="puzzle-set-picker">${esc(t('Sélection de puzzles'))}<select name="selection">${option('standard',t('Standard'),this.selection)}${option('custom',t('Personnalisée'),this.selection)}${d.sets.length?`<optgroup label="${esc(t('Mes sélections personnalisées'))}">${d.sets.map(s=>option(s.id,s.name,this.selection)).join('')}</optgroup>`:''}</select></label>
   ${custom?`<div class="puzzle-filter-grid" data-custom-filters><label>${esc(t('Historique'))}<select name="history">${[['all','Tous'],['unseen','Jamais tentés'],['failed','Déjà échoués']].map(([v,l])=>option(v,t(l),this.filters.history)).join('')}</select></label><label>${esc(t('Camp à jouer'))}<select name="color">${[['any','Les deux'],['white','Blancs'],['black','Noirs']].map(([v,l])=>option(v,t(l),this.filters.color)).join('')}</select></label><label>${esc(t('Classement minimum'))}<input name="rating_min" type="number" min="0" max="4000" value="${this.filters.rating_min}" required></label><label>${esc(t('Classement maximum'))}<input name="rating_max" type="number" min="0" max="4000" value="${this.filters.rating_max}" required></label><label>${esc(t('Thèmes'))}<input name="themes" value="${esc(this.filters.themes.join(' '))}" placeholder="fork pin mateIn2"></label><label>${esc(t('Ouverture'))}<input name="opening" value="${esc(this.filters.opening)}" placeholder="Sicilian Defense"></label><label>${esc(t('Longueur de la solution (demi-coups)'))}<span class="puzzle-range"><input aria-label="${esc(t('Minimum'))}" name="solution_min" type="number" min="1" max="100" value="${this.filters.solution_min}" required><span>–</span><input aria-label="${esc(t('Maximum'))}" name="solution_max" type="number" min="1" max="100" value="${this.filters.solution_max}" required></span></label></div><div class="puzzle-set-actions"><button type="button" data-save-set>${esc(t('Enregistrer la sélection'))}</button><button type="button" data-delete-set ${saved?'':'hidden'}>${esc(t('Supprimer la sélection'))}</button></div>`:`<p class="muted">${esc(t('Tous les thèmes et ouvertures, sans filtre personnalisé.'))}</p>`}
    ${storm?`<p>${esc(t('3 minutes · difficulté progressive · même camp pendant la séance.'))}</p><p class="muted">${esc(t('Un point par puzzle. Les bons coups prolongent le chrono; une erreur retire 10 secondes et remet le combo à zéro.'))}</p><p class="muted">${esc(t('Bonus : 5 coups → +3 s · 12 → +5 s · 20 → +7 s · 30 → +10 s, puis +10 s tous les 10 coups.'))}</p>${custom?`<p class="muted">${esc(t('La difficulté progresse dans les limites de ta sélection. Les records sont séparés du Storm standard.'))}</p>`:''}`:`<label class="puzzle-check"><input name="rated" type="checkbox" ${this.rated!==false?'checked':''}> ${esc(t('Faire évoluer ma cote'))}</label><p class="muted">${esc(t('La cote dépend de la réussite et de la difficulté. Le temps sert uniquement de statistique.'))}</p>`}
   <div class="puzzle-actions"><button class="primary" type="submit" ${storm?'data-start':''}>${esc(t(this.tab==='settings'?'Enregistrer les réglages':storm?'Démarrer Storm':'Commencer'))}</button>${this.tab==='settings'?`<button type="button" data-cancel-puzzle-settings>${esc(t('Annuler'))}</button>`:''}${!storm&&d.active?`<button type="button" data-resume>${esc(t('Reprendre le puzzle'))}</button>`:''}</div></form></section>
   <aside class="panel puzzle-summary"><h2>${esc(t('Gestion'))}</h2><div data-copy-settings-host></div><details class="puzzle-import"><summary>${esc(t('Banque de puzzles'))}</summary><p>${esc(t('Importe le fichier CSV.ZST de Lichess stocké sur le serveur ChessGym.'))}</p><a href="https://database.lichess.org/#puzzles" target="_blank" rel="noopener">${esc(t('Télécharger la banque Lichess'))}</a><form data-import><label>${esc(t('Chemin du fichier sur le serveur'))}<input name="source" required placeholder="C:\\Downloads\\lichess_db_puzzle.csv.zst"></label><button>${esc(t('Importer'))}</button></form><p role="status">${esc(t(d.bank.status==='importing'?'Importation en cours…':d.bank.count?'Banque prête':'Aucune banque importée.'))}</p></details></aside></div>`;
 }
 captureSetup(){const form=this.host.querySelector('[data-filters]');if(!form)return;if(this.selection==='standard')this.filters={...DEFAULT_FILTERS};else if(form.querySelector('[data-custom-filters]'))this.filters=this.readFilters(form);if(form.elements.rated)this.rated=form.elements.rated.checked;this.saveSetup();}
 bindSetup(){
  const form=this.host.querySelector('[data-filters]');
  this.host.querySelector('[data-exercise-bank]')?.addEventListener('click',()=>{this.tab='settings';void this.showSettings().catch(fail);});
  this.host.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{this.captureSetup();this.mode=b.dataset.mode;this.saveSetup();this.render();});
  form.onsubmit=e=>{e.preventDefault();if(!form.reportValidity())return;this.captureSetup();if(this.filters.rating_min>this.filters.rating_max){fail(new Error(t('La cote minimale doit être inférieure ou égale à la cote maximale.')));return;}if(this.tab==='settings'){this.settingsSnapshot=null;this.tab='play';this.saveSetup();this.render();return;}void (this.mode==='storm'?this.startStorm():this.start()).catch(fail);};
  if(form.elements.selection)form.elements.selection.onchange=()=>{this.captureSetup();this.selection=form.elements.selection.value;const saved=this.data.sets.find(s=>String(s.id)===this.selection);this.filters=this.selection==='standard'?{...DEFAULT_FILTERS}:saved?{...DEFAULT_FILTERS,...saved.filters}:this.filters;this.render();};
  form.querySelector('[data-custom-filters]')?.addEventListener('input',()=>{this.selection='custom';form.elements.selection.value='custom';form.querySelector('[data-delete-set]').hidden=true;this.captureSetup();if(this.mode==='storm')this.host.querySelector('[data-profile-value]').textContent=number(this.stormRecord());});
  form.querySelector('[data-save-set]')?.addEventListener('click',()=>{this.captureSetup();modal(t('Enregistrer la sélection'),`<label>${esc(t('Nom'))}<input name="name" maxlength="100" required></label>`,{onSubmit:async data=>{const saved=await post('/sets',{name:data.get('name'),filters:this.filters});this.selection=String(saved.id);await this.load();}});});
  form.querySelector('[data-delete-set]')?.addEventListener('click',async()=>{const id=Number(this.selection);if(!id)return;try{await api('/api/puzzles/sets/'+id,{method:'DELETE'});this.selection='custom';await this.load();}catch(e){fail(e);}});
  form.querySelector('[data-resume]')?.addEventListener('click',()=>{this.attempt=this.data.active;this.showAttempt(this.attempt);});
  this.host.querySelector('[data-exercise-customize]')?.addEventListener('click',()=>{this.captureSetup();this.tab='settings';void this.showSettings().catch(fail);});
  this.host.querySelector('[data-standard-selection]')?.addEventListener('click',()=>{this.selection='standard';this.filters={...DEFAULT_FILTERS};this.rated=true;this.saveSetup();this.render();});
  form.querySelector('[data-cancel-puzzle-settings]')?.addEventListener('click',()=>{this.restoreSetup();this.tab='play';this.render();});
  const importForm=this.host.querySelector('[data-import]');if(importForm)importForm.onsubmit=async e=>{e.preventDefault();const b=e.currentTarget.querySelector('button');b.disabled=true;try{await post('/import',{source:new FormData(e.currentTarget).get('source')});await this.load();}catch(error){fail(error);b.disabled=false;}};
 }
 readFilters(form){const f=new FormData(form);return {rating_min:Number(f.get('rating_min')),rating_max:Number(f.get('rating_max')),themes:String(f.get('themes')).trim().split(/[\s,]+/).filter(Boolean),opening:String(f.get('opening')).trim(),color:f.get('color'),solution_min:Number(f.get('solution_min')),solution_max:Number(f.get('solution_max')),history:f.get('history')};}
 async copySettings(host=null){
  const library=await api('/api/library');if(this.disposed)return;
  const bases=library.bases.filter(b=>!b.reference),settings=this.data.profile.settings;
  const choices=[['','Puzzles classiques','auto_copy_base_id'],['storm_','Puzzle Storm','storm_auto_copy_base_id']];
  const fields=choices.map(([prefix,label,key])=>{
   const current=settings[key],enabled=bases.some(b=>b.id===current);
   return `<section class="puzzle-copy-setting"><h3>${esc(t(label))}</h3><label class="puzzle-check"><input name="${prefix}enabled" type="checkbox" ${enabled?'checked':''} ${bases.length?'':'disabled'}>${esc(t(prefix?'Copier les puzzles Storm manqués':'Copier automatiquement mes échecs'))}</label><label>${esc(t('Base de destination'))}<select name="${prefix}base" ${enabled?'required':'disabled'}>${bases.map(b=>option(b.id,b.name,current)).join('')}</select></label></section>`;
  }).join('');
  const content=`<div class="puzzle-copy-settings">${fields}</div>${bases.length?'':`<p>${esc(t('Crée d’abord une base d’étude dans la bibliothèque.'))}</p>`}<p class="muted">${esc(t('Classique : dès une erreur ou une aide. Storm : après une mauvaise réponse.'))}</p><p class="muted">${esc(t('Les copies existantes et leurs annotations sont conservées, sans doublon dans la même base. Les anciennes tentatives ne sont pas copiées rétroactivement.'))}</p>`;
  const onSubmit=async data=>{
   const result=await api('/api/puzzles/settings',{method:'PUT',body:{auto_copy_base_id:data.has('enabled')?Number(data.get('base')):null,storm_auto_copy_base_id:data.has('storm_enabled')?Number(data.get('storm_base')):null}});
   if(this.disposed)return;
   this.data.profile.settings.auto_copy_base_id=result.auto_copy_base_id;
   this.data.profile.settings.storm_auto_copy_base_id=result.storm_auto_copy_base_id;
   const active=result.active_attempts?.find(a=>a.id===this.attempt?.id);
   if(active&&this.attempt){this.attempt.copied_entry_id=active.copied_entry_id;this.updateCopiedNotice();}
   notice(t('Réglages des puzzles enregistrés.'));
  };
  if(this.disposed||host&&!host.isConnected)return;
  const dialog=host||document.createElement('section');dialog.innerHTML='<form data-copy-preferences>'+content+'<button class="primary" type="submit">'+esc(t('Enregistrer'))+'</button></form>';
  dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget;if(!form.reportValidity())return;const button=form.querySelector('[type=submit]');button.disabled=true;try{await onSubmit(new FormData(form));}catch(error){fail(error);}finally{button.disabled=false;}};
  for(const [prefix] of choices)dialog.querySelector(`[name="${prefix}enabled"]`).onchange=e=>{const select=dialog.querySelector(`[name="${prefix}base"]`);select.disabled=!e.target.checked;select.required=e.target.checked;};
 }
 async createExercise(attemptId=null,button=null){
  const fromResults=attemptId!=null,sessionId=this.resultSessionId;
  const attempt=fromResults?this.stormResults?.attempts.find(a=>a.id===attemptId):this.attempt;
  if(this.disposed||this.creatingExercise||!attempt||attempt.status==='active'||(this.storm?.status==='active'))return;
  if(this.exerciseEditor&&!this.exerciseEditor.disposed){this.exerciseEditor.dialog.focus();return;}
  const token=this.viewToken;button??=this.host.querySelector('[data-create-exercise]');this.creatingExercise=true;if(button)button.disabled=true;
  try{
   const source=attempt.solution_pgn?attempt:await api('/api/puzzles/attempts/'+attempt.id);
   if(!source.solution_pgn)throw new Error(t('La solution du puzzle est indisponible. Recharge la page.'));
   const [library,doc]=await Promise.all([api('/api/library'),api('/api/board',{method:'POST',body:{pgn:source.solution_pgn}})]);
   if(this.disposed||token!==this.viewToken||(fromResults?(!this.showingStormResults||sessionId!==this.resultSessionId):this.attempt?.id!==attempt.id))return;
   const destination=this.data.profile.settings[source.mode==='storm'?'storm_auto_copy_base_id':'auto_copy_base_id'];
   this.exerciseEditor=openExerciseEditor({sourceDoc:doc,initialDoc:doc,sourcePath:'',flipped:source.color==='black',bases:library.bases,baseId:destination,
    initialTitle:'Lichess '+source.puzzle_id+' · '+source.rating,newBaseName:t('Puzzles à revoir'),
    onCreated:()=>notice(t('Exercice ajouté à la base. Le puzzle est conservé.')),
    onClosed:()=>{this.exerciseEditor=null;}});
  }finally{this.creatingExercise=false;if(button?.isConnected)button.disabled=false;}
 }
 updateCopiedNotice(){const host=this.host.querySelector('[data-copied-notice]');if(host){host.hidden=!this.attempt?.copied_entry_id;host.textContent=this.attempt?.copied_entry_id?t('Déjà copié dans la bibliothèque.'):'';}}
 async start(puzzleId=null){if(this.busy)return;const token=++this.viewToken;this.busy=true;try{const a=await nativeProgramRequest(this,'puzzles',{filters:this.filters,rated:this.rated!==false,puzzle_id:puzzleId},body=>post('/attempts',body));if(this.disposed||token!==this.viewToken)return;acceptedProgramCreation(this,'puzzles');this.showingStormResults=false;this.reviewingStormId=null;this.lastStormResult=null;this.storm=null;this.attempt=a;this.showAttempt(a);}finally{this.busy=false;}}
 async startStorm(){
  if(this.busy)return;const token=++this.viewToken;this.busy=true;
  try{const saved=this.data.sets.find(s=>String(s.id)===this.selection);const r=await nativeProgramRequest(this,'storm',this.selection==='standard'?{}:{filters:this.filters,...(saved?{set_name:saved.name}:{})},body=>post('/storm',body));if(this.disposed||token!==this.viewToken)return;acceptedProgramCreation(this,'storm');this.showingStormResults=false;this.reviewingStormId=null;this.lastStormResult=null;this.storm=r.storm;this.stormReceived=Date.now();this.attempt=r.attempt;this.showAttempt(r.attempt);}finally{this.busy=false;}
 }
 showAttempt(a,feedback=''){
  if(this.disposed)return;
  this.board?.dispose();clearInterval(this.timer);clearTimeout(this.poll);this.tab='play';this.attempt=a;
  const finished=a.status!=='active';
  const ratingChange=!this.storm&&a.rating_after!=null?`<div class="puzzle-rating-result"><span>${esc(t('Cote personnelle'))}</span><strong>${number(a.rating_after)}</strong><span>${a.rating_after>=a.rating_before?'+':''}${Math.round(a.rating_after-a.rating_before)}</span></div>`:'';
  this.shell(`<div class="puzzle-workspace">
   <section class="puzzle-board-column ${finished&&!this.storm?'finished':'solving'}">
    <div data-puzzle-board></div>
    ${this.storm?`<div class="puzzle-storm-timer" role="timer" aria-label="${esc(t('Temps restant'))}"><strong data-timer></strong></div>${this.stormTimeDeltaHtml()}`:''}
   </section>
   <section class="panel puzzle-attempt-panel">
    <header><h2>${esc(this.storm?'Puzzle Storm · '+this.stormName():'#'+a.puzzle_id)}</h2><div class="puzzle-attempt-tools">${this.storm?'':`<span>${esc(t('Difficulté'))} ${number(a.rating)}</span>`}<button data-exit>${esc(t('Retour'))}</button></div></header>
    ${this.storm?`<div class="puzzle-storm-score"><strong>${this.storm.score}</strong><span>${esc(t('puzzles résolus'))}</span><span>${esc(t('Combo'))} ${this.storm.combo} · ${esc(t('Erreurs'))} ${this.storm.mistakes}</span></div>${stormComboHtml(this.storm)}`:''}
    ${this.stormLastResultHtml()}${puzzleFeedbackHtml(a,feedback)}${ratingChange}
    <div class="puzzle-actions">${finished?`<button class="primary" data-next>${esc(t(this.storm?'Puzzle suivant':'Prochain puzzle'))}</button>${!this.storm?`<button data-create-exercise>＋ ${esc(t('Créer un exercice'))}</button><button data-replay>${esc(t('Rejouer sans cote'))}</button>`:''}`:this.storm?'':`<button data-hint>${esc(t('Indice'))}</button><button data-reveal>${esc(t('Voir la solution'))}</button>`}</div>
    ${finished&&!this.storm?`<p class="muted">${esc(t('Tu peux explorer librement la position et la solution.'))}</p><div data-solution class="puzzle-solution"></div><p>${esc(a.themes.join(' · '))}</p><a href="https://lichess.org/training/${encodeURIComponent(a.puzzle_id)}" target="_blank" rel="noopener">${esc(t('Puzzle original'))}</a>`:`<p class="muted">${esc(t(this.storm?'Une erreur retire 10 secondes et passe au puzzle suivant.':'Le premier mauvais coup compte comme un échec. Tu peux continuer pour comprendre.'))}</p>`}
    <p class="puzzle-copied" data-copied-notice ${a.copied_entry_id?'':'hidden'}>${a.copied_entry_id?esc(t('Déjà copié dans la bibliothèque.')):''}</p>
   </section>
  </div>`);
 const applied=appendLine(makeDoc(a.start_fen),'',a.positions||[]);this.board=new Board(this.host.querySelector('[data-puzzle-board]'),{doc:applied.doc,path:applied.path,flipped:a.color==='black',legalState:a.legal,training:!finished||!!this.storm,onMove:finished?null:(move)=>this.action('move',move),onChange:()=>this.renderMoves()});
 this.host.querySelector('[data-exit]').onclick=()=>{clearInterval(this.timer);this.viewToken++;this.attempt=null;this.storm=null;this.load().catch(fail);};this.host.querySelector('[data-hint]')?.addEventListener('click',()=>this.action('hint').catch(fail));this.host.querySelector('[data-reveal]')?.addEventListener('click',()=>this.action('reveal').catch(fail));this.host.querySelector('[data-next]')?.addEventListener('click',()=>this.next().catch(fail));this.host.querySelector('[data-replay]')?.addEventListener('click',()=>this.start(a.puzzle_id).catch(fail));this.host.querySelector('[data-create-exercise]')?.addEventListener('click',()=>this.createExercise().catch(fail));
 if(this.reviewingStormId){const back=this.host.querySelector('[data-exit]'),sid=this.reviewingStormId;back.textContent=t('← Bilan');back.title=t('Retour au bilan Storm');back.onclick=()=>{void this.openStormResults(sid);};}if(finished&&this.storm)this.board.inputLocked=true;if(finished&&a.pgn&&!this.storm)void this.loadSolution(a).catch(fail);if(this.storm){this.tick();this.timer=setInterval(()=>this.tick(),200);}}
 async loadSolution(a){
  const board=this.board,originalDoc=board?.doc;
  const doc=await api('/api/board',{method:'POST',body:{pgn:a.pgn}});
  if(this.disposed||this.attempt!==a||this.board!==board||!board||board.disposed||board.busy||board.doc!==originalDoc)return;
  // Loading annotations must keep the reached position (or the user's cursor).
  const path=board.path;
  if(!doc.nodes.some(node=>node.path===path&&node.fen===board.node().fen))return;
  await board.setDoc(doc,path);
  if(this.board===board&&!board.disposed)this.renderMoves();
 }
 renderMoves(){const host=this.host.querySelector('[data-solution]');if(!host||!this.board)return;host.innerHTML=analysisMovesHtml(this.board.doc,this.board.path);host.querySelectorAll('[data-path]').forEach(b=>b.onclick=()=>this.board.go(b.dataset.path));}
 stormLastResultHtml(){
  const a=this.lastStormResult;
  if(!this.storm||!a||a.session_id!==this.storm.id||a.id===this.attempt?.id)return '';
  const success=a.status==='completed'&&!a.failed;
  return `<div class="puzzle-storm-last-result" data-storm-last-result data-state="${success?'success':'errors'}" role="status"><span>${success?'✓':'×'} ${esc(t(success?'Puzzle précédent : réussi':'Puzzle précédent : manqué'))}</span>${a.copied_entry_id?`<small>${esc(t('Déjà copié dans la bibliothèque.'))}</small>`:''}</div>`;
 }
 stormTimeDeltaHtml(){
  const delta=this.stormTimeDelta;
  const visible=delta?.sessionId===this.storm?.id&&Date.now()-delta.at<2000;
  return `<div class="puzzle-storm-time-delta" data-time-delta role="status" data-positive="${!!delta&&delta.seconds>0}" ${visible?'':'hidden'}>${visible?(delta.seconds>0?'+':'−')+Math.abs(delta.seconds)+' s':''}</div>`;
 }
 async action(kind,move=null){
  if(this.busy||!this.attempt||this.attempt.status!=='active')return;
  const token=this.viewToken,sid=this.storm?.id,aid=this.attempt.id;let advanceFallback=false;
  this.busy=true;
  try{
   const body={request_id:requestId(),version:this.attempt.version,move};
   if(kind==='move'&&this.storm?.inline_next===true)body.advance_storm=true;
   const r=await post('/attempts/'+aid+'/'+kind,body);
   if(this.disposed||token!==this.viewToken)return;
   if(r.attempt.rating_after!=null){this.data.profile.rating=r.attempt.rating_after;if(r.attempt.rating_deviation!=null){this.data.profile.rating_deviation=r.attempt.rating_deviation;this.data.profile.provisional=r.attempt.provisional;}}
   if(r.storm){this.storm=r.storm;this.stormReceived=Date.now();if(r.storm.time_delta_seconds)this.stormTimeDelta={sessionId:r.storm.id,seconds:r.storm.time_delta_seconds,at:Date.now()};}
   if(r.correct===false)playSound('incorrect');else if(r.attempt.status==='completed')playSound('complete');else if(r.correct)playSound('correct');
   if(r.storm?.status==='completed'){this.attempt=r.attempt;this.finishStorm();return;}
   if(r.next_attempt&&r.storm?.status==='active'){
    this.lastStormResult=r.attempt;this.showAttempt(r.next_attempt);return;
   }
   this.showAttempt(r.attempt,r.attempt.status!=='active'?resultLabel(r.attempt):r.hint?t('Coup suggéré : {move}',{move:r.hint}):r.correct===false?t('Ce n’est pas la solution. Réessaie.'):r.correct?t('Bien joué !'):'');
   if(r.next_error){notice(t(r.next_error.message),true);return;}
   advanceFallback=!!this.storm&&this.storm.status==='active'&&r.attempt.status!=='active';
  }finally{this.busy=false;}
  // Older servers still use /next, without an artificial feedback delay.
  if(advanceFallback&&!this.disposed&&this.tab==='play'&&this.viewToken===token&&this.storm?.id===sid&&this.attempt?.id===aid)await this.next();
 }
 async next(){
  if(this.busy||this.disposed)return;if(!this.storm)return this.start();
  const token=this.viewToken,sid=this.storm.id,previous=this.attempt;this.busy=true;
  try{
   const r=await post('/storm/'+sid+'/next');
   if(this.disposed||token!==this.viewToken||this.storm?.id!==sid)return;
   this.storm=r.storm;this.stormReceived=Date.now();
   if(r.attempt&&r.storm.status==='active'){
    if(previous&&previous.status!=='active'&&r.attempt.id!==previous.id)this.lastStormResult=previous;
    this.showAttempt(r.attempt);
   }else this.finishStorm();
  }finally{this.busy=false;}
 }
 tick(){
  if(!this.storm||this.disposed)return;
  const waiting=this.storm.status==='active'&&this.storm.clock_started===false;
  const remaining=Math.max(0,this.storm.remaining_ms-(waiting?0:Date.now()-this.stormReceived));
  const el=this.host.querySelector('[data-timer]');
  const delta=this.host.querySelector('[data-time-delta]');if(delta&&Date.now()-(this.stormTimeDelta?.at||0)>=2000)delta.hidden=true;
  if(el){
   el.textContent=time(remaining/1000);
   if(waiting){el.dataset.waitingLabel=t('Au premier coup');el.title=t('Le chrono démarre au premier coup.');el.setAttribute('aria-label',el.textContent+' · '+el.title);}
   else{delete el.dataset.waitingLabel;el.removeAttribute('title');el.removeAttribute('aria-label');}
  }
  if(remaining<=0||this.storm.status!=='active'){clearInterval(this.timer);if(this.expiring)return;this.expiring=true;const token=this.viewToken,sid=this.storm.id;api('/api/puzzles/storm/'+sid).then(r=>{this.expiring=false;if(this.disposed||token!==this.viewToken||this.storm?.id!==sid)return;this.storm=r.storm;this.stormReceived=Date.now();if(r.storm.status==='completed')this.finishStorm();else this.timer=setInterval(()=>this.tick(),200);}).catch(e=>{this.expiring=false;fail(e);});}}
 finishStorm(){if(!this.disposed&&this.storm)void this.openStormResults(this.storm.id,{announce:true});}
 async openStormResults(sessionId,{announce=false}={}){
  if(this.disposed)return;
  this.board?.dispose();this.board=null;clearInterval(this.timer);clearTimeout(this.poll);
  const token=++this.viewToken;this.tab='play';this.showingStormResults=true;this.reviewingStormId=null;
  if(this.resultSessionId!==sessionId)this.stormResultFilter='all';this.resultSessionId=sessionId;
  if(announce&&this.announcedStormId!==sessionId){this.announcedStormId=sessionId;playSound('complete');}
  this.shell(`<section class="panel puzzle-storm-loading" role="status">${esc(t('Chargement du bilan Storm…'))}</section>`);
  try{
   const data=await api('/api/puzzles/storm/'+encodeURIComponent(sessionId)+'/attempts');
   if(this.disposed||token!==this.viewToken||this.tab!=='play'||this.resultSessionId!==sessionId)return;
   this.stormResults=data;this.storm=data.storm;this.renderStormResults();
  }catch(error){
   if(this.disposed||token!==this.viewToken)return;
   this.shell(`<section class="panel puzzle-storm-loading"><p role="alert">${esc(error.message||String(error))}</p><div class="puzzle-actions"><button data-retry-summary>${esc(t('Réessayer'))}</button><button data-home>${esc(t('Retour aux puzzles'))}</button></div></section>`);
   this.host.querySelector('[data-retry-summary]').onclick=()=>{void this.openStormResults(sessionId);};this.host.querySelector('[data-home]').onclick=()=>this.leaveStormResults();
  }
 }
 leaveStormResults(){this.viewToken++;this.showingStormResults=false;this.reviewingStormId=null;this.attempt=null;this.storm=null;void this.load().catch(fail);}
 renderStormResults(){
  const data=this.stormResults;if(!data||this.disposed)return;
  this.shell(stormResultsHtml(data,{filter:this.stormResultFilter,name:this.stormName(data.storm)}));
  this.host.querySelectorAll('[data-storm-filter]').forEach(button=>button.onclick=()=>{this.stormResultFilter=button.dataset.stormFilter;this.renderStormResults();});
  this.host.querySelectorAll('[data-storm-review]').forEach(button=>button.onclick=()=>this.openHistory(button.dataset.stormReview,{stormResultsId:data.storm.id}).catch(fail));
  this.host.querySelectorAll('[data-storm-exercise]').forEach(button=>button.onclick=()=>this.createExercise(button.dataset.stormExercise,button).catch(fail));
  this.host.querySelector('[data-home]').onclick=()=>this.leaveStormResults();
  this.host.querySelector('[data-restart]').onclick=()=>{
   this.mode='storm';const filters=data.storm.filters;
   this.selection=filters?String(this.data.sets.find(s=>this.filterKey(s.filters)===this.filterKey(filters))?.id||'custom'):'standard';
   this.filters=filters?structuredClone(filters):{...DEFAULT_FILTERS};void this.startStorm().catch(fail);
  };
 }
 async history(){
  if(this.disposed||this.storm?.status==='active')return;
  this.board?.dispose();this.board=null;clearInterval(this.timer);this.tab='history';
  this.shell('<section class="panel"><div data-training-history-table></div></section>');
  this.historyView=new TrainingHistoryView(this.host.querySelector('[data-training-history-table]'),{tool:'puzzles',tools:['puzzles','storm'],embedded:true,onOpen:record=>this.openTrainingRecord(record)});
  await this.historyView.load();
 }
 async openTrainingRecord(record){
  if(this.disposed)return;
  if(record.tool!=='storm')return this.openHistory(record.id);
  const token=++this.viewToken,data=await api('/api/puzzles/storm/'+encodeURIComponent(record.id));
  if(this.disposed||token!==this.viewToken)return;
  if(data.storm.status==='completed')return this.openStormResults(record.id);
  this.showingStormResults=false;this.reviewingStormId=null;this.storm=data.storm;this.stormReceived=Date.now();
  if(data.attempt)this.showAttempt(data.attempt);else await this.openStormResults(record.id);
 }
 async openHistory(id,{stormResultsId=null}={}){
  clearInterval(this.timer);
  const token=++this.viewToken;let a=await api('/api/puzzles/attempts/'+id);
  if(this.disposed||token!==this.viewToken)return;
  let storm=null;
  if(a.mode==='storm'&&a.status==='active'&&a.session_id){
   const data=await api('/api/puzzles/storm/'+a.session_id);
   if(this.disposed||token!==this.viewToken)return;
   if(data.storm.status==='completed')return this.openStormResults(data.storm.id);
   storm=data.storm;
   if(data.attempt?.id===a.id)a={...a,...data.attempt};
   else if(data.attempt){a=await api('/api/puzzles/attempts/'+data.attempt.id);if(this.disposed||token!==this.viewToken)return;}
  }
  this.showingStormResults=false;this.reviewingStormId=stormResultsId;this.storm=storm;
  if(storm)this.stormReceived=Date.now();
  this.showAttempt(a);const panel=this.host.querySelector('.puzzle-attempt-panel');const list=document.createElement('div');list.className='puzzle-event-list';list.innerHTML=`<h3>${esc(t('Coups proposés'))}</h3>${a.events.map(e=>`<p class="${e.correct===0?'wrong':''}">${esc(e.hint?t('Indice'):e.san||e.move||'—')} <span>${e.correct==null?'':e.correct?'✓':'×'} · ${time(e.elapsed_ms/1000)}</span></p>`).join('')}`;panel.append(list);}
 async statistics(){this.board?.dispose();clearInterval(this.timer);const token=this.viewToken;const s=await api('/api/puzzles/statistics');if(this.disposed||token!==this.viewToken)return;this.tab='stats';const ratings=s.ratings.map(x=>x.rating_after),min=Math.min(...ratings,1000),max=Math.max(...ratings,1800);const points=ratings.map((r,i)=>`${20+i/Math.max(1,ratings.length-1)*560},${170-(r-min)/Math.max(1,max-min)*140}`).join(' ');this.shell(`<div class="puzzle-stat-grid"><section class="panel"><h2>${esc(t('Évolution de la cote'))}</h2>${ratings.length?`<svg class="puzzle-rating-chart" viewBox="0 0 600 200" role="img" aria-label="${esc(t('Évolution de la cote'))}"><path d="M20 170H580" stroke="currentColor" opacity=".2"/><polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="3"/><text x="20" y="195" fill="currentColor">${Math.round(ratings[0])}</text><text x="550" y="195" fill="currentColor">${Math.round(ratings.at(-1))}</text></svg>`:`<p>${esc(t('Aucune tentative cotée pour le moment.'))}</p>`}<details><summary>${esc(t('Voir les valeurs'))}</summary>${s.ratings.map(r=>`<p>${esc(new Date(r.started_at).toLocaleDateString(locale()))} · ${number(r.rating_after)}</p>`).join('')}</details></section><section class="panel"><h2>${esc(t('Réussite par thème'))}</h2>${s.themes.sort((a,b)=>b.attempts-a.attempts).map(r=>`<div class="puzzle-theme-row"><span>${esc(r.theme)}</span><strong>${Math.round(r.solved/r.attempts*100)}%</strong><span>${r.solved}/${r.attempts}</span><progress value="${r.solved}" max="${r.attempts}"></progress></div>`).join('')||'<p>—</p>'}</section><section class="panel"><h2>${esc(t('Activité récente'))}</h2>${s.days.map(d=>`<p class="puzzle-stat-row"><span>${esc(d.day)}</span><span>${d.solved}/${d.attempts} ${esc(t('réussis'))}</span><span>${time(d.elapsed_ms/1000)}</span></p>`).join('')||'<p>—</p>'}</section><section class="panel"><h2>${esc(t('Historique Storm'))}</h2>${s.storms.map(s=>`<p class="puzzle-stat-row"><span>${esc(new Date(s.finished_at).toLocaleDateString(locale()))} · ${esc(s.key==='standard'?t('Standard'):s.name==='Personnalisée'?t('Personnalisée'):s.name)}</span><strong>${s.score}</strong><span>${esc(t('Combo'))} ${s.best_combo}</span><button data-storm-summary="${esc(s.id)}">${esc(t('Bilan'))}</button></p>`).join('')||'<p>—</p>'}</section></div>`);this.host.querySelectorAll('[data-storm-summary]').forEach(button=>button.onclick=()=>{void this.openStormResults(button.dataset.stormSummary);});}
}
