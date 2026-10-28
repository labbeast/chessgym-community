import {setLanguage,t} from '../static/i18n.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';

class Element{
 constructor(tag='div',attributes={}){
  this.tagName=tag.toUpperCase();this.attributes=attributes;this.id=attributes.id||'';this.children=[];this.dataset={};this.hidden='hidden' in attributes;this.disabled=false;this.scrollTop=0;
  for(const [key,value] of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;
  const classes=new Set((attributes.class||'').split(/\s+/).filter(Boolean));
  this.classList={add:(...names)=>names.forEach(name=>classes.add(name)),remove:(...names)=>names.forEach(name=>classes.delete(name)),contains:name=>classes.has(name),toggle:(name,on)=>{const enabled=on??!classes.has(name);enabled?classes.add(name):classes.delete(name);return enabled;}};
  const styles=new Map();this.style={setProperty:(name,value)=>styles.set(name,value),getPropertyValue:name=>styles.get(name)||'',removeProperty:name=>styles.delete(name)};
 }
 set innerHTML(value){
  this._html=value;this.children=[];this._text=null;
  const stack=[this],tokens=String(value).matchAll(/<\/?[^>]+>|[^<]+/g);
  for(const match of tokens){
   const token=match[0];
   if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}
   if(!token.startsWith('<')){stack.at(-1).children.push({textContent:token});continue;}
   const tag=token.match(/^<([\w-]+)/)?.[1];if(!tag)continue;
   const attrs={};for(const attr of token.matchAll(/([\w-]+)(?:="([^"]*)")?/g)){if(attr.index===1)continue;attrs[attr[1]]=attr[2]??'';}
   const child=new Element(tag,attrs);child.parentElement=stack.at(-1);stack.at(-1).children.push(child);
   if(!/^(input|img|br|hr|meta|link)$/.test(tag)&&!token.endsWith('/>'))stack.push(child);
  }
 }
 get innerHTML(){return this._html||'';}
 set textContent(value){this._text=String(value);}
 get textContent(){return this._text??this.children.map(child=>child.textContent||'').join('');}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 removeAttribute(name){delete this.attributes[name];}
 appendChild(child){child.parentElement=this;this.children.push(child);return child;}
 remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(child=>child!==this);this.parentElement=null;}
 matches(selector){
  if(selector.startsWith('#'))return this.id===selector.slice(1);
  if(selector.startsWith('.'))return this.classList.contains(selector.slice(1));
  const attr=selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
  if(attr)return attr[1] in this.attributes&&(attr[2]===undefined||this.attributes[attr[1]]===attr[2]);
  return this.tagName===selector.toUpperCase();
 }
 querySelectorAll(selector){
  if(selector.includes(','))return [...new Set(selector.split(',').flatMap(part=>this.querySelectorAll(part.trim())))];
  const [first,...rest]=selector.split(/\s+/);
  if(rest.length)return this.querySelectorAll(first).flatMap(child=>child.querySelectorAll(rest.join(' ')));
  const result=[];for(const child of this.children){if(!child.matches)continue;if(child.matches(selector))result.push(child);result.push(...child.querySelectorAll(selector));}return result;
 }
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 getBoundingClientRect(){return {top:this.id==='solution-panel'?120:0,height:30};}
}
const boardSource=String.raw`
export function makeDoc(fen){return {headers:{Result:'*'},nodes:[{path:'',parent:null,fen,children:[],comment:'',nags:[]}]};}
export class Board{
 constructor(host,options){Object.assign(this,{host,path:'',engineOn:false,disposed:false,inputLocked:false,busy:false,...options});globalThis.boards.push(this);host.innerHTML='<div class="board-toolbar"></div>';options.engineHost.innerHTML='<div class="engine-panel engine-docked"></div>';this.renderBoard();}
 node(){return this.doc.nodes.find(node=>node.path===this.path)||this.doc.nodes[0];}
 dispose(){this.disposed=true;}
 renderBoard(){this.renderedLocked=this.busy||this.inputLocked;this.renders=(this.renders||0)+1;}
 render(){this.renderBoard();}
 async setDoc(doc,path=''){this.doc=doc;this.path=path;this.renderBoard();if(globalThis.setDocGate)await globalThis.setDocGate;}
 async move(uci){
  this.busy=true;
  try{
   if(globalThis.moveGate)await globalThis.moveGate;
   if(this.disposed)return;
   const parent=this.node(),existing=parent.children.map(path=>this.doc.nodes.find(node=>node.path===path)).find(node=>node.uci===uci);
   const path=existing?.path||(parent.path?parent.path+'.':'')+parent.children.length,parts=parent.fen.split(' ');
   parts[1]=parts[1]==='w'?'b':'w';if(parts[1]==='w')parts[5]=String(Number(parts[5])+1);
   const san={e2e4:'e4',e7e5:'e5',g1f3:'Nf3',d2d4:'d4',d7d5:'d5',c2c4:'c4'}[uci]||uci;
   if(!existing){parent.children.push(path);this.doc.nodes.push({path,parent:parent.path,fen:parts.join(' '),san,uci,children:[],comment:'',nags:[]});}this.path=path;
   this.gameOver=globalThis.terminalMove===uci;this.result=this.gameOver?'1-0':'*';
   this.onChange?.(this);
  }finally{this.busy=false;if(!this.disposed)this.renderBoard();}
 }
 async go(path){if(this.disposed||this.busy||this.inputLocked||!this.doc.nodes.some(node=>node.path===path))return;this.path=path;this.gameOver=globalThis.terminalMove===this.node().uci;this.result=this.gameOver?'1-0':'*';this.onChange?.(this);}
}
`;
registerHooks({load(url,context,nextLoad){
 if(url.endsWith('/static/board.js'))return {format:'module',shortCircuit:true,source:boardSource};
 if(url.endsWith('/static/api.js'))return {format:'module',shortCircuit:true,source:`export const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';export const TYPES={solve:'Puzzle',moves:'Ouverture',play:'Position à jouer'};export const api=(...args)=>globalThis.testApi(...args);export const fail=error=>globalThis.errors.push(error);export const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');`};
 return nextLoad(url,context);
}});
globalThis.boards=[];globalThis.errors=[];
const calls=[],fen='8/8/8/8/8/8/8/K6k w - - 0 1',base={id:4,name:'Mes exercices',settings:{mode:'hybrid',skill:6}};
const card={id:'card-12',content_key:'a'.repeat(64),entry_id:12,path:'0.1',fen,title:'Trouver la suite',type:'solve',comment:'Explication secrète <script>',solutions:[['e2e4','e7e5','g1f3'],['d2d4','d7d5','c2c4']],settings:{}};
let queue={cards:[card]},queueGate=null,engineGate=null,gradeGate=null,masterGate=null;
globalThis.testApi=async(url,options={})=>{
 calls.push({url,options:structuredClone(options)});
 if(url.includes('/queue'))return queueGate?await queueGate:queue;
 if(url==='/api/engine/play')return engineGate?await engineGate:{uci:'e7e5',game_over:false};
 if(url.endsWith('/grade'))return gradeGate?await gradeGate:{};
 if(url.endsWith('/master'))return masterGate?await masterGate:{state:'mastered',due:null,interval_days:0};
 throw Error('Unexpected API '+url);
};
const review=await import('../static/review.js');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const host=new Element('main');
const options={onEditEntry:async()=>false,onClose:()=>review.stopReview(),onSettings:()=>{}};
const start=(extra={})=>review.startReview(host,base,{...options,...extra});
const click=id=>{const button=host.querySelector('#'+id);assert.ok(button,id);return button.onclick();};
const grades=()=>host.querySelector('#grade-panel').querySelectorAll('[data-grade]');
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const pagedCard=index=>({...card,id:'paged-'+index,entry_id:100+index,session_index:index,solutions:[['e2e4']]});
const paged=(cards,next,total,goal={minutes:null,cards:null})=>({session_id:'11111111-1111-4111-8111-111111111111',base_id:base.id,total,offset:cards[0]?.session_index??0,next_offset:next,cards,skipped:[],goal,priority:'due',probability_available:false});
function pagedApi(first,read){
 const original=globalThis.testApi;
 globalThis.testApi=async(url,options={})=>{
  if(url.startsWith('/api/review-sessions')){
   calls.push({url,options:structuredClone(options)});
   return url==='/api/review-sessions'?structuredClone(first):await read(url,options);
  }
  return original(url,options);
 };
}
const sourceDocument={headers:{Result:'*'},nodes:[
 {path:'',parent:null,fen,children:['0','1'],comment:'Root idea',nags:[]},
 {path:'0',parent:'',fen:fen.replace(' w ',' b '),uci:'e2e4',san:'e4',children:['0.0'],comment:'First move idea',nags:[1]},
 {path:'0.0',parent:'0',fen,uci:'e7e5',san:'e5',children:['0.0.0'],comment:'Reply idea',nags:[]},
 {path:'0.0.0',parent:'0.0',fen:fen.replace(' w ',' b '),uci:'g1f3',san:'Nf3',children:[],comment:'Last idea',nags:[]},
 {path:'1',parent:'',fen:fen.replace(' w ',' b '),uci:'d2d4',san:'d4',children:[],comment:'Alternative',nags:[]},
]};
const tests={
 async toolbar_overlay_waits_for_programme_resume_and_retains_callback_after_snapshot(){
  const previousDocument=globalThis.document;globalThis.document={hidden:false,createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}};
  const gate=deferred();let resumed=0,notified=0,failResume=true;
  const onToolbarResume=async()=>{resumed++;if(failResume){await gate.promise;throw Error('Resume failed');}review.resumeReviewToolbar();};
  try{
   await start({onToolbarResume,onStateChange:()=>notified++});const before=notified;review.pauseReviewToolbar();assert.ok(notified>before,'pause persists its snapshot');
   const snapshot=review.snapshotReview();assert.equal(snapshot.onToolbarResume,onToolbarResume);assert.equal('onToolbarResume' in review.reviewSnapshotData(snapshot),false);
   await review.resumeReview(host,snapshot);const button=host.querySelector('[data-review-toolbar-resume]');
   const pending=button.onclick();await button.onclick();assert.equal(resumed,1);assert.equal(button.disabled,true);assert.equal(review.reviewToolbarState().paused,true);
   gate.resolve();await pending;assert.equal(review.reviewToolbarState().paused,true);assert.equal(button.disabled,false);assert.match(errors.at(-1).message,/Resume failed/);
   failResume=false;await button.onclick();assert.equal(resumed,2);assert.equal(review.reviewToolbarState().paused,false);
  }finally{review.stopReview();globalThis.document=previousDocument;}
 },
 async toolbar_pause_preserves_clock_position_and_snapshot_without_grading(){
  const oldNow=Date.now,oldDocument=globalThis.document;let clock=1000;
  Date.now=()=>clock;globalThis.document={hidden:false,createElement:tag=>new Element(tag),addEventListener(){},removeEventListener(){}};
  try{
   const first={...paged([pagedCard(0),pagedCard(1)],null,2,{minutes:20,cards:null}),elapsed_ms:60000};
   await start({preparedSession:first});clock=6000;
   assert.equal(review.reviewToolbarState().elapsedMs,65000);assert.equal(review.reviewToolbarState().targetMs,1200000);
   const board=review.reviewBoard();assert.equal(review.pauseReviewToolbar(),true);
   assert.equal(board.inputLocked,true);assert.equal(host.querySelector('#reveal-answer').disabled,true);
   assert.ok(host.querySelector('[data-review-toolbar-pause]'));assert.equal(host.querySelector('.review-notebook').inert,true);
   await board.onMove('e2e4');await click('reveal-answer');assert.equal(board.path,'');assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
   clock=35000;const saved=review.snapshotReview();assert.equal(saved.attempt.elapsedMs,5000);assert.equal(saved.toolbarPaused,true);
   assert.equal(review.reviewToolbarState().elapsedMs,65000);review.stopReview();clock=60000;
   await review.resumeReview(host,saved);assert.equal(review.reviewToolbarState().paused,true);assert.equal(review.reviewBoard().inputLocked,true);
   clock=85000;assert.equal(review.reviewToolbarState().elapsedMs,65000);
   host.querySelector('[data-review-toolbar-resume]').onclick();assert.equal(review.reviewToolbarState().paused,false);assert.equal(review.reviewBoard().inputLocked,false);
   assert.equal(host.querySelector('.review-notebook').inert,false);clock=88000;assert.equal(review.reviewToolbarState().elapsedMs,68000);
   await review.reviewBoard().onMove('e2e4');clock=98000;assert.equal(review.reviewToolbarState().elapsedMs,68000,'completed card evidence is frozen');
   await grades()[2].onclick();assert.equal(review.reviewToolbarState().elapsedMs,68000,'recorded card is counted exactly once');
   await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();assert.equal(review.reviewToolbarState(),null,'finished session restores global navigation');
  }finally{review.stopReview();Date.now=oldNow;globalThis.document=oldDocument;}
 },
 async toolbar_pause_and_hidden_time_do_not_overlap_or_accept_busy_moves(){
  const oldNow=Date.now,oldDocument=globalThis.document,listeners=new Map();let clock=1000;
  Date.now=()=>clock;globalThis.document={hidden:false,createElement:tag=>new Element(tag),addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  try{
   await start();clock=5000;globalThis.document.hidden=true;listeners.get('visibilitychange')();clock=8000;
   review.pauseReviewToolbar();assert.equal(review.reviewToolbarState().elapsedMs,4000);
   globalThis.document.hidden=false;listeners.get('visibilitychange')();clock=12000;review.resumeReviewToolbar();clock=14000;
   assert.equal(review.reviewToolbarState().elapsedMs,6000);
   const gate=deferred();globalThis.moveGate=gate.promise;const moving=review.reviewBoard().onMove('e2e4');
   assert.throws(()=>review.pauseReviewToolbar(),/coup en cours/);assert.equal(review.reviewToolbarState().paused,false);
   gate.resolve();await moving;globalThis.moveGate=null;
  }finally{globalThis.moveGate=null;review.stopReview();Date.now=oldNow;globalThis.document=oldDocument;}
 },
 async training_run_context_survives_pause_and_never_finishes_implicitly(){
  const run='22222222-2222-4222-8222-222222222222',first={...paged([pagedCard(0)],null,1),training_run_id:run};
  pagedApi(first,async()=>first);await start({training_run_id:run});
  assert.equal(calls.find(c=>c.url==='/api/review-sessions').options.body.training_run_id,run);
  assert.equal(calls.find(c=>c.url==='/api/review-sessions').options.body.request_id,run,'Planned creation retries keep a stable receipt');
  assert.equal(review.reviewTrainingContext().training_run_id,run);
  const paused=review.suspendReview({assisted:false});assert.equal(paused.training_run_id,run);
  assert.equal(review.reviewSnapshotData(paused).training_run_id,run);
  await review.resumeReview(host,paused);await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();
  assert.equal(review.reviewTrainingContext().training_run_id,run);
  assert.equal(review.reviewTrainingContext().finished,true);
  assert.equal(review.reviewToolbarState().training_run_id,run);assert.equal(review.reviewToolbarState().active,false);assert.equal(review.reviewToolbarState().canPause,false);assert.equal(review.reviewToolbarState().canFinish,true);
  assert.equal((await review.settleReviewTraining({finishing:true})).training_run_id,run);
  assert.equal(calls.filter(c=>c.url.includes('/training/')).length,0,'Native completion does not finish the programme episode');
  const answer=calls.find(c=>c.url.endsWith('/grade'));assert.equal(answer.options.body.session_id,first.session_id);
 },
 async training_finish_preserves_ungraded_work_and_accepts_fresh_card(){
  const run='22222222-2222-4222-8222-222222222222',first={...paged([pagedCard(0),pagedCard(1)],null,2),training_run_id:run};
  pagedApi(first,async()=>first);await start({training_run_id:run});
  assert.equal((await review.settleReviewTraining({finishing:true})).training_run_id,run);
  await review.reviewBoard().onMove('d2d4');
  await assert.rejects(review.settleReviewTraining({finishing:true}),/carte en cours/);
  assert.equal((await review.settleReviewTraining()).training_run_id,run,'Pause keeps unfinished attempt');
  const paused=review.suspendReview({assisted:false});assert.equal(paused.attempt.userWorked,true);
  await review.resumeReview(host,paused);await assert.rejects(review.settleReviewTraining({finishing:true}),/carte en cours/);
  await review.reviewBoard().onMove('e2e4');await assert.rejects(review.settleReviewTraining({finishing:true}),/carte en cours/);
  await grades()[2].onclick();assert.equal((await review.settleReviewTraining({finishing:true})).card_id,'paged-1');
 },
 async training_settle_waits_for_grade_and_rejects_uncertain_receipt(){
  const run='22222222-2222-4222-8222-222222222222',first={...paged([pagedCard(0),pagedCard(1)],null,2),training_run_id:run};
  pagedApi(first,async()=>first);await start({training_run_id:run});await review.reviewBoard().onMove('e2e4');
  const gate=deferred();gradeGate=gate.promise;const saving=grades()[2].onclick();
  let settled=false;const waiting=review.settleReviewTraining().then(value=>{settled=true;return value;});await settle();assert.equal(settled,false);
  gate.resolve({});await saving;assert.equal((await waiting).training_run_id,run);
  await review.reviewBoard().onMove('e2e4');gradeGate=Promise.reject(Error('Network unavailable'));await grades()[2].onclick();
  await assert.rejects(review.settleReviewTraining({finishing:true}),/confirmation/);
  assert.equal(review.snapshotReview().pendingAction.action,'grade');
 },
 async training_empty_queue_does_not_bind_another_native_session(){
  const run='22222222-2222-4222-8222-222222222222',first={...paged([],null,0),training_run_id:run};
  pagedApi(first,async()=>first);await start({training_run_id:run});
  assert.equal(host.querySelector('#free-review'),null);
  assert.equal(review.reviewTrainingContext().training_run_id,run);
  assert.equal(calls.filter(c=>c.url==='/api/review-sessions').length,1);
 },
 async final_move_comment_uses_source_path_and_preserves_unassisted_result(){
  const source=structuredClone(sourceDocument);source.nodes.at(-2).comment='Final <annotation> [%eval 0.42]';const original=globalThis.testApi;let reads=0;globalThis.testApi=(url,options)=>{if(url.endsWith('/source')){reads++;return structuredClone(source);}return original(url,options);};
  queue={cards:[{...card,type:'moves',path:'0.0',fen,comment:'',answers:['g1f3'],solutions:[]}]};await start();assert.equal(reads,0);assert.doesNotMatch(host.textContent,/Final &lt;annotation/);await review.reviewBoard().onMove('g1f3');await settle();assert.equal(reads,1);
  assert.match(host.querySelector('#solution-panel').innerHTML,/Final &lt;annotation&gt;/);assert.doesNotMatch(host.querySelector('#solution-panel').innerHTML,/eval|<annotation>/);assert.match(host.querySelector('#review-moves').innerHTML,/Final &lt;annotation&gt;/);assert.equal(review.reviewBoard().node().comment,'Final <annotation> [%eval 0.42]');const snapshot=review.snapshotReview();assert.equal(snapshot.attempt.assisted,false);assert.equal(snapshot.attempt.errors,0);assert.equal(snapshot.attempt.hints,0);assert.equal(source.nodes.at(-2).comment,'Final <annotation> [%eval 0.42]');assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },
 async final_comment_follows_the_accepted_alternative_not_mainline(){
  const original=globalThis.testApi;globalThis.testApi=(url,options)=>url.endsWith('/source')?structuredClone(sourceDocument):original(url,options);queue={cards:[{...card,path:'',comment:'Introduction',solutions:[['e2e4','e7e5','g1f3'],['d2d4']]}]};await start();await review.reviewBoard().onMove('d2d4');await settle();assert.match(host.querySelector('#solution-panel').innerHTML,/Introduction/);assert.match(host.querySelector('#solution-panel').innerHTML,/Alternative/);assert.doesNotMatch(host.querySelector('#solution-panel').innerHTML,/Last idea|First move idea/);assert.equal(review.reviewBoard().path,'0');assert.equal(review.reviewBoard().node().comment,'Alternative');assert.equal(sourceDocument.nodes.at(-1).path,'1');
 },
 async final_comment_appears_after_reveal_and_automatic_opponent_reply(){
  const original=globalThis.testApi;globalThis.testApi=(url,options)=>url.endsWith('/source')?structuredClone(sourceDocument):original(url,options);queue={cards:[{...card,path:'',comment:'',solutions:[['e2e4','e7e5','g1f3']]}]};await start();await click('reveal-answer');await settle();assert.match(host.querySelector('#solution-panel').innerHTML,/Last idea/);assert.equal(review.snapshotReview().attempt.revealed,true);
  queue={cards:[{...card,path:'',comment:'',solutions:[['e2e4','e7e5']]}]};await start();await review.reviewBoard().onMove('e2e4');await settle();assert.match(host.querySelector('#solution-panel').innerHTML,/Reply idea/);assert.equal(review.reviewBoard().path,'0.0');assert.equal(review.snapshotReview().attempt.assisted,false);
 },
 async final_comments_survive_finished_resume_exploration_and_return_to_final(){
  const original=globalThis.testApi;globalThis.testApi=(url,options)=>url.endsWith('/source')?structuredClone(sourceDocument):original(url,options);queue={cards:[{...card,type:'moves',path:'0.0',comment:'',answers:['g1f3'],solutions:[]}]};await start();let board=review.reviewBoard();await board.onMove('g1f3');await settle();await board.go('');await board.onMove('d2d4');const explored=board.path,snapshot=review.suspendReview();assert.equal(snapshot.attempt.completion.finalComment,'Last idea');
  await review.resumeReview(host,await review.prepareReviewResume(snapshot));await settle();board=review.reviewBoard();assert.equal(board.path,explored);assert.equal(board.doc.nodes.length,3);assert.match(host.querySelector('#solution-panel').innerHTML,/Last idea/);await click('return-solution');assert.equal(board.path,'0');assert.equal(board.node().comment,'Last idea');assert.equal(review.snapshotReview().attempt.errors,0);
 },
 async failed_comment_load_preserves_grade_and_retry_only_loads_comments(){
  const original=globalThis.testApi;let failures=1;globalThis.testApi=(url,options)=>{if(url.endsWith('/source'))return failures--?Promise.reject(Error('Offline')):structuredClone(sourceDocument);return original(url,options);};queue={cards:[{...card,path:'',comment:'Introduction',solutions:[['d2d4']]}]};await start();await review.reviewBoard().onMove('d2d4');await settle();assert.match(host.querySelector('#solution-panel').textContent,/Introduction/);assert.match(host.querySelector('#solution-panel').textContent,/pas pu être chargés/);assert.ok(grades().every(button=>!button.disabled));assert.equal(errors.length,0);await host.querySelector('[data-review-comments-retry]').onclick();assert.match(host.querySelector('#solution-panel').textContent,/Alternative/);assert.equal(host.querySelector('[data-review-comments-retry]'),null);assert.equal(review.snapshotReview().attempt.assisted,false);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },
 async late_comment_cannot_change_new_card_or_retried_attempt(){
  const original=globalThis.testApi,gate=deferred();globalThis.testApi=(url,options)=>url.endsWith('/source')?gate.promise:original(url,options);queue={cards:[{...card,path:'',solutions:[['d2d4']]}]};await start();await review.reviewBoard().onMove('d2d4');await click('retry-card');const html=host.querySelector('#solution-panel').innerHTML;gate.resolve(structuredClone(sourceDocument));await settle();assert.equal(host.querySelector('#solution-panel').hidden,true);assert.equal(host.querySelector('#solution-panel').innerHTML,html);assert.equal(review.reviewBoard().doc.nodes.length,1);
  const late=deferred();globalThis.testApi=(url,options)=>url.endsWith('/source')?late.promise:original(url,options);await review.reviewBoard().onMove('d2d4');queue={cards:[{...card,id:'next-card',path:'',solutions:[['e2e4']]}]};await start();late.resolve(structuredClone(sourceDocument));await settle();assert.equal(review.reviewBoard().doc.nodes.length,1);assert.equal(review.reviewBoard().doc.nodes[0].comment,'');assert.equal(host.querySelector('#solution-panel').hidden,true);assert.equal(review.snapshotReview().cards[0].id,'next-card');
 },
 async final_comment_load_does_not_replace_full_source_while_consulting(){
  const original=globalThis.testApi,gate=deferred();let reads=0;globalThis.testApi=(url,options)=>{if(url.endsWith('/source'))return ++reads===1?gate.promise:structuredClone(sourceDocument);return original(url,options);};queue={cards:[{...card,type:'moves',path:'0.0',comment:'',answers:['g1f3'],solutions:[]}]};await start();await review.reviewBoard().onMove('g1f3');await click('toggle-review-source');const before=structuredClone(review.reviewBoard().doc);gate.resolve(structuredClone(sourceDocument));await settle();assert.deepEqual(review.reviewBoard().doc,before);await click('toggle-review-source');assert.equal(review.reviewBoard().node().comment,'Last idea');assert.match(host.querySelector('#solution-panel').innerHTML,/Last idea/);
 },
 async maintenance_cards_require_real_grade_instead_of_mastery_shortcut(){
  queue={cards:[{...card,maintenance:true,selection_reason:'maintenance',solutions:[['e2e4']]}]};await start({maintenanceEnabled:true});
  assert.equal(host.querySelector('#master-card').hidden,true);await click('master-card');assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,0);
  await review.reviewBoard().onMove('e2e4');assert.equal(grades().length,4);await grades()[2].onclick();assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
 },
 async daily_rejected_grade_refreshes_membership_and_recovers_after_failed_get(){
  const response={...paged([pagedCard(0),pagedCard(1)],null,2),mode:'daily',base_id:null,base_ids:[4],base:{id:null,name:'Séance du jour',settings:{}}};
  let refreshFails=true,gets=0;const original=globalThis.testApi;
  globalThis.testApi=async(url,options)=>{if(url.startsWith('/api/review-sessions/')){gets++;if(refreshFails)throw Error('Offline refresh');return {...response,cards:[pagedCard(1)],skipped:[0],skipped_unavailable:[0],skipped_completed:[],completed:0};}return original(url,options);};
  await review.startReview(host,response.base,{...options,preparedSession:response,sessionContextSupport:true});await review.reviewBoard().onMove('e2e4');
  gradeGate=Promise.reject(Object.assign(Error('Quota already filled'),{status:409}));await grades()[2].onclick();
  assert.match(host.querySelector('[data-retry-grade]').textContent,/Actualiser la séance et continuer/);assert.equal(review.snapshotReview().pendingAction.rejected,true);
  await host.querySelector('[data-retry-grade]').onclick();assert.equal(gets,1);assert.match(host.textContent,/Offline refresh/);assert.equal(review.snapshotReview().pendingAction.rejected,true);
  refreshFails=false;await host.querySelector('[data-retry-grade]').onclick();assert.equal(gets,2);assert.equal(review.snapshotReview().cards[0].session_index,1);assert.equal(review.snapshotReview().pendingAction,null);assert.equal(review.snapshotReview().completed,0);assert.match(host.textContent,/plus disponible/);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1,'a rejected request is never posted again');
  gradeGate=null;await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();assert.match(host.textContent,/1 exercice enregistré/);
 },
 async daily_rejected_grade_reload_skips_removed_card_without_posting_it(){
  const response={...paged([pagedCard(0),pagedCard(1)],null,2),mode:'daily',base_id:null,base_ids:[4],base:{id:null,name:'Séance du jour',settings:{}}};
  await review.startReview(host,response.base,{...options,preparedSession:response,sessionContextSupport:true});await review.reviewBoard().onMove('e2e4');gradeGate=Promise.reject(Object.assign(Error('Source deleted'),{status:404}));await grades()[2].onclick();
  const saved=review.reviewSnapshotData(review.snapshotReview());review.stopReview();
  const original=globalThis.testApi;globalThis.testApi=async(url,options)=>url.startsWith('/api/review-sessions/')?{...response,cards:[pagedCard(1)],skipped:[0],skipped_unavailable:[0],skipped_completed:[],completed:0}:original(url,options);
  const prepared=await review.prepareReviewResume(saved);assert.equal(prepared.pendingAction,null);assert.equal(prepared.attempt,null);assert.equal(prepared.skipped,1);
  await review.resumeReview(host,{...prepared,...options});assert.equal(review.snapshotReview().cards[0].session_index,1);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
 },
 async session_receipt_immediately_reconciles_completed_count_for_goals(){
  const response=paged([pagedCard(0),pagedCard(1),pagedCard(2)],null,3,{minutes:null,cards:2});
  await start({preparedSession:response,sessionSupport:true});await review.reviewBoard().onMove('e2e4');gradeGate=Promise.resolve({session_completed:2});await grades()[2].onclick();
  assert.equal(review.snapshotReview().completed,2);assert.match(host.textContent,/Objectif de séance atteint/);
 },
 async daily_session_preserves_each_base_settings_context_and_receipts(){
  const first={...pagedCard(0),base_id:4,base_name:'Tactique originale',settings:{mode:'automatic'},selection_reason:'personal_error'};
  const second={...pagedCard(1),base_id:9,base_name:'Finales originales',settings:{mode:'manual'},selection_reason:'maintenance',maintenance:true};
  const response={...paged([first,second],null,2),mode:'daily',base_id:null,base_ids:[4,9],base:{id:null,name:'Séance du jour',settings:{}}};
  let settingCard,paused;
  await review.startReview(host,response.base,{...options,preparedSession:response,sessionSupport:true,sessionContextSupport:true,maintenanceEnabled:true,onSettings:card=>settingCard=card,onPause:()=>paused=review.suspendReview({assisted:false})});
  assert.match(host.textContent,/Tactique originale · Erreurs personnelles/);assert.equal(calls.some(call=>call.url.includes('/queue')),false);
  await click('session-settings');assert.equal(settingCard.base_id,4);
  await review.reviewBoard().onMove('e2e4');assert.equal(grades().length,1);await grades()[0].onclick();
  const receipt=calls.find(call=>call.url.endsWith('/grade')).options.body;assert.equal(receipt.session_id,response.session_id);assert.equal(receipt.session_index,0);
  assert.match(host.textContent,/Finales originales · Entretien des acquis/);assert.match(host.querySelector('#master-card').getAttribute('title'),/rappels d’entretien/);
  await click('session-settings');assert.equal(settingCard.base_id,9);
  await review.reviewBoard().onMove('e2e4');assert.equal(grades().length,4);
  await click('session-pause');assert.equal(paused.mode,'daily');assert.equal(paused.base.id,null);assert.deepEqual(paused.base.settings,{});assert.deepEqual(paused.base_ids,[4,9]);
  assert.doesNotThrow(()=>review.reviewSnapshotData(paused));
 },
 async daily_resume_reconciles_server_answers_without_cross_base_settings(){
  const first={...pagedCard(0),base_id:4,base_name:'First',settings:{mode:'automatic'},selection_reason:'due'};
  const second={...pagedCard(1),base_id:9,base_name:'Second',settings:{mode:'manual'},selection_reason:'maintenance'};
  const response={...paged([first,second],null,2),mode:'daily',base_id:null,base_ids:[4,9],base:{id:null,name:'Séance du jour',settings:{}}};
  await review.startReview(host,response.base,{...options,preparedSession:response});await review.reviewBoard().onMove('e2e4');
  const saved=review.reviewSnapshotData(review.suspendReview({assisted:false}));
  const original=globalThis.testApi;globalThis.testApi=(url,options)=>url.startsWith('/api/review-sessions/')?Promise.resolve({...response,cards:[second],completed:1,elapsed_ms:4500,skipped:[0],skipped_completed:[0],skipped_unavailable:[]}):original(url,options);
  const prepared=await review.prepareReviewResume(saved);assert.equal(prepared.completed,1);assert.equal(prepared.sessionElapsedMs,4500);assert.equal(prepared.attempt,null);assert.deepEqual(prepared.base.settings,{});assert.match(prepared.resumeMessage,/déjà traités/);assert.doesNotMatch(prepared.resumeMessage,/Aucune note enregistrée/);
  await review.resumeReview(host,{...prepared,...options});assert.equal(review.snapshotReview().attempt.settings.mode,'manual');assert.match(host.textContent,/Second/);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },
 async hidden_tab_time_is_excluded_and_visibility_listener_is_disposed(){
  let clock=1000;Date.now=()=>clock;const listeners=new Set();globalThis.document={hidden:false,addEventListener:(event,fn)=>listeners.add(fn),removeEventListener:(event,fn)=>listeners.delete(fn)};
  queue={cards:[{...card,solutions:[['e2e4']]}]};await start();assert.equal(listeners.size,1);
  clock=2000;document.hidden=true;listeners.forEach(fn=>fn());clock=62000;assert.equal(review.snapshotReview().attempt.elapsedMs,1000);
  document.hidden=false;listeners.forEach(fn=>fn());clock=62500;await review.reviewBoard().onMove('e2e4');
  assert.equal(review.snapshotReview().attempt.completion.elapsedMs,1500);await grades()[2].onclick();assert.equal(calls.find(call=>call.url.endsWith('/grade')).options.body.elapsed_ms,1500);assert.equal(listeners.size,0);
 },
 async whole_game_requires_both_sides_and_only_one_final_grade(){
  queue={cards:[{...card,type:'game',path:'',solutions:[['e2e4','e7e5','g1f3']]}]};
  const original=globalThis.testApi;globalThis.testApi=(url,options)=>url.endsWith('/source')?structuredClone(sourceDocument):original(url,options);
  await start();const board=review.reviewBoard();
  assert.ok(!host.textContent.includes('First move idea'));
  await board.onMove('e2e4');assert.equal(board.path,'0');assert.equal(review.snapshotReview().attempt.ply,1);
  assert.match(host.textContent,/First move idea/);assert.ok(!host.textContent.includes('Reply idea'));
  assert.equal(host.querySelector('#grade-panel').hidden,true);
  await board.onMove('d7d5');assert.equal(review.snapshotReview().attempt.errors,1);assert.equal(board.path,'0');
  await board.onMove('e7e5');assert.equal(board.path,'0.0');assert.equal(host.querySelector('#grade-panel').hidden,true);
  await board.onMove('g1f3');assert.equal(host.querySelector('#grade-panel').hidden,false);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
  await grades()[2].onclick();assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
 },
 async opening_source_toggle_preserves_attempt_grade_and_detached_document(){
  queue={cards:[{...card,type:'moves',path:'0.0',solutions:[['g1f3']]}]};
  const original=globalThis.testApi;globalThis.testApi=(url,options)=>url.endsWith('/source')?structuredClone(sourceDocument):original(url,options);
  await start();let before=review.snapshotReview();const board=review.reviewBoard();
  await click('toggle-review-source');assert.equal(board.training,false);assert.equal(board.doc.nodes.length,5);
  assert.equal(board.path,'0.0');assert.equal(host.querySelector('#reveal-answer').disabled,true);
  await board.go('1');await board.onMove('e7e5');assert.equal(board.doc.nodes.length,5);
  board.gameOver=true;board.result='1-0';review.reviewAssistance();
  const during=review.snapshotReview();assert.equal(during.attempt.gameOver,before.attempt.gameOver);assert.equal(during.attempt.result,before.attempt.result);assert.deepEqual(during.attempt.doc,before.attempt.doc);assert.equal(during.attempt.path,before.attempt.path);
  assert.equal(during.attempt.errors,0);assert.equal(during.attempt.hints,0);assert.equal(during.attempt.assisted,false);
  await click('toggle-review-source');assert.equal(board.training,true);assert.equal(board.path,'');assert.equal(board.doc.nodes.length,1);
  await board.onMove('g1f3');assert.equal(host.querySelector('#grade-panel').hidden,false);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },
 async complete_game_resume_does_not_autoplay_black(){
  queue={cards:[{...card,type:'game',path:'',solutions:[['e2e4','e7e5','g1f3']]}]};
  const original=globalThis.testApi;globalThis.testApi=(url,options)=>url.endsWith('/source')?structuredClone(sourceDocument):original(url,options);
  await start();await review.reviewBoard().onMove('e2e4');
  const saved=review.suspendReview({assisted:false});await review.resumeReview(host,await review.prepareReviewResume(saved));
  assert.equal(review.reviewBoard().path,'0');assert.equal(review.snapshotReview().attempt.ply,1);
  await review.reviewBoard().onMove('e7e5');assert.equal(review.snapshotReview().attempt.ply,2);
 },
 async paged_grade_success_survives_next_batch_failure_without_regrading(){
  let fails=true;pagedApi(paged([pagedCard(0)],1,2),async()=>{if(fails)throw Error('Offline');return paged([pagedCard(1)],null,2);});
  await start({sessionSupport:true});await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();
  assert.match(host.textContent,/suite de la séance/);const saved=review.snapshotReview();assert.equal(saved.completed,1);assert.equal(saved.pendingAction,undefined);
  assert.equal(calls.filter(c=>c.url.endsWith('/grade')).length,1);
  fails=false;await host.querySelector('[data-batch-retry]').onclick();await settle();
  assert.match(host.textContent,/2 \/ 2/);assert.equal(review.snapshotReview().completed,1);
  await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();assert.match(host.textContent,/2 exercices enregistrés/);
  assert.equal(calls.filter(c=>c.url.endsWith('/grade')).length,2);
 },
 async paged_suspend_during_fetch_prevents_late_overwrite_and_resumes_next_index(){
  const gate=deferred();let waiting=true;pagedApi(paged([pagedCard(0)],1,2),()=>waiting?gate.promise:paged([pagedCard(1)],null,2));
  await start({sessionSupport:true});await review.reviewBoard().onMove('e2e4');const grading=grades()[2].onclick();await settle();
  const saved=review.suspendReview({assisted:false});assert.ok(saved);assert.equal(saved.completed,1);assert.equal(review.reviewBoard(),null);
  host.innerHTML='<p>Another page</p>';gate.resolve(paged([pagedCard(1)],null,2));await grading;assert.equal(host.textContent,'Another page');
  waiting=false;await review.resumeReview(host,{...await review.prepareReviewResume(saved),...options});
  assert.match(host.textContent,/2 \/ 2/);assert.equal(review.snapshotReview().completed,1);
 },
 async paged_empty_skipped_batches_finish_without_losing_completed_count(){
  pagedApi(paged([pagedCard(0)],1,4),url=>url.includes('offset=1&')?{...paged([],3,4),skipped:[1,2]}:{...paged([],null,4),skipped:[3]});
  await start({sessionSupport:true});await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();
  assert.match(host.textContent,/1 exercice enregistré/);const snapshot=review.snapshotReview();assert.equal(snapshot.skipped,3);assert.ok(review.reviewSessionFinished(snapshot));
  assert.equal(calls.filter(c=>c.url.includes('/api/review-sessions/')).length,2);
 },
 async paged_resume_fetches_current_global_offset_and_preserves_attempt(){
  pagedApi(paged([pagedCard(0),pagedCard(1),pagedCard(2)],3,6),url=>{assert.match(url,/offset=1&/);return paged([pagedCard(1),pagedCard(2),pagedCard(3)],4,6);});
  await start({sessionSupport:true});await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();await review.reviewBoard().onMove('e2e4');
  const saved=review.suspendReview({assisted:false}),prepared=await review.prepareReviewResume(saved);
  assert.equal(prepared.index,0);assert.equal(prepared.cards[0].session_index,1);assert.equal(prepared.completed,1);
  await review.resumeReview(host,{...prepared,...options});assert.match(host.textContent,/2 \/ 6/);assert.equal(review.reviewBoard().path,'0');
  assert.equal(calls.filter(c=>c.url.endsWith('/grade')).length,1,'resume never grades an attempt automatically');
 },
 async paged_card_and_time_goals_pause_then_continue_same_order(){
  let clock=1000;Date.now=()=>clock;const goal={cards:1,minutes:1};
  pagedApi(paged([pagedCard(0),pagedCard(1),pagedCard(2)],null,3,goal),()=>paged([pagedCard(1),pagedCard(2)],null,3,goal));
  await start({sessionSupport:true,goal});clock=62000;await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();
  assert.match(host.textContent,/Objectif de séance atteint/);assert.equal(review.reviewToolbarState().elapsedMs,61000);assert.equal(review.reviewToolbarState().canPause,false);const paused=review.suspendReview({assisted:false});assert.equal(paused.completed,1);assert.equal(paused.goalReached,true);
  await review.resumeReview(host,{...await review.prepareReviewResume(paused),...options});host.querySelector('[data-session-continue]').onclick();await settle();
  assert.match(host.textContent,/2 \/ 3/);assert.deepEqual(review.snapshotReview().goal,{minutes:null,cards:null});assert.equal(review.reviewToolbarState().targetMs,60000,'continuing preserves the original displayed target');assert.equal(review.reviewToolbarState().remainingMs,0);
  await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();assert.match(host.textContent,/3 \/ 3/);
  assert.equal(calls.filter(c=>c.url==='/api/review-sessions').length,1,'continuing retains the same durable order');
 },
 async paged_master_retry_freezes_duration_and_exact_payload(){
  let clock=1000;Date.now=()=>clock;pagedApi(paged([pagedCard(0),pagedCard(1)],null,2,{minutes:1,cards:null}),()=>{throw Error('Pending mastery must not reload the page');});
  await start({sessionSupport:true});clock=2000;masterGate=Promise.reject(Error('Lost acknowledgement'));await click('master-card');
  const saved=review.reviewSnapshotData(review.snapshotReview());assert.equal(saved.pendingAction.elapsedMs,1000);const body=structuredClone(saved.pendingAction.body);
  review.stopReview();clock=300000;masterGate=null;await review.resumeReview(host,{...await review.prepareReviewResume(saved),...options});await host.querySelector('[data-retry-grade]').onclick();
  assert.match(host.textContent,/2 \/ 2/);assert.doesNotMatch(host.textContent,/Objectif de séance atteint/);
  assert.equal(review.snapshotReview().sessionElapsedMs,1000);
  const requests=calls.filter(c=>c.url.endsWith('/master'));assert.equal(requests.length,2);assert.deepEqual(requests[1].options.body,body);
 },

 async english_review_preserves_original_comments_and_titles(){
  setLanguage('en');queue={cards:[{...card,title:'Révisions',comment:'Bien',solutions:[['e2e4']]}]};await start();assert.match(host.textContent,/Révisions/);assert.match(host.textContent,/Show answer/);await review.reviewBoard().onMove('e2e4');assert.match(host.textContent,/Success!/);assert.match(host.textContent,/Bien/,'the original PGN comment is not translated');assert.deepEqual(grades().map(button=>button.textContent),['Again','Hard','Good','Easy']);await grades()[2].onclick();assert.ok(host.textContent.includes(t('Séance terminée')));assert.match(host.textContent,/1 exercise saved in Mes exercices/);assert.equal(card.comment,'Explication secrète <script>');setLanguage('fr');
 },
 async definitive_grade_rejection_survives_reload_without_retrying(){
  for(const status of [400,404,409,422]){
   queue={cards:[{...card,solutions:[['e2e4']]}]};let closed=0;await start({onClose:()=>{closed++;review.stopReview();}});await review.reviewBoard().onMove('e2e4');
   const rejected=Object.assign(Error('Carte modifiée <script>'),{status});gradeGate=Promise.reject(rejected);await grades()[2].onclick();
   const saved=review.reviewSnapshotData(review.snapshotReview());assert.equal(saved.pendingAction.rejected,true);assert.match(host.textContent,/réponse n’a pas été acceptée/);assert.doesNotMatch(host.innerHTML,/<script>/);
   const before=calls.filter(call=>call.url.endsWith('/grade')).length;review.stopReview();await review.resumeReview(host,{...await review.prepareReviewResume(saved),...options,onClose:()=>{closed++;review.stopReview();}});
   assert.match(host.textContent,/Retour aux révisions/);assert.doesNotMatch(host.textContent,/Vérifier et continuer/);await host.querySelector('[data-retry-grade]').onclick();assert.equal(closed,1);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,before);gradeGate=null;
  }
 },
 async successful_grade_can_become_mastered_and_survives_pause(){
  const next={...card,id:'next',entry_id:13,solutions:[['e2e4']]};queue={cards:[{...card,solutions:[['e2e4']]},next]};await start();await review.reviewBoard().onMove('e2e4');gradeGate=Promise.resolve({state:'mastered',due:null,interval_days:181});await grades()[2].onclick();
  const snapshot=review.suspendReview();assert.equal(snapshot.mastered,1);assert.equal(snapshot.completed,1);queue={cards:[next]};await review.resumeReview(host,await review.prepareReviewResume(snapshot));gradeGate=null;await review.reviewBoard().onMove('e2e4');await grades()[2].onclick();assert.match(host.textContent,/1 exercice maîtrisé/);assert.match(host.textContent,/2 exercices enregistrés/);assert.match(host.textContent,/Les prochaines reprises sont planifiées/);assert.equal(calls.some(call=>call.url.endsWith('/master')),false);
 },
 async pending_grade_survives_reload_and_retries_exact_receipt_even_without_queue_card(){
  let clock=1000;Date.now=()=>clock;queue={cards:[{...card,solutions:[['e2e4']]}]};await start();await review.reviewBoard().onMove('e2e4');clock=2000;
  const gate=deferred();gradeGate=gate.promise;const sending=grades()[2].onclick();const saved=review.reviewSnapshotData(review.snapshotReview());assert.ok(saved.pendingAction);assert.doesNotThrow(()=>JSON.stringify(saved));assert.equal(review.suspendReview(),null);
  const original=structuredClone(saved.pendingAction.body);gate.reject(Error('Réponse perdue'));await sending;review.stopReview();clock=100000;queue={cards:[]};gradeGate=null;
  const prepared=await review.prepareReviewResume(saved);assert.equal(prepared.cards.length,1);await review.resumeReview(host,{...prepared,...options});await host.querySelector('[data-retry-grade]').onclick();
  const submitted=calls.filter(call=>call.url.endsWith('/grade'));assert.equal(submitted.length,2);assert.deepEqual(submitted[1].options.body,original);assert.match(host.textContent,/1 exercice enregistré/);
 },
 async durable_attempt_id_is_stable_across_resume_before_grading(){
  await start();const saved=review.reviewSnapshotData(review.snapshotReview());const id=saved.attempt.requestId;assert.match(id,/^[a-f0-9-]{36}$/);review.stopReview();await review.resumeReview(host,{...await review.prepareReviewResume(saved),...options});await click('reveal-answer');await grades()[0].onclick();assert.equal(calls.find(call=>call.url.endsWith('/grade')).options.body.request_id,id);
 },
 async old_server_uncertain_submission_is_not_sent_twice(){
  queue={cards:[{...card,content_key:undefined,solutions:[['e2e4']]}]};await start();await review.reviewBoard().onMove('e2e4');gradeGate=Promise.reject(Error('Réponse perdue'));await grades()[2].onclick();assert.match(host.textContent,/serveur actuel/);await host.querySelector('[data-retry-grade]').onclick();assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
 },

 async finished_exploration_accepts_both_sides_and_preserves_solution(){
  queue={cards:[{...card,solutions:[['e2e4']]}]};const original=structuredClone(queue.cards[0]);
  await start();const board=review.reviewBoard();assert.equal(host.querySelector('#return-solution').hidden,true);
  await board.onMove('e2e4');assert.equal(board.training,false);assert.equal(host.querySelector('#return-solution').hidden,false);
  await board.onMove('e7e5');await board.onMove('g1f3');assert.equal(board.path,'0.0.0','both colours can be moved after completion');
  await board.go('');await board.onMove('d2d4');assert.equal(board.path,'1');
  assert.deepEqual(board.doc.nodes[0].children,['0','1'],'alternatives remain distinct from the accepted solution');
  const count=board.doc.nodes.length;await board.go('');await board.onMove('e2e4');assert.equal(board.path,'0');assert.equal(board.doc.nodes.length,count,'replaying an existing move reuses it');
  await board.go('1');await click('return-solution');assert.equal(board.path,'0');assert.equal(board.doc.nodes.length,count,'returning to the answer preserves explored lines');
  assert.deepEqual(queue.cards[0],original);assert.equal(board.doc.id,undefined);
  assert.equal(calls.filter(call=>call.url==='/api/engine/play'||call.url.endsWith('/grade')||call.url.includes('/entries/')).length,0);
 },
 async exploration_freezes_grade_evidence_and_elapsed_time(){
  let clock=1000;Date.now=()=>clock;queue={cards:[{...card,solutions:[['e2e4']]}]};
  await start({onEditEntry:async()=>true});const board=review.reviewBoard();clock=2500;await board.onMove('e2e4');
  clock=100000;board.engineOn=true;board.onAssist();review.reviewAssistance();await click('analyse-position');
  await board.onMove('e7e5');await board.onMove('g1f3');
  assert.equal(host.querySelector('#attempt-status').dataset.state,'success');assert.match(host.querySelector('#attempt-status').textContent,/Réussi/);
  await grades()[2].onclick();const payload=calls.find(call=>call.url.endsWith('/grade')).options.body;
  assert.match(payload.request_id,/^[a-f0-9-]{36}$/);assert.equal(payload.content_key,card.content_key);const {request_id,content_key,...evidence}=payload;assert.deepEqual(evidence,{grade:2,errors:0,hints:0,assisted:false,elapsed_ms:1500,proposed_grade:2});
 },
 async revealed_exploration_retry_restores_training_and_attempt_evidence(){
  queue={cards:[{...card,solutions:[['e2e4']]}]};await start();const board=review.reviewBoard();
  await click('reveal-answer');assert.equal(board.training,false);await board.onMove('e7e5');board.onAssist();review.reviewAssistance();
  assert.equal(host.querySelector('#attempt-status').dataset.state,'revealed');
  await click('retry-card');assert.equal(board.training,true);assert.equal(board.doc.nodes.length,1);assert.equal(board.path,'');
  assert.equal(host.querySelector('#return-solution').hidden,true);assert.equal(host.querySelector('#grade-panel').hidden,true);
  await board.onMove('d2d4');assert.equal(board.doc.nodes.length,1,'new attempt validates answers again');
  await board.onMove('e2e4');await grades()[0].onclick();const payload=calls.find(call=>call.url.endsWith('/grade')).options.body;
  assert.equal(payload.errors,3,'revealing, retrying and the wrong new answer remain counted');assert.equal(payload.hints,1);assert.equal(payload.assisted,true);
 },
 async pending_exploration_serializes_grading_navigation_and_other_actions(){
  queue={cards:[{...card,solutions:[['e2e4']]}]};let edits=0;await start({onEditEntry:async()=>{edits++;return false;}});
  const board=review.reviewBoard();await board.onMove('e2e4');const gate=deferred();globalThis.moveGate=gate.promise;
  const moving=board.onMove('e7e5');await settle();assert.equal(board.renderedLocked,true);assert.ok(grades().every(button=>button.disabled));
  for(const id of ['return-solution','retry-card','analyse-position','master-card'])assert.equal(host.querySelector('#'+id).disabled,true,id);
  const before=JSON.stringify(board.doc);await grades()[2].onclick();await click('return-solution');await click('retry-card');await click('master-card');await click('analyse-position');await board.go('');await board.onMove('d7d5');
  assert.equal(JSON.stringify(board.doc),before);assert.equal(board.path,'0');assert.equal(edits,0);assert.equal(review.suspendReview(),null);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')||call.url.endsWith('/master')).length,0);
  gate.resolve();await moving;globalThis.moveGate=null;assert.equal(board.path,'0.0');assert.equal(board.renderedLocked,false);assert.ok(grades().every(button=>!button.disabled));
  await click('return-solution');assert.equal(board.path,'0');await grades()[2].onclick();assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
 },
 async exploration_suspend_resume_keeps_lines_without_changing_frozen_attempt(){
  let clock=100;Date.now=()=>clock;queue={cards:[{...card,solutions:[['e2e4']]}]};await start();const board=review.reviewBoard();
  clock=800;await board.onMove('e2e4');await board.onMove('e7e5');await board.onMove('g1f3');await board.go('');await board.onMove('d2d4');
  clock=10000;const snapshot=review.suspendReview();assert.equal(snapshot.attempt.completion.path,'0');assert.equal(snapshot.attempt.completion.doc.nodes.length,2);assert.equal(snapshot.attempt.completion.elapsedMs,700);
  assert.equal(snapshot.attempt.hints,0);assert.equal(snapshot.attempt.assisted,false);
  clock=20000;await review.resumeReview(host,await review.prepareReviewResume(snapshot));const resumed=review.reviewBoard();
  assert.equal(resumed.training,false);assert.equal(resumed.path,'1');assert.equal(resumed.doc.nodes.length,5);assert.equal(host.querySelector('#attempt-status').dataset.state,'success');
  await click('return-solution');assert.equal(resumed.path,'0');assert.equal(resumed.doc.nodes.length,5);
  await grades()[2].onclick();assert.equal(calls.find(call=>call.url.endsWith('/grade')).options.body.elapsed_ms,700);
 },
 async extended_solution_drops_exploration_and_resumes_from_accepted_endpoint(){
  queue={cards:[{...card,solutions:[['e2e4']]}]};await start();const board=review.reviewBoard();
  await board.onMove('e2e4');await board.onMove('e7e5');await board.onMove('b1c3');const snapshot=review.suspendReview();
  queue={cards:[{...card,solutions:[['e2e4','e7e5','g1f3']]}]};await review.resumeReview(host,await review.prepareReviewResume(snapshot));const resumed=review.reviewBoard();
  assert.equal(resumed.training,true);assert.equal(resumed.path,'0.0');assert.equal(resumed.doc.nodes.length,3);
  assert.equal(resumed.doc.nodes.some(node=>node.uci==='b1c3'),false);assert.equal(resumed.doc.nodes.some(node=>node.uci==='g1f3'),false,'future user answer remains concealed');
  assert.equal(host.querySelector('#grade-panel').hidden,true);assert.equal(host.querySelector('#return-solution').hidden,true);
  assert.match(host.querySelector('#review-resume-note').textContent,/prolongée/);await resumed.onMove('g1f3');assert.equal(resumed.training,false);await grades()[1].onclick();
  const payload=calls.find(call=>call.url.endsWith('/grade')).options.body;assert.equal(payload.errors,0);assert.equal(payload.hints,1);assert.equal(payload.assisted,true);
 },
 async finished_play_exploration_preserves_terminal_result_and_has_no_opponent(){
  queue={cards:[{...card,type:'play',settings:{...base.settings,side:'white',goal:'win'}}]};globalThis.terminalMove='e2e4';
  await start();const board=review.reviewBoard();await board.onMove('e2e4');assert.equal(board.training,false);assert.match(host.querySelector('#solution-panel').innerHTML,/1-0/);
  await board.go('');await board.onMove('d2d4');await board.onMove('d7d5');assert.equal(board.result,'*');assert.equal(board.gameOver,false);
  assert.equal(calls.filter(call=>call.url==='/api/engine/play').length,0,'finished play positions never launch an automatic opponent');
  const snapshot=review.suspendReview();assert.equal(snapshot.attempt.completion.result,'1-0');assert.equal(snapshot.attempt.completion.gameOver,true);
  await review.resumeReview(host,await review.prepareReviewResume(snapshot));assert.equal(review.reviewBoard().path,'1.0');assert.match(host.querySelector('#solution-panel').innerHTML,/1-0/);
  assert.equal(host.querySelector('#attempt-status').dataset.state,'success');await grades()[2].onclick();const payload=calls.find(call=>call.url.endsWith('/grade')).options.body;
  assert.equal(payload.errors,0);assert.equal(payload.hints,0);assert.equal(payload.proposed_grade,2);
 },
 async unassisted_navigation_pause_preserves_attempt_grade_and_active_time(){
  let clock=1000,stateChanges=0;Date.now=()=>clock;await start({onStateChange:()=>stateChanges++});const first=review.reviewBoard();
  await first.onMove('e2e4');clock=2000;const before=stateChanges,snapshot=review.suspendReview({assisted:false});
  assert.equal(snapshot.attempt.finished,false);assert.equal(snapshot.attempt.hints,0);assert.equal(snapshot.attempt.assisted,false);assert.equal(snapshot.attempt.elapsedMs,1000);
  assert.equal(first.disposed,true);assert.ok(stateChanges>before,'header state is refreshed when the session is paused');
  clock=1000000;await review.resumeReview(host,await review.prepareReviewResume(snapshot));const resumed=review.reviewBoard();
  assert.equal(resumed.path,'0.0');assert.equal(resumed.training,true);assert.equal(host.querySelector('#attempt-status').hidden,true);
  clock+=250;await resumed.onMove('g1f3');await grades()[2].onclick();const payload=calls.find(call=>call.url.endsWith('/grade')).options.body;
  assert.match(payload.request_id,/^[a-f0-9-]{36}$/);const {request_id,content_key,...evidence}=payload;assert.deepEqual(evidence,{grade:2,errors:0,hints:0,assisted:false,elapsed_ms:1250,proposed_grade:2});
 },
 async next_card_clears_exploration_and_restores_concealed_training(){
  queue={cards:[{...card,solutions:[['e2e4']]},{...card,id:'next',entry_id:13}]};await start();const first=review.reviewBoard();
  await first.onMove('e2e4');await first.onMove('e7e5');first.engineOn=true;first.onAssist();await grades()[2].onclick();
  const next=review.reviewBoard();assert.notEqual(next,first);assert.equal(first.disposed,true);assert.equal(next.training,true);assert.equal(next.doc.nodes.length,1);assert.equal(next.engineOn,false);
  assert.equal(host.querySelector('#return-solution').hidden,true);assert.equal(host.querySelector('#attempt-status').hidden,true);assert.equal(host.querySelector('#solution-panel').hidden,true);
  await next.onMove('d7d5');assert.equal(next.doc.nodes.length,1,'next card still rejects a wrong move');
  const snapshot=review.suspendReview();assert.equal(snapshot.attempt.completion,null);assert.equal(snapshot.attempt.errors,1);
 },
 async encounter_probability_is_visible_without_revealing_answers(){
  card.encounter_probability=.01;await start();
  assert.match(host.querySelector('.review-frequency').textContent,/1 %/);
  assert.match(host.querySelector('.review-frequency').textContent,/1 sur 100/);
  assert.equal(host.querySelector('#solution-panel').hidden,true);assert.equal(review.reviewBoard().doc.nodes.length,1);
  review.stopReview();delete card.encounter_probability;await start();assert.equal(host.querySelector('.review-frequency'),null);
 },
 async concealed_answers_and_shared_notation(){
  await start();const board=review.reviewBoard();
  assert.equal(board.engineOn,false);assert.equal(board.training,true);
  assert.equal(board.engineHost,host.querySelector('#review-engine'));assert.ok(host.classList.contains('review-page'));
  assert.equal(board.doc.id,undefined);assert.equal(board.doc.nodes.length,1);
  assert.ok(!host.querySelector('#review-moves').innerHTML.includes('e4'));
  assert.ok(!host.querySelector('#solution-panel').innerHTML.includes('Explication'));
  assert.equal(host.querySelector('#solution-panel').hidden,true);
  await board.onMove('a2a3');assert.equal(board.doc.nodes.length,1);
  await board.onMove('e2e4');assert.equal(board.doc.nodes.length,3);
  assert.match(host.querySelector('#review-moves').innerHTML,/analysis-move-row/);
  assert.ok(!host.querySelector('#review-moves').innerHTML.includes('Nf3'));
  assert.ok(host.querySelectorAll('#review-moves [data-path]').every(button=>button.disabled));
  assert.equal(board.renderedLocked,false,'accepted move releases rendered squares');
  await board.onMove('g1f3');
  assert.equal(host.querySelector('#solution-panel').hidden,false);
  assert.match(host.querySelector('#solution-panel').innerHTML,/Explication secrète &lt;script&gt;/);
  assert.equal(grades().length,4);
  const first=host.querySelectorAll('#review-moves [data-path]')[0];assert.equal(first.disabled,false);
  await first.onclick();assert.equal(board.path,'0','completed notation is navigable');
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0,'completion itself does not submit a grade');
 },
 async editor_receives_source_card_and_serializes_opening(){
  const opened=deferred(),seen=[];
  await start({onEditEntry:async source=>{seen.push(source);return opened.promise;}});
  const board=review.reviewBoard(),before=structuredClone(board.doc);
  const task=click('analyse-position');await click('analyse-position');
  assert.equal(seen.length,1);assert.equal(seen[0],card);
  assert.equal(seen[0].entry_id,12);assert.equal(seen[0].path,'0.1');
  assert.equal(host.querySelector('#analyse-position').disabled,true);assert.equal(board.renderedLocked,true);
  opened.resolve(false);await task;
  assert.equal(host.querySelector('#analyse-position').disabled,false);assert.equal(board.renderedLocked,false);
  assert.deepEqual(board.doc,before);assert.equal(host.querySelector('#attempt-status').hidden,true);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },
 async editor_failure_and_late_resolution_preserve_sessions(){
  await start({onEditEntry:async()=>{throw Error('Source indisponible');}});
  const board=review.reviewBoard();await click('analyse-position');
  assert.equal(errors.length,1);assert.equal(review.reviewBoard(),board);assert.equal(board.renderedLocked,false);
  const gate=deferred();await start({onEditEntry:()=>gate.promise});
  const opening=click('analyse-position');review.stopReview();
  host.innerHTML='<p>Autre page</p>';gate.resolve(true);await opening;
  assert.equal(host.innerHTML,'<p>Autre page</p>');assert.equal(review.reviewBoard(),null);
  assert.equal(host.classList.contains('review-page'),false);
 },
 async stale_queue_cannot_replace_new_page(){
  const gate=deferred();queueGate=gate.promise;const pending=start();
  review.stopReview();host.innerHTML='<p>Analyse actuelle</p>';
  gate.resolve(queue);await pending;
  assert.equal(host.innerHTML,'<p>Analyse actuelle</p>');assert.equal(boards.length,0);
 },
 async stale_queue_error_does_not_refresh_another_page(){
  const gate=deferred();queueGate=gate.promise;const pending=start();review.stopReview();host.innerHTML='<p>Nouvelle analyse</p>';gate.reject(Error('Ancienne requête'));await pending;assert.equal(host.innerHTML,'<p>Nouvelle analyse</p>');assert.equal(errors.length,0);
 },
 async retry_preserves_difficulty_and_releases_controls(){
  await start();const board=review.reviewBoard();
  await board.onMove('a2a3');await board.onMove('e2e4');await board.onMove('g1f3');
  assert.equal(host.querySelector('#grade-panel').hidden,false);
  board.engineOn=true;board.onAssist();
  await click('retry-card');
  assert.equal(board.doc.nodes.length,1);assert.equal(board.renderedLocked,false);
  assert.equal(host.querySelector('#grade-panel').hidden,true);
  assert.equal(host.querySelector('#solution-panel').hidden,true);
  assert.match(host.querySelector('#attempt-status').innerHTML,/2 erreurs/);
  assert.match(host.querySelector('#attempt-status').innerHTML,/Assistée/);
  assert.equal(host.querySelector('#reveal-answer').disabled,false);
  await board.onMove('d2d4');await board.onMove('c2c4');await grades()[0].onclick();
  const graded=calls.find(call=>call.url.endsWith('/grade'));
  assert.equal(graded.options.body.grade,0);assert.equal(graded.options.body.errors,2);assert.equal(graded.options.body.assisted,true);
  assert.equal(review.reviewBoard(),null);assert.equal(host.classList.contains('review-page'),false);
 },
 async reveal_and_automatic_grade_keep_attempt_evidence(){
  base.settings.mode='automatic';await start();
  await click('reveal-answer');
  assert.equal(review.reviewBoard().doc.nodes.length,4);
  assert.equal(host.querySelector('#solution-panel').hidden,false);
  assert.equal(grades().length,1);assert.equal(grades()[0].dataset.grade,'0');
  await grades()[0].onclick();
  const graded=calls.find(call=>call.url.endsWith('/grade'));
  assert.equal(graded.options.body.grade,0);assert.equal(graded.options.body.hints,1);assert.equal(graded.options.body.errors,1);assert.equal(graded.options.body.assisted,true);
 },
 async late_move_cannot_write_after_stop(){
  const gate=deferred();globalThis.moveGate=gate.promise;await start();
  const board=review.reviewBoard(),attempt=board.onMove('e2e4');
  assert.equal(board.renderedLocked,true);review.stopReview();host.innerHTML='<p>Bibliothèque</p>';
  gate.resolve();await attempt;
  assert.equal(host.innerHTML,'<p>Bibliothèque</p>');assert.equal(board.disposed,true);assert.equal(board.doc.nodes.length,1);
 },
 async engine_play_uses_attempt_history_and_keeps_solution_hidden(){
  queue={cards:[{...card,type:'play',settings:{side:'white',goal:'convert'}}]};
  await start();const board=review.reviewBoard();await board.onMove('e2e4');
  const engine=calls.find(call=>call.url==='/api/engine/play');
  assert.equal(engine.options.body.skill,6);assert.deepEqual(engine.options.body.history,['e2e4']);
  assert.equal(board.doc.nodes.length,3);assert.equal(board.renderedLocked,false);
  assert.equal(host.querySelector('#solution-panel').hidden,true);
  await click('finish-play');await click('goal-yes');await grades()[2].onclick();
  assert.equal(calls.find(call=>call.url.endsWith('/grade')).options.body.grade,2);
 },
 async late_engine_cannot_replace_next_screen(){
  queue={cards:[{...card,type:'play',settings:{side:'black'}}]};
  const gate=deferred();engineGate=gate.promise;const pending=start();await settle();
  const board=review.reviewBoard();assert.ok(board);
  review.stopReview();host.innerHTML='<p>Accueil</p>';gate.resolve({uci:'e2e4',game_over:false});await pending;
  assert.equal(host.innerHTML,'<p>Accueil</p>');assert.equal(board.disposed,true);assert.equal(board.doc.nodes.length,1);
 },
 async terminal_play_and_failed_grade_remain_usable(){
  queue={cards:[{...card,type:'play',settings:{side:'white',goal:'win'}}]};
  globalThis.terminalMove='e2e4';await start();const board=review.reviewBoard();await board.onMove('e2e4');
  assert.equal(host.querySelector('#solution-panel').hidden,false);assert.equal(grades().length,4);
  const gate=deferred();gradeGate=gate.promise;const pending=grades()[2].onclick();await settle();
  assert.ok(grades().every(button=>button.disabled));
  gate.reject(Error('Sauvegarde indisponible'));await pending;
  assert.equal(errors.length,1);assert.ok(grades().every(button=>!button.disabled));
  assert.equal(host.querySelector('#analyse-position').disabled,true);assert.equal(board.renderedLocked,true);assert.ok(host.querySelector('[data-retry-grade]'));gradeGate=null;await host.querySelector('[data-retry-grade]').onclick();assert.match(host.textContent,/1 exercice enregistré/);
 },
 async completed_card_advances_with_clean_board(){
  queue={cards:[card,{...card,id:'card-next',entry_id:13,title:'Deuxième exercice'}]};
  await start();const first=review.reviewBoard();await click('reveal-answer');await grades()[0].onclick();
  const second=review.reviewBoard();assert.notEqual(second,first);assert.equal(first.disposed,true);
  assert.equal(second.doc.nodes.length,1);assert.equal(second.engineOn,false);assert.equal(second.renderedLocked,false);
  assert.equal(host.querySelector('#solution-panel').hidden,true);assert.equal(host.querySelector('#attempt-status').hidden,true);
 },
 async status_preserves_board_owned_locks(){
  await start();const board=review.reviewBoard();board.inputLocked=true;board.renderBoard();board.onAssist();assert.equal(board.inputLocked,true,'status must not release Board-owned lock');assert.equal(board.renderedLocked,true);board.inputLocked=false;board.renderBoard();await click('reveal-answer');assert.equal(board.inputLocked,false);assert.equal(board.renderedLocked,false);
 },

 async resume_mid_solution_keeps_board_errors_time_and_updated_comments(){
  let clock=1000;Date.now=()=>clock;let snapshot;
  await start({onEditEntry:async()=>{snapshot=review.suspendReview();return true;}});
  const old=review.reviewBoard();await old.onMove('a2a3');await old.onMove('e2e4');clock=2200;
  await click('analyse-position');assert.ok(snapshot,'editing can suspend while opening');
  assert.equal(review.reviewBoard(),null);assert.equal(old.disposed,true);
  assert.equal(snapshot.attempt.elapsedMs,1200);assert.equal(snapshot.attempt.hints,1);
  old.doc.nodes[0].comment='mutation of disposed board';assert.equal(snapshot.attempt.doc.nodes[0].comment,'');
  const paused=structuredClone({...snapshot,onClose:null,onSettings:null,onEditEntry:null,onExploreLine:null});
  queue={cards:[{...card,title:'Titre corrigé',comment:'Nouvelle explication',solutions:[['e2e4','e7e5','g1f3']]}]};
  clock=900000;const prepared=await review.prepareReviewResume(snapshot);
  assert.equal(calls.filter(call=>call.url.endsWith('/queue?all=true')).length,1);
  assert.deepEqual({...snapshot,onClose:null,onSettings:null,onEditEntry:null,onExploreLine:null},paused,'preparation leaves paused session untouched');
  const requests=calls.length;await review.resumeReview(host,prepared);assert.equal(calls.length,requests,'resume mounts without a second queue fetch');
  const board=review.reviewBoard();assert.notEqual(board,old);assert.equal(board.path,'0.0');assert.equal(board.doc.nodes.length,3);
  assert.equal(board.renderedLocked,false);assert.match(host.textContent,/Titre corrigé/);
  assert.match(host.querySelector('#attempt-status').innerHTML,/1 erreur/);assert.match(host.querySelector('#attempt-status').innerHTML,/1 aide/);
  assert.ok(!host.querySelector('#review-moves').innerHTML.includes('Nf3'));assert.equal(host.querySelector('#solution-panel').hidden,true);
  clock+=300;await board.onMove('g1f3');assert.match(host.querySelector('#solution-panel').innerHTML,/Nouvelle explication/);
  await grades()[0].onclick();const graded=calls.find(call=>call.url.endsWith('/grade'));
  assert.equal(graded.options.body.elapsed_ms,1500,'editing and queue refresh time are excluded');assert.equal(graded.options.body.errors,1);assert.equal(graded.options.body.assisted,true);
 },
 async resume_preserves_original_queue_and_completed_count(){
  const next={...card,id:'next',entry_id:13,title:'Deuxième'},last={...card,id:'last',entry_id:14,title:'Troisième'};
  queue={cards:[card,next,last]};await start();await click('reveal-answer');await grades()[0].onclick();
  const snapshot=review.suspendReview();assert.equal(snapshot.completed,1);assert.equal(snapshot.index,1);
  queue={cards:[last,{...card,id:'new',entry_id:15},card,next]};
  const prepared=await review.prepareReviewResume(snapshot);assert.deepEqual(prepared.cards.map(c=>c.id),[card.id,'next','last']);
  await review.resumeReview(host,prepared);assert.match(host.textContent,/2 \/ 3/);assert.match(host.textContent,/Deuxième/);
  await click('reveal-answer');await grades()[0].onclick();assert.match(host.textContent,/Troisième/);
  await click('reveal-answer');await grades()[0].onclick();assert.match(host.textContent,/3 exercices enregistrés/);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,3);assert.equal(review.suspendReview(),null);
 },
 async changed_answer_restarts_only_current_exercise(){
  const next={...card,id:'next',entry_id:13};queue={cards:[card,next]};
  await start();await click('reveal-answer');await grades()[0].onclick();
  await review.reviewBoard().onMove('a2a3');await review.reviewBoard().onMove('e2e4');const snapshot=review.suspendReview();
  queue={cards:[card,{...next,solutions:[['d2d4','d7d5','c2c4']]}]};
  await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  const board=review.reviewBoard();assert.equal(board.doc.nodes.length,1);assert.match(host.textContent,/2 \/ 2/);
  assert.match(host.querySelector('#review-resume-note').textContent,/tentative actuelle reprend/);
  assert.match(host.querySelector('#attempt-status').innerHTML,/1 erreur/);assert.match(host.querySelector('#attempt-status').innerHTML,/1 aide/);
  assert.equal(host.querySelector('#grade-panel').hidden,true);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
  await board.onMove('d2d4');await board.onMove('c2c4');await grades()[0].onclick();assert.match(host.textContent,/2 exercices enregistrés/);
 },
 async changed_root_remaps_same_exercise_and_ambiguous_or_opening_cards_skip(){
  await start();await review.reviewBoard().onMove('e2e4');const snapshot=review.suspendReview();
  const updated={...card,id:'new-position',fen:fen.replace(' w ',' b ')};queue={cards:[updated]};
  const prepared=await review.prepareReviewResume(snapshot);assert.equal(prepared.cards[0].id,'new-position');
  await review.resumeReview(host,prepared);assert.equal(review.reviewBoard().node().fen,updated.fen);assert.equal(review.reviewBoard().doc.nodes.length,1);
  assert.match(host.querySelector('#review-resume-note').textContent,/L’exercice a changé/);
  queue={cards:[updated,{...updated,id:'ambiguous'}]};const ambiguous=await review.prepareReviewResume(snapshot);assert.equal(ambiguous.cards.length,0,'ambiguous replacement is never guessed');
  queue={cards:[{...card,type:'moves'}]};await start();const opening=review.suspendReview();queue={cards:[{...updated,type:'moves'}]};
  const removed=await review.prepareReviewResume(opening);assert.equal(removed.cards.length,0,'opening positions do not remap by entry');
 },
 async removed_exercises_skip_without_grades_and_failed_refresh_keeps_pause(){
  const next={...card,id:'next',entry_id:13};queue={cards:[card,next]};await start();const snapshot=review.suspendReview();
  queue={cards:[next]};let prepared=await review.prepareReviewResume(snapshot);await review.resumeReview(host,prepared);
  assert.match(host.querySelector('#review-resume-note').textContent,/1 exercice retiré/);assert.equal(review.reviewBoard().doc.nodes.length,1);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
  const paused=review.suspendReview(),before=JSON.stringify(paused);const gate=deferred();queueGate=gate.promise;
  const pending=review.prepareReviewResume(paused);gate.reject(Error('Connexion interrompue'));await assert.rejects(pending,/Connexion/);
  assert.equal(JSON.stringify(paused),before);queueGate=null;queue={cards:[]};prepared=await review.prepareReviewResume(paused);
  await review.resumeReview(host,prepared);assert.equal(review.reviewBoard(),null);assert.match(host.textContent,/Séance terminée/);assert.match(host.textContent,/0 exercice enregistré/);assert.match(host.textContent,/Aucune note enregistrée/);
 },
 async finished_attempt_keeps_selected_position_and_never_regrades_implicitly(){
  await start();await review.reviewBoard().onMove('e2e4');await review.reviewBoard().onMove('g1f3');await review.reviewBoard().go('0');
  const snapshot=review.suspendReview();assert.equal(snapshot.attempt.finished,true);assert.equal(snapshot.attempt.hints,0);
  queue={cards:[{...card,comment:'Explication corrigée'}]};await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  assert.equal(review.reviewBoard().path,'0');assert.equal(grades().length,4);assert.match(host.querySelector('#solution-panel').innerHTML,/Explication corrigée/);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
  const gate=deferred();gradeGate=gate.promise;const button=grades()[2],pending=button.onclick();await button.onclick();
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);gate.resolve({});await pending;
 },
 async extended_solution_continues_opponent_reply_without_leaking_user_answer(){
  queue={cards:[{...card,solutions:[['e2e4']]}]};await start();await review.reviewBoard().onMove('e2e4');
  const snapshot=review.suspendReview();queue={cards:[{...card,solutions:[['e2e4','e7e5','g1f3']]}]};
  await review.resumeReview(host,await review.prepareReviewResume(snapshot));const board=review.reviewBoard();
  assert.equal(board.path,'0.0');assert.equal(board.doc.nodes.length,3);assert.equal(board.renderedLocked,false);
  assert.equal(host.querySelector('#grade-panel').hidden,true);assert.equal(host.querySelector('#solution-panel').hidden,true);
  assert.ok(!host.querySelector('#review-moves').innerHTML.includes('Nf3'));assert.match(host.querySelector('#attempt-status').innerHTML,/1 aide/);
  assert.match(host.querySelector('#review-resume-note').textContent,/prolongée/);
  await board.onMove('g1f3');assert.equal(grades().length,4);
 },
 async resumed_play_keeps_history_and_manual_assessment_states(){
  queue={cards:[{...card,type:'play',settings:{...base.settings,side:'white',goal:'convert'}}]};await start();await review.reviewBoard().onMove('e2e4');
  let snapshot=review.suspendReview();await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  await review.reviewBoard().onMove('g1f3');const engine=calls.filter(call=>call.url==='/api/engine/play').at(-1);
  assert.deepEqual(engine.options.body.history,['e2e4','e7e5','g1f3']);
  await click('finish-play');snapshot=review.suspendReview();await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  assert.equal(host.querySelector('#grade-panel').hidden,true);assert.ok(host.querySelector('#goal-yes'));
  await click('goal-yes');snapshot=review.suspendReview();await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  assert.equal(grades().length,4);assert.equal(host.querySelector('#goal-yes'),null);assert.match(host.querySelector('#attempt-status').innerHTML,/Terminé avec aide/);
  await grades()[2].onclick();assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
 },
 async resumed_terminal_play_and_retry_reset_only_play_state(){
  queue={cards:[{...card,type:'play',settings:{...base.settings,side:'white',goal:'win'}}]};globalThis.terminalMove='e2e4';
  await start();await review.reviewBoard().onMove('e2e4');let snapshot=review.suspendReview();
  await review.resumeReview(host,await review.prepareReviewResume(snapshot));assert.equal(review.reviewBoard().gameOver,true);assert.equal(grades().length,4);
  assert.match(host.querySelector('#solution-panel').innerHTML,/1-0/);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
  await click('retry-card');assert.equal(review.reviewBoard().gameOver,false);assert.equal(host.querySelector('#grade-panel').hidden,true);
  snapshot=review.suspendReview();await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  assert.equal(review.reviewBoard().doc.nodes.length,1);assert.equal(host.querySelector('#solution-panel').hidden,true);
  assert.match(host.querySelector('#attempt-status').innerHTML,/1 erreur/);assert.equal(host.querySelector('#finish-play').disabled,false);
 },
 async changed_play_settings_restart_attempt_and_preserve_evidence(){
  const play={...card,type:'play',settings:{side:'white',goal:'convert',skill:3}};queue={cards:[play]};
  await start();await review.reviewBoard().onMove('e2e4');const snapshot=review.suspendReview();
  queue={cards:[{...play,settings:{...play.settings,skill:12}}]};await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  assert.equal(review.reviewBoard().doc.nodes.length,1);assert.match(host.querySelector('#attempt-status').innerHTML,/1 aide/);
  assert.match(host.querySelector('#review-resume-note').textContent,/tentative actuelle reprend/);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },

 async finished_solution_changed_to_another_answer_restarts_as_assisted(){
  queue={cards:[{...card,solutions:[['e2e4']]}]};await start();await review.reviewBoard().onMove('e2e4');
  const snapshot=review.suspendReview();assert.equal(snapshot.attempt.assisted,false);
  queue={cards:[{...card,solutions:[['d2d4']]}]};await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  assert.equal(review.reviewBoard().doc.nodes.length,1);assert.equal(host.querySelector('#grade-panel').hidden,true);
  assert.match(host.querySelector('#attempt-status').innerHTML,/1 aide/);assert.match(host.querySelector('#attempt-status').innerHTML,/Assistée/);
  await review.reviewBoard().onMove('d2d4');await grades()[1].onclick();const grade=calls.find(call=>call.url.endsWith('/grade'));
  assert.equal(grade.options.body.assisted,true);assert.equal(grade.options.body.hints,1);
 },

 async mastery_available_for_all_types_and_modes_before_attempt(){
  for(const mode of ['manual','automatic','hybrid'])for(const type of ['moves','solve','play']){
   base.settings.mode=mode;queue={cards:[{...card,id:mode+'-'+type,type,settings:{side:'white'}}]};
   await start();const board=review.reviewBoard(),button=host.querySelector('#master-card');
   assert.equal(button.disabled,false);assert.match(button.attributes.title,/dans les appris, sans nouvelles révisions/);
   assert.equal(host.querySelector('#grade-panel').hidden,true);assert.equal(board.doc.nodes.length,1);
   await button.onclick();assert.equal(review.reviewBoard(),null);assert.equal(board.disposed,true);
   assert.match(host.textContent,/1 exercice enregistré/);assert.match(host.textContent,/1 exercice maîtrisé/);
   assert.ok(!host.textContent.includes('Les prochaines reprises sont planifiées'));
  }
  const masters=calls.filter(call=>call.url.endsWith('/master'));assert.equal(masters.length,9);
  assert.ok(masters.every(call=>call.options.method==='POST'));assert.ok(masters.every(call=>call.options.body.request_id&&call.options.body.content_key===card.content_key&&!('grade' in call.options.body)));
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0,'mastery does not manufacture a review grade');
 },
 async mastery_waits_for_save_and_serializes_double_clicks(){
  queue={cards:[card,{...card,id:'next',entry_id:13,title:'Deuxième exercice'}]};
  await start();const first=review.reviewBoard(),button=host.querySelector('#master-card'),gate=deferred();masterGate=gate.promise;
  const pending=button.onclick();await button.onclick();
  assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,1);assert.equal(review.reviewBoard(),first);
  assert.equal(button.disabled,true);assert.equal(button.textContent,'Enregistrement…');assert.equal(first.renderedLocked,true);
  assert.equal(host.querySelector('#analyse-position').disabled,true);assert.equal(host.querySelector('#retry-card').disabled,true);
  await first.onMove('e2e4');await click('reveal-answer');assert.equal(first.doc.nodes.length,1);
  assert.equal(review.suspendReview(),null,'pending save cannot be suspended as an unsaved attempt');
  gate.resolve({state:'mastered'});await pending;
  assert.notEqual(review.reviewBoard(),first);assert.equal(first.disposed,true);assert.match(host.textContent,/2 \/ 2/);
  assert.equal(host.querySelector('#master-card').disabled,false);assert.equal(host.querySelector('#master-card').textContent,'Maîtrisé');
  assert.equal(review.reviewBoard().doc.nodes.length,1);assert.equal(review.reviewBoard().renderedLocked,false);
 },
 async mastery_failure_preserves_attempt_and_allows_retry(){
  await start();const board=review.reviewBoard();await board.onMove('a2a3');await board.onMove('e2e4');
  const before=structuredClone(board.doc),gate=deferred();masterGate=gate.promise;const pending=click('master-card');
  gate.reject(Error('Maîtrise non enregistrée'));await pending;
  assert.equal(errors.length,1);assert.equal(review.reviewBoard(),board);assert.deepEqual(board.doc,before);assert.equal(board.path,'0.0');
  assert.match(host.textContent,/1 \/ 1/);assert.match(host.querySelector('#attempt-status').innerHTML,/1 erreur/);
  assert.equal(host.querySelector('#master-card').disabled,true);assert.equal(board.renderedLocked,true);assert.ok(host.querySelector('[data-retry-grade]'));
  const snapshot=review.suspendReview();assert.equal(snapshot.completed,0);assert.equal(snapshot.mastered,0);
  await review.resumeReview(host,await review.prepareReviewResume(snapshot));masterGate=null;await host.querySelector('[data-retry-grade]').onclick();
  assert.match(host.textContent,/1 exercice maîtrisé/);assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,2);
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },
 async stale_mastery_success_and_failure_cannot_replace_new_session(){
  await start();const gate=deferred();masterGate=gate.promise;const pending=click('master-card');
  review.stopReview();queue={cards:[{...card,id:'new-session',title:'Nouvelle séance'}]};masterGate=null;await start();
  const fresh=review.reviewBoard(),before=host.innerHTML;gate.resolve({state:'mastered'});await pending;
  assert.equal(review.reviewBoard(),fresh);assert.equal(host.innerHTML,before);
  const second=deferred();masterGate=second.promise;const failing=click('master-card');review.stopReview();
  host.innerHTML='<p>Bibliothèque</p>';second.reject(Error('Ancienne sauvegarde'));await failing;
  assert.equal(host.innerHTML,'<p>Bibliothèque</p>');assert.equal(errors.length,0);
 },
 async mastery_respects_opening_and_engine_locks(){
  const opened=deferred();await start({onEditEntry:()=>opened.promise});const opening=click('analyse-position');
  assert.equal(host.querySelector('#master-card').disabled,true);await click('master-card');
  assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,0);opened.resolve(false);await opening;
  queue={cards:[{...card,type:'play',settings:{side:'black'}}]};const engine=deferred();engineGate=engine.promise;
  const starting=start();await settle();assert.equal(host.querySelector('#master-card').disabled,true);await click('master-card');
  assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,0);
  engine.resolve({uci:'e2e4',game_over:false});await starting;
  assert.equal(host.querySelector('#master-card').disabled,false);await click('master-card');
  assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,1);
 },
 async mastery_and_grading_share_one_submission_lock(){
  base.settings.mode='automatic';await start();await click('reveal-answer');const gradeButton=grades()[0];
  const gate=deferred();gradeGate=gate.promise;const pending=gradeButton.onclick();await click('master-card');
  assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,0);gate.reject(Error('Réessayer'));await pending;
  await click('master-card');await gradeButton.onclick();assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,0);
  const original=calls.find(call=>call.url.endsWith('/grade')).options.body;gradeGate=null;await host.querySelector('[data-retry-grade]').onclick();assert.deepEqual(calls.filter(call=>call.url.endsWith('/grade'))[1].options.body,original);assert.match(host.textContent,/1 exercice enregistré/);
 },
 async mastery_count_survives_editing_pause_and_remaining_grades(){
  const next={...card,id:'next',entry_id:13};queue={cards:[card,next]};await start();await click('master-card');
  const snapshot=review.suspendReview();assert.equal(snapshot.completed,1);assert.equal(snapshot.mastered,1);
  queue={cards:[next]};await review.resumeReview(host,await review.prepareReviewResume(snapshot));
  assert.match(host.textContent,/2 \/ 2/);await click('reveal-answer');await grades()[0].onclick();
  assert.match(host.textContent,/2 exercices enregistrés/);assert.match(host.textContent,/1 exercice maîtrisé/);
  assert.match(host.textContent,/Les prochaines reprises sont planifiées/);
  assert.equal(calls.filter(call=>call.url.endsWith('/master')).length,1);assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,1);
 },
 async sizing_and_mobile_reserve(){
  assert.equal(review.reviewBoardSize({width:1200,height:700,toolbarHeight:36}),664);
  assert.equal(review.reviewBoardSize({width:1000,height:900,toolbarHeight:36}),648);
  assert.equal(review.reviewBoardSize({width:300,height:700,toolbarHeight:36}),0);
  const css=await readFile(new URL('../static/review.css',import.meta.url),'utf8');
  assert.match(css,/@media\(min-width:1000px\) and \(min-height:600px\)/);
  assert.equal(review.reviewMobileBoardSize({width:378,height:730,toolbarHeight:33}),378);
  assert.equal(review.reviewMobileBoardSize({width:378,height:540,toolbarHeight:33}),378);
  assert.equal(review.reviewMobileBoardSize({width:378,height:200,toolbarHeight:33}),378,'short screens keep the board full width and scroll to the panels');
  assert.equal(review.reviewMobileBoardSize({width:820,height:700,toolbarHeight:33}),820,'portrait has no legacy 650px cap');
  assert.equal(review.reviewMobileBoardSize({width:0}),0);
  assert.match(css,/height:calc\(100dvh - var\(--app-header-height\)\)/);
  assert.ok(!css.includes('padding-bottom:90px'));
  let resize;
  globalThis.ResizeObserver=class{constructor(callback){resize=callback;}observe(){}disconnect(){}};
  globalThis.window={addEventListener(){},removeEventListener(){}};
  let mode='2';
  globalThis.getComputedStyle=element=>({getPropertyValue:name=>element.classList.contains('review-workbench')?({'--review-fit':mode,'row-gap':'6','--review-mobile-panel-min':'218','--review-notebook-min':'280','column-gap':'6'}[name]||''):''});
  try{
   await start();const workspace=host.querySelector('.review-workbench');workspace.clientWidth=378;workspace.clientHeight=650;resize();
   assert.equal(workspace.style.getPropertyValue('--review-board-size'),'378px');
   workspace.clientHeight=200;resize();
   assert.equal(workspace.style.getPropertyValue('--review-board-size'),'378px','viewport height does not reduce the portrait square');
   workspace.clientWidth=820;workspace.clientHeight=320;mode='1';resize();
   assert.equal(workspace.style.getPropertyValue('--review-board-size'),'290px','rotating to landscape still fits the board beside the notebook');
   mode='2';workspace.clientWidth=378;resize();
   assert.equal(workspace.style.getPropertyValue('--review-board-size'),'378px','portrait restores full width after rotating');
  }finally{review.stopReview();delete globalThis.ResizeObserver;delete globalThis.window;delete globalThis.getComputedStyle;}
 },
 async compact_mobile_tabs_keep_attempt_and_completion_visible(){
  await start();const board=review.reviewBoard(),notebook=host.querySelector('.review-notebook');
  assert.ok(!host.textContent.includes('À toi de jouer sur l’échiquier'));
  assert.ok(!host.textContent.includes('0 erreurs'));
  assert.ok(!host.textContent.includes('Joue la solution jusqu’au bout'));
  assert.equal(host.querySelector('#attempt-status').hidden,true);
  const tab=name=>host.querySelector('[data-review-tab-button="'+name+'"]');
  tab('engine').onclick();assert.equal(notebook.dataset.reviewTab,'engine');assert.equal(board.engineOn,false,'opening engine panel does not reveal analysis or count assistance');
  tab('moves').onclick();assert.equal(notebook.dataset.reviewTab,'moves');
  assert.equal(tab('moves').attributes['aria-pressed'],'true');
  assert.equal(tab('engine').attributes['aria-pressed'],'false');
  await board.onMove('e2e4');await board.onMove('g1f3');
  assert.equal(notebook.dataset.reviewTab,'exercise','finishing returns to result and grading');
  assert.equal(host.querySelector('#attempt-status').dataset.state,'success');
  assert.match(host.querySelector('#attempt-status').textContent,/Réussi !/);
  assert.equal(host.querySelector('#grade-panel').parentElement,notebook,'grading stays outside scrolling explanation');
  assert.equal(calls.filter(call=>call.url.endsWith('/grade')).length,0);
 },
 async completion_distinguishes_error_assistance_and_reveal(){
  await start();let board=review.reviewBoard();await board.onMove('a2a3');await board.onMove('e2e4');await board.onMove('g1f3');
  assert.equal(host.querySelector('#attempt-status').dataset.state,'errors');assert.match(host.querySelector('#attempt-status').textContent,/Terminé avec erreurs/);
  await start();board=review.reviewBoard();board.onAssist();await board.onMove('e2e4');await board.onMove('g1f3');
  assert.equal(host.querySelector('#attempt-status').dataset.state,'assisted');assert.match(host.querySelector('#attempt-status').textContent,/Terminé avec aide/);
  await start();await click('reveal-answer');assert.equal(host.querySelector('#attempt-status').dataset.state,'revealed');assert.match(host.querySelector('#attempt-status').textContent,/Réponse affichée/);
  await click('retry-card');assert.equal(host.querySelector('#attempt-status').dataset.state,'');assert.equal(host.querySelector('#grade-panel').hidden,true);
 },
 async mobile_more_actions_preserve_edit_and_retry(){
  await start();const actions=host.querySelector('.review-actions');
  await click('review-more');assert.equal(actions.dataset.menuOpen,'true');assert.equal(host.querySelector('#review-more').attributes['aria-expanded'],'true');
  await click('retry-card');assert.equal(actions.dataset.menuOpen,'false');assert.equal(host.querySelector('#review-more').attributes['aria-expanded'],'false');
  await click('review-more');await click('analyse-position');assert.equal(actions.dataset.menuOpen,'false');
  assert.equal(review.reviewBoard().doc.nodes.length,1);
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario],'unknown scenario '+scenario);
await tests[scenario]();review.stopReview();console.log('ok '+scenario);
