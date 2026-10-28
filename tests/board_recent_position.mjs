import test from 'node:test';
import assert from 'node:assert/strict';
import {START} from '../static/api.js';
import {boardRecentPosition} from '../static/board-recent-position.js';

const e4='rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1';
const d4='rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq d3 0 1';
const final='rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2';
const document=()=>({id:7,start_path:'0',nodes:[{path:'',fen:START},{path:'0',fen:e4,uci:'e2e4'},{path:'1',fen:d4,uci:'d2d4'},{path:'0.0',fen:final,uci:'e7e5'}]});
const store=(records=[])=>({items:new Map(records.map(([key,data])=>[key,{data}])),get(key){return this.items.get(key)?.data??null;},set(){assert.fail('preview must not write');},remove(){assert.fail('preview must not remove');}});
const noRequest=()=>assert.fail('a retained document must not be fetched');

test('the saved active variation overrides the snapshot path and the final PGN move',async()=>{
 const doc=document(),workspace=store([['document:entry:7',{doc,path:'0.0',flipped:false}],['view:entry:7',{path:'1',flipped:true}]]),before=structuredClone([...workspace.items]);
 assert.deepEqual(await boardRecentPosition({identity:'entry:7',store:workspace,request:noRequest}),{fen:d4,flipped:true,uci:'d2d4',path:'1'});
 assert.deepEqual([...workspace.items],before);
});

test('an explicitly saved root stays at root even when the entry starts later',async()=>{
 const workspace=store([['document:entry:7',{doc:document(),path:'0.0',flipped:true}],['view:entry:7',{path:'',flipped:false}]]);
 assert.deepEqual(await boardRecentPosition({identity:'entry:7',store:workspace,request:noRequest}),{fen:START,flipped:false,uci:null,path:''});
});

test('the current board uses its live document, active path and orientation',async()=>{
 const doc=document(),older=document();older.nodes=older.nodes.filter(node=>node.path!=='1');
 const workspace=store([['document:entry:7',{doc:older,path:'0.0',flipped:true}],['view:entry:7',{path:'0',flipped:true}]]),before=structuredClone({doc,items:[...workspace.items]});
 assert.deepEqual(await boardRecentPosition({identity:'entry:7',store:workspace,currentDoc:doc,currentPath:'1',currentFlipped:false,request:noRequest}),{fen:d4,flipped:false,uci:'d2d4',path:'1'});
 assert.deepEqual({doc,items:[...workspace.items]},before);
});

test('a compact saved recent lazily reads the entry and preserves its saved view',async()=>{
 const workspace=store([['view:entry:7',{path:'1',flipped:true}]]),before=structuredClone([...workspace.items]),controller=new AbortController(),calls=[];
 const result=await boardRecentPosition({identity:'entry:7',store:workspace,signal:controller.signal,request:async(url,options)=>{calls.push({url,options});return document();}});
 assert.deepEqual(calls,[{url:'/api/entries/7',options:{signal:controller.signal}}]);
 assert.deepEqual(result,{fen:d4,flipped:true,uci:'d2d4',path:'1'});assert.deepEqual([...workspace.items],before);
});

test('legacy analysis snapshots work only for their own identity',async()=>{
 const doc={...document(),id:null,workspace_id:'draft'},workspace=store([['analysis',{doc,path:'1',flipped:true}],['view:free:draft',{path:'0',flipped:false}]]);
 assert.deepEqual(await boardRecentPosition({identity:'free:draft',store:workspace,request:noRequest}),{fen:e4,flipped:false,uci:'e2e4',path:'0'});
 assert.equal(await boardRecentPosition({identity:'free:missing',store:workspace,request:noRequest}),null);
});

test('a removed path falls back to a valid start and then the root, never the final move',async()=>{
 const doc=document(),workspace=store([['document:entry:7',{doc}],['view:entry:7',{path:'0.99',flipped:true}]]);
 assert.deepEqual(await boardRecentPosition({identity:'entry:7',store:workspace,request:noRequest}),{fen:e4,flipped:true,uci:'e2e4',path:'0'});
 doc.start_path='removed';assert.deepEqual(await boardRecentPosition({identity:'entry:7',store:workspace,request:noRequest}),{fen:START,flipped:true,uci:null,path:''});
 doc.nodes=doc.nodes.filter(node=>node.path!=='');assert.equal(await boardRecentPosition({identity:'entry:7',store:workspace,request:noRequest}),null);
});

test('unavailable and cancelled reads remain caller-owned and never alter workspace data',async()=>{
 const workspace=store([['view:entry:7',{path:'1'}]]),before=structuredClone([...workspace.items]),error=Object.assign(new Error('Gone'),{status:404});
 await assert.rejects(boardRecentPosition({identity:'entry:7',store:workspace,request:async()=>{throw error;}}),value=>value===error);
 const controller=new AbortController();controller.abort();await assert.rejects(boardRecentPosition({identity:'entry:7',store:workspace,signal:controller.signal,request:noRequest}),{name:'AbortError'});
 assert.deepEqual([...workspace.items],before);
});
