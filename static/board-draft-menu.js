import {esc,fail} from './api.js';
import {t} from './i18n.js';
import {uiIcon} from './ui-icons.js';

// This menu only addresses recoverable analysis drafts. Library games retain
// their native right-click behavior and cannot acquire draft actions here.
export class BoardDraftMenu{
 constructor(root,{getDraft=()=>null,onAction,document:doc=globalThis.document,window:win=globalThis.window}={}){
  Object.assign(this,{root,getDraft,onAction,document:doc,window:win});this.listeners=[];this.disposed=false;this.menu=null;this.anchor=null;
  this.listen(root,'contextmenu',event=>{if(event.shiftKey)return;const target=this.target(event.target);if(!target)return;event.preventDefault();event.stopPropagation();this.open(target,Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)?{x:event.clientX,y:event.clientY}:null);});
  this.listen(root,'keydown',event=>{if(event.key!=='ContextMenu'&&!(event.key==='F10'&&event.shiftKey))return;const target=this.target(event.target);if(!target)return;event.preventDefault();event.stopPropagation();this.open(target);});
  this.listen(root,'click',event=>{const options=event.target?.closest?.('[data-board-draft-options]');if(!options||!root.contains(options))return;const target=this.target(options);if(!target)return;event.preventDefault();event.stopPropagation();if(this.menu&&this.identity===target.identity)this.close(true);else this.open(target);},true);
  this.listen(doc,'pointerdown',event=>{if(this.menu&&!this.menu.contains(event.target)&&!this.anchor?.contains(event.target))this.close();},true);
  this.listen(doc,'focusin',event=>{if(this.menu&&!this.menu.contains(event.target)&&!this.anchor?.contains(event.target))this.close();});
  this.listen(doc,'keydown',event=>{
   if(!this.menu)return;
   if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.close(true);return;}
   if(event.key==='Tab'){this.close(true);return;}
   if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
   event.preventDefault();event.stopPropagation();const items=[...this.menu.querySelectorAll('[role=menuitem]')],current=items.indexOf(this.document.activeElement);
   const next=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();
  },true);
  this.listen(win,'scroll',event=>{if(this.menu&&!this.menu.contains(event.target))this.close();},true);
  this.listen(win,'resize',()=>this.close());this.listen(win,'blur',()=>this.close());
 }
 listen(element,type,listener,capture=false){element?.addEventListener(type,listener,capture);this.listeners.push([element,type,listener,capture]);}
 target(element){
  if(this.disposed)return null;const item=element?.closest?.('[data-board-draft]');if(!item||!this.root.contains(item))return null;
  const identity=item.dataset.boardDraft,draft=this.getDraft(identity);if(!draft||draft.identity!==identity)return null;
  const button=element.closest?.('button'),anchor=button&&item.contains(button)?button:item.querySelector('button');
  return anchor?{item,anchor,identity,title:draft.title}:null;
 }
 open(target,point=null){
  this.close();if(this.disposed||!target?.anchor?.isConnected)return;const draft=this.getDraft(target.identity);if(!draft||draft.identity!==target.identity)return;
  this.anchor=target.anchor;this.item=target.item;this.identity=target.identity;this.item.classList.add('board-draft-menu-target');this.anchor.setAttribute('aria-expanded','true');
  const menu=this.document.createElement('div');this.menu=menu;menu.className='board-draft-context-menu';menu.setAttribute('data-board-draft-menu','');menu.setAttribute('role','menu');menu.setAttribute('aria-label',t('Actions du brouillon'));
  menu.innerHTML=`<div class="board-draft-menu-title" role="presentation">${esc(draft.title)}</div><button type="button" role="menuitem" tabindex="-1" data-board-draft-action="rename">${uiIcon('rename','board-menu-icon')}${esc(t('Renommer le brouillon…'))}</button><button type="button" role="menuitem" tabindex="-1" class="danger quiet" data-board-draft-action="delete">${uiIcon('delete','board-menu-icon')}${esc(t('Supprimer le brouillon…'))}</button>`;
  this.document.body.append(menu);menu.oncontextmenu=event=>event.preventDefault();
  menu.querySelectorAll('[role=menuitem]').forEach(button=>button.onclick=event=>{event?.stopPropagation();void this.activate(target.identity,button.dataset.boardDraftAction);});
  const box=this.anchor.getBoundingClientRect(),rect=menu.getBoundingClientRect(),width=this.window.innerWidth||this.document.documentElement.clientWidth,height=this.window.innerHeight||this.document.documentElement.clientHeight;
  menu.style.left=Math.max(8,Math.min(point?.x??box.left,width-rect.width-8))+'px';menu.style.top=Math.max(8,Math.min(point?.y??box.bottom,height-rect.height-8))+'px';
  menu.querySelector('[role=menuitem]')?.focus({preventScroll:true});
 }
 async activate(identity,action){
  if(this.disposed||this.identity!==identity||!['rename','delete'].includes(action))return;
  const draft=this.getDraft(identity);this.close(true);if(!draft||draft.identity!==identity)return;
  try{await this.onAction?.(identity,action);}catch(error){if(!this.disposed)fail(error);}
 }
 close(restore=false){const anchor=this.anchor;this.menu?.remove();this.menu=null;this.item?.classList.remove('board-draft-menu-target');anchor?.setAttribute('aria-expanded','false');this.anchor=null;this.item=null;this.identity=null;if(restore&&anchor?.isConnected)anchor.focus({preventScroll:true});}
 refresh(){this.close();}
 dispose(){if(this.disposed)return;this.disposed=true;this.close();for(const [element,type,listener,capture] of this.listeners)element?.removeEventListener(type,listener,capture);this.listeners=[];}
}
