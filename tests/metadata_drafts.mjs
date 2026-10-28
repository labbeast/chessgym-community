import assert from 'node:assert/strict';
import test from 'node:test';
import {editMetadata} from '../static/metadata.js';
import {makeDoc,serialize} from '../static/board.js';
import {dialogFactory} from './metadata_dom.mjs';

const notices=[];
globalThis.document={getElementById:()=>({append:node=>notices.push(node.textContent)}),createElement:()=>({remove(){}})};
const timer=globalThis.setTimeout;globalThis.setTimeout=(...args)=>{const handle=timer(...args);handle.unref?.();return handle;};
function source(){const doc=makeDoc();return {...doc,id:17,base_id:3,revision:'original-revision',title:'Mon exercice',start_path:'',analysis_dirty:true,analysis_source_line:[{path:'',fen:doc.nodes[0].fen}],headers:{...doc.headers,White:'Alice',Event:'Cours'},nodes:[{...doc.nodes[0],comment:'Annotation locale',nags:[1]}]};}
function form(doc){return new Map([...Object.entries(doc.headers),['title',doc.title],['Event','Nouveau tournoi']]);}

test('PGN metadata from analysis validates a draft without mutating its saved source',async()=>{
 const doc=source(),before=structuredClone(doc),calls=[],dialogs=[];let applied;
 globalThis.fetch=async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>({nodes:structuredClone(doc.nodes),headers:{...doc.headers,Event:'Nouveau tournoi'}})};};
 const dialog=editMetadata(doc,{persist:false,viewPath:'',openModal:dialogFactory(dialogs),onSaved:updated=>applied=updated});
 assert.equal(dialog.settings.submit,'Appliquer au brouillon');assert.equal(calls.length,0);
 await dialog.settings.onSubmit(form(doc),dialog.querySelector('form'));
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/api/board');assert.equal(calls[0].options.method,'POST');assert.deepEqual(calls[0].body,{pgn:serialize(doc),headers:{Event:'Nouveau tournoi'}});
 assert.deepEqual(doc,before);assert.equal(applied.id,17);assert.equal(applied.revision,'original-revision');assert.equal(applied.analysis_dirty,true);assert.deepEqual(applied.analysis_source_line,doc.analysis_source_line);assert.equal(applied.nodes[0].comment,'Annotation locale');assert.equal(applied.headers.Event,'Nouveau tournoi');assert.match(notices.at(-1),/brouillon/);
});

test('Explicit library metadata save remains a narrow header patch',async()=>{
 const doc=source(),calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options,body:JSON.parse(options.body)});return {ok:true,status:200,headers:{get:()=> 'application/json'},json:async()=>doc};};
 const dialog=editMetadata(doc,{openModal:dialogFactory([])});await dialog.settings.onSubmit(form(doc),dialog.querySelector('form'));
 assert.equal(calls[0].url,'/api/entries/17');assert.equal(calls[0].options.method,'PATCH');assert.deepEqual(calls[0].body,{headers:{Event:'Nouveau tournoi'},expected_revision:'original-revision'});assert(!('pgn' in calls[0].body));
});

test('A failed draft metadata validation never changes the source or applies edits',async()=>{
 const doc=source(),before=structuredClone(doc);let applied=false;globalThis.fetch=async()=>({ok:false,status:400,headers:{get:()=>null},json:async()=>({detail:'Champ invalide'})});
 const dialog=editMetadata(doc,{persist:false,openModal:dialogFactory([]),onSaved:()=>applied=true});await assert.rejects(dialog.settings.onSubmit(form(doc),dialog.querySelector('form')),/Champ invalide/);assert.deepEqual(doc,before);assert.equal(applied,false);
});
