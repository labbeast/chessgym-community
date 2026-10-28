import {t,ui,locale} from './i18n.js';
import {api,esc,option,fail} from './api.js';
import {Board,makeDoc,serialize} from './board.js';
import {MoveMenu,AnalysisHistory} from './move-menu.js';
import {renderAnalysisMovesInto,analysisMovesHtml,followAnalysisMove} from './analysis-moves.js';

const NAGS=[[1,'!'],[2,'?'],[3,'!!'],[4,'??'],[5,'!?'],[6,'?!'],[10,'='],[14,'+/='],[15,'=/+'],[16,'+/-'],[17,'-/+'],[18,'+-'],[19,'-+']];
let activeEditor=null;

function exerciseDraft(initialDoc,sourceFen){
 if(initialDoc==null)return makeDoc(sourceFen);
 const invalid=()=>{throw new Error(t('La solution fournie pour cet exercice est invalide.'));};
 if(typeof initialDoc!=='object'||Array.isArray(initialDoc))invalid();
 let draft;try{draft=structuredClone(initialDoc);}catch{invalid();}
 if(!draft.headers||typeof draft.headers!=='object'||Array.isArray(draft.headers)||!Array.isArray(draft.nodes)||!draft.nodes.length)invalid();
 const nodes=new Map();
 for(const node of draft.nodes){
  if(!node||typeof node.path!=='string'||typeof node.fen!=='string'||node.fen.trim().split(/\s+/).length!==6||!Array.isArray(node.children)||nodes.has(node.path))invalid();
  if((node.comment!=null&&typeof node.comment!=='string')||(node.starting_comment!=null&&typeof node.starting_comment!=='string')||(node.nags!=null&&(!Array.isArray(node.nags)||node.nags.some(nag=>!Number.isInteger(nag)||nag<0))))invalid();
  if(node.path!==''&&(typeof node.parent!=='string'||typeof node.san!=='string'||!node.san||typeof node.uci!=='string'||!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(node.uci)))invalid();
  nodes.set(node.path,node);
 }
 const root=nodes.get('');if(!root||draft.nodes[0]!==root||root.parent!==null)invalid();
 if(root.fen!==sourceFen)throw new Error(t('La solution ne commence pas à la position choisie.'));
 const seen=new Set(),pending=[root];
 while(pending.length){
  const node=pending.pop();if(seen.has(node.path))invalid();seen.add(node.path);
  for(const path of node.children){const child=nodes.get(path);if(typeof path!=='string'||!child||child.parent!==node.path)invalid();pending.push(child);}
 }
 if(seen.size!==nodes.size)invalid();
 for(const key of ['id','base_id','history','created_at','updated_at'])delete draft[key];
 draft.start_path='';draft.pgn=serialize(draft);return draft;
}

// The chosen position and optional complete solution are detached before opening.
// Navigation, history and engine belong to this dialog for its entire lifetime.
export function openExerciseEditor(options={}){
 if(activeEditor&&!activeEditor.disposed){activeEditor.dialog.focus();return activeEditor;}
 const editor=new ExerciseEditor(options);activeEditor=editor;return editor;
}

export class ExerciseEditor {
 constructor({sourceDoc,sourcePath='',flipped=false,bases=[],baseId=null,onCreated=null,onClosed=null,initialDoc=null,initialTitle=t('Position à travailler'),newBaseName=t('Mes erreurs'),allowNewBase=true,sourceLink=null}={}){
  const source=sourceDoc?.nodes?.find(node=>node.path===sourcePath);
  if(!source?.fen)throw new Error(t('La position de départ de cet exercice est introuvable.'));
  this.sourceLink=sourceLink?structuredClone(sourceLink):null;this.sourceFen=String(source.fen);this.bases=structuredClone(bases.filter(base=>!base.reference));this.onCreated=onCreated;this.onClosed=onClosed;
  const draft=exerciseDraft(initialDoc,this.sourceFen);
  this.allowNewBase=allowNewBase;this.saving=false;this.editing=false;this.disposed=false;this.createdEntry=null;this.createdBase=null;this.editController=null;this.listeners=[];this.pendingAnnotation=null;
  const selected=baseId==='new'&&allowNewBase?'new':this.bases.find(base=>String(base.id)===String(baseId))?.id??this.bases.find(base=>base.settings?.review_enabled&&base.settings?.type==='solve')?.id??this.bases[0]?.id??'new';
  this.dialog=document.createElement('dialog');this.dialog.className='exercise-editor-dialog';this.dialog.setAttribute('aria-labelledby','exercise-editor-title');this.dialog.tabIndex=-1;
  this.dialog.innerHTML=ui('<div class="exercise-editor-shell"><header class="exercise-editor-header"><div><h2 id="exercise-editor-title">Créer un exercice</h2><p>')+esc(t(initialDoc==null?'Joue les coups de ta solution. Reviens en arrière pour ajouter une variante.':'La solution est préremplie. Tu peux la modifier ou ajouter des variantes.'))+ui('</p></div><button type="button" data-exercise-action="close" aria-label="Fermer">×</button></header><div class="exercise-editor-destination"><label>Titre<input name="title" maxlength="200" value="')+esc(initialTitle)+ui('" autocomplete="off"></label><label>Base de destination<select name="base_id">')+this.bases.map(base=>option(base.id,base.name,selected)).join('')+(allowNewBase?option('new',t('＋ Créer une base'),selected):'')+ui('</select></label><label data-new-base>Nom de la nouvelle base<input name="base_name" maxlength="200" value="')+esc(newBaseName)+ui('" autocomplete="off"></label><p class="hint exercise-editor-base-note" data-base-note></p></div><div class="exercise-editor-workbench"><section class="exercise-editor-board" aria-label="Position et solution de l’exercice"><div data-exercise-board></div></section><section class="exercise-editor-notebook" aria-label="Solution et analyse"><div data-exercise-engine></div><div class="exercise-editor-notation-head"><strong>Solution & variantes</strong><div class="actions"><button type="button" data-exercise-action="root" title="Revenir au diagramme initial">Départ</button><button type="button" data-exercise-action="undo" title="Annuler · Ctrl+Z" aria-label="Annuler">↶</button><button type="button" data-exercise-action="redo" title="Rétablir · Ctrl+Maj+Z" aria-label="Rétablir">↷</button><button type="button" data-exercise-action="menu" title="Actions du coup sélectionné · clic droit" aria-label="Actions du coup sélectionné" aria-haspopup="menu">⋮</button></div></div><div class="exercise-editor-moves" data-exercise-moves></div><details class="exercise-editor-annotations"><summary>Commentaire / annotations · <span data-annotation-position>Position initiale</span></summary><label class="exercise-editor-comment-label">Commentaire de la position<textarea name="comment" rows="3" maxlength="8000" placeholder="Idée, justification, piège…"></textarea></label><div class="nag-grid">')+NAGS.map(([id,label])=>'<label><input type="checkbox" name="nag" value="'+id+'"><span>'+label+'</span></label>').join('')+ui('</div><p class="hint">Les commentaires sont conservés dans cet exercice.</p></details></section></div><footer class="exercise-editor-footer"><div><p class="hint">Ton analyse en arrière-plan reste intacte.</p><p class="exercise-editor-error" data-exercise-error role="alert" hidden></p></div><div class="actions"><button type="button" data-exercise-action="close">Annuler</button><button type="button" class="primary" data-exercise-action="save">Créer l’exercice</button></div></footer></div>');
  document.body.append(this.dialog);
  this.fields={title:this.dialog.querySelector('[name="title"]'),base_id:this.dialog.querySelector('[name="base_id"]'),base_name:this.dialog.querySelector('[name="base_name"]'),comment:this.dialog.querySelector('[name="comment"]')};
  this.movesHost=this.dialog.querySelector('[data-exercise-moves]');this.nagInputs=[...this.dialog.querySelectorAll('[name="nag"]')];
  this.history=new AnalysisHistory(100);this.history.reset(draft,'');
  this.board=new Board(this.dialog.querySelector('[data-exercise-board]'),{doc:draft,path:'',flipped,engineHost:this.dialog.querySelector('[data-exercise-engine]'),onChange:()=>this.changed(),onVariationChange:()=>this.renderMoves({followVariation:true})});
  this.moveMenu=new MoveMenu(this.movesHost,{getDoc:()=>this.board.doc,onAction:(action,path)=>{void this.edit(action,path);}});
  this.listen(this.dialog,'click',event=>this.click(event));
  this.listen(this.dialog,'keydown',event=>this.keydown(event));
  this.listen(this.dialog,'cancel',event=>{event.preventDefault();this.close();});
  this.listen(this.dialog,'close',()=>this.dispose());
  this.listen(this.fields.base_id,'change',()=>{this.error('');this.renderDestination();});
  this.listen(this.fields.comment,'input',()=>this.captureAnnotation());
  this.listen(this.fields.comment,'change',()=>{this.captureAnnotation();this.flushAnnotation();this.renderMoves();this.syncControls();});
  for(const input of this.nagInputs)this.listen(input,'change',()=>{this.captureAnnotation();this.flushAnnotation();this.renderMoves();this.syncControls();});
  this.renderDestination();this.renderMoves();this.renderAnnotation();this.syncControls();this.dialog.showModal();
 }
 listen(target,event,callback){target.addEventListener(event,callback);this.listeners.push([target,event,callback]);}
 busy(){return this.disposed||this.saving||this.editing||this.board.busy||this.board.inputLocked;}
 error(message=''){const host=this.dialog.querySelector('[data-exercise-error]');host.textContent=message;host.hidden=!message;}
 renderDestination(){
  const fresh=this.fields.base_id.value==='new',base=this.bases.find(base=>String(base.id)===this.fields.base_id.value);
  this.dialog.querySelector('[data-new-base]').hidden=!fresh;
  this.dialog.querySelector('[data-base-note]').textContent=fresh?t('Nouvelle base de révision · Résoudre · Hybride. Toutes les variantes saisies seront acceptées comme solutions.'):base?.settings?.type==='play'?(base.settings.review_enabled?t('Position à jouer contre le moteur : les coups de solution sont facultatifs.'):t('Position à jouer contre le moteur. Active les révisions dans les réglages de cette base pour la retrouver dans Révisions.')):base?.settings?.review_enabled?(base.settings.type==='moves'?t('Chaque décision de ton camp sera révisée séparément ; les variantes saisies fournissent les réponses acceptées.'):t('Toutes les variantes saisies seront acceptées comme solutions dans cet exercice.')):t('Active les révisions dans les réglages de cette base pour y retrouver cet exercice.');
 }
 renderMoves({follow=false,followVariation=false}={}){
  const previousScroll=this.movesHost.scrollTop;
  renderAnalysisMovesInto(this.movesHost,this.board.doc,this.board.path,null,this.board.selectedVariation?.()?.path);this.movesHost.scrollTop=previousScroll;
  if(followVariation)followAnalysisMove(this.movesHost,this.movesHost.querySelector('.move.variation-choice'));
  else if(follow){if(this.board.path==='')this.movesHost.scrollTop=0;else followAnalysisMove(this.movesHost,this.movesHost.querySelector('.move.current'));}
 }
 renderAnnotation(){
  const node=this.board.node();this.annotationPath=node.path;this.pendingAnnotation=null;this.fields.comment.value=node.comment||'';
  this.dialog.querySelector('[data-annotation-position]').textContent=node.san||t('Position initiale');
  for(const input of this.nagInputs){input.checked=(node.nags||[]).includes(Number(input.value));input.disabled=this.saving||this.editing||node.path==='';}
 }
 captureAnnotation(){
  if(this.disposed||this.saving||this.editing)return;
  this.pendingAnnotation={path:this.annotationPath,comment:this.fields.comment.value,nags:this.nagInputs.filter(input=>input.checked).map(input=>Number(input.value))};
 }
 flushAnnotation(){
  const pending=this.pendingAnnotation;if(!pending)return false;this.pendingAnnotation=null;
  const node=this.board.doc.nodes.find(node=>node.path===pending.path);if(!node)return false;
  const extra=(node.nags||[]).filter(nag=>!NAGS.some(([id])=>id===nag));
  node.comment=pending.comment;node.nags=node.path===''?[]:[...pending.nags,...extra];this.board.doc.pgn=serialize(this.board.doc);this.history.record(this.board.doc,this.board.path);return true;
 }
 annotate({comment='',nags=[]}={}){
  if(this.busy())return false;
  this.pendingAnnotation={path:this.board.path,comment:String(comment),nags:nags.filter(nag=>Number.isInteger(nag)&&nag>=0)};
  this.flushAnnotation();this.renderMoves();this.renderAnnotation();this.syncControls();return true;
 }
 changed(){
  if(this.disposed)return;this.flushAnnotation();this.history.record(this.board.doc,this.board.path);this.moveMenu?.close();this.renderMoves({follow:true});this.renderAnnotation();this.syncControls();
 }
 syncControls(){
  if(this.disposed)return;const locked=this.saving||this.editing;
  this.dialog.querySelectorAll('input,select,textarea,button').forEach(control=>{control.disabled=locked;});
  // Navigation controls are guarded by Board itself while validating a move.
  const flags=this.history.flags();
  this.dialog.querySelector('[data-exercise-action="undo"]').disabled=locked||!flags.can_undo;
  this.dialog.querySelector('[data-exercise-action="redo"]').disabled=locked||!flags.can_redo;
  this.dialog.querySelector('[data-exercise-action="menu"]').disabled=locked||this.board.path==='';
  for(const input of this.nagInputs)input.disabled=locked||this.board.path==='';
  const save=this.dialog.querySelector('[data-exercise-action="save"]');save.textContent=this.saving?t('Création…'):t('Créer l’exercice');
  const engineRefresh=this.dialog.querySelector('[data-b="analyse"]');if(engineRefresh)engineRefresh.disabled=locked||!this.board.engineOn;
 }
 async click(event){
  const move=event.target.closest?.('.move[data-path]');if(move&&this.movesHost.contains(move)){event.preventDefault();if(!this.busy()){this.flushAnnotation();await this.board.go(move.dataset.path);}return;}
  const button=event.target.closest?.('[data-exercise-action]');if(!button||!this.dialog.contains(button)||button.disabled)return;
  const action=button.dataset.exerciseAction;event.preventDefault();
  if(action==='close')return this.close();if(action==='save')return this.save();if(this.busy())return;
  if(action==='root'){this.flushAnnotation();return this.board.go('');}
  if(action==='undo'||action==='redo')return this.historyAction(action);
  if(action==='menu')return this.moveMenu.open(this.board.path,button);
 }
 keydown(event){
  if(event.defaultPrevented||event.isComposing)return;
  const text=event.target?.closest?.('input,textarea,select,[contenteditable="true"]');
  if(text||!(event.ctrlKey||event.metaKey)||event.altKey)return;
  const key=event.key.toLowerCase();if(key!=='z'&&key!=='y')return;
  event.preventDefault();void this.historyAction(key==='y'||event.shiftKey?'redo':'undo');
 }
 async historyAction(direction){
  if(this.busy()||!['undo','redo'].includes(direction))return false;
  this.flushAnnotation();const snapshot=this.history.take(direction);if(!snapshot)return false;
  this.editing=true;this.board.inputLocked=true;this.moveMenu.close();this.syncControls();
  try{await this.board.setDoc(snapshot.doc,snapshot.path);if(this.disposed)return false;this.renderMoves();this.renderAnnotation();return true;}
  finally{this.editing=false;if(!this.disposed){this.board.inputLocked=false;this.board.renderBoard();this.syncControls();}}
 }
 async edit(action,path=this.board.path){
  if(this.busy())return false;
  this.flushAnnotation();
  if(action==='annotate'){await this.board.go(path);if(this.disposed)return false;this.dialog.querySelector('.exercise-editor-annotations').open=true;this.fields.comment.focus();return true;}
  if(!['delete','up','down','promote','main'].includes(action))return false;
  this.editing=true;this.board.inputLocked=true;this.moveMenu.close();this.error('');this.syncControls();
  const controller=new AbortController();this.editController=controller;
  try{
   const result=await api('/api/board/tree',{method:'POST',signal:controller.signal,body:{pgn:serialize(this.board.doc),path,action,start_path:''}});
   if(this.disposed||controller.signal.aborted)return false;
   const doc={...this.board.doc,...result.doc};delete doc.id;delete doc.base_id;
   await this.board.setDoc(doc,result.path);if(this.disposed)return false;this.history.record(this.board.doc,this.board.path);this.renderMoves();this.renderAnnotation();return true;
  }catch(error){if(!this.disposed&&error.name!=='AbortError')this.error(error.message||String(error));return false;}
  finally{if(this.editController===controller)this.editController=null;this.editing=false;if(!this.disposed){this.board.inputLocked=false;this.board.renderBoard();this.syncControls();}}
 }
 async save(){
  if(this.busy()||this.createdEntry)return false;
  this.flushAnnotation();this.error('');
  const title=this.fields.title.value.trim(),selection=this.fields.base_id.value,baseName=this.fields.base_name.value.trim();
  const base=this.bases.find(base=>String(base.id)===selection),fresh=selection==='new';
  if(!title){this.error(t('Donne un titre à cet exercice.'));this.fields.title.focus();return false;}
  if(fresh&&(!this.allowNewBase||!baseName)){this.error(t('Donne un nom à la nouvelle base.'));return false;}
  if(!fresh&&!base){this.error(t('Choisis une base de destination.'));return false;}
  if(base?.settings?.type!=='play'&&!this.board.doc.nodes.some(node=>node.uci)){this.error(t('Joue au moins un coup pour définir la solution. Pour enregistrer un simple diagramme à jouer, choisis une base de type « Jouer contre le moteur ».'));return false;}
  let pgn;try{pgn=serialize(this.board.doc);}catch(error){this.error(error.message||String(error));return false;}this.saving=true;this.board.inputLocked=true;this.moveMenu.close();this.board.renderBoard();this.syncControls();
  let destinationId=base?.id;
  try{
   if(fresh){
    if(!this.createdBase)this.createdBase=await api('/api/bases',{method:'POST',body:{name:baseName,tags:['Erreurs',t('Entraînement')],settings:{review_enabled:true,type:'solve',mode:'hybrid'}}});
    destinationId=this.createdBase.id;
    // Keep the real destination after an entry failure; another click cannot
    // accidentally create a second empty base.
    if(!this.bases.some(base=>base.id===destinationId)){
     this.bases.push(this.createdBase);const item=document.createElement('option');item.value=String(destinationId);item.textContent=this.createdBase.name||baseName;this.fields.base_id.append(item);
    }
    this.fields.base_id.value=String(destinationId);this.renderDestination();
   }
   if(this.sourceLink){
    const result=await api('/api/game-analysis/'+this.sourceLink.entry_id+'/exercise',{method:'POST',body:{base_id:destinationId,title,pgn,ply:this.sourceLink.ply,fingerprint:this.sourceLink.fingerprint}});
    this.createdEntry=result.entry||await api('/api/entries/'+result.entry_id);
   }else this.createdEntry=await api('/api/entries',{method:'POST',body:{base_id:destinationId,title,pgn,start_path:''}});
  }catch(error){this.error(error.message||String(error));return false;}
  finally{this.saving=false;if(!this.disposed){this.board.inputLocked=false;this.board.renderBoard();this.syncControls();}}
  const result={entry:this.createdEntry,baseId:destinationId};this.close();
  // A library refresh failure must never turn successful creation into a retry.
  try{await this.onCreated?.(result);}catch(error){fail(new Error(t('L’exercice est enregistré, mais l’actualisation de la bibliothèque a échoué : ')+(error.message||String(error))));}
  return result;
 }
 close(){
  if(this.disposed)return true;if(this.saving)return false;
  this.dialog.close();this.dispose();return true;
 }
 dispose(){
  if(this.disposed)return;if(this.saving)return;
  this.disposed=true;this.editController?.abort();this.editController=null;this.moveMenu?.dispose();this.board?.dispose();
  for(const [target,event,callback] of this.listeners)target.removeEventListener(event,callback);this.listeners=[];this.dialog.remove();if(activeEditor===this)activeEditor=null;
  const onClosed=this.onClosed;this.onClosed=null;
  try{Promise.resolve(onClosed?.()).catch(fail);}catch(error){fail(error);}
 }
}
