import test from 'node:test';
import assert from 'node:assert/strict';
import {START} from '../static/api.js';
import {setLanguage,t} from '../static/i18n.js';
import {isPristineAnalysis,analysisIdentity,pruneEmptyAnalyses,draftKeys} from '../static/workspace-drafts.js';
import {WorkspaceStore} from '../static/workspace-store.js';
const empty=()=>({doc:{workspace_id:'a',headers:{Result:'*'},nodes:[{path:'',fen:START,san:null,uci:null,comment:'',nags:[],children:[],clock:null,elapsed:null}]},drawings:[]});
const memory=()=>({getItem(){return null;},setItem(){}});
test('untouched start board is empty irrespective of display choices; no identity is invented',()=>{
 assert.equal(isPristineAnalysis({doc:{}}),false);assert.equal(isPristineAnalysis(null),false);
 const snapshot=empty();delete snapshot.doc.workspace_id;snapshot.flipped=true;snapshot.engineOn=true;snapshot.path='';assert(isPristineAnalysis(snapshot));assert.equal(analysisIdentity(snapshot.doc),null);
});
test('moves, FEN diagrams, notes, NAGs, metadata, drawings and saved games remain meaningful',()=>{
 for(const edit of [s=>s.doc.nodes.push({path:'0',san:'e4'}),s=>s.doc.nodes[0].fen=START.replace(' w ',' b '),s=>s.doc.nodes[0].comment='[%clk 0:03:00]',s=>s.doc.nodes[0].nags=[1],s=>s.doc.headers.Event='Révisions',s=>s.doc.title='Bien',s=>s.drawings=[{orig:'e2',dest:'e4'}],s=>s.doc.id=4,s=>s.doc.headers.FEN=START]){const s=empty();edit(s);assert.equal(isPristineAnalysis(s),false);}
 assert.equal(isPristineAnalysis(empty(),{nodes:{'':{comment:'My notes'}}}),false);
});
test('cleanup targets provably empty drafts only and never overwrites the latest meaningful session',async()=>{
 const a=new WorkspaceStore({storage:memory()});await a.open('test');
 a.set('document:free:a',empty());const custom=empty();custom.doc.workspace_id='b';custom.doc.nodes[0].fen=START.replace(' w ',' b ');a.set('analysis',custom);a.set('document:free:b',custom);
 const annotated=empty();annotated.doc.workspace_id='c';a.set('document:free:c',annotated);a.set('annotation:free:c',{nodes:{'':{comment:'Keep'}}});
 const conflict=empty();conflict.doc.workspace_id='d';a.set('document:free:d',conflict);a.items.get('document:free:d').conflict={revision:9,data:custom};
 const remoteNotes=empty();remoteNotes.doc.workspace_id='e';a.set('document:free:e',remoteNotes);a.set('annotation:free:e',null);a.items.get('annotation:free:e').conflict={revision:10,data:{nodes:{'':{comment:'Remote notes'}}}};
 const old=empty();delete old.doc.workspace_id;a.set('document:free:legacy',old);a.set('annotation:free:legacy',{nodes:{'':{comment:'Keep legacy'}}});
 assert.deepEqual(pruneEmptyAnalyses(a),['document:free:a']);assert.equal(a.get('document:free:a'),null);assert.deepEqual(a.get('analysis'),custom);assert(a.get('document:free:c'));assert(a.get('document:free:d'));assert(a.get('document:free:legacy'));assert(a.get('document:free:e'));a.close();
});
test('deletion keys include only the same document and associated annotation/latest analysis',async()=>{
 const a=new WorkspaceStore({storage:memory()});await a.open('test');a.set('document:free:a',empty());a.set('annotation:free:a',{nodes:{'':{comment:'draft'}}});a.set('analysis',empty());a.set('review',{index:1});
 assert.deepEqual(new Set(draftKeys(a,'document:free:a')),new Set(['document:free:a','annotation:free:a','analysis']));
 const other=empty();other.doc.workspace_id='b';a.set('analysis',other);assert(!draftKeys(a,'document:free:a').includes('analysis'));a.close();
});
test('deletion confirmation and untouched badge are translated without translating names',()=>{
 setLanguage('en');assert.equal(t('Analyse libre'),'Free analysis');assert.equal(t('Supprimer'),'Delete');assert.equal(t('Brouillon supprimé.'),'Draft deleted.');assert.match(t('Supprimer ce brouillon et ses annotations non enregistrées ? Les parties enregistrées dans les bases sont conservées.'),/^Delete this draft/);setLanguage('fr');assert.equal(t('Brouillon supprimé.'),'Brouillon supprimé.');
});
