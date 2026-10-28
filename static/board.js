import {playSound,moveSound} from './sound.js';
import {t,ui,locale} from './i18n.js';
import {api,esc,fail,notice,START,time,modal,option} from './api.js';
import {pendingPieces,squareAtPoint,engineArrowsSvg,drawingsSvg} from './board-geometry.js';
export {squareAtPoint} from './board-geometry.js';
import {pieceUrl} from './appearance.js';
import {cachedAnalysis,streamAnalysis,analysisEngineName,refreshAnalysisEngine} from './engine-analysis.js';
import {engineSearchSettings,engineSettingsLoaded,loadEngineSettings,openEngineSettings} from './engine-settings.js';
import {formatNags,describeNags} from './annotations.js';
import {importedMoveEvaluation,preferredEvaluation} from './move-metrics.js';
import {pieces,makeDoc,serialize,appendLine,nodeIndex} from './chess-document.js';
import {formatClock,positionClocks} from './analysis-clocks.js';
export {pieces,makeDoc,serialize,appendLine} from './chess-document.js';
let boardSerial=0;
export class Board {
 constructor(host,{doc=makeDoc(),path='',flipped=false,showClocks=false,playerBandHtml=null,onMove=null,onChange=null,onVariationChange=null,onBeforeNavigate=null,onEvaluation=null,training=false,onAssist=null,onExploreLine=null,onCopyPgn=null,engineHost=null,legalState=null}={}){
  Object.assign(this,{host,doc,path,flipped,showClocks,playerBandHtml,onMove,onChange,onVariationChange,onBeforeNavigate,onEvaluation,training,onAssist,onExploreLine,onCopyPgn});
  this.variationSelection=null;
  this.drawings=[];this.draw=null;this.drawingFen=this.node().fen;this.drawingPath=path;
  this.engineHost=engineHost&&engineHost!==host?engineHost:null;
  this.selected=null;this.legal=[];this.lines=[];this.engineResultFen=null;this.engineSource='';this.analysisController=null;this.analysisPending=false;this.storedEvaluations=new Map();this.storedDocument=doc;this.engineOn=false;this.arrows=3;this.analysisSeq=0;this.previewSeq=0;this.busy=false;this.inputLocked=false;this.disposed=false;this.preview=null;this.pendingMove=null;this.drag=null;this.hoverPV=null;this.focusPV=null;this.suppressClickUntil=0;this.id=++boardSerial;this.listeners=[];
  this.listen(host,'pointerdown',e=>this.pointerDown(e));
  const pointerSurface=typeof window!=='undefined'?window:host;
  this.listen(pointerSurface,'pointermove',e=>this.pointerMove(e));
  this.listen(pointerSurface,'pointerup',e=>this.pointerUp(e));
  this.listen(pointerSurface,'pointercancel',e=>{if(this.drag?.id===e.pointerId)this.cancelDrag();if(this.draw?.id===e.pointerId)this.cancelDrawing();});
  this.listen(host,'lostpointercapture',e=>{if(e.target!==host||host.hasPointerCapture?.(e.pointerId))return;if(this.drag?.id===e.pointerId)this.cancelDrag();if(this.draw?.id===e.pointerId)this.cancelDrawing();});
  this.listen(host,'contextmenu',e=>{const board=e.target.closest?.('.chess-board');if(board&&host.contains(board))e.preventDefault();});
  // A docked engine lives beside the board; each surface owns only its listeners.
  for(const surface of [host,...(this.engineHost&&!host.contains(this.engineHost)?[this.engineHost]:[])]){
   this.listen(surface,'click',e=>this.handleClick(e));
   this.listen(surface,'change',e=>{if(e.target.matches?.('[data-arrows]')&&this.engineSurface().contains(e.target)){this.arrows=Number(e.target.value);this.renderBoard();}});
   this.listen(surface,'pointerover',e=>{if(e.pointerType!=='touch')this.pvEnter(e,'hoverPV');});
   this.listen(surface,'pointerout',e=>{if(e.pointerType!=='touch')this.pvLeave(e,'hoverPV');});
   this.listen(surface,'focusin',e=>this.pvEnter(e,'focusPV'));
   this.listen(surface,'focusout',e=>this.pvLeave(e,'focusPV'));
   this.listen(surface,'keydown',e=>{if(e.key==='Escape'){this.cancelDrag();this.cancelDrawing();this.clearPreview();}});
  }
  this.listen(host,'dragstart',e=>{if(e.target.closest?.('.chess-board'))e.preventDefault();});
  if(typeof window!=='undefined'){
   this.listen(window,'keydown',e=>{if(e.key==='Escape'&&this.draw)this.cancelDrawing();this.navigationKeydown(e);});
   this.listen(window,'blur',()=>{this.cancelDrag();this.cancelDrawing();this.clearPreview();});
   this.listen(window,'chessgym:appearancechange',()=>{this.cancelDrag();this.cancelDrawing(false);this.renderBoard();});
  }
  // A training response can already contain the legal moves for this exact position.
  const hasLegalState=legalState?.fen===this.node().fen&&Array.isArray(legalState.moves)&&legalState.moves.every(move=>typeof move==='string');
  if(hasLegalState){this.legal=[...legalState.moves];this.gameOver=legalState.game_over;this.result=legalState.result;}
  this.render();if(!hasLegalState)this.refreshLegal();
 }
 navigationKeydown(event){
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||event.defaultPrevented||event.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;
  if(this.disposed||this.training||this.busy||this.inputLocked||this.drag||this.draw)return;
  const target=event.target?.nodeType===3?event.target.parentElement:event.target;
  if(target?.isContentEditable||target?.closest?.('input,textarea,select,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]'))return;
  // A dialog/menu owns its keyboard input. Never move a board hidden behind it.
  const menus=[...(document.querySelectorAll?.('[role="menu"]')||[])];
  if(menus.some(menu=>!menu.hidden&&(!menu.getClientRects||menu.getClientRects().length)))return;
  const dialogs=[...(document.querySelectorAll?.('dialog[open]')||[])],dialog=dialogs.at(-1),ownDialog=this.host.closest('dialog');
  if((dialog&&!dialog.contains(this.host))||(ownDialog&&!ownDialog.open))return;
  if(event.key==='ArrowUp'||event.key==='ArrowDown'){
   if(this.variationChoices().length<2)return;
   event.preventDefault();this.selectVariation(event.key==='ArrowDown'?1:-1);return;
  }
  // Claim even an end-of-line key so a second mounted board cannot handle it.
  event.preventDefault();this.control(event.key==='ArrowLeft'?'prev':'next');
 }
 variationContext(){
  const current=this.node(),nodes=nodeIndex(this.doc);
  const children=parent=>(parent?.children||[]).map(path=>nodes.get(path)).filter(node=>node&&node.parent===parent.path);
  const parent=nodes.get(current.parent),siblings=children(parent);
  // Alternatives to the displayed move take precedence over its continuations.
  if(siblings.length>1&&siblings.some(node=>node.path===current.path))return {parent:parent.path,choices:siblings,defaultPath:current.path};
  const choices=children(current);return {parent:current.path,choices,defaultPath:choices[0]?.path};
 }
 variationChoices(){
  return this.variationContext().choices;
 }
 selectedVariation(){
  const selection=this.variationSelection;
  if(selection?.doc!==this.doc||selection.origin!==this.path)return null;
  const context=this.variationContext();
  return selection.parent===context.parent?context.choices.find(node=>node.path===selection.path)||null:null;
 }
 selectVariation(direction){
  if(this.disposed||this.training||this.busy||this.inputLocked||this.drag)return;
  const context=this.variationContext(),choices=context.choices;if(choices.length<2)return;
  const selected=this.selectedVariation(),index=Math.max(0,choices.findIndex(node=>node.path===(selected?.path||context.defaultPath)));
  const next=choices[(index+(direction<0?-1:1)+choices.length)%choices.length];
  this.variationSelection={doc:this.doc,origin:this.path,parent:context.parent,path:next.path};
  this.renderVariationChoice();this.onVariationChange?.(this);
 }
 renderVariationChoice(){
  const status=this.host.querySelector('.board-toolbar .turn');if(!status)return;
  const selected=this.selectedVariation(),choices=selected?this.variationChoices():[];
  status.textContent=selected?'↑↓ '+(choices.findIndex(node=>node.path===selected.path)+1)+'/'+choices.length+' · '+selected.san+' · →':this.node().fen.split(' ')[1]==='w'?t('Trait aux blancs'):t('Trait aux noirs');
  status.title=selected?(this.variationContext().parent===this.path?t('Suite choisie : '):t('Alternative au coup actuel : '))+selected.san+t(' · ↑ / ↓ pour choisir, → pour entrer'):t('↑ / ↓ pour choisir une variante, → pour avancer, ← pour revenir');
  status.setAttribute('aria-live','polite');
 }
 engineSurface(){return this.engineHost||this.host;}
 engineElement(){return this.engineSurface().querySelector('.engine-panel');}
 listen(target,name,fn){target.addEventListener(name,fn);this.listeners.push([target,name,fn]);}
 node(){return nodeIndex(this.doc).get(this.path)||this.doc.nodes[0];}
 dispose(){if(this.disposed)return;this.disposed=true;this.pendingMove=null;this.cancelAnalysis();this.previewSeq++;this.cancelDrag(false);this.clearDrawings(false);for(const [target,name,fn] of this.listeners)target.removeEventListener(name,fn);this.listeners=[];this.preview=null;}
 async refreshLegal(){const fen=this.node().fen;try{const r=await api('/api/legal?fen='+encodeURIComponent(fen));if(this.disposed||fen!==this.node().fen)return;this.legal=r.moves;this.gameOver=r.game_over;this.result=r.result;this.renderBoard();}catch(e){if(!this.disposed)fail(e);}}
 cancelAnalysis(){this.analysisSeq++;this.analysisController?.abort();this.analysisController=null;this.analysisPending=false;this.deferredEngineResult=null;}
 storedEvaluation(){
  const saved=this.storedDocument===this.doc?this.storedEvaluations.get(this.path):null;
  return preferredEvaluation(saved,importedMoveEvaluation(this.node().comment));
 }
 setAnalysisReport(report){
  if(this.disposed)return;this.storedEvaluations=new Map();this.storedDocument=this.doc;
  if(report&&!report.stale&&report.status!=='stale')for(const position of report.positions||[]){
   const node=nodeIndex(this.doc).get(position.path);
   if(node?.fen===position.fen&&(Number.isFinite(position.cp)||Number.isFinite(position.mate)))this.storedEvaluations.set(position.path,{cp:position.cp,mate:position.mate,depth:position.depth,winner:position.winner});
  }
  this.renderEngine();
 }
 prepareAnalysis(){
  const fen=this.node().fen,cache=this.engineOn?cachedAnalysis(fen,engineSearchSettings()):null;
  if(cache){this.lines=cache.lines;this.engineResultFen=fen;this.engineSource='cache';}
  else if(this.engineResultFen!==fen){this.lines=[];this.engineResultFen=null;this.engineSource='';}
  this.engineMessage='';return !!cache;
 }
 async setDoc(doc,path=''){this.onBeforeNavigate?.(this);this.clearDrawings(false);this.variationSelection=null;this.pendingMove=null;this.cancelAnalysis();this.cancelDrag(false);this.clearPreview(false);this.doc=doc;this.storedEvaluations.clear();this.storedDocument=doc;this.path=path;this.selected=null;this.legal=[];this.prepareAnalysis();this.render();if(this.engineOn&&!this.disposed)void this.analyse();await this.refreshLegal();}
 async go(path){if(this.busy||this.inputLocked||this.disposed||!nodeIndex(this.doc).has(path))return;this.onBeforeNavigate?.(this);this.variationSelection=null;this.cancelAnalysis();this.cancelDrag(false);this.clearPreview(false);if(this.path!==path)playSound(moveSound(this.doc.nodes.find(node=>node.path===path)?.san||this.node().san||''),{navigation:true});this.path=path;this.selected=null;this.legal=[];this.prepareAnalysis();this.render();this.onChange?.(this);if(this.engineOn&&!this.disposed)void this.analyse();await this.refreshLegal();}
 render(){if(this.disposed)return;this.cancelDrag(false);this.cancelDrawing(false);this.clearPreview(false);const n=this.node(),clockBand=position=>this.showClocks||this.playerBandHtml?'<div class="board-clock'+(this.playerBandHtml?' board-player-band':'')+'" data-board-clock="'+position+'" hidden></div>':'';this.host.innerHTML=clockBand('top')+ui('<div class="chess-board-wrap"><div class="chess-board" role="group" aria-label="Échiquier interactif : déplacer les pièces par clic ou glisser-déposer, dessiner des flèches avec le bouton droit"></div><div class="board-preview-label" aria-live="polite" hidden></div></div>')+clockBand('bottom')+ui('<div class="board-toolbar"><div><button type="button" data-b="first" title="Position initiale">|‹</button><button type="button" data-b="prev" title="Coup précédent (←)" aria-keyshortcuts="ArrowLeft">‹</button><button type="button" data-b="next" title="Coup suivant (→)" aria-keyshortcuts="ArrowRight">›</button><button type="button" data-b="last" title="Dernier coup">›|</button></div><span class="turn">')+(n.fen.split(' ')[1]==='w'?t('Trait aux blancs'):t('Trait aux noirs'))+ui('</span><div class="board-tools"><button type="button" class="copy-fen" data-b="copy-fen" title="Copier la position FEN" aria-label="Copier FEN"><span class="copy-verb">Copier </span>FEN</button>')+(typeof this.onCopyPgn==='function'?ui('<button type="button" class="copy-pgn" data-b="copy-pgn" title="Copier toute la partie au format PGN" aria-label="Copier PGN"><span class="copy-verb">Copier </span>PGN</button>'):'')+ui('<button type="button" data-b="flip" title="Retourner l’échiquier">⇅</button></div></div>')+(this.engineHost?'':this.enginePanelHtml());
  if(this.engineHost)this.engineHost.innerHTML=this.enginePanelHtml();
  this.renderBoard();this.renderVariationChoice();
 }
 renderBoard(){
  if(this.disposed)return;const node=this.node();
  if(this.drawingFen!==node.fen||this.drawingPath!==this.path)this.clearDrawings(false);
  this.drawingFen=node.fen;this.drawingPath=this.path;
  if(this.pendingMove&&(this.pendingMove.doc!==this.doc||this.pendingMove.path!==this.path||this.pendingMove.fen!==node.fen))this.pendingMove=null;
  this.renderClocks();
  const pending=this.pendingMove,display=this.preview||(pending?{...node,uci:pending.uci}:node),p=pending?pendingPieces(node.fen,pending.uci):pieces(display.fen),files=this.flipped?'hgfedcba':'abcdefgh',ranks=this.flipped?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];
  const legal=!this.preview&&!pending&&this.selected?this.legal.filter(x=>x.startsWith(this.selected)).map(x=>x.slice(2,4)):[];
  const board=this.host.querySelector('.chess-board');if(!board)return;board.classList.toggle('previewing',!!this.preview);board.classList.toggle('dragging',!!this.drag?.active);board.classList.toggle('drawing',!!this.draw);
  board.innerHTML=ranks.map((rank,ri)=>[...files].map((f,fi)=>{
   const sq=f+rank,c=p[sq],white=c&&c===c.toUpperCase(),light=('abcdefgh'.indexOf(f)+rank)%2===0;
   return '<button class="square '+(light?'light':'dark')+(!this.preview&&this.selected===sq?' selected':'')+(display.uci&&(display.uci.slice(0,2)===sq||display.uci.slice(2,4)===sq)?' last':'')+(this.drag?.active&&this.drag.from===sq?' drag-source':'')+'" data-square="'+sq+'" aria-label="'+sq+(c?' '+(white?t('blanc '):t('noir '))+c.toUpperCase():t(' vide'))+'" '+(this.busy||this.inputLocked?'disabled':'')+'>'+(c?'<img draggable="false" src="'+esc(pieceUrl(c))+'" alt="">':'')+(legal.includes(sq)?'<i class="legal-dot"></i>':'')+(fi===0?'<span class="rank">'+rank+'</span>':'')+(ri===7?'<span class="file">'+f+'</span>':'')+'</button>';
  }).join('')).join('')+(!this.preview&&!pending?this.arrowSvg()+this.drawingSvg():'');
  for(const action of ['copy-fen','copy-pgn']){const copyButton=this.host.querySelector('[data-b="'+action+'"]');if(copyButton)copyButton.disabled=this.busy||this.inputLocked;}
  const label=this.host.querySelector('.board-preview-label');if(label){label.hidden=!this.preview;label.textContent=this.preview?t('Aperçu · ')+this.preview.label:'';}
 }
 renderClocks(){
  if(this.playerBandHtml){
   const order=this.flipped?['white','black']:['black','white'];
   for(const [index,position] of ['top','bottom'].entries()){
    const band=this.host.querySelector('[data-board-clock="'+position+'"]');if(!band)continue;
    band.hidden=false;band.dataset.side=order[index];band.innerHTML=this.playerBandHtml(this,order[index]);
   }
   return;
  }
  if(!this.showClocks)return;
  const clocks=positionClocks(this.doc,this.path),masked=!!(this.preview||this.pendingMove),order=this.flipped?['white','black']:['black','white'];
  for(const [index,position] of ['top','bottom'].entries()){
   const band=this.host.querySelector('[data-board-clock="'+position+'"]');if(!band)continue;
   band.hidden=!clocks.available;if(!clocks.available)continue;
   const side=order[index],name=String(this.doc.headers?.[side==='white'?'White':'Black']||'').trim(),value=masked?null:clocks[side];
   const label=side==='white'?t('Blancs'):t('Noirs'),title=masked?t('Horloge indisponible dans cet aperçu'):t('Temps restant');
   band.dataset.side=side;
   band.innerHTML='<span class="board-clock-player"><span class="board-clock-side">'+esc(label)+'</span>'+(name&&name!=='?'?'<span class="board-clock-name" title="'+esc(name)+'">'+esc(name)+'</span>':'')+'</span><span class="board-clock-value" title="'+esc(title)+'" aria-label="'+esc(title+' : '+(value==null?t('Non disponible'):formatClock(value)))+'">'+esc(formatClock(value))+'</span>';
  }
 }
 arrowSvg(){return engineArrowsSvg(this);}
 ownPiece(square){const c=pieces(this.node().fen)[square];return !!c&&((c===c.toUpperCase())===(this.node().fen.split(' ')[1]==='w'));}
 // Drawings are a local overlay: they never change the document or review score.
 drawingSvg(){return drawingsSvg(this);}
 renderDrawings(){
  if(this.disposed)return;const board=this.host.querySelector('.chess-board');if(!board)return;
  board.classList.toggle('drawing',!!this.draw);const previous=board.querySelector?.('.board-drawings'),svg=this.drawingSvg();
  if(previous){if(svg)previous.outerHTML=svg;else previous.remove();}else if(svg)board.insertAdjacentHTML?.('beforeend',svg);
 }
 cancelDrawing(render=true){const draw=this.draw;if(!draw)return;this.draw=null;try{if(this.host.hasPointerCapture?.(draw.id))this.host.releasePointerCapture(draw.id);}catch{}if(render)this.renderDrawings();}
 clearDrawings(render=true){this.cancelDrawing(false);this.drawings=[];if(render)this.renderDrawings();}
 drawDown(e,square){
  e.preventDefault();this.clearPreview(false);this.selected=null;
  this.draw={id:e.pointerId,from:square,to:square,fen:this.node().fen,path:this.path};
  try{this.host.setPointerCapture(e.pointerId);}catch{}
  this.renderBoard();
 }
 drawMove(e){
  const draw=this.draw;if(!draw||draw.id!==e.pointerId)return;
  if(this.busy||this.inputLocked||draw.fen!==this.node().fen||draw.path!==this.path||(e.buttons!=null&&!(e.buttons&2))){this.cancelDrawing();return;}
  e.preventDefault();const to=squareAtPoint(this.host.querySelector('.chess-board').getBoundingClientRect(),e.clientX,e.clientY,this.flipped);
  if(draw.to!==to){draw.to=to;this.renderDrawings();}
 }
 drawUp(e){
  const draw=this.draw;if(!draw||draw.id!==e.pointerId)return;e.preventDefault();
  const to=squareAtPoint(this.host.querySelector('.chess-board').getBoundingClientRect(),e.clientX,e.clientY,this.flipped);
  this.cancelDrawing(false);
  if(to&&!this.busy&&!this.inputLocked&&draw.fen===this.node().fen&&draw.path===this.path){
   const index=this.drawings.findIndex(shape=>shape.from===draw.from&&shape.to===to);
   if(index<0)this.drawings.push({from:draw.from,to});else this.drawings.splice(index,1);
  }
  this.renderDrawings();
 }
 pointerDown(e){
  if(this.disposed||this.busy||this.inputLocked||this.drag||this.draw||e.isPrimary===false)return;
  const sq=e.target.closest?.('[data-square]');if(!sq||!this.host.contains(sq))return;
  if(e.button===2&&e.pointerType!=='touch'){this.drawDown(e,sq.dataset.square);return;}
  if(e.button!=null&&e.button!==0)return;
  this.clearDrawings();
  const from=sq.dataset.square;if(!this.ownPiece(from))return;
  this.clearPreview(false);this.drag={id:e.pointerId,from,x:e.clientX,y:e.clientY,fen:this.node().fen,active:false,pointerType:e.pointerType};
 }
 pointerMove(e){
  if(this.draw){this.drawMove(e);return;}
  const d=this.drag;if(!d||d.id!==e.pointerId)return;
  if(this.busy||this.inputLocked||d.fen!==this.node().fen){this.cancelDrag();return;}
  const distance=Math.hypot(e.clientX-d.x,e.clientY-d.y);
  if(!d.active&&distance<(d.pointerType==='touch'?8:5))return;
  if(!d.active){
   d.active=true;this.selected=d.from;this.clearPreview(false);
   try{this.host.setPointerCapture(e.pointerId);}catch{}
   const board=this.host.querySelector('.chess-board'),rect=board.getBoundingClientRect();
   d.piece=document.createElement('img');d.piece.className='dragged-chess-piece';d.piece.src=pieceUrl(pieces(d.fen)[d.from]);d.piece.alt='';d.piece.draggable=false;d.piece.style.width=rect.width/8*.9+'px';d.piece.style.height=rect.height/8*.9+'px';(this.host.closest('dialog')||document.body).append(d.piece);this.renderBoard();
  }
  e.preventDefault();d.piece.style.left=e.clientX+'px';d.piece.style.top=e.clientY+'px';
  const square=squareAtPoint(this.host.querySelector('.chess-board').getBoundingClientRect(),e.clientX,e.clientY,this.flipped);
  this.host.querySelectorAll('.drag-target').forEach(el=>el.classList.remove('drag-target'));
  if(square)this.host.querySelector('[data-square="'+square+'"]')?.classList.add('drag-target');
 }
 pointerUp(e){
  if(this.draw){this.drawUp(e);return;}
  const d=this.drag;if(!d||d.id!==e.pointerId)return;
  const dragged=d.active,from=d.from,fen=d.fen;
  const to=dragged?squareAtPoint(this.host.querySelector('.chess-board').getBoundingClientRect(),e.clientX,e.clientY,this.flipped):null;
  this.cancelDrag(false);
  if(!dragged)return;
  e.preventDefault();this.suppressClickUntil=Date.now()+750;
  if(fen===this.node().fen&&to&&to!==from){void this.tryMove(from,to);}
  else{this.selected=null;this.renderBoard();}
 }
 cancelDrag(render=true){const d=this.drag;if(!d)return;this.drag=null;d.piece?.remove();if(d.active)this.suppressClickUntil=Date.now()+750;try{if(this.host.hasPointerCapture?.(d.id))this.host.releasePointerCapture(d.id);}catch{}if(render&&!this.disposed)this.renderBoard();}
 handleClick(e){
  if(this.disposed)return;
  const control=e.target.closest?.('[data-b]');if(control&&(this.host.contains(control)||this.engineSurface().contains(control))){if(!control.disabled){e.preventDefault();this.control(control.dataset.b);}return;}
  const square=e.target.closest?.('[data-square]');
  if(square&&this.host.contains(square)){if((e.button!=null&&e.button!==0)||this.draw||(e.detail!==0&&Date.now()<this.suppressClickUntil)){e.preventDefault();return;}void this.click(square.dataset.square);return;}
  const pv=e.target.closest?.('[data-pv-line]');if(pv&&this.engineSurface().contains(pv)){e.preventDefault();void this.playLine(Number(pv.dataset.pvLine),Number(pv.dataset.pvIndex));}
 }
 async tryMove(from,to,preferredUci=null){
  if(this.busy||this.inputLocked||this.disposed)return false;
  const candidates=this.legal.filter(m=>m.startsWith(from+to));
  if(!candidates.length||(preferredUci!==null&&!candidates.includes(preferredUci))){this.selected=null;this.renderBoard();return false;}
  const fen=this.node().fen,doc=this.doc,path=this.path;
  const pending={fen,doc,path,uci:preferredUci||(candidates.length>1?from+to:candidates[0])};
  this.clearDrawings(false);this.cancelAnalysis();this.pendingMove=pending;this.inputLocked=true;this.selected=null;this.clearPreview(false);this.renderBoard();
  try{const move=preferredUci||(candidates.length>1?await this.promotion(candidates):candidates[0]);if(!move||this.disposed||this.doc!==doc||this.path!==path||this.node().fen!==fen)return false;
   pending.uci=move;this.renderBoard();
   if(this.onMove)await this.onMove(move,this);else await this.move(move);return true;
  }catch(e){if(!this.disposed&&this.doc===doc&&this.path===path)fail(e);return false;}finally{if(this.pendingMove===pending)this.pendingMove=null;this.inputLocked=false;if(!this.disposed){this.renderBoard();this.flushEngineUpdate();}}
 }
 async click(sq){if(this.busy||this.inputLocked||this.disposed)return;this.clearDrawings(false);this.clearPreview(false);if(this.selected&&this.legal.some(m=>m.startsWith(this.selected+sq))){await this.tryMove(this.selected,sq);return;}this.selected=this.ownPiece(sq)&&this.selected!==sq?sq:null;this.renderBoard();}
 promotion(moves){return new Promise(resolve=>{const d=modal(t('Promotion'),'<div class="promotion">'+moves.map(m=>'<button type="button" data-promote="'+m+'">'+esc({q:t('Dame'),r:t('Tour'),b:t('Fou'),n:t('Cavalier')}[m[4]])+'</button>').join('')+'</div>');let done=false;d.querySelectorAll('[data-promote]').forEach(b=>b.onclick=()=>{done=true;resolve(b.dataset.promote);d.close();});d.addEventListener('close',()=>{if(!done)resolve(null);},{once:true});});}
 async move(uci){
  if(this.disposed)return;this.onBeforeNavigate?.(this);this.cancelAnalysis();this.busy=true;this.cancelDrag(false);this.clearPreview(false);
  try{const parent=this.node(),sourceDoc=this.doc,sourcePath=this.path;
   const r=await api('/api/move',{method:'POST',body:{fen:parent.fen,uci}});if(this.disposed||this.doc!==sourceDoc||this.path!==sourcePath)return;const applied=appendLine(this.doc,this.path,[r]);this.doc=applied.doc;this.path=applied.path;this.gameOver=r.game_over;this.result=r.result;playSound(moveSound(r.san));
   this.variationSelection=null;this.legal=[];this.prepareAnalysis();this.render();this.onChange?.(this);if(this.engineOn&&!this.disposed)void this.analyse();await this.refreshLegal();
  }finally{this.busy=false;if(!this.disposed)this.renderBoard();}
 }
 async copyFen(){
  if(this.busy||this.inputLocked)return;
  const fen=this.preview?.fen||this.node().fen;
  try{await navigator.clipboard.writeText(fen);notice(t('FEN copié.'));}
  catch{const d=modal(t('Copier FEN'),ui('<p class="hint">Copie cette position pour la réutiliser dans un autre outil.</p><textarea rows="3" readonly aria-label="Position FEN">')+esc(fen)+'</textarea>');const text=d.querySelector('textarea');text.focus();text.select();}
 }
 control(action){
  const n=this.node();if(action==='copy-fen')return this.copyFen();if(action==='copy-pgn'){if(this.disposed||this.busy||this.inputLocked||typeof this.onCopyPgn!=='function')return;return Promise.resolve().then(()=>this.onCopyPgn()).catch(fail);}if(action==='flip'){this.cancelDrag(false);this.cancelDrawing(false);this.flipped=!this.flipped;this.renderBoard();return;}
  if(this.training&&['first','prev','next','last'].includes(action))return;
  if(action==='first')return this.go('');
  if(action==='prev'){
   if(n.parent!==null)return this.go(n.parent);
   if(this.variationSelection){this.variationSelection=null;this.renderVariationChoice();this.onVariationChange?.(this);}
   return;
  }
  if(action==='next'){
   const selected=this.selectedVariation();
   if(selected){
    if(selected.path!==this.path)return this.go(selected.path);
    this.variationSelection=null;this.renderVariationChoice();this.onVariationChange?.(this);return;
   }
   if(n.children.length)return this.go(n.children[0]);
   return;
  }
  if(action==='last'){let x=n;while(x.children.length)x=this.doc.nodes.find(k=>k.path===x.children[0]);return this.go(x.path);}
  if(action==='engine-settings')return this.editEngineSettings().catch(error=>{if(!this.disposed)fail(error);});
  if(action==='engine'){this.engineOn=!this.engineOn;if(this.engineOn){this.onAssist?.();this.analyse();}else{this.cancelAnalysis();this.lines=[];this.engineResultFen=null;this.engineSource='';this.engineMessage='';}this.render();}
  if(action==='analyse'){if(!this.engineOn)return;this.onAssist?.();this.analyse({force:true});}
 }
 async editEngineSettings(){
  if(this.disposed||this.busy||this.inputLocked||this.engineSettingsOpening)return;
  this.engineSettingsOpening=true;
  try{return await openEngineSettings({isCurrent:()=>!this.disposed,onSaved:()=>this.engineSettingsChanged()});}
  finally{this.engineSettingsOpening=false;}
 }
 engineSettingsChanged(){
  if(this.disposed)return;this.cancelAnalysis();this.clearPreview(false);this.lines=[];this.engineResultFen=null;this.engineSource='';this.engineMessage='';
  const head=this.engineSurface().querySelector('.engine-head');if(head)head.innerHTML=this.engineHeadHtml();this.renderEngine();
  if(this.engineOn)void this.analyse({force:true});
 }
 async analyse({force=false}={}){
  if(this.disposed||!this.engineOn)return;this.cancelAnalysis();const seq=this.analysisSeq,fen=this.node().fen,path=this.path;
  const owns=()=>seq===this.analysisSeq&&!this.disposed&&this.engineOn&&path===this.path&&fen===this.node().fen;
  let controller;
  try{
   if(!engineSettingsLoaded()){this.analysisPending=true;this.engineMessage='';this.renderEngine();await loadEngineSettings();if(!owns())return;}
   const refresh=refreshAnalysisEngine(),changed=refresh?await refresh:false;if(!owns())return;
   if(changed){this.lines=[];this.engineResultFen=null;this.engineSource='';}
   const settings=engineSearchSettings();this.clearPreview(false);const cached=this.prepareAnalysis();
   if(!force&&cached){this.analysisPending=false;this.receiveEngineUpdate({result:{lines:this.lines,cached:true},type:'done',seq,fen,path});return;}
   controller=new AbortController();this.analysisController=controller;this.analysisPending=true;this.engineMessage='';this.renderEngine();
   await streamAnalysis(fen,{settings,signal:controller.signal,refresh:force,onUpdate:(result,type)=>{
    if(!owns()||controller.signal.aborted)return;this.receiveEngineUpdate({result,type,seq,fen,path});
   }});
  }catch(e){if(owns()&&!controller?.signal.aborted&&e.name!=='AbortError'){this.engineMessage=e.message;this.renderEngine();}}
  finally{if(owns()){this.analysisPending=false;this.analysisController=null;this.renderEngine();}}
 }
 engineUpdateIsCurrent({seq,fen,path=this.path}){return !this.disposed&&seq===this.analysisSeq&&path===this.path&&fen===this.node().fen&&this.engineOn;}
 recordEngineEvaluation(update){
  if(update.evaluationRecorded||this.training||!this.onEvaluation)return;
  update.evaluationRecorded=true;const line=update.result.lines?.[0];
  if(line)this.onEvaluation(this,{path:update.path??this.path,fen:update.fen,line});
 }
 receiveEngineUpdate(update){
  if(!this.engineUpdateIsCurrent(update))return;
  if(this.inputLocked){this.deferredEngineResult=update;return;}
  // Hover freezes clickable variations, but the current score still belongs to its move.
  this.recordEngineEvaluation(update);
  if(this.hoverPV||this.focusPV){this.deferredEngineResult=update;return;}
  this.applyEngineUpdate(update);
 }
 applyEngineUpdate(update){
  if(!this.engineUpdateIsCurrent(update))return;
  if(this.inputLocked){this.deferredEngineResult=update;return;}
  this.recordEngineEvaluation(update);const {result,type,fen}=update;
  this.lines=result.lines;this.engineResultFen=fen;this.engineSource=result.cached?'cache':'live';this.analysisPending=type!=='done'&&!!this.analysisController;this.renderEngine();
 }
 flushEngineUpdate(){if(this.hoverPV||this.focusPV||this.inputLocked||!this.deferredEngineResult)return;const update=this.deferredEngineResult;this.deferredEngineResult=null;this.applyEngineUpdate(update);}
 engineScore(line){return line?.mate!=null?'#'+line.mate:line?.cp!=null?(line.cp>=0?'+':'')+(line.cp/100).toFixed(2):'—';}
 engineHeaderState(){
  const live=this.engineOn&&this.engineResultFen===this.node().fen?this.lines[0]:null,saved=!this.training||this.engineOn?this.storedEvaluation():null,line=preferredEvaluation(saved,live),usesLive=!!live&&(line===live||(line?.depth===live.depth&&(line?.cp??null)===(live.cp??null)&&(line?.mate??null)===(live.mate??null))),origin=usesLive?(this.engineSource==='cache'?(this.analysisPending?t('En mémoire · En cours'):t('En mémoire')):this.analysisPending?t('En cours'):''):line?t('Enregistré'):'';
  const depth=(origin?origin+' · ':'')+(Number.isFinite(line?.depth)?t('Prof. ')+line.depth:this.engineOn?(this.analysisPending?t('Analyse…'):t('Analyse active')):t('Désactivé'));
  return {line,depth};
 }
 engineHeadHtml(){
  const name=esc(analysisEngineName());
  const arrows=ui('<label class="inline engine-arrow-control" title="Nombre de flèches moteur">')+(this.engineHost?'↗':t('Flèches'))+ui(' <select data-arrows aria-label="Nombre de flèches moteur">')+[0,1,2,3].map(i=>option(i,i,this.arrows)).join('')+'</select></label>';
  const refresh='<button type="button" data-b="analyse" '+(!this.engineOn?'disabled':'')+ui(' title="Actualiser l’analyse" aria-label="Actualiser l’analyse">↻</button>');
  const settings=ui('<button type="button" data-b="engine-settings" title="Réglages du moteur" aria-label="Réglages du moteur">⚙</button>'),actions='<span class="engine-actions">'+settings+refresh+'</span>';
  if(!this.engineHost)return '<button type="button" data-b="engine" aria-pressed="'+this.engineOn+'">'+(this.engineOn?'●':'○')+' '+name+'</button>'+arrows+actions;
  const {line,depth}=this.engineHeaderState();
  return '<button type="button" class="engine-toggle" data-b="engine" aria-pressed="'+this.engineOn+'" aria-label="'+(this.engineOn?t('Désactiver'):t('Activer'))+' '+name+'" title="'+(this.engineOn?t('Désactiver'):t('Activer'))+' '+name+'">'+(this.engineOn?'●':'○')+ui('</button><strong class="engine-score" title="Évaluation du point de vue des blancs">')+esc(this.engineScore(line))+'</strong><span class="engine-name"><span data-engine-label>'+name+'</span><small title="'+esc(depth)+'">'+esc(depth)+'</small></span>'+arrows+actions;
 }
 enginePanelHtml(){return '<section class="engine-panel'+(this.engineHost?' engine-docked':'')+ui('" aria-label="Analyse du moteur"><div class="engine-head">')+this.engineHeadHtml()+'</div><div class="engine-output">'+this.engineHtml()+'</div></section>';}
 engineHtml(){
  if(!this.engineOn)return this.training?ui('<p class="muted">Activer le moteur compte comme une aide pour cette tentative.</p>'):'';
  const status=this.engineMessage||(!this.lines.length&&this.analysisPending?t('Le moteur analyse la position…'):'');
  const message=status?'<p class="muted">'+esc(status)+'</p>':'';
  if(!this.lines.length)return message;
  const parts=this.node().fen.split(' '),start=Number(parts[5]||1),black=parts[1]==='b';
  return message+this.lines.map((l,lineIndex)=>'<div class="engine-line"><strong>'+esc(this.engineScore(l))+'</strong><span class="engine-moves">'+(l.san||[]).map((san,index)=>{
   const ply=index+(black?1:0),number=start+Math.floor(ply/2),prefix=ply%2===0?number+'.':index===0?number+'…':'';
   return '<button type="button" class="engine-move" data-pv-line="'+lineIndex+'" data-pv-index="'+index+'" title="'+esc((this.training?t('Ouvrir une copie dans l’analyse'):t('Jouer la variante'))+t(' jusqu’à ')+san)+'" aria-label="'+esc(t('Aperçu et variante jusqu’à ')+number+(ply%2?t(' noirs, '):t(' blancs, '))+san)+'">'+(prefix?'<span class="move-number">'+prefix+'</span>':'')+esc(san)+'</button>';
  }).join('')+'</span><small>P'+l.depth+'</small></div>').join('')+ui('<small class="engine-help">Évaluation du point de vue des blancs · survol : aperçu · clic : ')+(this.training?t('ouvrir une copie dans l’analyse'):t('jouer la variante'))+'</small>';
 }
 renderEngine(){if(this.disposed||this.hoverPV||this.focusPV)return;this.clearPreview(false);const surface=this.engineSurface(),e=surface.querySelector('.engine-output');if(e)e.innerHTML=this.engineHtml();if(this.engineHost){const head=surface.querySelector('.engine-head');if(head){const score=head.querySelector?.('.engine-score'),depth=head.querySelector?.('.engine-name small');if(score&&depth){const state=this.engineHeaderState(),label=head.querySelector?.('[data-engine-label]');if(label)label.textContent=analysisEngineName();score.textContent=this.engineScore(state.line);depth.textContent=state.depth;depth.title=state.depth;}else head.innerHTML=this.engineHeadHtml();}}this.renderEngineArrows();}
 // Engine progress only changes its SVG overlay. Replacing the square buttons
 // between pointerdown and pointerup would make native click-to-move unreliable.
 renderEngineArrows(){
  if(this.disposed)return;const board=this.host.querySelector('.chess-board');if(!board)return;
  const previous=board.querySelector?.('.board-arrows'),svg=this.preview||this.pendingMove||this.drag?.active?'':this.arrowSvg();
  if(previous){if(svg)previous.outerHTML=svg;else previous.remove();}
  else if(svg)board.insertAdjacentHTML?.('beforeend',svg);
 }
 pvKey(button){return button?Number(button.dataset.pvLine)+':'+Number(button.dataset.pvIndex):null;}
 pvEnter(e,kind){
  const button=e.target.closest?.('[data-pv-line]');if(!button||!this.engineSurface().contains(button)||button.contains?.(e.relatedTarget))return;
  const key=this.pvKey(button);if(this[kind]===key)return;this[kind]=key;void this.updatePreview();
 }
 pvLeave(e,kind){
  const surface=this.engineSurface(),button=e.target.closest?.('[data-pv-line]'),row=kind==='hoverPV'?e.target.closest?.('.engine-line'):null;
  if((!button||!surface.contains(button))&&(!row||!surface.contains(row)))return;
  if(button?.contains?.(e.relatedTarget))return;
  // Transfer directly between moves, including across PVs, without flashing the
  // original board or releasing a pending engine update between pointer events.
  const next=e.relatedTarget?.closest?.('[data-pv-line]');
  if(next&&surface.contains(next)){const key=this.pvKey(next);if(this[kind]!==key){this[kind]=key;void this.updatePreview();}return;}
  // Keep the last preview over gaps/padding, but also handle exits from that
  // padding so the preview and deferred analysis are released on true row exit.
  if(row?.contains(e.relatedTarget)||!this[kind])return;
  this[kind]=null;void this.updatePreview();
 }
 async linePositions(line,fen){
  if(Array.isArray(line.positions)&&line.positions.length===line.pv?.length&&line.positions.every((p,i)=>p.uci===line.pv[i]&&p.fen&&p.san))return line.positions;
  if(!line.positionRequest)line.positionRequest=api('/api/line',{method:'POST',body:{fen,moves:line.pv||[]}}).then(r=>{line.positions=r.positions;return r.positions;}).catch(e=>{delete line.positionRequest;throw e;});
  return line.positionRequest;
 }
 async updatePreview(){
  const key=this.hoverPV||this.focusPV,seq=++this.previewSeq;
  if(!key||this.busy||this.inputLocked||this.drag?.active||this.draw||this.disposed){this.preview=null;this.markPreview();this.renderBoard();this.flushEngineUpdate();return;}
  const [lineIndex,index]=key.split(':').map(Number),line=this.lines[lineIndex],fen=this.node().fen;
  if(!line||!line.pv?.[index])return;
  try{const positions=await this.linePositions(line,fen);if(this.disposed||seq!==this.previewSeq||fen!==this.node().fen||line!==this.lines[lineIndex])return;
   const position=positions[index];if(!position)throw new Error(t('Aperçu indisponible pour cette variante.'));this.preview={...position,label:position.san};this.markPreview(key);this.renderBoard();
  }catch(e){if(seq===this.previewSeq&&!this.disposed){this.preview=null;this.markPreview();this.renderBoard();notice(t('Aperçu indisponible : ')+e.message,true);}}
 }
 markPreview(key=null){this.engineSurface().querySelectorAll('[data-pv-line]').forEach(button=>button.classList.toggle('preview-current',this.pvKey(button)===key));}
 clearPreview(render=true){this.previewSeq++;this.hoverPV=null;this.focusPV=null;this.preview=null;this.markPreview();if(render&&!this.disposed){this.renderBoard();this.flushEngineUpdate();}}
 async playLine(lineIndex,index){
  if(this.disposed||this.busy||this.inputLocked)return;this.onBeforeNavigate?.(this);const line=this.lines[lineIndex];if(!line?.pv?.[index])return;
  const fen=this.node().fen,path=this.path,doc=this.doc,moves=line.pv.slice(0,index+1);this.cancelAnalysis();this.inputLocked=true;this.cancelDrag(false);this.clearPreview();
  try{
   const positions=(await this.linePositions(line,fen)).slice(0,index+1);
   if(this.disposed||this.doc!==doc||this.path!==path||positions.length!==moves.length)return;
   if(this.training){
    if(!this.onExploreLine){notice(t('Ouvre cette position dans l’échiquier d’analyse pour explorer la variante.'));return;}
    const copy=appendLine(doc,path,positions,{detached:true});this.onAssist?.();await this.onExploreLine(copy,this);return;
   }
   const applied=appendLine(doc,path,positions);this.doc=applied.doc;this.path=applied.path;
   this.variationSelection=null;this.legal=[];this.selected=null;this.prepareAnalysis();this.render();this.onChange?.(this);if(this.engineOn&&!this.disposed)void this.analyse();await this.refreshLegal();
  }catch(e){if(!this.disposed)fail(e);}finally{this.inputLocked=false;if(!this.disposed){this.renderBoard();this.flushEngineUpdate();}}
 }
}

export function movesHtml(doc,path='',hide=false){if(hide)return '';const map=new Map(doc.nodes.map(n=>[n.path,n]));const line=(node,depth=0)=>{if(depth>500)return '';return (node.children||[]).map((p,i)=>{const n=map.get(p);if(!n)return '';const fen=node.fen.split(' '),description=describeNags(n.nags||[]);const token='<button class="move'+(n.path===path?' current':'')+'" data-path="'+n.path+'"'+(description?' title="'+esc(description)+'"':'')+'>'+fen[5]+(fen[1]==='w'?'.':'…')+' '+esc(n.san)+esc(formatNags(n.nags||[]))+'</button>'+(n.comment?'<span class="move-comment">'+esc(n.comment.replace(/\[%[^\]]+\]/g,'').trim())+'</span>':'');return i===0?token+line(n,depth+1):'<div class="variation">('+token+line(n,depth+1)+')</div>';}).join('');};return line(map.get(''));}
export function clocksHtml(doc,path){const nodes=doc.nodes.filter(n=>n.uci&&n.elapsed!=null);if(!nodes.length)return ui('<p class="muted">Aucun temps par coup disponible dans ce PGN.</p>');const max=Math.max(1,...nodes.map(n=>n.elapsed));return '<div class="clock-chart">'+nodes.map(n=>'<button title="'+esc(n.san+' : '+time(n.elapsed))+'" data-path="'+n.path+'" class="'+(n.path===path?'current':'')+'" style="height:'+Math.max(3,n.elapsed/max*85)+'px"></button>').join('')+ui('</div><small>Temps utilisé par coup · données du PGN</small>');}
