import assert from 'node:assert/strict';
import {MoveMenu,moveActions,AnalysisHistory} from '../static/move-menu.js';
const tree={headers:{White:'Auteur',Result:'*'},nodes:[
 {path:'',parent:null,children:['0','1'],fen:'root'},
 {path:'0',parent:'',children:['0.0','0.1'],san:'e4',uci:'e2e4',fen:'e4'},
 {path:'0.0',parent:'0',children:['0.0.0'],san:'e5',uci:'e7e5',fen:'e5'},
 {path:'0.0.0',parent:'0.0',children:[],san:'Nf3',uci:'g1f3',fen:'nf3'},
 {path:'0.1',parent:'0',children:['0.1.0'],san:'c5',uci:'c7c5',fen:'c5'},
 {path:'0.1.0',parent:'0.1',children:[],san:'Nf3',uci:'g1f3',fen:'nf3c5',comment:'Plan [%clk 0:05:00]',nags:[5],clock:300},
 {path:'1',parent:'',children:['1.0'],san:'d4',uci:'d2d4',fen:'d4'},
 {path:'1.0',parent:'1',children:[],san:'d5',uci:'d7d5',fen:'d5'}
]};
class Classes{constructor(){this.items=new Set();}add(x){this.items.add(x);}remove(x){this.items.delete(x);}contains(x){return this.items.has(x);}}
class Element{
 constructor(doc,dataset={}){this.ownerDocument=doc;this.dataset=dataset;this.listeners=[];this.classList=new Classes();this.style={};this.children=[];this.attributes={};this.isConnected=true;this.disabled=false;}
 addEventListener(type,fn,capture){this.listeners.push({type,fn,capture});}
 removeEventListener(type,fn,capture){this.listeners=this.listeners.filter(x=>x.type!==type||x.fn!==fn||x.capture!==capture);}
 emit(type,event={}){const e={target:this,key:'',preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...event};for(const listener of this.listeners.filter(x=>x.type===type)){listener.fn(e);if(e.stopped)break;}return e;}
 setAttribute(k,v){this.attributes[k]=v;}
 append(node){this.children.push(node);node.parent=this;}
 contains(node){return node===this||this.children.some(c=>c.contains(node));}
 closest(selector){if(selector==='.move[data-path]'&&this.dataset.path!==undefined&&this.classList.contains('move'))return this;return null;}
 set innerHTML(html){this.html=html;this.children=[];for(const match of html.matchAll(new RegExp('<button([^>]*)>(.*?)</button>','g'))){const node=new Element(this.ownerDocument,{treeAction:match[1].match(/data-tree-action="([^"]*)"/)?.[1]});node.disabled=/ disabled/.test(match[1]);node.textContent=match[2];this.append(node);}}
 get innerHTML(){return this.html||'';}
 querySelectorAll(selector){return ['[role=menuitem]','[data-tree-action]'].includes(selector)?this.children:[];}
 getBoundingClientRect(){return {left:60,bottom:70,width:255,height:280};}
 focus(){this.ownerDocument.activeElement=this;}
 remove(){this.isConnected=false;if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
}
function environment(){const doc=new Element();doc.ownerDocument=doc;doc.createElement=()=>new Element(doc);doc.body=new Element(doc);doc.documentElement={clientWidth:800,clientHeight:600};const win=new Element(doc);win.innerWidth=800;win.innerHeight=600;const root=new Element(doc),token=new Element(doc,{path:'0.1.0'});token.classList.add('move');root.append(token);const pv=new Element(doc,{pvLine:'0',pvIndex:'0'});root.append(pv);const calls=[];const controller=new MoveMenu(root,{getDoc:()=>tree,onAction:(...args)=>calls.push(args),document:doc,window:win});return {doc,win,root,token,pv,calls,controller};}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const tests={
 reading_bookmark_context_action_targets_only_eligible_mainline_move(){
  const e=environment(),before=structuredClone(tree);e.controller.canBookmark=path=>path==='0.0';
  e.root.emit('contextmenu',{target:e.token});assert.equal(e.controller.menu.children.some(n=>n.dataset.treeAction==='bookmark'),false);
  e.token.dataset.path='0.0';e.root.emit('contextmenu',{target:e.token});
  const button=e.controller.menu.children.find(n=>n.dataset.treeAction==='bookmark');assert.ok(button);assert.equal(button.disabled,false);
  button.onclick();assert.deepEqual(e.calls,[['bookmark','0.0']]);assert.equal(e.controller.menu,null);assert.deepEqual(tree,before);
  e.controller.canBookmark=()=>false;e.root.emit('contextmenu',{target:e.token});assert.equal(e.controller.menu.children.some(n=>n.dataset.treeAction==='bookmark'),false);e.controller.dispose();
 },
 actions_target_enclosing_branch(){
  let state=moveActions(tree,'0.1.0');assert.equal(state.branch.path,'0.1');assert.equal(state.up,true);assert.equal(state.down,false);assert.equal(state.promote,true);assert.equal(state.main,true);assert.equal(state.delete,true);
  state=moveActions(tree,'0.0.0');assert.equal(state.branch.path,'0.0');assert.equal(state.promote,false);assert.equal(state.down,true);assert.equal(state.main,false);
  state=moveActions(tree,'1.0');assert.equal(state.branch.path,'1');assert.equal(state.promote,true);
  assert.equal(moveActions(tree,'').delete,false);assert.equal(moveActions(tree,'bad').main,false);
  const linear={nodes:tree.nodes.slice(0,2).map(n=>({...n,children:n.path===''?['0']:[]}))};assert.equal(moveActions(linear,'0').up,false);assert.equal(moveActions(linear,'0').annotate,true);
 },
 context_targets_clicked_move_only(){
  const e=environment();assert.equal(e.root.emit('contextmenu',{target:e.pv}).prevented,undefined);assert.equal(e.controller.menu,undefined);
  const event=e.root.emit('contextmenu',{target:e.token,clientX:790,clientY:590});assert.equal(event.prevented,true);assert.equal(e.controller.selectedPath,'0.1.0');assert.equal(e.controller.menu.attributes.role,'menu');assert.equal(e.controller.menu.style.left,'537px');assert.equal(e.controller.menu.style.top,'312px');
  const deleteButton=e.controller.menu.children.find(x=>x.dataset.treeAction==='delete');deleteButton.onclick();assert.deepEqual(e.calls,[['delete','0.1.0']]);assert.equal(e.controller.menu,null);assert.equal(e.token.attributes['aria-expanded'],'false');
  e.root.emit('contextmenu',{target:e.token,shiftKey:true});assert.equal(e.controller.menu,null);e.controller.dispose();
 },
 keyboard_and_accessible_button(){
  const e=environment(),event=e.root.emit('keydown',{target:e.token,key:'F10',shiftKey:true});assert.equal(event.prevented,true);assert.equal(e.doc.activeElement.dataset.treeAction,'up');assert.equal(e.controller.menu.children.find(x=>x.dataset.treeAction==='down').disabled,true);
  e.doc.emit('keydown',{key:'ArrowDown'});assert.equal(e.doc.activeElement.dataset.treeAction,'promote');e.doc.emit('keydown',{key:'End'});assert.equal(e.doc.activeElement.dataset.treeAction,'delete');e.doc.emit('keydown',{key:'ArrowDown'});assert.equal(e.doc.activeElement.dataset.treeAction,'up');
  e.doc.emit('keydown',{key:'Escape'});assert.equal(e.controller.menu,null);assert.equal(e.doc.activeElement,e.token);
  const more=new Element(e.doc);e.controller.open('0.1.0',more);assert.equal(more.attributes['aria-expanded'],'true');e.doc.emit('keydown',{key:'Tab'});assert.equal(e.controller.menu,null);e.controller.dispose();
 },
 async touch_long_press_and_scroll_cancel(){
  const e=environment();e.root.emit('pointerdown',{target:e.token,pointerType:'touch',pointerId:1,clientX:30,clientY:40});await pause(570);assert.ok(e.controller.menu);const click=e.root.emit('click',{target:e.token});assert.equal(click.prevented,true);assert.equal(click.stopped,true);e.controller.close();
  e.root.emit('pointerdown',{target:e.token,pointerType:'touch',pointerId:1,clientX:30,clientY:40});e.win.emit('pointermove',{pointerId:1,clientX:30,clientY:60});await pause(570);assert.equal(e.controller.menu,null);
  e.root.emit('pointerdown',{target:e.token,pointerType:'touch',pointerId:1,clientX:30,clientY:40});e.win.emit('scroll');assert.equal(e.controller.press,null);e.controller.dispose();
 },
 dismissal_and_disposal(){
  const e=environment();e.controller.open('0.1.0',e.token);e.doc.emit('pointerdown',{target:e.controller.menu.children[0]});assert.ok(e.controller.menu);e.doc.emit('pointerdown',{target:e.doc.body});assert.equal(e.controller.menu,null);
  e.controller.open('0.1.0',e.token);e.win.emit('scroll',{target:e.controller.menu});assert.ok(e.controller.menu);e.win.emit('scroll',{target:e.root});assert.equal(e.controller.menu,null);
  e.controller.open('0.1.0',e.token);e.controller.dispose();assert.equal(e.doc.body.children.length,0);assert.equal(e.token.classList.contains('menu-target'),false);assert.equal(e.root.listeners.length,0);assert.equal(e.win.listeners.length,0);assert.equal(e.doc.listeners.length,0);
 },
 history_restores_tree_annotations_and_cursor(){
  const history=new AnalysisHistory(),doc=structuredClone(tree);history.reset(doc,'0');history.record(doc,'0.1.0');assert.deepEqual(history.flags(),{can_undo:false,can_redo:false});
  doc.nodes.find(n=>n.path==='0.1.0').comment='Nouvelle idée';doc.nodes.find(n=>n.path==='0.1.0').nags=[1];history.record(doc,'0.1.0');const restored=history.take('undo');assert.equal(restored.path,'0.1.0');assert.equal(restored.doc.nodes.find(n=>n.path==='0.1.0').comment,'Plan [%clk 0:05:00]');assert.equal(restored.doc.nodes.length,tree.nodes.length);assert.equal(restored.doc.nodes.find(n=>n.path==='0.1.0').clock,300);
  restored.doc.headers.White='Mutation extérieure';assert.equal(history.current.doc.headers.White,'Auteur');const redo=history.take('redo');assert.equal(redo.doc.nodes.find(n=>n.path==='0.1.0').comment,'Nouvelle idée');assert.deepEqual(history.flags(),{can_undo:true,can_redo:false});
 },
 history_branching_limits_and_metadata(){
  const history=new AnalysisHistory(2),doc=structuredClone(tree);history.reset(doc);doc.headers.White='Premier';history.record(doc,'0');doc.headers.White='Second';history.record(doc,'0.0');doc.headers.White='Troisième';history.record(doc,'0.0.0');assert.equal(history.past.length,2);
  const restored=history.take('undo');assert.equal(restored.doc.headers.White,'Second');restored.doc.title='Nouveau titre';history.record(restored.doc,restored.path);assert.equal(history.flags().can_redo,false);assert.equal(history.take('redo'),null);
  history.record({...doc,id:5,revision:'saved-revision',analysis_dirty:true},'0');assert.equal(history.current.doc.id,5);assert.equal(history.current.doc.revision,'saved-revision');assert.equal(history.flags().can_undo,true);assert.equal(history.take('undo').doc.title,'Nouveau titre');history.reset(tree);assert.deepEqual(history.flags(),{can_undo:false,can_redo:false});
 }
};
const selected=process.argv[2];assert.ok(tests[selected],'unknown test '+selected);await tests[selected]();console.log(selected+' passed');
