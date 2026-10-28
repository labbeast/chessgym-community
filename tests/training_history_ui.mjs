import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage,t} from '../static/i18n.js';
import {openTrainingHistory,TrainingHistoryView,TRAINING_HISTORY_TOOLS,historyDuration,historyDate,trainingHistoryRowsHtml,trainingHistoryDetailHtml,trainingHistoryPaginationHtml} from '../static/training-history.js';
import translations from '../static/locales/en-training-history.js';

beforeEach(()=>setLanguage('fr'));
const host=()=>({innerHTML:'',classList:{add(){},remove(){}},querySelector:()=>null,querySelectorAll:()=>[]});
const row=(overrides={})=>({id:'12',key:'review:12',tool:'review',unit:'answer',title:'Training example',started_at:'2026-10-24T18:30:00Z',finished_at:'2026-10-24T18:32:00Z',duration_ms:120000,duration_kind:'active',status:'completed',outcome:'success',completed_count:1,total_count:1,score:null,maximum:null,metrics:{},...overrides});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

test('history distinguishes missing duration from a genuine zero and uses concise units',()=>{
 assert.equal(historyDuration(null),'—');assert.equal(historyDuration(undefined),'—');assert.equal(historyDuration('bad'),'—');assert.equal(historyDuration(0),'0 s');assert.equal(historyDuration(1500),'2 s');assert.equal(historyDuration(245),'0,25 s');assert.equal(historyDuration(62300),'1 min 2 s');assert.equal(historyDuration(3660000),'1 h 1 min');assert.equal(historyDuration(-5),'0 s');assert.equal(historyDate('bad'),'—');
});
test('shared rows show contextual activity, duration and result without inventing a session',()=>{
 const html=trainingHistoryRowsHtml([row({metrics:{base_name:'Endgames'}})]);
 assert.match(html,/>Réponse</);assert.match(html,/Training example/);assert.match(html,/Révisions · Endgames/);assert.match(html,/2 min 0 s/);assert.match(html,/Temps actif/);assert.match(html,/>Réussi</);assert.match(html,/data-training-detail="0"/);assert.doesNotMatch(html,/data-training-open/);
 const unknown=trainingHistoryRowsHtml([row({duration_ms:null,duration_kind:'unknown',tool:'color',status:'active',outcome:'unknown',score:0,maximum:20})],{onOpen:true});assert.match(unknown,/Durée non mesurée/);assert.match(unknown,/>En cours</);assert.match(unknown,/0 \/ 20 points/);assert.match(unknown,/data-training-open/);
});
test('titles, engine names, event actions and answers remain escaped user data',()=>{
 const html=trainingHistoryRowsHtml([row({title:'<script>bad()</script>',metrics:{base_name:'<img src=x>'}})]);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script|<img/);
 const details=trainingHistoryDetailHtml({item:row({title:'"<bad>'}),details:{white:'<script>',answer:'<b>'},events:[{action:'<img>',result:'" onload=1',details:{answer:'<svg onload=x>'}}]});assert.doesNotMatch(details,/<script|<img|<svg|onload=1/);assert.match(details,/&lt;svg onload=x&gt;/);
});
test('review grades are zero based and unknown fields never dump raw state objects',()=>{
 for(const [grade,label] of [[0,'Manqué'],[1,'Difficile'],[2,'Bien'],[3,'Facile']])assert.match(trainingHistoryDetailHtml({item:row(),details:{grade}}),new RegExp('>'+label+'<'));
 const html=trainingHistoryDetailHtml({item:row(),details:{state:{secret:'unexpected'},solve_success:false,reconstruction_success:true,accuracy:87.5}});assert.doesNotMatch(html,/secret|unexpected|object Object/);assert.match(html,/Position reconstruite/);assert.match(html,/>Oui</);assert.match(html,/>Non</);assert.match(html,/87,5 %/);
});
test('reading is selectable and translation dictionary covers the common history vocabulary',()=>{
 assert.equal(TRAINING_HISTORY_TOOLS.reading,'Lecture');setLanguage('en');for(const key of ['Historique des entraînements','Durée non mesurée','Aucune activité pour ces filtres','Résultat partiel','Afficher la suite'])assert.notEqual(t(key),key);
});
test('filters reset paging, encode search safely and send the users calendar timezone',async()=>{
 let url;const view=new TrainingHistoryView(host(),{request:async value=>{url=value;return {items:[],total:0,limit:25};}});view.offset=50;
 await view.setFilters({tool:'guess',status:'completed',outcome:'success',date_from:'2026-10-01',date_to:'2026-10-24',q:' rook & ending '});const query=new URL(url,'http://localhost').searchParams;
 assert.equal(query.get('offset'),'0');assert.equal(query.get('tool'),'guess');assert.equal(query.get('q'),'rook & ending');assert.equal(query.get('date_from'),'2026-10-01');assert.equal(query.get('time_zone'),Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC');
});
test('locked tool and restricted puzzle selector cannot leak unrelated tools into requests',async()=>{
 const urls=[];const request=async url=>{urls.push(url);return {items:[],total:0};};
 const locked=new TrainingHistoryView(host(),{tool:'color',request});await locked.setFilters({tool:'review'});assert.equal(new URL(urls.at(-1),'http://x').searchParams.get('tool'),'color');assert.doesNotMatch(locked.filterHtml(),/data-training-filter="tool"/);
 const puzzles=new TrainingHistoryView(host(),{tool:'puzzles',tools:['puzzles','storm'],request});await puzzles.setFilters({tool:'storm'});assert.equal(new URL(urls.at(-1),'http://x').searchParams.get('tool'),'storm');await puzzles.setFilters({tool:'computer'});assert.equal(new URL(urls.at(-1),'http://x').searchParams.get('tool'),'puzzles');assert.doesNotMatch(puzzles.filterHtml(),/value="computer"/);
});
test('inverted dates do not issue an API call or change the last applied filters',async()=>{
 let calls=0;const view=new TrainingHistoryView(host(),{request:async()=>{calls++;return {};}});await view.setFilters({date_from:'2026-11-01',date_to:'2026-10-01'});assert.equal(calls,0);assert.equal(view.filters.date_from,'');assert.match(view.error,/date de début/);
});
test('a newer list response wins and dispose aborts in-flight list without late DOM changes',async()=>{
 const pending=[],signals=[];const view=new TrainingHistoryView(host(),{request:async(url,options)=>{signals.push(options.signal);const d=deferred();pending.push(d);return d.promise;}});
 const first=view.load(),second=view.load(25);assert(signals[0].aborted);pending[1].resolve({items:[row({title:'new'})],total:30,limit:25});await second;pending[0].resolve({items:[row({title:'old'})],total:30,limit:25});await first;assert.equal(view.items[0].title,'new');
 const third=view.load();const html=view.host.innerHTML;view.dispose();assert(signals[2].aborted);pending[2].resolve({items:[],total:0});await third;assert.equal(view.host.innerHTML,html);
});
test('an empty last page recovers and pagination keeps next disabled when finished',async()=>{
 const calls=[];const view=new TrainingHistoryView(host(),{request:async url=>{calls.push(url);return calls.length===1?{items:[],total:24,limit:25}:{items:[row()],total:24,limit:25};}});await view.load(25);assert.equal(calls.length,2);assert.equal(view.offset,0);
 const html=trainingHistoryPaginationHtml({offset:25,limit:25,total:29});assert.match(html,/26–29 sur 29/);assert.match(html,/data-training-page="50" disabled/);
});
test('late detail cannot replace a newly selected row or reappear after filtering',async()=>{
 const pending=[];const view=new TrainingHistoryView(host(),{request:async()=>{const d=deferred();pending.push(d);return d.promise;}});
 const a=row(),b=row({id:'13',key:'review:13'});view.items=[a,b];const first=view.showDetail(a),second=view.showDetail(b);pending[1].resolve({item:b,details:{grade:3},events:[]});await second;pending[0].resolve({item:a,details:{grade:0},events:[]});await first;assert.equal(view.detail.item.id,'13');
 const next=view.showDetail(a),list=view.load();pending[3].resolve({items:[],total:0});await list;pending[2].resolve({item:a,details:{grade:2},events:[]});await next;assert.equal(view.detail,null);
});
test('detail events can all be loaded without repeating page one',async()=>{
 const calls=[];const item=row({tool:'color',id:'color id',key:'color:color id'}),view=new TrainingHistoryView(host(),{request:async url=>{calls.push(url);return {item,events:[{action:'b2',result:'success'}],event_count:2,events_truncated:false,next_events_offset:null};}});
 view.detail={item,events:[{action:'a1',result:'success'}],event_count:2,events_truncated:true,next_events_offset:1};view.detailKey=item.key;
 assert.match(trainingHistoryDetailHtml(view.detail),/data-training-events-more/);await view.loadMoreEvents();assert.equal(view.detail.events.length,2);assert.match(calls[0],/color%20id\?events_offset=1&events_limit=100/);assert.doesNotMatch(trainingHistoryDetailHtml(view.detail),/data-training-events-more/);await view.loadMoreEvents();assert.equal(calls.length,1);
});
test('late event page cannot attach to another selected activity',async()=>{
 const d=deferred(),view=new TrainingHistoryView(host(),{request:()=>d.promise});view.detail={item:row(),events:[{action:'a'}],next_events_offset:1};view.detailKey='review:12';const loading=view.loadMoreEvents();view.clearDetail();d.resolve({item:row(),events:[{action:'b'}],next_events_offset:null});await loading;assert.equal(view.detail,null);
});
test('source open is explicit, detached and suppressed after dispose or list navigation',async()=>{
 const d=deferred();let opened=0;const item=row(),view=new TrainingHistoryView(host(),{request:()=>d.promise,onOpen:()=>opened++});const pending=view.open(item);view.dispose();d.resolve({item,details:{},events:[]});await pending;assert.equal(opened,0);
 const detail={item,details:{grade:2},events:[]},ready=new TrainingHistoryView(host(),{request:async()=>detail,onOpen:(record,value)=>{record.title='changed';value.details.grade=0;opened++;}});await ready.open(item);assert.equal(opened,1);assert.equal(item.title,'Training example');assert.equal(detail.details.grade,2);
});
test('network errors preserve usable filters and show a retry instead of fabricated empty results',async()=>{
 const view=new TrainingHistoryView(host(),{tool:'review',request:async()=>{throw new Error('offline');}});await view.load();assert.match(view.host.innerHTML,/offline/);assert.match(view.host.innerHTML,/Historique indisponible/);assert.match(view.host.innerHTML,/data-training-refresh/);assert.equal(view.filters.tool,'review');
});

test('blindfold details preserve exact reconstructed pieces and omit technical source paths',()=>{
 const html=trainingHistoryDetailHtml({item:row({tool:'blindfold'}),details:{first_path:'0.0',first_ply:2,entry_id:123,solve_success:1,reconstruction_success:0},events:[{action:'Reconstitution finale',result:'failure',details:{expected:{a1:'K',e2:'P'},proposed:{a1:'K',e3:'P'},missing:[{square:'e2',piece:'P'}],misplaced:[{square:'e3',piece:'P',expected:null}]}}]});
 assert.match(html,/♔ a1 · ♙ e2/);assert.match(html,/♔ a1 · ♙ e3/);assert.match(html,/♙ e3 \(attendu : vide\)/);assert.doesNotMatch(html,/entry_id|first_path|>0\.0</);assert.match(html,/>Oui</);assert.match(html,/>Non</);
});
test('review grades are shown as grades instead of invented quiz points',()=>{
 const html=trainingHistoryRowsHtml([row({score:1,maximum:3,metrics:{grade:1}})]);assert.match(html,/>Difficile</);assert.doesNotMatch(html,/1 \/ 3 points/);
});

test('history translations preserve existing engine and review vocabulary',()=>{
 setLanguage('en');const html=trainingHistoryRowsHtml([row({score:1,maximum:3,metrics:{grade:1}})]);assert.match(html,/>Hard</);assert.match(html,/>Answer</);assert.match(html,/Reviews/);assert.equal(translations['Évaluation'],undefined);assert.equal(translations['Manqué'],undefined);assert.equal(translations['En cours'],undefined);
});

test('computer outcomes say win or loss rather than puzzle solved',()=>{
 setLanguage('en');const won=trainingHistoryRowsHtml([row({tool:'computer',unit:'game',outcome:'success'})]),lost=trainingHistoryRowsHtml([row({tool:'computer',unit:'game',outcome:'failure'})]);assert.match(won,/>Victory</);assert.match(lost,/>Defeat</);assert.doesNotMatch(won,/Solved/);
});
test('reading progress is labeled cumulative and never invented as visit volume',()=>{
 const html=trainingHistoryRowsHtml([row({tool:'reading',unit:'visit',completed_count:null,total_count:null,metrics:{progress:35}})]);assert.match(html,/>Visite</);assert.match(html,/Progression de la partie : 35 %/);assert.doesNotMatch(html,/coups lus/);
});

test('history dialog is immediately owned and closing aborts its pending load',async()=>{
 const previous=globalThis.document,pending=deferred(),content=host();let signal,removed=false;const listeners={};
 const dialog={innerHTML:'',open:false,querySelector:selector=>selector==='[data-history-dialog-host]'?content:null,querySelectorAll:()=>[],addEventListener:(name,handler)=>listeners[name]=handler,showModal(){this.open=true;},close(){this.open=false;listeners.close?.();},remove(){removed=true;}};
 globalThis.document={createElement:()=>dialog,body:{append(){}},documentElement:{}};
 try{
  const result=await openTrainingHistory({tool:'color',request:(url,options)=>{signal=options.signal;return pending.promise;}});assert.equal(result,dialog);assert(dialog.open);const loadingHtml=content.innerHTML;dialog.close();assert(signal.aborted);assert(removed);pending.resolve({items:[row()],total:1});await Promise.resolve();await Promise.resolve();assert.equal(content.innerHTML,loadingHtml);
 }finally{globalThis.document=previous;}
});

test('archived experiments keep details without a launch action',async()=>{
 const archived=row({tool:'guess',open_available:false,metrics:{mode:'mix',delta_cp:120}});
 const html=trainingHistoryRowsHtml([archived],{onOpen:true});
 assert.match(html,/data-training-detail/);assert.doesNotMatch(html,/data-training-open/);
 let opened=false;const view=new TrainingHistoryView(host(),{onOpen:()=>{opened=true;}});
 await view.open(archived);assert.equal(opened,false);
});
