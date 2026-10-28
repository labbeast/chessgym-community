import test from 'node:test';
import assert from 'node:assert/strict';
import {BoardDraftMenu} from '../static/board-draft-menu.js';

class Element{
 constructor(document=null,dataset={},parent=null){Object.assign(this,{document,dataset,parent,children:[],attributes:{},listeners:new Map(),style:{},isConnected:true,tagName:'DIV'});parent?.children.push(this);const names=new Set();this.classList={add:n=>names.add(n),remove:n=>names.delete(n),contains:n=>names.has(n)};}
 addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener);}
 removeEventListener(type,listener){this.listeners.set(type,(this.listeners.get(type)||[]).filter(fn=>fn!==listener));}
 emit(type,event){for(const fn of this.listeners.get(type)||[])fn(event);}
 contains(node){for(let current=node;current;current=current.parent)if(current===this)return true;return false;}
 closest(selector){for(let n=this;n;n=n.parent)if(selector==='button'&&n.tagName==='BUTTON'||selector==='[data-board-draft]'&&n.dataset.boardDraft!==undefined||selector==='[data-board-draft-options]'&&n.dataset.boardDraftOptions!==undefined)return n;return null;}
 setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return this.attributes[name]??null;}
 append(child){child.parent=this;this.children.push(child);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(c=>c!==this);this.isConnected=false;}
 focus(){this.document.activeElement=this;}
 getBoundingClientRect(){return {left:15,top:20,bottom:50,width:235,height:120};}
 set innerHTML(html){this.html=html;this.children=[];for(const match of html.matchAll(/<button[^>]*data-board-draft-action="([^"]+)"[^>]*>([^]*?)<\/button>/g)){const child=new Element(this.document,{boardDraftAction:match[1]},this);child.tagName='BUTTON';child.attributes.role='menuitem';child.textContent=match[2];}}
 querySelectorAll(selector){return selector==='[role=menuitem]'?this.children.filter(c=>c.attributes.role==='menuitem'):selector==='button'?this.children.filter(c=>c.tagName==='BUTTON'):[];}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function environment(){
 const document=new Element();document.document=document;document.body=new Element(document);document.documentElement={clientWidth:1000,clientHeight:800};document.createElement=()=>new Element(document);
 const root=new Element(document),window=new Element(document);Object.assign(window,{innerWidth:390,innerHeight:400});
 const item=new Element(document,{boardDraft:'free:one'},root),button=new Element(document,{},item),options=new Element(document,{boardDraftOptions:'free:one'},item);button.tagName=options.tagName='BUTTON';
 const saved=new Element(document,{},root),savedButton=new Element(document,{},saved);savedButton.tagName='BUTTON';
 const drafts=new Map([['free:one',{identity:'free:one',title:'<script>My draft</script>'}]]),actions=[];
 const menu=new BoardDraftMenu(root,{document,window,getDraft:id=>drafts.get(id)||null,onAction:async(...args)=>actions.push(args)});
 return {document,root,window,item,button,options,savedButton,drafts,actions,menu};
}
const event=(target,extra={})=>({target,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;},...extra});

test('right-click scope is limited to current genuine drafts and escapes the menu title',()=>{
 const ui=environment(),saved=event(ui.savedButton);ui.root.emit('contextmenu',saved);assert.equal(saved.prevented,false);assert.equal(ui.menu.menu,null);
 const opened=event(ui.button,{clientX:20,clientY:40});ui.root.emit('contextmenu',opened);assert(opened.prevented);assert(opened.stopped);assert.match(ui.menu.menu.html,/&lt;script&gt;/);assert.doesNotMatch(ui.menu.menu.html,/<script>/);assert.deepEqual(ui.menu.menu.children.map(c=>c.dataset.boardDraftAction),['rename','delete']);
 ui.menu.close();ui.drafts.clear();const stale=event(ui.button);ui.root.emit('contextmenu',stale);assert.equal(stale.prevented,false);assert.equal(ui.menu.menu,null);ui.menu.dispose();
});
test('ellipsis opens a menu without activating the board row or bubbling outside-click',()=>{
 const ui=environment(),opened=event(ui.options);ui.root.emit('click',opened);assert(opened.prevented);assert(opened.stopped);assert(ui.menu.menu);assert.equal(ui.menu.anchor,ui.options);assert.equal(ui.actions.length,0);const toggle=event(ui.options);ui.root.emit('click',toggle);assert.equal(ui.menu.menu,null);assert.equal(ui.document.activeElement,ui.options);ui.menu.dispose();
});
test('Shift F10, arrows, Home End and Escape provide complete keyboard navigation',()=>{
 const ui=environment(),keyboard=event(ui.button,{key:'F10',shiftKey:true});ui.root.emit('keydown',keyboard);assert(keyboard.prevented);const [rename,remove]=ui.menu.menu.children;assert.equal(ui.document.activeElement,rename);
 ui.document.emit('keydown',event(rename,{key:'ArrowDown'}));assert.equal(ui.document.activeElement,remove);ui.document.emit('keydown',event(remove,{key:'ArrowDown'}));assert.equal(ui.document.activeElement,rename);ui.document.emit('keydown',event(rename,{key:'End'}));assert.equal(ui.document.activeElement,remove);ui.document.emit('keydown',event(remove,{key:'Home'}));assert.equal(ui.document.activeElement,rename);
 const escape=event(rename,{key:'Escape'});ui.document.emit('keydown',escape);assert(escape.prevented);assert(escape.stopped);assert.equal(ui.menu.menu,null);assert.equal(ui.document.activeElement,ui.button);ui.menu.dispose();
});
test('Tab closes and returns focus without trapping normal tab movement',()=>{
 const ui=environment();ui.root.emit('keydown',event(ui.options,{key:'ContextMenu'}));const tab=event(ui.document.activeElement,{key:'Tab'});ui.document.emit('keydown',tab);assert.equal(tab.prevented,false);assert.equal(ui.menu.menu,null);assert.equal(ui.document.activeElement,ui.options);ui.menu.dispose();
});
test('viewport clamping keeps the menu inside narrow screens',()=>{
 const ui=environment();ui.root.emit('contextmenu',event(ui.button,{clientX:390,clientY:400}));assert.equal(ui.menu.menu.style.left,'147px');assert.equal(ui.menu.menu.style.top,'272px');ui.root.emit('contextmenu',event(ui.button,{clientX:-20,clientY:-20}));assert.equal(ui.menu.menu.style.left,'8px');assert.equal(ui.menu.menu.style.top,'8px');ui.menu.dispose();
});
test('action callbacks revalidate draft state and never dispatch against saved rows',async()=>{
 const ui=environment();ui.root.emit('click',event(ui.options));await ui.menu.activate('free:one','rename');assert.deepEqual(ui.actions,[['free:one','rename']]);assert.equal(ui.document.activeElement,ui.options);
 ui.root.emit('click',event(ui.options));ui.drafts.clear();await ui.menu.activate('free:one','delete');assert.deepEqual(ui.actions,[['free:one','rename']]);assert.equal(ui.menu.menu,null);ui.menu.dispose();
});
test('outside pointer/focus, scroll, resize, refresh and disposal close cleanly',()=>{
 const ui=environment(),outside=new Element(ui.document);const open=()=>ui.root.emit('click',event(ui.options));
 open();ui.document.emit('pointerdown',event(ui.menu.menu.children[0]));assert(ui.menu.menu);ui.document.emit('pointerdown',event(outside));assert.equal(ui.menu.menu,null);
 open();ui.document.emit('focusin',event(outside));assert.equal(ui.menu.menu,null);
 open();ui.window.emit('scroll',event(ui.menu.menu));assert(ui.menu.menu);ui.window.emit('scroll',event(ui.root));assert.equal(ui.menu.menu,null);
 open();ui.window.emit('resize',event(ui.window));assert.equal(ui.menu.menu,null);open();ui.menu.refresh();assert.equal(ui.menu.menu,null);
 open();ui.menu.dispose();assert.equal(ui.menu.menu,null);for(const element of [ui.root,ui.document,ui.window])assert.equal([...element.listeners.values()].flat().length,0);assert.equal(ui.item.classList.contains('board-draft-menu-target'),false);ui.menu.dispose();
});
test('shift-right-click and out-of-root drafts retain native context behavior',()=>{
 const ui=environment(),shift=event(ui.button,{shiftKey:true});ui.root.emit('contextmenu',shift);assert.equal(shift.prevented,false);const other=new Element(ui.document,{boardDraft:'free:one'}),button=new Element(ui.document,{},other);button.tagName='BUTTON';const outside=event(button);ui.root.emit('contextmenu',outside);assert.equal(outside.prevented,false);assert.equal(ui.menu.menu,null);ui.menu.dispose();
});
