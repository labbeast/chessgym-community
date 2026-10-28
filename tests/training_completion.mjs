import test from 'node:test';
import assert from 'node:assert/strict';
import {programCreationBody,nativeProgramRequest,acceptedProgramCreation,launchNativeProgram,nativeProgramContext,settleNativeProgram} from '../static/training-native.js';
import {trainingOptionsHtml,setTrainingOption} from '../static/training-options.js';
import {TrainingPlan} from '../static/training-plan.js';
import {createBlock} from '../static/training-program.js';
import {trainingAssistanceHtml,duplicateWeekHtml} from '../static/training-assistance.js';
const store=()=>{const values=new Map();return {get:key=>values.get(key),set:(key,value)=>values.set(key,structuredClone(value)),remove:key=>values.delete(key),values};};
const run=(activity,other={})=>({id:'run',state:'active',activity,block:{id:'block',title:'My block',options:{}},launch:{options:{}},...other});
const host=()=>({innerHTML:'',classList:{add(){},remove(){}},addEventListener(){},removeEventListener(){},querySelector:()=>null,querySelectorAll:()=>[]});

test('native creation retries retain the exact receipt across a new view and uncertain response',async()=>{
 const storage=store(),a={trainingRun:run('color'),trainingStore:storage},calls=[];
 await assert.rejects(nativeProgramRequest(a,'color',{duration:30},async body=>{calls.push(body);throw Object.assign(Error('lost'),{status:503});}));
 const b={trainingRun:run('color'),trainingStore:storage};await nativeProgramRequest(b,'color',{duration:30},async body=>{calls.push(body);return {id:'one'};});
 assert.deepEqual(calls[1],calls[0]);assert.equal(calls[0].training_run_id,'run');assert(calls[0].request_id);assert.equal(storage.values.size,0);
 const next=programCreationBody(b,'color',{duration:30});assert.notEqual(next.request_id,calls[0].request_id);
});
test('a definitive invalid launch can be corrected but uncertain settings cannot be replaced',async()=>{
 const view={trainingRun:run('coordinates'),trainingStore:store()};programCreationBody(view,'coordinates',{duration:30});
 assert.throws(()=>programCreationBody(view,'coordinates',{duration:60}),/confirmation/);
 acceptedProgramCreation(view,'coordinates');await assert.rejects(nativeProgramRequest(view,'coordinates',{duration:7},async()=>{throw Object.assign(Error('invalid'),{status:422});}));
 assert.equal(programCreationBody(view,'coordinates',{duration:60}).duration,60);
});
test('free native activities keep their original request shape',()=>{
 const body={duration:30};assert.equal(programCreationBody({},'color',body),body);
});
test('each current unfinished native source is preserved when another programme is launched',async()=>{
 for(const activity of ['puzzles','guess','computer','blindfold','coordinates','color']){
  const source={id:'current',training_run_id:'other',status:'active',finished:false,completed:false};
  const view=activity==='puzzles'?{attempt:source}:{session:source,finished:()=>false};
  await assert.rejects(launchNativeProgram(view,run(activity)),/autre activité/);assert.equal(view.trainingRun,undefined);assert.equal((view.attempt||view.session).id,'current');
 }
});
test('opening a planned puzzle keeps filters and resumes its exact occurrence without creating one',async()=>{
 const calls=[],view={filters:{themes:[],color:'any'},load:async()=>{},showAttempt(value){this.shown=value;}};
 await launchNativeProgram(view,run('puzzles',{launch:{options:{mode:'classic',rated:false,filters:{rating_min:1200,rating_max:1400}}},native_ref:{tool:'puzzles',id:'p1'}}),{request:async path=>{calls.push(path);return {id:'p1',training_run_id:'run',status:'active'};}});
 assert.equal(view.filters.rating_min,1200);assert.equal(view.selection,'custom');assert.equal(view.rated,false);assert.deepEqual(calls,['/api/puzzles/attempts/p1']);assert.equal(view.shown.id,'p1');assert.equal(nativeProgramContext(view).id,'run');
});
test('a retained unrelated puzzle cannot be replaced by a programme setup',async()=>{
 const view={filters:{},load:async()=>{},data:{active:{id:'old',status:'active'}}};await assert.rejects(launchNativeProgram(view,run('puzzles')),/autre puzzle/);
});
test('Storm resumes its parent and never creates an independent classic attempt',async()=>{
 const calls=[],view={filters:{},load:async()=>{},showAttempt(a){this.shown=a;}};
 await launchNativeProgram(view,run('puzzles',{native_ref:{tool:'storm',id:'s1'}}),{request:async path=>{calls.push(path);return {storm:{id:'s1',status:'active',training_run_id:'run'},attempt:{id:'child',status:'active'}};}});
 assert.deepEqual(calls,['/api/puzzles/storm/s1']);assert.equal(view.shown.id,'child');assert.equal(nativeProgramContext(view).id,'run');
});
test('guess and skill setup retains configured options while choosing real source games',async()=>{
 const guess={settings:{side:'white'},load:async()=>{}};await launchNativeProgram(guess,run('guess',{launch:{base_id:9,options:{side:'both'}}}));assert.equal(guess.programBaseId,9);assert.equal(guess.settings.side,'both');
 const coordinates={config:{duration:30},load:async()=>{},openTrainingRecord(r){this.record=r;}};await launchNativeProgram(coordinates,run('coordinates',{launch:{options:{duration:60,orientation:'black'}},native_ref:{tool:'coordinates',id:'c'}}));assert.equal(coordinates.config.duration,60);assert.equal(coordinates.record.id,'c');
});
test('new blindfold categories use Lichess defaults instead of a saved personal reconstruction',async()=>{
 const view={config:{mode:'reconstruct',rated:false,entry_id:42,whole_game:true,input:'text'},baseId:9,programBaseId:9,async load(){this.loaded=structuredClone(this.config);}};
 await launchNativeProgram(view,run('blindfold',{launch:{category_id:'blindfold',options:{}}}));
 assert.equal(view.loaded.mode,'opening');assert.equal(view.loaded.rated,true);assert.equal(view.loaded.entry_id,undefined);assert.equal(view.loaded.whole_game,false);assert.equal(view.loaded.input,'text');assert.equal(view.baseId,null);assert.equal(view.programBaseId,null);
 const saved={id:'saved',tool:'blindfold'},resumed={config:{mode:'positions',rated:false},load:async()=>{},async openHistory(id){this.opened=id;}};
 await launchNativeProgram(resumed,run('blindfold',{launch:{category_id:'blindfold',options:{mode:'positions',rated:false}},native_ref:saved}));
 assert.equal(resumed.opened,'saved');assert.equal(resumed.config.mode,'positions');assert.equal(resumed.config.rated,false);
 const personal={config:{},load:async()=>{}};await launchNativeProgram(personal,run('blindfold',{launch:{base_id:9,options:{}}}));assert.equal(personal.config.mode,'reconstruct');assert.equal(personal.config.rated,false);assert.equal(personal.programBaseId,9);
});
test('computer launch preserves another current game and resumes its own archive',async()=>{
 const other={session:{id:'other',training_run_id:'other',position:{game_over:false}}};
 await assert.rejects(launchNativeProgram({config:{}},run('computer'),{computerSnapshot:other}),/autre partie/);assert.equal(other.session.id,'other');
 const snapshot={session:{id:'mine',training_run_id:'run',position:{game_over:false}}},view={config:{},load(s){this.loaded=s;}};
 await launchNativeProgram(view,run('computer',{native_ref:{tool:'computer',id:'mine'}}),{request:async()=>({snapshot})});assert.deepEqual(view.loaded,snapshot);
});
test('programme finish never reveals, resigns or completes an unfinished native exercise',async()=>{
 let calls=0;const view={trainingRun:run('guess'),session:{completed:false},reveal(){calls++;}};await assert.rejects(settleNativeProgram(view,'finish'),/Termine l’exercice/);assert.equal(calls,0);await settleNativeProgram(view,'pause');view.session.completed=true;await settleNativeProgram(view,'finish');
 const computer={trainingRun:run('computer'),session:{},finished:()=>true,pauseGame(){calls++;},async archive(){calls++;}};await settleNativeProgram(computer,'finish');assert.equal(calls,2);
});
test('native options use typed values and scope generic tools independently of manual resources',()=>{
 const block=createBlock('coordinates');setTrainingOption(block,'duration','60');setTrainingOption(block,'coordinates',true,'checkbox');assert.deepEqual(block.options,{duration:60,coordinates:true});assert.match(trainingOptionsHtml(block),/value="60" selected/);assert.equal(setTrainingOption(block,'__proto__.bad','x'),false);
 assert.equal(trainingOptionsHtml({...block,resource:{type:'external',name:'Paper'}}),'');
 assert.equal(createBlock('guess').resource.type,'tool');assert.equal(createBlock('puzzles').resource.id,'puzzles');
});
test('assistance rendering does not apply suggestions or activate automation',()=>{
 const data={settings:{auto_assign:false,revision:3},unambiguous_count:2,suggestions:[{program_id:'p',block_id:'b',field:'target',current:60,proposed:45,samples:6}]};
 const markup=trainingAssistanceHtml(data);assert.doesNotMatch(markup,/toggle-auto-assignment|assign-unambiguous/);assert.match(markup,/Examiner/);assert.doesNotMatch(markup,/data-plan-action="apply-adjustment"/);assert.equal(data.settings.auto_assign,false);
 const preview=duplicateWeekHtml({blocks:[{title:'<unsafe>',target:2,metric:'sessions'}]},'New');assert.match(preview,/ne sont pas copiés/);assert.doesNotMatch(preview,/<unsafe>/);
});
test('week duplication requires a preview then creates an inactive draft with the source revision',async()=>{
 const calls=[],w={id:'w',revision:7,name:'Source',definition:{blocks:[]}};const view=new TrainingPlan(host(),{request:async(path,options)=>{calls.push({path,options});return options?{id:'new',status:'draft'}:w;}});view.render=()=>{};view.load=async()=>{};
 await view.assistanceAction('duplicate-week',{dataset:{week:'w'}});assert.equal(calls.length,1);assert.equal(calls[0].options,undefined);assert.equal(view.duplicate.week.revision,7);
 await view.assistanceAction('confirm-duplicate',{});assert.equal(calls.length,2);assert.equal(calls[1].options.body.expected_revision,7);assert.equal(calls[1].options.body.name,'Copie de Source');assert.equal(view.selectedProgramId,'new');assert.equal(view.view,'program');
});
test('only the examined adjustment is explicitly applied to future weeks by default',async()=>{
 const calls=[],view=new TrainingPlan(host(),{request:async(path,options)=>{calls.push({path,options});return {};}});view.render=()=>{};view.load=async()=>{};view.loadAssistance=async()=>{};
 view.assistance={suggestions:[{program_id:'p',program_revision:4,block_id:'b',field:'unit_minutes',current:20,proposed:18,samples:4}]};
 await view.assistanceAction('preview-adjustment',{dataset:{suggestion:'0'}});assert.equal(calls.length,0);await view.assistanceAction('apply-adjustment',{});assert.equal(calls.length,1);assert.equal(calls[0].options.body.apply_to_current,false);assert.equal(calls[0].options.body.proposed,18);assert.equal(calls[0].options.body.expected_revision,4);
});

test('recovering an assistance change refreshes its visible state and enabled controls',async()=>{
 const view=new TrainingPlan(host(),{request:async()=>({settings:{auto_assign:true,revision:2}})});view.render=()=>{};let loaded=0;view.load=async()=>{loaded++;};view.loadAssistance=async()=>{assert.equal(view.busy,false);loaded++;view.assistance={settings:{auto_assign:true,revision:2}};};view.showAssistance=true;view.assistance={settings:{auto_assign:false,revision:1}};view.pendingMutation={kind:'assistance',url:'/api/training/assistance/settings',method:'PATCH',body:{expected_revision:1,auto_assign:true,mutation_id:'receipt'}};
 await view.recoverMutation();assert.equal(loaded,2);assert.equal(view.assistance.settings.auto_assign,true);assert.equal(view.pendingMutation,null);assert.equal(view.busy,false);
});

test('history keeps the displayed native run without borrowing another programme title or completion state',()=>{
 const view={trainingActivity:'guess',trainingRun:{...run('guess'),id:'previous',state:'completed',block:{title:'Previous programme'}},session:{id:'history-session',training_run_id:'displayed',completed:false}};
 assert.deepEqual(nativeProgramContext(view),{id:'displayed',activity:'guess',title:null});view.trainingRun.state='active';assert.deepEqual(nativeProgramContext(view),{id:'displayed',activity:'guess',title:null});view.session.training_run_id='previous';assert.equal(nativeProgramContext(view).title,'Previous programme');view.session.training_run_id=null;assert.equal(nativeProgramContext(view),null);
});
