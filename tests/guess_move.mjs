import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
class Element{
 constructor(tag='div',attributes={}){
  this.tagName=tag.toUpperCase();this.attributes=attributes;this.id=attributes.id||'';this.children=[];this.dataset={};this.hidden='hidden' in attributes;this.disabled='disabled' in attributes;this.scrollTop=0;
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
 get value(){if(Object.hasOwn(this,'_value'))return this._value;if(this.tagName==='SELECT'){const options=this.querySelectorAll('option');return (options.find(item=>'selected' in item.attributes)||options[0])?.attributes.value||'';}return this.attributes.value||'';}
 set value(value){this._value=String(value);}
 get elements(){return Object.fromEntries(this.querySelectorAll('[name]').map(element=>[element.attributes.name,element]));}
 set textContent(value){this._text=String(value);}
 get textContent(){return this._text??this.children.map(child=>child.textContent||'').join('');}
 addEventListener(name,callback){this['on'+name]=callback;}
 setAttribute(name,value){this.attributes[name]=String(value);}
 getAttribute(name){return this.attributes[name]??null;}
 removeAttribute(name){delete this.attributes[name];}
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
 constructor(host,options){Object.assign(this,{host,path:'',engineOn:false,disposed:false,inputLocked:false,busy:false,...options});globalThis.boards.push(this);host.innerHTML='<div class="board-player-band" data-board-clock="top"></div><div class="board-toolbar"></div><div class="board-player-band" data-board-clock="bottom"></div>';options.engineHost.innerHTML='<div class="engine-panel engine-docked"></div>';this.renderBoard();}
 node(){return this.doc.nodes.find(node=>node.path===this.path)||this.doc.nodes[0];}
 dispose(){this.disposed=true;}
 renderBoard(){this.renderedLocked=this.busy||this.inputLocked;this.renders=(this.renders||0)+1;this.renderClocks();}
 renderClocks(){for(const place of ['top','bottom']){const band=this.host.querySelector('[data-board-clock="'+place+'"]'),side=(place==='top')!==this.flipped?'black':'white';band.dataset.side=side;band.innerHTML=this.playerBandHtml?.(this,side)||'';}}
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
 async go(path){if(this.disposed||this.busy||this.inputLocked||!this.doc.nodes.some(node=>node.path===path))return;this.path=path;this.gameOver=globalThis.terminalMove===this.node().uci;this.result=this.gameOver?'1-0':'*';this.renderBoard();this.onChange?.(this);}
}
`;

registerHooks({load(url,context,nextLoad){
 if(url.endsWith('/static/training-history.js'))return {format:'module',shortCircuit:true,source:'export class TrainingHistoryView{constructor(host,options){}async load(){}dispose(){}};export const openTrainingHistory=async()=>({close(){}});'};
 if(url.endsWith('/static/training-statistics.js'))return {format:'module',shortCircuit:true,source:'export const openTrainingStatistics=options=>globalThis.openStatisticsDialog(options);'};
 if(url.endsWith('/static/training-settings.js'))return {format:'module',shortCircuit:true,source:'export const openTrainingSettings=options=>globalThis.openSettingsDialog(options);'};
 if(url.endsWith('/static/board.js'))return {format:'module',shortCircuit:true,source:boardSource};
 if(url.endsWith('/static/api.js'))return {format:'module',shortCircuit:true,source:`export const api=(...args)=>globalThis.testApi(...args);export const fail=error=>globalThis.errors.push(error);export const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';export const esc=(s='')=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');export const option=(v,label)=>'<option value="'+v+'">'+label+'</option>';`};
 return nextLoad(url,context);
}});
globalThis.boards=[];globalThis.errors=[];const calls=[];
const settingsDialogs=[],statisticsDialogs=[];
globalThis.openSettingsDialog=options=>{
 const form=new Element('form');form.innerHTML=options.html;
 const dialog={form,options,closed:false,close(){this.closed=true;},async save(values){await options.onSubmit(new Map(Object.entries(values)),form);this.close();}};
 options.onReady?.(form,dialog);settingsDialogs.push(dialog);return dialog;
};
globalThis.openStatisticsDialog=async options=>{const dialog={options,closed:false,close(){this.closed=true;}};statisticsDialogs.push(dialog);return dialog;};
const fen='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const doc={headers:{Result:'*'},nodes:[{path:'',parent:null,fen,children:[],comment:'',nags:[]}]};
const start={id:'session-one',entry_id:8,title:'Test game',side:'both',path:'',completed:false,awaiting_continue:false,pending:false,doc,score:0,maximum:0,exact_count:0,attempts:[],result:null};
const step=(uci,san)=>({uci,san,fen:fen.replace(' w ',' b '),game_over:false,result:'*'});
const proposal=step('d2d4','d4'),original=step('e2e4','e4'),best=step('g1f3','Nf3');
const result={score:10,exact:false,proposal_san:'d4',original_san:'e4',comment:'The original idea',proposal:{cp:20,positions:[proposal]},original:{cp:-80,positions:[original]},best:{cp:25,san:['Nf3'],positions:[best]}};
const answered={...start,score:10,maximum:10,awaiting_continue:true,result,attempts:[{id:1,path:'',uci:'d2d4',score:10,exact:0,elapsed_ms:1000,result}]};
const next={...answered,path:'0',awaiting_continue:false,result:null,doc:{headers:doc.headers,nodes:[{...doc.nodes[0],children:['0']},{...original,path:'0',parent:'',children:[],comment:'',nags:[]}]}};
let response=answered;
globalThis.testApi=async(url,options={})=>{calls.push({url,options});if(url.endsWith('/attempt'))return structuredClone(response);if(url.endsWith('/continue'))return structuredClone(next);if(url==='/api/guess-move/sessions')return structuredClone(start);if(url.endsWith('/source'))return next.doc;return structuredClone(start);};
const {GuessMoveView}=await import('../static/guess-move.js');
const {guessGameDetailsHtml,guessPlayerBandHtml}=await import('../static/guess-game-info.js');
const host=new Element('main'),view=new GuessMoveView(host);
const setup=()=>{view.session=structuredClone(start);view.renderSession();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const clockDoc=()=>({headers:{White:'Alexandre Martin',Black:'Sophie Bernard',WhiteElo:'2486',BlackElo:'2432',Event:'Tournoi de Montréal',Date:'2026.10.18',TimeControl:'300+3'},nodes:[
 {...structuredClone(doc.nodes[0]),children:['0']},
 {path:'0',parent:'',uci:'e2e4',san:'e4',fen:'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',clock:298,children:['0.0']},
 {path:'0.0',parent:'0',uci:'e7e5',san:'e5',fen:'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2',clock:291,children:['0.0.0']},
 {path:'0.0.0',parent:'0.0',uci:'g1f3',san:'Nf3',fen:'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2',clock:null,children:[]}
]});
const bandAt=place=>host.querySelector('[data-board-clock="'+place+'"]');
const clockAt=place=>bandAt(place).querySelector('.guess-player-clock-value')?.textContent;
const tests={
 async game_information_shows_players_ratings_event_and_date(){
  view.session={...structuredClone(start),side:'white',path:'0.0',doc:clockDoc()};view.renderSession();
  assert.match(host.querySelector('.guess-game-details').textContent,/Tournoi de Montréal/);
  assert.match(host.querySelector('.guess-game-details').textContent,/2026/);
  assert.match(host.querySelector('.guess-game-details').textContent,/18/);
  assert.equal(bandAt('top').querySelector('.guess-player-name').textContent,'Sophie Bernard');
  assert.match(bandAt('top').querySelector('.guess-player-rating').textContent,/2432/);
  assert.equal(bandAt('bottom').querySelector('.guess-player-name').textContent,'Alexandre Martin');
  assert.match(bandAt('bottom').querySelector('.guess-player-rating').textContent,/2486/);
  assert.equal(clockAt('top'),'4:51');assert.equal(clockAt('bottom'),'4:58');
  assert.match(bandAt('bottom').textContent,/Temps de la partie/);
 },
 async game_information_preserves_partial_dates_and_escapes_headers(){
  for(const [date,expected] of [['2024.??.??',/2024/],['2024.10.??',/2024/],['????.??.??',/2023/]]){
   const html=guessGameDetailsHtml({Event:'Open <script> & finale',Date:date,UTCDate:'2023.09.15'});
   assert.match(html,expected);assert.ok(!html.includes('??'));assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);assert.match(html,/&amp;/);
  }
  const details=new Element();details.innerHTML=guessGameDetailsHtml({Date:'2024.??.??',UTCDate:'2023.09.15'});assert.equal(details.querySelector('.guess-date').textContent,'2024');
  details.innerHTML=guessGameDetailsHtml({Date:'2024.10.??',UTCDate:'2023.09.15'});assert.match(details.querySelector('.guess-date').textContent,/octobre 2024/);assert.ok(!details.textContent.includes('15'));
  details.innerHTML=guessGameDetailsHtml({Date:'2025.02.30',UTCDate:'2023.09.15'});assert.match(details.querySelector('.guess-date').textContent,/15 septembre 2023/);
  const headers={White:'<img src=x onerror=alert(1)>',Black:'?',WhiteElo:'<b>2000</b>',BlackElo:'0',Event:'?',Date:'????.??.??'};
  const source={...structuredClone(doc),headers},board={doc:source,path:'',node(){return this.doc.nodes[0];}};
  const whiteHtml=guessPlayerBandHtml(board,'white',source),blackHtml=guessPlayerBandHtml(board,'black',source);
  assert.ok(!whiteHtml.includes('<img'));assert.match(whiteHtml,/&lt;img/);assert.ok(!whiteHtml.includes('guess-player-rating'));assert.ok(!blackHtml.includes('guess-player-rating'));assert.ok(!whiteHtml.includes('guess-player-clock'));
  assert.match(blackHtml,/Noirs/);assert.equal(guessGameDetailsHtml(headers),'');
  view.session={...structuredClone(start),doc:{...structuredClone(doc),headers:{White:'?',Black:'?',WhiteElo:'-',BlackElo:'0'}}};view.renderSession();
  assert.equal(bandAt('top').querySelector('.guess-player-name').textContent,'Noirs');assert.equal(bandAt('bottom').querySelector('.guess-player-name').textContent,'Blancs');assert.equal(host.querySelector('.guess-player-clock'),null);
 },
 async historical_clocks_follow_navigation_flip_and_annotation_gaps(){
  const source=clockDoc();view.session={...structuredClone(start),side:'black',completed:true,path:'0.0',doc:source};view.renderSession();
  assert.equal(bandAt('top').dataset.side,'white');assert.equal(clockAt('top'),'4:58');assert.equal(clockAt('bottom'),'4:51');
  await view.board.go('0');assert.equal(clockAt('top'),'4:58');assert.equal(clockAt('bottom'),'5:00');
  await view.board.go('0.0.0');assert.equal(clockAt('top'),undefined);assert.equal(clockAt('bottom'),'4:51');
  assert.equal(bandAt('top').querySelector('.guess-player-name').textContent,'Alexandre Martin');
  view.board.flipped=false;view.board.renderBoard();assert.equal(bandAt('bottom').dataset.side,'white');assert.equal(clockAt('bottom'),undefined);assert.equal(clockAt('top'),'4:51');
  source.nodes.at(-1).clock=0;view.board.doc.nodes.at(-1).clock=0;view.board.renderBoard();assert.equal(clockAt('bottom'),'0:00');
 },
 async historical_clocks_hide_during_preview_and_outside_the_source_line(){
  view.session={...structuredClone(start),completed:true,path:'0.0',doc:clockDoc()};view.renderSession();
  for(const property of ['preview','pendingMove']){
   view.board[property]={fen:'preview'};view.board.renderBoard();assert.equal(host.querySelector('.guess-player-clock'),null);assert.equal(host.querySelectorAll('.guess-player-name').length,2);view.board[property]=null;view.board.renderBoard();assert.equal(clockAt('bottom'),'4:58');
  }
  const current=view.board.node(),originalFen=current.fen,originalUci=current.uci;
  current.fen=fen;view.board.renderBoard();assert.equal(host.querySelector('.guess-player-clock'),null);current.fen=originalFen;
  current.uci='c7c5';view.board.renderBoard();assert.equal(host.querySelector('.guess-player-clock'),null);current.uci=originalUci;view.board.renderBoard();assert.equal(clockAt('top'),'4:51');
  await view.explore({positions:[{uci:'b1c3',san:'Nc3',fen:'rnbqkbnr/pppp1ppp/8/4p3/4P3/2N5/PPPP1PPP/R1BQKBNR b KQkq - 1 2'}]},'0.0');
  assert.equal(host.querySelector('.guess-player-clock'),null);assert.equal(host.querySelectorAll('.guess-player-rating').length,2);
  await view.board.go('0.0');assert.equal(clockAt('top'),'4:51');assert.equal(clockAt('bottom'),'4:58');
 },
 async conceals_then_scores_and_explores_without_source_mutation(){
  setup();assert.equal(view.board.training,true);assert.ok(!host.textContent.includes('original idea'));assert.equal(host.querySelector('[data-engine]').hidden,true);
  await view.board.onMove('d2d4');assert.equal(calls.filter(c=>c.url.endsWith('/attempt')).length,1);assert.match(host.textContent,/10\/10/);assert.match(host.textContent,/original idea/);
  assert.equal(view.board.training,false);assert.equal(host.querySelector('[data-engine]').hidden,false);
  await host.querySelector('[data-line="proposal"]').onclick();assert.equal(view.board.node().uci,'d2d4');
  assert.equal(view.session.doc.nodes.length,1);assert.ok(calls.every(c=>!c.url.startsWith('/api/entries')));
  await view.board.onMove('e7e5');assert.equal(calls.filter(c=>c.url.endsWith('/attempt')).length,1,'free exploration is not a scored attempt');
  await host.querySelector('[data-continue]').onclick();assert.equal(view.board.node().uci,'e2e4');assert.equal(view.board.training,true);assert.equal(view.session.score,10);
 },
 async pending_engine_locks_proposal_and_retry_uses_first_move(){
  view.session={...structuredClone(start),pending:true,attempts:[{id:1,path:'',uci:'d2d4',score:null,result:null,elapsed_ms:1000}]};view.renderSession();
  await view.board.onMove('e2e4');assert.equal(calls.length,0);await host.querySelector('[data-retry]').onclick();
  assert.equal(calls[0].options.body.uci,'d2d4');assert.equal(view.session.awaiting_continue,true);
 },
 async double_submission_and_late_response_cannot_overwrite_other_page(){
  setup();const gate=deferred();globalThis.testApi=(url,options)=>{calls.push({url,options});return gate.promise;};
  const pending=view.board.onMove('d2d4');await view.board.onMove('e2e4');assert.equal(calls.length,1);
  view.dispose();host.innerHTML='<p>Other page</p>';gate.resolve(answered);await pending;assert.equal(host.textContent,'Other page');
 },
 async first_move_persists_after_error_without_unlocked_second_chance(){
  setup();globalThis.testApi=async(url,options)=>{calls.push({url,options});if(url.endsWith('/attempt'))throw Error('Engine unavailable');return {...start,pending:true,attempts:[{id:1,path:'',uci:'d2d4',score:null,result:null,elapsed_ms:1000}]};};
  await view.board.onMove('d2d4');assert.equal(view.session.pending,true);assert.ok(host.querySelector('[data-retry]'));
  const count=calls.length;await view.board.onMove('e2e4');assert.equal(calls.length,count);
 },
 async failed_recovery_after_disposal_preserves_other_page(){
  setup();const recovery=deferred(),recovering=deferred();
  globalThis.testApi=async(url,options)=>{calls.push({url,options});if(url.endsWith('/attempt'))throw Error('Engine unavailable');recovering.resolve();return recovery.promise;};
  const pending=view.board.onMove('d2d4');await recovering.promise;
  view.dispose();host.innerHTML='<p>Other page</p>';recovery.reject(Error('Recovery unavailable'));
  await assert.doesNotReject(pending);assert.equal(host.textContent,'Other page');assert.equal(errors.length,1);
 },
 async failed_recovery_after_new_launch_preserves_selected_game(){
  setup();const recovery=deferred(),recovering=deferred();
  globalThis.testApi=async(url,options)=>{calls.push({url,options});if(url.endsWith('/attempt'))throw Error('Engine unavailable');recovering.resolve();return recovery.promise;};
  const pending=view.board.onMove('d2d4');await recovering.promise;
  await view.launch({entryId:9});const launchForm=host.querySelector('[data-guess-launch]'),content=host.textContent;
  recovery.reject(Error('Recovery unavailable'));await assert.doesNotReject(pending);
  assert.equal(view.disposed,false);assert.equal(view.session,null);assert.equal(host.querySelector('[data-guess-launch]'),launchForm);assert.equal(host.textContent,content);assert.equal(errors.length,1);
 },
 async complete_history_shows_summary_and_analysis_callback(){
  let opened;view.onAnalyse=payload=>{opened=payload;};view.session={...structuredClone(answered),completed:true,path:null,awaiting_continue:false,result:null,doc:next.doc};view.renderSession();
  assert.match(host.textContent,/Bonnes alternatives/);assert.match(host.textContent,/Coups originaux retrouvés/);
  await host.querySelector('[data-analysis]').onclick();assert.equal(opened.entryId,8);assert.equal(opened.doc.nodes.at(-1).uci,'e2e4');
  await host.querySelector('[data-attempt]').onclick();assert.match(host.textContent,/original idea/);
 },
 async launch_current_document_posts_detached_pgn_and_path(){
  await view.launch({doc:next.doc,path:'0',side:'black'});
  assert.equal(calls[0].options.body.path,'0');assert.equal(calls[0].options.body.side,'black');assert.match(calls[0].options.body.pgn,/e4/);assert.ok(!Object.hasOwn(calls[0].options.body,'entry_id'));
 },
 async settings_update_selected_game_defaults_without_starting_a_session(){
  await view.launch({entryId:8,path:'0'});let form=host.querySelector('[data-guess-launch]');
  assert.equal(form.elements.side.value,'white');assert.equal(form.elements.start.value,'current');
  view.showSettings();const canceled=settingsDialogs[0];assert.equal(canceled.form.elements.side.value,'white');canceled.form.elements.side.value='both';canceled.close();
  assert.equal(view.settings.side,'white');assert.equal(form.elements.side.value,'white');
  view.showSettings();await settingsDialogs[1].save({side:'black',start:'beginning'});
  assert.equal(form.elements.side.value,'black');assert.equal(form.elements.start.value,'beginning');assert.equal(calls.length,0);assert.equal(view.session,null);
  await form.onsubmit({preventDefault(){},currentTarget:form});
  assert.deepEqual(calls[0].options.body,{path:'',side:'black',entry_id:8});assert.equal(host.querySelector('[data-training-settings]').disabled,true);
 },
 async current_position_default_and_inline_override_preserve_selected_source(){
  view.applySettings({side:'both',start:'current'});await view.launch({doc:next.doc,path:'0'});
  const form=host.querySelector('[data-guess-launch]');assert.equal(form.elements.side.value,'both');assert.equal(form.elements.start.value,'current');form.elements.side.value='black';
  await form.onsubmit({preventDefault(){},currentTarget:form});
  assert.equal(calls[0].options.body.path,'0');assert.equal(calls[0].options.body.side,'black');assert.match(calls[0].options.body.pgn,/e4/);assert.deepEqual(next.doc.headers,{Result:'*'});
  await view.launch({entryId:9});assert.equal(host.querySelector('[data-guess-launch]').elements.side.value,'both');assert.equal(host.querySelector('[name="start"]'),null);
  const other=new GuessMoveView(new Element('main'));assert.deepEqual(other.settings,{side:'white',start:'current'});other.dispose();
 },
 async active_settings_are_locked_and_statistics_preserve_session(){
  setup();const session=view.session,board=view.board;
  view.showSettings();assert.equal(settingsDialogs.length,0);assert.equal(host.querySelector('[data-training-settings]').disabled,true);
  await view.showStatistics();assert.equal(statisticsDialogs[0].options.tool,'guess');assert.equal(view.session,session);assert.equal(view.board,board);assert.equal(calls.length,0);
  session.completed=true;view.renderSession();assert.equal(host.querySelector('[data-training-settings]').disabled,false);view.showSettings();assert.equal(settingsDialogs.length,1);
  view.dispose();assert.equal(settingsDialogs[0].closed,true);assert.equal(statisticsDialogs[0].closed,true);
 },
 async startup_blocks_settings_and_late_statistics_are_closed(){
  await view.launch({entryId:8});const gate=deferred();globalThis.testApi=()=>gate.promise;
  const pending=view.start({entryId:8});assert.equal(view.busy,true);view.showSettings();assert.equal(settingsDialogs.length,0);
  gate.resolve(start);await pending;assert.equal(view.busy,false);
  const statistics=deferred();globalThis.openStatisticsDialog=()=>statistics.promise;const opening=view.showStatistics();view.dispose();let closed=false;statistics.resolve({close(){closed=true;}});await opening;assert.equal(closed,true);
 },
 async restored_settings_are_validated_and_only_explicit_save_notifies_workspace(){
  const saved=[],otherHost=new Element('main'),other=new GuessMoveView(otherHost,{initialSettings:{side:'black',start:'beginning'},onSettingsChange:value=>saved.push(value)});
  await other.launch({entryId:9,path:'0'});assert.equal(otherHost.querySelector('[name="side"]').value,'black');assert.equal(otherHost.querySelector('[name="start"]').value,'beginning');assert.equal(saved.length,0);
  other.showSettings();settingsDialogs.at(-1).close();assert.equal(saved.length,0);
  other.showSettings();await settingsDialogs.at(-1).save({side:'both',start:'current'});assert.deepEqual(saved,[{side:'both',start:'current'}]);saved[0].side='white';assert.equal(other.settings.side,'both');other.dispose();
  const invalid=new GuessMoveView(new Element('main'),{initialSettings:{side:'invalid',start:'bad'}});assert.deepEqual(invalid.settings,{side:'white',start:'current'});invalid.dispose();
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario]);await tests[scenario]();view.dispose();console.log('ok '+scenario);
