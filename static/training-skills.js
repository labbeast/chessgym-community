import {bindTrainingTabs,setupSummaryHtml} from './exercise-tabs.js';
import {api,esc,fail,option,time,START} from './api.js';
import {pieces} from './chess-document.js';
import {t,getLanguage} from './i18n.js';
import {pieceUrl} from './appearance.js';
import {Board} from './board.js';
import {playSound} from './sound.js';
import {openTrainingHistory} from './training-history.js';
import {openTrainingSettings} from './training-settings.js';
import {nativeProgramRequest,acceptedProgramCreation} from './training-native.js';

const txt=value=>esc(t(value));
const label=(name,body)=>`<label>${txt(name)}${body}</label>`;
const select=(name,items,value)=>`<select name="${name}">${items.map(([key,text])=>option(key,t(text),value)).join('')}</select>`;
const number=(name,value,min,max)=>`<input type="number" name="${name}" value="${value}" min="${min}" max="${max}" required>`;
const modes={coordinates:'Coordonnées',notation:'Notation des coups',mixed:'Mixte',opening:'Ouvertures',positions:'Positions',endgame:'Finales',reconstruct:'Reconstituer une position'};
export function localSan(san,language=getLanguage()){
 return language==='fr'?String(san).replace(/^([KQRBN])/,(_,p)=>({K:'R',Q:'D',R:'T',B:'F',N:'C'}[p])):san;
}
export function orderedSquares(orientation='white'){
 const squares=[];
 for(let row=0;row<8;row++)for(let col=0;col<8;col++)squares.push('abcdefgh'[orientation==='black'?7-col:col]+(orientation==='black'?row+1:8-row));
 return squares;
}
export function squareGrid({orientation='white',coordinates=false,pieces={},selected='',comparison=null}={}){
 return `<div class="skill-square-grid" role="group" aria-label="${txt('Échiquier')}">${orderedSquares(orientation).map((square,index)=>{
  const col=index%8,row=Math.floor(index/8),piece=pieces[square],correct=comparison?.correct?.includes(square),wrong=comparison?.misplaced?.some(x=>x.square===square),missing=comparison?.missing?.some(x=>x.square===square);
  return `<button type="button" class="skill-square ${((square.charCodeAt(0)-97)+Number(square[1]))%2?'dark':'light'}${selected===square?' selected':''}${correct?' correct-square':''}${wrong||missing?' wrong-square':''}" data-square="${square}" aria-label="${esc(square)}">${piece?`<img src="${pieceUrl(piece)}" alt="${esc(piece)}" draggable="false">`:''}${coordinates&&col===0?`<span class="skill-rank">${square[1]}</span>`:''}${coordinates&&row===7?`<span class="skill-file">${square[0]}</span>`:''}</button>`;
 }).join('')}</div>`;
}
function moveList(moves){return (moves||[]).map(move=>`<span>${move.number}${move.color==='black'?'…':'.'} ${esc(localSan(move.san))}</span>`).join(' ');}
function metrics(values){return `<div class="skill-metrics">${values.map(([name,value])=>`<div><strong>${esc(value)}</strong><span>${txt(name)}</span></div>`).join('')}</div>`;}
const savedChoice=(value,choices,fallback)=>choices.includes(value)?value:fallback;
const savedNumber=(value,min,max,fallback)=>Number.isInteger(value)&&value>=min&&value<=max?value:fallback;
const savedBoolean=(value,fallback)=>typeof value==='boolean'?value:fallback;

export class CoordinateView {
 constructor(container,{onAnalyse,initialSettings=null,onSettingsChange=null}={}){
  const saved=initialSettings||{};
  this.container=container;this.onAnalyse=onAnalyse;this.onSettingsChange=onSettingsChange;this.config={mode:savedChoice(saved.mode,['coordinates','notation','mixed'],'coordinates'),orientation:savedChoice(saved.orientation,['white','black','random'],'white'),duration:savedChoice(saved.duration,[30,60],30),coordinates:savedBoolean(saved.coordinates,false)};this.disposed=false;this.busy=false;this.data={history:[],records:[]};
 }
 async load(){try{this.data=await api('/api/skills/coordinates/history');if(!this.disposed)this.render();}catch(e){if(!this.disposed)fail(e);}}
 dispose(){this.disposed=true;this.dialogSequence=(this.dialogSequence||0)+1;clearInterval(this.timer);this.boardLayoutCleanup?.();this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();}
 render(){
  if(this.disposed)return;
  const locked=this.session&&!this.session.finished;
  this.container.innerHTML=`<section class="training-skill-view coordinate-view"><header class="skill-header training-header"><div class="training-header-copy"><h1>${txt('Coordonnées')}</h1><span>${txt('Trouve la case le plus vite possible.')}</span></div><nav class="tabs training-tabs" aria-label="${txt('Coordonnées')}"><span class="training-tab" aria-current="page">${txt('Jouer')}</span><button type="button" data-training-history aria-haspopup="dialog" ${locked?'disabled':''}>${txt('Historique')}</button><button type="button" data-training-statistics aria-haspopup="dialog" ${locked?'disabled':''}>${txt('Statistiques')}</button><button type="button" data-training-settings aria-haspopup="dialog" ${locked?'disabled':''}>${txt('Réglages')}</button></nav></header><div class="skill-layout"><div class="skill-stage">${this.session?this.sessionHtml():this.setupHtml()}</div>${this.session?'<div class="coordinate-live-program" data-training-session-slot></div>':''}</div></section>`;
  bindTrainingTabs(this.container);
  this.container.querySelector('[data-exercise-customize]')?.addEventListener('click',()=>this.showSettings());
  this.container.querySelector('[data-training-history]')?.addEventListener('click',()=>void this.showHistory().catch(fail));
  this.container.querySelector('[data-training-statistics]')?.addEventListener('click',()=>void this.showStatistics().catch(fail));
  this.container.querySelector('[data-training-settings]')?.addEventListener('click',()=>this.showSettings());
  const form=this.container.querySelector('[data-coordinate-setup]');if(form){form.onchange=()=>{this.config=this.configFromForm(new FormData(form));this.onSettingsChange?.({...this.config});const record=form.querySelector('[data-coordinate-highscore]');if(record)record.outerHTML=this.highScoreHtml(this.config);};form.onsubmit=e=>{e.preventDefault();void this.start(new FormData(form));};}
  this.container.querySelectorAll('[data-square]').forEach(button=>button.onclick=()=>void this.answer(button.dataset.square));
  const again=this.container.querySelector('[data-coordinate-again]');if(again)again.onclick=()=>{this.session=null;this.render();};
  this.container.querySelector('[data-retry-finish]')?.addEventListener('click',()=>void this.finish());
  this.observeBoardLayout();
 }
 observeBoardLayout(){
  this.boardLayoutCleanup?.();
  const board=this.container.querySelector('.skill-coordinate-board');
  if(!board||typeof window==='undefined'||typeof ResizeObserver==='undefined')return;
  const stage=board.closest('.skill-stage'),main=this.container.closest('main')||this.container,viewport=window.visualViewport;
  let frame=0;
  const fit=()=>{
   if(this.disposed||!board.isConnected||!board.getClientRects().length)return;
   // Use the document position so scrolling cannot enlarge the board again.
   const top=board.getBoundingClientRect().top+window.scrollY;
   const hint=stage.querySelector('.skill-livehint')?.getBoundingClientRect().height||0;
   const bottom=Number.parseFloat(getComputedStyle(main).paddingBottom)||0;
   const size=Math.max(0,Math.floor((viewport?.height||window.innerHeight)-top-hint-bottom-8))+'px';
   if(stage.style.getPropertyValue('--coordinate-board-size')!==size)stage.style.setProperty('--coordinate-board-size',size);
  };
  const schedule=()=>{if(!frame)frame=requestAnimationFrame(()=>{frame=0;fit();});};
  const observer=new ResizeObserver(schedule);observer.observe(this.container);if(main!==this.container)observer.observe(main);
  window.addEventListener('resize',schedule);viewport?.addEventListener('resize',schedule);fit();
  this.boardLayoutCleanup=()=>{observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',schedule);viewport?.removeEventListener('resize',schedule);};
 }
 settingsFieldsHtml(config=this.config){return `${label('Mode',select('mode',Object.entries(modes).slice(0,3),config.mode))}${label('Orientation',select('orientation',[['white','Blancs'],['black','Noirs'],['random','Aléatoire']],config.orientation))}${label('Durée',select('duration',[[30,'30 secondes'],[60,'60 secondes']],config.duration))}<label class="skill-check"><input type="checkbox" name="coordinates" ${config.coordinates?'checked':''}>${txt('Afficher les coordonnées sur les bords')}</label><p>${txt('Bonne case : +1. En cas d’erreur, la même cible reste affichée.')}</p>`;}
 highScoreHtml(config=this.session?.config||this.config){
  const orientations=config.orientation==='random'?['white','black']:[config.orientation];
  const values=orientations.map(orientation=>{
   const record=(this.data.records||[]).find(row=>row.config.mode===config.mode&&row.config.orientation===orientation&&row.config.duration===config.duration&&row.config.coordinates===config.coordinates);
   return `<span>${orientations.length>1?txt(orientation==='black'?'Noirs':'Blancs')+' ':''}<strong data-coordinate-best="${esc(orientation)}"${record?'':` aria-label="${txt('Aucun record')}"`}>${record?esc(record.score):'—'}</strong></span>`;
  }).join('');
  return `<div class="coordinate-highscore" data-coordinate-highscore><span>${txt('Record personnel')}</span><span class="coordinate-highscore-values">${values}</span></div>`;
 }
 setupHtml(){return `<form data-coordinate-setup class="exercise-launch"><div class="coordinate-setup-options"><div class="exercise-quick-options">${label('Mode',select('mode',Object.entries(modes).slice(0,3),this.config.mode))}${label('Durée',select('duration',[[30,'30 secondes'],[60,'60 secondes']],this.config.duration))}</div><input type="hidden" name="orientation" value="${esc(this.config.orientation)}"><input hidden type="checkbox" name="coordinates" ${this.config.coordinates?'checked':''}><div class="coordinate-setup-summary">${setupSummaryHtml(t(this.config.orientation==='black'?'Noirs':this.config.orientation==='random'?'Aléatoire':'Blancs')+' · '+t(this.config.coordinates?'Coordonnées visibles':'Sans coordonnées'))}</div>${this.highScoreHtml(this.config)}<div data-training-session-slot></div></div><div class="skill-coordinate-board"><div inert aria-hidden="true">${squareGrid({orientation:this.config.orientation,coordinates:this.config.coordinates})}</div><div class="skill-coordinate-target"><button class="primary skill-coordinate-start" type="submit" data-coordinate-start>${txt('Clique pour commencer')}</button></div></div></form>`;}
 configFromForm(form){return {mode:form.get('mode'),orientation:form.get('orientation'),duration:Number(form.get('duration')),coordinates:form.has('coordinates')};}
 showSettings(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const inline=this.container.querySelector('[data-coordinate-setup]'),config=inline?this.configFromForm(new FormData(inline)):{...this.config};
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  this.settingsDialog=openTrainingSettings({host:this.container,title:t('Réglages')+' · '+t('Coordonnées'),html:this.settingsFieldsHtml(config),onSubmit:data=>{
   if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)return;
   this.config=this.configFromForm(data);this.onSettingsChange?.({...this.config});this.render();
  }});
 }
 async showStatistics(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const {openTrainingStatistics}=await import('./training-statistics.js');
  if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)return;
  const dialog=await openTrainingStatistics({host:this.container,tool:'coordinates',extraHtml:'<aside class="skill-history">'+this.historyHtml()+'</aside>'});
  if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)dialog.close();else this.statisticsDialog=dialog;
 }
 sessionHtml(){
  const session=this.session,result=session.result;
  if(session.finished){return `<div class="skill-result" role="status"><h2>${txt('Séance terminée')}</h2>${metrics([['Score',result.score??0],['Précision',(result.accuracy??0)+' %'],['Erreurs',result.errors??0],['Temps moyen',result.mean_ms==null?'—':(result.mean_ms/1000).toFixed(2)+' s']])}${this.highScoreHtml()}<button class="primary" data-coordinate-again>${txt('Nouvelle séance')}</button></div>`;}
  const target=session.target;
  return `<div class="skill-livebar"><span data-clock aria-label="${txt('Temps restant')}">${this.remaining()} s</span><strong><span data-score>${session.score}</span> ${txt('points')}</strong>${this.highScoreHtml()}</div><div class="skill-coordinate-board">${squareGrid({orientation:session.config.orientation,coordinates:session.config.coordinates})}<div class="skill-coordinate-target"><strong class="skill-target" role="status" aria-live="polite" aria-atomic="true">${esc(target.notation?localSan(target.piece+target.square):target.square)}</strong></div></div><div class="skill-livehint" aria-live="polite">${this.finishError?`<button data-retry-finish>${txt('Réessayer l’enregistrement du résultat')}</button>`:this.feedback?txt(this.feedback):txt('Clique sur la case demandée.')}</div>`;
 }
 historyHtml(){
  const records=this.data.records||[];
  const details=row=>`${t(modes[row.config.mode])} · ${t(row.config.orientation==='black'?'Noirs':'Blancs')} · ${row.config.duration} s`;
  return `<h2>${txt('Records personnels')}</h2>${records.length?`<ul class="skill-records">${records.map(row=>`<li><span>${esc(details(row))}</span><strong>${row.score}</strong></li>`).join('')}</ul>`:`<p class="muted">${txt('Termine une séance pour établir ton premier record.')}</p>`}`;
 }
 async openTrainingRecord(record){
  const generation=this.historySequence=(this.historySequence||0)+1,session=await api('/api/skills/coordinates/'+encodeURIComponent(record.id));
  if(this.disposed||generation!==this.historySequence)return;
  clearInterval(this.timer);this.session=session;this.config={...session.config};this.offset=Date.now()/1000-session.server_time;this.feedback='';this.finishError=false;this.render();
  if(!session.finished)this.timer=setInterval(()=>this.tick(),100);
 }
 async showHistory(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const dialog=await openTrainingHistory({host:this.container,tool:'coordinates',extraHtml:'<aside class="skill-history">'+this.historyHtml()+'</aside>'});if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)dialog.close();else this.historyDialog=dialog;
 }
 async start(form){
  if(this.busy)return;this.busy=true;this.historySequence=(this.historySequence||0)+1;this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const button=this.container.querySelector('[type=submit]');if(button)button.disabled=true;
  this.config=this.configFromForm(form);
  try{const session=await nativeProgramRequest(this,'coordinates',this.config,body=>api('/api/skills/coordinates',{method:'POST',body}));if(this.disposed)return;acceptedProgramCreation(this,'coordinates');this.session=session;this.offset=Date.now()/1000-session.server_time;this.feedback='';this.finishError=false;this.render();this.timer=setInterval(()=>this.tick(),100);}catch(e){if(!this.disposed){fail(e);if(button)button.disabled=false;}}finally{this.busy=false;}
 }
 remaining(){return Math.max(0,Math.ceil(this.session.deadline-(Date.now()/1000-this.offset)));}
 tick(){if(this.disposed||!this.session||this.session.finished)return;const clock=this.container.querySelector('[data-clock]');if(clock)clock.textContent=this.remaining()+' s';if(this.remaining()===0&&!this.busy)void this.finish();}
 async answer(square){
  if(this.busy||this.disposed||!this.session||this.session.finished||this.remaining()===0)return;
  this.busy=true;const previous=this.session;
  try{const session=await api(`/api/skills/coordinates/${previous.id}/answer`,{method:'POST',body:{square,index:previous.index}});if(this.disposed)return;this.session=session;this.offset=Date.now()/1000-session.server_time;
   if(!session.finished){const correct=session.score>previous.score;this.feedback=correct?'Bonne réponse':'Essaie encore';playSound(correct?'correct':'incorrect');}
   if(session.finished)await this.completed();else this.render();
  }catch(e){if(!this.disposed){try{const session=await api('/api/skills/coordinates/'+previous.id);if(this.disposed)return;this.session=session;this.offset=Date.now()/1000-session.server_time;this.feedback='Séance récupérée. Continue avec la cible affichée.';if(session.finished)await this.completed();else this.render();}catch{if(!this.disposed)fail(e);}}}finally{this.busy=false;}
 }
 async finish(){if(this.busy)return;this.busy=true;try{const session=await api(`/api/skills/coordinates/${this.session.id}/finish`,{method:'POST',body:{}});if(this.disposed)return;this.session=session;await this.completed();}catch(e){if(!this.disposed&&e.status!==409){fail(e);clearInterval(this.timer);this.finishError=true;this.render();}}finally{this.busy=false;}}
 async completed(){clearInterval(this.timer);playSound('complete');try{this.data=await api('/api/skills/coordinates/history');}finally{if(!this.disposed)this.render();}}
}

const pieceNames={K:'roi',Q:'dame',R:'tour',B:'fou',N:'cavalier',P:'pion'};
function descriptionHtml(position){
 if(!position)return '';
 const colors=['white','black'].map(color=>{
  const groups='KQRBNP'.split('').map(type=>{
   const squares=(position[color]||[]).filter(item=>item.piece.toUpperCase()===type).map(item=>item.square).sort();
   if(!squares.length)return '';
   const piece=color==='white'?type:type.toLowerCase();
   return `<li class="skill-piece-group"><img src="${pieceUrl(piece)}" alt="${txt(pieceNames[type])}" title="${txt(pieceNames[type])}" draggable="false"><span>${squares.map(esc).join(', ')}</span></li>`;
  }).join('');
  return `<section class="skill-piece-color" data-piece-color="${color}"><h3>${txt(color==='white'?'Blancs':'Noirs')}</h3><ul>${groups}</ul></section>`;
 }).join('');
 return `<div class="skill-description"><div class="skill-piece-colors">${colors}</div><p>${txt(position.turn==='white'?'Trait aux blancs':'Trait aux noirs')}</p>${position.castling!=='-'?`<p>${txt('Droits de roque')} : ${esc(position.castling)}</p>`:''}${position.en_passant?`<p>${txt('Prise en passant')} : ${esc(position.en_passant)}</p>`:''}</div>`;
}
export class BlindfoldView {
 constructor(container,{onAnalyse,initialSettings=null,onSettingsChange=null}={}){
  const saved=initialSettings||{};
  this.container=container;this.onAnalyse=onAnalyse;this.onSettingsChange=onSettingsChange;this.config={mode:savedChoice(saved.mode==='endgame'?'positions':saved.mode,['opening','positions','reconstruct'],'opening'),rated:savedBoolean(saved.rated,true),rating_min:savedNumber(saved.rating_min,0,4000,1000),rating_max:savedNumber(saved.rating_max,0,4000,2000),max_moves:savedNumber(saved.max_moves,1,200,10),max_pieces:savedNumber(saved.max_pieces,2,32,7),input:savedChoice(saved.input,['board','text'],'board'),hide_prompt:savedBoolean(saved.hide_prompt,true),reconstruct_after:savedBoolean(saved.reconstruct_after,true),whole_game:savedBoolean(saved.whole_game,false)};
  if(this.config.rating_min>this.config.rating_max){this.config.rating_min=1000;this.config.rating_max=2000;}
  const entryId=savedNumber(saved.entry_id,1,Number.MAX_SAFE_INTEGER,null);if(entryId)this.config.entry_id=entryId;this.baseId=savedNumber(saved.base_id,1,Number.MAX_SAFE_INTEGER,null);
  this.disposed=false;this.busy=false;this.data={history:[]};this.bases=[];this.entries=[];this.entryOffset=0;this.entryTotal=0;this.placed={};this.selectedPiece='P';this.selectedSquare='';this.answerIndex=0;
 }
 async load(){try{const [history,bases,overview]=await Promise.all([api('/api/skills/blindfold/history'),api('/api/skills/blindfold/bases'),api('/api/skills/blindfold/overview')]);if(this.disposed)return;this.data={...history,profiles:overview.profiles};this.bases=this.programBaseId?bases.bases.filter(base=>Number(base.id)===this.programBaseId):bases.bases;if(overview.active_session){this.adoptSession(overview.active_session);for(const key of Object.keys(this.config))if(Object.hasOwn(this.session.config,key))this.config[key]=this.session.config[key];if(this.session.config.entry_id)this.config.entry_id=this.session.config.entry_id;if(this.config.mode==='endgame')this.config.mode='positions';this.config.rated=this.session.config.rated===true;this.orientation=this.session.color||'white';}if(!this.bases.some(base=>base.id===this.baseId))this.baseId=this.bases[0]?.id;this.render();if(this.baseId)await this.loadEntries({aroundId:this.config.entry_id});}catch(e){if(!this.disposed)fail(e);}}
 dispose(){this.disposed=true;clearInterval(this.preparationTimer);this.entrySequence=(this.entrySequence||0)+1;this.dialogSequence=(this.dialogSequence||0)+1;this.board?.dispose();this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();}
 render(){
  if(this.disposed)return;this.board?.dispose();this.board=null;
  const locked=this.session&&!this.session.finished;
  this.container.innerHTML=`<section class="training-skill-view"><header class="skill-header training-header"><div class="training-header-copy"><h1>${txt('Puzzles à l’aveugle')}</h1><span>${txt('Visualise la position, puis vérifie ton calcul.')}</span></div><nav class="tabs training-tabs" aria-label="${txt('Puzzles à l’aveugle')}"><span class="training-tab" aria-current="page">${txt('Jouer')}</span><button type="button" data-training-history aria-haspopup="dialog">${txt('Historique')}</button><button type="button" data-training-statistics aria-haspopup="dialog" ${locked?'disabled':''}>${txt('Statistiques')}</button><button type="button" data-training-settings aria-haspopup="dialog" ${locked?'disabled':''}>${txt('Réglages')}</button></nav></header><div class="skill-layout skill-layout-single"><div class="skill-stage">${this.session?this.sessionHtml():this.setupHtml()}</div></div></section>`;
  this.syncPreparationClock();
  bindTrainingTabs(this.container);
  this.container.querySelector('[data-exercise-customize]')?.addEventListener('click',()=>this.showSettings());
  this.container.querySelector('[data-training-history]')?.addEventListener('click',()=>void this.showHistory().catch(fail));
  this.container.querySelector('[data-training-statistics]')?.addEventListener('click',()=>void this.showStatistics().catch(fail));
  this.container.querySelector('[data-training-settings]')?.addEventListener('click',()=>this.showSettings());
  const form=this.container.querySelector('[data-blind-setup]');if(form){
   form.onsubmit=e=>{e.preventDefault();void this.start();};
   const base=form.querySelector('[data-base]');if(base)base.onchange=()=>{this.baseId=Number(base.value);this.entryOffset=0;void this.loadEntries();};
   const search=form.querySelector('[data-entry-search]');if(search)search.onclick=()=>{this.entryOffset=0;void this.loadEntries();};
   form.querySelectorAll('[data-entry-page]').forEach(button=>button.onclick=()=>{this.entryOffset=Math.max(0,this.entryOffset+Number(button.dataset.entryPage)*50);void this.loadEntries();});
  }
  this.container.querySelector('[data-start-custom]')?.addEventListener('click',()=>void this.start());
  this.container.querySelectorAll('[data-rated-puzzle]').forEach(button=>button.onclick=()=>void this.start({mode:button.dataset.ratedPuzzle,rated:true,hide_prompt:true}));
  this.container.querySelector('[data-custom-set]')?.addEventListener('change',event=>{
   if(this.busy)return;this.captureConfig(form);this.entrySearch=form?.elements.entry_search?.value??this.entrySearch;
   const mode=event.target.value;this.config.rated=!mode;this.config.mode=mode||(this.config.mode==='reconstruct'?'opening':this.config.mode);this.render();
  });
  this.container.querySelector('[data-ready]')?.addEventListener('click',()=>void this.ready());
  this.container.querySelector('[data-reveal]')?.addEventListener('click',()=>void this.reveal());
  this.container.querySelector('[data-new]')?.addEventListener('click',()=>void this.newExercise());
  this.container.querySelector('[data-verify]')?.addEventListener('click',()=>void this.verify());
  this.container.querySelector('[data-start-position]')?.addEventListener('click',()=>this.resetReconstruction(true));
  this.container.querySelector('[data-clear]')?.addEventListener('click',()=>this.resetReconstruction());
  this.container.querySelector('[data-flip]')?.addEventListener('click',()=>{this.orientation=this.orientation==='black'?'white':'black';this.render();});
  this.container.querySelector('[data-cancel-square]')?.addEventListener('click',()=>{this.selectedSquare='';this.render();});
  this.container.querySelectorAll('[data-piece]').forEach(button=>button.onclick=()=>{this.selectedPiece=button.dataset.piece;this.render();});
  this.container.querySelectorAll('[data-square]').forEach(button=>button.onclick=()=>this.square(button.dataset.square));
  const answer=this.container.querySelector('[data-blind-answer]');if(answer)answer.onsubmit=e=>{e.preventDefault();void this.answer(new FormData(answer).get('move'));};
  this.container.querySelector('[data-analyse]')?.addEventListener('click',()=>this.onAnalyse?.({doc:this.session.document,path:this.board?.path||''}));
  this.container.querySelectorAll('[data-history]').forEach(button=>button.onclick=()=>void this.openHistory(button.dataset.history));
  const board=this.container.querySelector('[data-result-board]');if(board&&this.session?.document){
   const doc=this.session.document,path=this.session.config.mode==='reconstruct'||this.session.result?.reconstruction_success!=null?doc.nodes.at(-1)?.path||'':'';
   this.board=new Board(board,{doc,path,flipped:this.orientation==='black',onChange:()=>this.renderMoveCursor()});
   this.container.querySelectorAll('[data-move-path]').forEach(button=>button.onclick=()=>void this.board.go(button.dataset.movePath));
   this.renderMoveCursor();
  }
 }
 captureConfig(form,config=this.config){if(!form)return;const data=new FormData(form);for(const key of ['mode','input'])if(data.has(key))config[key]=data.get(key);for(const key of ['rating_min','rating_max','max_moves','max_pieces'])if(data.has(key))config[key]=Number(data.get(key));for(const key of ['rated','hide_prompt','reconstruct_after','whole_game'])if(form.elements[key])config[key]=data.has(key);if(data.has('entry_id'))config.entry_id=Number(data.get('entry_id'))||null;if(config.rated&&config.mode!=='reconstruct')config.hide_prompt=true;}
 profilesHtml(){
  return `<dl class="blindfold-profiles">${['opening','positions'].map(mode=>{const p=this.data.profiles?.[mode]||{rating:500,rated_count:0,provisional:true};return `<div data-blindfold-profile="${mode}"><dt>${txt(modes[mode])}</dt><dd>${Math.round(p.rating)}</dd><small>${esc(p.provisional?t('Cote provisoire · {count} exercices classés',{count:p.rated_count}):t('{count} exercices classés',{count:p.rated_count}))}</small><button type="button" class="primary" data-rated-puzzle="${mode}" aria-label="${esc(t('Commencer · {mode}',{mode:t(modes[mode])}))}">${txt('Commencer')}</button></div>`;}).join('')}</dl>`;
 }
 targetHtml(config){
  const p=this.data.profiles?.[config.mode],target=p?.targets||{moves:5,pieces:3,moves_min:3,moves_max:7,pieces_min:3,pieces_max:4};
  return `<div class="blindfold-target" data-blindfold-target><strong>${esc(config.mode==='opening'?t('Environ {count} coups complets',{count:target.moves}):t('Environ {count} pièces',{count:target.pieces}))}</strong><span>${esc(config.mode==='opening'?t('Sélection : {min}–{max} coups',{min:target.moves_min,max:target.moves_max}):t('Sélection : {min}–{max} pièces',{min:target.pieces_min,max:target.pieces_max}))}</span><p>${txt('La charge de visualisation suit ta cote. Les rois et les pions comptent comme pièces.')}</p><p>${txt('Seule la résolution sans erreur compte pour le classement. La reconstruction est une statistique secondaire, sans effet sur la cote. Une erreur, une révélation ou un abandon avant la fin de la solution peut faire baisser la cote.')}</p></div>`;
 }
 settingsFieldsHtml(state=this,{custom=false}={}){
  const config=state.config,reconstruct=config.mode==='reconstruct';
  const modeOptions=[['opening','Ouvertures'],['positions','Positions'],['reconstruct','Reconstituer une position']];
  const exercise=custom?'':label('Exercice',select('mode',modeOptions,config.mode));
  if(!reconstruct)return `${exercise}${custom?'':`<label class="skill-check"><input type="checkbox" name="rated" ${config.rated?'checked':''}>${txt('Exercice classé')}</label>`}${config.rated?this.targetHtml(config):`<div class="skill-field-row">${label('Cote minimale',number('rating_min',config.rating_min,0,4000))}${label('Cote maximale',number('rating_max',config.rating_max,0,4000))}</div>${config.mode==='opening'?label('Nombre maximal de coups joués',number('max_moves',config.max_moves,1,200)):label('Nombre maximal de pièces',number('max_pieces',config.max_pieces,2,32))}<label class="skill-check"><input type="checkbox" name="hide_prompt" ${config.hide_prompt?'checked':''}>${txt('Masquer la description lorsque je suis prêt')}</label>`}<label class="skill-check"><input type="checkbox" name="reconstruct_after" ${config.reconstruct_after?'checked':''}>${txt('Reconstituer aussi la position finale')}</label>${label('Répondre',select('input',[['board','Échiquier vide'],['text','Notation au clavier, sans échiquier']],config.input))}<p>${txt('La banque de puzzles Lichess doit être importée dans Puzzles.')}</p>`;
  return `${exercise}${label('Base',`<select data-base>${state.bases.map(base=>option(base.id,base.name,state.baseId)).join('')}</select>`)}<div class="skill-entry-search"><input name="entry_search" placeholder="${txt('Rechercher une partie')}" value="${esc(state.entrySearch||'')}"><button type="button" data-entry-search>${txt('Rechercher')}</button></div>${label('Partie',`<select name="entry_id" data-entry-select>${state.entries.map(entry=>option(entry.id,entry.title,config.entry_id)).join('')}</select>`)}<div class="skill-entry-paging"><button type="button" data-entry-page="-1" ${state.entryOffset===0?'disabled':''}>‹</button><span data-entry-count>${state.entryTotal?`${state.entryOffset+1}–${Math.min(state.entryOffset+50,state.entryTotal)} / ${state.entryTotal}`:txt('Aucune partie')}</span><button type="button" data-entry-page="1" ${state.entryOffset+50>=state.entryTotal?'disabled':''}>›</button></div>${label('Premiers X coups',number('max_moves',config.max_moves,1,200))}<label class="skill-check"><input type="checkbox" name="whole_game" ${config.whole_game?'checked':''}>${txt('Toute la partie')}</label><p>${txt('Un coup comprend le coup des blancs et la réponse des noirs. Les variantes sont ignorées.')}</p>`;
 }
 setupHtml(){
  if(this.trainingRun)return `<div class="exercise-launch"><h2>${esc(this.trainingRun.block?.title||t('Bloc d’entraînement'))}</h2>${setupSummaryHtml(t(modes[this.config.mode])+' · '+t(this.config.rated?'Exercice classé':'Non coté'))}<button class="primary" type="button" data-start-custom ${this.config.mode==='reconstruct'&&!this.entries.length?'disabled':''}>${txt('Commencer')}</button></div>`;
  const custom=this.config.mode==='reconstruct'||!this.config.rated;
  return `<div class="exercise-launch">${this.profilesHtml()}${custom?`<div><h2>${txt('Sélection personnalisée')}</h2>${setupSummaryHtml(t(modes[this.config.mode])+' · '+t('Non coté'))}<button class="primary" type="button" data-start-custom ${this.config.mode==='reconstruct'&&!this.entries.length?'disabled':''}>${txt('Commencer')}</button></div>`:`${setupSummaryHtml(t('Difficulté adaptée à ta cote'))}`}</div>`;
 }

 showSettings(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const draft={config:{...this.config},bases:this.bases,baseId:this.baseId,entries:[...this.entries],entryOffset:this.entryOffset,entryTotal:this.entryTotal,entrySearch:this.entrySearch||''};
  const inline=this.container.querySelector('[data-blind-setup]');if(inline){this.captureConfig(inline,draft.config);draft.entrySearch=inline.elements.entry_search?.value??draft.entrySearch;}
  let dialog,requestSequence=0,loading=false;
  const current=()=>!this.disposed&&sequence===this.dialogSequence&&dialog?.open&&!this.busy&&(!this.session||this.session.finished);
  const redraw=()=>{if(!current())return;dialog.querySelector('[data-training-settings-fields]').innerHTML=this.settingsFieldsHtml(draft);bind(dialog.querySelector('form'));};
  const load=async()=>{
   const request=++requestSequence,baseId=draft.baseId,offset=draft.entryOffset;if(!baseId)return;
   const form=dialog.querySelector('form');this.captureConfig(form,draft.config);draft.entrySearch=form.elements.entry_search?.value??draft.entrySearch;
   loading=true;dialog.querySelector('[type=submit]').disabled=true;form.querySelector('[data-entry-select]')?.setAttribute('disabled','');
   try{
    const data=await api(`/api/bases/${baseId}/entries?limit=50&offset=${offset}&search=${encodeURIComponent(draft.entrySearch)}`);
    if(!current()||request!==requestSequence)return;
    this.captureConfig(dialog.querySelector('form'),draft.config);draft.entries=data.entries;draft.entryTotal=data.total;
    if(!draft.entries.some(entry=>entry.id===draft.config.entry_id))draft.config.entry_id=draft.entries[0]?.id||null;
    loading=false;redraw();
   }catch(error){if(current()&&request===requestSequence){loading=false;draft.entries=[];draft.entryTotal=0;draft.config.entry_id=null;redraw();fail(error);}}
   finally{if(current()&&request===requestSequence)dialog.querySelector('[type=submit]').disabled=false;}
  };
  const bind=form=>{
   form.elements.mode.onchange=()=>{this.captureConfig(form,draft.config);requestSequence++;loading=false;dialog.querySelector('[type=submit]').disabled=false;redraw();if(draft.config.mode==='reconstruct'&&draft.baseId&&!draft.entries.length)void load();};
   if(form.elements.rated)form.elements.rated.onchange=()=>{this.captureConfig(form,draft.config);redraw();};
   const base=form.querySelector('[data-base]');if(base)base.onchange=()=>{draft.baseId=Number(base.value);draft.entryOffset=0;void load();};
   form.querySelector('[data-entry-search]')?.addEventListener('click',()=>{draft.entryOffset=0;void load();});
   form.querySelectorAll('[data-entry-page]').forEach(button=>button.onclick=()=>{draft.entryOffset=Math.max(0,draft.entryOffset+Number(button.dataset.entryPage)*50);void load();});
  };
  this.settingsDialog=openTrainingSettings({host:this.container,title:t('Réglages')+' · '+t('Puzzles à l’aveugle'),html:this.settingsFieldsHtml(draft),onReady:(form,node)=>{dialog=node;bind(form);},onSubmit:(data,form)=>{
   if(!current())return;if(loading)return false;
   this.captureConfig(form,draft.config);if(draft.config.mode!=='reconstruct'&&draft.config.rating_min>draft.config.rating_max)throw new Error(t('La cote minimale doit être inférieure ou égale à la cote maximale.'));
   this.config={...draft.config};this.baseId=draft.baseId;this.entries=draft.entries;this.entryOffset=draft.entryOffset;this.entryTotal=draft.entryTotal;this.entrySearch=form.elements.entry_search?.value??draft.entrySearch;
   this.entrySequence=(this.entrySequence||0)+1;this.onSettingsChange?.({...this.config,base_id:this.baseId??null});this.render();
  }});
 }
 async showStatistics(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const {openTrainingStatistics}=await import('./training-statistics.js');
  if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)return;
  const dialog=await openTrainingStatistics({host:this.container,tool:'blindfold'});
  if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)dialog.close();else this.statisticsDialog=dialog;
 }
 async loadEntries({aroundId=null}={}){
  const sequence=this.entrySequence=(this.entrySequence||0)+1;
  if(!this.baseId)return;const baseId=this.baseId,offset=this.entryOffset;this.entrySearch=this.container.querySelector('[name=entry_search]')?.value??this.entrySearch??'';
  const current=()=>!this.disposed&&sequence===this.entrySequence&&baseId===this.baseId&&offset===this.entryOffset;
  try{const data=await api(`/api/bases/${baseId}/entries?limit=50&offset=${offset}&search=${encodeURIComponent(this.entrySearch)}${aroundId?'&around_id='+encodeURIComponent(aroundId):''}`);if(!current())return;const form=!this.session?this.container.querySelector('[data-blind-setup]'):null;if(form)this.captureConfig(form);this.entries=data.entries;this.entryTotal=data.total;if(aroundId&&Number.isInteger(data.offset))this.entryOffset=data.offset;if(aroundId&&this.entries.some(entry=>entry.id===aroundId))this.config.entry_id=aroundId;else if(!this.entries.some(entry=>entry.id===this.config.entry_id))this.config.entry_id=this.entries[0]?.id||null;if(!this.session&&!this.settingsDialog?.open)this.render();}catch(e){if(current())fail(e);}
 }
 async showHistory(){
  if(this.disposed||this.busy)return;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const dialog=await openTrainingHistory({host:this.container,tool:'blindfold',onOpen:!this.session||this.session.finished?record=>this.openHistory(record.id):null});
  if(this.disposed||sequence!==this.dialogSequence)dialog.close();else this.historyDialog=dialog;
 }
 promptHtml(){
  const prompt=this.session.prompt;if(!prompt||(this.session.phase==='reconstruct'&&this.session.config.mode!=='reconstruct'))return '';
  return `<div class="skill-prompt">${prompt.initial_position?`<h3>${txt('Position de départ personnalisée')}</h3>${descriptionHtml(prompt.initial_position)}`:''}${prompt.position?descriptionHtml(prompt.position):''}${prompt.moves?`<div class="skill-move-list">${moveList(prompt.moves)}</div>`:''}</div>`;
 }
 sessionHtml(){
  const session=this.session,reconstruct=this.isReconstruction();
  if(session.finished)return this.resultHtml();
  return `<div class="skill-session-title"><strong>${txt(modes[session.config.mode])}</strong><span>${esc(session.title||session.puzzle_id||'')}${session.rating?' · Lichess '+session.rating:''}${session.challenge?' · Blindfold '+Math.round(session.challenge.exercise_rating):''}</span></div>${session.rated?`<p class="blindfold-rated-note">${txt(session.rating_eligible===false?'Puzzle déjà commencé : cette répétition ne change pas la cote.':'Classé : seule la résolution sans erreur compte. La reconstruction ne change pas la cote.')}</p>`:''}${this.preparationHtml()}${this.promptHtml()}${!session.started?`<p>${txt('Visualise la position avant de commencer.')}</p><button class="primary" data-ready>${txt(reconstruct?'Reconstituer la position':'Je suis prêt')}</button>`:reconstruct?(session.config.mode!=='reconstruct'?this.reconstructionPromptHtml():'')+this.editorHtml():this.solveHtml()}<div class="skill-actions"><button data-reveal>${txt(reconstruct&&session.config.mode!=='reconstruct'&&session.started?'Passer la reconstruction':'Révéler et terminer')}</button><button data-new>${txt('Nouvel exercice')}</button></div>`;
 }
 preparationElapsed(){
  const session=this.session;
  if(!Number.isFinite(session?.preparation_ms))return null;
  const running=!session.started&&!session.finished;
  return Math.max(0,session.preparation_ms+(running&&this.preparationReceivedAt!=null?performance.now()-this.preparationReceivedAt:0));
 }
 preparationHtml(){
  const elapsed=this.preparationElapsed();
  return elapsed==null?'':`<div class="blindfold-preparation"><span>${txt('Temps de visualisation')}</span><strong data-preparation-clock>${time(Math.floor(elapsed/1000))}</strong></div>`;
 }
 syncPreparationClock(){
  clearInterval(this.preparationTimer);this.preparationTimer=null;
  if(this.disposed||!this.session||this.session.started||this.session.finished||this.preparationElapsed()==null)return;
  this.preparationTimer=setInterval(()=>{
   const clock=this.container.querySelector('[data-preparation-clock]');
   if(clock)clock.textContent=time(Math.floor(this.preparationElapsed()/1000));
  },250);
 }
 solveHtml(){
  const session=this.session,text=session.config.input==='text';
  return `<div class="skill-solve-status" role="status">${this.feedback?txt(this.feedback):txt('À toi de jouer.')} <span>${session.errors} ${txt('erreurs')}</span></div>${session.played?.length?`<div class="skill-move-list skill-played">${moveList(session.played)}</div>`:''}${text?`<form data-blind-answer class="skill-answer-form"><label>${txt('Ton coup')}<input name="move" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${getLanguage()==='fr'?'Cf3 ou g1f3':txt('Nf3 ou g1f3')}" required maxlength="30"></label><button class="primary" type="submit">${txt('Jouer')}</button></form>`:`${squareGrid({orientation:this.orientation,coordinates:true,selected:this.selectedSquare})}<div class="skill-board-tools"><span>${this.selectedSquare?esc(this.selectedSquare)+' → ?':txt('Choisis la case de départ, puis la case d’arrivée.')}</span><button data-cancel-square ${!this.selectedSquare?'disabled':''}>${txt('Annuler')}</button><button data-flip title="${txt('Retourner l’échiquier')}">⇅</button>${label('Promotion',select('promotion',[['q','Dame'],['r','Tour'],['b','Fou'],['n','Cavalier']],'q'))}</div>`}`;
 }
 isReconstruction(){return this.session?.config.mode==='reconstruct'||this.session?.phase==='reconstruct';}
 adoptSession(session){
  const previous=this.session;
  if(session.phase==='reconstruct'&&(previous?.id!==session.id||previous?.phase!=='reconstruct')){this.placed={};this.selectedSquare='';this.selectedPiece='P';}
  this.session=session;this.preparationReceivedAt=performance.now();this.answerIndex=session.answer_index??this.answerIndex;
 }
 reconstructionPromptHtml(){return `<div class="skill-reconstruction-prompt" role="status"><strong>${txt('Étape 2 · Reconstitue la position finale')}</strong><p>${txt('La suite de coups est terminée. Replace toutes les pièces de mémoire, puis vérifie ta position.')}</p><p>${txt('Statistique secondaire : cette étape ne change ni la réussite du puzzle ni la cote.')}</p></div>`;}
 resetReconstruction(initial=false){
  if(this.busy||this.disposed||!this.session?.started||this.session.finished||!this.isReconstruction())return;
  this.placed=initial?pieces(START):{};this.selectedSquare='';this.selectedPiece='P';this.render();
 }
 editorHtml(){return `<div class="skill-palette" aria-label="${txt('Choisir une pièce')}">${'KQRBNPkqrbnp'.split('').map(piece=>`<button data-piece="${piece}" class="${this.selectedPiece===piece?'active':''}" title="${esc(piece)}"><img src="${pieceUrl(piece)}" alt="${esc(piece)}"></button>`).join('')}<button data-piece="" class="${this.selectedPiece===''?'active':''}" title="${txt('Effacer')}">×</button></div>${squareGrid({orientation:this.orientation,coordinates:true,pieces:this.placed})}<div class="skill-board-tools"><button type="button" data-start-position title="${txt('Position initiale standard')}">${txt('Position départ')}</button><button type="button" data-clear>${txt('Vider')}</button><button data-flip title="${txt('Retourner l’échiquier')}">⇅</button><button class="primary" data-verify>${txt('Vérifier ma position')}</button></div>`;}
 resultHtml(){
  const session=this.session,result=session.result||{},reconstruct=session.config.mode==='reconstruct'||result.reconstruction_success!=null,twoStages=session.config.mode!=='reconstruct'&&result.reconstruction_success!=null;
  const pieceDescription=item=>`${txt(item.piece===item.piece.toUpperCase()?'Blancs':'Noirs')} · ${txt(pieceNames[item.piece.toUpperCase()])} ${esc(item.square)}`;
  const comparison=reconstruct&&Array.isArray(result.correct)?`<div class="skill-comparison"><h3>${txt('Ta proposition')}</h3>${squareGrid({orientation:this.orientation,coordinates:true,pieces:result.proposed,comparison:result})}<p>${txt('Cases correctes')} : ${result.correct.length} · ${txt('Pièces manquantes')} : ${result.missing.length} · ${txt('Pièces mal placées')} : ${result.misplaced.length}</p>${result.missing.length?`<p>${txt('Pièces manquantes')} : ${result.missing.map(pieceDescription).join(', ')}</p>`:''}${result.misplaced.length?`<p>${txt('Pièces mal placées')} : ${result.misplaced.map(pieceDescription).join(', ')}</p>`:''}</div>`:'';
  const stages=twoStages?`<div class="skill-stage-outcomes"><div class="${result.solve_success?'success':'incorrect'}"><strong aria-label="${txt(result.solve_success?'Calcul réussi':'Calcul avec erreurs')}"><span aria-hidden="true">${result.solve_success?'✓':'×'}</span> ${txt('Calcul')}</strong><small>${result.solve_errors||0} ${txt('erreurs')} · ${time((result.solve_elapsed_ms||0)/1000)}</small></div><div class="${result.reconstruction_skipped?'':result.reconstruction_success?'success':'incorrect'}"><strong aria-label="${txt(result.reconstruction_success?'Position finale exacte':'Position finale non validée')}"><span aria-hidden="true">${result.reconstruction_skipped?'—':result.reconstruction_success?'✓':'×'}</span> ${txt('Position finale · statistique secondaire')}</strong><small>${result.reconstruction_skipped?txt('Non effectuée'):result.accuracy==null?txt('Non vérifiée'):result.accuracy+' %'} · ${time((result.reconstruction_elapsed_ms||0)/1000)}</small></div></div>`:'';
  const rating=result.rated?`<div class="blindfold-rating-result" data-blindfold-rating-result role="status"><strong>${esc(t('Cote Blindfold : {before} → {after}',{before:Math.round(result.rating_before),after:Math.round(result.rating_after)}))}</strong><span>${result.rating_delta>0?'+':''}${esc(result.rating_delta)}</span><small>${txt(result.rating_success?'Solution sans erreur.':'Aucun point gagné : une solution complète sans erreur est requise.')}</small></div>`:session.rated?`<p class="blindfold-rated-note">${txt('Aucun changement de cote.')}</p>`:'';
  const total=result.total_elapsed_ms??(session.started===false?Math.max(result.elapsed_ms||0,result.preparation_ms||0):(result.elapsed_ms||0)+(result.preparation_ms||0));
  const preparation=Number.isFinite(result.preparation_ms)?`<div class="blindfold-preparation"><span>${txt('Temps de visualisation')}</span><strong data-preparation-time>${time(result.preparation_ms/1000)}</strong></div>`:'';
  return `<div class="skill-result-banner ${result.success?'success':''}" role="status"><strong>${txt(result.success?'Exercice réussi':result.revealed&&!twoStages?'Solution révélée':'Exercice terminé')}</strong><span>${txt('Temps total')} : <span data-total-time>${time(total/1000)}</span>${!twoStages?(reconstruct&&result.accuracy!=null?' · '+result.accuracy+' %':' · '+(result.errors||0)+' '+t('erreurs')):''}</span></div>${preparation}${rating}${stages}${comparison}${reconstruct?`<h3 class="skill-target-position">${txt('Position attendue')}</h3>`:''}<div data-result-board></div><div class="skill-move-list skill-result-moves">${session.document?.nodes.filter(node=>node.san).map(node=>`<button data-move-path="${esc(node.path)}">${esc(localSan(node.san))}</button>`).join('')||''}</div>${session.attempts?.length?`<details><summary>${txt('Mes réponses')}</summary><ol class="skill-attempt-list">${session.attempts.map(attempt=>`<li class="${attempt.correct?'':'incorrect'}">${esc(attempt.move)} ${attempt.correct?'✓':'×'}</li>`).join('')}</ol></details>`:''}<div class="skill-actions"><button class="primary" data-new>${txt('Nouvel exercice')}</button>${this.onAnalyse?`<button data-analyse>${txt('Ouvrir dans l’analyse')}</button>`:''}</div>`;
 }
 renderMoveCursor(){this.container.querySelectorAll('[data-move-path]').forEach(button=>button.classList.toggle('active',button.dataset.movePath===this.board?.path));}
 async start(overrides={}){
  this.historySequence=(this.historySequence||0)+1;
  if(this.busy||this.disposed)return;this.busy=true;
  const controls=[...this.container.querySelectorAll('[data-rated-puzzle], [data-custom-set], [data-blind-setup] [type=submit]')];controls.forEach(control=>control.disabled=true);
  this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const current=this.container.querySelector('[data-blind-setup]');if(current)this.captureConfig(current);
  Object.assign(this.config,overrides);
  const payload={...this.config,language:getLanguage()};
  // Loading the reconstruction picker may remember an entry even while a
  // Lichess mode is selected. It must not become that puzzle's source base.
  if(payload.mode!=='reconstruct'){delete payload.entry_id;delete payload.whole_game;}
  try{const session=await nativeProgramRequest(this,'blindfold',payload,body=>api('/api/skills/blindfold',{method:'POST',body}));if(this.disposed)return;acceptedProgramCreation(this,'blindfold');this.adoptSession(session);this.placed={};this.selectedSquare='';this.answerIndex=0;this.orientation=session.color||'white';this.feedback='';this.render();}catch(e){if(!this.disposed){fail(e);this.render();}}finally{this.busy=false;}
 }
 async ready(){await this.action('ready');}
 async newExercise(){
  if(this.busy)return;this.busy=true;
  try{if(this.session&&!this.session.finished){await api(`/api/skills/blindfold/${this.session.id}/abandon`,{method:'POST',body:{}});if(this.disposed)return;this.data=await api('/api/skills/blindfold/history');}if(this.disposed)return;this.session=null;this.selectedSquare='';this.render();}catch(error){if(!this.disposed)fail(error);}finally{this.busy=false;}
 }
 async reveal(){await this.action('reveal');}
 async action(name,body){
  if(this.busy||!this.session)return;this.busy=true;
  try{const session=await api(`/api/skills/blindfold/${this.session.id}/${name}`,{method:'POST',body:body||{}});if(this.disposed)return;this.adoptSession(session);if(session.finished){playSound(session.result?.success?'complete':'incorrect');this.data=await api('/api/skills/blindfold/history');}this.render();}catch(e){if(!this.disposed)fail(e);}finally{this.busy=false;}
 }
 square(square){
  if(this.busy||this.session?.finished||!this.session?.started)return;
  if(this.isReconstruction()){
   if(this.selectedPiece)this.placed[square]=this.selectedPiece;else delete this.placed[square];this.render();return;
  }
  if(!this.selectedSquare){this.selectedSquare=square;this.render();return;}
  if(this.selectedSquare===square){this.selectedSquare='';this.render();return;}
  const from=this.selectedSquare,promotion=this.container.querySelector('[name=promotion]')?.value||'q';
  this.selectedSquare='';
  // The server knows whether a promotion is required. Sending an explicit
  // choice is harmless for any other piece and reveals no pawn locations.
  void this.answer(from+square,promotion);
 }
 async answer(move,promotion){
  if(this.busy||!move||this.isReconstruction()||this.session?.finished)return;this.busy=true;
  try{const body={move,index:this.answerIndex,language:getLanguage()};if(promotion)body.move=move+'='+promotion;
   const session=await api(`/api/skills/blindfold/${this.session.id}/answer`,{method:'POST',body});if(this.disposed)return;this.adoptSession(session);this.feedback=session.correct?'Bonne réponse':'Ce coup n’est pas la solution.';playSound(session.correct?'correct':'incorrect');
   if(session.finished){if(session.result.success)playSound('complete');this.data=await api('/api/skills/blindfold/history');}this.render();this.container.querySelector('[name=move]')?.focus();
  }catch(e){if(!this.disposed){try{const session=await api('/api/skills/blindfold/'+this.session.id);if(this.disposed)return;this.adoptSession(session);this.feedback='Séance récupérée. Continue depuis la position actuelle.';this.render();}catch{if(!this.disposed)fail(e);}}}finally{this.busy=false;}
 }
 async verify(){if(!this.isReconstruction()||!this.session?.started||this.session.finished)return;await this.action('position',{pieces:{...this.placed}});}
 async openTrainingRecord(record){return this.openHistory(record.id);}
 async openHistory(id){if(this.busy||this.disposed)return;const generation=this.historySequence=(this.historySequence||0)+1;try{const session=await api('/api/skills/blindfold/'+encodeURIComponent(id));if(!this.disposed&&generation===this.historySequence){this.adoptSession(session);this.orientation=session.color||'white';this.render();}}catch(e){if(!this.disposed&&generation===this.historySequence)fail(e);}}
}
