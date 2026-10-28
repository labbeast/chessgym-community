import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {START} from '../static/api.js';
import {setLanguage} from '../static/i18n.js';
import {draftManagerModel,draftManagerHtml} from '../static/draft-manager.js';

beforeEach(()=>setLanguage('fr'));
const doc=(identity,overrides={})=>({...(typeof identity==='number'?{id:identity,base_id:7}:{workspace_id:identity}),headers:{Result:'*'},nodes:[{path:'',fen:START,comment:'',nags:[],children:[]}],...overrides});
const store=records=>({items:new Map(records.map(([key,data,extra={}])=>[key,{data,updated_at:'2026-10-25T12:00:00Z',...extra}])),get(key){return this.items.get(key)?.data??null;},info(key){return this.items.get(key)||{};}});

test('all drafts appear once with document snapshots preferred and current first',()=>{
 const current=doc(7,{analysis_dirty:true,title:'Saved draft'}),other=doc('free-one',{title:'Free draft'});
 const s=store([['analysis',{doc:current}],['document:entry:7',{doc:current}],['document:free:free-one',{doc:other}],['view:entry:7',{draftLabel:'Custom name'}],...Array.from({length:25},(_,i)=>['document:free:draft-'+i,{doc:doc('draft-'+i,{title:'Draft '+i})}])]);
 const before=JSON.stringify([...s.items]),rows=draftManagerModel({store:s,doc:current});
 assert.equal(rows.length,27);assert.equal(rows[0].key,'document:entry:7');assert.equal(rows[0].current,true);assert.equal(rows[0].title,'Custom name');assert.equal(rows.filter(row=>row.identity==='entry:7').length,1);assert.equal(JSON.stringify([...s.items]),before);
});

test('pristine boards, intact saved games and activity snapshots are excluded',()=>{
 const clean=doc(3,{analysis_dirty:false}),s=store([['document:free:empty',{doc:doc('empty')}],['document:entry:3',{doc:clean}],['analysis',{doc:{...clean,analysis_dirty:true}}],['review',{base:{id:1},cards:[{}],index:0}],['computer',{session:{}}]]);
 assert.deepEqual(draftManagerModel({store:s}),[]);
});

test('saved legacy analysis, drawings, and annotation-only changes remain recoverable',()=>{
 const s=store([['analysis',{doc:doc(4,{analysis_dirty:true})}],['document:free:drawing',{doc:doc('drawing'),drawings:[{from:'e2',to:'e4'}]}],['document:entry:6',{doc:doc(6)}],['annotation:entry:6',{nodes:{'':{comment:'Unapplied note'}}}]]);
 assert.deepEqual(new Set(draftManagerModel({store:s}).map(row=>row.key)),new Set(['analysis','document:free:drawing','document:entry:6']));
 const legacy=store([['analysis',{doc:{headers:{Result:'*'},nodes:[{path:'',fen:START,comment:'Old free draft'}]}}]]);
 assert.equal(draftManagerModel({store:legacy})[0].key,'analysis');
});

test('conflicted analysis versions stay accessible and unrelated conflicts stay outside the manager',()=>{
 const s=store([['document:entry:2',{doc:doc(2)},{conflict:{data:{doc:doc(2,{analysis_dirty:true})}}}],['document:free:empty',{doc:doc('empty')},{conflict:{data:{doc:doc('empty',{title:'Remote work'})}}}],['review',{base:{id:7}},{conflict:{data:{}}}],['computer',{session:{}},{conflict:{data:{}}}]]);
 const rows=draftManagerModel({store:s}),html=draftManagerHtml(rows);
 assert.equal(rows.length,2);assert.match(html,/data-resolve-key="document:entry:2"/);assert.match(html,/data-resolve-key="document:free:empty"/);assert.doesNotMatch(html,/data-resolve-key="review"|data-resolve-key="computer"/);
});

test('manager escapes user content, renders a direct bilingual list, and has a useful empty state',()=>{
 const s=store([['document:free:one',{doc:doc('one',{title:'<script>Title</script>'})}]]);
 const rows=draftManagerModel({store:s}),html=draftManagerHtml(rows);
 assert.match(html,/&lt;script&gt;Title&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>|<details|data-resume-/);assert.match(html,/data-workspace-document="document:free:one"/);assert.match(html,/data-delete-workspace="document:free:one"/);assert.match(html,/aria-label="Supprimer le brouillon[^\"]*&lt;script&gt;Title&lt;\/script&gt;[^\"]*"/);assert.match(html,/>×<\/button>/);
 setLanguage('en');assert.match(draftManagerHtml([]),/No saved drafts/);
 const english=draftManagerHtml(rows);assert.match(english,/aria-label="Delete[^\"]*&lt;script&gt;Title&lt;\/script&gt;[^\"]*"/);assert.match(english,/>×<\/button>/);assert.doesNotMatch(english,/>Delete<\/button>/);
});

test('a remote-only document conflict remains visible for explicit recovery',()=>{
 const s=store([['document:free:remote',null,{conflict:{data:{doc:doc('remote',{title:'Remote work'})}}}]]);
 const rows=draftManagerModel({store:s}),html=draftManagerHtml(rows);assert.equal(rows.length,1);assert.equal(rows[0].title,'Remote work');assert.equal(rows[0].available,false);assert.match(html,/data-resolve-key="document:free:remote"/);assert.match(html,/data-workspace-document="document:free:remote" disabled/);assert.match(html,/data-delete-workspace="document:free:remote" disabled/);
});
