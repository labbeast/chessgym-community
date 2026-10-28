import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const sources={
 'training-statistics.js':`export const openTrainingStatistics=async()=>({close(){}});`,
 'training-history.js':`export class TrainingHistoryView{constructor(host,options){this.host=host;this.options=options;this.loads=0;this.disposed=false;globalThis.histories.push(this);}async load(){this.loads++;}dispose(){this.disposed=true;}}export const openTrainingHistory=options=>globalThis.openHistoryDialog(options);`,
 'api.js':`export const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';export const api=(...args)=>globalThis.request(...args);export const esc=value=>String(value??'');export const option=()=>'';export const fail=error=>{throw error;};export const modal=()=>{};export const notice=()=>{};export const time=value=>String(value);`,
 'i18n.js':`export const t=(value)=>value;export const ui=value=>value;export const locale=()=> 'en';export const getLanguage=()=> 'fr';`,
 'board.js':`export class Board{};export const makeDoc=()=>({});export const appendLine=()=>({});`,
 'chess-document.js':`export const pieces=()=>({});export const serialize=()=>'';export const nodeIndex=()=>new Map();export const appendLine=()=>({});`,
 'analysis-moves.js':`export const renderAnalysisMovesInto=()=>{};export const analysisMovesHtml=()=>'';`,
 'appearance.js':`export const pieceUrl=()=>'';`,
 'sound.js':`export const playSound=()=>{};`,
 'puzzle-feedback.js':`export const puzzleFeedbackHtml=()=>'';export const puzzleResultLabel=()=>'';`,
 'exercise-editor.js':`export const openExerciseEditor=()=>{};`,
 'storm-results.js':`export const stormResultsHtml=()=>'';`,
};
registerHooks({load(url,context,next){const source=Object.entries(sources).find(([name])=>url.endsWith('/static/'+name))?.[1];return source===undefined?next(url,context):{format:'module',shortCircuit:true,source};}});
const {CoordinateView,BlindfoldView}=await import('../static/training-skills.js');
const {ColorTrainingView}=await import('../static/color-training.js');
const {GuessMoveView}=await import('../static/guess-move.js');
const {PuzzleView}=await import('../static/puzzles.js');
const {ComputerHistoryView}=await import('../static/computer-history.js');
const host=()=>({innerHTML:'',classList:{add(){},remove(){}},querySelector:()=>null,querySelectorAll:()=>[]});
let dialogs;
beforeEach(()=>{dialogs=[];globalThis.histories=[];globalThis.request=async()=>{throw Error('Unexpected API request');};globalThis.openHistoryDialog=async options=>{const dialog={options,closed:false,close(){this.closed=true;}};dialogs.push(dialog);return dialog;};});

test('timed coordinate and Color rounds cannot lose time under the history dialog',async()=>{
 for(const View of [CoordinateView,ColorTrainingView]){
  const view=new View(host()),session={id:'current',finished:false};view.session=session;
  await view.showHistory();assert.equal(dialogs.length,0);assert.equal(view.session,session);
  session.finished=true;await view.showHistory();assert.equal(dialogs.length,1);assert.equal(dialogs[0].options.tool,View===CoordinateView?'coordinates':'color');
  view.dispose();assert.equal(dialogs[0].closed,true);dialogs=[];
 }
});
test('dialog finishing loading after disposal is immediately closed',async()=>{
 let release;globalThis.openHistoryDialog=()=>new Promise(resolve=>release=resolve);
 const view=new ColorTrainingView(host());const opening=view.showHistory();view.dispose();let closed=false;release({close(){closed=true;}});await opening;assert.equal(closed,true);
});
test('blindfold inspection preserves an unfinished reconstruction and never provides a replacing action',async()=>{
 const view=new BlindfoldView(host());view.session={id:'current',finished:false};view.placed={a1:'K',h8:'k'};
 await view.showHistory();assert.equal(dialogs[0].options.tool,'blindfold');assert.equal(dialogs[0].options.onOpen,null);assert.deepEqual(view.placed,{a1:'K',h8:'k'});assert.equal(view.session.id,'current');view.dispose();
});
test('finished blindfold exercise can reopen a previous exercise through the shared history',async()=>{
 const view=new BlindfoldView(host());view.session={finished:true};let opened;view.openHistory=id=>opened=id;
 await view.showHistory();await dialogs[0].options.onOpen({id:'past'});assert.equal(opened,'past');await view.openTrainingRecord({id:'global'});assert.equal(opened,'global');view.dispose();
});
test('guess history inspection leaves current session intact; finished game allows explicit opening',async()=>{
 const view=new GuessMoveView(host());view.session={id:'active',completed:false};await view.showHistory();assert.equal(dialogs[0].options.onOpen,null);assert.equal(view.session.id,'active');
 view.session.completed=true;let opened;view.openSession=id=>opened=id;await view.showHistory();await dialogs[1].options.onOpen({id:'past'});assert.equal(opened,'past');view.dispose();
});
test('puzzle history provides classic and Storm choices and is blocked during a live Storm',async()=>{
 const view=new PuzzleView(host());view.shell=()=>{};view.storm={status:'active'};await view.history();assert.equal(histories.length,0);
 view.storm.status='completed';await view.history();assert.equal(view.tab,'history');assert.equal(histories.length,1);assert.deepEqual(histories[0].options.tools,['puzzles','storm']);assert.equal(histories[0].options.tool,'puzzles');
 let opened;view.openTrainingRecord=record=>opened=record;await histories[0].options.onOpen({tool:'storm',id:'s'});assert.equal(opened.id,'s');view.dispose();assert.equal(histories[0].disposed,true);
});
test('global puzzle record opens the existing attempt without creating a new attempt',async()=>{
 const view=new PuzzleView(host());let opened;view.openHistory=id=>opened=id;await view.openTrainingRecord({tool:'puzzles',id:'p'});assert.equal(opened,'p');
});
test('a Storm record returns to its summary or resumes its exact current attempt',async()=>{
 const view=new PuzzleView(host());let shown,summary;
 view.showAttempt=attempt=>shown=attempt;view.openStormResults=id=>summary=id;
 globalThis.request=async path=>{assert.equal(path,'/api/puzzles/storm/s');return {storm:{id:'s',status:'completed'}};};
 await view.openTrainingRecord({tool:'storm',id:'s'});assert.equal(summary,'s');
 globalThis.request=async()=>({storm:{id:'s',status:'active'},attempt:{id:'current'}});
 await view.openTrainingRecord({tool:'storm',id:'s'});assert.equal(shown.id,'current');assert.equal(view.storm.id,'s');
});
test('late Storm record response does not replace the page after navigation',async()=>{
 const view=new PuzzleView(host());let release,shown=false;globalThis.request=()=>new Promise(resolve=>release=resolve);view.showAttempt=()=>shown=true;
 const opening=view.openTrainingRecord({tool:'storm',id:'s'});view.viewToken++;release({storm:{id:'s',status:'active'},attempt:{id:'current'}});await opening;assert.equal(shown,false);
});
test('computer archive uses shared history while preserving its dedicated replay entry point',async()=>{
 const view=new ComputerHistoryView(host());await view.load();assert.equal(histories.length,1);assert.equal(histories[0].options.tool,'computer');assert.equal(histories[0].loads,1);
 let opened;view.view=id=>opened=id;await histories[0].options.onOpen({id:'game'});assert.equal(opened,'game');await view.openTrainingRecord({id:'global'});assert.equal(opened,'global');
 view.dispose();assert.equal(histories[0].disposed,true);
});

test('Color and coordinate record opening only fetches the existing session and leaves records intact',async()=>{
 for(const [View,tool] of [[ColorTrainingView,'color'],[CoordinateView,'coordinates']]){
  const calls=[],session={id:'old',finished:true,config:{duration:60,mode:'coordinates'},server_time:100};globalThis.request=async path=>{calls.push(path);return session;};
  const view=new View(host());view.render=()=>{};view.data={records:[{score:9}]};await view.openTrainingRecord({id:'old'});assert.deepEqual(calls,['/api/skills/'+tool+'/old']);assert.equal(view.session,session);assert.equal(view.data.records[0].score,9);assert.equal(view.timer??null,null);view.dispose();
 }
});
test('late Color and coordinate record responses cannot replace a new session',async()=>{
 for(const View of [ColorTrainingView,CoordinateView]){
  let release;globalThis.request=()=>new Promise(resolve=>release=resolve);const view=new View(host());view.render=()=>{};
  const opening=view.openTrainingRecord({id:'old'});view.dispose();release({id:'old',finished:true,config:{duration:30},server_time:100});await opening;assert.equal(view.session??null,null);
 }
});

test('archived experiments cannot reopen the removed game interface',async()=>{
 const view=new GuessMoveView(host());
 await assert.rejects(view.openSession('mix-archived'),/archivée/);
 view.dispose();
});
