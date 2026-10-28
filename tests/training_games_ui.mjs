import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage,t} from '../static/i18n.js';
import {TrainingProgram,createBlock,emptyProgram,activityLabel} from '../static/training-program.js';
import {TrainingPlan,durationDetails,effortHtml,workCounts} from '../static/training-plan.js';
import {CATEGORY_IDS,categoryPeriodHtml,categoryLaunchHtml,categoryManagementHtml} from '../static/training-category-view.js';
import {TrainingTimeStatistics,statisticsDays,statisticsSummary,groupStatisticsDays} from '../static/training-time-statistics.js';

const host=()=>({innerHTML:'',classList:{add(){},remove(){},toggle(){}},addEventListener(){},removeEventListener(){},querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false});
const category=()=>({id:'games',activity:'games',target_minutes:60,daily_target_minutes:20,progress:{duration_ms:960000,duration_by_kind:{estimated:360000,calculated:600000}},today:{duration_ms:null}});
const payload=()=>({date_from:'2026-10-26',date_to:'2026-10-27',days:[
 {date:'2026-10-26',by_activity:{games:960000,analysis:60000},by_activity_duration_by_kind:{games:{calculated:600000,estimated:360000},analysis:{active:60000}}},
 {date:'2026-10-27',by_activity:{games:null},by_activity_unknown:{games:1}},
]});
beforeEach(()=>setLanguage('fr'));

test('Games is an automatically derived programme activity with a fixed My Games source',()=>{
 assert(CATEGORY_IDS.includes('games'));const block=createBlock('games');
 assert.equal(block.axis,'play');assert.equal(block.unit,'games');assert.deepEqual(block.resource,{type:'tool',id:'games',name:'Mes parties',generation:'tool-v1'});
 const program={...emptyProgram(),definition:{blocks:[block]}},view=new TrainingProgram(host(),{program,resources:[{...block.resource,activities:['games']}]});
 const html=view.blockHtml(block,0);assert.match(html,/data-block-field="resource" disabled/);assert.match(html,/tool:games:tool-v1/);assert.match(html,/option value="quantity"/);
 assert.doesNotMatch(html,/option value="sessions"|data-block-field="session_minutes"|data-block-field="resource_name"/);
});

test('Games navigation opens My Games without a native run or manual declaration',async()=>{
 const pages=[],view=new TrainingPlan(host(),{request:async()=>{throw Error('No request expected');},onNavigate:page=>pages.push(page),onLaunch:()=>{throw Error('No native run expected');}});
 const block={...createBlock('games'),id:'g',available:true,automatic:true};view.week={id:'w',blocks:[block]};
 await view.launchCategory('games','free');await view.launchBlock('g');await view.launchPeriod('g','today');assert.deepEqual(pages,['played','played','played']);
 assert.match(view.periodLaunchHtml(block),/Ouvrir mes parties/);assert.match(categoryLaunchHtml(category()),/data-category="games"/);
 const html=categoryManagementHtml(category(),{effortHtml});assert.match(html,/Objectif du jour/);assert.match(html,/Ouvrir mes parties/);assert.doesNotMatch(html,/manual-category|Continuer librement/);
 view.manual={activity:'external',date:'2026-10-27',title:'Work'};assert.doesNotMatch(view.manualHtml(),/option value="games"/);
});

test('Games shows unknown time and estimates honestly with and without a goal',()=>{
 const item=category(),options={effortHtml,workCounts};let html=categoryPeriodHtml(item,'today',options);assert.match(html,/— \/ 20/);assert.doesNotMatch(html,/0 \/ 20/);
 item.daily_target_minutes=0;html=categoryPeriodHtml(item,'today',options);assert.match(html,/<strong>—<\/strong>/);
 html=categoryPeriodHtml(item,'week',options);assert.match(html,/16 \/ 60/);assert.match(html,/Dont 6 min estimées d’après la cadence/);
 const details=durationDetails(item.progress.duration_by_kind);assert.match(details,/Temps estimé d’après la cadence : 6 min/);assert.match(details,/Temps calculé à partir des pendules : 10 min/);
 setLanguage('en');assert.equal(activityLabel('games'),'Games');assert.equal(t('Ouvrir mes parties'),'Open My Games');assert.match(categoryPeriodHtml(item,'week',options),/Including 6 min estimated from the time control/);
});

test('Games statistics retain provenance through filters and grouping without inflating totals',()=>{
 const days=statisticsDays(payload(),undefined,undefined,['games']),summary=statisticsSummary(days),groups=groupStatisticsDays(days,'week');
 assert.equal(summary.duration_ms,960000);assert.equal(summary.by_activity_estimated.games,360000);assert.equal(summary.by_activity_calculated.games,600000);assert.equal(summary.unknown_duration_count,1);
 assert.equal(groups[0].by_activity_estimated.games,360000);assert.equal(groups[0].by_activity_calculated.games,600000);
 const onlyAnalysis=statisticsSummary(statisticsDays(payload(),undefined,undefined,['analysis']));assert.equal(onlyAnalysis.duration_ms,60000);assert.equal(onlyAnalysis.by_activity_estimated.games,0);assert.equal(onlyAnalysis.unknown_duration_count,0);
 const invalid=payload();invalid.days[0].by_activity_duration_by_kind.games={estimated:1200000,calculated:900000};const safe=statisticsSummary(statisticsDays(invalid));assert.equal(safe.by_activity_estimated.games,960000);assert.equal(safe.by_activity_calculated.games,0);
});

test('visible statistics mark estimated portions only for selected activities',()=>{
 const view=new TrainingTimeStatistics(host(),{today:'2026-10-27'});view.date_from='2026-10-26';view.data=payload();view.selected=['games'];view.render();
 assert.match(view.host.innerHTML,/Dont 6 min estimées d’après la cadence/);assert.match(view.host.innerHTML,/Dont 10 min calculées à partir des pendules/);assert.match(view.host.innerHTML,/16 min ≈/);assert.match(view.host.innerHTML,/durée inconnue/);
 view.selected=['analysis'];view.render();assert.doesNotMatch(view.host.innerHTML,/tts-provenance|16 min ≈|Dont 6 min/);assert.match(view.host.innerHTML,/1 min/);
});
