import {GamePicker} from './game-picker.js';
import {associatedGuessBases,guessDashboardHtml} from './guess-bases.js';
import {CollectionList} from './list-view.js';
import {bindTrainingTabs,setupSummaryHtml} from './exercise-tabs.js';
import {t,ui} from './i18n.js';
import {api,esc,fail,option} from './api.js';
import {Board} from './board.js';
import {guessGameDetailsHtml,guessPlayerBandHtml} from './guess-game-info.js';
import {serialize,appendLine} from './chess-document.js';
import {renderAnalysisMovesInto} from './analysis-moves.js';
import {playSound} from './sound.js';
import {TrainingHistoryView,openTrainingHistory} from './training-history.js';
import {openTrainingStatistics} from './training-statistics.js';
import {openTrainingSettings} from './training-settings.js';
import {nativeProgramRequest,acceptedProgramCreation} from './training-native.js';

const endpoint='/api/guess-move/sessions';
const copy=value=>structuredClone(value);
const evaluation=line=>line?.mate!=null?'#'+line.mate:line?.cp!=null?(line.cp>=0?'+':'')+(line.cp/100).toFixed(2):'—';
const sideLabel=side=>({white:t('Blancs'),black:t('Noirs'),both:t('Les deux camps')})[side];
const guessSettings=values=>({side:['white','black','both'].includes(values?.side)?values.side:'white',start:['current','beginning'].includes(values?.start)?values.start:'current'});

export class GuessMoveView {
 constructor(container,{onAnalyse=null,onLibrary=null,initialSettings=null,onSettingsChange=null}={}){this.host=container;this.onAnalyse=onAnalyse;this.onLibrary=onLibrary;this.onSettingsChange=onSettingsChange;this.board=null;this.disposed=false;this.sequence=0;this.busy=false;this.offset=0;this.listSequence=0;this.selectedBaseId=null;this.settings=guessSettings(initialSettings);}
 dispose(){this.baseCollection?.dispose();this.gamePicker?.dispose();this.disposed=true;this.sequence++;this.historyView?.dispose();this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();this.board?.dispose();this.board=null;this.host.classList.remove('guess-page');}
 heading(title=t('Deviner le coup'),description=t('Retrouve le coup de la partie ou une bonne alternative. Le premier essai compte.'),session=null){
  return '<header class="page-title training-header"><div class="training-header-copy"><h1>'+esc(title)+'</h1>'+(session?guessGameDetailsHtml(session.doc?.headers):'')+'<p class="muted">'+esc(description)+'</p></div><div class="training-header-tools">'+(session?'<strong class="guess-score">'+session.score+'/'+session.maximum+'</strong>':'')+'<nav class="tabs training-tabs" aria-label="'+esc(t('Deviner le coup'))+'"><span class="training-tab" aria-current="page">'+esc(t('Jouer'))+'</span><button type="button" data-training-history aria-haspopup="dialog">'+esc(t('Historique'))+'</button><button type="button" data-training-statistics aria-haspopup="dialog">'+esc(t('Statistiques'))+'</button><button type="button" data-training-settings aria-haspopup="dialog"'+(session&&!session.completed?' disabled':'')+'>'+esc(t('Réglages'))+'</button>'+(session?'<button type="button" data-home>'+esc(t('Séances'))+'</button>':'')+'</nav></div></header>';
 }
 bindHeading(){
  bindTrainingTabs(this.host);
  this.host.querySelector('[data-training-history]')?.addEventListener('click',()=>void this.showHistory().catch(fail));
  this.host.querySelector('[data-training-statistics]')?.addEventListener('click',()=>void this.showStatistics().catch(fail));
  this.host.querySelector('[data-training-settings]')?.addEventListener('click',()=>this.showSettings());
 }
 async load(){
  const seq=++this.sequence;this.busy=false;this.historyView?.dispose();this.historyView=null;this.board?.dispose();this.board=null;this.host.classList.add('guess-page');
  this.baseCollection?.dispose();this.baseCollection=null;
  this.gamePicker?.dispose();this.gamePicker=null;
  this.host.innerHTML=ui('<div class="loading">Chargement…</div>');
  const library=await api('/api/library');
  if(this.disposed||seq!==this.sequence)return;
  this.allBases=this.programBaseId?library.bases.filter(base=>Number(base.id)===this.programBaseId):library.bases;this.session=null;
  await this.renderPicker(this.programBaseId||null);
 }
 async renderPicker(baseId=null){
  if(this.disposed)return;
  const seq=++this.sequence;
  this.baseCollection?.dispose();this.baseCollection=null;
  this.gamePicker?.dispose();this.gamePicker=null;
  this.bases=associatedGuessBases(this.allBases);
  const selected=(this.programBaseId&&Number(baseId)===this.programBaseId?this.allBases:this.bases).find(base=>Number(base.id)===Number(baseId));
  this.selectedBaseId=selected?.id??null;
  if(!selected){
   this.host.innerHTML=this.heading()+guessDashboardHtml(this.bases,{onLibrary:!!this.onLibrary});
   this.bindHeading();
   this.host.querySelector('[data-guess-library]')?.addEventListener('click',()=>void Promise.resolve(this.onLibrary?.()).catch(fail));
   this.host.querySelectorAll('[data-guess-base]').forEach(button=>button.onclick=()=>this.renderPicker(Number(button.dataset.guessBase)).catch(fail));
   const grid=this.host.querySelector('.guess-base-grid');
   if(grid){const items=[...grid.querySelectorAll('[data-guess-card]')].map(node=>{const base=this.bases.find(base=>String(base.id)===node.dataset.guessCard);return {node,text:[base.name,...base.tags||[]].join(' '),values:{type:base.reference?'reference':'personal'},sort:{name:base.name,games:Number(base.entry_count)||0}};});this.baseCollection=new CollectionList(grid,{items,stateKey:'guess-bases',placeholder:'Rechercher une base…',filters:[{key:'type',label:'Type de base',options:[['personal','Personnelle'],['reference','Référence']]}],sorts:[['name','Nom'],['games','Nombre de parties']]});}
   return;
  }
  this.host.innerHTML=this.heading()+'<section class="panel"><div class="section-heading guess-picker-heading"><h2>'+esc(selected.name)+'</h2>'+(this.programBaseId?'':'<button type="button" data-guess-back>'+esc(t('Retour aux bases'))+'</button>')+'</div><div data-game-picker></div></section>';
  this.bindHeading();
  this.host.querySelector('[data-guess-back]')?.addEventListener('click',()=>void this.renderPicker().catch(fail));
  this.gamePicker=new GamePicker(this.host.querySelector('[data-game-picker]'),{bases:[selected],stateKey:'guess-picker',onSelect:async(base,id)=>{if(this.disposed||seq!==this.sequence)return;if(base.reference){const doc=await api('/api/reference-bases/'+base.id+'/games/'+id);if(!this.disposed&&seq===this.sequence)await this.launch({doc,sourceBaseId:base.id});}else await this.launch({entryId:id});}});
  await this.gamePicker.ready;
 }
 async launch({entryId=null,doc=null,path='',side=null,sourceBaseId=null}={}){
  this.sourceBaseId=sourceBaseId||this.programBaseId||null;
  this.baseCollection?.dispose();this.baseCollection=null;
  this.gamePicker?.dispose();this.gamePicker=null;
  if(side)return this.start({entryId,doc,path,side});
  this.sequence++;this.busy=false;this.session=null;
  this.historyView?.dispose();this.historyView=null;this.board?.dispose();this.board=null;this.host.classList.add('guess-page');
  this.host.innerHTML=this.heading()+ui('<section class="exercise-launch guess-launch"><p>Le pointage dépend uniquement de l’évaluation de Stockfish. Un coup de qualité équivalente au meilleur coup obtient 10/10.</p><form data-guess-launch>')+setupSummaryHtml(sideLabel(this.settings.side))+ui('<label hidden>Camp joué<select name="side"><option value="white">Blancs</option><option value="black">Noirs</option><option value="both">Les deux camps</option></select></label>')+(path?ui('<label hidden>Départ<select name="start"><option value="current">Position actuelle</option><option value="beginning">Début de la partie</option></select></label>'):'')+ui('<div class="actions"><button type="submit" class="primary">Commencer</button><button type="button" data-cancel>Retour</button></div></form></section>');
  this.bindHeading();
  this.applySettings(this.settings);
  this.host.querySelector('[data-exercise-customize]')?.addEventListener('click',()=>this.showSettings());
  this.host.querySelector('[data-cancel]').onclick=()=>this.allBases?this.renderPicker(this.selectedBaseId).catch(fail):this.load().catch(fail);
  this.host.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('[type="submit"]');button.disabled=true;try{await this.start({entryId,doc,path:form.elements.start?.value==='beginning'?'':path,side:form.elements.side.value});}catch(error){fail(error);button.disabled=false;}};
 }
 async start({entryId,doc,path='',side='white'}){
  const seq=++this.sequence;this.busy=true;
  const settingsButton=this.host.querySelector('[data-training-settings]');if(settingsButton)settingsButton.disabled=true;
  const body={path,side,...(doc?{pgn:serialize(doc),...(this.sourceBaseId?{source_base_id:this.sourceBaseId}:{})}:{entry_id:entryId})};
  try{const session=await nativeProgramRequest(this,'guess',body,payload=>api(endpoint,{method:'POST',body:payload}));if(this.disposed||seq!==this.sequence)return;
   acceptedProgramCreation(this,'guess');this.session=session;this.renderSession();
  }finally{if(!this.disposed&&seq===this.sequence){this.busy=false;const button=this.host.querySelector('[data-training-settings]');if(button)button.disabled=!!this.session&&!this.session.completed;}}
 }
 async openTrainingRecord(record){return this.openSession(record.id);}
 async openSession(id){if(String(id).startsWith('mix-'))throw new Error(t('Cette séance expérimentale est archivée. Ses résultats restent dans l’historique.'));const seq=++this.sequence,session=await api(endpoint+'/'+encodeURIComponent(id));if(this.disposed||seq!==this.sequence)return;this.session=session;this.renderSession();}
 renderSession(){
  this.baseCollection?.dispose();this.baseCollection=null;this.gamePicker?.dispose();this.gamePicker=null;
  const s=this.session;this.historyView?.dispose();this.historyView=null;this.board?.dispose();this.board=null;this.busy=false;this.startedAt=Date.now();this.previewAttempt=null;
  this.host.innerHTML=this.heading(t('Deviner le coup'),sideLabel(s.side)+' · '+t('Premier essai'),s)+ui('<div class="guess-workbench"><div data-board></div><section class="analysis-notebook guess-notebook"><div class="guess-status" role="status"></div><div data-feedback></div><div data-engine hidden></div><div data-moves class="guess-moves"></div><div data-attempts></div><footer class="guess-actions"></footer></section></div>');
  this.bindHeading();
  this.host.querySelector('[data-home]').onclick=()=>this.load().catch(fail);
  let display={doc:copy(s.doc),path:s.path??s.doc.nodes.at(-1).path};
  if(s.awaiting_continue&&s.result?.proposal?.positions?.length)display=appendLine(display.doc,s.path,s.result.proposal.positions.slice(0,1),{detached:true});
  this.board=new Board(this.host.querySelector('[data-board]'),{doc:display.doc,path:display.path,flipped:s.side==='black',playerBandHtml:(board,side)=>guessPlayerBandHtml(board,side,s.doc),training:!s.completed&&!s.awaiting_continue,engineHost:this.host.querySelector('[data-engine]'),onMove:uci=>this.move(uci),onChange:()=>this.renderMoves()});
  this.renderMoves();this.renderFeedback();this.renderAttempts();
  if(s.completed)playSound('complete');
 }
 async showHistory(){
  if(this.disposed||this.busy)return;
  const dialog=await openTrainingHistory({host:this.host,tool:'guess',onOpen:!this.session||this.session.completed?record=>this.openSession(record.id):null});
  if(this.disposed)dialog.close();else this.historyDialog=dialog;
 }
 async showStatistics(){
  if(this.disposed||this.busy)return;
  const dialog=await openTrainingStatistics({host:this.host,tool:'guess'});
  if(this.disposed)dialog.close();else this.statisticsDialog=dialog;
 }
 applySettings(values,{notify=false}={}){
  this.settings=guessSettings(values);
  const form=this.host.querySelector('[data-guess-launch]');
  if(form){form.elements.side.value=this.settings.side;if(form.elements.start)form.elements.start.value=this.settings.start;}
  const summary=this.host.querySelector('.exercise-config-summary');if(summary)summary.textContent=sideLabel(this.settings.side);if(notify)this.onSettingsChange?.(copy(this.settings));
 }
 showSettings(){
  if(this.disposed||this.busy||(this.session&&!this.session.completed))return;
  this.settingsDialog=openTrainingSettings({host:this.host,title:t('Réglages')+' · '+t('Deviner le coup'),html:'<p class="muted">'+esc(t('Ces réglages seront proposés pour les prochaines parties. Le départ s’applique lorsqu’une partie est ouverte depuis une position.'))+'</p>'+ui('<label>Camp joué<select name="side"><option value="white">Blancs</option><option value="black">Noirs</option><option value="both">Les deux camps</option></select></label><label>Départ<select name="start"><option value="current">Position actuelle</option><option value="beginning">Début de la partie</option></select></label>'),onReady:form=>{form.elements.side.value=this.settings.side;form.elements.start.value=this.settings.start;},onSubmit:values=>{if(!this.disposed&&!this.busy&&(!this.session||this.session.completed))this.applySettings({side:values.get('side'),start:values.get('start')},{notify:true});}});
 }
 renderMoves(){
  if(!this.board||this.disposed)return;
  const host=this.host.querySelector('[data-moves]');renderAnalysisMovesInto(host,this.board.doc,this.board.path);
  const inspect=this.session.completed||this.session.awaiting_continue;
  host.querySelectorAll('[data-path]').forEach(button=>{button.disabled=!inspect;button.onclick=()=>inspect?this.board.go(button.dataset.path):undefined;});
 }
 async move(uci){
  if(this.busy||this.disposed||this.session.pending)return;
  if(this.session.awaiting_continue||this.session.completed){await this.board.move(uci);return;}
  await this.submit(uci);
 }
 async submit(uci){
  if(this.busy||this.disposed)return;
  const seq=this.sequence,s=this.session;this.busy=true;this.board.inputLocked=true;this.board.renderBoard();
  this.host.querySelector('.guess-status').textContent=t('Stockfish évalue ton premier essai…');
  try{
   const next=await api(endpoint+'/'+s.id+'/attempt',{method:'POST',body:{path:s.path,uci,elapsed_ms:Date.now()-this.startedAt}});
   if(this.disposed||seq!==this.sequence)return;this.session=next;playSound(next.result?.score>=8?'correct':'incorrect');this.renderSession();
  }catch(error){
   if(this.disposed||seq!==this.sequence)return;fail(error);
   // Recover the persisted first proposal; retry sends that same move only.
   try{const state=await api(endpoint+'/'+s.id);if(!this.disposed&&seq===this.sequence){this.session=state;this.renderSession();}}catch{if(!this.disposed&&seq===this.sequence)this.host.querySelector('.guess-status').textContent=t('Évaluation en attente. Réessaie avec le même coup.');}
  }finally{if(!this.disposed&&seq===this.sequence){this.busy=false;if(this.board){this.board.inputLocked=false;this.board.renderBoard();}}}
 }
 renderFeedback(){
  const s=this.session,r=this.previewAttempt?.result||s.result,host=this.host.querySelector('[data-feedback]'),status=this.host.querySelector('.guess-status'),actions=this.host.querySelector('.guess-actions');
  host.innerHTML='';actions.innerHTML='';
  this.host.querySelector('[data-engine]').hidden=!s.completed&&!s.awaiting_continue;
  if(s.completed){status.textContent=t('Séance terminée · {score}/{maximum}',{score:s.score,maximum:s.maximum});const rows=s.attempts.filter(a=>a.score!=null);host.innerHTML='<div class="guess-summary">'+[[t('Coups originaux retrouvés'),s.exact_count],[t('Bonnes alternatives'),rows.filter(a=>!a.exact&&a.score>=8).length],[t('À retravailler'),rows.filter(a=>a.score<8).length],[t('Temps de réflexion'),Math.round(rows.reduce((sum,a)=>sum+a.elapsed_ms,0)/1000)+' '+t('s')]].map(([label,value])=>'<div><strong>'+esc(value)+'</strong><small>'+esc(label)+'</small></div>').join('')+'</div>';}
  else if(s.pending){
   status.textContent=t('Premier essai enregistré · évaluation à reprendre');
   actions.innerHTML=ui('<button class="primary" data-retry>Relancer l’évaluation</button>');
   actions.querySelector('[data-retry]').onclick=()=>this.submit(s.attempts.find(attempt=>attempt.path===s.path).uci);
  }else status.textContent=s.awaiting_continue?t('Compare les coups, puis reprends la partie originale.'):t('À toi de deviner · la suite reste masquée');
  if(r){
   host.innerHTML='<div class="guess-result"><strong>'+r.score+'/10</strong><span>'+esc(r.exact?t('Coup de la partie retrouvé'):r.score===10?t('Alternative équivalente'):t('Autre proposition'))+'</span></div><div class="guess-comparisons">'+[['proposal',t('Ton coup'),r.proposal_san],['original',t('Coup de la partie'),r.original_san],['best',t('Meilleur coup'),r.best?.san?.[0]||'—']].map(([key,label,san])=>'<button data-line="'+key+'"><small>'+esc(label)+'</small><strong>'+esc(san)+'</strong><span>'+esc(evaluation(r[key]))+'</span></button>').join('')+'</div>'+(r.comment?'<p class="guess-comment">'+esc(r.comment)+'</p>':'')+ui('<p class="hint">Évaluations du point de vue des blancs. Clique sur un coup pour explorer sa variante.</p>');
   host.querySelectorAll('[data-line]').forEach(button=>button.onclick=()=>this.explore(r[button.dataset.line],this.previewAttempt?.path??s.path).catch(fail));
  }
  if(s.awaiting_continue){actions.innerHTML=ui('<button data-continue class="primary">Continuer la partie</button>');actions.querySelector('[data-continue]').onclick=()=>this.continue().catch(fail);}
  if(s.completed&&this.onAnalyse){actions.innerHTML=ui('<button data-analysis>Analyser la partie complète</button>');actions.querySelector('[data-analysis]').onclick=async()=>{try{const doc=await api(endpoint+'/'+s.id+'/source');await this.onAnalyse({doc,path:'',entryId:s.entry_id});}catch(error){fail(error);}};}
 }
 async explore(line,path){
  if(!line?.positions?.length||!this.board||path==null)return;
  const applied=appendLine(copy(this.session.doc),path,line.positions,{detached:true});await this.board.setDoc(applied.doc,applied.path);this.renderMoves();
 }
 async continue(){
  if(this.busy)return;this.busy=true;const seq=this.sequence,s=this.session;
  try{const next=await api(endpoint+'/'+s.id+'/continue',{method:'POST',body:{path:s.path}});if(this.disposed||seq!==this.sequence)return;this.session=next;this.renderSession();}
  finally{if(!this.disposed&&seq===this.sequence)this.busy=false;}
 }
 renderAttempts(){
  const rows=this.session.attempts.filter(a=>a.result),host=this.host.querySelector('[data-attempts]');
  host.innerHTML=rows.length?'<details '+(this.session.completed?'open':'')+'><summary>'+t('Tentatives')+' · '+rows.length+'</summary><div class="guess-attempts">'+rows.map(a=>'<button data-attempt="'+a.id+'"><span>'+esc(a.result.proposal_san)+' → '+esc(a.result.original_san)+'</span><strong>'+a.score+'/10</strong><small>'+Math.round(a.elapsed_ms/1000)+' '+t('s')+'</small></button>').join('')+'</div></details>':'';
  host.querySelectorAll('[data-attempt]').forEach(button=>{button.disabled=!this.session.completed&&!this.session.awaiting_continue;button.onclick=()=>{this.previewAttempt=rows.find(a=>a.id===Number(button.dataset.attempt));this.renderFeedback();return this.board.go(this.previewAttempt.path);};});
 }
}
