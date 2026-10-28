import assert from 'node:assert/strict';
import {LibraryDrag,movePayload} from '../static/library-drag.js';
class Element{
 constructor(dataset={},parent=null){this.dataset=dataset;this.parent=parent;this.children=[];parent?.children.push(this);this.attrs=new Map();this.events=new Map();this.style={};this.rect={left:0,top:0,width:200,height:180};const classes=new Set();this.classList={add(...names){names.forEach(n=>classes.add(n));},remove(...names){names.forEach(n=>classes.delete(n));},contains:n=>classes.has(n)};}
 addEventListener(type,fn,capture=false){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push({fn,capture});}removeEventListener(type,fn){this.events.set(type,(this.events.get(type)||[]).filter(item=>item.fn!==fn));}
 emit(type,event){for(const {fn} of this.events.get(type)||[])fn(event);}
 matches(selector){const key={'[data-library-base]':'libraryBase','[data-library-drag]':'libraryDrag','[data-folder]':'folder','[data-base]':'base'}[selector];return key&&this.dataset[key]!==undefined;}
 closest(selector){for(let node=this;node;node=node.parent)if(node.matches(selector))return node;return null;}
 contains(node){for(let n=node;n;n=n.parent)if(n===this)return true;return false;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 getBoundingClientRect(){return this.rect;}setAttribute(key,value){this.attrs.set(key,String(value));}getAttribute(key){return this.attrs.get(key);}removeAttribute(key){this.attrs.delete(key);}append(child){this.children.push(child);child.parent=this;}remove(){this.parent.children=this.parent.children.filter(child=>child!==this);}setPointerCapture(id){this.captured=id;}releasePointerCapture(){this.captured=null;}
}
function setup(options={}){
 const root=new Element(),win=new Element(),body=new Element(),cards=[1,2,3].map((id,i)=>{const card=new Element({libraryBase:String(id)},root);card.rect.left=i*220;card.base=new Element({base:String(id),contextName:'Base '+id},card);card.handle=new Element({libraryDrag:String(id)},card);return card;});
 const folders=['all','root','5'].map(id=>new Element({folder:id},root));let hit=null;const document={body,createElement:()=>new Element(),elementFromPoint:()=>hit},moves=[],dialogs=[],errors=[];
 const drag=new LibraryDrag(root,{onMove:async payload=>{moves.push(payload);await options.save?.(payload);},onChooseFolder:id=>dialogs.push(id),onError:error=>errors.push(error.message),document,window:win});
 return {root,win,body,cards,folders,moves,dialogs,errors,drag,hit:element=>{hit=element;}};
}
function event(target,extra={}){return {target,clientX:0,clientY:0,pointerId:7,button:0,pointerType:'mouse',prevented:0,stopped:0,immediate:0,preventDefault(){this.prevented++;},stopPropagation(){this.stopped++;},stopImmediatePropagation(){this.immediate++;},...extra};}
function start(ui,id=0){const data=new Map(),e=event(ui.cards[id].base,{dataTransfer:{setData:(k,v)=>data.set(k,v)}});ui.root.emit('dragstart',e);return {data,event:e};}
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
const tests={
 async native_pointercancel_does_not_cancel_browser_drag_and_pointer_cancel_is_scoped(){
  const ui=setup();ui.root.emit('pointerdown',event(ui.cards[0].base));assert.equal(ui.cards[0].draggable,true);start(ui);ui.win.emit('pointercancel',event(ui.cards[0].base));assert.equal(ui.drag.active.id,1);
  const over=event(ui.folders[2]);ui.root.emit('dragover',over);assert.equal(over.prevented,1);ui.root.emit('drop',over);await settle();assert.deepEqual(ui.moves,[{base_id:1,folder_id:5}]);
  ui.root.emit('pointerdown',event(ui.cards[0].handle,{pointerType:'touch'}));ui.hit(ui.folders[2]);ui.win.emit('pointermove',event(ui.cards[0].handle,{pointerType:'touch',clientX:30}));ui.win.emit('pointercancel',event(ui.cards[0].handle,{pointerId:9}));assert.equal(ui.drag.active.id,1);ui.win.emit('pointercancel',event(ui.cards[0].handle));assert.equal(ui.drag.active,null);assert.equal(ui.moves.length,1);
 },
 async native_folder_drop_commits_only_valid_payload_and_waits_for_server(){
  let resolve;const ui=setup({save:()=>new Promise(r=>resolve=r)});const begun=start(ui);assert.equal(begun.data.get('application/x-chessgym-base'),'1');assert.equal(begun.event.dataTransfer.effectAllowed,'move');
  const over=event(ui.folders[2]);ui.root.emit('dragover',over);assert.equal(over.prevented,1);assert.equal(ui.folders[2].classList.contains('library-drop-folder'),true);
  ui.root.emit('drop',event(ui.folders[2]));assert.deepEqual(ui.moves,[{base_id:1,folder_id:5}]);assert.equal(ui.drag.busy,true);assert.equal(ui.root.getAttribute('aria-busy'),'true');assert.equal(ui.cards[0].classList.contains('library-drag-source'),false);
  assert.equal(ui.folders[2].classList.contains('library-drop-folder'),false);ui.root.emit('dragstart',event(ui.cards[1].base));assert.equal(ui.drag.active,null);resolve();await settle();assert.equal(ui.drag.busy,false);assert.equal(ui.root.getAttribute('aria-busy'),undefined);
 },
 async reorder_uses_horizontal_or_vertical_insertion_and_keeps_folder_implicit(){
  const ui=setup();start(ui);ui.root.emit('drop',event(ui.cards[2],{clientX:450,clientY:80}));await settle();assert.deepEqual(ui.moves[0],{base_id:1,before_id:3});
  start(ui);ui.root.emit('drop',event(ui.cards[2],{clientX:630,clientY:80}));await settle();assert.deepEqual(ui.moves[1],{base_id:1,after_id:3});
  ui.cards.forEach((card,i)=>{card.rect={left:0,top:i*200,width:200,height:180};});start(ui);const over=event(ui.cards[1],{clientX:10,clientY:370});ui.root.emit('dragover',over);assert.equal(ui.cards[1].classList.contains('library-drop-vertical'),true);ui.root.emit('drop',over);await settle();assert.deepEqual(ui.moves[2],{base_id:1,after_id:2});
 },
 async foreign_drops_all_bases_and_self_are_never_mutations(){
  const ui=setup();ui.root.emit('drop',event(ui.folders[2]));assert.equal(ui.moves.length,0);start(ui);const all=event(ui.folders[0]);ui.root.emit('dragover',all);assert.equal(all.prevented,0);ui.root.emit('drop',all);start(ui);ui.root.emit('drop',event(ui.cards[0]));assert.equal(ui.moves.length,0);
  start(ui);ui.root.emit('drop',event(ui.folders[1]));await settle();assert.deepEqual(ui.moves,[{base_id:1,folder_id:null}]);assert.equal(movePayload(0,{kind:'folder',id:5}),null);
 },
 async pointer_handle_supports_touch_without_stealing_card_long_press(){
  const ui=setup();const normal=event(ui.cards[0].base,{pointerType:'touch'});ui.root.emit('pointerdown',normal);assert.equal(normal.prevented,0);assert.equal(ui.cards[0].draggable,false);assert.equal(ui.drag.press,undefined);
  ui.root.emit('pointerdown',event(ui.cards[0].handle,{pointerType:'touch'}));ui.hit(ui.folders[2]);ui.win.emit('pointermove',event(ui.cards[0].handle,{pointerType:'touch',clientX:50,clientY:20}));assert.equal(ui.body.children.length,1);assert.equal(ui.folders[2].classList.contains('library-drop-folder'),true);
  ui.win.emit('pointerup',event(ui.cards[0].handle,{pointerType:'touch',clientX:50,clientY:20}));await settle();assert.deepEqual(ui.moves,[{base_id:1,folder_id:5}]);assert.equal(ui.body.children.length,0);assert.equal(ui.dialogs.length,0);
  const click=event(ui.cards[0].base);ui.root.emit('click',click);assert.equal(click.immediate,1,'The end of the drag cannot open the game base');
 },
 async handle_tap_and_keyboard_offer_folder_choice_and_order_controls(){
  const ui=setup();ui.root.emit('pointerdown',event(ui.cards[1].handle,{pointerType:'touch'}));ui.win.emit('pointerup',event(ui.cards[1].handle,{pointerType:'touch'}));assert.deepEqual(ui.dialogs,[2]);ui.drag.suppressUntil=0;
  ui.root.emit('click',event(ui.cards[2].handle,{detail:0}));assert.deepEqual(ui.dialogs,[2,3]);ui.root.emit('keydown',event(ui.cards[1].handle,{key:'ArrowUp',altKey:true}));await settle();assert.deepEqual(ui.moves,[{base_id:2,before_id:1}]);
  ui.root.emit('keydown',event(ui.cards[1].handle,{key:'ArrowDown',altKey:true}));await settle();assert.deepEqual(ui.moves[1],{base_id:2,after_id:3});
 },
 async rejected_save_keeps_cards_in_original_order_and_restores_controls(){
  const ui=setup({save:()=>{throw Error('Dossier indisponible');}});start(ui);ui.root.emit('drop',event(ui.folders[2]));await settle();assert.deepEqual(ui.errors,['Dossier indisponible']);assert.equal(ui.drag.busy,false);assert.deepEqual(ui.drag.cards().map(card=>card.dataset.libraryBase),['1','2','3']);assert.equal(ui.root.classList.contains('library-drag-busy'),false);
 },
 async escape_dispose_and_outside_release_cancel_without_saving(){
  const ui=setup();ui.root.emit('pointerdown',event(ui.cards[0].handle));ui.hit(ui.folders[2]);ui.win.emit('pointermove',event(ui.cards[0].handle,{clientX:30}));ui.root.emit('keydown',event(ui.cards[0].handle,{key:'Escape'}));assert.equal(ui.body.children.length,0);assert.equal(ui.drag.active,null);assert.equal(ui.cards[0].handle.captured,null);
  ui.root.emit('pointerdown',event(ui.cards[0].handle));ui.hit(null);ui.win.emit('pointermove',event(ui.cards[0].handle,{clientX:30}));ui.win.emit('pointerup',event(ui.cards[0].handle,{clientX:30}));assert.equal(ui.moves.length,0);
  start(ui);ui.drag.dispose();assert.equal(ui.cards[0].classList.contains('library-drag-source'),false);assert.equal([...ui.root.events.values()].flat().length,0);assert.equal([...ui.win.events.values()].flat().length,0);await ui.drag.commit({base_id:1,folder_id:5});assert.equal(ui.moves.length,0);
 }
};
const scenario=process.argv[2];if(!tests[scenario])throw new Error('Unknown scenario '+scenario);await tests[scenario]();console.log('ok '+scenario);
