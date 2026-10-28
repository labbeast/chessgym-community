import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';

// Keep the real PGN/branch/history operations, replacing only browser rendering
// and Stockfish transport. Requests below behave as a separately validated server.
registerHooks({load(url,context,nextLoad){
 if(url.endsWith('/static/board.js')){
  const source=readFileSync(new URL(url),'utf8').replace('export class Board {','class BrowserBoard {');
  return {format:'module',shortCircuit:true,source:source+`
export class Board extends BrowserBoard {
 constructor(...args){super(...args);globalThis.boards.push(this);}
 render(){} renderBoard(){} renderEngine(){}
 async refreshLegal(){this.legal=globalThis.legalAt(this.node().fen);}
 async analyse(){this.engineRequests=(this.engineRequests||0)+1;}
}`};
 }
 if(url.endsWith('/static/appearance.js'))return {format:'module',shortCircuit:true,source:'export function pieceUrl(){return "";}'};
 if(url.endsWith('/static/engine-analysis.js'))return {format:'module',shortCircuit:true,source:'export function analysisEngineName(){return "Stockfish";}export function refreshAnalysisEngine(){return false;}export function cachedAnalysis(){return null;}export async function streamAnalysis(){throw new Error("Unexpected engine request");}'};
 return nextLoad(url,context);
}});

const decode=text=>String(text).replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
class Classes{
 constructor(element){this.element=element;this.values=new Set();}
 add(...values){values.forEach(value=>this.values.add(value));}
 remove(...values){values.forEach(value=>this.values.delete(value));}
 contains(value){return this.values.has(value);}
 toggle(value,force){const use=force??!this.contains(value);use?this.add(value):this.remove(value);return use;}
}
class Element{
 constructor(tag='div'){
  this.tagName=tag.toUpperCase();this.nodeType=1;this.children=[];this.parentElement=null;
  this.attributes=new Map();this.dataset={};this.classList=new Classes(this);this.style={};
  this.listeners=[];this.disabled=false;this.hidden=false;this.checked=false;this.open=false;
  this._value='';this._text='';this.scrollTop=0;this.isConnected=true;
 }
 set className(value){this.classList.values=new Set(String(value).split(/\s+/).filter(Boolean));}
 get className(){return [...this.classList.values].join(' ');}
 setAttribute(name,value){
  value=String(value);this.attributes.set(name,value);
  if(name==='class')this.className=value;
  else if(name.startsWith('data-'))this.dataset[name.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
  else if(['name','id','type','value','title','role'].includes(name))this[name]=value;
  else if(['disabled','hidden','checked','selected','required'].includes(name))this[name]=true;
 }
 getAttribute(name){return this.attributes.get(name)??null;}
 removeAttribute(name){this.attributes.delete(name);if(['disabled','hidden','checked'].includes(name))this[name]=false;}
 get value(){
  if(this.tagName==='SELECT'&&!this._value){const options=this.querySelectorAll('option');return (options.find(option=>option.selected)||options[0])?.value||'';}
  if(this.tagName==='TEXTAREA'&&!this._value)return this.textContent;
  return this._value;
 }
 set value(value){this._value=String(value);}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 set textContent(value){this._text=String(value);this.children=[];}
 append(...nodes){for(const node of nodes){node.remove();node.isConnected=true;node.parentElement=this;this.children.push(node);}}
 appendChild(node){this.append(node);return node;}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;this.isConnected=false;}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 matches(selector){
  return selector.split(',').some(part=>{
   part=part.trim();if(!part)return false;
   if(part.includes(' ')){const chunks=part.split(/\s+/),last=chunks.pop();return this.matches(last)&&!!this.parentElement?.closest(chunks.join(' '));}
   if(/^[a-z][\w-]*/i.test(part)&&part.match(/^[a-z][\w-]*/i)[0].toUpperCase()!==this.tagName)return false;
   for(const [,id] of part.matchAll(/#([\w-]+)/g))if(this.id!==id)return false;
   for(const [,name] of part.matchAll(/\.([\w-]+)/g))if(!this.classList.contains(name))return false;
   for(const [,name,value] of part.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)){
    const actual=name==='open'?(this.open?'':null):this.getAttribute(name);
    if(actual===null||(value!==undefined&&actual!==value))return false;
   }
   return true;
  });
 }
 closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
 querySelectorAll(selector){return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]);}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 get elements(){return this.querySelectorAll('input,select,textarea,button');}
 set innerHTML(value){
  this._html=String(value);this.children=[];this._text='';const stack=[this];
  for(const token of String(value).match(/<!--[\s\S]*?-->|<\/?[^>]+>|[^<]+/g)||[]){
   if(token.startsWith('<!--'))continue;
   if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
   if(token.startsWith('<')){
    const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;
    const child=new Element(tag),attrs=token.slice(tag.length+1).replace(/\/?>$/,'');
    for(const [,name,double,single,bare] of attrs.matchAll(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))child.setAttribute(name,decode(double??single??bare??''));
    stack.at(-1).append(child);
    if(!['input','br','hr','img','meta','link'].includes(tag)&&!token.endsWith('/>'))stack.push(child);
   }else stack.at(-1)._text+=decode(token);
  }
 }
 get innerHTML(){return this._html||'';}
 addEventListener(type,fn,options){this.listeners.push({type,fn,options});}
 removeEventListener(type,fn){this.listeners=this.listeners.filter(listener=>listener.type!==type||listener.fn!==fn);}
 async emit(type,props={}){
  const event={target:this,currentTarget:this,key:'',preventDefault(){this.defaultPrevented=true;},stopPropagation(){},stopImmediatePropagation(){this.stopped=true;},...props};
  const direct=this['on'+type];if(direct)await direct(event);
  for(const listener of [...this.listeners].filter(listener=>listener.type===type)){await listener.fn(event);if(listener.options?.once)this.removeEventListener(type,listener.fn);if(event.stopped)break;}
  return event;
 }
 focus(){document.activeElement=this;}
 select(){}
 getBoundingClientRect(){return {left:0,top:0,bottom:30,width:400,height:300};}
 getClientRects(){return this.hidden?[]:[this.getBoundingClientRect()];}
 showModal(){this.open=true;}
 close(){this.open=false;void this.emit('close');}
}
const documentElement=new Element('html'),body=new Element('body');documentElement.append(body);
globalThis.document=new Element('document');Object.assign(document,{body,documentElement,activeElement:null,createElement:tag=>new Element(tag)});
document.append(documentElement);document.getElementById=id=>document.querySelector('#'+id);
const notices=document.createElement('div');notices.id='notices';body.append(notices);
globalThis.window=new Element('window');window.innerWidth=1500;window.innerHeight=900;
globalThis.boards=[];
globalThis.FormData=class{
 constructor(form){this.values=form.elements.filter(field=>field.name&&!field.disabled&&(!['checkbox','radio'].includes(field.type)||field.checked)).map(field=>[field.name,field.value]);}
 get(name){return this.values.find(([key])=>key===name)?.[1]??null;}
 getAll(name){return this.values.filter(([key])=>key===name).map(([,value])=>value);}
 entries(){return this.values[Symbol.iterator]();}
 [Symbol.iterator](){return this.entries();}
};
globalThis.confirm=()=>true;
const originalTimer=globalThis.setTimeout;globalThis.setTimeout=(fn,ms)=>{const handle=originalTimer(fn,ms);handle.unref?.();return handle;};

const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const E4='rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
const E5='rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const NF3='rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
const C5='rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
const NC3='rnbqkbnr/pp1ppppp/8/2p5/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 2';
const moves=new Map([
 [E4,new Map([['e7e5',{uci:'e7e5',san:'e5',fen:E5}],['c7c5',{uci:'c7c5',san:'c5',fen:C5}]])],
 [E5,new Map([['g1f3',{uci:'g1f3',san:'Nf3',fen:NF3}]])],
 [C5,new Map([['b1c3',{uci:'b1c3',san:'Nc3',fen:NC3}]])]
]);
globalThis.legalAt=fen=>[...(moves.get(fen)?.keys()||[])];
const requests=[];let respond=async(url,body)=>{
 if(url==='/api/move'){const position=moves.get(body.fen)?.get(body.uci);assert.ok(position,'Unexpected manual move');return position;}
 throw new Error('Unexpected request '+url);
};
globalThis.fetch=async(url,options={})=>{
 const request={url,method:options.method||'GET',body:typeof options.body==='string'?JSON.parse(options.body):options.body,signal:options.signal};requests.push(request);
 const payload=await respond(url,request.body,request);
 return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>payload};
};
const {makeDoc,appendLine,serialize}=await import('../static/board.js');
const {openExerciseEditor}=await import('../static/exercise-editor.js');
const settle=async()=>{for(let index=0;index<20;index++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const sourceDocument=()=>{
 const doc=appendLine(makeDoc(START),'',[{uci:'e2e4',san:'e4',fen:E4},{uci:'e7e5',san:'e5',fen:E5}]).doc;
 Object.assign(doc,{id:77,base_id:5,title:'Analyse importante',history:{can_undo:true,can_redo:true},start_path:'0'});
 doc.headers.White='Source';doc.nodes[1].comment='Annotation originale';doc.nodes[1].nags=[5];return doc;
};
const base={id:9,name:'Mes exercices',settings:{review_enabled:true,type:'solve',mode:'hybrid'},tags:['Erreurs']};
function solutionDocument(){
 let doc=appendLine(makeDoc(E4),'',[moves.get(E4).get('e7e5'),moves.get(E5).get('g1f3')]).doc;
 doc=appendLine(doc,'',[moves.get(E4).get('c7c5'),moves.get(C5).get('b1c3')]).doc;
 Object.assign(doc,{id:301,base_id:22,history:{can_undo:true},start_path:'0.0',created_at:'yesterday',updated_at:'today'});
 doc.headers.Event='Exact puzzle solution';doc.headers.White='Puzzle White';doc.headers.PuzzleId='AbCd1';
 doc.nodes[0].comment='Puzzle introduction';doc.nodes[1].comment='Forced reply';doc.nodes[1].nags=[1];
 doc.nodes.find(node=>node.path==='1').starting_comment='Alternative accepted';
 doc.nodes.find(node=>node.path==='1.0').comment='Alternative ending';
 return doc;
}
function open(options={}){
 const source=options.sourceDoc||sourceDocument(),before=JSON.stringify(source),created=[];
 const editor=openExerciseEditor({sourceDoc:source,sourcePath:'0',flipped:true,bases:[base],baseId:9,onCreated:entry=>created.push(entry),...options});
 return {editor,source,before,created};
}
function field(editor,name,value){const element=editor.dialog.querySelector('[name="'+name+'"]');assert.ok(element,'Missing field '+name);if(value!==undefined)element.value=value;return element;}
async function play(editor,uci){editor.board.legal=legalAt(editor.board.node().fen);assert.equal(await editor.board.tryMove(uci.slice(0,2),uci.slice(2,4),uci),true);await settle();}
const tests={
 async prefilled_solution_is_detached_at_root_and_preserves_annotations(){
  const initialDoc=solutionDocument(),original=JSON.stringify(initialDoc),{editor,source,before}=open({initialDoc});
  assert.equal(editor.board.path,'');assert.equal(editor.board.node().fen,E4);assert.equal(editor.fields.comment.value,'Puzzle introduction');
  assert.match(editor.dialog.textContent,/La solution est préremplie/);
  assert.deepEqual(editor.board.doc.nodes,initialDoc.nodes);assert.deepEqual(editor.board.doc.headers,initialDoc.headers);
  assert.notEqual(editor.board.doc.nodes,initialDoc.nodes);assert.notEqual(editor.board.doc.headers,initialDoc.headers);
  for(const key of ['id','base_id','history','created_at','updated_at'])assert.equal(editor.board.doc[key],undefined);
  assert.equal(editor.board.doc.start_path,'');assert.deepEqual(editor.history.flags(),{can_undo:false,can_redo:false});
  assert.equal(editor.board.engineOn,false);assert.equal(editor.board.engineRequests,undefined);
  await editor.board.go('1.0');editor.annotate({comment:'My independent note',nags:[5]});
  editor.board.doc.headers.Event='Edited only in draft';
  assert.equal(JSON.stringify(initialDoc),original);assert.equal(JSON.stringify(source),before);editor.close();
  assert.equal(JSON.stringify(initialDoc),original);assert.equal(JSON.stringify(source),before);
 },
 async prefilled_solution_saves_exact_moves_and_variants_without_engine_additions(){
  const initialDoc=solutionDocument(),original=JSON.stringify(initialDoc),expected=serialize(initialDoc);
  const {editor,source,before}=open({initialDoc}),ordinary=respond;
  editor.board.control('engine');assert.equal(editor.board.engineRequests,1);assert.equal(editor.board.path,'');
  assert.equal(serialize(editor.board.doc),expected);
  respond=async(url,body)=>url==='/api/entries'?{id:302,base_id:9}:ordinary(url,body);
  const result=await editor.save();assert.equal(result.entry.id,302);
  const posts=requests.filter(request=>request.url==='/api/entries');assert.equal(posts.length,1);assert.equal(posts[0].body.pgn,expected);assert.equal(posts[0].body.start_path,'');
  assert.deepEqual(requests.map(request=>request.url),['/api/entries']);
  assert.match(posts[0].body.pgn,/Alternative accepted/);assert.match(posts[0].body.pgn,/c5 2\. Nc3/);
  assert.equal(JSON.stringify(initialDoc),original);assert.equal(JSON.stringify(source),before);
 },
 async prefilled_invalid_document_opens_no_dialog(){
  const cases=[null,{},[],{headers:{},nodes:[]},{headers:[],nodes:makeDoc(E4).nodes}];
  cases[0]=makeDoc(START);
  const duplicate=solutionDocument();duplicate.nodes.push(structuredClone(duplicate.nodes[1]));cases.push(duplicate);
  const missing=solutionDocument();missing.nodes[0].children.push('missing');cases.push(missing);
  const orphan=solutionDocument();orphan.nodes[0].children=[];cases.push(orphan);
  const cycle=solutionDocument();cycle.nodes[1].children.push('');cases.push(cycle);
  const comment=solutionDocument();comment.nodes[1].comment={invalid:true};cases.push(comment);
  for(const initialDoc of cases){
   const before=JSON.stringify(initialDoc),boardCount=boards.length,dialogs=document.body.querySelectorAll('dialog').length;
   assert.throws(()=>open({initialDoc}),/solution/i);
   assert.equal(boards.length,boardCount);assert.equal(document.body.querySelectorAll('dialog').length,dialogs);assert.equal(JSON.stringify(initialDoc),before);
  }
  const next=open();assert.equal(next.editor.board.doc.nodes.length,1);next.editor.close();
 },
 async on_closed_runs_once_after_disposal_on_cancel_and_save(){
  let closed=0,current;
  const onClosed=()=>{closed++;assert.equal(current.disposed,true);assert.equal(current.board.disposed,true);assert.equal(current.dialog.isConnected,false);};
  current=open({initialDoc:solutionDocument(),onClosed}).editor;
  current.close();current.close();current.dispose();assert.equal(closed,1);
  const ordinary=respond;respond=async(url,body)=>url==='/api/entries'?{id:303}:ordinary(url,body);
  current=open({initialDoc:solutionDocument(),onClosed}).editor;
  await current.save();current.dispose();assert.equal(closed,2);
  current=open({initialDoc:solutionDocument(),onClosed}).editor;
  current.dispose();current.dispose();assert.equal(closed,3);
 },
 async detached_position_and_cancel(){
  const {editor,source,before}=open();
  assert.equal(editor.board.node().fen,E4);assert.equal(editor.board.path,'');assert.equal(editor.board.flipped,true);
  assert.equal(editor.board.doc.nodes.length,1);assert.equal(editor.board.doc.id,undefined);assert.equal(editor.board.doc.base_id,undefined);
  assert.deepEqual(editor.history.flags(),{can_undo:false,can_redo:false});assert.equal(editor.board.engineOn,false);assert.equal(editor.board.engineRequests,undefined);
  assert.equal(editor.board.doc.nodes[0].comment,'');assert.equal(JSON.stringify(source),before);
  await play(editor,'c7c5');editor.annotate({comment:'Ma solution',nags:[1]});
  assert.equal(JSON.stringify(source),before);assert.equal(editor.close(),true);assert.equal(editor.disposed,true);
  assert.equal(JSON.stringify(source),before);assert.ok(requests.every(request=>!request.url.startsWith('/api/entries')));
 },
 async manual_branches_and_edit_history(){
  const {editor,source,before}=open();
  await play(editor,'e7e5');await play(editor,'g1f3');const firstLine=serialize(editor.board.doc);
  await editor.board.go('');await editor.board.go('0');await editor.board.go('');
  await play(editor,'c7c5');await play(editor,'b1c3');
  assert.deepEqual(editor.board.doc.nodes[0].children,['0','1']);
  assert.match(serialize(editor.board.doc),/1\.\.\. e5 \(1\.\.\. c5 2\. Nc3/);
  assert.equal(editor.board.node().san,'Nc3');
  await editor.historyAction('undo');assert.equal(editor.board.doc.nodes.some(node=>node.san==='Nc3'),false);
  await editor.historyAction('undo');assert.equal(serialize(editor.board.doc),firstLine);
  await editor.historyAction('redo');assert.equal(editor.board.doc.nodes.some(node=>node.san==='c5'),true);
  await editor.historyAction('redo');assert.equal(editor.board.node().san,'Nc3');
  await editor.board.go('');const count=requests.length;await play(editor,'e7e5');
  assert.equal(editor.board.path,'0');assert.equal(editor.board.doc.nodes.length,5);assert.equal(requests.length,count+1);
  assert.equal(JSON.stringify(source),before);editor.close();
 },
 async variation_selection_preserves_exercise_annotation_draft(){
  const {editor,source,before}=open();
  await play(editor,'e7e5');await editor.board.go('');await play(editor,'c7c5');await editor.board.go('');
  const board=editor.board;board.control('engine');
  const engineRequests=board.engineRequests,requestCount=requests.length,original=serialize(board.doc),flags=editor.history.flags();
  editor.fields.comment.value='Idée en cours, ne pas effacer';await editor.fields.comment.emit('input');
  const pendingAnnotation=editor.pendingAnnotation,annotationInput=editor.fields.comment;
  editor.movesHost.scrollTop=173;board.selectVariation(1);
  const selected=editor.movesHost.querySelector('.move.variation-choice');
  assert.ok(selected);assert.equal(selected.dataset.path,'1');assert.equal(selected.getAttribute('aria-current'),null);assert.equal(selected.classList.contains('current'),false);
  assert.equal(board.selectedVariation().path,'1');assert.equal(board.path,'');assert.equal(board.node().fen,E4);
  assert.equal(editor.fields.comment,annotationInput);assert.equal(annotationInput.value,'Idée en cours, ne pas effacer');assert.equal(editor.pendingAnnotation,pendingAnnotation);
  assert.equal(editor.annotationPath,'');assert.equal(serialize(board.doc),original);assert.deepEqual(editor.history.flags(),flags);
  assert.equal(board.engineOn,true);assert.equal(board.engineRequests,engineRequests);assert.equal(requests.length,requestCount);assert.equal(JSON.stringify(source),before);
  editor.movesHost.scrollTop=247;editor.renderMoves();
  assert.equal(editor.movesHost.scrollTop,247);assert.equal(editor.movesHost.querySelector('.move.variation-choice').dataset.path,'1');assert.equal(editor.pendingAnnotation,pendingAnnotation);
  await board.control('next');await settle();
  assert.equal(board.path,'1');assert.equal(board.node().fen,C5);assert.equal(board.selectedVariation(),null);
  assert.equal(editor.movesHost.querySelector('.move.variation-choice'),null);assert.equal(editor.movesHost.querySelector('.move.current').dataset.path,'1');
  assert.equal(board.doc.nodes[0].comment,'Idée en cours, ne pas effacer');assert.equal(editor.pendingAnnotation,null);assert.equal(editor.fields.comment.value,'');
  assert.equal(board.engineRequests,engineRequests+1);assert.equal(JSON.stringify(source),before);editor.close();
 },
 async annotation_and_tree_actions(){
  const {editor,source,before}=open();
  await play(editor,'e7e5');await editor.board.go('');await play(editor,'c7c5');
  editor.fields.comment.value='Cette défense mérite une carte';await editor.fields.comment.emit('input');
  await editor.board.go('0');
  assert.equal(editor.board.doc.nodes.find(node=>node.path==='1').comment,'Cette défense mérite une carte');
  assert.equal(editor.board.node().comment,'');editor.annotate({comment:'Idée principale',nags:[1,14]});
  assert.match(serialize(editor.board.doc),/e5 \$1 \$14 \{Idée principale\}/);
  const ordinary=respond;respond=async(url,body)=>{
   if(url!=='/api/board/tree')return ordinary(url,body);
   assert.equal(body.start_path,'');assert.match(body.pgn,/Cette défense/);assert.doesNotMatch(body.pgn,/Annotation originale/);
   const doc=structuredClone(editor.board.doc);
   if(body.action==='main'){assert.equal(body.path,'1');doc.nodes[0].children=['1','0'];return {doc,path:'1'};}
   assert.equal(body.action,'delete');assert.equal(body.path,'0');doc.nodes=doc.nodes.filter(node=>node.path!=='0');doc.nodes[0].children=['1'];return {doc,path:''};
  };
  assert.equal(await editor.edit('main','1'),true);assert.equal(editor.board.doc.nodes[0].children[0],'1');
  assert.equal(await editor.edit('delete','0'),true);assert.equal(editor.board.doc.nodes.some(node=>node.san==='e5'),false);
  await editor.historyAction('undo');assert.equal(editor.board.doc.nodes.find(node=>node.san==='e5').comment,'Idée principale');
  assert.equal(JSON.stringify(source),before);editor.close();
 },
 async save_only_draft_pgn(){
  const {editor,source,before,created}=open();await play(editor,'c7c5');await play(editor,'b1c3');
  editor.fields.title.value='Mon exercice';editor.fields.comment.value='Dernier commentaire saisi';await editor.fields.comment.emit('input');
  const saved={id:888,base_id:9,title:'Mon exercice'},ordinary=respond;
  respond=async(url,body)=>url==='/api/entries'?saved:ordinary(url,body);
  const result=await editor.save(),post=requests.find(request=>request.url==='/api/entries');
  assert.equal(post.method,'POST');assert.equal(post.body.base_id,9);assert.equal(post.body.title,'Mon exercice');assert.equal(post.body.start_path,'');
  assert.ok(post.body.pgn.includes('[FEN "'+E4+'"]'));
  assert.match(post.body.pgn,/1\.\.\. c5 2\. Nc3 \{Dernier commentaire saisi\}/);
  assert.doesNotMatch(post.body.pgn,/White "Source"|1\. e4|1\.\.\. e5|Annotation originale/);
  assert.deepEqual(result,{entry:saved,baseId:9});assert.deepEqual(created,[result]);assert.equal(editor.disposed,true);
  assert.equal(editor.board.disposed,true);assert.equal(JSON.stringify(source),before);
 },
 async source_link_saves_manual_solution_and_recovers_stale_report(){
  const sourceLink={entry_id:77,ply:2,fingerprint:'saved-report'},ordinary=respond;
  const {editor,source,before,created}=open({sourceLink,bases:[{id:400,name:'Mega reference',reference:true,settings:{review_enabled:true,type:'solve'}},base],baseId:400});
  assert.deepEqual(editor.bases.map(item=>item.id),[9]);assert.doesNotMatch(editor.fields.base_id.innerHTML,/Mega reference/);await play(editor,'c7c5');await play(editor,'b1c3');
  editor.annotate({comment:'Ma solution, sans variante imposée',nags:[5]});
  const pgn=serialize(editor.board.doc),saved={id:889,base_id:9,title:'Position à travailler'};let attempts=0;
  respond=async(url,body)=>{
   if(url==='/api/game-analysis/77/exercise'){
    attempts++;assert.equal(body.pgn,pgn);assert.equal(body.ply,2);assert.equal(body.fingerprint,'saved-report');assert.equal(body.base_id,9);
    if(attempts===1)throw new Error('La partie a changé. Actualise le bilan.');
    return {entry_id:889,base_id:9,duplicate:false};
   }
   if(url==='/api/entries/889')return saved;
   return ordinary(url,body);
  };
  assert.equal(await editor.save(),false);assert.equal(editor.disposed,false);assert.equal(serialize(editor.board.doc),pgn);assert.equal(JSON.stringify(source),before);
  assert.match(editor.dialog.querySelector('[data-exercise-error]').textContent,/Actualise/);
  const result=await editor.save();assert.deepEqual(result,{entry:saved,baseId:9});assert.deepEqual(created,[result]);
  assert.equal(editor.disposed,true);assert.equal(JSON.stringify(source),before);
  assert.equal(requests.filter(request=>request.url==='/api/entries').length,0);
  const post=requests.find(request=>request.url==='/api/game-analysis/77/exercise');assert.equal(post.method,'POST');
  assert.match(post.body.pgn,/c5 2\. Nc3/);assert.match(post.body.pgn,/Ma solution/);assert.doesNotMatch(post.body.pgn,/Annotation originale|White "Source"/);
 },
 async save_lock_prevents_duplicates_and_changes(){
  const {editor,source,before,created}=open();await play(editor,'e7e5');
  const pending=deferred(),ordinary=respond;respond=async(url,body)=>url==='/api/entries'?pending.promise:ordinary(url,body);
  const saving=editor.save();await settle();const frozen=serialize(editor.board.doc);
  assert.equal(editor.saving,true);assert.equal(editor.board.inputLocked,true);
  assert.equal(await editor.save(),false);assert.equal(editor.close(),false);assert.equal(editor.annotate({comment:'Refusé'}),false);
  assert.equal(await editor.edit('delete','0'),false);assert.equal(await editor.historyAction('undo'),false);
  await editor.board.go('');assert.equal(editor.board.path,'0');assert.equal(serialize(editor.board.doc),frozen);
  const cancelled=await editor.dialog.emit('cancel');assert.equal(cancelled.defaultPrevented,true);assert.equal(editor.disposed,false);
  assert.equal(requests.filter(request=>request.url==='/api/entries').length,1);
  pending.resolve({id:90});await saving;assert.equal(created.length,1);assert.equal(JSON.stringify(source),before);
  assert.equal(await editor.save(),false);
 },
 async failed_save_keeps_draft_and_reuses_created_base(){
  const {editor,source,before}=open();await play(editor,'c7c5');editor.annotate({comment:'Ne pas perdre ceci',nags:[5]});
  editor.fields.base_id.value='new';editor.fields.base_name.value='Mes positions';const original=serialize(editor.board.doc),ordinary=respond;let entryAttempts=0;
  respond=async(url,body)=>{
   if(url==='/api/bases')return {id:20,name:body.name,settings:body.settings,tags:body.tags};
   if(url==='/api/entries'){entryAttempts++;if(entryAttempts===1)throw new Error('Serveur temporairement indisponible');return {id:91};}
   return ordinary(url,body);
  };
  assert.equal(await editor.save(),false);assert.equal(editor.disposed,false);assert.equal(editor.saving,false);assert.equal(editor.board.inputLocked,false);
  assert.equal(serialize(editor.board.doc),original);assert.equal(editor.fields.base_id.value,'20');
  assert.match(editor.dialog.querySelector('[data-exercise-error]').textContent,/temporairement/);
  const result=await editor.save();assert.equal(result.entry.id,91);assert.equal(result.baseId,20);
  assert.equal(requests.filter(request=>request.url==='/api/bases').length,1);assert.equal(requests.filter(request=>request.url==='/api/entries').length,2);
  assert.ok(requests.filter(request=>request.url==='/api/entries').every(request=>request.body.pgn===original&&request.body.base_id===20));
  assert.equal(JSON.stringify(source),before);
 },
 async edit_failure_preserves_draft(){
  const {editor,source,before}=open();await play(editor,'e7e5');editor.annotate({comment:'Conserver',nags:[1]});
  const original=serialize(editor.board.doc),cursor=editor.board.path,flags=editor.history.flags(),ordinary=respond;
  respond=async(url,body)=>{if(url==='/api/board/tree')throw new Error('Modification refusée');return ordinary(url,body);};
  assert.equal(await editor.edit('delete','0'),false);assert.equal(serialize(editor.board.doc),original);assert.equal(editor.board.path,cursor);
  assert.deepEqual(editor.history.flags(),flags);assert.equal(editor.editing,false);assert.equal(editor.board.inputLocked,false);
  assert.match(editor.dialog.querySelector('[data-exercise-error]').textContent,/refusée/);assert.equal(JSON.stringify(source),before);editor.close();
 },
 async close_disposes_board_and_listeners(){
  const documentBefore=document.listeners.length,windowBefore=window.listeners.length;
  const {editor,source,before}=open();await play(editor,'e7e5');editor.board.control('engine');assert.equal(editor.board.engineOn,true);assert.equal(editor.board.engineRequests,1);
  const pending=deferred(),ordinary=respond;respond=async(url,body)=>url==='/api/board/tree'?pending.promise:ordinary(url,body);
  const editing=editor.edit('delete','0');await settle();const request=requests.at(-1);assert.equal(request.url,'/api/board/tree');assert.equal(request.signal.aborted,false);
  const original=serialize(editor.board.doc);assert.equal(editor.close(),true);assert.equal(request.signal.aborted,true);
  assert.equal(editor.board.disposed,true);assert.equal(editor.dialog.isConnected,false);assert.equal(editor.listeners.length,0);
  assert.equal(document.listeners.length,documentBefore);assert.equal(window.listeners.length,windowBefore);
  pending.resolve({doc:makeDoc(E4),path:''});assert.equal(await editing,false);assert.equal(serialize(editor.board.doc),original);
  assert.equal(JSON.stringify(source),before);
  const next=open();assert.notEqual(next.editor,editor);next.editor.close();
 },
 async no_solution_validation_and_optional_engine(){
  const {editor}=open();assert.equal(await editor.save(),false);assert.equal(editor.disposed,false);assert.equal(requests.length,0);
  assert.match(editor.dialog.querySelector('[data-exercise-error]').textContent,/au moins un coup/);
  editor.board.control('engine');assert.equal(editor.board.engineOn,true);assert.equal(editor.board.engineRequests,1);
  assert.equal(editor.board.doc.nodes.length,1);assert.deepEqual(editor.history.flags(),{can_undo:false,can_redo:false});
  editor.board.control('engine');assert.equal(editor.board.engineOn,false);assert.equal(editor.board.doc.nodes.length,1);editor.close();
  const playBase={id:10,name:'Conversions',settings:{type:'play',review_enabled:true}};
  const next=open({bases:[playBase],baseId:10}),ordinary=respond;respond=async(url,body)=>url==='/api/entries'?{id:92}:ordinary(url,body);
  const saved=await next.editor.save();assert.equal(saved.entry.id,92);assert.equal(saved.baseId,10);
  const post=requests.find(request=>request.url==='/api/entries');assert.ok(post);assert.equal(post.body.start_path,'');assert.doesNotMatch(post.body.pgn,/1\.\.\./);
 },
 async successful_creation_survives_refresh_error(){
  let callbacks=0;const {editor}=open({onCreated:async()=>{callbacks++;throw new Error('Refresh failed');}});await play(editor,'e7e5');
  const ordinary=respond;respond=async(url,body)=>url==='/api/entries'?{id:93}:ordinary(url,body);
  const result=await editor.save();assert.equal(result.entry.id,93);assert.equal(editor.disposed,true);assert.equal(callbacks,1);
  assert.equal(await editor.save(),false);assert.equal(requests.filter(request=>request.url==='/api/entries').length,1);
 },
 async close_ignores_pending_manual_move_and_reopens_cleanly(){
  const {editor,source,before}=open(),ordinary=respond,pending=deferred();
  const reused=openExerciseEditor({sourceDoc:sourceDocument(),sourcePath:''});assert.equal(reused,editor);assert.equal(editor.board.node().fen,E4);
  respond=async(url,body)=>url==='/api/move'?pending.promise:ordinary(url,body);
  editor.board.legal=legalAt(E4);const moving=editor.board.tryMove('e7','e5','e7e5');await settle();
  assert.equal(editor.board.busy,true);assert.equal(await editor.save(),false);assert.equal(requests.filter(request=>request.url==='/api/entries').length,0);
  assert.equal(editor.close(),true);const next=open({sourcePath:''});assert.notEqual(next.editor,editor);assert.equal(next.editor.board.node().fen,START);
  pending.resolve(moves.get(E4).get('e7e5'));await moving;
  assert.equal(editor.board.doc.nodes.length,1);assert.equal(next.editor.board.doc.nodes.length,1);
  assert.equal(next.editor.board.node().fen,START);assert.equal(next.editor.disposed,false);assert.equal(JSON.stringify(source),before);next.editor.close();
 }
};
const selected=process.argv[2];assert.ok(tests[selected],'unknown test '+selected);await tests[selected]();console.log(selected+' passed');
