import {openTrainingStatistics} from './training-statistics.js';
import {api,esc,modal,notice,option} from './api.js';
import {t,locale} from './i18n.js';
import {Board} from './board.js';
import {nodeIndex,serialize} from './chess-document.js';
import {renderAnalysisMovesInto} from './analysis-moves.js';
import {TrainingHistoryView} from './training-history.js';

const endpoint='/api/computer';
const copy=value=>structuredClone(value);
const existingCopies=game=>(game.copies||[]).filter(link=>link.entry_id!=null);
const number=value=>Number(value||0).toLocaleString(locale());
const resultLabel=game=>game.finished?game.result||'*':t('En cours');
const dateLabel=value=>{const date=new Date(value);return value&&Number.isFinite(date.valueOf())?date.toLocaleString(locale(),{dateStyle:'medium',timeStyle:'short'}):'—';};
const reasonLabel=reason=>t(({checkmate:'Échec et mat',stalemate:'Pat',insufficient_material:'Matériel insuffisant',fifty_moves:'Règle des 50 coups',threefold_repetition:'Triple répétition',seventyfive_moves:'Règle des 75 coups',fivefold_repetition:'Quintuple répétition',resignation:'Abandon',timeout:'Temps écoulé',timeout_insufficient_material:'Temps écoulé · matériel insuffisant'})[reason]||'Partie terminée');

export function computerTimeControlLabel(value){
 if(value==null||value==='-'||value==='*'||value==='none'||value==='unlimited')return t('Sans limite');
 if(typeof value==='object'){
  const initial=Number(value.initial_ms??value.base_ms??(value.minutes!=null?value.minutes*60000:null)),increment=Number(value.increment_ms??(value.increment!=null?value.increment*1000:0));
  return initial>0?`${number(initial/60000)} + ${number(increment/1000)}`:t('Sans limite');
 }
 const match=String(value).match(/^(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?$/);
 return match&&Number(match[1])>0?`${number(Number(match[1])/60)} + ${number(Number(match[2]||0))}`:String(value);
}
export function personalComputerBases(bases=[]){return bases.filter(base=>!base.reference);}
export function computerHistoryRowsHtml(items=[]){
 return items.map(game=>{
  const id=esc(game.id),finished=!!game.finished,human=game.side==='black'?'black':'white',status=resultLabel(game),copies=existingCopies(game),outcome=!finished?'ongoing':game.result==='1/2-1/2'?'draw':game.result===(human==='white'?'1-0':'0-1')?'won':'lost';
  return `<tr data-computer-game="${id}"><td class="computer-history-players"><span><i aria-hidden="true">♙</i><b${human==='white'?' class="human"':''}>${esc(game.white||'—')}</b></span><span><i aria-hidden="true">♟</i><b${human==='black'?' class="human"':''}>${esc(game.black||'—')}</b></span></td><td class="computer-history-date">${esc(dateLabel(game.created_at))}</td><td class="computer-history-cadence">${esc(computerTimeControlLabel(game.time_control))}</td><td class="computer-history-result"><span class="computer-history-result-label ${outcome}"${finished?` title="${esc(reasonLabel(game.reason))}"`:''}>${esc(status)}</span><small>${esc(t(Number(game.moves)===1?'1 coup':'{count} coups',{count:number(game.moves)}))}</small>${game.auto_copy_error?`<small class="computer-copy-warning" title="${esc(game.auto_copy_error)}">${esc(t('Copie à vérifier'))}</small>`:''}</td><td class="computer-history-actions"><button data-history-view="${id}">${esc(t('Revoir'))}</button>${!finished?`<button data-history-resume="${id}">${esc(t('Reprendre'))}</button>`:''}<button data-history-analyse="${id}">${esc(t('Analyser'))}</button><button data-history-copy="${id}"${copies.length?` title="${esc(t('Déjà copiée dans {count} base(s)',{count:number(copies.length)}))}"`:''}>${copies.length?'<span aria-hidden="true">✓ </span>':''}${esc(t('Copier…'))}</button></td></tr>`;
 }).join('');
}
export function computerHistoryPaginationHtml({offset=0,limit=25,total=0}={}){
 return `<footer class="computer-history-pagination"><span>${esc(total?t('{start}–{end} sur {total}',{start:number(offset+1),end:number(Math.min(offset+limit,total)),total:number(total)}):t('Aucune partie'))}</span><div><button data-history-page="${Math.max(0,offset-limit)}" ${offset<=0?'disabled':''} aria-label="${esc(t('Page précédente'))}">‹</button><button data-history-page="${offset+limit}" ${offset+limit>=total?'disabled':''} aria-label="${esc(t('Page suivante'))}">›</button></div></footer>`;
}
export function computerCopySettingsHtml(settings,bases){
 bases=personalComputerBases(bases);
 const enabled=!!settings.auto_copy,selected=bases.some(base=>Number(base.id)===Number(settings.base_id))?settings.base_id:'';
 return `<div class="computer-copy-settings"><label class="computer-check"><input type="checkbox" name="auto_copy" ${enabled?'checked':''} ${bases.length?'':'disabled'}><span>${esc(t('Copier automatiquement les parties terminées'))}</span></label><label>${esc(t('Base de destination'))}<select name="base_id" ${enabled&&bases.length?'required':'disabled'}>${option('',t('Choisir une base'),selected)}${bases.map(base=>option(base.id,base.name,selected)).join('')}</select></label>${bases.length?'':`<p class="hint">${esc(t('Crée d’abord une base d’étude dans la bibliothèque.'))}</p>`}<p class="hint">${esc(t('Toutes tes parties sont conservées dans l’historique du mode ordinateur. Cette option ajoute une copie dans la base choisie lorsqu’une partie se termine.'))}</p><p class="hint">${esc(t('Une seule copie par partie et par base. Les parties déjà terminées ne sont pas copiées rétroactivement.'))}</p></div>`;
}
async function resolveBases(bases,request){return personalComputerBases(typeof bases==='function'?await bases():Array.isArray(bases)?bases:(await request('/api/library')).bases||[]);}
export async function openComputerSettings({bases,onSaved=null,isCurrent=()=>true,request=api}={}){
 const [settings,available]=await Promise.all([request(endpoint+'/settings'),resolveBases(bases,request)]);if(!isCurrent())return null;
 const dialog=modal(t('Réglages du mode ordinateur'),computerCopySettingsHtml(settings,available),{onSubmit:async data=>{
  if(!isCurrent())return;
  const enabled=data.has('auto_copy'),base=Number(data.get('base_id'))||null;
  if(enabled&&!available.some(item=>Number(item.id)===base))throw new Error(t('Choisis une base de destination.'));
  const updated=await request(endpoint+'/settings',{method:'PATCH',body:{auto_copy:enabled,base_id:enabled?base:null,expected_revision:settings.revision}});
  if(!isCurrent())return;
  await onSaved?.(updated);notice(t('Réglages du mode ordinateur enregistrés.'));
 }});
 const enabled=dialog.querySelector('[name="auto_copy"]'),select=dialog.querySelector('[name="base_id"]');
 enabled.onchange=()=>{select.disabled=!enabled.checked;select.required=enabled.checked;};
 return dialog;
}

// Viewing or analysing an archive never starts the opponent or modifies the
// retained game. Resume is a separate, explicit action owned by the app.
export class ComputerHistoryView {
 constructor(host,{onResume=null,onAnalyse=null,onBack=null,bases=null,onSettings=null,onStatistics=null,request=api}={}){
  Object.assign(this,{host,onResume,onAnalyse,onBack,bases,onSettings,onStatistics,request});this.offset=0;this.limit=25;this.total=0;this.items=[];this.board=null;this.archive=null;this.disposed=false;this.sequence=0;this.controller=null;this.busy=false;this.error='';
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.statisticsDialog?.close();this.sequence++;this.controller?.abort();this.historyView?.dispose();this.board?.dispose();this.board=null;this.host.classList.remove('computer-history-page','computer-page','computer-game-finished');}
 async load(offset=this.offset){
  if(this.disposed)return;this.historyView?.dispose();this.historyView=null;this.board?.dispose();this.board=null;this.archive=null;this.items=[];this.busy=false;this.error='';this.offset=Math.max(0,Number(offset)||0);
  this.host.classList.add('computer-page','computer-history-page');this.host.classList.remove('computer-game-finished');
  this.renderList();const history=this.historyView;await history.load(this.offset);if(!this.disposed&&this.historyView===history)this.offset=history.offset;
 }
 heading(title=t('Historique contre l’ordinateur')){
  return `<header class="computer-heading training-header"><h1>${esc(title)}</h1><nav class="tabs training-tabs computer-heading-actions" aria-label="${esc(t('Jouer contre l’ordinateur'))}">${this.onBack?`<button class="training-tab" type="button" data-history-back>${esc(t('Jouer'))}</button>`:''}<span class="training-tab" aria-current="page">${esc(t('Historique'))}</span><button class="training-tab" type="button" data-history-statistics aria-haspopup="dialog">${esc(t('Statistiques'))}</button>${this.onSettings?`<button class="training-tab" type="button" data-history-settings aria-haspopup="dialog" aria-label="${esc(t('Réglages du mode ordinateur'))}">${esc(t('Réglages'))}</button>`:''}</nav></header>`;
 }
 bindHeading(){
  this.host.querySelector('[data-history-statistics]')?.addEventListener('click',()=>this.run(()=>this.showStatistics()));
  this.host.querySelector('[data-history-back]')?.addEventListener('click',()=>this.run(()=>this.onBack?.()));
  this.host.querySelector('[data-history-settings]')?.addEventListener('click',()=>this.run(()=>this.onSettings?.()));
 }
 async showStatistics(){
  if(this.disposed||this.statisticsDialog?.open)return;
  const dialog=await (this.onStatistics?this.onStatistics():openTrainingStatistics({tool:'computer',request:this.request}));
  if(!dialog)return;if(this.disposed)dialog.close();else this.statisticsDialog=dialog;
 }
 errorHtml(){return `<p data-history-error class="computer-error" role="alert"${this.error?'':' hidden'}>${esc(this.error)}</p>`;}
 renderList(){
  if(this.disposed)return;this.historyView?.dispose();
  this.host.innerHTML=this.heading()+`<section class="panel computer-history-panel">${this.errorHtml()}<div data-training-history-table></div></section>`;
  this.bindHeading();
  this.historyView=new TrainingHistoryView(this.host.querySelector('[data-training-history-table]'),{tool:'computer',embedded:true,request:this.request,onOpen:record=>this.run(()=>this.view(record.id))});
 }
 async run(action){
  if(this.disposed||this.busy)return;this.busy=true;this.error='';this.showError();
  try{await action();}catch(error){if(!this.disposed&&error.name!=='AbortError'){this.error=error.message||String(error);this.showError();}}
  finally{this.busy=false;}
 }
 showError(){const error=this.host.querySelector('[data-history-error]');if(error){error.textContent=this.error;error.hidden=!this.error;}}
 async document(id){
  if(this.archive?.id===id)return copy(this.archive);
  const result=await this.request(endpoint+'/games/'+encodeURIComponent(id));return this.disposed?null:result;
 }
 archiveDoc(archive){
  const session=archive.snapshot?.session;if(!session?.position?.doc)throw new Error(t('La partie archivée est incomplète.'));
  const doc=copy(session.position.doc);doc.headers={...doc.headers,...session.headers,Result:archive.result||session.headers?.Result||'*'};delete doc.id;delete doc.base_id;doc.pgn=archive.pgn||serialize(doc);return doc;
 }
 async resume(id){const archive=await this.document(id);if(!archive||this.disposed)return;if(archive.finished_at||archive.result&&archive.result!=='*')return this.view(id);await this.onResume?.(copy(archive.snapshot),archive);}
 async analyse(id){const archive=await this.document(id);if(!archive||this.disposed)return;await this.onAnalyse?.({doc:this.archiveDoc(archive),path:this.archive?.id===id?this.board?.path||'':archive.snapshot.session.position.path||''});}
 async openTrainingRecord(record){return this.view(record.id);}
 async view(id){
  const archive=await this.document(id);if(!archive||this.disposed)return;const doc=this.archiveDoc(archive);this.historyView?.dispose();this.historyView=null;this.board?.dispose();this.board=null;this.archive=archive;
  const session=archive.snapshot.session,finished=!!archive.finished_at||archive.result!=='*',path=archive.snapshot.displayPath||session.position.path||'';
  this.host.classList.add('computer-game-finished');
  this.host.innerHTML=this.heading()+`<div class="computer-history-detail-heading"><button data-history-list>‹ ${esc(t('Historique'))}</button><span>${esc(dateLabel(archive.created_at))} · ${esc(computerTimeControlLabel(doc.headers.TimeControl))}</span></div><div class="computer-workspace"><div class="computer-board-column"><div data-history-board></div></div><section class="panel computer-game-panel"><div class="computer-history-match"><span><i aria-hidden="true">♙</i><b>${esc(doc.headers.White||'—')}</b></span><span><i aria-hidden="true">♟</i><b>${esc(doc.headers.Black||'—')}</b></span><strong>${esc(finished?archive.result:t('En cours'))}</strong></div>${this.errorHtml()}<div data-history-moves class="computer-moves"></div><footer class="computer-actions">${!finished&&this.onResume?`<button data-detail-resume>${esc(t('Reprendre la partie'))}</button>`:''}${this.onAnalyse?`<button data-detail-analyse>${esc(t('Analyser la partie'))}</button>`:''}<button data-detail-copy>${esc(t('Copier dans une base…'))}</button></footer></section></div>`;
  this.bindHeading();this.host.querySelector('[data-history-list]').onclick=()=>this.load();
  this.board=new Board(this.host.querySelector('[data-history-board]'),{doc,path:nodeIndex(doc).has(path)?path:'',flipped:session.side==='black',training:false,onChange:()=>this.renderMoves()});
  this.board.tryMove=async()=>false;this.board.click=async()=>{};const pointerDown=this.board.pointerDown.bind(this.board);this.board.pointerDown=event=>{if(event.button!==0)pointerDown(event);};this.board.renderBoard();this.renderMoves();
  this.host.querySelector('[data-detail-resume]')?.addEventListener('click',()=>this.run(()=>this.resume(id)));
  this.host.querySelector('[data-detail-analyse]')?.addEventListener('click',()=>this.run(()=>this.analyse(id)));
  this.host.querySelector('[data-detail-copy]').onclick=()=>this.run(()=>this.copyToBase(id));
 }
 renderMoves(){if(!this.board||this.disposed)return;const host=this.host.querySelector('[data-history-moves]');renderAnalysisMovesInto(host,this.board.doc,this.board.path);host.querySelectorAll('[data-path]').forEach(button=>button.onclick=()=>this.board.go(button.dataset.path));}
 async copyToBase(id){
  const available=await resolveBases(this.bases,this.request);if(this.disposed)return;
  const archive=await this.document(id);if(!archive||this.disposed)return;
  const copied=new Set(existingCopies(archive).map(item=>Number(item.base_id))),first=available.find(base=>!copied.has(Number(base.id)))?.id||available[0]?.id;
  modal(t('Copier la partie dans une base'),`<div class="computer-copy-settings"><label>${esc(t('Base de destination'))}<select name="base_id" required ${available.length?'':'disabled'}>${available.map(base=>option(base.id,base.name+(copied.has(Number(base.id))?' · '+t('Déjà copiée'):''),first)).join('')}</select></label><p class="hint">${esc(t('Copie la partie dans son état actuel. Les copies existantes ne sont pas écrasées.'))}</p>${available.length?'':`<p>${esc(t('Crée d’abord une base d’étude dans la bibliothèque.'))}</p>`}</div>`,{...(available.length?{submit:t('Copier'),onSubmit:async data=>{
   if(this.disposed)return;
   const result=await this.request(endpoint+'/games/'+encodeURIComponent(id)+'/copy',{method:'POST',body:{base_id:Number(data.get('base_id'))}});if(this.disposed)return;
   // Copy returns a link, not the archived game. Keep its full snapshot intact.
   const link={base_id:result.base_id,entry_id:result.entry_id};
   const update=game=>{if(game){game.copies=[...(game.copies||[]).filter(item=>item.entry_id!==link.entry_id&&item.base_id!==link.base_id),link];}};
   if(this.archive?.id===id)update(this.archive);
   update(this.items.find(game=>game.id===id));
   if(!this.archive)await this.load();notice(t(result.created?'Partie copiée dans la base.':'Cette partie a déjà été copiée. Sa copie existante est conservée.'));
  }}:{})});
 }
}
