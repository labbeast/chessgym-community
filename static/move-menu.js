import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';

// A move inside a continuation targets the nearest enclosing choice for local
// ordering. Deletion always starts at the exact move the user selected.
export function moveActions(doc,path) {
 const map=new Map((doc.nodes||[]).map(n=>[n.path,n]));
 const node=map.get(path);let branch=null,current=node,offMain=false;
 while(current&&current.parent!==null){
  const parent=map.get(current.parent);if(!parent)break;
  const index=(parent.children||[]).indexOf(current.path);
  if(index>0)offMain=true;
  if(!branch&&(parent.children||[]).length>1)branch={path:current.path,index,total:parent.children.length};
  current=parent;
 }
 const exists=!!node&&path!=='';
 return {node,branch,delete:exists,up:exists&&!!branch&&branch.index>0,
  down:exists&&!!branch&&branch.index<branch.total-1,promote:exists&&!!branch&&branch.index>0,
  main:exists&&offMain,annotate:exists};
}

const labels=()=>[
 ['up',t('Monter la variante')],['down',t('Descendre la variante')],
 ['promote',t('Promouvoir dans cette variante')],['main',t('Promouvoir en ligne principale')],
 ['annotate',t('Commenter / annoter')],['delete',t('Supprimer à partir d’ici')],
];

export class MoveMenu {
 constructor(root,{getDoc,onAction,canBookmark=()=>false,document:doc=globalThis.document,window:win=globalThis.window}={}){
  Object.assign(this,{root,getDoc,onAction,canBookmark,document:doc,window:win});this.listeners=[];this.press=null;this.suppressUntil=0;
  this.listen(root,'contextmenu',e=>{const token=this.token(e.target);if(!token||e.shiftKey)return;e.preventDefault();this.cancelPress();this.open(token.dataset.path,token,{x:e.clientX,y:e.clientY});});
  this.listen(root,'keydown',e=>{if(e.key==='ContextMenu'||(e.key==='F10'&&e.shiftKey)){const token=this.token(e.target);if(token){e.preventDefault();this.open(token.dataset.path,token);}}});
  this.listen(root,'pointerdown',e=>{const token=this.token(e.target);if(!token||e.pointerType==='mouse'||e.isPrimary===false)return;this.cancelPress();const press={id:e.pointerId,x:e.clientX,y:e.clientY,token};press.timer=setTimeout(()=>{if(this.press!==press)return;this.press=null;this.suppressUntil=Date.now()+900;this.open(token.dataset.path,token,{x:press.x,y:press.y});},550);this.press=press;});
  this.listen(win,'pointermove',e=>{if(this.press?.id===e.pointerId&&Math.hypot(e.clientX-this.press.x,e.clientY-this.press.y)>9)this.cancelPress();});
  this.listen(win,'pointerup',()=>this.cancelPress());this.listen(win,'pointercancel',()=>this.cancelPress());
  this.listen(root,'click',e=>{if(Date.now()<this.suppressUntil&&this.token(e.target)){e.preventDefault();e.stopImmediatePropagation();}},true);
  this.listen(doc,'pointerdown',e=>{if(this.menu&&!this.menu.contains(e.target))this.close();},true);
  this.listen(doc,'keydown',e=>this.keydown(e));
  this.listen(win,'scroll',e=>{if(!this.menu?.contains(e.target)){this.cancelPress();this.close();}},true);
  this.listen(win,'resize',()=>this.close());this.listen(win,'blur',()=>{this.cancelPress();this.close();});
 }
 listen(el,type,fn,capture=false){el.addEventListener(type,fn,capture);this.listeners.push([el,type,fn,capture]);}
 token(target){const token=target?.closest?.('.move[data-path]');return token&&this.root.contains(token)?token:null;}
 cancelPress(){if(this.press)clearTimeout(this.press.timer);this.press=null;}
 open(path,anchor,point=null){
  this.close();const status=moveActions(this.getDoc(),path);if(!status.node||path==='')return;
  this.anchor=anchor;this.selectedPath=path;anchor?.classList.add('menu-target');anchor?.setAttribute('aria-expanded','true');
  const menu=this.document.createElement('div');this.menu=menu;menu.className='move-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label',t('Actions pour ')+(status.node.san||t('ce coup')));
  const available=this.canBookmark(path)?[...labels().slice(0,-1),['bookmark',t('⚑ Déplacer le signet ici')],labels().at(-1)]:labels();
  status.bookmark=true;
  menu.innerHTML='<div class="move-menu-title" role="presentation">'+esc(status.node.san||t('Coup'))+'</div>'+available.map(([action,label])=>'<button type="button" role="menuitem" tabindex="-1" data-tree-action="'+action+'" '+(!status[action]?'disabled aria-disabled="true"':'')+' class="'+(action==='delete'?'danger':'')+'">'+label+'</button>').join('');
  (this.root.closest('dialog')||this.document.body).append(menu);
  for(const button of menu.querySelectorAll('[data-tree-action]'))button.onclick=()=>{if(button.disabled)return;const action=button.dataset.treeAction;this.close();this.onAction(action,path);};
  const box=anchor?.getBoundingClientRect()||{left:12,bottom:12},rect=menu.getBoundingClientRect();
  const width=this.window.innerWidth||this.document.documentElement.clientWidth,height=this.window.innerHeight||this.document.documentElement.clientHeight;
  menu.style.left=Math.max(8,Math.min(point?.x??box.left,width-rect.width-8))+'px';menu.style.top=Math.max(8,Math.min(point?.y??box.bottom,height-rect.height-8))+'px';
  this.items()[0]?.focus({preventScroll:true});
 }
 items(){return [...(this.menu?.querySelectorAll('[role=menuitem]')||[])].filter(el=>!el.disabled);}
 keydown(e){if(!this.menu)return;if(e.key==='Escape'){e.preventDefault();this.close(true);return;}if(e.key==='Tab'){this.close();return;}
  if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;e.preventDefault();const items=this.items();if(!items.length)return;const i=items.indexOf(this.document.activeElement),next=e.key==='Home'?0:e.key==='End'?items.length-1:e.key==='ArrowDown'?(i+1)%items.length:(i<0?items.length-1:(i-1+items.length)%items.length);items[next].focus();
 }
 close(restore=false){this.cancelPress();const anchor=this.anchor;this.menu?.remove();this.menu=null;anchor?.classList.remove('menu-target');anchor?.setAttribute('aria-expanded','false');this.anchor=null;if(restore&&anchor?.isConnected)anchor.focus({preventScroll:true});}
 dispose(){this.cancelPress();this.close();for(const [el,type,fn,capture] of this.listeners)el.removeEventListener(type,fn,capture);this.listeners=[];}
}

// Navigation updates the stored cursor without creating an edit. Snapshots are
// detached from live documents so an in-place annotation can be undone safely.
export class AnalysisHistory {
 constructor(limit=100){this.limit=limit;this.reset();}
 reset(doc=null,path=''){this.past=[];this.future=[];this.current=doc?this.snapshot(doc,path):null;}
 snapshot(doc,path){const copy=structuredClone(doc);delete copy.history;return {doc:copy,path,signature:JSON.stringify({headers:copy.headers,nodes:copy.nodes,title:copy.title,start_path:copy.start_path})};}
 record(doc,path=''){
  const next=this.snapshot(doc,path);
  if(!this.current){this.current=next;return;}
  if(next.signature===this.current.signature){this.current.path=path;return;}
  this.past.push(this.current);if(this.past.length>this.limit)this.past.shift();this.current=next;this.future=[];
 }
 flags(){return {can_undo:this.past.length>0,can_redo:this.future.length>0};}
 take(direction){const source=direction==='undo'?this.past:this.future,target=direction==='undo'?this.future:this.past;if(!source.length)return null;if(this.current)target.push(this.current);this.current=source.pop();return {doc:structuredClone(this.current.doc),path:this.current.path};}
}
