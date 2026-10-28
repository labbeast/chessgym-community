import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join,resolve} from 'node:path';
const root=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(import.meta.url);
const dependencies=process.env.CHESSGYM_TEST_NODE_MODULES||join(process.env.USERPROFILE,'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules');
const {chromium}=require(join(dependencies,'playwright'));
const output=resolve(root,'output/training-games-ui');await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHESSGYM_TEST_BROWSER||'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'});
try{
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('http://chessgym.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/static/styles.css"><link rel="stylesheet" href="/static/training-plan.css"><link rel="stylesheet" href="/static/training-time-statistics.css"><link rel="stylesheet" href="/static/ui-icons.css"></head><body><main id="host" style="max-width:1150px;margin:24px auto;padding:16px"></main></body></html>'});
  if(!path.startsWith('/static/'))return route.abort();
  try{return route.fulfill({body:await readFile(join(root,path.slice(1))),contentType:path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'application/octet-stream'});}catch{return route.abort();}
 });
 await page.goto('http://chessgym.test/');
 await page.evaluate(async()=>{
  const {setLanguage}=await import('/static/i18n.js'),{TrainingPlan}=await import('/static/training-plan.js'),{CATEGORY_IDS}=await import('/static/training-category-view.js');setLanguage('en');
  const empty={duration_ms:0,games:0,attempts:null},today={duration_ms:960000,games:3,attempts:null,duration_by_kind:{estimated:360000,calculated:600000}},week={duration_ms:2760000,games:6,attempts:null,duration_by_kind:{estimated:360000,calculated:2400000}};
  window.view=new TrainingPlan(document.getElementById('host'),{request:async()=>{throw Error('No API write expected');},onNavigate:page=>{window.destination=page;}});
  view.data={programs:[],resources:[],active_runs:[],templates:[],current_program_id:null};view.overview={week_start:'2026-10-26',week_end:'2026-11-01',today:{date:'2026-10-27',...today},...week,categories:CATEGORY_IDS.map(activity=>({id:activity,activity,target_minutes:activity==='games'?120:0,daily_target_minutes:activity==='games'?30:0,today:activity==='games'?today:empty,progress:activity==='games'?week:empty,blocks:[],resources:[],active_runs:[]})),active_runs:[],days:[],manual_activities:[]};view.render();
 });
 const games=page.locator('[data-category-row="games"]');await games.getByRole('button',{name:'Open My Games'}).click();assert.equal(await page.evaluate(()=>destination),'played');assert.match(await games.innerText(),/Including 6 min estimated from the time control/);
 await page.screenshot({path:join(output,'games-overview-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'games-overview-mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),'overview horizontal overflow');
 await page.setViewportSize({width:1280,height:1000});
 await page.evaluate(async()=>{
  view.dispose();const {TrainingTimeStatistics}=await import('/static/training-time-statistics.js');window.stats=new TrainingTimeStatistics(document.getElementById('host'),{today:'2026-10-27'});stats.date_from='2026-10-26';stats.selected=['games'];stats.data={date_from:'2026-10-26',date_to:'2026-10-27',days:[{date:'2026-10-26',by_activity:{games:960000},by_activity_duration_by_kind:{games:{estimated:360000,calculated:600000}}},{date:'2026-10-27',by_activity:{games:null},by_activity_unknown:{games:1}}]};stats.render();
 });
 assert.match(await page.locator('.tts-provenance').innerText(),/Including 6 min estimated/);assert.match(await page.locator('.tts-provenance').innerText(),/Including 10 min calculated/);assert.match(await page.locator('.tts-unknown').innerText(),/unknown/);
 await page.screenshot({path:join(output,'games-statistics-desktop.png'),fullPage:true});assert.deepEqual(errors,[]);console.log(JSON.stringify({output,checks:'navigation, estimates, unknown durations, desktop and mobile overflow',screenshots:3}));
}finally{await browser.close();}
