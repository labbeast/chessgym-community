import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {TrainingHistoryView} from '../static/training-history.js';
import {setLanguage,t} from '../static/i18n.js';
import {makeDoc,appendLine} from '../static/chess-document.js';
import {ComputerHistoryView,computerHistoryRowsHtml,computerHistoryPaginationHtml,computerTimeControlLabel,computerCopySettingsHtml,personalComputerBases} from '../static/computer-history.js';

beforeEach(()=>setLanguage('fr'));
const game={id:'a',white:'Joueur',black:'Stockfish · Niveau 2',side:'white',result:'*',finished:false,moves:3,time_control:'600+5',created_at:'2026-10-24T10:00:00Z',copies:[]};
const host=()=>({innerHTML:'',classList:{add(){},remove(){}},querySelector:()=>null,querySelectorAll:()=>[]});
const document=()=>({id:'a',snapshot:{session:{position:{doc:appendLine(makeDoc(),'',[{uci:'e2e4',san:'e4',fen:'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'}]).doc,path:'0'},headers:{White:'Player',Black:'Engine',Result:'1-0'}}},result:'1-0',pgn:'retained pgn',finished_at:'2026-10-24T10:01:00Z'});

test('history shows participants, side, cadence, result and explicit resume for unfinished games',()=>{
 setLanguage('fr');const html=computerHistoryRowsHtml([game]);assert.match(html,/class="human">Joueur/);assert.match(html,/Stockfish · Niveau 2/);assert.match(html,/10 \+ 5/);assert.match(html,/>En cours</);assert.match(html,/data-history-resume="a"/);assert.match(html,/3 coups/);
 const finished=computerHistoryRowsHtml([{...game,finished:true,result:'0-1',reason:'resignation'}]);assert.doesNotMatch(finished,/data-history-resume/);assert.match(finished,/>0-1</);assert.match(finished,/title="Abandon"/);
});
test('history escapes archive values and never translates player data',()=>{
 setLanguage('en');const html=computerHistoryRowsHtml([{...game,id:'"<bad>',white:'Joueur <script>',black:'<img src=x>',time_control:'"<bad>'}]);assert.match(html,/Joueur &lt;script&gt;/);assert.doesNotMatch(html,/<script|<img|=""<bad/);assert(html.includes('>'+t('En cours')+'<'));setLanguage('fr');
});
test('time controls use minutes plus seconds, including short custom games',()=>{
 assert.equal(computerTimeControlLabel('300+2'),'5 + 2');assert.equal(computerTimeControlLabel('6+0'),'0,1 + 0');assert.equal(computerTimeControlLabel('-'),'Sans limite');assert.equal(computerTimeControlLabel({initial_ms:600000,increment_ms:5000}),'10 + 5');assert.equal(computerTimeControlLabel(null),'Sans limite');
});
test('copy settings exclude reference databases and require an explicit eligible destination',()=>{
 const bases=[{id:1,name:'My games'},{id:2,name:'Mega',reference:true},{id:3,name:'<Lessons>'}];assert.equal(personalComputerBases(bases).length,2);
 const html=computerCopySettingsHtml({auto_copy:true,base_id:2},bases);assert.doesNotMatch(html,/Mega|value="2"/);assert.match(html,/value="" selected/);assert.match(html,/&lt;Lessons&gt;/);assert.match(html,/name="base_id" required/);assert.match(html,/pas copiées rétroactivement/);
 const disabled=computerCopySettingsHtml({auto_copy:false,base_id:null},[]);assert.match(disabled,/name="auto_copy"  disabled/);assert.match(disabled,/Crée d’abord une base/);
});
test('pagination never suggests a next page when the last page is partial',()=>{
 const first=computerHistoryPaginationHtml({offset:0,limit:25,total:29});assert.match(first,/1–25 sur 29/);assert.match(first,/data-history-page="0" disabled/);assert.doesNotMatch(first,/data-history-page="25" disabled/);
 const last=computerHistoryPaginationHtml({offset:25,limit:25,total:29});assert.match(last,/26–29 sur 29/);assert.match(last,/data-history-page="50" disabled/);
});
test('archive analysis is a detached document without its library save identity',()=>{
 const view=new ComputerHistoryView(host()),archive=document(),original=JSON.stringify(archive);archive.snapshot.session.position.doc.id=7;archive.snapshot.session.position.doc.base_id=8;
 const doc=view.archiveDoc(archive);assert.equal(doc.id,undefined);assert.equal(doc.base_id,undefined);assert.equal(doc.headers.Result,'1-0');doc.nodes[0].comment='detached';assert.equal(archive.snapshot.session.position.doc.nodes[0].comment,'');assert.equal(doc.pgn,'retained pgn');assert.equal(original.includes('detached'),false);
});
test('analysis callback receives archived line and never requests an engine move',async()=>{
 const calls=[],archive=document();let analysed;const view=new ComputerHistoryView(host(),{request:async path=>{calls.push(path);return archive;},onAnalyse:value=>analysed=value});await view.analyse('a');assert.deepEqual(calls,['/api/computer/games/a']);assert.equal(analysed.path,'0');assert.equal(analysed.doc.nodes[1].san,'e4');assert.equal(analysed.doc.headers.Result,'1-0');
});
test('finished games cannot be resumed; an unfinished game passes a detached snapshot',async()=>{
 const archive=document();let resumed,viewed=0;const view=new ComputerHistoryView(host(),{request:async()=>archive,onResume:value=>resumed=value});view.view=async()=>viewed++;
 await view.resume('a');assert.equal(viewed,1);assert.equal(resumed,undefined);archive.finished_at=null;archive.result='*';await view.resume('a');assert(resumed);resumed.session.headers.White='Changed';assert.equal(archive.snapshot.session.headers.White,'Player');
});
test('disposal and newer page requests cannot be overwritten by late responses',async()=>{
 const responses=[];let signal;const view=new ComputerHistoryView(host(),{request:async(url,options)=>{signal=options.signal;return new Promise(resolve=>responses.push(resolve));}});let rendered=0;view.renderList=()=>{view.historyView=new TrainingHistoryView(host(),{tool:'computer',request:view.request});view.historyView.render=()=>rendered++;};
 const first=view.load(0),second=view.load(25);responses[1]({items:[{...game,id:'latest'}],total:30,limit:25});await second;responses[0]({items:[game],total:30,limit:25});await first;assert.equal(view.historyView.items[0].id,'latest');
 const pending=view.load();const before=rendered;view.dispose();assert(signal.aborted);responses[2]({items:[game],total:1,limit:25});await pending;assert.equal(rendered,before);
});
test('archive fetch completion after leaving cannot call resume or analysis',async()=>{
 let resolve,calls=0;const view=new ComputerHistoryView(host(),{request:()=>new Promise(done=>resolve=done),onAnalyse:()=>calls++});const pending=view.analyse('a');view.dispose();resolve(document());await pending;assert.equal(calls,0);
});
test('an emptied final page returns to the last available page',async()=>{
 const pages=[];const view=new ComputerHistoryView(host(),{request:async path=>{pages.push(path);return pages.length===1?{items:[],total:24,limit:25}:{items:[game],total:24,limit:25};}});view.renderList=()=>{view.historyView=new TrainingHistoryView(host(),{tool:'computer',request:view.request});view.historyView.render=()=>{};};await view.load(25);assert.equal(view.offset,0);assert.equal(view.historyView.items.length,1);assert.equal(pages.length,2);
});

test('deleted library copies do not show a live copied badge',()=>{
 const deleted=computerHistoryRowsHtml([{...game,copies:[{base_id:1,entry_id:null}]}]);assert.doesNotMatch(deleted,/✓|Déjà copiée dans/);
 const present=computerHistoryRowsHtml([{...game,copies:[{base_id:1,entry_id:null},{base_id:2,entry_id:8}]}]);assert.match(present,/✓/);assert.match(present,/Déjà copiée dans 1 base/);
});

test('single move counts are grammatically singular',()=>{assert.match(computerHistoryRowsHtml([{...game,moves:1}]),/1 coup</);setLanguage('en');assert.match(computerHistoryRowsHtml([{...game,moves:1}]),/1 move</);});
