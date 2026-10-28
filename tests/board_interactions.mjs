
import assert from 'node:assert/strict';
import {Board,appendLine,makeDoc,pieces,squareAtPoint} from '../static/board.js';
import {clearAnalysisCache} from '../static/engine-analysis.js';
import {applyEngineSettings} from '../static/engine-settings.js';
import {recordPositionEvaluation} from '../static/position-evaluation.js';
if(!process.argv[2].startsWith('analysis_preferences_'))applyEngineSettings();
const raw=[];for await(const chunk of process.stdin)raw.push(chunk);const f=JSON.parse(Buffer.concat(raw).toString());
class Classes {
 constructor(){this.values=new Set();}
 add(x){this.values.add(x);}remove(x){this.values.delete(x);}
 toggle(x,on){if(on===undefined)on=!this.values.has(x);on?this.add(x):this.remove(x);return on;}
 contains(x){return this.values.has(x);}
}
class Element {
 constructor(dataset={}){this.dataset=dataset;this.classList=new Classes();this.style={};this.listeners=new Map();this.children=[];this.innerHTML='';this.hidden=false;this.textContent='';}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
 emit(name,event={}){event.type=name;for(const fn of this.listeners.get(name)||[])fn(event);}
 append(node){this.children.push(node);node.parent=this;}
 remove(){this.removed=true;if(this.parent)this.parent.children=this.parent.children.filter(n=>n!==this);}
 contains(node){return node===this||this.children.some(child=>child.contains(node));}
 closest(selector){return selector==='[data-square]'&&this.dataset.square?this:selector==='[data-pv-line]'&&this.dataset.pvLine!==undefined?this:selector==='[data-b]'&&this.dataset.b!==undefined?this:selector.startsWith('.')&&this.classList.contains(selector.slice(1))?this:this.parent?.closest(selector)||null;
 }
 matches(selector){return selector==='[data-arrows]'&&this.isArrows===true;}
 getBoundingClientRect(){return {left:100,top:50,width:400,height:400};}
}
class Host extends Element {
 set innerHTML(value){this._html=String(value);this.clockBands=Object.fromEntries([...this._html.matchAll(/data-board-clock="(top|bottom)" hidden/g)].map(([,position])=>{const band=new Element({boardClock:position});band.hidden=true;return [position,band];}));}
 get innerHTML(){return this._html||'';}
 constructor(){super();this.board=new Element();this.board.classList.add('chess-board');this.label=new Element();this.output=new Element();this.engine=new Element();this.head=new Element();this.arrows=new Element();this.arrows.isArrows=true;this.squares=Object.fromEntries([...'abcdefgh'].flatMap(file=>[1,2,3,4,5,6,7,8].map(rank=>[file+rank,new Element({square:file+rank})])));this.tokens=[new Element({pvLine:'0',pvIndex:'0'}),new Element({pvLine:'0',pvIndex:'1'})];this.append(this.board);Object.values(this.squares).forEach(square=>this.board.append(square));this.children.push(this.arrows,...this.tokens);this.capture=new Set();}
 querySelector(s){if(s==='.chess-board')return this.board;if(s==='.board-preview-label')return this.label;if(s==='.engine-panel')return this.engine;if(s==='.engine-head')return this.head;if(s==='.engine-output')return this.output;if(s==='[data-arrows]')return this.arrows;const clock=s.match(/^\[data-board-clock="(top|bottom)"\]$/);if(clock)return this.clockBands[clock[1]]||null;return this.squares[s.match(/data-square="([a-h][1-8])"/)?.[1]]||null;}
 querySelectorAll(s){if(s==='[data-pv-line]')return this.tokens;if(s==='.drag-target')return Object.values(this.squares).filter(el=>el.classList.contains('drag-target'));return [];}
 setPointerCapture(id){this.capture.add(id);}hasPointerCapture(id){return this.capture.has(id);}releasePointerCapture(id){this.capture.delete(id);}
}
const windowStub=new Element();globalThis.window=windowStub;
const notices=new Element();let openDialogs=[],openMenus=[];globalThis.document={body:new Element(),createElement:()=>new Element(),getElementById:()=>notices,querySelectorAll:selector=>selector==='dialog[open]'?openDialogs:selector==='[role="menu"]'?openMenus:[]};
class TestBoard extends Board {
 render(){this.renderBoard();}
 async refreshLegal(){if(this.disposed)return;const snapshot=f.byFen[this.node().fen];this.legal=snapshot?.legal||[];this.gameOver=snapshot?.game_over||false;this.renderBoard();}
}
function board(opts={}){return new TestBoard(new Host(),opts);}
class ClockBoard extends TestBoard {render(){Board.prototype.render.call(this);}}
function clockDocument(){const doc=structuredClone(f.document);for(const node of doc.nodes)node.clock=({e2e4:590,c7c5:580,d2d4:570,d7d5:560})[node.uci]??null;return doc;}
const clockValue=band=>band.innerHTML.match(/class="board-clock-value"[^>]*>([^<]*)<\/span>/)?.[1];
function event(target,x,y,overrides={}){return {target,clientX:x,clientY:y,pointerId:1,pointerType:'mouse',isPrimary:true,button:0,preventDefault(){this.prevented=true;},...overrides};}
function xy(square,flipped=false){let x='abcdefgh'.indexOf(square[0]),y=8-Number(square[1]);if(flipped){x=7-x;y=7-y;}return [100+(x+.5)*50,50+(y+.5)*50];}
function drag(b,from,to,{flipped=false,touch=false}={}){const [x,y]=xy(from,flipped),target=b.host.squares[from];b.host.emit('pointerdown',event(target,x,y,{pointerType:touch?'touch':'mouse'}));const dest=typeof to==='string'?xy(to,flipped):to;windowStub.emit('pointermove',event(target,...dest,{pointerType:touch?'touch':'mouse'}));windowStub.emit('pointerup',event(target,...dest,{pointerType:touch?'touch':'mouse'}));}
function draw(b,from,to){const target=b.host.squares[from],dest=typeof to==='string'?xy(to,b.flipped):to;b.host.emit('pointerdown',event(target,...xy(from,b.flipped),{button:2,buttons:2}));windowStub.emit('pointermove',event(b.host,...dest,{button:-1,buttons:2}));windowStub.emit('pointerup',event(b.host,...dest,{button:2,buttons:0}));}
function trackOverlays(b){
 const surface=b.host.board,overlays=new Map();let markup=surface.innerHTML,writes=0;
 const install=html=>{const name=html.match(/class="(board-arrows|board-drawings)"/)?.[1];if(!name)return;let value=html;const node={get outerHTML(){return value;},set outerHTML(html){value=html;},remove(){overlays.delete(name);}};overlays.set(name,node);};
 Object.defineProperty(surface,'innerHTML',{configurable:true,get(){return markup;},set(html){markup=html;writes++;overlays.clear();for(const svg of html.matchAll(/<svg\b[\s\S]*?<\/svg>/g))install(svg[0]);}});
 surface.querySelector=selector=>overlays.get(selector.slice(1))||null;
 surface.insertAdjacentHTML=(where,html)=>{assert.equal(where,'beforeend');install(html);};
 return {overlays,get writes(){return writes;}};
}
function response(url,body,payload){
 if(url==='/api/engine/analyse/stream')return {ok:true,status:200,body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'done',fen:body.fen,engine:'Stockfish',...payload})+'\n'));controller.close();}})};
 return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>payload};
}
function mockFetch(fn){globalThis.fetch=async(url,options={})=>{const body=options.body?JSON.parse(options.body):null;return response(url,body,await fn(url,body));};}
function deferredFetch(){
 const gate={requests:[]};
 globalThis.fetch=(url,options={})=>new Promise((resolve,reject)=>{
  const body=options.body?JSON.parse(options.body):null;gate.requests.push({url,body,signal:options.signal});
  gate.resolve=payload=>resolve(response(url,body,payload));gate.reject=reject;
 });return gate;
}
function streamGate(){
 const requests=[];globalThis.fetch=async(url,options={})=>{
  assert.equal(url,'/api/engine/analyse/stream');const body=JSON.parse(options.body),request={body,signal:options.signal};requests.push(request);
  return {ok:true,status:200,body:new ReadableStream({start(controller){options.signal?.addEventListener('abort',()=>controller.error(new DOMException('Cancelled','AbortError')),{once:true});request.emit=(type,lines)=>controller.enqueue(new TextEncoder().encode(JSON.stringify({type,fen:body.fen,engine:'Stockfish',lines})+'\n'));request.close=()=>controller.close();},cancel(){request.cancelled=true;}})};
 };return requests;
}
function renderedPieces(b){
 const result={};
 for(const match of b.host.board.innerHTML.matchAll(/<button\b[^>]*data-square="([a-h][1-8])"[^>]*>([\s\S]*?)<\/button>/g)){
  const piece=match[2].match(/<img\b[^>]*src="[^"]*\/([wb])([KQRBNP])\.svg"/);
  if(piece)result[match[1]]=piece[1]==='w'?piece[2]:piece[2].toLowerCase();
 }return result;
}
function showsPosition(b,fen,message){assert.deepEqual(renderedPieces(b),pieces(fen),message);}

const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function pressKey(key,overrides={}){const event={key,target:document.body,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...overrides};windowStub.emit('keydown',event);return event;}
const tests={
 async player_bands_without_clocks_follow_flip_navigation_and_preview(){
  const doc=structuredClone(f.document),before=JSON.stringify(doc),calls=[];
  assert.ok(doc.nodes.every(node=>node.clock==null));
  const b=new ClockBoard(new Host(),{doc,playerBandHtml:(current,side)=>{
   const state={side,path:current.path,preview:!!current.preview};calls.push(state);
   return side+'|'+state.path+'|'+(state.preview?'preview':'position');
  }});
  assert.equal(b.showClocks,false);assert.match(b.host.innerHTML,/board-player-band/);
  for(const band of Object.values(b.host.clockBands))assert.equal(band.hidden,false);
  assert.equal(b.host.clockBands.top.dataset.side,'black');assert.equal(b.host.clockBands.top.innerHTML,'black||position');
  assert.equal(b.host.clockBands.bottom.dataset.side,'white');assert.equal(b.host.clockBands.bottom.innerHTML,'white||position');
  b.control('flip');assert.equal(b.host.clockBands.top.dataset.side,'white');assert.equal(b.host.clockBands.bottom.dataset.side,'black');
  await b.go('0');assert.equal(b.host.clockBands.top.innerHTML,'white|0|position');assert.equal(b.host.clockBands.bottom.innerHTML,'black|0|position');
  assert.deepEqual(calls.slice(-2),[{side:'white',path:'0',preview:false},{side:'black',path:'0',preview:false}]);
  await b.go('');b.engineOn=true;b.lines=[f.opening.line];b.hoverPV='0:0';await b.updatePreview();assert.ok(b.preview);
  assert.equal(b.host.clockBands.top.innerHTML,'white||preview');assert.equal(b.host.clockBands.bottom.innerHTML,'black||preview');
  assert.deepEqual(calls.slice(-2),[{side:'white',path:'',preview:true},{side:'black',path:'',preview:true}]);
  b.clearPreview();b.engineOn=false;assert.equal(b.host.clockBands.top.innerHTML,'white||position');
  assert.equal(b.host.clockBands.bottom.hidden,false);assert.equal(JSON.stringify(doc),before);b.dispose();
 },
 async analysis_clocks_are_optional_and_distinguish_unknown_from_zero(){
  const ordinary=new ClockBoard(new Host(),{doc:clockDocument()});assert.doesNotMatch(ordinary.host.innerHTML,/data-board-clock/);ordinary.dispose();
  const empty=new ClockBoard(new Host(),{showClocks:true});assert.equal(empty.host.clockBands.top.hidden,true);assert.equal(empty.host.clockBands.bottom.hidden,true);empty.dispose();
  const doc=clockDocument(),b=new ClockBoard(new Host(),{doc,showClocks:true});
  assert.equal(b.host.clockBands.top.hidden,false);assert.equal(b.host.clockBands.bottom.hidden,false);assert.equal(clockValue(b.host.clockBands.top),'—');assert.equal(clockValue(b.host.clockBands.bottom),'—');
  doc.nodes.find(node=>node.path==='0').clock=0;await b.go('0');assert.equal(clockValue(b.host.clockBands.bottom),'0:00');assert.equal(clockValue(b.host.clockBands.top),'—');
  doc.nodes.find(node=>node.path==='0').clock=null;b.renderBoard();assert.equal(clockValue(b.host.clockBands.bottom),'—');assert.equal(b.host.clockBands.bottom.hidden,false,'other recorded clocks keep the layout stable');
  await b.setDoc(makeDoc());assert.equal(b.host.clockBands.top.hidden,true);assert.equal(b.host.clockBands.bottom.hidden,true);b.dispose();
 },
 async analysis_clocks_follow_branches_flip_and_restored_positions(){
  const doc=clockDocument();doc.headers.White='<Alice "captain">';const before=JSON.stringify(doc),b=new ClockBoard(new Host(),{doc,path:'0.0',showClocks:true});
  assert.equal(b.host.clockBands.top.dataset.side,'black');assert.equal(clockValue(b.host.clockBands.top),'9:40');assert.equal(clockValue(b.host.clockBands.bottom),'9:50');
  assert.match(b.host.clockBands.bottom.innerHTML,/&lt;Alice &quot;captain&quot;&gt;/);assert.doesNotMatch(b.host.clockBands.bottom.innerHTML,/<Alice/);
  const markup=b.host.innerHTML;assert.ok(markup.indexOf('data-board-clock="top"')<markup.indexOf('class="chess-board-wrap"'));assert.ok(markup.indexOf('data-board-clock="bottom"')>markup.indexOf('class="chess-board-wrap"'));assert.ok(markup.indexOf('data-board-clock="bottom"')<markup.indexOf('class="board-toolbar"'));
  await b.go('1.0');assert.equal(clockValue(b.host.clockBands.top),'9:20');assert.equal(clockValue(b.host.clockBands.bottom),'9:30');
  b.control('flip');assert.equal(b.host.clockBands.top.dataset.side,'white');assert.equal(clockValue(b.host.clockBands.top),'9:30');assert.equal(clockValue(b.host.clockBands.bottom),'9:20');
  await b.go('0');assert.equal(clockValue(b.host.clockBands.top),'9:50');assert.equal(clockValue(b.host.clockBands.bottom),'—','future or sibling clocks cannot leak into this position');
  assert.equal(JSON.stringify(doc),before);b.dispose();
  const restored=new ClockBoard(new Host(),{doc:structuredClone(doc),path:'1.0',flipped:true,showClocks:true});assert.equal(clockValue(restored.host.clockBands.top),'9:30');assert.equal(clockValue(restored.host.clockBands.bottom),'9:20');restored.dispose();
 },
 async analysis_clocks_mask_preview_and_pending_positions_without_hiding_bands(){
  const doc=clockDocument();doc.headers.TimeControl='600+5';const b=new ClockBoard(new Host(),{doc,showClocks:true});
  assert.equal(clockValue(b.host.clockBands.top),'10:00');assert.equal(clockValue(b.host.clockBands.bottom),'10:00');
  b.engineOn=true;b.lines=[f.opening.line];b.hoverPV='0:0';await b.updatePreview();assert.ok(b.preview);
  for(const band of Object.values(b.host.clockBands)){assert.equal(band.hidden,false);assert.equal(clockValue(band),'—');assert.match(band.innerHTML,/Horloge indisponible dans cet aperçu/);}
  b.control('flip');assert.equal(b.host.clockBands.top.dataset.side,'white');assert.equal(clockValue(b.host.clockBands.top),'—');b.clearPreview();b.engineOn=false;
  assert.equal(clockValue(b.host.clockBands.top),'10:00');const gate=deferredFetch(),pending=b.tryMove('e2','e4');
  assert.equal(gate.requests.length,1);assert.ok(b.pendingMove);for(const band of Object.values(b.host.clockBands)){assert.equal(band.hidden,false);assert.equal(clockValue(band),'—');}
  gate.resolve(f.opening.line.positions[0]);await pending;assert.equal(b.pendingMove,null);assert.equal(clockValue(b.host.clockBands.top),'9:50');assert.equal(clockValue(b.host.clockBands.bottom),'10:00');b.dispose();
 },
 async initial_legal_state_is_playable_without_network_roundtrip(){
  class InitialBoard extends Board {render(){this.firstLegalSnapshot??=[...this.legal];this.renderBoard();}}
  const requests=[],moves=[],fen=f.opening.fen,state={fen,moves:[...f.byFen[fen].legal],game_over:false,result:'*'};
  mockFetch(url=>{requests.push(url);throw Error('An exact initial legal state must not fetch legal moves');});
  const b=new InitialBoard(new Host(),{doc:makeDoc(fen),legalState:state,training:true,onMove:move=>moves.push(move)});
  assert.deepEqual(b.firstLegalSnapshot,state.moves,'legal moves must be ready before the first render');assert.deepEqual(b.legal,state.moves);assert.notEqual(b.legal,state.moves);assert.equal(b.gameOver,false);assert.equal(b.result,'*');
  state.moves.length=0;assert(b.legal.includes('e2e4'),'the board must not share the response array');await b.click('e2');await b.click('e4');assert.deepEqual(moves,['e2e4']);assert.deepEqual(requests,[]);b.dispose();
  const finished=new InitialBoard(new Host(),{doc:makeDoc(fen),legalState:{fen,moves:[],game_over:true,result:'1-0'}});assert.deepEqual(finished.legal,[]);assert.equal(finished.gameOver,true);assert.equal(finished.result,'1-0');assert.deepEqual(requests,[]);finished.dispose();
 },
 async invalid_initial_legal_state_falls_back_to_exact_position_request(){
  class InitialBoard extends Board {render(){this.renderBoard();}}
  const fen=f.opening.fen,wrongFen=f.black.fen,expected=f.byFen[fen].legal;
  for(const state of [null,{}, {fen:wrongFen,moves:['e7e5']},{fen,moves:null},{fen,moves:'e2e4'},{fen,moves:['e2e4',1]}]){
   const requests=[];mockFetch(url=>{requests.push(url);assert.equal(url,'/api/legal?fen='+encodeURIComponent(fen));return {moves:expected,game_over:false,result:'*'};});
   const b=new InitialBoard(new Host(),{doc:makeDoc(fen),legalState:state});await settle();assert.equal(requests.length,1);assert.deepEqual(b.legal,expected);assert.equal(b.result,'*');b.dispose();
  }
 },
 async initial_legal_state_does_not_survive_navigation_or_document_replacement(){
  class InitialBoard extends Board {render(){this.renderBoard();}}
  const doc=structuredClone(f.document),fen=doc.nodes[0].fen,requests=[];
  mockFetch(url=>{requests.push(url);const position=new URL(url,'http://local.test').searchParams.get('fen');assert(f.byFen[position]);return {moves:f.byFen[position].legal,game_over:!!f.byFen[position].game_over,result:'*'};});
  const b=new InitialBoard(new Host(),{doc,legalState:{fen,moves:f.byFen[fen].legal,game_over:false,result:'*'}});assert.equal(requests.length,0);
  await b.go('0');assert.equal(requests.length,1);assert.equal(requests[0],'/api/legal?fen='+encodeURIComponent(b.node().fen));assert.deepEqual(b.legal,f.byFen[b.node().fen].legal);assert(!b.legal.includes('e2e4'));
  await b.setDoc(makeDoc(f.promotion.fen));assert.equal(requests.length,2);assert.deepEqual(b.legal,f.byFen[f.promotion.fen].legal);assert(b.legal.includes('a7a8q'));assert(!b.legal.includes('e7e5'));b.dispose();
 },
 async analysis_settings_cancel_restart_and_keep_exact_cache_keys(){
  clearAnalysisCache();const requests=streamGate(),b=board({engineHost:new Host()}),original=JSON.stringify(b.doc);b.engineOn=true;b.arrows=2;const first=b.analyse();await settle();requests[0].emit('info',[f.opening.line]);await settle();
  b.hoverPV='0:1';await b.updatePreview();assert.ok(b.preview);applyEngineSettings({mode:'depth',time_ms:5000,depth:22});b.engineSettingsChanged();await settle();assert.equal(requests[0].signal.aborted,true);assert.equal(requests.length,2);assert.equal(requests[1].body.depth,22);assert.equal(requests[1].body.time_ms,null,'Depth mode must not add a hidden duration');assert.equal(requests[1].body.multipv,3);assert.equal(requests[1].body.refresh,true);assert.equal(b.preview,null);assert.equal(b.arrows,2);assert.equal(JSON.stringify(b.doc),original);
  requests[1].emit('done',[{...f.opening.line,depth:22}]);await first;await settle();assert.equal(b.lines[0].depth,22);
  applyEngineSettings({mode:'time',time_ms:5000,depth:22});const timed=b.analyse();await settle();assert.equal(requests.length,3);assert.equal(requests[2].body.depth,null);assert.equal(requests[2].body.time_ms,5000);requests[2].emit('done',[{...f.opening.line,depth:19}]);await timed;
  applyEngineSettings({mode:'depth',time_ms:5000,depth:22});await b.analyse();assert.equal(requests.length,3,'Only the cache for the selected depth can be reused');assert.equal(b.lines[0].depth,22);b.dispose();
 },
 async engine_settings_controls_do_not_enable_training_or_count_as_assistance(){
  let assistance=0;for(const docked of [false,true]){const b=board({training:true,onAssist:()=>assistance++,...(docked?{engineHost:new Host()}:{})});assert.match(b.engineHeadHtml(),/data-b="engine-settings"/);assert.match(b.engineHeadHtml(),/aria-label="Réglages du moteur"/);applyEngineSettings({mode:'depth',time_ms:3000,depth:20});b.engineSettingsChanged();assert.equal(b.engineOn,false);assert.equal(assistance,0);assert.equal(b.arrows,3);b.dispose();}
 },
 async analysis_preferences_load_before_stream_and_only_latest_position_runs(){
  const calls=[];let finish;globalThis.fetch=async(url,options={})=>{calls.push({url,body:options.body?JSON.parse(options.body):null});if(url==='/api/engine/settings')return response(url,null,await new Promise(resolve=>finish=resolve));return response(url,JSON.parse(options.body),{lines:[]});};
  const b=board({doc:f.variationDocument});b.engineOn=true;const initial=b.analyse();await settle();assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/engine/settings');await b.go('0');assert.equal(calls.length,1,'Concurrent positions share the preference request');finish({mode:'depth',time_ms:7000,depth:24});await initial;await settle();assert.equal(calls.length,2);assert.equal(calls[1].body.fen,b.node().fen);assert.equal(calls[1].body.depth,24);assert.equal(calls[1].body.time_ms,null,'Depth mode must not add a hidden duration');b.dispose();
 },
 async analysis_preferences_disposed_board_cannot_start_delayed_engine(){
  let finish,calls=0;globalThis.fetch=async(url)=>{calls++;assert.equal(url,'/api/engine/settings');return response(url,null,await new Promise(resolve=>finish=resolve));};const b=board();b.engineOn=true;const pending=b.analyse();await settle();b.dispose();finish({mode:'time',time_ms:5000,depth:18});await pending;assert.equal(calls,1);assert.equal(b.analysisController,null);
 },
 async right_draw_toggles_arrows_circles_without_changing_chess(){
  const calls=[],b=board({onMove:uci=>calls.push(uci)}),before=JSON.stringify(b.doc),tracking=trackOverlays(b);
  draw(b,'e2','e4');assert.deepEqual(b.drawings,[{from:'e2',to:'e4'}]);assert.equal(b.draw,null);assert.equal(b.host.capture.size,0);
  assert.match(tracking.overlays.get('board-drawings').outerHTML,/x1="450" y1="650" x2="450" y2="450"/);
  draw(b,'c3','f6');assert.equal(b.drawings.length,2,'empty squares may start an arrow');
  draw(b,'e2','e4');assert.deepEqual(b.drawings,[{from:'c3',to:'f6'}],'same direction toggles off');
  draw(b,'f6','c3');assert.equal(b.drawings.length,2,'opposite direction remains a separate arrow');
  draw(b,'d5','d5');assert.match(b.drawingSvg(),/<circle cx="350" cy="350"/);draw(b,'d5','d5');assert.doesNotMatch(b.drawingSvg(),/<circle/);
  assert.equal(JSON.stringify(b.doc),before);assert.equal(b.selected,null);assert.deepEqual(calls,[]);assert.equal(document.body.children.length,0,'drawing never creates a piece ghost');b.dispose();
 },
 async right_draw_preview_capture_and_release_outside_are_safe(){
  const b=board(),target=b.host.squares.e2,tracking=trackOverlays(b),start=xy('e2'),end=xy('e4');draw(b,'a1','a8');
  const down=event(target,...start,{button:2,buttons:2});b.host.emit('pointerdown',down);assert.equal(down.prevented,true);assert.equal(b.host.hasPointerCapture(1),true);assert.equal(b.host.board.classList.contains('drawing'),true);
  const writes=tracking.writes;windowStub.emit('pointermove',event(b.host,...end,{button:-1,buttons:2}));assert.equal(tracking.writes,writes,'live drawing only replaces its SVG');assert.match(b.drawingSvg(),/x1="450" y1="650" x2="450" y2="450"/);
  b.host.emit('lostpointercapture',event(target,...end));assert.ok(b.draw,'square replacement must not cancel host capture');
  windowStub.emit('pointermove',event(b.host,20,20,{button:-1,buttons:2}));assert.equal(b.draw.to,null);windowStub.emit('pointerup',event(b.host,20,20,{button:2,buttons:0}));assert.deepEqual(b.drawings,[{from:'a1',to:'a8'}]);assert.equal(b.host.board.classList.contains('drawing'),false);
  for(const cancel of ['pointercancel','blur','escape','lost','buttons']){
   b.host.emit('pointerdown',event(target,...start,{button:2,buttons:2}));
   if(cancel==='escape')pressKey('Escape');else if(cancel==='lost'){b.host.releasePointerCapture(1);b.host.emit('lostpointercapture',event(b.host,...end));}else if(cancel==='buttons')windowStub.emit('pointermove',event(b.host,...end,{buttons:0}));else windowStub.emit(cancel,event(b.host,...end));
   assert.equal(b.draw,null,cancel+' cancels the draft');assert.deepEqual(b.drawings,[{from:'a1',to:'a8'}]);assert.equal(b.host.capture.size,0);
  }
  b.dispose();assert.deepEqual(b.drawings,[]);
 },
 async right_draw_scopes_context_menu_and_ignores_other_buttons(){
  const b=board(),square=b.host.squares.e2,inside=event(square,...xy('e2'),{button:2});b.host.emit('contextmenu',inside);assert.equal(inside.prevented,true);
  const control=new Element({b:'flip'});b.host.append(control);const outside=event(control);b.host.emit('contextmenu',outside);assert.equal(outside.prevented,undefined,'toolbar and notation menus retain ownership');
  for(const options of [{button:1},{button:2,pointerType:'touch'},{button:2,isPrimary:false}]){b.host.emit('pointerdown',event(square,...xy('e2'),options));assert.equal(b.draw,null);assert.equal(b.drag,null);}
  b.busy=true;draw(b,'e2','e4');b.busy=false;b.inputLocked=true;draw(b,'e2','e4');b.inputLocked=false;assert.deepEqual(b.drawings,[]);
  draw(b,'e2','e4');b.host.emit('click',event(square,...xy('e2'),{button:2,detail:1}));await settle();assert.equal(b.selected,null,'secondary activation cannot move or select a piece');
  b.dispose();const after=event(square);b.host.emit('contextmenu',after);assert.equal(after.prevented,undefined);assert.ok([...b.host.listeners.values()].every(set=>set.size===0));
 },
 async right_draw_flips_keeps_engine_arrows_and_hides_during_pv(){
  const b=board(),tracking=trackOverlays(b);b.engineOn=true;b.lines=[f.opening.line];draw(b,'e2','e4');
  const drawings=tracking.overlays.get('board-drawings'),before=drawings.outerHTML;b.renderEngineArrows();assert.equal(tracking.overlays.get('board-drawings'),drawings);assert.equal(drawings.outerHTML,before);assert.match(tracking.overlays.get('board-arrows').outerHTML,/#484a4d/);
  b.control('flip');assert.deepEqual(b.drawings,[{from:'e2',to:'e4'}]);assert.match(b.drawingSvg(),/x1="350" y1="150" x2="350" y2="350"/);draw(b,'e2','e4');assert.deepEqual(b.drawings,[],'flipped coordinates toggle the same logical arrow');
  draw(b,'a1','h8');b.hoverPV='0:0';await b.updatePreview();assert.ok(b.preview);assert.equal(tracking.overlays.has('board-drawings'),false,'drawings belong to actual position, not a PV preview');assert.equal(b.drawings.length,1);
  b.clearPreview();assert.equal(tracking.overlays.has('board-drawings'),true);b.engineOn=false;b.renderEngine();assert.equal(tracking.overlays.has('board-arrows'),false);assert.equal(tracking.overlays.has('board-drawings'),true);b.dispose();
 },
 async right_draw_clears_on_left_click_navigation_and_new_exercise(){
  const b=board({doc:structuredClone(f.document)});draw(b,'e2','e4');await b.go('0');assert.deepEqual(b.drawings,[]);
  draw(b,'a1','a8');await b.setDoc(makeDoc(b.node().fen));assert.deepEqual(b.drawings,[],'loading a new exercise with the same FEN clears old notes');
  draw(b,'a1','a8');const square=b.host.squares.c3;b.host.emit('pointerdown',event(square,...xy('c3')));assert.deepEqual(b.drawings,[],'left press on an empty square clears drawings');
  draw(b,'a1','a8');await b.click('c3');assert.deepEqual(b.drawings,[],'keyboard square activation clears drawings too');b.dispose();
  const moves=[],normal=board({onMove:uci=>moves.push(uci)});draw(normal,'e2','e4');normal.host.emit('pointerdown',event(normal.host.squares.e2,...xy('e2')));windowStub.emit('pointerup',event(normal.host.squares.e2,...xy('e2')));normal.host.emit('click',event(normal.host.squares.e2,...xy('e2'),{detail:1}));await settle();assert.equal(normal.selected,'e2','drawing does not swallow the next left click');
  normal.host.emit('click',event(normal.host.squares.e4,...xy('e4'),{detail:1}));await settle();assert.deepEqual(moves,['e2e4']);assert.deepEqual(normal.drawings,[]);normal.dispose();
 },
 async right_draw_training_and_multiple_boards_are_independent(){
  let assists=0,moves=0;const review=board({training:true,onAssist:()=>assists++,onMove:()=>moves++}),other=board({doc:structuredClone(f.document)}),before=JSON.stringify(review.doc);
  draw(review,'e2','e4');assert.deepEqual(other.drawings,[]);assert.equal(assists,0);assert.equal(moves,0);assert.equal(JSON.stringify(review.doc),before);
  draw(other,'b1','c3');assert.equal(review.drawings.length,1);assert.equal(other.drawings.length,1);
  other.host.emit('pointerdown',event(other.host.squares.a1,...xy('a1'),{button:2,buttons:2}));assert.equal(pressKey('ArrowRight').defaultPrevented,false);assert.equal(other.path,'','arrow keys do not navigate during a right-button gesture');windowStub.emit('pointercancel',event(other.host));
  review.dispose();other.dispose();assert.equal(windowStub.listeners.get('pointermove').size,0);
 },
 async copy_pgn_control_survives_navigation_and_respects_edit_locks(){
  class ToolbarBoard extends TestBoard {render(){Board.prototype.render.call(this);}}
  const doc=structuredClone(f.document),calls=[],host=new Host(),b=new ToolbarBoard(host,{doc,onCopyPgn:()=>calls.push(b.path)});
  assert.match(host.innerHTML,/class="copy-pgn" data-b="copy-pgn"[^>]*aria-label="Copier PGN"/);
  assert.match(host.innerHTML,/aria-label="Copier FEN"><span class="copy-verb">Copier <\/span>FEN/);
  const copy=new Element({b:'copy-pgn'});host.append(copy);const before=JSON.stringify(b.doc);
  const click=event(copy);host.emit('click',click);await settle();assert.equal(click.prevented,true);assert.deepEqual(calls,['']);assert.equal(JSON.stringify(b.doc),before);
  await b.go('0');assert.match(host.innerHTML,/data-b="copy-pgn"/,'navigation retains the board-owned copy action');host.emit('click',event(copy));await settle();assert.deepEqual(calls,['','0']);
  b.busy=true;host.emit('click',event(copy));await settle();b.busy=false;
  b.inputLocked=true;host.emit('click',event(copy));await settle();b.inputLocked=false;
  copy.disabled=true;host.emit('click',event(copy));await settle();assert.equal(calls.length,2,'disabled controls and pending edits cannot export');
  b.dispose();host.emit('click',event(copy));await settle();assert.equal(calls.length,2);
  const normal=new ToolbarBoard(new Host());assert.doesNotMatch(normal.host.innerHTML,/data-b="copy-pgn"/,'unrelated boards keep their existing controls');await normal.control('copy-pgn');normal.dispose();
 },
 async inactive_engine_is_quiet_but_training_and_analysis_errors_remain_visible(){
  const b=board({engineHost:new Host()});assert.equal(b.engineHtml(),'');
  b.engineOn=true;b.analysisPending=true;assert.match(b.engineHtml(),/Le moteur analyse la position/);
  b.engineMessage='Moteur indisponible';assert.match(b.engineHtml(),/Moteur indisponible/);
  b.lines=[f.opening.line];assert.match(b.engineHtml(),/data-pv-index="2"/);assert.match(b.engineHeadHtml(),/engine-score/,'the compact view retains the live score node');b.dispose();
  const review=board({training:true,engineHost:new Host()});assert.match(review.engineHtml(),/compte comme une aide/);review.dispose();
 },
 async pv_hover_is_continuous_across_buttons_and_line_gaps(){
  for(const docked of [false,true]){
   const b=board(docked?{engineHost:new Host()}:{}),surface=b.engineSurface(),row=new Element(),moves=new Element(),number=new Element();
   row.classList.add('engine-line');moves.classList.add('engine-moves');surface.append(row);row.append(moves);surface.tokens.forEach(token=>moves.append(token));surface.tokens[0].append(number);
   b.lines=[f.opening.line,f.capture.line];b.engineOn=true;
   const [first,second]=surface.tokens,otherRow=new Element(),other=new Element({pvLine:'1',pvIndex:'1'});otherRow.classList.add('engine-line');surface.append(otherRow);otherRow.append(other);surface.tokens.push(other);
   const seen=[],render=b.renderBoard.bind(b);b.renderBoard=()=>{seen.push(b.preview?.fen||b.node().fen);render();};
   const over=(target,relatedTarget=null)=>surface.emit('pointerover',{target,relatedTarget,pointerType:'mouse'}),out=(target,relatedTarget=null)=>surface.emit('pointerout',{target,relatedTarget,pointerType:'mouse'});
   over(number);await settle();assert.equal(b.preview.fen,f.opening.line.positions[0].fen);seen.length=0;
   out(number,first);over(first,number);await settle();assert.equal(b.preview.fen,f.opening.line.positions[0].fen,'move number belongs to the same hover target');
   out(first,second);over(second,first);await settle();assert.equal(b.preview.fen,f.opening.line.positions[1].fen);
   out(second,moves);await settle();assert.equal(b.preview.fen,f.opening.line.positions[1].fen,'space between moves keeps the last preview');
   out(moves,first);over(first,moves);await settle();assert.equal(b.preview.fen,f.opening.line.positions[0].fen);
   out(first,other);over(other,first);await settle();assert.equal(b.preview.fen,f.capture.line.positions[1].fen,'moving directly to another PV previews its move');
   assert.ok(!seen.includes(b.node().fen),'no intermediate render may flash the original position');
   out(other,otherRow);await settle();assert.equal(b.hoverPV,'1:1');out(otherRow,null);await settle();assert.equal(b.preview,null,'leaving the row from blank space clears the preview');assert.equal(b.hoverPV,null);
   over(first);await settle();out(first,null);await settle();assert.equal(b.preview,null,'leaving directly from a move still clears');
   surface.emit('focusin',{target:first,relatedTarget:null});await settle();surface.emit('focusout',{target:first,relatedTarget:moves});await settle();assert.equal(b.preview,null,'keyboard focus must not stick in nonfocusable row space');
   surface.emit('pointerover',{target:first,relatedTarget:null,pointerType:'touch'});await settle();assert.equal(b.preview,null,'touch does not activate a hover');b.dispose();
  }
 },
 async pv_gap_preserves_stream_until_actual_line_exit(){
  clearAnalysisCache();const requests=streamGate(),b=board({engineHost:new Host()}),surface=b.engineSurface(),row=new Element(),moves=new Element();
  row.classList.add('engine-line');surface.append(row);row.append(moves);surface.tokens.forEach(token=>moves.append(token));
  b.engineOn=true;const pending=b.analyse();await settle();requests[0].emit('info',[f.opening.line]);await settle();const [first,second]=surface.tokens;
  surface.emit('pointerover',{target:first,relatedTarget:null,pointerType:'mouse'});await settle();
  requests[0].emit('done',[f.capture.line]);await pending;
  surface.emit('pointerout',{target:first,relatedTarget:moves,pointerType:'mouse'});await settle();assert.deepEqual(b.lines[0].pv,f.opening.line.pv,'gap must not flush a pending PV replacement');
  surface.emit('pointerover',{target:second,relatedTarget:moves,pointerType:'mouse'});await settle();assert.equal(b.preview.fen,f.opening.line.positions[1].fen,'the next move still belongs to the displayed PV');
  surface.emit('pointerout',{target:second,relatedTarget:row,pointerType:'mouse'});surface.emit('pointerout',{target:row,relatedTarget:null,pointerType:'mouse'});await settle();
  assert.equal(b.preview,null);assert.equal(b.hoverPV,null);assert.deepEqual(b.lines[0].pv,f.capture.line.pv,'actual line exit releases the latest engine result');b.dispose();
 },
 async progressive_updates_preserve_all_square_button_identities(){
  clearAnalysisCache();const requests=streamGate(),b=board(),surface=b.host.board;
  let markup='',buttons=[],overlay=null,writes=0,overlayUpdates=0;
  const makeOverlay=html=>{let text=html;return {get outerHTML(){return text;},set outerHTML(value){text=value;overlayUpdates++;},remove(){overlay=null;}};};
  Object.defineProperty(surface,'innerHTML',{configurable:true,get(){return markup;},set(value){markup=value;writes++;buttons=[...value.matchAll(/<button[^>]+data-square="([a-h][1-8])"/g)].map(match=>new Element({square:match[1]}));overlay=value.includes('class="board-arrows"')?makeOverlay(value):null;}});
  surface.querySelector=selector=>selector==='.board-arrows'?overlay:null;
  surface.insertAdjacentHTML=(where,html)=>{assert.equal(where,'beforeend');assert.match(html,/class="board-arrows"/);overlay=makeOverlay(html);overlayUpdates++;};
  b.renderBoard();const initial=buttons.slice(),initialWrites=writes;assert.equal(initial.length,64);
  b.engineOn=true;const pending=b.analyse();await settle();requests[0].emit('info',[f.opening.line]);await settle();requests[0].emit('info',[f.capture.line]);await settle();requests[0].emit('done',[f.capture.line]);await pending;
  assert.equal(writes,initialWrites,'progress must not assign board.innerHTML');assert.ok(initial.every((button,index)=>buttons[index]===button),'all64 square buttons retain their DOM identities');assert.ok(overlayUpdates>=2,'arrows still follow progressive PV updates');
  b.engineOn=false;b.renderEngine();assert.equal(overlay,null,'disabling engine removes only arrows');assert.ok(initial.every((button,index)=>buttons[index]===button));b.renderBoard();assert.notEqual(buttons[0],initial[0],'normal board rendering still replaces position squares');b.dispose();
 },

 async queued_analysis_flushes_after_move_unlock(){
  clearAnalysisCache();const requests=streamGate(),b=board();b.lines=[f.opening.line];b.engineResultFen=b.node().fen;b.engineOn=true;
  let legalDone;b.refreshLegal=()=>new Promise(resolve=>{legalDone=resolve;});const apply=b.playLine(0,0);await settle();assert.equal(b.inputLocked,true);assert.equal(requests.length,1);
  requests[0].emit('done',[f.black.line]);await settle();assert.deepEqual(b.lines,[],'input-locked board queues its engine result');legalDone();await apply;assert.deepEqual(b.lines,[f.black.line],'unlock applies the queued final result');assert.equal(b.analysisPending,false);b.dispose();
 },

 async progressive_cache_returns_instantly_and_aborts_navigation(){
  clearAnalysisCache();const requests=streamGate(),b=board({doc:structuredClone(f.document),engineHost:new Host()});b.engineOn=true;
  const first=b.analyse();await settle();requests[0].emit('info',[{...f.opening.line,depth:5,cp:12}]);await settle();
  assert.equal(b.lines[0].depth,5);assert.match(b.engineHeadHtml(),/>[+]0[.]12</);assert.match(b.engineHtml(),/data-pv-index/);assert.equal(b.analysisPending,true);
  requests[0].emit('done',[f.opening.line]);await first;assert.equal(b.lines[0].depth,10);assert.equal(b.analysisPending,false);
  const next=b.go('0');assert.equal(requests.length,2);assert.equal(requests[1].body.fen,b.node().fen);assert.deepEqual(b.lines,[],'never show previous-position PV');
  const back=b.go('');assert.equal(requests[1].signal.aborted,true);assert.deepEqual(b.lines,[f.opening.line],'return restores PV synchronously before any promise');assert.match(b.engineHeadHtml(),/En mémoire/);assert.equal(requests.length,2,'completed positions must not be recomputed');
  await Promise.all([next,back]);await settle();assert.deepEqual(b.lines,[f.opening.line]);b.dispose();
 },
 async analysis_starts_before_legal_and_late_responses_are_discarded(){
  clearAnalysisCache();const b=board({doc:structuredClone(f.document),engineHost:new Host()}),gate=deferredFetch();b.engineOn=true;
  let legalDone;b.refreshLegal=()=>new Promise(resolve=>{legalDone=resolve;});const navigation=b.go('0');
  assert.equal(gate.requests.length,1,'engine must start before legal request settles');assert.equal(gate.requests[0].body.fen,b.node().fen);
  b.control('engine');assert.equal(gate.requests[0].signal.aborted,true);gate.resolve({lines:[f.black.line]});legalDone();await navigation;await settle();assert.deepEqual(b.lines,[]);assert.equal(b.engineOn,false);
  b.refreshLegal=async()=>{};b.engineOn=true;const again=deferredFetch(),pending=b.analyse();const old=again.requests[0];b.dispose();assert.equal(old.signal.aborted,true);const head=b.engineHeadHtml();again.resolve({lines:[f.black.line]});await pending;assert.deepEqual(b.lines,[]);assert.equal(b.engineHeadHtml(),head);
 },
 async stored_scores_require_matching_path_fen_and_prefer_greater_depth(){
  clearAnalysisCache();const b=board({doc:structuredClone(f.document),engineHost:new Host()}),root=b.node();
  b.setAnalysisReport({positions:[{path:'',fen:root.fen,cp:42,depth:18},{path:'0',fen:'wrong',cp:800}]});assert.match(b.engineHeadHtml(),/>[+]0[.]42</);assert.match(b.engineHeadHtml(),/Enregistré/);assert.deepEqual(b.lines,[],'saved position score is not a move prediction');
  await b.go('0');assert.doesNotMatch(b.engineHeadHtml(),/[+]8[.]00/);await b.go('');
  const requests=streamGate();b.engineOn=true;const pending=b.analyse();assert.match(b.engineHeadHtml(),/Enregistré/);requests[0].emit('info',[f.opening.line]);await settle();assert.match(b.engineHeadHtml(),/>[+]0[.]42</,'shallower live analysis does not replace the saved score');assert.deepEqual(b.lines[0].pv,f.opening.line.pv,'live continuations remain available');
  requests[0].emit('info',[{...f.opening.line,depth:18}]);await settle();assert.match(b.engineHeadHtml(),/>[+]0[.]42</,'equal depth preserves the existing evaluation');
  requests[0].emit('info',[{...f.opening.line,depth:19}]);await settle();assert.match(b.engineHeadHtml(),/>[+]0[.]25</,'deeper live analysis replaces the saved score');
  b.setAnalysisReport({positions:[{path:'',fen:root.fen,cp:90,depth:20}]});assert.match(b.engineHeadHtml(),/>[+]0[.]90</,'a still deeper report wins');
  requests[0].emit('done',[{...f.opening.line,depth:21}]);await pending;assert.match(b.engineHeadHtml(),/>[+]0[.]25</);b.control('engine');b.setAnalysisReport({status:'stale',positions:[{path:'',fen:root.fen,cp:90}]});assert.match(b.engineHeadHtml(),/engine-score[^>]*>—</);
  b.setAnalysisReport({positions:[{path:'',fen:root.fen,cp:42}]});await b.setDoc(makeDoc());assert.match(b.engineHeadHtml(),/engine-score[^>]*>—</,'a newly loaded document cannot inherit saved score');b.dispose();
 },
 async live_evaluation_records_position_without_report_and_preserves_annotations(){
  clearAnalysisCache();const requests=streamGate(),doc=structuredClone(f.document),original=JSON.stringify(doc),events=[];
  doc.nodes.find(node=>node.path==='0').comment+=' [%clk 0:09:42]';
  const onEvaluation=(b,{path,fen,line})=>{events.push({path,fen,line});const source=b.doc,next=recordPositionEvaluation(source,path,fen,line,b.storedEvaluation());b.doc=next;if(b.storedDocument===source)b.storedDocument=next;};
  const b=board({doc,path:'0',onEvaluation,engineHost:new Host()}),beforeRoot=JSON.stringify(b.doc.nodes.find(node=>node.path==='')),beforeBranch=JSON.stringify(b.doc.nodes.find(node=>node.path==='1'));
  b.engineOn=true;const pending=b.analyse();await settle();requests[0].emit('info',[{...f.black.line,cp:-35,depth:12}]);await settle();
  assert.match(b.node().comment,/\[%eval -0[.]35,\s*12\]/,'the score keeps White perspective even when Black is to move');assert.match(b.node().comment,/Idée conservée/);assert.match(b.node().comment,/\[%clk 0:09:42\]/);assert.deepEqual(b.node().nags,[1]);assert.equal(b.doc.analysis_dirty,true);assert.match(b.doc.pgn,/\[%eval -0[.]35,\s*12\]/);assert.equal(JSON.stringify(b.doc.nodes.find(node=>node.path==='')),beforeRoot);assert.equal(JSON.stringify(b.doc.nodes.find(node=>node.path==='1')),beforeBranch);
  const improved=b.doc;requests[0].emit('info',[{...f.black.line,cp:99,depth:12}]);await settle();assert.equal(b.doc,improved,'equal depth does not overwrite the saved score');requests[0].emit('info',[{...f.black.line,cp:300,depth:8}]);await settle();assert.equal(b.doc,improved,'shallower updates cannot downgrade it');
  requests[0].emit('done',[{...f.black.line,cp:null,mate:-3,depth:16}]);await pending;assert.match(b.node().comment,/\[%eval #-3,\s*16\]/);assert.equal((b.node().comment.match(/\[%eval/g)||[]).length,1);assert.ok(events.every(event=>event.path==='0'&&event.fen===f.black.fen));assert.notEqual(JSON.stringify(b.doc),original);
  b.control('engine');assert.match(b.engineHeadHtml(),/>#-3</,'the position score remains visible with the engine stopped');const restored=structuredClone(b.doc);b.dispose();const reopened=board({doc:restored,path:'0',engineHost:new Host()});assert.match(reopened.engineHeadHtml(),/>#-3</);reopened.dispose();
 },
 async live_evaluation_only_replaces_a_shallower_report(){
  clearAnalysisCache();const requests=streamGate(),b=board({doc:structuredClone(f.document),path:'0',onEvaluation:(b,{path,fen,line})=>{const source=b.doc,next=recordPositionEvaluation(source,path,fen,line,b.storedEvaluation());b.doc=next;if(b.storedDocument===source)b.storedDocument=next;},engineHost:new Host()});
  b.setAnalysisReport({positions:[{path:'0',fen:b.node().fen,cp:42,depth:18}]});const original=b.doc;b.engineOn=true;const pending=b.analyse();await settle();
  for(const depth of [12,18]){requests[0].emit('info',[{...f.black.line,cp:80,depth}]);await settle();assert.equal(b.doc,original);assert.match(b.engineHeadHtml(),/>[+]0[.]42</);}
  requests[0].emit('done',[{...f.black.line,cp:81,depth:19}]);await pending;assert.match(b.node().comment,/\[%eval 0[.]81,\s*19\]/);assert.match(b.engineHeadHtml(),/>[+]0[.]81</);b.control('engine');assert.match(b.engineHeadHtml(),/>[+]0[.]81</);b.dispose();
 },
 async live_evaluation_cache_is_saved_and_training_never_writes(){
  clearAnalysisCache();const requests=streamGate(),source=board(),original=JSON.stringify(source.doc);source.engineOn=true;const pending=source.analyse();await settle();requests[0].emit('done',[{...f.opening.line,cp:50,depth:17}]);await pending;assert.equal(JSON.stringify(source.doc),original,'ordinary boards do not mutate documents without a callback');source.dispose();
  const updates=[],onEvaluation=(b,{path,fen,line})=>{updates.push(path);b.doc=recordPositionEvaluation(b.doc,path,fen,line,b.storedEvaluation());};
  const b=board({onEvaluation});b.engineOn=true;await b.analyse();assert.equal(requests.length,1,'the cached result needs no fresh request');assert.match(b.node().comment,/\[%eval 0[.]50,\s*17\]/);assert.ok(updates.length>0);b.dispose();
  const review=board({training:true,onEvaluation}),before=JSON.stringify(review.doc),count=updates.length;review.engineOn=true;await review.analyse();assert.equal(JSON.stringify(review.doc),before);assert.equal(updates.length,count,'training boards never publish evaluations for persistence');review.dispose();
 },
 async live_evaluation_saves_during_preview_and_defers_while_locked(){
  clearAnalysisCache();const requests=streamGate(),b=board({onEvaluation:(b,{path,fen,line})=>{b.doc=recordPositionEvaluation(b.doc,path,fen,line,b.storedEvaluation());}});b.engineOn=true;const pending=b.analyse();await settle();requests[0].emit('info',[f.opening.line]);await settle();b.hoverPV='0:1';await b.updatePreview();const previewFen=b.preview.fen,html=b.engineSurface().output.innerHTML;
  requests[0].emit('info',[{...f.capture.line,cp:70,depth:20}]);await settle();assert.match(b.node().comment,/\[%eval 0[.]70,\s*20\]/,'hover must not lose the better result if the user navigates away');assert.equal(b.preview.fen,previewFen);assert.equal(b.engineSurface().output.innerHTML,html,'saving the score must not replace preview controls');assert.deepEqual(b.lines[0].pv,f.opening.line.pv);
  b.hoverPV=null;await b.updatePreview();b.inputLocked=true;const before=b.doc;requests[0].emit('done',[{...f.opening.line,cp:90,depth:22}]);await pending;assert.equal(b.doc,before,'an in-flight edit owns its document until unlock');b.inputLocked=false;b.flushEngineUpdate();assert.match(b.node().comment,/\[%eval 0[.]90,\s*22\]/);b.dispose();
 },
 async live_evaluation_discards_late_navigation_document_and_disposal_results(){
  clearAnalysisCache();const updates=[],b=board({doc:structuredClone(f.document),onEvaluation:(b,value)=>updates.push(value)}),gate=deferredFetch();b.engineOn=true;const pending=b.analyse(),resolveOld=gate.resolve;await b.go('0');resolveOld({lines:[f.opening.line]});await pending;assert.deepEqual(updates,[],'a response from the previous path cannot annotate the new move');
  const resolvePosition=gate.resolve;await b.setDoc(makeDoc(b.node().fen));resolvePosition({lines:[f.black.line]});await settle();assert.deepEqual(updates,[],'even an identical FEN belongs to a new document after setDoc');const resolveDisposed=gate.resolve;b.dispose();resolveDisposed({lines:[f.black.line]});await settle();assert.deepEqual(updates,[],'disposed boards cannot write');
 },
 async streamed_pv_keeps_hover_preview_and_click_target_stable(){
  clearAnalysisCache();const requests=streamGate(),b=board({engineHost:new Host()});b.engineOn=true;const pending=b.analyse();await settle();requests[0].emit('info',[f.opening.line]);await settle();
  b.hoverPV='0:1';await b.updatePreview();assert.equal(b.preview.fen,f.opening.line.positions[1].fen);const html=b.engineSurface().output.innerHTML;
  requests[0].emit('info',[f.capture.line]);await settle();assert.deepEqual(b.lines[0].pv,f.opening.line.pv);assert.equal(b.preview.fen,f.opening.line.positions[1].fen);assert.equal(b.engineSurface().output.innerHTML,html,'streaming cannot replace a hovered button');
  await b.playLine(0,1);assert.equal(b.node().fen,f.opening.line.positions[1].fen,'click plays the displayed PV');assert.equal(requests[0].signal.aborted,true);await pending;b.dispose();
  clearAnalysisCache();const more=streamGate(),other=board();other.engineOn=true;const analysis=other.analyse();await settle();more[0].emit('info',[f.opening.line]);await settle();other.focusPV='0:1';await other.updatePreview();more[0].emit('done',[f.capture.line]);await analysis;assert.deepEqual(other.lines[0].pv,f.opening.line.pv);other.focusPV=null;await other.updatePreview();assert.deepEqual(other.lines[0].pv,f.capture.line.pv,'latest result appears after leaving PV');assert.equal(other.analysisPending,false);other.dispose();
 },
 async manual_refresh_preserves_cache_and_bypasses_both_caches(){
  clearAnalysisCache();const requests=streamGate(),b=board({engineHost:new Host()});b.engineOn=true;let pending=b.analyse();await settle();requests[0].emit('done',[f.opening.line]);await pending;
  pending=b.analyse({force:true});await settle();assert.equal(requests.length,2);assert.equal(requests[1].body.refresh,true);assert.deepEqual(b.lines,[f.opening.line]);assert.match(b.engineHeadHtml(),/En cours/);assert.match(b.engineHtml(),/data-pv-index/);
  requests[1].emit('done',[{...f.opening.line,cp:35,depth:14}]);await pending;assert.equal(b.lines[0].cp,35);b.dispose();
 },

 async docked_engine_controls_preview_and_atomic_play(){
  class DockBoard extends TestBoard {render(){Board.prototype.render.call(this);}}
  const dock=new Host(),host=new Host(),calls=[];
  mockFetch((url,body)=>{calls.push({url,body});assert.equal(url,'/api/engine/analyse/stream');return {lines:body.fen===f.opening.fen?[f.opening.line]:[]};});
  const b=new DockBoard(host,{engineHost:dock});
  assert.doesNotMatch(host.innerHTML,/class="engine-panel/,'docked engine must not also render below the board');
  assert.match(dock.innerHTML,/class="engine-panel engine-docked"/);assert.match(dock.innerHTML,/aria-label="Activer Stockfish"/);assert.equal(b.engineElement(),dock.engine);
  assert.doesNotMatch(dock.innerHTML,/class="chess-board/);assert.match(dock.innerHTML,/engine-score[^>]*>—</,'no made-up score before analysis');
  const toggle=new Element({b:'engine'});dock.append(toggle);dock.emit('click',event(toggle));await settle();
  assert.equal(b.engineOn,true);assert.equal(calls.length,1);assert.deepEqual(b.lines[0],f.opening.line);assert.match(dock.head.innerHTML,/>[+]0[.]25</);assert.match(dock.head.innerHTML,/Prof[.] 10/);assert.match(dock.output.innerHTML,/data-pv-index="2"/);assert.equal(host.output.innerHTML,'');
  dock.arrows.value='0';dock.emit('change',{target:dock.arrows});assert.equal(b.arrows,0);assert.equal(b.arrowSvg(),'');
  const token=dock.tokens[1];dock.emit('pointerover',{target:token,pointerType:'mouse',relatedTarget:null});await settle();assert.equal(b.preview.fen,f.opening.line.positions[1].fen);assert.ok(token.classList.contains('preview-current'));assert.equal(b.path,'');
  dock.emit('pointerout',{target:token,pointerType:'mouse',relatedTarget:null});await settle();assert.equal(b.preview,null);assert.ok(!token.classList.contains('preview-current'));
  dock.emit('focusin',{target:token,relatedTarget:null});await settle();assert.equal(b.preview.fen,f.opening.line.positions[1].fen);dock.emit('keydown',{key:'Escape'});assert.equal(b.preview,null);
  dock.emit('click',event(token));await settle();await settle();assert.equal(b.node().fen,f.opening.line.positions[1].fen);assert.equal(b.doc.nodes.length,3,'clicking a PV applies the entire prefix');
  b.dispose();assert.ok([...dock.listeners.values()].every(set=>set.size===0));assert.ok([...host.listeners.values()].every(set=>set.size===0));assert.ok([...windowStub.listeners.values()].every(set=>set.size===0));
  const snapshot=JSON.stringify(b.doc);dock.emit('click',event(toggle));assert.equal(JSON.stringify(b.doc),snapshot);
 },
 async docked_engine_clears_stale_results_and_keeps_default_board(){
  class DockBoard extends TestBoard {render(){Board.prototype.render.call(this);}}
  const dock=new Host(),b=new DockBoard(new Host(),{engineHost:dock}),gate=deferredFetch();
  b.engineOn=true;b.lines=[f.opening.line];b.engineResultFen=b.node().fen;b.renderEngine();assert.match(dock.head.innerHTML,/>[+]0[.]25</);
  const pending=b.analyse();assert.match(dock.head.innerHTML,/>[+]0[.]25</,'same-position results stay visible during refinement');assert.match(dock.output.innerHTML,/data-pv-line/);
  b.control('engine');await b.setDoc(makeDoc(f.promotion.fen));gate.resolve({lines:[f.opening.line]});await pending;await settle();assert.equal(b.engineOn,false);assert.deepEqual(b.lines,[]);assert.doesNotMatch(dock.innerHTML,/[+]0[.]25/);
  b.dispose();const before=dock.innerHTML;b.renderEngine();assert.equal(dock.innerHTML,before,'disposed engines cannot redraw a reused dock');
  const normal=new DockBoard(new Host());assert.equal(normal.engineHost,null);assert.equal(normal.engineElement(),normal.host.engine);assert.match(normal.host.innerHTML,/class="engine-panel"/);assert.doesNotMatch(normal.host.innerHTML,/engine-docked/);
  const next=new Element({b:'flip'});normal.host.append(next);normal.host.emit('click',event(next));assert.equal(normal.flipped,true,'inline board controls still delegate correctly');normal.dispose();
 },

 async keyboard_navigation_follows_current_branch_and_notifies(){
  const doc=structuredClone(f.document),before=JSON.stringify(doc),changes=[],b=board({doc,onChange:view=>changes.push(view.path)});
  assert.equal(pressKey('ArrowLeft').defaultPrevented,true);assert.equal(b.path,'');assert.deepEqual(changes,[]);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0');assert.equal(b.node().uci,'e2e4');assert.deepEqual(changes,['0']);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0.0');assert.equal(b.node().uci,'c7c5');
  pressKey('ArrowRight');await settle();assert.deepEqual(changes,['0','0.0'],'end of branch must not call go or onChange');
  pressKey('ArrowLeft');await settle();assert.equal(b.path,'0');
  await b.go('1');const count=changes.length;pressKey('ArrowRight');await settle();assert.equal(b.path,'1.0');assert.equal(b.node().uci,'d7d5');assert.equal(changes.length,count+1);
  pressKey('ArrowLeft');await settle();assert.equal(b.path,'1');pressKey('ArrowLeft');await settle();assert.equal(b.path,'');assert.equal(JSON.stringify(doc),before,'keyboard traversal does not mutate a PGN');
  Board.prototype.render.call(b);assert.match(b.host.innerHTML,/data-b="prev"[^>]*aria-keyshortcuts="ArrowLeft"/);assert.match(b.host.innerHTML,/data-b="next"[^>]*aria-keyshortcuts="ArrowRight"/);b.dispose();
 },
 async keyboard_variation_selection_preserves_board_engine_and_pgn(){
  for(const path of ['', '0']){
   const doc=structuredClone(f.variationDocument),before=JSON.stringify(doc),changes=[],choices=[],b=board({doc,onChange:view=>changes.push(view.path),onVariationChange:view=>choices.push(view)});
   if(path)await b.go(path);changes.length=0;
   let analyses=0,legalRefreshes=0;b.analyse=async()=>{analyses++;};b.refreshLegal=async()=>{legalRefreshes++;};
   b.engineOn=true;b.lines=[f.opening.line];b.engineResultFen=b.node().fen;const engineLines=b.lines,fen=b.node().fen,display=b.host.board.innerHTML;
   assert.equal(b.selectedVariation(),null);
   for(const [key,uci] of [['ArrowDown','d2d4'],['ArrowDown','c2c4'],['ArrowDown','e2e4'],['ArrowUp','c2c4']]){
    assert.equal(pressKey(key).defaultPrevented,true);await settle();
    assert.equal(b.selectedVariation().uci,uci);assert.equal(b.path,path);assert.equal(b.node().fen,fen);assert.equal(b.host.board.innerHTML,display,'choosing a branch must not redraw or advance the position');
   }
   assert.equal(choices.length,4);assert.ok(choices.every(view=>view===b),'variation callback receives the live board');assert.deepEqual(changes,[],'selection is not a position change');
   assert.equal(analyses,0,'choosing an alternative must not restart Stockfish');assert.equal(legalRefreshes,0);assert.equal(b.lines,engineLines);assert.equal(b.engineResultFen,fen);
   assert.equal(JSON.stringify(b.doc),before,'selection must not reorder or annotate the PGN');b.dispose();
  }
 },
 async keyboard_variation_entry_and_reset_follow_chosen_branch(){
  const doc=structuredClone(f.variationDocument),before=JSON.stringify(doc),changes=[],b=board({doc,onChange:view=>changes.push(view.path)});
  pressKey('ArrowUp');assert.equal(b.selectedVariation().uci,'c2c4','up starts from mainline and wraps to the last alternative');
  b.control('next');await settle();assert.equal(b.path,'2');assert.equal(b.node().uci,'c2c4');assert.equal(b.selectedVariation(),null);assert.deepEqual(changes,['2']);
  pressKey('ArrowLeft');await settle();assert.equal(b.path,'');assert.equal(b.selectedVariation(),null);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0','next without a choice returns to the mainline');
  pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'d2d4');assert.equal(b.path,'0');
  pressKey('ArrowRight');await settle();assert.equal(b.path,'1');assert.equal(b.node().uci,'d2d4');assert.equal(b.selectedVariation(),null);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'1.0','after entering a sibling, ordinary next advances exactly one ply');
  pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'g8f6');pressKey('ArrowRight');await settle();assert.equal(b.path,'1.1');assert.equal(b.selectedVariation(),null);
  await b.go('');pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'d2d4');
  await b.go('0');assert.equal(b.selectedVariation(),null,'direct navigation clears a stale branch choice');
  pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'d2d4');b.control('prev');await settle();assert.equal(b.path,'');assert.equal(b.selectedVariation(),null,'back clears the choice rather than carrying it to the parent');
  pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'d2d4');const changeCount=changes.length,cleared=[];let rootAnalyses=0;b.onVariationChange=view=>cleared.push(view);b.analyse=async()=>{rootAnalyses++;};
  assert.equal(pressKey('ArrowLeft').defaultPrevented,true);await settle();assert.equal(b.path,'');assert.equal(b.selectedVariation(),null,'back at the initial position cancels a pending choice');assert.equal(changes.length,changeCount,'cancelling at the initial position is not navigation');assert.deepEqual(cleared,[b]);assert.equal(rootAnalyses,0);
  pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'d2d4');await b.setDoc(structuredClone(f.variationDocument));assert.equal(b.path,'');assert.equal(b.selectedVariation(),null,'a reloaded document does not inherit a choice');
  assert.equal(JSON.stringify(doc),before);b.dispose();
 },
 async keyboard_current_move_siblings_take_priority_over_replies(){
  const doc=structuredClone(f.variationDocument),before=JSON.stringify(doc),b=board({doc});
  await b.go('1');assert.equal(b.node().uci,'d2d4');assert.equal(b.node().children.length,2,'this position also has multiple replies');
  assert.equal(pressKey('ArrowDown').defaultPrevented,true);assert.equal(b.selectedVariation().uci,'c2c4','start from the current sibling, not the first child');assert.equal(b.path,'1');
  pressKey('ArrowUp');assert.equal(b.selectedVariation().uci,'d2d4');pressKey('ArrowUp');assert.equal(b.selectedVariation().uci,'e2e4');
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0','right enters the selected current-move alternative without another ply');assert.equal(b.selectedVariation(),null);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0.0','without a pending choice, right still enters the next move');
  assert.equal(JSON.stringify(doc),before);b.dispose();
 },
 async keyboard_leaf_black_and_nested_siblings_are_selectable(){
  const b=board({doc:structuredClone(f.variationDocument)});
  await b.go('0.0');assert.equal(b.node().uci,'c7c5');assert.equal(b.node().children.length,0);
  assert.equal(pressKey('ArrowDown').defaultPrevented,true);assert.equal(b.selectedVariation().uci,'e7e5');assert.equal(b.path,'0.0','leaf sibling selection keeps the current position');
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0.1');assert.equal(b.selectedVariation(),null);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0.1.0','continue after the newly selected black move');
  await b.go('1.1.0');assert.equal(b.node().uci,'c2c4');
  assert.equal(pressKey('ArrowDown').defaultPrevented,true);assert.equal(b.selectedVariation().uci,'g1f3');assert.equal(b.path,'1.1.0');
  pressKey('ArrowRight');await settle();assert.equal(b.path,'1.1.1');assert.equal(b.node().children.length,0);
  pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'c2c4','down wraps from the last nested alternative');pressKey('ArrowRight');await settle();assert.equal(b.path,'1.1.0');
  b.dispose();
 },
 async keyboard_lone_current_move_falls_back_to_child_variants(){
  const b=board({doc:structuredClone(f.childForkDocument)});
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0');assert.equal(b.node().children.length,2);
  assert.equal(pressKey('ArrowDown').defaultPrevented,true);assert.equal(b.selectedVariation().uci,'e7e5');assert.equal(b.path,'0');
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0.1');assert.equal(b.selectedVariation(),null);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0.1.0');b.dispose();
 },
 async keyboard_selecting_current_sibling_does_not_advance(){
  const choices=[],b=board({doc:structuredClone(f.variationDocument),onVariationChange:view=>choices.push(view.selectedVariation()?.path??null)});
  await b.go('1');pressKey('ArrowDown');pressKey('ArrowUp');assert.equal(b.selectedVariation().path,'1');
  let navigations=0,analyses=0,refreshes=0;b.onChange=()=>navigations++;b.analyse=async()=>analyses++;b.refreshLegal=async()=>refreshes++;b.engineOn=true;const display=b.host.board.innerHTML;
  pressKey('ArrowRight');await settle();assert.equal(b.path,'1','explicitly choosing the current move must not play its reply');assert.equal(b.selectedVariation(),null);assert.equal(choices.at(-1),null,'the selection highlight is cleared');
  assert.equal(navigations,0,'confirming the current move does not disturb unsaved annotation drafts');assert.equal(analyses,0);assert.equal(refreshes,0);assert.equal(b.host.board.innerHTML,display);
  pressKey('ArrowRight');await settle();assert.equal(b.path,'1.0');b.dispose();
 },
 async keyboard_stale_sibling_choices_are_ignored(){
  const b=board({doc:structuredClone(f.variationDocument)});
  await b.go('0');pressKey('ArrowDown');assert.equal(b.selectedVariation().path,'1');
  b.path='2';assert.equal(b.selectedVariation(),null,'a selection belongs to its original current position');
  pressKey('ArrowRight');await settle();assert.equal(b.path,'2.0');assert.equal(b.selectedVariation(),null);
  await b.go('0');pressKey('ArrowDown');assert.equal(b.selectedVariation().path,'1');
  b.doc=structuredClone(f.variationDocument);assert.equal(b.selectedVariation(),null,'a replacement document cannot reuse a choice at the same path');
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0.0');b.dispose();
 },
 async keyboard_single_continuation_preserves_vertical_scrolling(){
  const choices=[],b=board({doc:structuredClone(f.childForkDocument),onVariationChange:view=>choices.push(view)});
  for(const path of ['', '0.1.0']){
   await b.go(path);
   for(const key of ['ArrowUp','ArrowDown']){assert.equal(pressKey(key).defaultPrevented,false);assert.equal(b.path,path);assert.equal(b.selectedVariation(),null);}
  }
  assert.deepEqual(choices,[],'vertical scrolling without a sibling or child fork must not create a branch selection');b.dispose();
 },
 async keyboard_ignores_editing_composition_and_modified_keys(){
  const b=board({doc:structuredClone(f.document)});
  for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'])for(const field of ['input','textarea','select','[contenteditable=""]','[contenteditable="true"]','[contenteditable="plaintext-only"]']){
   const target=new Element();target.closest=selector=>selector.split(',').includes(field)?target:null;
   const event=pressKey(key,{target});assert.equal(event.defaultPrevented,false,key+' '+field);assert.equal(b.path,'',field);assert.equal(b.selectedVariation(),null);
  }
  for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){
   assert.equal(pressKey(key,{target:{isContentEditable:true}}).defaultPrevented,false);
   const editable={isContentEditable:true};assert.equal(pressKey(key,{target:{nodeType:3,parentElement:editable}}).defaultPrevented,false);
   for(const modifier of ['ctrlKey','altKey','metaKey','shiftKey','isComposing']){assert.equal(pressKey(key,{[modifier]:true}).defaultPrevented,false);assert.equal(b.path,'');assert.equal(b.selectedVariation(),null);}
   assert.equal(pressKey(key,{keyCode:229}).defaultPrevented,false);assert.equal(pressKey(key,{defaultPrevented:true}).defaultPrevented,true);assert.equal(b.path,'');assert.equal(b.selectedVariation(),null);
  }
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0');b.dispose();
 },
 async keyboard_modal_and_menu_own_their_input(){
  const background=board({doc:structuredClone(f.document)}),dialog=new Element();dialog.open=true;openDialogs=[dialog];
  for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){assert.equal(pressKey(key).defaultPrevented,false);assert.equal(background.path,'','settings modal blocks the underlying board');assert.equal(background.selectedVariation(),null);}
  const foreground=board({doc:structuredClone(f.document)});dialog.append(foreground.host);const nativeClosest=foreground.host.closest.bind(foreground.host);foreground.host.closest=selector=>selector==='dialog'?dialog:nativeClosest(selector);
  assert.equal(pressKey('ArrowDown').defaultPrevented,true);assert.equal(foreground.selectedVariation().uci,'d2d4');assert.equal(background.selectedVariation(),null);assert.equal(background.path,'');
  assert.equal(pressKey('ArrowUp').defaultPrevented,true);assert.equal(foreground.selectedVariation().uci,'e2e4');
  assert.equal(pressKey('ArrowRight').defaultPrevented,true);await settle();assert.equal(foreground.path,'0');assert.equal(background.path,'');
  const menu=new Element();menu.getClientRects=()=>[{}];openMenus=[menu];
  for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){assert.equal(pressKey(key).defaultPrevented,false);assert.equal(foreground.path,'0');assert.equal(background.path,'');assert.equal(foreground.selectedVariation(),null);}
  menu.hidden=true;pressKey('ArrowRight');await settle();assert.equal(foreground.path,'0.0');
  menu.hidden=false;menu.getClientRects=()=>[];pressKey('ArrowLeft');await settle();assert.equal(foreground.path,'0');
  openMenus=[];openDialogs=[];dialog.open=false;background.dispose();assert.equal(pressKey('ArrowRight').defaultPrevented,false,'closed dialog boards stay inactive');assert.equal(foreground.path,'0');foreground.dispose();
 },
 async keyboard_busy_training_and_drag_are_not_navigated(){
  const b=board({doc:structuredClone(f.document)});
  for(const field of ['busy','inputLocked','training']){b[field]=true;for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){assert.equal(pressKey(key).defaultPrevented,false);assert.equal(b.path,'');assert.equal(b.selectedVariation(),null);}b[field]=false;}
  for(const active of [false,true]){b.drag={active};for(const key of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){assert.equal(pressKey(key).defaultPrevented,false);assert.equal(b.path,'');assert.equal(b.selectedVariation(),null);}}b.drag=null;
  pressKey('ArrowRight');await settle();assert.equal(b.path,'0');b.dispose();
 },
 async keyboard_multiple_boards_consume_once_and_dispose(){
  const first=board({doc:structuredClone(f.document)}),second=board({doc:structuredClone(f.document)});
  pressKey('ArrowRight');await settle();assert.equal(first.path,'0');assert.equal(second.path,'','same DOM event is handled once');
  pressKey('ArrowRight');await settle();assert.equal(first.path,'0.0');assert.equal(second.path,'');pressKey('ArrowRight');await settle();assert.equal(second.path,'','end-of-branch still claims the key');
  first.dispose();pressKey('ArrowRight');await settle();assert.equal(second.path,'0');second.dispose();const event=pressKey('ArrowRight');assert.equal(event.defaultPrevented,false);assert.ok([...windowStub.listeners.values()].every(set=>set.size===0));
 },
 async drag_mouse_touch_flipped_and_ghost(){
  for(const flipped of [false,true])for(const touch of [false,true]){
   const moves=[],b=board({flipped,onMove:async uci=>moves.push(uci)});
   drag(b,'e2','e4',{flipped,touch});await settle();assert.deepEqual(moves,['e2e4']);assert.equal(b.drag,null);assert.equal(document.body.children.length,0);
   b.host.emit('click',{target:b.host.squares.e4,detail:1,preventDefault(){}});await settle();assert.deepEqual(moves,['e2e4']);assert.equal(b.selected,null);b.dispose();
  }
 },
 async drag_cancellation_and_legal_moves(){
  const moves=[],b=board({onMove:async uci=>moves.push(uci)});
  drag(b,'e2',[99,150]);await settle();assert.deepEqual(moves,[]);assert.equal(b.selected,null);
  drag(b,'e2','e5');await settle();assert.deepEqual(moves,[]);assert.equal(b.drag,null);
  drag(b,'e7','e5');await settle();assert.deepEqual(moves,[]);assert.equal(b.drag,null);
  const [x,y]=xy('e2'),target=b.host.squares.e2;b.host.emit('pointerdown',event(target,x,y));windowStub.emit('pointermove',event(target,x+25,y-25));assert.equal(document.body.children.length,1);windowStub.emit('pointercancel',event(target,x+25,y-25));assert.equal(document.body.children.length,0);assert.equal(b.drag,null);
  b.host.emit('pointerdown',event(target,x,y));windowStub.emit('pointermove',event(target,x+25,y-25));b.dispose();assert.equal(document.body.children.length,0);assert.ok([...b.host.listeners.values()].every(set=>set.size===0));assert.ok([...windowStub.listeners.values()].every(set=>set.size===0));
 },
 async capture_transfer_and_dialog_drag(){
  const b=board(),dialog=new Element();const originalClosest=b.host.closest.bind(b.host);b.host.closest=selector=>selector==='dialog'?dialog:originalClosest(selector);
  const target=b.host.squares.e2,[x,y]=xy('e2');b.host.emit('pointerdown',event(target,x,y,{pointerType:'touch'}));windowStub.emit('pointermove',event(target,x+25,y-25,{pointerType:'touch'}));
  assert.equal(dialog.children.length,1,'the moving piece must remain in the dialog top layer');assert.equal(document.body.children.length,0);
  b.host.emit('lostpointercapture',event(target,x,y));assert.equal(b.drag.active,true,'implicit capture lost on a replaced square must not cancel the host drag');
  b.host.emit('lostpointercapture',event(b.host,x,y));assert.equal(b.drag.active,true,'a stale lost event must not cancel current capture');
  b.host.releasePointerCapture(1);b.host.emit('lostpointercapture',event(b.host,x,y));assert.equal(b.drag,null);assert.equal(dialog.children.length,0);
  b.dispose();
 },
 async click_click_and_drag_threshold(){
  const moves=[],b=board({onMove:async uci=>moves.push(uci)}),target=b.host.squares.e2,[x,y]=xy('e2');
  b.host.emit('pointerdown',event(target,x,y));assert.equal(b.host.capture.size,0,'a tap must retain its native click target');windowStub.emit('pointermove',event(target,x+2,y+2));assert.equal(b.drag.active,false);windowStub.emit('pointerup',event(target,x+2,y+2));b.host.emit('click',{target,detail:1,preventDefault(){}});await settle();assert.equal(b.selected,'e2');b.host.emit('click',{target:b.host.squares.e4,detail:1,preventDefault(){}});await settle();assert.deepEqual(moves,['e2e4']);
  b.suppressClickUntil=Date.now()+1000;b.host.emit('click',{target,detail:0,preventDefault(){}});await settle();assert.equal(b.selected,'e2','keyboard activation remains usable after a drag');b.dispose();
 },
 async drag_promotion_and_cancel(){
  const moves=[],b=board({doc:makeDoc(f.promotion.fen),onMove:async uci=>moves.push(uci)});let choices;
  b.promotion=async list=>{choices=list;return 'a7a8n';};drag(b,'a7','a8',{touch:true});await settle();assert.deepEqual(new Set(choices),new Set(['a7a8q','a7a8r','a7a8b','a7a8n']));assert.deepEqual(moves,['a7a8n']);
  b.promotion=async()=>null;drag(b,'a7','a8');await settle();assert.deepEqual(moves,['a7a8n']);assert.equal(b.inputLocked,false);
   b.promotion=async()=>{throw Error('Explorer UCI must keep its exact promotion');};assert.equal(await b.tryMove('a7','a8','a7a8r'),true);assert.deepEqual(moves,['a7a8n','a7a8r']);assert.equal(await b.tryMove('a7','a8','a7a8k'),false);assert.deepEqual(moves,['a7a8n','a7a8r']);b.dispose();
 },
 async snapshot_rook_promotion_and_en_passant(){
  for(const name of ['castle','promotion','enpassant']){
   const fixture=f[name],b=board({doc:makeDoc(fixture.fen)});b.engineOn=true;b.lines=[fixture.line];const before=structuredClone(b.doc);b.hoverPV='0:'+(fixture.line.pv.length-1);await b.updatePreview();assert.equal(b.preview.fen,fixture.line.positions.at(-1).fen);assert.deepEqual(b.doc,before);assert.equal(b.path,'');assert.equal(b.host.board.classList.contains('previewing'),true);assert.equal(b.host.label.hidden,false);
   const p=pieces(b.preview.fen);if(name==='castle'){assert.equal(p.g1,'K');assert.equal(p.f1,'R');assert.equal(p.h1,undefined);}if(name==='promotion'){assert.equal(p.a8,'Q');assert.equal(p.a7,undefined);}if(name==='enpassant'){assert.equal(p.d6,'P');assert.equal(p.d5,undefined);}
   b.clearPreview();assert.equal(b.preview,null);assert.equal(b.host.board.classList.contains('previewing'),false);assert.deepEqual(b.doc,before);b.dispose();
  }
 },
 async hover_focus_and_stale_preview(){
  const b=board(),line={...f.opening.line};delete line.positions;b.lines=[line];b.engineOn=true;let release;globalThis.fetch=()=>new Promise(resolve=>{release=()=>resolve({ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({positions:f.opening.line.positions})});});
  b.hoverPV='0:1';const pending=b.updatePreview();b.clearPreview();release();await pending;assert.equal(b.preview,null,'late requests must not resurrect a hover');
  b.lines=[f.opening.line];const token=b.host.tokens[1];b.host.emit('focusin',{target:token,relatedTarget:null});await settle();assert.equal(b.preview.fen,f.opening.line.positions[1].fen);b.host.emit('focusout',{target:token,relatedTarget:null});await settle();assert.equal(b.preview,null);
  b.host.emit('pointerover',{target:token,pointerType:'mouse',relatedTarget:null});await settle();assert.equal(b.preview.fen,f.opening.line.positions[1].fen);b.host.emit('pointerout',{target:token,pointerType:'mouse',relatedTarget:null});await settle();assert.equal(b.preview,null);b.dispose();
 },
 async apply_pv_preserves_branches_comments_and_headers(){
  const original=structuredClone(f.document),b=board({doc:original});b.lines=[f.opening.line];let changed=0;b.onChange=()=>changed++;
  pressKey('ArrowDown');assert.equal(b.selectedVariation().uci,'d2d4');
  await b.playLine(0,1);assert.equal(b.selectedVariation(),null,'playing an engine line clears a pending sibling choice');assert.equal(b.node().fen,f.opening.line.positions[1].fen);assert.equal(changed,1);assert.deepEqual(original,f.document,'the input tree must not be mutated');assert.equal(b.doc.headers.White,'Auteur');
  const oldBranch=f.document.nodes.find(n=>n.uci==='d2d4');assert.deepEqual(b.doc.nodes.find(n=>n.path===oldBranch.path),oldBranch);assert.equal(b.doc.nodes.find(n=>n.uci==='e2e4').comment,'Idée conservée');assert.deepEqual(b.doc.nodes.find(n=>n.uci==='e2e4').nags,[1]);assert.equal(b.doc.nodes.filter(n=>n.uci==='e2e4').length,1);
  const result=appendLine(b.doc,'',f.opening.line.positions.slice(0,2));assert.equal(result.doc.nodes.length,b.doc.nodes.length);assert.equal(result.path,b.path);b.dispose();
 },
 async saved_pv_stays_local_and_preserves_source_revision(){
  const doc=structuredClone(f.document);doc.id=42;doc.revision='source-revision';const before=structuredClone(doc),expected=appendLine(doc,'',f.opening.line.positions.slice(0,2));const requests=[];mockFetch((url,body)=>{requests.push({url,body});throw new Error('Engine line must not write the saved entry');});
  const b=board({doc});b.lines=[f.opening.line];await b.playLine(0,1);assert.equal(requests.length,0);assert.equal(b.path,expected.path);assert.equal(b.doc.analysis_dirty,true);assert.equal(b.doc.id,42);assert.equal(b.doc.revision,'source-revision');assert.deepEqual(doc,before);b.dispose();
 },
 async training_opens_detached_analysis_without_answer(){
  const doc=structuredClone(f.document);doc.id=42;let assist=0,answer=0,opened;const b=board({doc,training:true,onMove:()=>answer++,onAssist:()=>assist++,onExploreLine:value=>{opened=value;}});b.lines=[f.opening.line];const before=JSON.stringify(b.doc);await b.playLine(0,1);assert.equal(assist,1);assert.equal(answer,0);assert.equal(JSON.stringify(b.doc),before);assert.equal(b.path,'');assert.equal(opened.doc.id,undefined);assert.equal(opened.doc.nodes.find(n=>n.path===opened.path).fen,f.opening.line.positions[1].fen);b.dispose();
 },
 async coordinates_and_keyboard_pv_labels(){
  const rect={left:100,top:50,width:400,height:400};assert.equal(squareAtPoint(rect,100,50),'a8');assert.equal(squareAtPoint(rect,100,50,true),'h1');assert.equal(squareAtPoint(rect,500,50),null);assert.equal(squareAtPoint(rect,100,450),null);assert.equal(squareAtPoint(rect,99,50),null);
  const b=board({doc:makeDoc(f.black.fen)});b.lines=[f.black.line];b.engineOn=true;const html=b.engineHtml();assert.match(html,/1…/);assert.match(html,/2\./);assert.equal((html.match(/data-pv-index=/g)||[]).length,f.black.line.pv.length);assert.match(html,/type="button"/);b.dispose();
 },

 async drop_remains_at_destination_until_server_accepts(){
  for(const saved of [false,true]){
   const doc=makeDoc();if(saved)doc.id=42;
   const before=JSON.stringify(doc),b=board({doc}),gate=deferredFetch(),step=f.opening.line.positions[0];
   drag(b,'e2','e4');
   assert.equal(gate.requests.length,1);assert.equal(gate.requests[0].url,'/api/move');
   assert.equal(JSON.stringify(b.doc),before,'the pending display must not edit the PGN');assert.equal(b.path,'');assert.equal(b.inputLocked,true);
   showsPosition(b,step.fen,'releasing a dragged piece must show it at its destination while the request is pending');
   b.renderBoard();showsPosition(b,step.fen,'a render must not restore the old position');
   windowStub.emit('blur');showsPosition(b,step.fen,'losing focus after the drop must not restore the old position');
   b.control('flip');showsPosition(b,step.fen,'flipping the board must preserve the pending move');
   gate.resolve(step);
   await settle();await settle();assert.equal(b.inputLocked,false);assert.equal(b.node().fen,step.fen);showsPosition(b,step.fen,'the accepted move must not jump back');
   assert.equal(document.body.children.length,0);assert.equal(b.doc.analysis_dirty,true);if(saved)assert.equal(b.doc.id,42);assert.equal(JSON.stringify(doc),before);b.dispose();
  }
 },
 async rejected_review_and_failed_request_restore_position(){
  let finish;const b=board({onMove:()=>new Promise(resolve=>{finish=resolve;})}),before=JSON.stringify(b.doc);
  drag(b,'e2','e4');showsPosition(b,f.opening.line.positions[0].fen);
  finish();await settle();showsPosition(b,f.opening.fen,'an incorrect review answer must restore the source position');assert.equal(JSON.stringify(b.doc),before);assert.equal(b.inputLocked,false);b.dispose();
  const failing=board(),gate=deferredFetch();drag(failing,'e2','e4');showsPosition(failing,f.opening.line.positions[0].fen);
  const originalError=console.error,originalTimeout=globalThis.setTimeout;console.error=()=>{};
  globalThis.setTimeout=(fn,ms,...args)=>{const timer=originalTimeout(fn,ms,...args);timer.unref?.();return timer;};
  try{gate.reject(new Error('Expected test request failure'));await settle();await settle();}finally{console.error=originalError;globalThis.setTimeout=originalTimeout;}
  showsPosition(failing,f.opening.fen,'a failed request must restore the source position');assert.equal(failing.inputLocked,false);assert.equal(failing.path,'');failing.dispose();
 },
 async pending_capture_castle_and_en_passant(){
  for(const name of ['capture','castle','enpassant']){
   const fixture=f[name],positions=fixture.line.positions,source=positions.length>1?positions.at(-2).fen:fixture.fen,step=positions.at(-1);
   const b=board({doc:makeDoc(source)}),before=JSON.stringify(b.doc),gate=deferredFetch();
   drag(b,step.uci.slice(0,2),step.uci.slice(2,4));
   showsPosition(b,step.fen,name+' must display all involved pieces correctly before the server reply');assert.equal(JSON.stringify(b.doc),before);
   gate.resolve(step);await settle();await settle();showsPosition(b,step.fen);assert.equal(b.node().fen,step.fen);b.dispose();
  }
 },
 async pending_promotion_choice_and_cancel(){
  const b=board({doc:makeDoc(f.promotion.fen)}),gate=deferredFetch();let choose;
  b.promotion=()=>new Promise(resolve=>{choose=resolve;});drag(b,'a7','a8');
  assert.equal(renderedPieces(b).a7,undefined);assert.equal(renderedPieces(b).a8,'P','the pawn stays at the drop square while choosing its promotion');assert.equal(gate.requests.length,0);
  choose('a7a8q');await settle();assert.equal(renderedPieces(b).a8,'Q');assert.equal(renderedPieces(b).a7,undefined);
  gate.resolve(f.promotion.line.positions[0]);await settle();await settle();showsPosition(b,f.promotion.line.positions[0].fen);b.dispose();
  const canceled=board({doc:makeDoc(f.promotion.fen)});canceled.promotion=()=>new Promise(resolve=>{choose=resolve;});drag(canceled,'a7','a8');assert.equal(renderedPieces(canceled).a8,'P');
  choose(null);await settle();showsPosition(canceled,f.promotion.fen,'closing the promotion chooser must restore the pawn');assert.equal(canceled.inputLocked,false);canceled.dispose();
 },
 async pending_move_cannot_replace_a_new_document(){
  for(const saved of [false,true]){
   const doc=makeDoc();if(saved)doc.id=42;
   const b=board({doc}),gate=deferredFetch();drag(b,'e2','e4');showsPosition(b,f.opening.line.positions[0].fen);
   const replacement=makeDoc(f.promotion.fen);await b.setDoc(replacement);showsPosition(b,replacement.nodes[0].fen);
   gate.resolve(f.opening.line.positions[0]);await settle();await settle();
   assert.equal(b.doc,replacement,'a late server response must not replace a newly loaded game');assert.equal(b.path,'');showsPosition(b,replacement.nodes[0].fen);b.dispose();
  }
  const b=board(),gate=deferredFetch();drag(b,'e2','e4');b.dispose();const displayed=b.host.board.innerHTML;
  gate.resolve(f.opening.line.positions[0]);await settle();await settle();assert.equal(b.host.board.innerHTML,displayed);assert.equal(document.body.children.length,0);
 }

};
const selected=process.argv[2];assert.ok(tests[selected],'unknown test '+selected);await tests[selected]();console.log(selected+' passed');
