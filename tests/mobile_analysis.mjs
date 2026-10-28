import assert from 'node:assert/strict';
import {mountMobileAnalysis} from '../static/mobile-analysis.js';

class CommandNode{
 constructor(name){this.name=name;this.children=[];this.parentElement=null;this.listeners=new Map();}
 get nextSibling(){const children=this.parentElement?.children||[];return children[children.indexOf(this)+1]||null;}
 append(node){node.remove();this.children.push(node);node.parentElement=this;}
 prepend(node){node.remove();this.children.unshift(node);node.parentElement=this;}
 insertBefore(node,anchor){if(!anchor){this.append(node);return;}assert.equal(anchor.parentElement,this);node.remove();this.children.splice(this.children.indexOf(anchor),0,node);node.parentElement=this;}
 remove(){if(this.parentElement){const children=this.parentElement.children;children.splice(children.indexOf(this),1);this.parentElement=null;}}
 querySelector(selector){const name={'.analysis-reading-controls':'reading','.analysis-more-actions':'menu'}[selector];return this.find(name);}
 find(name){if(this.name===name)return this;for(const child of this.children){const result=child.find(name);if(result)return result;}return null;}
 cloneNode(){throw Error('Live commands must be moved without cloning');}
 addEventListener(type,handler){this.listeners.set(type,handler);}
 click(){this.listeners.get('click')?.();}
}
function commandFixture(){
 const nodes=Object.fromEntries(['home','title','actions','reading','save','more','menu','reset','dock'].map(name=>[name,new CommandNode(name)]));
 const {home,title,actions,reading,save,more,menu,reset}=nodes;
 home.append(title);home.append(actions);actions.append(reading);actions.append(save);actions.append(more);more.append(menu);menu.append(reset);
 reading.draft={font:'16',expanded:true};more.open=true;save.disabled=true;nodes.saves=0;save.addEventListener('click',()=>nodes.saves++);
 return nodes;
}
function fixture({initial='moves',mobile=true,commands=null}={}){
 const listeners=new Map(),mediaListeners=new Set(),selected=[],visible=[],focused=[],writes=[];
 const nodes=new Map(['moves','explorer','bilan','repertoire','charts'].map(id=>[id,{id,draft:{value:'draft-'+id},engine:{running:true}}]));
 const items=[...nodes.keys()].map(id=>({dataset:{mobilePanel:id},attributes:new Map(),tabIndex:99,
  setAttribute(name,value){this.attributes.set(name,value);},focus(options){focused.push([id,options]);},closest(selector){return selector==='[data-mobile-panel]'?this:null;}}));
 const tabs={querySelectorAll(selector){assert.equal(selector,'[data-mobile-panel]');return items;},contains(node){return items.includes(node);},
  addEventListener(type,handler){listeners.set(type,handler);},removeEventListener(type,handler){if(listeners.has(type))assert.equal(listeners.get(type),handler);listeners.delete(type);}};
 const workbench={dataset:{},querySelector(selector){return selector==='.analysis-mobile-tabs'?tabs:null;},
  set innerHTML(value){writes.push(value);throw Error('The panel controller must preserve existing DOM nodes');},replaceChildren(){throw Error('Panel recreation would discard drafts');}};
 const media={matches:mobile,addEventListener(type,fn){assert.equal(type,'change');mediaListeners.add(fn);},removeEventListener(type,fn){assert.equal(type,'change');mediaListeners.delete(fn);}};
 let query;
 globalThis.window={matchMedia(value){query=value;return media;}};
 const control=mountMobileAnalysis(workbench,{initial,commands,onSelect:id=>selected.push(id),onVisibilityChange:()=>visible.push(workbench.dataset.mobilePanel)});
 const emit=(type,event)=>listeners.get(type)?.(event);
 const key=(id,key,modifiers={})=>{const event={target:items.find(item=>item.dataset.mobilePanel===id),key,...modifiers,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}};emit('keydown',event);return event;};
 const change=matches=>{media.matches=matches;for(const handler of mediaListeners)handler();};
 return {control,workbench,nodes,items,tabs,media,query,listeners,mediaListeners,selected,visible,focused,writes,emit,key,change};
}
const tests={
 mobile_commands_move_existing_controls_and_put_reading_in_more_menu(){
  const c=commandFixture(),draft=c.reading.draft,saveHandler=c.save.listeners.get('click');
  const f=fixture({commands:c});
  assert.deepEqual(c.home.children,[c.title]);assert.deepEqual(c.dock.children,[c.actions]);
  assert.deepEqual(c.actions.children,[c.save,c.more]);assert.deepEqual(c.menu.children,[c.reading,c.reset]);
  assert.equal(c.reading.draft,draft);assert.equal(c.more.open,true);assert.equal(c.save.disabled,true);assert.equal(c.save.listeners.get('click'),saveHandler);
  c.save.click();assert.equal(c.saves,1,'Moving a control retains its existing listener exactly once');
  f.control.select('explorer');f.change(true);f.change(true);
  assert.deepEqual(c.dock.children,[c.actions]);assert.deepEqual(c.menu.children,[c.reading,c.reset]);
  c.save.click();assert.equal(c.saves,2,'Repeated media events never duplicate commands or handlers');
 },
 desktop_mobile_roundtrip_restores_original_command_order_and_draft(){
  const c=commandFixture(),f=fixture({mobile:false,commands:c}),order=[...c.actions.children],draft=c.reading.draft;
  assert.deepEqual(c.home.children,[c.title,c.actions]);assert.deepEqual(c.dock.children,[]);assert.deepEqual(c.menu.children,[c.reset]);
  for(let i=0;i<3;i++){
   f.change(true);c.reading.draft.font=String(17+i);c.save.disabled=false;c.save.click();f.change(false);
   assert.deepEqual(c.home.children,[c.title,c.actions]);assert.deepEqual(c.actions.children,order);assert.deepEqual(c.menu.children,[c.reset]);assert.deepEqual(c.dock.children,[]);
   assert.equal(c.reading.draft,draft);assert.equal(c.reading.draft.font,String(17+i));assert.equal(c.save.disabled,false);
  }
  assert.equal(c.saves,3);f.control.disconnect();assert.deepEqual(c.actions.children,order);
 },
 disconnect_restores_commands_and_stale_breakpoint_callback_cannot_move_them(){
  const c=commandFixture(),order=[...c.actions.children],f=fixture({commands:c}),late=[...f.mediaListeners][0];
  assert.equal(c.actions.parentElement,c.dock);f.control.disconnect();assert.equal(c.actions.parentElement,c.home);assert.deepEqual(c.actions.children,order);
  late();f.change(true);f.control.select('charts');assert.equal(c.actions.parentElement,c.home);assert.deepEqual(c.dock.children,[]);assert.deepEqual(c.menu.children,[c.reset]);
  f.control.disconnect();c.save.click();assert.equal(c.saves,1);
 },
 absent_command_hosts_leave_tab_controller_usable(){
  for(const commands of [{},{actions:new CommandNode('actions')},{dock:new CommandNode('dock')}]){
   const f=fixture({commands});f.control.select('charts');f.change(false);f.change(true);assert.equal(f.control.panel,'charts');f.control.disconnect();
  }
 },
 initial_panel_has_accessible_selection_without_reentrant_selection_callback(){
  const f=fixture({initial:'explorer'});
  assert.equal(f.control.panel,'explorer');assert.equal(f.workbench.dataset.mobilePanel,'explorer');assert.equal(f.control.active,true);
  assert.deepEqual(f.selected,[],'Mount cannot call a callback that relies on the returned controller before assignment');
  assert.deepEqual(f.visible,['explorer']);
  for(const item of f.items){const active=item.dataset.mobilePanel==='explorer';assert.equal(item.attributes.get('aria-selected'),String(active));assert.equal(item.tabIndex,active?0:-1);}
  const fallback=fixture({initial:'missing'});assert.equal(fallback.control.panel,'moves');assert.deepEqual(fallback.selected,[]);
 },
 switching_panels_preserves_existing_drafts_and_engine_instances(){
  const f=fixture(),nodes=[...f.nodes.values()],drafts=nodes.map(node=>node.draft),engines=nodes.map(node=>node.engine);
  for(const id of ['explorer','charts','repertoire','bilan','moves'])f.control.select(id);
  assert.deepEqual(f.selected,['explorer','charts','repertoire','bilan','moves']);assert.equal(f.visible.length,6);
  assert.deepEqual([...f.nodes.values()],nodes);nodes.forEach((node,i)=>{assert.equal(node.draft,drafts[i]);assert.equal(node.engine,engines[i]);assert.equal(node.engine.running,true);});assert.deepEqual(f.writes,[]);
  const before=f.visible.length;f.control.select('unknown');assert.equal(f.visible.length,before);assert.equal(f.control.panel,'moves');
 },
 delegated_clicks_select_only_tabs_inside_the_controller(){
  const f=fixture(),target=f.items.find(item=>item.dataset.mobilePanel==='charts');
  f.emit('click',{target:{closest:()=>target}});assert.equal(f.control.panel,'charts');assert.deepEqual(f.selected,['charts']);
  f.emit('click',{target:{closest:()=>({dataset:{mobilePanel:'moves'}})}});f.emit('click',{target:{}});
  assert.equal(f.control.panel,'charts');assert.equal(f.selected.length,1);
 },
 keyboard_selection_wraps_focus_and_consumes_board_navigation_keys(){
  const f=fixture();
  for(const [from,key,to] of [['moves','ArrowLeft','charts'],['charts','ArrowRight','moves'],['moves','End','charts'],['charts','Home','moves'],['moves','ArrowRight','explorer']]){
   const event=f.key(from,key);assert.equal(event.prevented,true);assert.equal(event.stopped,true);assert.equal(f.control.panel,to);
   assert.deepEqual(f.focused.at(-1),[to,{preventScroll:true}]);assert.equal(f.items.find(item=>item.dataset.mobilePanel===to).tabIndex,0);
  }
 },
 unrelated_keys_and_modified_shortcuts_are_not_intercepted(){
  const f=fixture();
  for(const [key,modifiers] of [['ArrowUp',{}],['ArrowDown',{}],['Enter',{}],['ArrowRight',{altKey:true}],['ArrowRight',{ctrlKey:true}],['ArrowRight',{metaKey:true}],['ArrowRight',{shiftKey:true}]]){
   const event=f.key('moves',key,modifiers);assert.equal(event.prevented,false);assert.equal(event.stopped,false);
  }
  const outside=f.key('unknown','ArrowRight');assert.equal(outside.prevented,false);assert.equal(outside.stopped,false);assert.deepEqual(f.selected,[]);
 },
 breakpoint_changes_sync_mobile_tool_visibility_without_losing_selection(){
  const f=fixture({initial:'explorer',mobile:false});
  assert.match(f.query,/max-width:\s*850px/);assert.match(f.query,/max-width:\s*1000px/);assert.match(f.query,/max-height:\s*500px/);
  assert.equal(f.control.active,false);f.change(true);assert.equal(f.control.active,true);assert.deepEqual(f.selected,['explorer']);
  f.control.select('charts');f.change(false);assert.equal(f.control.active,false);assert.equal(f.control.panel,'charts');
  assert.deepEqual(f.selected,['explorer','charts'],'Returning to desktop updates layout without forcing a hidden mobile tool');
  f.change(true);assert.deepEqual(f.selected,['explorer','charts','charts']);assert.deepEqual(f.visible,['explorer','explorer','charts','charts','charts']);
 },
 disconnect_detaches_handlers_and_ignores_queued_events(){
  const f=fixture(),click=f.listeners.get('click'),key=f.listeners.get('keydown'),change=[...f.mediaListeners][0];
  f.control.disconnect();assert.equal(f.listeners.size,0);assert.equal(f.mediaListeners.size,0);
  const before=f.visible.length;f.control.select('explorer');click({target:f.items[1]});change();
  key({target:f.items[0],key:'ArrowRight',preventDefault(){},stopPropagation(){}});
  assert.equal(f.control.panel,'moves');assert.deepEqual(f.selected,[]);assert.equal(f.visible.length,before);assert.deepEqual(f.focused,[]);
 },
 missing_workspace_or_tabs_is_a_safe_noop(){
  delete globalThis.window;assert.equal(mountMobileAnalysis(null),null);assert.equal(mountMobileAnalysis({querySelector:()=>null}),null);
 },
};
const name=process.argv[2];assert.ok(tests[name],name);await tests[name]();console.log(name+' passed');
