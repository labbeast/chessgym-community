import assert from 'node:assert/strict';
import {LibraryMenu} from '../static/library-menu.js';

class Element{
 constructor(document=null,dataset={},parent=null){Object.assign(this,{document,dataset,parent,children:[],attributes:{},listeners:new Map(),style:{},isConnected:true});parent?.children.push(this);const classes=new Set();this.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name)};}
 addEventListener(type,listener){if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener);}
 removeEventListener(type,listener){this.listeners.set(type,(this.listeners.get(type)||[]).filter(item=>item!==listener));}
 emit(type,event){for(const listener of this.listeners.get(type)||[])listener(event);}
 contains(node){for(let current=node;current;current=current.parent)if(current===this)return true;return false;}
 closest(selector){for(let current=this;current;current=current.parent)if(selector==='[data-base],[data-folder]'&&(current.dataset.base!==undefined||current.dataset.folder!==undefined))return current;return null;}
 setAttribute(name,value){this.attributes[name]=String(value);}getAttribute(name){return this.attributes[name]??null;}removeAttribute(name){delete this.attributes[name];}
 append(child){child.parent=this;this.children.push(child);}remove(){if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);this.isConnected=false;}
 focus(){this.document.activeElement=this;}
 getBoundingClientRect(){return {left:15,top:20,bottom:50,width:230,height:120};}
 set innerHTML(html){this.html=html;this.children=[];for(const match of html.matchAll(/<button([^>]*)>([^]*?)<\/button>/g)){const attributes=Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(item=>[item[1],item[2]]));if(!attributes['data-library-menu-action'])continue;const child=new Element(this.document,{libraryMenuAction:attributes['data-library-menu-action']},this);child.attributes=attributes;child.textContent=match[2];}}
 querySelectorAll(selector){return this.children.filter(child=>selector.split(',').some(part=>{const match=part.trim().match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);return match&&child.attributes[match[1]]!==undefined&&(match[2]===undefined||child.attributes[match[1]]===match[2]);}));}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
}
function environment(options={}){
 const document=new Element();document.document=document;document.body=new Element(document);document.documentElement={clientWidth:1000,clientHeight:800};document.createElement=()=>new Element(document);
 const root=new Element(document),window=new Element(document);Object.assign(window,{innerWidth:1000,innerHeight:800});
 const folders=['1','2','all','root'].map(folder=>new Element(document,{folder,contextName:'Folder '+folder},root)),base=new Element(document,{base:'9',contextName:'Base'},root);
 const actions=[],empty=new Set([1]);const menu=new LibraryMenu(root,{document,window,canDeleteFolder:id=>empty.has(id),onAction:(...args)=>actions.push(args),...options});
 return {document,root,window,folders,base,actions,empty,menu};
}
const event=(target,extra={})=>({target,prevented:false,preventDefault(){this.prevented=true;},stopPropagation(){},stopImmediatePropagation(){},...extra});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function modeEnvironment({reference=false,save=null}={}){
 const source={id:9,reference,settings:{guess_enabled:false,review_enabled:true,is_repertoire:false,reading_enabled:false}},calls=[],errors=[];
 const ui=environment({getBase:id=>id===9?source:null,onToggleMode:async(id,key,enabled)=>{calls.push([id,key,enabled]);if(save)await save(id,key,enabled);source.settings[key]=enabled;},onError:error=>errors.push(error)});
 const open=()=>{ui.root.emit('contextmenu',event(ui.base));return ui.menu.menu;};
 const item=key=>ui.menu.menu?.children.find(button=>button.dataset.libraryMenuAction===key);
 return {...ui,source,calls,errors,open,item};
}
const tests={
 async modes_save_without_navigation_and_allow_multiple_changes(){
  const ui=modeEnvironment(),menu=ui.open(),guess=ui.item('guess_enabled');
  assert.equal(guess.getAttribute('role'),'menuitemcheckbox');assert.equal(guess.getAttribute('aria-checked'),'false');assert.equal(ui.item('review_enabled').getAttribute('aria-checked'),'true');
  guess.focus();await guess.onclick();await settle();assert.equal(ui.menu.menu,menu);assert.equal(ui.document.activeElement,guess);assert.equal(guess.getAttribute('aria-checked'),'true');assert.equal(ui.source.settings.guess_enabled,true);assert.deepEqual(ui.calls,[[9,'guess_enabled',true]]);assert.deepEqual(ui.actions,[]);
  await ui.item('review_enabled').onclick();await settle();assert.equal(ui.menu.menu,menu);assert.equal(ui.item('review_enabled').getAttribute('aria-checked'),'false');assert.equal(ui.source.settings.review_enabled,false);
  await guess.onclick();await settle();assert.equal(guess.getAttribute('aria-checked'),'false');assert.deepEqual(ui.calls.at(-1),[9,'guess_enabled',false]);
  ui.item('settings').onclick();assert.equal(ui.menu.menu,null);assert.deepEqual(ui.actions,[['base',9,'settings']]);ui.menu.dispose();
 },
 async failed_save_keeps_state_and_ignores_duplicate_clicks(){
  let rejectSave;const failure=new Error('Save failed'),pending=new Promise((_,reject)=>rejectSave=reject);const ui=modeEnvironment({save:()=>pending}),menu=ui.open(),guess=ui.item('guess_enabled');
  const saved=guess.onclick();await guess.onclick();await ui.item('reading_enabled').onclick();assert.equal(ui.calls.length,1);assert.equal(guess.getAttribute('aria-checked'),'false');assert.equal(ui.source.settings.guess_enabled,false);
  rejectSave(failure);await saved;await settle();assert.equal(ui.menu.menu,menu);assert.equal(guess.getAttribute('aria-checked'),'false');assert.equal(ui.source.settings.guess_enabled,false);assert.deepEqual(ui.errors,[failure]);assert.deepEqual(ui.actions,[]);
  ui.menu.dispose();
 },
 reference_bases_only_offer_supported_modes(){
  const ui=modeEnvironment({reference:true});ui.open();assert.ok(ui.item('guess_enabled'));assert.ok(ui.item('settings'));for(const key of ['review_enabled','is_repertoire','reading_enabled'])assert.equal(ui.item(key),undefined);ui.menu.dispose();
 },
 keyboard_includes_mode_checkboxes_and_restores_card(){
  const ui=modeEnvironment();ui.root.emit('keydown',event(ui.base,{key:'F10',shiftKey:true}));const buttons=ui.menu.menu.children;
  assert.deepEqual(buttons.map(button=>button.dataset.libraryMenuAction),['guess_enabled','review_enabled','reading_enabled','settings']);assert.equal(buttons.length,4);assert.equal(ui.document.activeElement,buttons[0]);for(let index=1;index<buttons.length;index++){ui.document.emit('keydown',event(ui.document.activeElement,{key:'ArrowDown'}));assert.equal(ui.document.activeElement,buttons[index]);}
  ui.document.emit('keydown',event(ui.document.activeElement,{key:'Home'}));assert.equal(ui.document.activeElement,buttons[0]);ui.document.emit('keydown',event(ui.document.activeElement,{key:'End'}));assert.equal(ui.document.activeElement,buttons.at(-1));
  ui.document.emit('keydown',event(ui.document.activeElement,{key:'Escape'}));assert.equal(ui.menu.menu,null);assert.equal(ui.document.activeElement,ui.base);assert.equal(ui.calls.length,0);ui.menu.dispose();
 },
 delete_only_for_current_empty_folder_and_keep_original_actions(){
  const ui=environment();ui.root.emit('contextmenu',event(ui.folders[0]));assert.deepEqual(ui.menu.menu.children.map(item=>item.dataset.libraryMenuAction),['rename','delete']);
  ui.menu.menu.children[1].onclick();assert.deepEqual(ui.actions,[['folder',1,'delete']]);assert.equal(ui.menu.menu,null);assert.equal(ui.document.activeElement,ui.folders[0]);
  ui.empty.clear();ui.root.emit('contextmenu',event(ui.folders[0]));assert.equal(ui.menu.menu.children.length,1);ui.menu.menu.children[0].onclick();assert.deepEqual(ui.actions[1],['folder',1,'rename']);
  ui.root.emit('contextmenu',event(ui.base));assert.equal(ui.menu.menu.children.length,1);ui.menu.menu.children[0].onclick();assert.deepEqual(ui.actions[2],['base',9,'settings']);
  for(const folder of ui.folders.slice(2)){const e=event(folder);ui.root.emit('contextmenu',e);assert.equal(e.prevented,false);assert.equal(ui.menu.menu,null);}
  ui.menu.dispose();
 },
 keyboard_moves_between_menu_actions_and_escape_restores_folder(){
  const ui=environment();ui.root.emit('keydown',event(ui.folders[0],{key:'F10',shiftKey:true}));const [rename,remove]=ui.menu.menu.children;
  assert.equal(ui.document.activeElement,rename);ui.document.emit('keydown',event(rename,{key:'ArrowDown'}));assert.equal(ui.document.activeElement,remove);
  ui.document.emit('keydown',event(remove,{key:'ArrowDown'}));assert.equal(ui.document.activeElement,rename);
  ui.document.emit('keydown',event(rename,{key:'End'}));assert.equal(ui.document.activeElement,remove);
  ui.document.emit('keydown',event(remove,{key:'Home'}));assert.equal(ui.document.activeElement,rename);
  ui.document.emit('keydown',event(rename,{key:'ArrowUp'}));assert.equal(ui.document.activeElement,remove);
  ui.document.emit('keydown',event(remove,{key:'Escape'}));assert.equal(ui.menu.menu,null);assert.equal(ui.document.activeElement,ui.folders[0]);assert.equal(ui.actions.length,0);
  ui.menu.dispose();assert.equal([...ui.root.listeners.values()].flat().length,0);
 },
 native_context_menu_and_other_library_targets_remain_untouched(){
  const ui=environment();const shift=event(ui.folders[0],{shiftKey:true});ui.root.emit('contextmenu',shift);assert.equal(shift.prevented,false);assert.equal(ui.menu.menu,undefined);
  const outside=new Element(ui.document,{folder:'1'});const e=event(outside);ui.root.emit('contextmenu',e);assert.equal(e.prevented,false);assert.equal(ui.actions.length,0);ui.menu.dispose();
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario]);await tests[scenario]();console.log('ok '+scenario);
