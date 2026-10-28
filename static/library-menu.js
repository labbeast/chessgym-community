import {t} from './i18n.js';
import {esc} from './api.js';
import {uiIcon} from './ui-icons.js';
import {libraryModes} from './library-modes.js';

// Scoped to the library: other right-click menus keep their usual behavior.
export class LibraryMenu {
 constructor(root,{onAction,canDeleteFolder=()=>false,getBase=()=>null,onToggleMode,onError=()=>{},document:doc=globalThis.document,window:win=globalThis.window}={}){
  Object.assign(this,{root,onAction,canDeleteFolder,getBase,onToggleMode,onError,document:doc,window:win});this.listeners=[];this.press=null;this.suppressUntil=0;this.saving=false;
  this.listen(root,'contextmenu',e=>{const target=this.target(e.target);if(!target||e.shiftKey)return;e.preventDefault();if(this.press||(e.pointerType&&e.pointerType!=='mouse')){this.suppressUntil=Date.now()+900;this.suppressedAnchor=target.anchor;}this.cancelPress();this.open(target,{x:e.clientX,y:e.clientY});});
  this.listen(root,'keydown',e=>{if(e.key==='ContextMenu'||(e.key==='F10'&&e.shiftKey)){const target=this.target(e.target);if(target){e.preventDefault();e.stopPropagation();this.open(target);}}});
  this.listen(root,'pointerdown',e=>{this.cancelPress();const target=this.target(e.target);if(!target||e.pointerType==='mouse'||e.isPrimary===false)return;this.suppressUntil=0;this.suppressedAnchor=null;this.touchPointer=e.pointerId;this.touchAnchor=target.anchor;const press={id:e.pointerId,x:e.clientX,y:e.clientY,target};press.timer=setTimeout(()=>{if(this.press!==press)return;this.press=null;this.suppressUntil=Date.now()+900;this.suppressedAnchor=target.anchor;this.open(target,{x:press.x,y:press.y});},550);this.press=press;});
  this.listen(win,'pointermove',e=>{if(this.press?.id===e.pointerId&&Math.hypot(e.clientX-this.press.x,e.clientY-this.press.y)>9)this.cancelPress();});
  const endPress=e=>{if(this.touchPointer===e.pointerId){if(this.suppressedAnchor===this.touchAnchor)this.suppressUntil=Date.now()+900;this.touchPointer=null;this.touchAnchor=null;}this.cancelPress();};
  this.listen(win,'pointerup',endPress);this.listen(win,'pointercancel',endPress);
  this.listen(root,'click',e=>{if(Date.now()<this.suppressUntil&&this.target(e.target)?.anchor===this.suppressedAnchor){e.preventDefault();e.stopImmediatePropagation();}},true);
  this.listen(doc,'pointerdown',e=>{if(this.menu&&!this.menu.contains(e.target))this.close();},true);
  this.listen(doc,'keydown',e=>{if(!this.menu)return;if(e.key==='Escape'){e.preventDefault();e.stopPropagation();this.close(true);}else if(e.key==='Tab'){this.close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();const items=[...this.menu.querySelectorAll('[data-library-menu-action]')],current=items.indexOf(this.document.activeElement);const next=e.key==='Home'?0:e.key==='End'?items.length-1:(current+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}});
  this.listen(win,'scroll',e=>{if(!this.menu?.contains(e.target)){this.cancelPress();this.close();}},true);
  this.listen(win,'resize',()=>this.close());this.listen(win,'blur',()=>this.close());
 }
 listen(el,type,fn,capture=false){el.addEventListener(type,fn,capture);this.listeners.push([el,type,fn,capture]);}
 target(element){
  const anchor=element?.closest?.('[data-base],[data-folder]');if(!anchor||!this.root.contains(anchor))return null;
  const type=anchor.dataset.base!==undefined?'base':'folder',id=Number(type==='base'?anchor.dataset.base:anchor.dataset.folder);
  return Number.isSafeInteger(id)&&id>0?{anchor,type,id}:null;
 }
 cancelPress(){if(this.press)clearTimeout(this.press.timer);this.press=null;}
 open(target,point=null){
  this.close();if(!target?.anchor?.isConnected)return;this.anchor=target.anchor;this.anchor.classList.add('library-menu-target');this.anchor.setAttribute('aria-expanded','true');
  const menu=this.document.createElement('div');this.menu=menu;menu.className='library-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',target.type==='base'?t('Actions de la base'):t('Actions du dossier'));
  const name=this.anchor.dataset.contextName||'',label=target.type==='base'?t('Réglages de la base'):t('Renommer le dossier…');
  // Repertoires need their side and primary status configured in the full settings.
  const modes=target.type==='base'&&this.onToggleMode?libraryModes(this.getBase(target.id)).filter(mode=>mode.key!=='is_repertoire'):[];
  const actions=[{key:target.type==='base'?'settings':'rename',label}];
  if(target.type==='folder'&&this.canDeleteFolder(target.id))actions.push({key:'delete',label:t('Supprimer le dossier vide'),danger:true});
  menu.innerHTML='<div class="library-menu-title" role="presentation">'+esc(name)+'</div>'+modes.map(mode=>'<button type="button" role="menuitemcheckbox" aria-checked="'+mode.checked+'" tabindex="-1" data-library-menu-action="'+mode.key+'"><span class="library-mode-check" aria-hidden="true"></span>'+uiIcon(mode.icon)+'<span>'+esc(mode.label)+'</span></button>').join('')+(modes.length?'<div class="library-menu-separator" role="separator"></div>':'')+actions.map(action=>'<button type="button" role="menuitem" tabindex="-1" data-library-menu-action="'+action.key+'"'+(action.danger?' class="danger quiet"':'')+'>'+esc(action.label)+'</button>').join('');
  this.document.body.append(menu);menu.oncontextmenu=e=>e.preventDefault();
  menu.querySelectorAll('[data-library-menu-action]').forEach(button=>button.onclick=()=>{if(this.saving)return;const action=button.dataset.libraryMenuAction;if(modes.some(mode=>mode.key===action))return this.toggleMode(target,action,button);this.close(true);this.onAction(target.type,target.id,action);});
  this.setBusy(this.saving);
  const box=this.anchor.getBoundingClientRect(),rect=menu.getBoundingClientRect(),width=this.window.innerWidth||this.document.documentElement.clientWidth,height=this.window.innerHeight||this.document.documentElement.clientHeight;
  menu.style.left=Math.max(8,Math.min(point?.x??box.left,width-rect.width-8))+'px';menu.style.top=Math.max(8,Math.min(point?.y??box.bottom,height-rect.height-8))+'px';
  menu.querySelector('[data-library-menu-action]')?.focus({preventScroll:true});
 }
 setBusy(busy){this.menu?.setAttribute('aria-busy',String(busy));this.menu?.querySelectorAll('[data-library-menu-action]').forEach(button=>button.setAttribute('aria-disabled',String(busy)));}
 async toggleMode(target,key,button){
  const mode=libraryModes(this.getBase(target.id)).find(mode=>mode.key===key);if(!mode||this.saving)return;
  this.saving=true;this.setBusy(true);
  try{
   await this.onToggleMode(target.id,key,!mode.checked);
   // The menu may have been closed and reopened while the request was pending.
   if(this.anchor?.dataset.base===String(target.id))for(const item of this.menu?.querySelectorAll('[data-library-menu-action]')||[]){const current=libraryModes(this.getBase(target.id)).find(mode=>mode.key===item.dataset.libraryMenuAction);if(current)item.setAttribute('aria-checked',String(current.checked));}
  }catch(error){this.onError(error);}
  finally{this.saving=false;this.setBusy(false);}
 }
 close(restore=false){this.cancelPress();const anchor=this.anchor;this.menu?.remove();this.menu=null;anchor?.classList.remove('library-menu-target');anchor?.setAttribute('aria-expanded','false');this.anchor=null;if(restore&&anchor?.isConnected)anchor.focus({preventScroll:true});}
 dispose(){this.close();for(const [el,type,fn,capture] of this.listeners)el.removeEventListener(type,fn,capture);this.listeners=[];}
}
