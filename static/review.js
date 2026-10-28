import {t,ui} from './i18n.js';
import {api,esc,fail,TYPES} from './api.js';
import {Board,makeDoc} from './board.js';
import {renderAnalysisMovesInto,analysisMovesHtml} from './analysis-moves.js';
import {playSound} from './sound.js';
import {copySession,attemptMoves,solutions,prepareReviewResume} from './review-resume.js';
export {prepareReviewResume,reviewSnapshotData} from './review-resume.js';
import {probabilityDisplay} from './explorer-probability.js';
import {dailyReasons} from './review-selection.js';
import {reviewSourceAnnotations,reviewExplanationComments} from './review-comments.js';
import {newId as attemptId} from './identifiers.js';

let active=null;
const live=(s,card=s.card,board=s.board)=>active===s&&!s.stopped&&s.card===card&&s.board===board;
const turn=fen=>fen.split(' ')[1]==='w'?'white':'black';
const proposed=s=>s.errors>0?0:s.hints>0||s.assisted?1:2;


function disposeCard(s){s.toolbarPauseOverlay?.remove();s.toolbarPauseOverlay=null;for(const {node,inert} of s.toolbarPausedRegions||[])node.inert=inert;s.toolbarPausedRegions=[];s.visibilityCleanup?.();s.visibilityCleanup=null;s.layout?.disconnect();s.layout=null;s.board?.dispose();s.board=null;}
function activeElapsed(s){if(s.toolbarPaused)return s.toolbarPausedElapsed||0;const now=Date.now();return Math.max(0,now-s.startedAt-(s.hiddenMs||0)-(s.hiddenAt==null?0:now-s.hiddenAt));}
function observeVisibility(s){
 const doc=globalThis.document;if(!doc?.addEventListener)return;
 const changed=()=>{if(doc.hidden){if(s.hiddenAt==null)s.hiddenAt=Date.now();}else if(s.hiddenAt!=null){s.hiddenMs=(s.hiddenMs||0)+Math.max(0,Date.now()-s.hiddenAt);s.hiddenAt=null;}s.onStateChange?.();};
 doc.addEventListener('visibilitychange',changed);s.visibilityCleanup=()=>doc.removeEventListener('visibilitychange',changed);
}
export function stopReview(){
 if(!active)return;
 const session=active;active=null;session.stopped=true;disposeCard(session);
 session.host.classList.remove('review-page');
 session.onStateChange?.();
}
export function reviewAssistance(){
 if(active?.card&&!active.stopped&&!active.finished&&!active.sourceMode){active.assisted=true;active.hints++;updateStatus(active);}
}
export function reviewBoard(){return active&&!active.stopped&&active.board&&!active.board.disposed?active.board:null;}
export function reviewFen(){return reviewBoard()?.node().fen;}
export function reviewToolbarState(){
 const s=active;if(!s||s.stopped||(s.finishedSession&&!s.training_run_id)||(!s.finishedSession&&!s.goalReached&&(!s.board||!s.card)))return null;
 const elapsedMs=Math.max(0,s.sessionElapsedMs||0)+(s.board?(s.completion?.elapsedMs??activeElapsed(s)):0);
 const targetMs=s.toolbarTargetMs||(Number(s.goal?.minutes)>0?Number(s.goal.minutes)*60000:null);
 return {id:s.session_id||s.requestId,activity:'review',title:sessionTitle(s)||s.card?.title||t('Révision'),program:!!s.training_run_id,training_run_id:s.training_run_id||null,active:!s.finishedSession,
  elapsedMs,targetMs,remainingMs:targetMs==null?null:Math.max(0,targetMs-elapsedMs),clockType:targetMs==null?'elapsed':'session',
  paused:!!s.toolbarPaused,canPause:!!s.board&&!(s.working||s.opening||s.loadingBatch||s.pendingAction||s.board.busy),canFinish:!(s.working||s.opening||s.loadingBatch||s.pendingAction),goalReached:!!s.goalReached,
  completed:s.completed||0,total:s.total??s.cards.length};
}
function showToolbarPause(s){
 const workspace=s.host.querySelector('.review-workbench');if(!workspace||s.toolbarPauseOverlay)return;
 const doc=s.host.ownerDocument||globalThis.document;if(!doc?.createElement)return;
 const overlay=doc.createElement('div');overlay.className='training-pause-overlay';overlay.setAttribute('data-review-toolbar-pause','');overlay.setAttribute('role','status');
 overlay.innerHTML='<strong>'+esc(t('Séance en pause'))+'</strong><button type="button" data-review-toolbar-resume>'+esc(t('Reprendre'))+'</button>';
 const resume=overlay.querySelector('[data-review-toolbar-resume]');
 resume.onclick=async()=>{
  if(!live(s)||s.toolbarResumePending)return;
  s.toolbarResumePending=true;resume.disabled=true;
  try{await (s.onToolbarResume?s.onToolbarResume():resumeReviewToolbar());}
  catch(error){if(live(s))fail(error);}
  finally{s.toolbarResumePending=false;if(live(s)&&s.toolbarPaused)resume.disabled=false;}
 };
 s.toolbarPausedRegions=Array.from(workspace.children).map(node=>({node,inert:!!node.inert}));
 for(const {node} of s.toolbarPausedRegions)node.inert=true;
 workspace.appendChild(overlay);s.toolbarPauseOverlay=overlay;
}
export function pauseReviewToolbar(){
 const s=active;if(!s||s.stopped||!s.board||s.finishedSession)return false;if(s.toolbarPaused)return true;
 if(s.working||s.opening||s.loadingBatch||s.pendingAction||s.board.busy||s.board.inputLocked)
  throw Error(t('Patiente jusqu’à la fin du coup en cours.'));
 s.toolbarPausedElapsed=s.completion?.elapsedMs??activeElapsed(s);s.toolbarPaused=true;showToolbarPause(s);updateControls(s);return true;
}
export function resumeReviewToolbar(){
 const s=active;if(!s||s.stopped||!s.toolbarPaused)return false;
 s.startedAt=Date.now()-(s.toolbarPausedElapsed||0);s.hiddenMs=0;s.hiddenAt=globalThis.document?.hidden?Date.now():null;s.toolbarPaused=false;
 s.toolbarPauseOverlay?.remove();s.toolbarPauseOverlay=null;
 for(const {node,inert} of s.toolbarPausedRegions||[])node.inert=inert;s.toolbarPausedRegions=[];
 updateControls(s);return true;
}
export function reviewTrainingContext(){
 const s=active;if(!s||s.stopped)return null;
 return {training_run_id:s.training_run_id||null,session_id:s.session_id||null,
  card_id:s.card?.id||null,entry_id:s.card?.entry_id??null,
  busy:!!(s.working||s.opening||s.loadingBatch),pending:!!s.pendingAction,
  finished:!!s.finishedSession};
}
export async function settleReviewTraining({finishing=false}={}){
 const s=active;if(!s||s.stopped)return null;
 // Finishing a programme block never fabricates a grade for the current card.
 if(s.recordPromise)await s.recordPromise;
 if(active!==s||s.stopped)return null;
 if(s.pendingAction||s.working||s.opening||s.loadingBatch)
  throw Error(t('Attends la confirmation de la révision avant de terminer ce bloc.'));
 if(finishing&&s.board&&(s.userWorked||s.finished||s.revealed||s.errors||s.hints||s.assisted))
  throw Error(t('Termine et évalue la carte en cours avant de terminer ce bloc, ou mets le bloc en pause pour conserver ta tentative.'));
 return reviewTrainingContext();
}

const copy=value=>structuredClone(value);
const sessionTitle=s=>s.mode==='daily'?t(s.selection==='learn'?'Tout apprendre':s.selection==='review'?'Tout réviser':'Réviser / Apprendre'):s.base.name;
const sessionFields=s=>({session_id:s.session_id,training_run_id:s.training_run_id||null,mode:s.mode,selection:s.selection,base_ids:s.base_ids,total:s.total,next_offset:s.next_offset,goal:s.goal,sessionElapsedMs:s.sessionElapsedMs||0,goalReached:!!s.goalReached,finishedSession:!!s.finishedSession,toolbarPaused:!!s.toolbarPaused,toolbarTargetMs:s.toolbarTargetMs||(Number(s.goal?.minutes)>0?Number(s.goal.minutes)*60000:null),sessionContextSupport:s.sessionContextSupport,maintenanceEnabled:s.maintenanceEnabled});
const hasNextBatch=s=>!!s.session_id&&s.next_offset!=null;
export const reviewSessionFinished=s=>s?.session_id?!!s.finishedSession:s?.index>=s?.cards?.length;
export function snapshotReview({assisted=false,stop=false}={}){
 const s=active;
 if(stop&&(s?.working||s?.finishedSession||(!s?.session_id&&s?.index>=s?.cards.length)))return null;
 if(s&&!s.stopped&&(s.finishedSession||s.goalReached||s.loadingBatch||s.batchError||s.index>=s.cards.length&&s.cards.length)){const snapshot={...sessionFields(s),base:copy(s.base),cards:copy(s.cards),index:s.index,completed:s.completed,all:s.all,mastered:s.mastered||0,attempt:null,skipped:s.skipped||0,onClose:s.onClose,onPause:s.onPause,onToolbarResume:s.onToolbarResume,onSettings:s.onSettings,onEditEntry:s.onEditEntry,onExploreLine:s.onExploreLine,onStateChange:s.onStateChange,receiptSupport:s.receiptSupport};if(stop)stopReview();return snapshot;}
 if(!s||s.stopped||!s.board||(s.working&&!s.pendingAction)||s.board.busy||(s.board.inputLocked&&!s.pendingAction&&(!s.controlLock||s.previousInputLock)))return null;
 const attempt=copy({
  doc:s.sourceRestore?.doc||s.board.doc,path:s.sourceRestore?.path??s.board.path,flipped:s.board.flipped,arrows:s.board.arrows,
  engineOn:s.sourceRestore?.engineOn??s.board.engineOn,gameOver:!!(s.sourceRestore?.gameOver??s.board.gameOver),result:s.sourceRestore?.result||s.board.result||'*',
  ply:s.ply,playHistory:s.playHistory,errors:s.errors,hints:s.hints,requestId:s.requestId,userWorked:!!s.userWorked,
  assisted:s.assisted,finished:s.finished,revealed:s.revealed,
  completionMessage:s.completionMessage,completion:s.completion,playTerminal:s.playTerminal,goalAssessment:s.goalAssessment,
  elapsedMs:s.completion?.elapsedMs??activeElapsed(s),settings:s.settings
 });
 // Opening the full source reveals the solution, but never submits a grade.
 if(assisted&&!attempt.finished){attempt.assisted=true;attempt.hints++;}
 const snapshot={...sessionFields(s),base:copy(s.base),cards:copy(s.cards),index:s.index,completed:s.completed,all:s.all,
  onClose:s.onClose,onPause:s.onPause,onToolbarResume:s.onToolbarResume,onSettings:s.onSettings,onEditEntry:s.onEditEntry,onExploreLine:s.onExploreLine,onStateChange:s.onStateChange,
  mastered:s.mastered||0,attempt,skipped:s.skipped||0,receiptSupport:s.receiptSupport,pendingAction:s.pendingAction?copy(s.pendingAction):null};
 if(stop)stopReview();
 return snapshot;
}
export function suspendReview({assisted=true}={}){return snapshotReview({assisted,stop:true});}
export async function resumeReview(host,prepared){
 if(!prepared)return;
 stopReview();
 const s={...copySession(prepared),host,stopped:false,board:null};
 active=s;
 if(s.goalReached){showGoalReached(s);return;}
 if(s.index>=s.cards.length){await advanceReview(s);return;}
 const attempt=s.attempt;delete s.attempt;
 await showCard(s,attempt);
}

export async function startReview(host,base,{all=false,selection='review',onClose,onPause,onToolbarResume,onSettings,onEditEntry,onExploreLine,onStateChange,receiptSupport=null,sessionSupport=false,sessionContextSupport=false,maintenanceEnabled=false,preparedSession=null,training_run_id=null,goal={minutes:null,cards:null}}={}){
 stopReview();
 sessionSupport=sessionSupport||!!training_run_id;sessionContextSupport=sessionContextSupport||!!training_run_id||!!preparedSession?.training_run_id;
 const s={host,base,cards:[],index:0,completed:0,mastered:0,stopped:false,board:null,all,selection,onClose,onPause,onToolbarResume,onSettings,onEditEntry,onExploreLine,onStateChange,receiptSupport,sessionSupport,sessionContextSupport,maintenanceEnabled,training_run_id,goal,sessionElapsedMs:0};
 active=s;
 let response;
 try{response=preparedSession||(sessionSupport?await api('/api/review-sessions',{method:'POST',body:{base_id:base.id,selection,goal,request_id:training_run_id||attemptId(),...(training_run_id?{training_run_id}:{})}}):await api('/api/bases/'+base.id+'/queue?selection='+encodeURIComponent(selection)));}
 catch(error){if(live(s))throw error;return;}
 if(!live(s))return;
 if(training_run_id&&response.training_run_id!==training_run_id)throw Error(t('Le contexte du programme n’a pas été conservé. Reviens au programme pour reprendre ce bloc.'));
 s.training_run_id=response.training_run_id||null;s.selection=response.selection||selection;
 s.cards=response.cards;if(sessionSupport||response.session_id)Object.assign(s,{session_id:response.session_id,mode:response.mode,base_ids:response.base_ids,total:response.total,next_offset:response.next_offset,goal:response.goal||goal,completed:response.completed||0,sessionElapsedMs:response.elapsed_ms||0});
 if(!s.cards.length&&hasNextBatch(s)){await advanceReview(s);return;}
 if(!s.cards.length&&s.mode==='daily'){showSessionComplete(s);return;}
 if(!s.cards.length){
  const learning=s.selection==='learn';
  host.innerHTML=ui('<div class="page-title"><h1>')+esc(base.name)+ui('</h1><button id="back-reviews">← Révisions</button></div><div class="empty"><span class="empty-icon">✓</span><h2>')+esc(t(learning?'Aucune nouvelle carte':'Tout est à jour'))+ui('</h2><p>')+esc(t(learning?'Toutes les cartes disponibles ont déjà été travaillées.':'Aucune révision due. Tu peux apprendre de nouvelles cartes.'))+ui('</p>')+(!learning&&!s.training_run_id?ui('<button id="learn-review">Apprendre</button>'):'')+ui('</div>');
  host.querySelector('#back-reviews').onclick=onClose;
  const learn=host.querySelector('#learn-review');
  if(learn)learn.onclick=()=>startReview(host,base,{selection:'learn',onClose,onPause,onToolbarResume,onSettings,onEditEntry,onExploreLine,onStateChange,receiptSupport,sessionSupport,sessionContextSupport,maintenanceEnabled,training_run_id,goal}).catch(fail);
  return;
 }
 await showCard(s);
}

// Fit the square to the available height; long notation scrolls inside its pane.
export function reviewBoardSize({width,height,toolbarHeight,gap=12,notebookMin=340}){
 return Math.max(0,Math.floor(Math.min(width-notebookMin-gap,height-toolbarHeight)));
}
// Portrait prioritizes square size; the workbench scrolls if its panels cannot fit.
export function reviewMobileBoardSize({width}){
 return Math.max(0,Math.floor(width));
}
function observeLayout(s){
 const workspace=s.host.querySelector('.review-workbench'),boardHost=s.host.querySelector('#review-board');
 if(!workspace||!boardHost||typeof ResizeObserver==='undefined')return null;
 let disposed=false;
 const px=(style,name)=>Number.parseFloat(style.getPropertyValue(name))||0;
 const fit=()=>{
  if(disposed)return;
  const style=getComputedStyle(workspace);
  const mode=style.getPropertyValue('--review-fit').trim();
  if(!['1','2'].includes(mode)){workspace.style.removeProperty('--review-board-size');return;}
  const toolbar=boardHost.querySelector('.board-toolbar');
  if(!toolbar)return;
  const toolbarStyle=getComputedStyle(toolbar);
  const size=(mode==='2'?reviewMobileBoardSize:reviewBoardSize)({width:workspace.clientWidth,height:workspace.clientHeight,
   toolbarHeight:toolbar.getBoundingClientRect().height+px(toolbarStyle,'margin-top')+px(toolbarStyle,'margin-bottom'),
   gap:px(style,mode==='2'?'row-gap':'column-gap')||(mode==='2'?6:12),notebookMin:px(style,'--review-notebook-min')||340,
   panelMin:px(style,'--review-mobile-panel-min')||218});
  if(size>=0&&workspace.style.getPropertyValue('--review-board-size')!==size+'px')workspace.style.setProperty('--review-board-size',size+'px');
 };
 const observer=new ResizeObserver(fit);observer.observe(workspace);observer.observe(boardHost);
 window.addEventListener('resize',fit);fit();
 return {refresh:fit,disconnect(){disposed=true;observer.disconnect();window.removeEventListener('resize',fit);}};
}

function selectReviewTab(s,tab){
 if(!live(s)||!['exercise','moves','engine'].includes(tab))return;
 s.mobileTab=tab;
 const notebook=s.host.querySelector('.review-notebook');if(notebook)notebook.dataset.reviewTab=tab;
 s.host.querySelectorAll('[data-review-tab-button]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.reviewTabButton===tab)));
 s.layout?.refresh();
}

function setReviewMenu(s,open){
 const actions=s.host.querySelector('.review-actions'),button=s.host.querySelector('#review-more');
 if(actions)actions.dataset.menuOpen=String(open);
 button?.setAttribute('aria-expanded',String(open));
}

async function showCard(s,restored=null){
 if(s.stopped)return;
 const restorePaused=!!s.toolbarPaused;
 disposeCard(s);
 Object.assign(s,{card:s.cards[s.index],errors:0,hints:0,assisted:false,finished:false,revealed:false,
  ply:0,playHistory:[],requestId:attemptId(),playTerminal:false,goalAssessment:null,completionMessage:'',completion:null,sourceMode:false,sourceRestore:null,sourceDoc:null,...restored,
  startedAt:Date.now()-(restored?.elapsedMs||0),hiddenMs:0,hiddenAt:globalThis.document?.hidden?Date.now():null,toolbarPaused:false,toolbarPausedElapsed:0,working:false,recording:null,opening:false,controlLock:false,previousInputLock:false});
 s.userWorked=restored?.userWorked??!!(restored&&(restored.ply||restored.playHistory?.length));
 observeVisibility(s);
 s.solutions=solutions(s.card);
 if(restored?.doc&&s.card.type!=='play'){
  const accepted=attemptMoves(restored)||[];
  s.solutions=s.solutions.filter(line=>accepted.every((uci,index)=>line[index]===uci));
 }
 const settings=s.settings={...s.base.settings,...s.card.settings},play=s.card.type==='play';
 s.userSide=play&&['white','black'].includes(settings.side)?settings.side:turn(s.card.fen);
 const mission=s.card.type==='game'?t('Rejoue la partie · les deux camps'):play?{win:t('Gagner la position'),convert:t('Convertir l’avantage'),draw:t('Tenir la nulle')}[settings.goal]||t('Jouer la position'):s.userSide==='white'?t('Trouve la suite · blancs'):t('Trouve la suite · noirs');
 const help=play?t('Stockfish · force ')+(settings.skill??10)+' / 20':'';
 const chance=Number.isFinite(s.card.encounter_probability)?probabilityDisplay({status:'ok',probability:s.card.encounter_probability}):null;
 const reason=dailyReasons()[s.card.selection_reason];
 const context=s.mode==='daily'?'<p class="review-selection-context">'+esc(s.card.base_name||'')+(reason?' · '+esc(reason):'')+'</p>':s.card.maintenance?'<p class="review-selection-context">'+esc(t('Entretien des acquis'))+'</p>':'';
 const frequency=chance?ui('<span class="review-frequency" title="Chemin le plus fréquent depuis le départ du répertoire, selon les filtres de la dernière exploration. Tes propres coups sont supposés joués."> · ')+esc(chance.text)+' ('+esc(chance.ratio)+ui(')</span>'):'';
 if(s.card.type==='game'){
  try{s.sourceDoc=await api('/api/reviews/'+encodeURIComponent(s.card.id)+'/source');}catch(error){if(live(s))fail(error);}
  if(active!==s||s.stopped)return;
 }
 s.host.classList.add('review-page');
 s.host.innerHTML=ui('<div class="page-title"><div><div class="eyebrow">')+esc(sessionTitle(s))+' · '+((s.card.session_index??s.index)+1)+t(' / ')+(s.total??s.cards.length)+(' · '+t(s.selection==='learn'?'Apprendre':s.selection==='both'?'Réviser + Apprendre':'Réviser'))+frequency+ui('</div><h1 title="')+esc(s.card.title||TYPES[s.card.type])+'">'+esc(s.card.title||TYPES[s.card.type])+ui('</h1>')+context+ui('</div><div class="actions">')+(s.onPause?ui('<button id="session-pause" title="Mettre la séance en pause" aria-label="Mettre la séance en pause">Ⅱ</button>'):'')+ui('<button id="session-settings" title="Réglages de la base" aria-label="Réglages de la base">⚙</button><button id="session-back" title="Retour aux révisions" aria-label="Retour aux révisions">←</button></div></div>')+
  ui('<div class="review-workbench"><div class="review-board-column"><div id="review-board"></div></div>')+
  ui('<section class="analysis-notebook review-notebook" data-review-tab="exercise" aria-label="Révision et coups"><div class="review-tabs" role="group" aria-label="Panneau de révision">')+[['exercise',t('Exercice')],['moves',t('Coups')],['engine',t('Moteur')]].map(([id,label])=>ui('<button type="button" data-review-tab-button="')+id+'" aria-pressed="'+(id==='exercise')+'">'+label+ui('</button>')).join('')+ui('</div><div id="review-engine"></div>')+
  ui('<section class="review-mission"><h2>')+esc(mission)+ui('</h2>')+(help?ui('<p class="muted">')+esc(help)+ui('</p>'):'')+(s.resumeMessage?ui('<p class="hint" role="status" id="review-resume-note">')+esc(s.resumeMessage)+ui('</p>'):'')+ui('<div id="attempt-status" class="attempt-status" aria-live="polite" aria-atomic="true" hidden></div></section>')+
  ui('<div class="review-content"><div class="review-notation"><div class="notation-heading"><h2>Coups</h2><span class="notation-pov" id="review-move-hint">La suite reste masquée</span></div><div id="review-moves" class="review-move-list"></div></div>')+
  ui('<section class="review-feedback" id="solution-panel" hidden></section></div><section class="review-grading" id="grade-panel" hidden></section>')+
  ui('<footer class="review-actions" data-menu-open="false"><div class="actions">')+(s.card.type==='moves'?ui('<button id="toggle-review-source" aria-pressed="false">Ligne / PGN complet</button>'):'')+(play?ui('<button id="finish-play">Terminer</button>'):ui('<button id="reveal-answer">Voir la réponse</button>'))+ui('<button id="return-solution" class="quiet" title="Revenir à la position de fin de l’exercice, sans effacer les variantes explorées" hidden>Position finale</button><button id="master-card" class="quiet" title="Conserver dans les appris, sans nouvelles révisions" aria-label="Marquer comme maîtrisé : conserver dans les appris, sans nouvelles révisions">Maîtrisé</button><button id="review-more" class="review-more" type="button" aria-label="Autres actions" aria-expanded="false" aria-controls="review-secondary">⋯</button></div>')+
  ui('<div class="review-secondary" id="review-secondary"><button id="retry-card" class="quiet">Recommencer</button><button id="analyse-position" title="Ouvrir la partie ou l’exercice complet avec ses coups, variantes et commentaires">Analyser / éditer</button></div></footer></section></div>');
 s.mobileTab='exercise';
 s.host.querySelectorAll('[data-review-tab-button]').forEach(button=>button.onclick=()=>selectReviewTab(s,button.dataset.reviewTabButton));
 s.host.querySelector('#review-more').onclick=()=>setReviewMenu(s,s.host.querySelector('.review-actions').dataset.menuOpen!=='true');
 s.host.querySelector('.review-actions').onkeydown=event=>{if(event.key==='Escape'){setReviewMenu(s,false);s.host.querySelector('#review-more').focus?.();}};
 s.board=new Board(s.host.querySelector('#review-board'),{
  doc:restored?.doc||makeDoc(s.card.fen),path:restored?.path||'',training:!s.finished,flipped:restored?.flipped??(s.userSide==='black'),engineHost:s.host.querySelector('#review-engine'),
  onMove:uci=>attempt(s,uci),onChange:()=>{renderMoves(s);s.onStateChange?.();},
  onVariationChange:()=>renderMoves(s),
  onExploreLine:payload=>s.onExploreLine?.(payload),
  onAssist:()=>{if(live(s)&&!s.finished&&!s.sourceMode){s.assisted=true;s.hints++;updateStatus(s);}}
 });
 if(restored?.doc){s.board.gameOver=restored.gameOver;s.board.result=restored.result;s.board.arrows=restored.arrows??3;}
 s.layout=observeLayout(s);
 s.host.querySelector('#session-back').onclick=s.onClose;
 s.host.querySelector('#session-settings').onclick=()=>s.onSettings?.(s.card);
 const pause=s.host.querySelector('#session-pause');if(pause)pause.onclick=s.onPause;
 s.host.querySelector('#analyse-position').onclick=()=>{setReviewMenu(s,false);return editEntry(s);};
 s.host.querySelector('#retry-card').onclick=()=>{setReviewMenu(s,false);return retry(s);};
 s.host.querySelector('#return-solution').onclick=()=>{if(live(s)&&(s.finished||s.sourceMode)&&!s.working&&!s.opening)return s.board.go(s.completion.path);};
 s.host.querySelector('#master-card').onclick=()=>masterCard(s);
 if(s.maintenanceEnabled){const master=s.host.querySelector('#master-card');master.setAttribute('title',t('Conserver dans les appris avec des rappels d’entretien espacés'));master.setAttribute('aria-label',t('Marquer comme maîtrisé avec entretien des acquis'));}
 const sourceToggle=s.host.querySelector('#toggle-review-source');if(sourceToggle)sourceToggle.onclick=()=>toggleReviewSource(s);
 if(play)s.host.querySelector('#finish-play').onclick=()=>finishPlay(s);
 else s.host.querySelector('#reveal-answer').onclick=()=>reveal(s);
 renderMoves(s);updateStatus(s);
 if(s.finished){if(play)renderPlayResult(s);else await complete(s,s.completionMessage||t('Solution trouvée'));}
 if(restored?.doc&&restored.engineOn){
  s.board.engineOn=true;s.board.render?.();void s.board.analyse?.();
 }
 s.resumeMessage='';
 if(s.pendingAction){renderPendingAction(s);return;}
 s.onStateChange?.();
 if(!s.finished&&s.card.type!=='game'&&turn(s.board.node().fen)!==s.userSide){
  if(play)await engineTurn(s);else await resumeSolutionTurn(s);
 }
 if(restorePaused&&live(s)&&!s.working&&!s.board.busy)pauseReviewToolbar();
}

async function resumeSolutionTurn(s){
 const card=s.card,board=s.board;s.working=true;updateControls(s);
 try{
  while(live(s,card,board)&&turn(board.node().fen)!==s.userSide&&s.solutions[0]?.[s.ply]){
   const reply=s.solutions[0][s.ply];await board.move(reply);
   if(!live(s,card,board))return;
   s.solutions=s.solutions.filter(line=>line[s.ply]===reply);s.ply++;
  }
  if(!live(s,card,board))return;
   if(s.solutions.some(line=>line.length===s.ply))await complete(s);else updateStatus(s,t('Continue la suite depuis ta tentative.'));
 }catch(error){if(live(s,card,board))fail(error);}
 finally{if(live(s,card,board)){s.working=false;updateControls(s);}}
}

function updateControls(s){
 if(!live(s)||!s.board)return;
 const locked=s.working||s.opening||!!s.pendingAction||s.toolbarPaused;
 if(locked&&!s.controlLock){s.previousInputLock=s.board.inputLocked;s.controlLock=true;s.board.inputLocked=true;s.board.renderBoard();}
 else if(!locked&&s.controlLock){s.controlLock=false;s.board.inputLocked=!!s.previousInputLock;s.board.renderBoard();}
 for(const id of ['retry-card','analyse-position','master-card','return-solution','session-pause']){
  const button=s.host.querySelector('#'+id);
  if(button)button.disabled=!!(locked||s.sourceMode||(id==='analyse-position'&&!s.onEditEntry));
 }
 const sourceToggle=s.host.querySelector('#toggle-review-source');if(sourceToggle)sourceToggle.disabled=!!locked;
 const master=s.host.querySelector('#master-card');if(master){master.hidden=!!s.card.maintenance;master.textContent=s.recording==='master'?t('Enregistrement…'):t('Maîtrisé');}
 const edit=s.host.querySelector('#analyse-position');if(edit)edit.textContent=s.opening?t('Ouverture…'):t('Analyser / éditer');
 for(const id of ['reveal-answer','finish-play']){
  const button=s.host.querySelector('#'+id);if(button){button.disabled=!!(locked||s.finished||s.sourceMode);button.hidden=s.finished;}
 }
 const returnButton=s.host.querySelector('#return-solution');if(returnButton)returnButton.hidden=!s.finished;
 s.host.querySelectorAll('[data-grade],#goal-yes,#goal-no').forEach(button=>button.disabled=!!(locked||s.sourceMode));
 s.host.querySelectorAll('#review-moves [data-path]').forEach(button=>button.disabled=!!(locked||(!s.finished&&!s.sourceMode)));
 s.onStateChange?.();
}
function updateStatus(s,message=''){
 if(!live(s)||!s.card)return;
 const el=s.host.querySelector('#attempt-status');if(!el)return;
 const finished=s.finished;
 let state='',label=message||(s.opening?t('Ouverture…'):s.working?t('Un instant…'):'');
 if(finished){
  state=s.revealed?'revealed':s.card.type==='play'&&s.goalAssessment===null?'pending':s.errors>0?'errors':s.assisted||s.hints?'assisted':'success';
  label={revealed:t('Réponse affichée · à revoir'),pending:t('Partie terminée · objectif à évaluer'),errors:t('Terminé avec erreurs'),assisted:t('Terminé avec aide'),success:t('Réussi !')}[state];
 }
 const counts=[s.errors?t(s.errors===1?'{count} erreur':'{count} erreurs',{count:s.errors}):'',s.hints?t(s.hints===1?'{count} aide':'{count} aides',{count:s.hints}):''].filter(Boolean);
 el.hidden=!label&&!counts.length&&!s.assisted;el.dataset.state=state;
 el.innerHTML=(label?ui('<strong>')+(finished?ui('<span class="review-result-icon" aria-hidden="true">')+(state==='success'?'✓':'●')+ui('</span>'):'')+esc(label)+ui('</strong>'):'')+(counts.length||s.assisted?ui('<div class="attempt-counts">')+counts.map(text=>ui('<span>')+esc(text)+ui('</span>')).join('')+(s.assisted?ui('<span class="badge">Assistée</span>'):'')+ui('</div>'):'')+(finished?ui('<small class="review-exploration-hint">Exploration libre · résultat conservé</small>'):'');
 const notebook=s.host.querySelector('.review-notebook');if(notebook)notebook.dataset.finished=String(finished);
 const workspace=s.host.querySelector('.review-workbench');if(workspace)workspace.dataset.exploring=String(finished);
 updateControls(s);
}
function renderMoves(s){
 if(!live(s)||!s.board)return;
 const list=s.host.querySelector('#review-moves');if(!list)return;
 // During the attempt only accepted moves are present. Free branches stay local.
 renderAnalysisMovesInto(list,s.board.doc,s.board.path,null,s.board.selectedVariation?.()?.path);
 list.querySelectorAll('[data-path]').forEach(button=>{
  button.disabled=(!s.finished&&!s.sourceMode)||s.working||s.opening;
  button.onclick=()=>{if(live(s)&&(s.finished||s.sourceMode)&&!s.working&&!s.opening)void s.board.go(button.dataset.path);};
 });
 const hint=s.host.querySelector('#review-move-hint');
 if(hint)hint.textContent=s.sourceMode?t('Consultation · tentative conservée'):s.card.type==='game'&&!s.finished?t('Les deux camps · {played}/{total} demi-coups',{played:s.ply,total:s.solutions[0]?.length||0}):s.finished?t('Explore librement les variantes'):s.card.type==='play'?t('Ta partie contre Stockfish'):t('La suite reste masquée');
 if(s.finished&&s.card.type!=='play')syncReviewCommentVisibility(s);
 s.layout?.refresh();
}
function scrollToFeedback(s){
 const content=s.host.querySelector('.review-content'),target=s.host.querySelector('#solution-panel');
 if(!content||!target||target.getClientRects?.().length===0)return;
 const pane=content.getBoundingClientRect?.(),box=target.getBoundingClientRect?.();
 if(pane&&box)content.scrollTop=Math.max(0,content.scrollTop+box.top-pane.top-8);
}
async function editEntry(s){
 if(!live(s)||s.working||s.opening||s.board.busy||s.board.inputLocked||!s.onEditEntry)return;
 const card=s.card,board=s.board;
 s.opening=true;updateStatus(s);
 try{
  const opened=await s.onEditEntry(card);
  if(live(s,card,board)&&opened===true&&!s.finished){s.assisted=true;s.hints++;}
 }catch(error){if(live(s,card,board))fail(error);}
 finally{if(live(s,card,board)){s.opening=false;updateStatus(s);}}
}
async function retry(s){
 if(!live(s)||s.working||s.opening||s.board.busy||s.board.inputLocked)return;
 const card=s.card,board=s.board,engineOn=board.engineOn;
 if(s.completion){s.startedAt=Date.now()-s.completion.elapsedMs;s.hiddenMs=0;s.hiddenAt=globalThis.document?.hidden?Date.now():null;}
 s.completion=null;board.training=true;
 s.errors++;s.ply=0;s.playHistory=[];s.solutions=solutions(card);s.finished=false;s.revealed=false;s.playTerminal=false;s.goalAssessment=null;s.completionMessage='';s.working=true;
 selectReviewTab(s,'exercise');updateControls(s);
 try{
  await board.setDoc(makeDoc(card.fen));
  if(!live(s,card,board))return;
  board.gameOver=false;board.result='*';
  s.host.querySelector('#grade-panel').hidden=true;s.host.querySelector('#solution-panel').hidden=true;
  // A retry with an already enabled engine is still assisted.
  if(engineOn)s.assisted=true;
  renderMoves(s);
 }catch(error){if(live(s,card,board))fail(error);}
 finally{if(live(s,card,board)){s.working=false;updateStatus(s,t('Nouvel essai'));}}
 if(live(s,card,board)&&card.type==='play'&&turn(board.node().fen)!==s.userSide)await engineTurn(s);
}
async function attempt(s,uci){
 if(!live(s)||s.working||s.opening||s.sourceMode||s.toolbarPaused)return;
 const card=s.card,board=s.board;
 if(s.finished){
  // No solution validation or opponent automation after completion. The board
  // keeps legal moves and sibling variations in its detached document.
  s.working=true;updateControls(s);
  try{await board.move(uci);}
  catch(error){if(live(s,card,board))fail(error);}
  finally{if(live(s,card,board)){s.working=false;updateControls(s);}}
  return;
 }
 if(card.type!=='game'&&turn(board.node().fen)!==s.userSide){updateStatus(s,t('C’est au moteur de jouer.'));return;}
 s.userWorked=true;
 if(card.type==='play'){
  s.working=true;updateControls(s);
  try{
   await board.move(uci);if(!live(s,card,board))return;
   s.playHistory.push(uci);
   if(board.gameOver){finishPlay(s,true);return;}
  }catch(error){if(live(s,card,board))fail(error);return;}
  finally{if(live(s,card,board)){s.working=false;updateControls(s);}}
  if(live(s,card,board))await engineTurn(s);
  return;
 }
 const candidates=s.solutions.filter(line=>line[s.ply]===uci);
 if(!candidates.length){playSound('incorrect');s.errors++;updateStatus(s,t('Ce coup ne correspond pas à la réponse attendue. Essaie encore.'));return;}
 s.working=true;updateControls(s);
 try{
  await board.move(uci);if(!live(s,card,board))return;
  s.solutions=candidates;s.ply++;playSound('correct');applyGameComment(s);
   if(s.solutions.some(line=>line.length===s.ply)){await complete(s);return;}
  while(card.type!=='game'&&turn(board.node().fen)!==s.userSide&&s.solutions[0]?.[s.ply]){
   const reply=s.solutions[0][s.ply];
   await board.move(reply);if(!live(s,card,board))return;
   s.solutions=s.solutions.filter(line=>line[s.ply]===reply);s.ply++;
  }
   if(s.solutions.some(line=>line.length===s.ply))await complete(s);
  else updateStatus(s,t('Bien. Continue la suite.'));
 }catch(error){if(live(s,card,board))fail(error);}
 finally{if(live(s,card,board)){s.working=false;updateControls(s);}}
}
async function engineTurn(s){
 if(!live(s)||s.finished||s.opening)return;
 const card=s.card,board=s.board;s.working=true;board.busy=true;board.renderBoard();updateStatus(s,t('Stockfish réfléchit…'));
 try{
  const r=await api('/api/engine/play',{method:'POST',body:{fen:board.node().fen,skill:Number(s.settings.skill??10),time_ms:750,history:s.playHistory,initial_fen:card.fen}});
  if(!live(s,card,board))return;
  board.busy=false;
  if(r.uci){await board.move(r.uci);if(!live(s,card,board))return;s.playHistory.push(r.uci);}
  if(r.game_over){board.result=r.result;board.gameOver=true;}
  if(r.game_over||board.gameOver)finishPlay(s,true);
 }catch(error){if(live(s,card,board)){fail(error);updateStatus(s,t('Le moteur ne peut pas répondre. Vérifie sa disponibilité.'));}}
 finally{if(live(s,card,board)){s.working=false;board.busy=false;board.renderBoard();updateControls(s);if(!s.finished)updateStatus(s);}}
}
async function reveal(s){
 if(!live(s)||s.working||s.opening||s.finished||s.toolbarPaused)return;
 const card=s.card,board=s.board;
 s.revealed=true;s.errors++;s.hints++;s.assisted=true;s.working=true;updateControls(s);
 try{
  const solution=s.solutions[0]||card.answers?.slice(0,1)||[];
  while(s.ply<solution.length){await board.move(solution[s.ply]);if(!live(s,card,board))return;s.ply++;applyGameComment(s);}
   await complete(s,t('Réponse affichée · à revoir.'));
 }catch(error){if(live(s,card,board))fail(error);}
 finally{if(live(s,card,board)){s.working=false;updateControls(s);}}
}
function enableExploration(s){
 if(!s.completion)s.completion=copy({doc:s.board.doc,path:s.board.path,
  result:s.board.result||'*',gameOver:!!s.board.gameOver,elapsedMs:activeElapsed(s)});
 if(s.board.training){s.board.training=false;s.board.render();}
}
function syncReviewCommentVisibility(s){
 const panel=s.host.querySelector('#solution-panel'),list=s.host.querySelector('#review-moves');if(!panel||!list)return;
 const clean=value=>String(value||'').replace(/\[%[^\]]*\]/g,'').replace(/\s+/g,' ').trim();
 const shown=new Set([...list.querySelectorAll('.analysis-move-comment')].map(node=>clean(node.textContent)));
 const paragraphs=[...panel.querySelectorAll('.explanation')];
 for(const paragraph of paragraphs)paragraph.classList.toggle('review-comment-in-notation',shown.has(clean(paragraph.textContent)));
 panel.dataset.commentsInNotation=String(paragraphs.length>0&&panel.children.length===paragraphs.length&&paragraphs.every(paragraph=>shown.has(clean(paragraph.textContent))));
}
function renderReviewComments(s,{loading=false,failed=false}={}){
 const panel=s.host.querySelector('#solution-panel');panel.hidden=false;
 panel.innerHTML=reviewExplanationComments(s.card.comment,s.completion?.finalComment).map(comment=>ui('<p class="explanation">')+esc(comment)+ui('</p>')).join('')+(loading?ui('<p class="hint" role="status">Chargement des commentaires PGN…</p>'):failed?ui('<p class="hint">Les commentaires PGN n’ont pas pu être chargés. Le résultat de l’exercice est conservé.</p><button type="button" data-review-comments-retry>Réessayer les commentaires</button>'):'');
 syncReviewCommentVisibility(s);
 const retry=panel.querySelector('[data-review-comments-retry]');if(retry)retry.onclick=()=>loadReviewComments(s);
}
async function loadReviewComments(s){
 if(!live(s)||!s.finished||s.card.type==='play')return;
 const card=s.card,board=s.board,completion=s.completion,sequence=s.commentLoadSequence=(s.commentLoadSequence||0)+1;
 const current=()=>live(s,card,board)&&s.finished&&s.completion===completion&&s.commentLoadSequence===sequence;
 renderReviewComments(s,{loading:!s.sourceDoc});
 try{
  const source=s.sourceDoc||await api('/api/reviews/'+encodeURIComponent(card.id)+'/source');if(!current())return;s.sourceDoc=source;
  const annotations=reviewSourceAnnotations(card,{doc:completion.doc,ply:s.ply},source);
  s.completion={...completion,doc:annotations.doc,finalComment:annotations.finalComment};
  // Keep exploratory branches. Only the accepted nodes receive source metadata.
  const accepted=new Map(annotations.doc.nodes.map(node=>[node.path,node]));
  const target=s.sourceMode&&s.sourceRestore?s.sourceRestore.doc:board.doc,annotated={...target,nodes:target.nodes.map(node=>{const source=accepted.get(node.path);return source&&source.uci===node.uci?{...node,comment:source.comment||'',starting_comment:source.starting_comment||'',nags:[...(source.nags||[])]}:node;})};
  if(s.sourceMode&&s.sourceRestore)s.sourceRestore.doc=annotated;else board.doc=annotated;
  renderMoves(s);renderReviewComments(s);s.onStateChange?.();
 }catch{if(current())renderReviewComments(s,{failed:true});}
}
function complete(s,message=t('Solution trouvée')){
 if(!live(s))return;
 if(!s.finished)playSound('complete');s.finished=true;s.completionMessage=message;enableExploration(s);selectReviewTab(s,'exercise');updateStatus(s,message);renderMoves(s);
 renderReviewComments(s);gradePanel(s);scrollToFeedback(s);void loadReviewComments(s);
}

function finishPlay(s,terminal=false){
 if(!live(s)||s.finished||s.opening||(s.working&&!terminal))return;
 s.finished=true;s.playTerminal=terminal;const result=s.board.result||'*',goal=s.settings.goal;let reached=null;
 if(terminal&&result!=='*'){
  if(goal==='draw')reached=result==='1/2-1/2'||(s.userSide==='white'?result==='1-0':result==='0-1');
  else reached=s.userSide==='white'?result==='1-0':result==='0-1';
  s.errors=reached?0:Math.max(1,s.errors);
 }
 s.goalAssessment=reached;
 renderPlayResult(s);
}
function renderPlayResult(s){
 enableExploration(s);
 selectReviewTab(s,'exercise');
 const terminal=s.playTerminal,result=s.completion.result,reached=s.goalAssessment;
 const panel=s.host.querySelector('#solution-panel');panel.hidden=false;
 panel.innerHTML=ui('<h2>Bilan de la position</h2><p>')+(terminal?ui('Résultat de la partie : <strong>')+esc(result)+ui('</strong>.'):t('La partie a été arrêtée avant un résultat définitif.'))+ui('</p><p class="hint">')+(terminal?t('Le résultat détermine si l’objectif est atteint.'):t('Évalue toi-même si tu as rempli l’objectif. Une évaluation du moteur ne confirme pas à elle seule une victoire ou une nulle.'))+ui('</p>')+(reached===null?ui('<div class="actions"><button id="goal-yes">Objectif atteint</button><button id="goal-no">À retravailler</button></div>'):'');
 updateStatus(s,terminal?t('Partie terminée'):reached===null?t('À toi d’évaluer la tentative'):reached?t('Objectif déclaré atteint.'):t('Position à retravailler.'));renderMoves(s);
 if(reached===null){
  panel.querySelector('#goal-yes').onclick=()=>{if(!live(s)||s.opening||s.working)return;s.goalAssessment=true;s.errors=0;gradePanel(s);updateStatus(s,t('Objectif déclaré atteint.'));};
  panel.querySelector('#goal-no').onclick=()=>{if(!live(s)||s.opening||s.working)return;s.goalAssessment=false;s.errors=Math.max(1,s.errors);gradePanel(s);updateStatus(s,t('Position à retravailler.'));};
 }else gradePanel(s);
 scrollToFeedback(s);
}
function gradePanel(s){
 const p=s.host.querySelector('#grade-panel');p.hidden=false;
 const grade=proposed(s),labels=[t('Manqué'),t('Difficile'),t('Bien'),t('Facile')],mode=s.settings.mode||'hybrid';
 p.innerHTML=(mode==='automatic'?'':ui('<h2>Évalue pour continuer</h2>'))+(mode==='automatic'?ui('<button class="primary" data-grade="')+grade+'">'+labels[grade]+ui(' · Continuer</button>'):ui('<div class="grade-buttons">')+labels.map((label,i)=>ui('<button data-grade="')+i+'" class="'+(i===grade?'suggested':'')+'"'+(mode==='hybrid'&&i===grade?ui(' title="Résultat proposé"'):'')+'>'+label+ui('</button>')).join('')+ui('</div>'));
 p.querySelectorAll('[data-grade]').forEach(button=>button.onclick=()=>gradeCard(s,Number(button.dataset.grade)));
 updateControls(s);
}
function showSessionComplete(s){
 s.finishedSession=true;disposeCard(s);s.host.classList.remove('review-page');
 s.onStateChange?.();
 s.host.innerHTML=ui('<div class="empty"><span class="empty-icon">✓</span><h1>Séance terminée</h1><p>')+esc(t(s.completed>1?'{count} exercices enregistrés dans {base}.':'{count} exercice enregistré dans {base}.',{count:s.completed,base:s.base.name}))+ui('</p>')+
  (s.resumeMessage?ui('<p role="status">')+esc(s.resumeMessage)+ui('</p>'):'')+
  (s.mastered?ui('<p class="muted">')+esc(t(s.maintenanceEnabled?'{count} exercices maîtrisés. Des rappels d’entretien espacés préservent ces acquis.':s.mastered>1?'{count} exercices maîtrisés, conservés dans les appris, sans nouvelles révisions.':'{count} exercice maîtrisé, conservé dans les appris, sans nouvelles révisions.',{count:s.mastered}))+ui('</p>'):'')+
  (s.completed>(s.mastered||0)?'<p class="muted">'+esc(s.mode==='daily'?t('Les prochaines reprises respectent les réglages de chaque base.'):t('Les prochaines reprises sont planifiées selon les réglages de cette base.'))+'</p>':'')+ui('<button id="session-done" class="primary">Retour aux révisions</button></div>');
 s.host.querySelector('#session-done').onclick=s.onClose;
}
function gradeCard(s,grade){
 if(s.pendingAction)return;
 return recordCard(s,'grade',{grade,errors:s.errors,hints:s.hints,assisted:s.assisted,elapsed_ms:s.completion?.elapsedMs??activeElapsed(s),proposed_grade:proposed(s)});
}
function masterCard(s){
 if(s.pendingAction||s.card.maintenance)return;
 // Mastery changes scheduling only. It does not invent a review grade or duration.
 return recordCard(s,'master',{});
}
function renderPendingAction(s){
 const p=s.host.querySelector('#grade-panel'),pending=s.pendingAction;p.hidden=false;
 const safe=!pending.rejected&&s.receiptSupport!==false&&!!pending.body.content_key;
 const refresh=!!s.session_id&&pending.rejected;
 const message=pending.rejected?t('Cette réponse n’a pas été acceptée. ')+(pending.message||t('La carte a changé.'))+t(refresh?' Actualise la séance pour continuer avec les exercices encore disponibles.':' Retourne aux révisions pour actualiser la séance.'):safe?t('La confirmation de la dernière réponse est en attente.'):t('Le serveur actuel ne permet pas de vérifier une réponse incertaine. Retourne aux révisions pour actualiser la liste.');
 p.innerHTML=ui('<p role="status">')+esc(message)+(pending.refreshError?' '+esc(pending.refreshError):'')+ui('</p><button type="button" data-retry-grade class="primary">')+(safe?t('Vérifier et continuer'):refresh?t('Actualiser la séance et continuer'):t('Retour aux révisions'))+ui('</button>');
 p.querySelector('[data-retry-grade]').onclick=()=>safe?recordCard(s,pending.action,pending.body):refresh?refreshRejectedSession(s):s.onClose?.();
}
async function refreshRejectedSession(s){
 if(!live(s)||s.working||s.opening||!s.pendingAction?.rejected)return;
 const snapshot=snapshotReview();if(!snapshot)return;
 const card=s.card,board=s.board;s.working=true;updateControls(s);
 const button=s.host.querySelector('[data-retry-grade]');if(button)button.disabled=true;
 try{
  const prepared=await prepareReviewResume(snapshot);
  if(!live(s,card,board))return;
  await resumeReview(s.host,prepared);
 }catch(error){if(live(s,card,board)){s.pendingAction.refreshError=error.message;s.onStateChange?.();renderPendingAction(s);}}
 finally{if(live(s,card,board)){s.working=false;updateControls(s);}}
}
async function recordCard(s,action,body){
 if(!live(s)||s.working||s.opening||s.pendingAction?.rejected||s.board.busy||(s.board.inputLocked&&!s.pendingAction))return;
 const card=s.card,board=s.board;
 if(!s.pendingAction){body={...body,...(s.sessionContextSupport&&s.session_id?{session_id:s.session_id,session_index:card.session_index}:{}),request_id:s.requestId||attemptId(),...(card.content_key?{content_key:card.content_key}:{})};s.pendingAction={action,body:copy(body),card_id:card.id,elapsedMs:body.elapsed_ms??s.completion?.elapsedMs??activeElapsed(s)};}
 const pending=s.pendingAction;s.working=true;s.recording=pending.action;updateControls(s);s.onStateChange?.();
 try{
  s.recordPromise=api('/api/reviews/'+encodeURIComponent(pending.card_id)+'/'+pending.action,{method:'POST',body:pending.body});
  const result=await s.recordPromise;
  if(!live(s,card,board))return;
  s.pendingAction=null;s.sessionElapsedMs=(s.sessionElapsedMs||0)+(pending.elapsedMs??pending.body.elapsed_ms??s.completion?.elapsedMs??0);s.completed=Math.max((s.completed||0)+1,result?.session_completed||0);if(pending.action==='master'||result?.state==='mastered')s.mastered=(s.mastered||0)+1;s.index++;
  s.working=false;s.recording=null;
  if(((s.goal?.minutes&&s.sessionElapsedMs>=s.goal.minutes*60000)||(s.goal?.cards&&s.completed>=s.goal.cards))&&(s.index<s.cards.length||hasNextBatch(s))){s.goalReached=true;showGoalReached(s);}
  else await advanceReview(s);
 }catch(error){if(live(s,card,board)){if([400,404,409,422].includes(error.status)){pending.rejected=true;pending.message=error.message;s.onStateChange?.();}fail(error);renderPendingAction(s);}}
 finally{s.recordPromise=null;if(live(s,card,board)){s.working=false;s.recording=null;updateControls(s);}}
}

function showGoalReached(s){
 disposeCard(s);s.host.classList.remove('review-page');s.onStateChange?.();
 s.host.innerHTML=ui('<div class="empty"><h1>Objectif de séance atteint</h1><p>Tu peux t’arrêter ici ou poursuivre la séance.</p><div class="actions"><button data-session-continue class="primary">Continuer</button><button data-session-stop>Retour aux révisions</button></div></div>');
 s.host.querySelector('[data-session-continue]').onclick=()=>{s.toolbarTargetMs=s.toolbarTargetMs||(Number(s.goal?.minutes)>0?Number(s.goal.minutes)*60000:null);s.goalReached=false;s.goal={minutes:null,cards:null};void advanceReview(s);};
 s.host.querySelector('[data-session-stop]').onclick=s.onPause||s.onClose;
}
async function advanceReview(s){
 if(active!==s||s.stopped)return;
 if(s.index<s.cards.length){await showCard(s);return;}
 if(!hasNextBatch(s)){showSessionComplete(s);return;}
 disposeCard(s);s.loadingBatch=true;s.batchError=null;s.onStateChange?.();
 s.host.innerHTML=ui('<div class="loading" role="status">Chargement de la suite…</div>');
 try{
  while(hasNextBatch(s)){
   const offset=s.next_offset,response=await api('/api/review-sessions/'+encodeURIComponent(s.session_id)+'?offset='+offset+'&limit=20');
   if(active!==s||s.stopped)return;
   s.cards=response.cards||[];s.index=0;s.next_offset=response.next_offset;s.total=response.total;s.completed=Math.max(s.completed||0,response.completed||0);s.sessionElapsedMs=Math.max(s.sessionElapsedMs||0,response.elapsed_ms||0);s.skipped=(s.skipped||0)+(response.skipped||[]).length;
   if(s.next_offset!=null&&s.next_offset<=offset)throw Error(t('La suite de la séance n’a pas pu être chargée.'));
   if(s.cards.length)break;
  }
  s.loadingBatch=false;
  if(s.cards.length)await showCard(s);else showSessionComplete(s);
 }catch(error){
  if(active!==s||s.stopped)return;s.loadingBatch=false;s.batchError=true;s.onStateChange?.();
  s.host.innerHTML=ui('<div class="empty"><p>La suite de la séance n’a pas pu être chargée.</p><p>')+esc(error.message)+ui('</p><button data-batch-retry>Réessayer</button><button data-batch-back>Retour aux révisions</button></div>');
  s.host.querySelector('[data-batch-retry]').onclick=()=>void advanceReview(s);s.host.querySelector('[data-batch-back]').onclick=s.onClose;
 }
}


function applyGameComment(s){
 if(s.card.type!=='game'||!s.sourceDoc)return;
 const source=s.sourceDoc.nodes.find(node=>node.path===Array(s.ply).fill('0').join('.'));
 if(source){const path=s.board.path;s.board.doc={...s.board.doc,nodes:s.board.doc.nodes.map(node=>node.path===path?{...node,comment:source.comment||'',nags:[...(source.nags||[])]}:node)};renderMoves(s);}
}

async function toggleReviewSource(s){
 if(!live(s)||s.working||s.opening||s.pendingAction||s.board.busy||s.toolbarPaused)return;
 const card=s.card,board=s.board;s.working=true;updateControls(s);
 try{
  if(s.sourceMode){
   const saved=s.sourceRestore;s.sourceMode=false;s.sourceRestore=null;
   board.training=!s.finished;await board.setDoc(saved.doc,saved.path);
   board.gameOver=saved.gameOver;board.result=saved.result;board.engineOn=saved.engineOn;board.render();if(board.engineOn)void board.analyse?.();
  }else{
   const doc=s.sourceDoc||await api('/api/reviews/'+encodeURIComponent(card.id)+'/source');
   if(!live(s,card,board))return;
   s.sourceDoc=doc;s.sourceRestore={doc:copy(board.doc),path:board.path,gameOver:!!board.gameOver,result:board.result||'*',engineOn:board.engineOn};
   s.sourceMode=true;board.training=false;board.engineOn=false;board.cancelAnalysis?.();
   await board.setDoc(copy(doc),doc.nodes.some(node=>node.path===card.path)?card.path:'');
  }
  if(!live(s,card,board))return;
  const button=s.host.querySelector('#toggle-review-source');button.textContent=s.sourceMode?t('Revenir au coup à réviser'):t('Ligne / PGN complet');button.setAttribute('aria-pressed',String(s.sourceMode));
  s.host.querySelector('.review-workbench').dataset.consulting=String(s.sourceMode);
  selectReviewTab(s,'moves');renderMoves(s);
 }catch(error){if(live(s,card,board))fail(error);}
 finally{if(live(s,card,board)){s.working=false;updateControls(s);}}
}
