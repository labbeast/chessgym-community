import {esc} from './api.js';
import {t} from './i18n.js';
import {pieceUrl} from './appearance.js';
import {pieces} from './chess-document.js';

let previewSerial=0;
function boardHtml({fen,flipped,uci}){
 const position=pieces(fen),files=flipped?'hgfedcba':'abcdefgh',ranks=flipped?[1,2,3,4,5,6,7,8]:[8,7,6,5,4,3,2,1];
 return '<div class="board-recent-preview-board" aria-hidden="true">'+ranks.map((rank,ri)=>[...files].map((file,fi)=>{
  const square=file+rank,piece=position[square],light=('abcdefgh'.indexOf(file)+rank)%2===0,last=uci&&(uci.slice(0,2)===square||uci.slice(2,4)===square);
  return '<span class="board-recent-preview-square '+(light?'light':'dark')+(last?' last':'')+'" data-square="'+square+'">'+(piece?'<img src="'+esc(pieceUrl(piece))+'" alt="" draggable="false">':'')+(fi===0?'<span class="rank">'+rank+'</span>':'')+(ri===7?'<span class="file">'+file+'</span>':'')+'</span>';
 }).join('')).join('')+'</div><div class="board-recent-preview-caption">'+esc(t('Dernière position active'))+'</div>';
}

// A display-only board outside the scrolling menu; no Board instance, moves or sounds.
export class BoardRecentPreview{
 constructor(host,{getPosition,delay=180}={}){
  this.host=host;this.getPosition=getPosition;this.delay=delay;this.listeners=[];this.id='board-recent-preview-'+(++previewSerial);this.sequence=0;
  this.listen(host,'pointerover',event=>{if(event.pointerType==='touch')return;this.touch=false;const row=this.row(event.target);if(row&&!row.contains(event.relatedTarget))this.schedule(row);});
  this.listen(host,'pointerout',event=>{if(this.target===this.row(event.target)&&!this.target?.contains(event.relatedTarget))this.hide();});
  this.listen(host,'focusin',event=>{const row=this.row(event.target);if(!this.touch&&row?.matches(':focus-visible'))this.schedule(row);});
  this.listen(host,'focusout',event=>{if(this.target===this.row(event.target)&&!this.target?.contains(event.relatedTarget))this.hide();});
  this.listen(host,'pointerdown',event=>{this.touch=event.pointerType==='touch';this.hide();});
  this.listen(host,'click',()=>this.hide());
  this.listen(host,'contextmenu',()=>this.hide());
  this.listen(host,'toggle',()=>{if(this.target&&!this.visible(this.target))this.hide();},true);
  this.listen(document,'keydown',event=>{this.touch=false;if(event.key==='Escape')this.hide();},true);
  this.listen(document,'scroll',()=>this.hide(),true);
  this.listen(window,'resize',()=>this.hide());
  this.listen(window,'blur',()=>this.hide());
  this.observer=new MutationObserver(()=>{if(this.target&&!this.visible(this.target))this.hide();});
  this.observer.observe(host,{childList:true,subtree:true});
 }
 listen(target,type,callback,capture=false){target.addEventListener(type,callback,capture);this.listeners.push(()=>target.removeEventListener(type,callback,capture));}
 row(target){const row=target?.closest?.('.board-recent-row');return row&&this.host.contains(row)?row:null;}
 visible(row){return row.isConnected&&row.closest('[data-board-menu]')?.open&&row.closest('.board-recent-section')?.open&&row.getClientRects().length>0;}
 schedule(row){
  if(this.target===row||!this.visible(row))return;
  this.hide();this.target=row;const sequence=this.sequence;
  this.timer=setTimeout(()=>{this.timer=null;void this.show(row,sequence);},this.delay);
 }
 async show(row,sequence){
  if(this.target!==row||!this.visible(row)||sequence!==this.sequence)return;
  const controller=new AbortController();this.controller=controller;
  try{
   const position=await this.getPosition(row,{signal:controller.signal});
   if(!position?.fen||controller.signal.aborted||sequence!==this.sequence||this.target!==row||!this.visible(row))return;
   const popup=document.createElement('div');popup.id=this.id;popup.className='board-recent-preview';popup.setAttribute('role','tooltip');popup.dataset.fen=position.fen;popup.dataset.flipped=String(!!position.flipped);
   popup.innerHTML=boardHtml(position);document.body.append(popup);this.popup=popup;
   row.setAttribute('aria-describedby',[row.getAttribute('aria-describedby'),this.id].filter(Boolean).join(' '));
   const box=popup.getBoundingClientRect(),anchor=row.getBoundingClientRect(),menu=row.closest('[data-board-menu-content]').getBoundingClientRect(),gap=10,margin=8;
   let left=menu.right+gap;
   if(left+box.width>window.innerWidth-margin)left=menu.left-box.width-gap;
   popup.style.left=Math.max(margin,Math.min(left,window.innerWidth-box.width-margin))+'px';
   popup.style.top=Math.max(margin,Math.min(anchor.top,window.innerHeight-box.height-margin))+'px';
  }catch(error){if(error.name!=='AbortError'&&sequence===this.sequence)this.hide();}
 }
 hide(){
  this.sequence++;clearTimeout(this.timer);this.timer=null;this.controller?.abort();this.controller=null;
  if(this.target){const described=(this.target.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==this.id).join(' ');if(described)this.target.setAttribute('aria-describedby',described);else this.target.removeAttribute('aria-describedby');}
  this.popup?.remove();this.popup=null;this.target=null;
 }
 dispose(){this.hide();this.observer.disconnect();this.listeners.forEach(remove=>remove());this.listeners=[];}
}
