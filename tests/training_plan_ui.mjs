import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setLanguage,t} from '../static/i18n.js';
import messages from '../static/locales/en-training-plan.js';
import {TrainingProgram,createBlock,emptyProgram,programEstimate,blockEstimate,templateBlocks,compatibleResources,resourceFromChoice,resourceIdentity,validateProgram,programDifferences,blockGoal} from '../static/training-program.js';
import {TrainingPlan,progressHtml,currentStudyDate,effortHtml,workCounts} from '../static/training-plan.js';
import {CATEGORY_IDS,categoryPeriodHtml,categoryLaunchHtml,categoryRemaining,categorySourceHtml} from '../static/training-category-view.js';
import {trainingAssistanceHtml} from '../static/training-assistance.js';

const host=()=>({innerHTML:'',classList:{add(){},remove(){},toggle(){}},addEventListener(){},removeEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const error=(status=503)=>Object.assign(new Error('Unavailable'),{status});
const program=()=>({...emptyProgram(),id:'p',revision:1,status:'active',definition:{schema_version:1,budget_minutes:240,intention:'',blocks:[{...createBlock('review'),id:'b',title:'My opening',resource:{type:'base',id:5,name:'Reti',generation:'v1'},metric:'minutes',target:60}]}});
const week=()=>({id:'w',name:'My programme',revision:1,program_id:'p',week_start:'2026-10-19',week_end:'2026-10-25',blocks:program().definition.blocks.map(b=>({...b,available:true,automatic:true,progress:{realized:0,remaining:60,target:60,duration_ms:null}})),definition:program().definition,activities:[],manual_activities:[],unassigned:[],active_runs:[],completed_blocks:0,total_blocks:1,planned_minutes:60,duration_ms:null});
const overview=(current=week())=>({week_start:'2026-10-19',week_end:'2026-10-25',today:{date:'2026-10-25',duration_ms:0,attempts:0},duration_ms:0,attempts:0,days:[],manual_activities:[],categories:CATEGORY_IDS.map(activity=>({id:activity,activity,target_minutes:0,daily_target_minutes:0,goal_revision:0,today:{duration_ms:0,attempts:0},progress:{duration_ms:0,attempts:0},blocks:(current?.blocks||[]).filter(b=>b.activity===activity),resources:[],active_runs:[]}))});
const state=()=>({programs:[program()],templates:[],resources:[],current_program_id:'p',active_runs:[],study_day:{timezone:'America/Toronto',start_hour:4}});
beforeEach(()=>setLanguage('fr'));

test('workload estimates preserve independent session and unit lengths, including unknowns',()=>{
 const blocks=[{metric:'minutes',target:60,session_minutes:20,axis:'calculation'},{metric:'sessions',target:3,session_minutes:15,axis:'openings'},{metric:'quantity',target:2,session_minutes:45,unit_minutes:20,axis:'strategy'}];
 assert.deepEqual(programEstimate(blocks),{minutes:145,unknown:0,byAxis:{calculation:60,openings:45,strategy:40}});
 assert.equal(blockEstimate({...blocks[2],unit_minutes:null}),null);assert.equal(programEstimate([...blocks,{metric:'quantity',target:1}]).unknown,1);
 assert.equal(240-programEstimate(blocks).minutes,95);
});
test('new blocks do not invent live resources or a time budget',()=>{
 const value=emptyProgram();assert.equal(value.definition.budget_minutes,null);assert.deepEqual(value.definition.blocks,[]);
 for(const activity of ['review','reading','external']){const b=createBlock(activity);assert.equal(b.resource.type,'external');assert.equal(b.resource.id,undefined);assert.equal(b.resource.name,'');assert.equal(validateProgram({...value,definition:{...value.definition,blocks:[b]}}).length,0);}
 for(const activity of ['puzzles','guess','computer','blindfold','coordinates','color']){const b=createBlock(activity);assert.equal(b.resource.type,'tool');assert.equal(b.resource.id,activity);assert.equal(b.resource.generation,'tool-v1');}
 assert.equal(createBlock('reading').unit,'games');assert.equal(createBlock('puzzles').unit,'positions');
});
test('resource choices respect activity compatibility and retain immutable generation',()=>{
 const resources=[{type:'base',id:1,name:'Both',generation:'g1',activities:['review','reading']},{type:'base',id:2,name:'Read only',generation:'g2',activities:['reading']}];
 assert.deepEqual(compatibleResources(resources,'review').map(r=>r.id),[1]);
 assert.equal(resourceFromChoice('base:2:g2',resources,'review'),null);
 assert.equal(resourceFromChoice('base:1:g1',resources,'review').generation,'g1');
 assert.notEqual(resourceIdentity({id:1,generation:'deleted'}),resourceIdentity(resources[0]));
});
test('partial template application makes independent fresh blocks and preserves originals',()=>{
 const template={builtin:true,definition:{blocks:[{...createBlock('review'),id:'source1',axis:'Ouvertures'},{...createBlock('reading'),id:'source2'}]}},original=structuredClone(template);
 const added=templateBlocks(template,[0]);assert.equal(added.length,1);assert.notEqual(added[0].id,'source1');assert.equal(added[0].axis,'openings');added[0].target=999;added[0].resource.name='Changed';assert.deepEqual(template,original);
 assert.notEqual(templateBlocks(template,[0])[0].id,added[0].id);assert.deepEqual(templateBlocks(template,[-1,9]),[]);
});
test('programme validation rejects missing names, invalid goals and duplicate identities',()=>{
 const p=program();assert.deepEqual(validateProgram(p),[]);p.definition.blocks.push(structuredClone(p.definition.blocks[0]));assert.match(validateProgram(p).join(' '),/identité différente/);
 p.definition.blocks.pop();p.definition.blocks[0].metric='sessions';p.definition.blocks[0].target=1.5;assert.match(validateProgram(p).join(' '),/nombres entiers/);p.name=' ';assert.match(validateProgram(p).join(' '),/nom/);
});
test('editing ordinary fields preserves the input DOM instead of remounting the editor',()=>{
 const content=host(),drafts=[],view=new TrainingProgram(content,{program:program(),onDraft:value=>drafts.push(value)}),markup=content.innerHTML;
 view.handleInput({type:'input',target:{tagName:'INPUT',dataset:{blockField:'title'},value:'A title being typed',matches:()=>false,closest:()=>({dataset:{blockId:'b'}})}});
 assert.equal(content.innerHTML,markup);assert.equal(view.program.definition.blocks[0].title,'A title being typed');assert.equal(drafts.at(-1).definition.blocks[0].title,'A title being typed');assert.equal(view.dirty,true);view.dispose();
});
test('conflict comparison shows resource and objective differences without replacing the draft',()=>{
 const a=program(),b=structuredClone(a);b.name='Remote';b.definition.blocks[0].resource.name='Other base';b.definition.blocks[0].target=90;
 const differences=programDifferences(a,b);assert(differences.some(x=>x.label==='Nom du programme'));assert(differences.some(x=>x.remote.includes('Other base')&&x.remote.includes('90')));assert.equal(a.name,'Mon programme');
 const view=new TrainingProgram(host(),{program:a});view.showError(Object.assign(error(409),{currentProgram:b}));assert.equal(view.program.name,a.name);assert.match(view.host.innerHTML,/Deux versions/);assert.match(view.host.innerHTML,/Utiliser la version enregistrée/);
});
test('progress keeps effort separate from mastery and escapes user text, retaining null versus zero duration',()=>{
 const block={...week().blocks[0],title:'<script>bad</script>',progress:{realized:75,target:60,remaining:0,duration_ms:null}};
 let html=progressHtml(block);assert.match(html,/75 \/ 60/);assert.match(html,/value="60" max="60"/);assert.match(html,/Durées renseignées.*—/);assert.doesNotMatch(html,/<script>|Maîtrise|réussis/);assert.match(html,/&lt;script&gt;/);
 block.progress.duration_ms=0;html=progressHtml(block);assert.match(html,/Durées renseignées.*0 min/);
 assert.match(blockGoal({...createBlock('reading'),metric:'quantity',target:2}),/2 parties étudiées/);
});
test('study date follows the configured zone and study-day boundary through DST',()=>{
 const settings={timezone:'America/Toronto',start_hour:4};
 assert.equal(currentStudyDate(settings,new Date('2026-10-26T06:30:00Z')),'2026-10-25');
 assert.equal(currentStudyDate(settings,new Date('2026-10-26T09:00:00Z')),'2026-10-26');
 assert.equal(currentStudyDate(settings,new Date('2026-11-01T06:30:00Z')),'2026-10-31');
});

test('one compact overview follows menu order while planned blocks and goals stay in Programme',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();view.overview=overview(view.week);view.overview.categories.reverse();
 const category=view.overview.categories.find(c=>c.activity==='review');category.today={duration_ms:1080000,attempts:12};category.progress={duration_ms:4500000,attempts:29};category.daily_target_minutes=20;category.target_minutes=60;
 const html=view.todayHtml();assert.equal(view.weekHtml(),html);assert.equal((html.match(/data-category-row=/g)||[]).length,11);assert.deepEqual([...html.matchAll(/data-category-row="([^"]+)"/g)].map(match=>match[1]),CATEGORY_IDS);const management=view.categoryManagementHtml();assert.equal((management.match(/data-block-row="b"/g)||[]).length,1);assert.equal((management.match(/<h3>My opening<\/h3>/g)||[]).length,1);assert.match(management,/data-category-picker/);assert.match(management,/data-category-goal-form="review"/);
 assert.match(html,/tp-block-today[\s\S]*18 \/ 20 min[\s\S]*12 essais/);assert.match(html,/tp-block-week[\s\S]*75 \/ 60[\s\S]*29 essais/);assert.doesNotMatch(html,/tp-category-details|data-category-goal-form|data-block-row|Objectifs et détails|Goals and details|tp-other-runs|tp-daily-breakdown|tp-session-planner/);
 assert.doesNotMatch(html,/tp-today-work|tp-today-grid|tp-proposals|Travail à attribuer|data-assignment/);
});

test('all categories accumulate without a programme or positive goal',()=>{
 const view=new TrainingPlan(host());view.data={...state(),programs:[],current_program_id:null};view.week=null;view.overview=overview(null);
 const reading=view.overview.categories.find(c=>c.activity==='reading');reading.today={duration_ms:180000,attempts:null};reading.progress={duration_ms:540000,attempts:null};
 const html=view.todayHtml();assert.equal((html.match(/data-category-row=/g)||[]).length,11);assert.equal((html.match(/Sans objectif/g)||[]).length>=22,true);assert.doesNotMatch(html,/<progress|data-block-row|data-plan-action="assign/);assert.match(html,/3 min/);assert.match(html,/9 min/);assert.match(html,/Ajoute une base compatible pour commencer/);assert.match(html,/data-category="coordinates" data-scope="free"/);assert.doesNotMatch(view.programHtml(),/tp-category-management|data-category-picker|data-category-goal-form/);assert.match(view.programHtml(),/data-program-picker/);
});

test('legacy week routes resolve to the single day and week tab',async()=>{
 const routes=[],view=new TrainingPlan(host(),{view:'week',onRoute:value=>routes.push(value)});
 view.data=state();view.week=week();view.render();
 assert.equal(view.view,'today');assert.match(view.host.innerHTML,/Jour et semaine/);
 assert.doesNotMatch(view.host.innerHTML,/data-plan-view="(?:week|summary)"/);assert.deepEqual([...view.host.innerHTML.matchAll(/data-plan-view="([^"]+)"/g)].map(match=>match[1]),['today','program','statistics']);
 await view.setView('program');await view.setView('week');
 assert.equal(view.view,'today');assert.equal(routes.at(-1),'today');
});

test('category overview retains unknown daily measurements and measured zero separately',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=null;view.overview=overview(null);const category=view.overview.categories[0];
 category.today={duration_ms:null,attempts:null};let html=categoryPeriodHtml(category,'today',{effortHtml,workCounts});assert.match(html,/<strong>—<\/strong>/);assert.match(html,/Sans objectif/);
 category.today={duration_ms:0,attempts:0};html=categoryPeriodHtml(category,'today',{effortHtml,workCounts});assert.match(html,/<strong>0 min<\/strong>/);assert.match(html,/0 essais/);
});

test('category day and week goals stay independent and both use the same progress structure',()=>{
 const category=overview(null).categories.find(c=>c.activity==='coordinates');Object.assign(category,{daily_target_minutes:5,target_minutes:20,today:{duration_ms:180000,attempts:145,sessions:1},progress:{duration_ms:540000,attempts:418,sessions:2}});
 for(const language of ['fr','en']){setLanguage(language);const today=categoryPeriodHtml(category,'today',{effortHtml,workCounts}),weekly=categoryPeriodHtml(category,'week',{effortHtml,workCounts});assert.match(today,/>3 \/ 5 min<\/strong>/);assert.match(today,/<progress value="3" max="5"/);assert.match(weekly,/>9 \/ 20 min<\/strong>/);assert.match(weekly,/<progress value="9" max="20"/);assert.match(today,/145/);assert.match(weekly,/418/);assert.doesNotMatch(today,/418/);}
 assert.equal(categoryRemaining(category,'today'),2);assert.equal(categoryRemaining(category,'week'),11);
 setLanguage('fr');let launch=categoryLaunchHtml(category,{run:{id:'native'}});assert.match(launch,/Reprendre aujourd’hui.*2 min restants/);assert.match(launch,/Reprendre la semaine.*11 min restants/);
 category.today.duration_ms=360000;launch=categoryLaunchHtml(category);assert.match(launch,/data-scope="today"[^>]*disabled/);assert.doesNotMatch(launch,/data-scope="week"[^>]*disabled/);
 category.daily_target_minutes=0;assert.doesNotMatch(categoryPeriodHtml(category,'today',{effortHtml,workCounts}),/<progress|Objectif atteint/);assert.match(categoryLaunchHtml(category),/data-scope="free"/);assert.equal(categoryRemaining(category,'week'),11);
});

test('assignment controls are absent from the overview, recorded history and assistance',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();view.overview=overview(view.week);view.week.unassigned=[{id:'old',tool:'review',resource:{type:'base',id:5},duration_ms:60000}];
 view.week.activities=[{id:'old',title:'Old activity',tool:'review',duration_ms:60000}];
 for(const html of [view.todayHtml(),view.activitiesHtml(view.week),view.activitiesHtml(view.week,{readonly:true}),trainingAssistanceHtml({settings:{automatic:true},unassigned_count:3,suggestions:[]})])assert.doesNotMatch(html,/Travail à attribuer|Work to assign|data-assignment|data-group-assignment|data-assistance-auto|data-plan-action="(?:assign|assign-group|auto-assign)/);
});

const periodMarkup=(html,period)=>{
 const content=html.match(new RegExp('<div class="tp-block-'+period+'">([\\s\\S]*?)</div>'))?.[1];
 assert(content,'Missing '+period+' period');return content;
};

test('daily and weekly columns show the same ratio, bar and effort structure with their own measurements',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();
 const block=view.week.blocks[0];block.target=20;block.session_minutes=5;
 block.today={duration_ms:180000,attempts:145,sessions:1};
 block.progress={realized:9,target:20,remaining:11,duration_ms:540000,attempts:418,sessions:2};
 for(const language of ['fr','en']){
  setLanguage(language);const html=view.overviewBlockHtml(block),today=periodMarkup(html,'today'),weekly=periodMarkup(html,'week');
  assert.match(today,/<strong[^>]*>3 \/ 5 min<\/strong>/);assert.match(today,/<progress[^>]*value="3"[^>]*max="5"/);
  assert.match(weekly,/<strong[^>]*>9 \/ 20 min<\/strong>/);assert.match(weekly,/<progress[^>]*value="9"[^>]*max="20"/);
  assert.match(today,new RegExp('<small>3 min.*145 '+(language==='fr'?'essais':'attempts')+'.*1 '+(language==='fr'?'séances':'sessions')));
  assert.match(weekly,new RegExp('<small>9 min.*418 '+(language==='fr'?'essais':'attempts')+'.*2 '+(language==='fr'?'séances':'sessions')));
  assert.doesNotMatch(today,/418/);assert.doesNotMatch(weekly,/145/);
 }
});

test('daily goals use completed sessions and credited quantities independently of attempts',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();const block=view.week.blocks[0];
 for(const [metric,unit,value] of [['sessions','cards',1],['quantity','cards',2],['quantity','games',3],['quantity','positions',4]]){
  Object.assign(block,{metric,unit,target:8,today:{duration_ms:180000,attempts:145,cards:2,games:3,positions:4,sessions:1},progress:{realized:6,target:8,duration_ms:540000,attempts:418}});
  const today=periodMarkup(view.overviewBlockHtml(block),'today');
  assert.match(today,new RegExp('<strong[^>]*>'+value+' / 8 '));assert.match(today,new RegExp('<progress[^>]*value="'+value+'"[^>]*max="8"'));
  assert.match(today,/145 essais/);assert.doesNotMatch(today,/<strong[^>]*>145 \/|value="145"/);
 }
});

test('daily bar caps at the target without losing excess work or inventing known durations',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();const block=view.week.blocks[0];
 block.target=30;block.session_minutes=20;block.progress={realized:27,target:20,duration_ms:1620000};
 block.today={duration_ms:1500000,attempts:200};
 let today=periodMarkup(view.overviewBlockHtml(block),'today');
 assert.match(today,/<strong[^>]*>25 \/ 20 min<\/strong>/);assert.match(today,/<progress[^>]*value="20"[^>]*max="20"/);assert.match(today,/<small>25 min.*200 essais/);
 block.today={duration_ms:null,attempts:null};today=periodMarkup(view.overviewBlockHtml(block),'today');
 assert.match(today,/<strong[^>]*>0 \/ 20 min<\/strong>/);assert.match(today,/<progress[^>]*value="0"[^>]*max="20"/);assert.match(today,/<small>—<\/small>/);
 block.today={duration_ms:0,attempts:0};today=periodMarkup(view.overviewBlockHtml(block),'today');
 assert.match(today,/<strong[^>]*>0 \/ 20 min<\/strong>/);assert.match(today,/<small>0 min.*0 essais<\/small>/);assert.doesNotMatch(today,/NaN|undefined/);
});

test('current runs resume in their category and Programme keeps block controls without extra overview sections',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();
 const current={id:'current-run',week_id:'w',block_id:'b',block:structuredClone(view.week.blocks[0]),state:'paused',activity:'review',native_ref:{id:'native',tool:'review'},launch:{base_id:5},duration_ms:1000};
 const older={...current,id:'older-run',week_id:'old-week',block:{...current.block,title:'Previous opening'}};
 view.week.active_runs=[current];view.data.active_runs=[current,older];view.overview=overview(view.week);view.data.resources=[{type:'base',id:5,name:'Reti',activities:['review']}];
 const category=view.overview.categories.find(c=>c.activity==='review');category.active_runs=[current];category.daily_target_minutes=20;category.target_minutes=60;
 const html=view.todayHtml(),row=html.match(/<article[^>]*data-category-row="review"[\s\S]*?<\/article>/)?.[0];
 assert(row);assert.match(row,/data-plan-action="launch-category" data-category="review" data-scope="today" data-run="current-run"/);
 assert.doesNotMatch(row,/data-run="older-run"|data-plan-action="launch-block"|data-block-row/);
 assert.equal((row.match(/data-plan-action="launch-category"/g)||[]).length,2);
 assert.doesNotMatch(html,/Autres séances en cours|tp-other-runs|tp-daily-breakdown|tp-session-planner/);
 const management=view.categoryManagementHtml();assert.match(management,/data-plan-action="launch-period" data-block="b" data-scope="today" data-run="current-run"/);assert.equal((management.match(/<h3>My opening<\/h3>/g)||[]).length,1);
});

test('weekly blocks show all attempts beyond the goal and a separate today contribution',()=>{
 const b={...week().blocks[0],progress:{realized:75,target:60,remaining:0,duration_ms:4500000,attempts:29},today:{duration_ms:1080000,attempts:12}};
 const html=progressHtml(b);assert.match(html,/75 \/ 60/);assert.match(html,/29 essais/);assert.match(html,/Aujourd’hui :.*18 min.*12 essais/);
 const view=new TrainingPlan(host());view.data=state();view.week={...week(),blocks:[b],today:{date:'2026-10-25'},days:[{date:'2026-10-24',duration_ms:null,attempts:null},{date:'2026-10-25',duration_ms:1080000,attempts:12}]};
 const daily=view.daysHtml(view.week);assert.match(daily,/Travail par jour/);assert.match(daily,/scope="row"/);assert.match(daily,/tp-current-day/);assert.match(daily,/<td>—<\/td>/);
 view.overview=overview(view.week);setLanguage('en');assert.match(view.todayHtml(),/Today/);assert.match(progressHtml(b),/12 attempts/);
});

test('automatically assigned free work remains available for an explicit session goal',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();view.week.blocks[0].metric='sessions';
 view.week.activities=[{id:'auto',origin:'automatic',run_id:null,block_id:'b',assignment:{block_id:'b'},duration_ms:1000,tool:'review',resource:{type:'base',id:5},unit:'cards'}];
 assert.match(view.activitiesHtml(view.week),/data-plan-action="episode"/);
 view.episode={block_id:'b'};assert.match(view.episodeHtml(),/value="auto"/);
});
test('uncertain mutation persists its exact receipt and retries without creating another',async()=>{
 const calls=[],drafts=[];let fail=true;const view=new TrainingPlan(host(),{request:async(url,options)=>{calls.push({url,...options});if(fail){fail=false;throw error();}return {id:'saved'};},onDraft:value=>drafts.push(value)});
 await assert.rejects(view.mutate('/programs','POST',{name:'Example',definition:{}},{kind:'program'}));assert(view.pendingMutation);const receipt=view.pendingMutation.body.mutation_id;
 await assert.rejects(view.mutate('/programs','POST',{name:'Different'}),/Vérifie/);assert.equal(calls.length,1);
 assert.equal((await view.mutate('/programs','POST',{name:'Example',definition:{}},{kind:'program'})).id,'saved');assert.equal(calls[1].body.mutation_id,receipt);assert.equal(view.pendingMutation,null);assert(drafts.some(d=>d?.pendingMutation?.body.mutation_id===receipt));
});
test('definitive conflicts clear receipts but keep the edited programme',async()=>{
 const p=program(),view=new TrainingPlan(host(),{draft:{program:p},request:async()=>{throw error(409);}});
 await assert.rejects(view.mutate('/programs/p','PUT',{name:'Changed',expected_revision:1}));assert.equal(view.pendingMutation,null);assert.deepEqual(view.programDraft,p);
});
test('recovering a lost save preserves edits made after the original request',async()=>{
 const sent=program(),draft=structuredClone(sent);draft.name='Newer unsaved name';draft.definition.blocks[0].target=120;
 const body={name:sent.name,definition:sent.definition,expected_revision:1,mutation_id:'old-receipt'},pending={url:'/api/training/programs/p',method:'PUT',body,kind:'program'};
 const view=new TrainingPlan(host(),{draft:{program:draft,pendingMutation:pending},request:async()=>({...sent,revision:2})});view.load=async()=>{};
 await view.recoverMutation();assert.equal(view.programDraft.name,'Newer unsaved name');assert.equal(view.programDraft.definition.blocks[0].target,120);assert.equal(view.programDraft.revision,2);assert.equal(view.pendingMutation,null);
});
test('a proposal from a previous week is discarded rather than launched with a new context',async()=>{
 const view=new TrainingPlan(host(),{draft:{preview:{week_id:'previous',items:[{block_id:'b'}]}},request:async url=>url.endsWith('/state')?state():url.endsWith('/overview')?overview():{week:week(),active_program:program()}});
 await view.load();assert.equal(view.preview,null);
});
test('a stale bootstrap cannot ensure a week or replace a newer screen',async()=>{
 const first=deferred(),calls=[];const view=new TrainingPlan(host(),{request:async(url)=>{calls.push(url);if(calls.length===1)return first.promise;return url.endsWith('/state')?state():url.endsWith('/overview')?overview():{week:week(),active_program:program()};}});
 const older=view.load();await view.load();const fresh=view.data;first.resolve({...state(),programs:[]});await older;assert.equal(view.data,fresh);assert.equal(calls.filter(url=>url.endsWith('/weeks/current')).length,1);
});
test('disposed owner cannot create a week after a delayed read',async()=>{
 const pending=deferred(),calls=[];const view=new TrainingPlan(host(),{request:async url=>{calls.push(url);return pending.promise;}});const loading=view.load();view.dispose();pending.resolve(state());await loading;assert.deepEqual(calls,['/api/training/state']);
});
test('double launch stays blocked until the native launch finishes',async()=>{
 const opening=deferred(),calls=[],launches=[];const view=new TrainingPlan(host(),{request:async(url,options)=>{calls.push([url,options]);return {id:'r',block:week().blocks[0]};},onLaunch:run=>{launches.push(run);return opening.promise;}});view.data=state();view.week=week();view.load=async()=>{};
 const first=view.launchBlock('b',15);await Promise.resolve();await Promise.resolve();await view.launchBlock('b',15);assert.equal(calls.length,1);assert.equal(launches.length,1);opening.resolve();await first;
});
test('manual blocks open a declaration without an orphan run or invented minutes',async()=>{
 const view=new TrainingPlan(host(),{request:async()=>{throw Error('No write expected');},onLaunch:()=>{throw Error('No native launch expected');}});view.data=state();view.week=week();view.week.blocks[0].automatic=false;await view.launchBlock('b',30);assert.equal(view.manual.block_id,'b');assert.equal(view.manual.duration_minutes,null);assert.equal(view.manual.sessions,0);
});

test('period choices show the daily and weekly remaining goal and disable completed periods',()=>{
 const view=new TrainingPlan(host());view.data=state();view.week=week();const b=view.week.blocks[0];
 b.target=20;b.session_minutes=5;b.progress={target:20,realized:9};b.today={duration_ms:180000};
 let html=view.periodLaunchHtml(b,{id:'paused'});
 assert.match(html,/Reprendre aujourd’hui.*2 min restants/);assert.match(html,/Reprendre la semaine.*11 min restants/);
 b.metric='quantity';b.unit='cards';b.today={cards:7,attempts:145};b.progress.realized=20;
 html=view.periodLaunchHtml(b,{id:'paused'});assert.match(html,/13 cartes travaillées restants/);
 assert.match(html,/data-scope="week"[^>]*disabled/);assert.doesNotMatch(html,/data-scope="today"[^>]*disabled/);
});

test('scoped resume retargets the same run and keeps an uncertain request recoverable',async()=>{
 const calls=[],launched=[],view=new TrainingPlan(host(),{request:async(url,options)=>{calls.push({url,...structuredClone(options)});if(calls.length===1)throw error();return {id:'r',block_id:'b',native_ref:{id:'native'}};},onLaunch:async run=>launched.push(run)});
 view.data=state();view.week=week();view.week.active_runs=[{id:'r',block_id:'b',week_id:'w',revision:7,state:'paused',block:structuredClone(view.week.blocks[0])}];view.load=async()=>{};
 await assert.rejects(view.launchPeriod('b','week'),/Unavailable/);assert.equal(view.launching,false);
 assert.equal(calls[0].method,'PATCH');assert.equal(calls[0].url,'/api/training/runs/r');
 assert.equal(calls[0].body.action,'resume');assert.equal(calls[0].body.goal_scope,'week');assert.equal(calls[0].body.expected_revision,7);
 assert.equal(view.pendingMutation.kind,'run');await view.recoverMutation();
 assert.deepEqual(calls[1].body,calls[0].body);assert.equal(launched.length,1);assert.equal(launched[0].native_ref.id,'native');
});

test('new scoped launches send the period without inventing a remaining budget and block double clicks',async()=>{
 const opening=deferred(),calls=[],view=new TrainingPlan(host(),{request:async(url,options)=>{calls.push({url,...options});return {id:'new'};},onLaunch:()=>opening.promise});
 view.data=state();view.week=week();view.load=async()=>{};
 const first=view.launchPeriod('b','today');await Promise.resolve();await Promise.resolve();await view.launchPeriod('b','week');
 assert.equal(calls.length,1);assert.equal(calls[0].method,'POST');assert.equal(calls[0].body.goal_scope,'today');assert.equal(calls[0].body.minutes,undefined);
 opening.resolve();await first;
 view.week.blocks[0].progress.realized=60;await view.launchPeriod('b','week');assert.equal(calls.length,1);
});

test('a category without a programme resumes the same source with a recoverable period request',async()=>{
 const calls=[],launched=[],view=new TrainingPlan(host(),{request:async(url,options)=>{calls.push({url,...structuredClone(options)});if(calls.length===1)throw error();return {id:'existing',native_ref:{id:'native-review'}};},onLaunch:async run=>launched.push(run)});
 view.data={...state(),programs:[],current_program_id:null,resources:[{type:'base',id:5,activities:['review']}]};view.week=null;view.overview=overview(null);view.load=async()=>{};
 view.overview.categories.find(c=>c.activity==='review').active_runs=[{id:'existing',revision:4,state:'paused',launch:{base_id:5}}];
 await assert.rejects(view.launchCategory('review','week'),/Unavailable/);assert.equal(calls[0].url,'/api/training/categories/review/runs');assert.equal(calls[0].body.goal_scope,'week');assert.equal(calls[0].body.run_id,'existing');assert.equal(calls[0].body.base_id,5);assert.equal(calls[0].body.expected_revision,4);assert.equal(calls[0].body.minutes,undefined);
 await view.recoverMutation();assert.deepEqual(calls[1].body,calls[0].body);assert.equal(launched[0].native_ref.id,'native-review');assert.equal(view.pendingMutation,null);
});

test('changing the category source cannot resume another database and a free launch remains unbounded',async()=>{
 const calls=[],opening=deferred(),view=new TrainingPlan(host(),{request:async(url,options)=>{calls.push({url,...structuredClone(options)});return {id:'new-source'};},onLaunch:()=>opening.promise});view.data={...state(),resources:[{type:'base',id:5,activities:['review']},{type:'base',id:7,activities:['review']}]};view.overview=overview(null);view.load=async()=>{};
 view.overview.categories.find(c=>c.activity==='review').active_runs=[{id:'old-source',revision:4,launch:{base_id:5}}];view.categorySources.review='7';
 const first=view.launchCategory('review','free');await Promise.resolve();await Promise.resolve();await view.launchCategory('review','free');assert.equal(calls.length,1);assert.equal(calls[0].body.base_id,7);assert.equal(calls[0].body.goal_scope,'free');assert.equal(calls[0].body.run_id,undefined);assert.equal(calls[0].body.minutes,undefined);opening.resolve();await first;
});

test('external categories can declare work without a programme and analysis opens its tracked board',async()=>{
 const navigated=[],view=new TrainingPlan(host(),{request:async()=>{throw Error('No write expected');},onNavigate:async page=>navigated.push(page)});view.data={...state(),programs:[],current_program_id:null};view.overview=overview(null);await view.launchCategory('external','free');assert.equal(view.manual.activity,'external');assert.equal(view.manual.duration_minutes,null);assert.equal(view.manual.date,'2026-10-25');assert.equal(view.manual.sessions,0);await view.launchCategory('analysis','free');assert.deepEqual(navigated,['analysis']);
});
test('pending preparation is explicitly cancellable while a native activity is preserved',()=>{
 const view=new TrainingPlan(host());assert.match(view.runHtml({id:'r',activity:'review',state:'preparing',block:{title:'A'},duration_ms:null,quantity:0,sessions:0}),/Annuler la préparation/);
 assert.doesNotMatch(view.runHtml({id:'r',activity:'review',state:'active',block:{title:'A'},native_ref:{tool:'review',id:'native'},duration_ms:null,quantity:0,sessions:0}),/Annuler la préparation/);
});
test('owned strings are registered and dynamic personal data is preserved in English',async()=>{
 setLanguage('en');for(const [source,translated] of Object.entries(messages))assert.equal(t(source),translated,source);
 for(const file of ['training-plan.js','training-program.js','training-category-view.js']){const source=await readFile(new URL('../static/'+file,import.meta.url),'utf8');for(const match of source.matchAll(/\bt\('([^'\n]+)'/g)){const text=match[1];if(text.includes('<')||text.includes('>'))continue;assert(Object.hasOwn(messages,text)||t(text)!==text,'Missing translation: '+text);}}
 const view=new TrainingProgram(host(),{program:{...program(),name:'Mon répertoire personnel'}});assert.match(view.host.innerHTML,/Mon répertoire personnel/);assert.match(view.host.innerHTML,/Build my programme/);assert.match(view.host.innerHTML,/My training blocks/);assert.match(view.host.innerHTML,/My week/);assert.doesNotMatch(view.host.innerHTML,/tp-templates|data-template-list|data-template-detail|A starting point|Templates to make your own/);
});

test('blindfold category uses default puzzles despite old selected or ongoing custom databases',async()=>{
 const calls=[],view=new TrainingPlan(host(),{request:async(url,options)=>{calls.push({url,...options});return {id:'default-puzzles'};}});view.data={...state(),resources:[{type:'base',id:5,name:'Personal games',activities:['blindfold']}]};view.overview=overview(null);view.load=async()=>{};
 const category=view.overview.categories.find(c=>c.activity==='blindfold');category.active_runs=[{id:'personal',launch:{base_id:5}}];view.categorySources.blindfold='5';
 assert.equal(categorySourceHtml(category,{resources:view.data.resources,baseId:'5'}),'');assert.equal(view.categoryBase(category),'');assert.equal(view.categoryRun(category),undefined);
 await view.launchCategory('blindfold','today');assert.equal(calls[0].body.base_id,undefined);assert.equal(calls[0].body.run_id,undefined);assert.equal(calls[0].body.goal_scope,'today');
});
