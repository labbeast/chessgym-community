import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {START} from '../static/api.js';
import {setLanguage} from '../static/i18n.js';
import {boardRecentMetadata,boardMenuModel,boardMenuHtml,boardRelativeDate} from '../static/board-menu.js';
import {uiIcon} from '../static/ui-icons.js';
import translations from '../static/locales/en-board-menu.js';

beforeEach(()=>setLanguage('fr'));
const stamp='2026-10-25T14:00:00.000Z';
const bases=[{id:7,name:'Répertoire blanc'},{id:8,name:'Références'}];
const doc=(id=5,overrides={})=>({id,base_id:id?7:null,workspace_id:id?undefined:'free-one',title:id?'Partie exemple':'',headers:{Result:'*'},nodes:[{path:'',fen:START,children:[],comment:'',nags:[]}],...overrides});
const store=(records=[])=>({items:new Map(records.map(([key,data,updated_at=stamp,extra={}])=>[key,{data,updated_at,...extra}])),get(key){return structuredClone(this.items.get(key)?.data??null);},info(key){return {dirty:!!this.items.get(key)?.dirty,conflict:this.items.get(key)?.conflict};},set(){assert.fail('model must not write');},remove(){assert.fail('model must not remove');}});

test('metadata identifies base and one-based position in the current filtered order',()=>{
 const d=doc(5),metadata=boardRecentMetadata(d,{baseId:7,ids:[3,5,9]},bases,stamp);
 assert.deepEqual(metadata,{identity:'entry:5',entryId:5,baseId:7,title:'Partie exemple',baseName:'Répertoire blanc',index:2,total:3,openedAt:stamp});
 const remote=boardRecentMetadata(d,{baseId:7,remote:{},currentId:5,index:100,total:200},bases,stamp);assert.equal(remote.index,101);assert.equal(remote.total,200);
 const mismatch=boardRecentMetadata(d,{baseId:8,ids:[5]},bases,stamp);assert.equal(mismatch.index,null);assert.equal(mismatch.total,null);
});
test('reference-source drafts keep their library context',()=>{
 const metadata=boardRecentMetadata(doc(null,{reference_source:{base_id:8,game_id:99},title:'Reference game'}),null,bases,stamp);assert.equal(metadata.baseId,8);assert.equal(metadata.baseName,'Références');assert.equal(metadata.identity,'free:free-one');
});
test('a pristine current board is free analysis without a draft badge',()=>{
 const model=boardMenuModel({store:store(),doc:doc(null),bases});assert.equal(model.current.title,'Analyse libre');assert.equal(model.current.draft,false);assert.deepEqual(model.recents,[]);assert.doesNotMatch(boardMenuHtml(model),/board-recent-draft/);
});
test('free diagrams, annotations and changed headers count as real drafts',()=>{
 for(const change of [{nodes:[{path:'',fen:START,comment:'An idea'}]},{headers:{Event:'My study'}},{title:'My analysis'},{nodes:[{path:'',fen:'diagram'}]}])assert.equal(boardMenuModel({store:store(),doc:doc(null,change)}).current.draft,true);
 const current=doc(null),s=store([['annotation:free:free-one',{nodes:{'':{comment:'Unapplied'}}}]]);assert.equal(boardMenuModel({store:s,doc:current}).current.draft,true);assert.equal(current.nodes[0].comment,'');
});
test('saved records require chess edits or unapplied annotations, never sync dirtiness',()=>{
 const d=doc(),s=store([['view:entry:5',{path:'0'},stamp,{dirty:true}],['document:entry:5',{doc:d},stamp,{dirty:true}]]);assert.equal(boardMenuModel({store:s,doc:d}).current.draft,false);
 s.items.set('annotation:entry:5',{data:{nodes:{'':{comment:'Unapplied'}}}});assert.equal(boardMenuModel({store:s,doc:d}).current.draft,true);s.items.delete('annotation:entry:5');assert.equal(boardMenuModel({store:s,doc:{...d,analysis_dirty:true}}).current.draft,true);
 s.items.set('annotation:entry:5',{data:{nodes:{}},conflict:{data:{nodes:{'':{comment:'remote'}}}}});assert.equal(boardMenuModel({store:s,doc:d}).current.draft,true);
});
test('compact saved recents remain available without any PGN document snapshot',()=>{
 const meta=boardRecentMetadata(doc(9,{title:'Compact title'}),{baseId:7,ids:[9,5]},bases,stamp),s=store([['view:entry:9',{boardRecent:meta}]]);const item=boardMenuModel({store:s,doc:doc(),bases}).recents[0];assert.equal(item.identity,'entry:9');assert.equal(item.title,'Compact title');assert.equal(item.index,1);assert.equal(item.snapshotKey,null);assert.equal(item.draft,false);
});
test('legacy views keep an entry fallback and their base/list context',()=>{
 const s=store([['view:entry:9',{entryNavigation:{baseId:7,ids:[5,9,12]}}]]),item=boardMenuModel({store:s,doc:doc(),bases}).recents[0];assert.equal(item.title,'Partie 9');assert.equal(item.baseName,'Répertoire blanc');assert.equal(item.index,2);assert.equal(item.total,3);
});
test('current identity is excluded; snapshot/view/analysis copies deduplicate and sort by actual visit date',()=>{
 const s=store([
  ['view:entry:5',{boardRecent:boardRecentMetadata(doc(5),null,bases,stamp)}],
  ['view:entry:9',{boardRecent:boardRecentMetadata(doc(9),null,bases,'2026-10-24T12:00:00Z')}],
  ['document:entry:9',{doc:doc(9,{analysis_dirty:true})},'2026-10-26T12:00:00Z'],
  ['analysis',{doc:doc(9)}],
  ['view:entry:12',{boardRecent:boardRecentMetadata(doc(12),null,bases,stamp)}],
 ]);const model=boardMenuModel({store:s,doc:doc(5),bases});assert.deepEqual(model.recents.map(x=>x.identity),['entry:12','entry:9']);assert.equal(model.recents[1].draft,true);assert.equal(model.recents[1].snapshotKey,'document:entry:9');assert.equal(model.recents[1].openedAt,'2026-10-24T12:00:00.000Z');
});
test('recent list starts with one current board and preserves its dedicated return action',()=>{
 const s=store([
  ['view:entry:5',{boardRecent:boardRecentMetadata(doc(5),null,bases,stamp)}],
  ['document:entry:5',{doc:doc(5)}],
  ['view:entry:9',{boardRecent:boardRecentMetadata(doc(9),null,bases,stamp)}],
 ]);
 for(const current of [doc(5),doc(5,{analysis_dirty:true}),doc(null)]){
  const model=boardMenuModel({store:s,doc:current,bases}),html=boardMenuHtml(model,{now:Date.parse(stamp)});
  const list=html.match(/<div class="board-recent-list">([^]*?)<\/details>/)?.[1];
  assert(list,'The recent list remains present even for an empty current analysis');
  const rows=[...list.matchAll(/<button\b[^>]*class="board-recent-row[^\"]*"[^>]*>[^]*?<\/button>/g)].map(match=>match[0]);
  assert.equal((html.match(/data-board-command="current"/g)||[]).length,1);
  assert.match(rows[0],/data-board-command="current"/);
  assert.match(rows[0],/board-recent-current/);
  assert.equal(rows.length,model.recents.length+1);
  assert(!html.includes('data-board-recent="'+model.current.identity+'"'),'The active board must not reopen through the snapshot restore path');
  assert.doesNotMatch(html,/class="board-menu-label"/);
 }
 const empty=boardMenuHtml(boardMenuModel({store:store(),doc:doc(null),bases}));
 assert.doesNotMatch(empty,/board-recent-empty/,'The current board itself is a list item when there is no history');
});
test('free view ghosts and pristine saved snapshots are excluded, recoverable drafts remain',()=>{
 const s=store([['view:free:ghost',{boardRecent:{title:'Saved elsewhere'}}],['document:free:pristine',{doc:doc(null,{workspace_id:'pristine'})}],['analysis',{doc:doc(null,{workspace_id:'draft',title:'Actual draft'})}]]);const model=boardMenuModel({store:s,doc:doc(5),bases});assert.equal(model.recents.length,1);assert.equal(model.recents[0].identity,'free:draft');assert.equal(model.recents[0].snapshotKey,'analysis');assert.equal(model.recents[0].draft,true);
});
test('twenty newest unique boards are returned without mutating store contents',()=>{
 const s=store(Array.from({length:30},(_,i)=>['view:entry:'+(i+1),{boardRecent:boardRecentMetadata(doc(i+1),null,bases,Date.parse(stamp)+i*1000)}])),before=JSON.stringify([...s.items]);const model=boardMenuModel({store:s,doc:doc(100),bases});assert.equal(model.recents.length,20);assert.equal(model.recents[0].identity,'entry:30');assert.equal(model.recents.at(-1).identity,'entry:11');assert.equal(JSON.stringify([...s.items]),before);
});
test('invalid timestamps and impossible counters never render misleading dates or positions',()=>{
 const s=store([['view:entry:9',{boardRecent:{title:42,index:8,total:2,openedAt:'invalid'}},'invalid']]);const item=boardMenuModel({store:s,doc:doc(),bases}).recents[0];assert.equal(item.index,null);assert.equal(item.total,null);assert.equal(item.openedAt,null);assert.equal(item.title,'Partie 9');assert.equal(boardRelativeDate('invalid'),'');assert.doesNotMatch(boardMenuHtml({current:item,recents:[]}),/Invalid Date|datetime=/);
});
test('menu escapes user titles, base names and identity attributes and exposes commands',()=>{
 const html=boardMenuHtml({current:{title:'<script>name</script>',baseName:'<img onerror=x>',index:1,total:2,draft:true},recents:[{identity:'free:" onclick="bad',title:'<svg>',baseName:'&base',openedAt:stamp,draft:true}]},{now:Date.parse(stamp)});
 const withoutIcons=['plus','history','drafts'].reduce((markup,name)=>markup.replaceAll(uiIcon(name,'board-menu-icon'),''),html);
 assert.doesNotMatch(withoutIcons,/<script|<img|<svg|" onclick="/);assert.match(html,/&lt;script&gt;/);assert.match(html,/&lt;svg&gt;/);assert.match(html,/data-board-recent="free:&quot; onclick=&quot;bad"/);for(const action of ['current','new','manage'])assert.match(html,new RegExp('data-board-command="'+action+'"'));assert.doesNotMatch(html,/data-board-command="library"/);assert.match(html,/<details class="board-recent-section" open>/);
});
test('current marker is unique and descriptive metadata shares the second line with its date',()=>{
 for(const language of ['fr','en']){
  setLanguage(language);
  const item={identity:'entry:5',title:'A long current title',baseName:'A long library name',index:3,total:6,draft:true,openedAt:stamp};
  const html=boardMenuHtml({current:item,recents:[{...item,identity:'entry:9',title:'Another draft'}]},{now:Date.parse(stamp)+120000});
  const rows=[...html.matchAll(/<button\b[^>]*class="board-recent-row[^\"]*"[^>]*>([^]*?)<\/button>/g)];
  assert.equal(rows.length,2);
  assert.equal((html.match(/class="board-recent-current-label"/g)||[]).length,1);
  assert.equal((html.match(/aria-current="true"/g)||[]).length,1);
  assert.match(rows[0][0],/aria-current="true"/);
  assert.match(rows[0][1],new RegExp('class="board-recent-current-label"[^>]*>'+(language==='fr'?'Actuel':'Current')+'<'));
  assert.doesNotMatch(rows[1][0],/board-recent-current-label|aria-current/);
  for(const [,row] of rows){
   const heading=row.match(/<span class="board-recent-heading">([^]*?)<span class="board-recent-meta">/)?.[1];
   const metadata=row.match(/<span class="board-recent-meta">([^]*)/)?.[1];
   assert(heading&&metadata,'Each row has one heading and one metadata line');
   assert.match(heading,/class="board-recent-title"/);
   assert.doesNotMatch(heading,/board-recent-context|board-recent-draft|<time/);
   assert.match(metadata,/class="board-recent-context"/);
   assert.match(metadata,/class="board-recent-draft"/);
   assert.match(metadata,/<time datetime="2026-10-25T14:00:00\.000Z"/);
  }
 }
});
test('relative dates use the selected interface language',()=>{
 const now=Date.parse(stamp);assert.equal(boardRelativeDate(now-86400000,now),'hier');assert.match(boardRelativeDate(now-120000,now),/il y a 2 minutes/);setLanguage('en');assert.equal(boardRelativeDate(now-86400000,now),'yesterday');assert.equal(boardRelativeDate(now-120000,now),'2 minutes ago');assert.equal(translations['Gérer les brouillons…'],'Manage drafts…');
});
test('draft aliases are trimmed and bounded without changing document or stored PGN titles',()=>{
 const d=doc(5,{analysis_dirty:true}),other=doc(null,{workspace_id:'other',title:'Original PGN title'}),s=store([['view:entry:5',{draftLabel:'  Current alias  '}],['document:free:other',{doc:other}],['view:free:other',{draftLabel:' x'.repeat(200)}]]),before=JSON.stringify([...s.items]);
 const model=boardMenuModel({store:s,doc:d,bases});assert.equal(model.current.title,'Current alias');assert.equal(model.recents[0].title.length,160);assert.equal(d.title,'Partie exemple');assert.equal(other.title,'Original PGN title');assert.equal(JSON.stringify([...s.items]),before);
 const clean=boardMenuModel({store:s,doc:{...d,analysis_dirty:false},bases});assert.equal(clean.current.title,'Partie exemple');
});
test('only actual drafts expose context scope and accessible sibling options',()=>{
 const html=boardMenuHtml({current:{identity:'entry:5',title:'Saved',draft:false},recents:[{identity:'free:one',title:'Draft',draft:true},{identity:'entry:7',title:'Saved too',draft:false}]});assert.equal((html.match(/data-board-draft=/g)||[]).length,1);assert.equal((html.match(/data-board-draft-options=/g)||[]).length,1);assert.match(html,/data-board-draft="free:one"/);assert.match(html,/<\/button><button type="button" class="board-draft-options"/);assert.match(html,/aria-haspopup="menu"/);assert.doesNotMatch(html,/data-board-draft="entry:5"|data-board-draft="entry:7"/);
});

test('unfinished dots follow only real draft titles before the current label without adding a row',()=>{
 for(const currentDraft of [false,true]){
  const html=boardMenuHtml({current:{identity:'entry:5',title:'Current',draft:currentDraft},recents:[{identity:'free:one',title:'Draft',draft:true},{identity:'entry:7',title:'Saved',draft:false}]});
  const rows=[...html.matchAll(/<button\b[^>]*class="board-recent-row[^\"]*"[^>]*>([^]*?)<\/button>/g)].map(match=>match[1]);
  assert.equal(rows.length,3);assert.equal((html.match(/class="board-activity-dot"/g)||[]).length,currentDraft?2:1);
  for(const [index,row] of rows.entries()){
   assert.equal((row.match(/class="board-recent-heading"/g)||[]).length,1);assert.equal((row.match(/class="board-recent-meta"/g)||[]).length,1);
   if(index===1||index===0&&currentDraft){assert.match(row.replace(uiIcon('drafts','board-menu-icon'),''),/<span class="board-recent-heading"><span class="board-recent-title"[^>]*>[^<]+<\/span><span class="board-activity-dot" aria-hidden="true"><\/span>/);if(index===0)assert(row.indexOf('board-activity-dot')<row.indexOf('board-recent-current-label'));}
   else assert.doesNotMatch(row,/board-activity-dot/);
  }
 }
});

test('untitled recent boards follow the interface language while user titles stay unchanged',()=>{
 const free=doc(null,{nodes:[{path:'',fen:START,comment:'idea'}]}),named=doc(9,{title:'Analyse libre'}),untitled=doc(10,{title:''});
 const s=store([['document:free:free-one',{doc:free}],['view:free:free-one',{boardRecent:boardRecentMetadata(free,null,bases,stamp)}],['view:entry:9',{boardRecent:boardRecentMetadata(named,null,bases,stamp)}],['view:entry:10',{boardRecent:boardRecentMetadata(untitled,null,bases,stamp)}]]);
 setLanguage('en');const model=boardMenuModel({store:s,doc:doc(5),bases});
 assert.equal(model.recents.find(x=>x.identity==='free:free-one').title,'Free analysis');assert.equal(model.recents.find(x=>x.identity==='entry:9').title,'Analyse libre');assert.equal(model.recents.find(x=>x.identity==='entry:10').title,'Game 10');
});
