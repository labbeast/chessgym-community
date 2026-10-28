import assert from 'node:assert/strict';
import {WorkspaceStore} from '../static/workspace-store.js';
import {computerSessionSnapshot,persistComputerSession} from '../static/computer-workspace.js';
import {makeDoc} from '../static/chess-document.js';
import {START} from '../static/api.js';

const memory=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};};
function game(){const config={provider:'maia',level:1700,skill:4,time_ms:500,side:'random',start:'initial',fen:START};return {version:1,mode:'play',config,origin:null,displayPath:'',pendingMove:null,session:{config:structuredClone(config),side:'black',baseline:0,start:{initial_fen:START,history:[]},position:{initial_fen:START,fen:START,history:[],doc:makeDoc(),path:'',turn:'white',game_over:false},headers:{Result:'*'},resigned:false}};}
const storage=memory(),store=new WorkspaceStore({storage});await store.open('alice');
assert.equal(persistComputerSession(store,{version:1,mode:'setup',config:{},session:null}),null);assert.equal(store.get('computer'),null);
const saved=game();persistComputerSession(store,saved);assert.deepEqual(store.get('computer'),saved);
saved.config.provider='stockfish';saved.session.position.history.push('e2e4');assert.equal(store.get('computer').config.provider,'maia');assert.deepEqual(store.get('computer').session.position.history,[]);
const restarted=new WorkspaceStore({storage});await restarted.open('alice');assert.deepEqual(restarted.get('computer'),store.get('computer'));
await restarted.open('bob');assert.equal(restarted.get('computer'),null);await restarted.open('alice',{namespace:'restored-backup'});assert.equal(restarted.get('computer'),null);

const setup=game();setup.mode='setup';setup.config={provider:'stockfish',skill:20,start:'fen',fen:'new diagram'};setup.origin={fen:'next diagram'};setup.pendingMove='e2e4';
const recovered=computerSessionSnapshot(setup);assert.equal(recovered.mode,'play');assert.equal(recovered.config.provider,'maia');assert.equal(recovered.config.level,1700);assert.equal(recovered.pendingMove,null);assert.equal(recovered.origin,null);assert.equal(recovered.session.side,'black');
persistComputerSession(store,setup);const previous=store.get('computer');persistComputerSession(store,{version:1,mode:'setup',session:null});assert.deepEqual(store.get('computer'),previous);

const intent=game();intent.pendingMove='e2e4';persistComputerSession(store,intent);const afterClose=new WorkspaceStore({storage});await afterClose.open('alice');assert.equal(afterClose.get('computer').pendingMove,'e2e4');
intent.session.resigned=true;intent.session.headers.Result='0-1';const resigned=computerSessionSnapshot(intent);assert.equal(resigned.pendingMove,null);assert.equal(resigned.session.headers.Result,'0-1');
const old=game();delete old.session.config;assert.deepEqual(computerSessionSnapshot(old).session.config,old.config);
const invalid=game();delete invalid.session.position.doc;persistComputerSession(store,invalid);assert.equal(store.get('computer').pendingMove,'e2e4');

const requests=[];const remote=new WorkspaceStore({storage:memory(),delay:100000,request:async(path,options)=>{requests.push([path,options]);if(!options)return {items:[]};return {key:'computer',revision:7,data:options.body.data};}});await remote.open('alice',{remote:true});persistComputerSession(remote,game());await remote.flush();assert.equal(requests[1][0],'/api/workspace/computer');assert.equal(requests[1][1].method,'PUT');assert.equal(requests[1][1].body.expected_revision,0);assert(!requests.some(([path])=>path.includes('/entries')));
for(const item of [store,restarted,afterClose,remote])item.close();
console.log('PASS computer recovery, synchronous local persistence, frozen configuration, intent, account isolation and workspace-only sync');
