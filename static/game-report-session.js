import {t} from './i18n.js';
import {api,esc} from './api.js';
import {Board} from './board.js';
import {makeDoc,appendLine,pieces} from './chess-document.js';
import {analysisMovesHtml} from './analysis-moves.js';
import {observeAnalysisLayout} from './analysis-layout.js';

// A separate, disposable document uses the same board area. Neither retry nor
// comparison can call the source board's editing, history or draft callbacks.
export class GameReportSession {
 constructor({board,workbench,finding,fingerprint,kind='retry',onResult=()=>{},onClose=()=>{}}){
  this.original=board;this.workbench=workbench;this.finding=structuredClone(finding);this.fingerprint=fingerprint;this.onResult=onResult;this.onClose=onClose;
  this.entryId=board.doc.id;this.disposed=false;this.busy=false;this.attempts=0;this.outcome='cancelled';this.mode=kind;this.feedback='';this.hinted=false;this.sequence=0;
  this.saved={inputLocked:board.inputLocked,engineOn:board.engineOn};board.inputLocked=true;board.cancelAnalysis();board.cancelDrag();board.clearPreview(false);board.engineOn=false;
  this.disabled=[...document.querySelectorAll('.analysis-page>.page-title [data-action],#analysis-command-dock [data-action]')].map(element=>({element,disabled:element.disabled}));this.disabled.forEach(({element})=>element.disabled=true);
  this.container=document.createElement('section');this.container.className='report-session-board';
  this.container.innerHTML='<div data-session-board></div><div class="report-session-controls" data-session-controls aria-live="polite"></div>';
  board.host.after(this.container);this.boardHost=this.container.querySelector('[data-session-board]');this.controls=this.container.querySelector('[data-session-controls]');
  this.notebook=document.createElement('section');this.notebook.className='report-session-notebook';this.notebook.innerHTML='<div class="report-session-intro"></div><div data-session-engine></div><div class="report-session-moves"></div>';
  workbench.querySelector('.analysis-notebook').append(this.notebook);workbench.classList.add('report-session-active');
  this.board=new Board(this.boardHost,{doc:makeDoc(finding.fen),flipped:finding.side==='black',training:kind==='retry',engineHost:this.notebook.querySelector('[data-session-engine]'),onMove:kind==='retry'?(uci)=>this.attempt(uci):null,onChange:()=>this.renderMoves()});
  this.clickHandler=event=>{const button=event.target.closest('[data-report-session]');if(!button||button.disabled)return;this.action(button.dataset.reportSession).catch(error=>{if(!this.disposed){this.feedback=error.message;this.render();}});};
  this.container.addEventListener('click',this.clickHandler);this.notebook.addEventListener('click',this.clickHandler);
  this.moveHandler=event=>{const move=event.target.closest('[data-path]');if(move&&this.mode!=='retry'&&!this.busy)this.board.go(move.dataset.path);};this.notebook.addEventListener('click',this.moveHandler);
  this.render();this.layout=observeAnalysisLayout(workbench,this.boardHost,{extraToolbar:this.controls});
  this.ready=kind==='retry'?Promise.resolve(true):this.showLine(kind);
 }
 emit(outcome,final=false){this.outcome=outcome;this.onResult({outcome,attempts:this.attempts,hinted:this.hinted,final});}
 render(){
  if(this.disposed)return;const searching=this.mode==='retry';this.workbench.classList.toggle('report-session-searching',searching);
  const title=searching?t('À toi de jouer'):this.mode==='played'?t('Le coup joué'):t('Une meilleure suite');
  const feedback=this.busy?t('Vérification du coup…'):this.feedback|| (searching?t('Trouve un meilleur coup. Ton analyse reste conservée.'):t('Explore cette copie, puis retourne à ta partie.'));
  this.controls.innerHTML='<div class="report-session-status"><strong>'+esc(title)+'</strong><span role="status">'+esc(feedback)+'</span></div><div class="report-session-actions">'+(searching?'<button type="button" data-report-session="hint" '+(this.busy?'disabled':'')+'>'+esc(t('Indice'))+'</button><button type="button" data-report-session="reveal" '+(this.busy?'disabled':'')+'>'+esc(t('Voir la solution'))+'</button>':'<button type="button" data-report-session="reset" '+(this.busy?'disabled':'')+'>'+esc(t('Réessayer'))+'</button><button type="button" data-report-session="'+(this.mode==='played'?'alternative':'played')+'" '+(this.busy?'disabled':'')+'>'+esc(this.mode==='played'?t('Voir l’alternative'):t('Voir le coup joué'))+'</button>')+'<button type="button" class="primary" data-report-session="finish">'+esc(t('Retour à la partie'))+'</button></div>';
  this.notebook.querySelector('.report-session-intro').innerHTML=searching?'<div class="report-session-focus"><span class="report-session-orbit" aria-hidden="true">?</span><span class="report-session-eyebrow">'+esc(t('Un moment à comprendre'))+'</span><h3>'+esc(t('Quelle serait ta décision ?'))+'</h3><p>'+esc(t('Les coups et le moteur restent masqués pendant ta recherche.'))+'</p><div class="report-session-steps"><span>'+esc(t('Chercher'))+'</span><span>'+esc(t('Comparer'))+'</span><span>'+esc(t('Retenir'))+'</span></div></div>':'<div class="report-session-note"><strong>'+esc(t('Exploration temporaire'))+'</strong><p>'+esc(t('Les coups joués ici ne modifient ni la partie ni son brouillon.'))+'</p></div>';
  this.notebook.querySelector('[data-session-engine]').hidden=searching;this.renderMoves();this.layout?.refresh();
 }
 renderMoves(){if(this.disposed)return;const host=this.notebook.querySelector('.report-session-moves');host.hidden=this.mode==='retry';if(!host.hidden)host.innerHTML=analysisMovesHtml(this.board.doc,this.board.path);}
 async attempt(uci){
  if(this.disposed||this.busy||this.mode!=='retry')return;this.busy=true;this.attempts++;const seq=++this.sequence;this.controller?.abort();this.controller=new AbortController();this.render();
  try{const result=await api('/api/game-analysis/'+this.entryId+'/retry',{method:'POST',body:{ply:this.finding.ply,uci,fingerprint:this.fingerprint},signal:this.controller.signal});if(this.disposed||seq!==this.sequence)return;
   if(result.accepted){this.feedback=t('Bien trouvé ! Tu peux maintenant comparer les suites.');this.emit('solved');this.mode='alternative';this.board.training=false;this.board.onMove=null;await this.board.move(uci);}
   else{this.feedback=t('Il existe un coup plus solide. Essaie encore.');this.emit('missed');}
  }catch(error){if(!this.disposed&&seq===this.sequence&&error.name!=='AbortError')this.feedback=error.message;}
  finally{if(!this.disposed&&seq===this.sequence){this.busy=false;this.render();}}
 }
 async showLine(kind){
  if(this.disposed||this.busy)return false;this.busy=true;const seq=++this.sequence;this.controller?.abort();this.controller=new AbortController();this.feedback='';this.render();
  const moves=(kind==='played'?[this.finding.uci,...(this.finding.after?.pv||[])]:this.finding.pv?.length?this.finding.pv:[this.finding.best_uci]).filter(Boolean).slice(0,16);
  try{const result=await api('/api/line',{method:'POST',body:{fen:this.finding.fen,moves},signal:this.controller.signal});if(this.disposed||seq!==this.sequence)return false;
   const applied=appendLine(makeDoc(this.finding.fen),'',result.positions);this.mode=kind;this.board.training=false;this.board.onMove=null;await this.board.setDoc(applied.doc,applied.doc.nodes[1]?.path||'');if(this.disposed)return false;
   if(this.outcome!=='solved')this.emit('revealed');return true;
  }catch(error){if(!this.disposed&&seq===this.sequence&&error.name!=='AbortError')this.feedback=error.message;return false;}
  finally{if(!this.disposed&&seq===this.sequence){this.busy=false;this.render();}}
 }
 async action(action){
  if(this.disposed)return;if(action==='finish'){this.dispose();return;}if(this.busy)return;
  if(action==='hint'){
   this.hinted=true;this.onResult({outcome:this.outcome,attempts:this.attempts,hinted:true,final:false,hintOnly:true});const piece=pieces(this.finding.fen)[String(this.finding.best_uci||'').slice(0,2)]?.toLowerCase(),labels={p:t('un pion'),n:t('un cavalier'),b:t('un fou'),r:t('une tour'),q:t('la dame'),k:t('le roi')};
   this.feedback=labels[piece]?t('Essaie de jouer avec {piece}.',{piece:labels[piece]}):t('Cherche les échecs, les prises et les menaces.');this.render();return;
  }
  if(action==='reveal'||action==='alternative'||action==='played')return this.showLine(action==='played'?'played':'alternative');
  if(action==='reset'){
   const seq=++this.sequence;this.busy=true;this.controller?.abort();this.board.cancelAnalysis();this.board.engineOn=false;this.board.training=true;this.board.onMove=uci=>this.attempt(uci);this.mode='retry';this.feedback='';this.emit('reset');this.render();
   try{await this.board.setDoc(makeDoc(this.finding.fen),'');}
   finally{if(!this.disposed&&seq===this.sequence){this.busy=false;this.render();}}
  }
 }
 dispose({restore=true}={}){
  if(this.disposed)return;this.disposed=true;this.sequence++;this.controller?.abort();this.layout?.disconnect();this.board.dispose();this.container.removeEventListener('click',this.clickHandler);this.notebook.removeEventListener('click',this.clickHandler);this.notebook.removeEventListener('click',this.moveHandler);this.container.remove();this.notebook.remove();this.workbench.classList.remove('report-session-active','report-session-searching');
  this.disabled.forEach(({element,disabled})=>element.disabled=disabled);this.original.inputLocked=this.saved.inputLocked;this.original.engineOn=this.saved.engineOn;
  if(restore&&!this.original.disposed){this.original.renderBoard();this.original.renderEngine();if(this.saved.engineOn)void this.original.analyse();}
  this.onResult({outcome:this.outcome==='reset'?'cancelled':this.outcome,attempts:this.attempts,hinted:this.hinted,final:true});this.onClose(this,{restore});
 }
}
