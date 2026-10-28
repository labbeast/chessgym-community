import test from 'node:test';
import assert from 'node:assert/strict';
import {PreferencesService} from '../static/preferences-store.js';
import {WorkspaceStore} from '../static/workspace-store.js';
import {persistAnalysisSnapshot,analysisSnapshot,draftKeys} from '../static/workspace-drafts.js';
import {makeDoc,appendLine,nodeIndex} from '../static/chess-document.js';
import {renderAnalysisMovesInto} from '../static/analysis-moves.js';
import {EntryTable} from '../static/entry-table.js';
import {TestNode} from './metadata_dom.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
const memory=()=>{const data=new Map(),writes=[];return {data,writes,getItem:key=>data.get(key)||null,setItem:(key,value)=>{writes.push({key,value});data.set(key,value);},removeItem:key=>data.delete(key)};};

test('preferences serialize independent partial writes, recover after failure, isolate accounts',async()=>{
 const gate=deferred(),calls=[],service=new PreferencesService({request:async(url,options)=>{calls.push(options.body);if(calls.length===1)return gate.promise;return options.body;}});
 service.open('alice',{initial:{theme:'copper',review_defaults:{hard:2,easy:10}}});
 const one=service.patch({theme:'sage'}),two=service.patch({review_defaults:{hard:3}});await tick();assert.equal(calls.length,1);gate.reject(Error('offline'));await assert.rejects(one);await two;
 assert.deepEqual(service.get().review_defaults,{hard:3,easy:10});
 const late=deferred();service.request=()=>late.promise;const pending=service.patch({language:'en'});await tick();service.open('bob',{initial:{language:'fr'}});late.resolve({language:'en'});assert.equal(await pending,null);assert.equal(service.get().language,'fr');
});

test('workspace migration preserves CAS metadata and cursor writes never rewrite document or unrelated slots',async()=>{
 const storage=memory();storage.data.set('chessgym-workspace-v1:alice',JSON.stringify({review:{key:'review',revision:9,version:2,dirty:true,data:{note:'x'.repeat(100000)}}}));
 const store=new WorkspaceStore({storage,delay:100000});await store.open('alice');assert.equal(store.items.get('review').revision,9);
 const doc=makeDoc();doc.workspace_id='test';doc.nodes[0].comment='note';persistAnalysisSnapshot(store,doc,{path:'',arrows:3},{draft:true});
 storage.writes.length=0;for(let i=0;i<100;i++)persistAnalysisSnapshot(store,doc,{path:String(i),arrows:3},{draft:true});
 assert.equal(storage.writes.filter(write=>write.key.includes('document%3A')||write.key.includes('review')).length,0);
 assert(storage.writes.reduce((sum,write)=>sum+write.value.length,0)<50000);
 const second=new WorkspaceStore({storage});await second.open('alice');assert.equal(analysisSnapshot(second).path,'99');assert.equal(analysisSnapshot(second).doc.nodes[0].comment,'note');assert(draftKeys(second,'document:free:test').includes('view:free:test'));
 await second.open('alice',{namespace:'restored'});assert.equal(second.get('review'),null);store.close();second.close();
});

test('move cursor reuses buttons and comments while content and engine report changes rebuild',()=>{
 const doc=makeDoc(),fen='rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
 const extended=appendLine(doc,'',[{uci:'e2e4',san:'e4',fen}]).doc;extended.nodes[1].comment='Révisions Bien';const host=new TestNode();
 renderAnalysisMovesInto(host,extended,'');const button=host.querySelector('[data-path="0"]'),comment=host.querySelector('[data-comment-path="0"]');
 const result=renderAnalysisMovesInto(host,extended,'0');assert.equal(result.changed,false);assert.equal(host.querySelector('[data-path="0"]'),button);assert(button.attrs.class.split(' ').includes('current'));assert(comment.attrs.class.split(' ').includes('analysis-current-comment'));
 assert.equal(renderAnalysisMovesInto(host,extended,'0',{positions:[]}).changed,true);assert.notEqual(host.querySelector('[data-path="0"]'),button);assert.equal(nodeIndex(extended),nodeIndex(extended));
});

test('remote table keeps multi-page selections and revisions; stale responses cannot replace current filters',async()=>{
 const host=new TestNode(),calls=[],gate=deferred();let mode='page';
 const table=new EntryTable(host,{base:{id:1,name:'Base',settings:{}},remote:{endpoint:'/api/bases/1/entries'},request:async(url,options)=>{
  calls.push({url,options});if(options?.method)return {count:options.body.entry_ids.length};if(mode==='deferred')return gate.promise;
  const offset=Number(new URL(url,'http://test').searchParams.get('offset'));return {entries:[{id:offset+1,title:'Game',revision:'rev'+offset,headers:{}}],offset,total:101,total_all:101,selected_total:0,has_more:offset<100};
 },notify:()=>{},onError:error=>{throw error;}});
 await table.loadPage(0);table.selection.add(1);table.renderRows();await table.loadPage(50);table.selection.add(51);table.renderRows();assert.deepEqual(table.selectedIds,[1,51]);
 await table.runBatch({action:'review',entry_ids:table.selectedIds,selected:true});assert.deepEqual(calls.at(-1).options.body.expected_revisions,{'1':'rev0','51':'rev50'});
 mode='deferred';const stale=table.loadPage(100);await tick();mode='page';table.query='new';await table.loadPage(0);gate.resolve({entries:[{id:999,headers:{}}],offset:100,total:101});await stale;assert.equal(table.entries[0].id,1);assert(calls.at(-1).url.includes('search=new'));table.dispose();
});


test('a corrupt local slot preserves its raw copy and all valid unsynced drafts',async()=>{
 const storage=memory(),prefix='chessgym-workspace-v1:alice';
 storage.data.set(prefix,JSON.stringify({format:2,keys:['analysis','review']}));
 storage.data.set(prefix+':slot:analysis',JSON.stringify({key:'analysis',revision:5,version:2,dirty:true,data:{note:'keep'}}));
 storage.data.set(prefix+':slot:review','{broken json');
 const store=new WorkspaceStore({storage});await store.open('alice');
 assert.equal(store.get('analysis').note,'keep');assert.equal(store.items.get('analysis').revision,5);assert(store.info('analysis').error);
 store.set('analysis',{note:'new note'});assert.equal(storage.data.get(prefix+':slot:review'),'{broken json');
 assert.deepEqual(JSON.parse(storage.data.get(prefix)).keys.sort(),['analysis','review']);
 const other=new WorkspaceStore({storage});await other.open('alice');assert.equal(other.get('analysis').note,'new note');assert(other.localError);store.close();other.close();
});

test('a corrupt manifest is not silently replaced; deleted valid remote slots are cleaned',async()=>{
 const storage=memory(),prefix='chessgym-workspace-v1:alice';storage.data.set(prefix,'{broken manifest');
 const store=new WorkspaceStore({storage});await store.open('alice');store.set('analysis',{note:'in memory'});
 assert.equal(storage.data.get(prefix),'{broken manifest');assert(store.localError);assert.equal(store.get('analysis').note,'in memory');store.close();
 storage.data.set(prefix,JSON.stringify({format:2,keys:['analysis']}));storage.data.set(prefix+':slot:analysis',JSON.stringify({key:'analysis',revision:5,version:0,dirty:false,data:{note:'remote removed'}}));
 const remote=new WorkspaceStore({storage,request:async()=>({items:[]})});await remote.open('alice',{remote:true});
 assert.equal(remote.get('analysis'),null);assert.equal(storage.data.has(prefix+':slot:analysis'),false);assert.deepEqual(JSON.parse(storage.data.get(prefix)).keys,[]);remote.close();
});
