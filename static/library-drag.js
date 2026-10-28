import {t,ui,locale} from './i18n.js';
import {fail} from './api.js';

export function movePayload(baseId,target){
 if(!Number.isSafeInteger(baseId)||baseId<=0||!target)return null;
 if(target.kind==='folder')return {base_id:baseId,folder_id:target.id};
 if(target.kind==='base'&&target.id!==baseId)return {base_id:baseId,[target.edge==='after'?'after_id':'before_id']:target.id};
 return null;
}

export class LibraryDrag {
 constructor(root,{onMove,onChooseFolder,onError=fail,document:doc=globalThis.document,window:win=globalThis.window}={}){
  Object.assign(this,{root,onMove,onChooseFolder,onError,document:doc,window:win});this.listeners=[];this.suppressUntil=0;this.busy=false;this.disposed=false;
  this.listen(root,'dragstart',event=>this.nativeStart(event));
  this.listen(root,'dragover',event=>{if(!this.active||this.busy)return;const target=this.dropTarget(event.target,event.clientX,event.clientY);this.showTarget(target);if(target){event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='move';}});
  this.listen(root,'dragleave',event=>{if(!root.contains(event.relatedTarget))this.showTarget(null);});
  this.listen(root,'drop',event=>{if(!this.active)return;event.preventDefault();event.stopPropagation();const target=this.dropTarget(event.target,event.clientX,event.clientY);this.finish(target);});
  this.listen(root,'dragend',()=>this.cancel());
  this.listen(root,'pointerdown',event=>this.pointerStart(event));
  this.listen(win,'pointermove',event=>this.pointerMove(event));
  this.listen(win,'pointerup',event=>this.pointerEnd(event));
  this.listen(win,'pointercancel',event=>{if(this.press&&this.press.id===event.pointerId)this.cancel();});
  this.listen(win,'blur',()=>this.cancel());
  this.listen(root,'click',event=>{
   if(Date.now()<this.suppressUntil){event.preventDefault();event.stopImmediatePropagation();return;}
   const handle=event.target.closest?.('[data-library-drag]');if(handle&&event.detail===0&&!this.busy){event.preventDefault();this.onChooseFolder?.(Number(handle.dataset.libraryDrag));}
  },true);
  this.listen(root,'keydown',event=>{
   if(event.key==='Escape'&&(this.active||this.press)){event.preventDefault();event.stopPropagation();this.cancel();return;}
   const handle=event.target.closest?.('[data-library-drag]');if(!handle||this.busy||!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;
   event.preventDefault();event.stopPropagation();const cards=this.cards(),index=cards.findIndex(card=>card.dataset.libraryBase===handle.dataset.libraryDrag),neighbor=cards[index+(event.key==='ArrowUp'?-1:1)];
   if(neighbor)this.commit({base_id:Number(handle.dataset.libraryDrag),[event.key==='ArrowUp'?'before_id':'after_id']:Number(neighbor.dataset.libraryBase)});
  });
 }
 listen(el,type,fn,capture=false){el.addEventListener(type,fn,capture);this.listeners.push([el,type,fn,capture]);}
 cards(){return [...this.root.querySelectorAll('[data-library-base]')];}
 nativeStart(event){
  const card=event.target.closest?.('[data-library-base]');
  if(!card||this.busy||event.target.closest?.('[data-library-drag]')){if(card)event.preventDefault();return;}
  this.begin(card);if(event.dataTransfer){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-chessgym-base',String(this.active.id));}
 }
 begin(card){this.active={id:Number(card.dataset.libraryBase),card};card.classList.add('library-drag-source');this.root.classList.add('library-dragging');}
 dropTarget(element,x,y){
  if(!this.active||!element||!this.root.contains(element))return null;
  const folder=element.closest?.('[data-folder]');
  if(folder){const key=folder.dataset.folder,id=key==='root'?null:Number(key);if(key==='all'||(id!==null&&(!Number.isSafeInteger(id)||id<=0)))return null;return {kind:'folder',id,element:folder};}
  const card=element.closest?.('[data-library-base]');if(!card||Number(card.dataset.libraryBase)===this.active.id)return null;
  const cards=this.cards(),first=cards[0]?.getBoundingClientRect(),second=cards[1]?.getBoundingClientRect(),vertical=!second||Math.abs(first.top-second.top)>5;
  const rect=card.getBoundingClientRect(),after=vertical?y>rect.top+rect.height/2:x>rect.left+rect.width/2;
  return {kind:'base',id:Number(card.dataset.libraryBase),edge:after?'after':'before',vertical,element:card};
 }
 showTarget(target){
  this.target?.element?.classList.remove('library-drop-folder','library-drop-before','library-drop-after','library-drop-vertical');this.target=target;
  if(!target)return;target.element.classList.add(target.kind==='folder'?'library-drop-folder':'library-drop-'+target.edge);if(target.vertical)target.element.classList.add('library-drop-vertical');
 }
 pointerStart(event){
  const handle=event.target.closest?.('[data-library-drag]');
  if(!handle){const card=event.target.closest?.('[data-library-base]');if(card)card.draggable=event.pointerType==='mouse';return;}
  if(!this.root.contains(handle)||event.button!==0||event.isPrimary===false||this.busy)return;
  const card=handle.closest('[data-library-base]');if(!card)return;event.preventDefault();this.cancel();
  this.press={id:event.pointerId,x:event.clientX,y:event.clientY,handle,card};handle.setPointerCapture?.(event.pointerId);
 }
 pointerMove(event){
  const press=this.press;if(!press||press.id!==event.pointerId)return;
  if(!this.active&&Math.hypot(event.clientX-press.x,event.clientY-press.y)<7)return;
  if(!this.active){this.begin(press.card);this.ghost=this.document.createElement('div');this.ghost.className='library-drag-ghost';this.ghost.textContent=press.card.querySelector('[data-base]')?.dataset.contextName||t('Déplacer la base');this.document.body.append(this.ghost);}
  event.preventDefault();this.ghost.style.left=(event.clientX+14)+'px';this.ghost.style.top=(event.clientY+14)+'px';
  this.showTarget(this.dropTarget(this.document.elementFromPoint(event.clientX,event.clientY),event.clientX,event.clientY));
 }
 pointerEnd(event){
  const press=this.press;if(!press||press.id!==event.pointerId)return;event.preventDefault();
  if(this.active)this.finish(this.dropTarget(this.document.elementFromPoint(event.clientX,event.clientY),event.clientX,event.clientY));
  else {const id=Number(press.card.dataset.libraryBase);this.cancel();this.suppressUntil=Date.now()+700;this.onChooseFolder?.(id);}
 }
 finish(target){const payload=movePayload(this.active?.id,target);this.cancel();if(payload)this.commit(payload);}
 cancel(){
  if(this.active||this.press)this.suppressUntil=Date.now()+700;
  this.active?.card?.classList.remove('library-drag-source');this.root.classList.remove('library-dragging');this.showTarget(null);
  if(this.press){try{this.press.handle.releasePointerCapture?.(this.press.id);}catch{}}
  this.ghost?.remove();this.ghost=null;this.active=null;this.press=null;
 }
 async commit(payload){
  if(this.busy||this.disposed)return;this.busy=true;this.root.classList.add('library-drag-busy');this.root.setAttribute('aria-busy','true');
  try{await this.onMove?.(payload);}catch(error){this.onError(error);}finally{this.busy=false;if(!this.disposed){this.root.classList.remove('library-drag-busy');this.root.removeAttribute('aria-busy');}}
 }
 dispose(){this.disposed=true;this.cancel();for(const [el,type,fn,capture] of this.listeners)el.removeEventListener(type,fn,capture);this.listeners=[];}
}
