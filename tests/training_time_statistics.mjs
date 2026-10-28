import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setLanguage,t,sourceMessages} from '../static/i18n.js';
import messages from '../static/locales/en-training-time-statistics.js';
import {TrainingTimeStatistics,TIME_CATEGORIES,validStatisticsDate,shiftStatisticsDate,statisticsRange,previousStatisticsRange,statisticsDays,groupStatisticsDays,statisticsSummary,statisticsWeekdays,statisticsTime} from '../static/training-time-statistics.js';

const host=()=>({innerHTML:'',listeners:new Map(),classList:{add(){},remove(){}},addEventListener(type,fn){this.listeners.set(type,fn);},removeEventListener(type){this.listeners.delete(type);}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const payload=(from='2026-10-25',to='2026-10-27')=>({date_from:from,date_to:to,days:[{date:'2026-10-25',duration_ms:180000,by_activity:{review:120000,reading:60000},by_activity_unknown:{}},{date:'2026-10-26',duration_ms:300000,by_activity:{review:0,analysis:300000},by_activity_unknown:{reading:1}},{date:'2026-10-27',duration_ms:0,by_activity:{review:0,reading:0},by_activity_unknown:{}}]});
beforeEach(()=>setLanguage('fr'));

test('date ranges use inclusive UTC dates through leap years and DST, and reject invalid dates',()=>{
 assert(validStatisticsDate('2024-02-29'));assert(!validStatisticsDate('2026-02-29'));assert(!validStatisticsDate('2026-13-01'));assert(!validStatisticsDate('2026-02-31'));
 assert.equal(shiftStatisticsDate('2026-11-01',1),'2026-11-02');assert.equal(shiftStatisticsDate('2026-03-08',1),'2026-03-09');
 assert.equal(statisticsRange('2026-10-25','2026-10-27').days,3);assert.equal(statisticsRange('2026-10-28','2026-10-27'),null);
 assert.equal(statisticsRange('2024-01-01','2025-12-30').days,730);assert.equal(statisticsRange('2024-01-01','2025-12-31'),null);
 assert.deepEqual(previousStatisticsRange('2026-03-01','2026-03-03'),{date_from:'2026-02-26',date_to:'2026-02-28'});
});

test('all eleven categories are available and filtered totals never use unrelated global totals',()=>{
 assert.equal(TIME_CATEGORIES.length,11);assert(TIME_CATEGORIES.includes('analysis'));
 const days=statisticsDays(payload());assert.equal(days.length,3);assert.equal(statisticsSummary(days).duration_ms,480000);
 const onlyReading=statisticsDays(payload(),undefined,undefined,['reading']);assert.equal(statisticsSummary(onlyReading).duration_ms,60000);assert.equal(statisticsSummary(onlyReading).unknown_duration_count,1);
 assert.equal(statisticsSummary(statisticsDays(payload(),undefined,undefined,[])).duration_ms,0);
});

test('missing measurements stay distinguishable from measured zero and invalid values cannot inflate totals',()=>{
 const data={date_from:'2026-10-25',date_to:'2026-10-27',days:[{date:'2026-10-25',by_activity:{review:null,reading:-10,puzzles:'900000'},by_activity_unknown:{}},{date:'2026-10-26',by_activity:{review:0},by_activity_unknown:{reading:2}}]};
 const days=statisticsDays(data);assert.equal(days[0].duration_ms,0);assert.equal(days[0].unknown_duration_count,1);assert.equal(days[1].unknown_duration_count,2);assert.equal(days[2].duration_ms,0);assert.equal(days[2].unknown_duration_count,0);
 const summary=statisticsSummary(days);assert.equal(summary.unknown_duration_count,3);assert.equal(summary.active_days,0);assert.equal(summary.average_ms,0);assert.equal(statisticsTime(0),'0 min');assert.equal(statisticsTime(null),'—');assert.equal(statisticsTime(30000),'< 1 min');
});

test('weekly and monthly grouping preserve exact time across Monday and year boundaries',()=>{
 const data={date_from:'2025-12-28',date_to:'2026-01-05',days:[{date:'2025-12-28',by_activity:{review:60000}},{date:'2025-12-31',by_activity:{review:120000}},{date:'2026-01-01',by_activity:{reading:180000}},{date:'2026-01-05',by_activity:{analysis:240000}}]},days=statisticsDays(data),weeks=groupStatisticsDays(days,'week'),months=groupStatisticsDays(days,'month');
 assert.deepEqual(weeks.map(row=>row.key),['2025-12-22','2025-12-29','2026-01-05']);assert.deepEqual(weeks.map(row=>row.duration_ms),[60000,300000,240000]);assert.deepEqual(weeks.map(row=>row.days),[1,7,1]);
 assert.deepEqual(months.map(row=>row.duration_ms),[180000,420000]);assert.equal(months.reduce((sum,row)=>sum+row.duration_ms,0),statisticsSummary(days).duration_ms);
});

test('daily and weekday averages include inactive days but not weekdays outside the range',()=>{
 const days=statisticsDays(payload()),summary=statisticsSummary(days),weekdays=statisticsWeekdays(days);assert.equal(summary.active_days,2);assert.equal(summary.average_ms,160000);
 assert.equal(weekdays[0].average_ms,300000);assert.equal(weekdays[1].average_ms,0);assert.equal(weekdays[1].days,1);assert.equal(weekdays[2].days,0);assert.equal(weekdays[6].average_ms,180000);
});

test('rendered charts include accessible summaries, all categories, unknown annotations and no goal requirement',()=>{
 const view=new TrainingTimeStatistics(host(),{today:'2026-10-27'});view.date_from='2026-10-25';view.data=payload();view.previous={days:[]};view.render();const html=view.host.innerHTML;
 assert.equal((html.match(/data-stats-category=/g)||[]).length,11);assert.match(html,/Temps cumulé/);assert.match(html,/8 min/);assert.match(html,/durée inconnue/);assert.match(html,/tts-timeline/);assert.match(html,/tts-calendar/);assert.match(html,/tts-distribution/);assert.match(html,/tts-weekdays/);assert.match(html,/<caption>/);assert.match(html,/role="img"/);assert.doesNotMatch(html,/NaN|Infinity|Work to assign|Travail à attribuer/);
 view.selected=[];view.render();assert.match(view.host.innerHTML,/Sélectionne une activité/);assert.doesNotMatch(view.host.innerHTML,/tts-timeline/);view.dispose();assert.equal(view.host.listeners.size,0);
});

test('empty periods render honestly without a divide-by-zero or fabricated time',()=>{
 const view=new TrainingTimeStatistics(host(),{today:'2026-10-27'});view.data={days:[]};view.previous={days:[]};view.render();assert.match(view.host.innerHTML,/Aucune durée mesurée/);assert.match(view.host.innerHTML,/0 min/);assert.doesNotMatch(view.host.innerHTML,/NaN|Infinity/);
});

test('short periods leave enough room between timeline and calendar labels',()=>{
 const view=new TrainingTimeStatistics(host(),{today:'2026-10-27'}),days=statisticsDays({date_from:'2026-09-28',date_to:'2026-10-27',days:[]}),timeline=view.timelineHtml(groupStatisticsDays(days)),calendar=view.calendarHtml(days);
 const positions=html=>[...html.matchAll(/class="tts-axis-(?:date|month)" x="([\d.]+)"/g)].map(match=>Number(match[1]));
 const dates=positions(timeline);for(let index=1;index<dates.length;index++)assert(dates[index]-dates[index-1]>=42);
 assert.equal(positions(calendar).length,1);assert.match(calendar,/oct\./);
});

test('a phone shows every bar of a short period and chart observers are disposed',()=>{
 const previous=globalThis.ResizeObserver;let resize,disconnected=false;
 globalThis.ResizeObserver=class {constructor(callback){resize=callback;}observe(){}disconnect(){disconnected=true;}};
 try{const content=host();content.clientWidth=280;const view=new TrainingTimeStatistics(content,{today:'2026-10-27'}),days=statisticsDays({date_from:'2026-09-28',date_to:'2026-10-27',days:[]});
  let html=view.timelineHtml(groupStatisticsDays(days));assert.match(html,/viewBox="0 0 240 245"/);assert.doesNotMatch(html,/min-width|data-time-scroll/);assert(([...html.matchAll(/tts-axis-date/g)]).length<=3);
  view.data=payload();content.clientWidth=390;resize();assert.match(content.innerHTML,/viewBox="0 0 350 245"/);view.dispose();assert(disconnected);
 }finally{globalThis.ResizeObserver=previous;}
});

test('filtering and grouping update every chart from the same selected measurements',async()=>{
 const view=new TrainingTimeStatistics(host(),{today:'2026-10-27'});view.date_from='2026-10-25';view.data=payload();view.selected=['review','reading'];
 await view.handleChange({target:{matches:s=>s==='[data-stats-category]',dataset:{statsCategory:'review'},checked:false}});assert.deepEqual(view.selected,['reading']);assert.match(view.host.innerHTML,/1 min/);assert.doesNotMatch(view.host.innerHTML,/8 min/);
 await view.handleChange({target:{matches:s=>s==='[data-stats-grouping]',value:'month'}});assert.equal(view.grouping,'month');assert.equal(groupStatisticsDays(statisticsDays(view.data,view.date_from,view.date_to,view.selected),'month').length,1);
});

test('load compares equal inclusive periods and previous-period failure does not hide current results',async()=>{
 const requests=[],view=new TrainingTimeStatistics(host(),{today:'2026-10-27',request:async url=>{requests.push(url);if(url.includes('date_to=2026-09-27'))throw new Error('Unavailable');return payload('2026-09-28','2026-10-27');}});await view.load();
 assert.equal(requests.length,2);assert.match(requests[0],/date_from=2026-09-28&date_to=2026-10-27/);assert.match(requests[1],/date_from=2026-08-29&date_to=2026-09-27/);assert.equal(view.previous,null);assert.equal(view.error,'');assert.match(view.host.innerHTML,/Période précédente indisponible/);assert.match(view.host.innerHTML,/Temps cumulé/);
});

test('a slower obsolete load cannot overwrite a newer range or a disposed screen',async()=>{
 const requests=[],view=new TrainingTimeStatistics(host(),{today:'2026-10-27',request:()=>{const item=deferred();requests.push(item);return item.promise;}});const first=view.load();view.date_from='2026-10-25';const second=view.load();
 requests[2].resolve(payload());requests[3].resolve({days:[]});await second;const current=view.data;requests[0].resolve({days:[],marker:'old'});requests[1].resolve({days:[]});await first;assert.equal(view.data,current);
 const third=view.load(),markup=view.host.innerHTML;view.dispose();requests[4].resolve({days:[],marker:'disposed'});requests[5].resolve({days:[]});await third;assert.equal(view.host.innerHTML,markup);assert.equal(view.data,current);
});

test('invalid custom dates make no request and current failures remain retryable',async()=>{
 let requests=0;const view=new TrainingTimeStatistics(host(),{today:'2026-10-27',request:async()=>{requests++;throw new Error('<unexpected>');}});await view.setDates('2026-02-31','2026-10-27');assert.equal(requests,0);assert.match(view.host.innerHTML,/730 jours/);
 await view.load();assert.equal(requests,2);assert.match(view.host.innerHTML,/&lt;unexpected&gt;/);assert.match(view.host.innerHTML,/data-stats-action="retry"/);assert.equal(view.data,null);
});

test('English time statistics messages are registered and all literal labels are translated',async()=>{
 setLanguage('en');for(const [source,translation] of Object.entries(messages))assert.equal(t(source),translation,source);
 const source=await readFile(new URL('../static/training-time-statistics.js',import.meta.url),'utf8');for(const [,literal] of source.matchAll(/\bt\('([^']+)'/g))assert(Object.hasOwn(sourceMessages,literal),literal);
 const view=new TrainingTimeStatistics(host(),{today:'2026-10-27'});view.data=payload();view.render();assert.match(view.host.innerHTML,/Your training time/);assert.match(view.host.innerHTML,/Time distribution/);assert.doesNotMatch(view.host.innerHTML,/Ton temps d’entraînement|Temps cumulé/);
});
