import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const report={checks:[],errors:[],geometry:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:1000},args:['--no-first-run','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function json(path,method='GET',data){const r=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(r.ok(),path+' '+r.status()+' '+await r.text());return r.json();}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function poll(fn,label){for(let n=0;n<100;n++){const value=await fn();if(value)return value;await page.waitForTimeout(100);}throw Error('Timed out: '+label);}
async function closeStartup(){const button=page.locator('#modal[open] [data-close]').first();if(await button.isVisible())await button.click();}
async function toolbar(){await page.locator('header.topbar [data-training-session-bar]').waitFor();assert.equal(await page.locator('#main [data-training-session-bar]').count(),0);}
async function normalHeader(){assert.equal(await page.locator('[data-training-session-bar]').count(),0);assert.equal(await page.locator('.topbar.training-toolbar-active').count(),0);assert(await page.locator('.top-nav').isVisible());assert(await page.locator('.top-actions [data-page="settings"]').isVisible());}
async function go(pageName){const nav=page.locator('.top-nav'),target=nav.locator('[data-page="'+pageName+'"]');if(!await target.count()){await go('exercises');await page.locator('[data-exercise-page="'+pageName+'"]').click();}else{if(!await target.isVisible())await nav.locator('.navigation-group:has([data-page="'+pageName+'"])>summary').click();await target.click();}await page.waitForURL('**/#/'+pageName+'*');}
async function recordedTime(activity){const overview=await json('/api/training/overview');return overview.categories.find(category=>category.id===activity).today.duration_ms||0;}
async function action(name){const button=page.locator('header.topbar [data-program-session="'+name+'"]');if(!await button.isVisible())await page.locator('.training-session-menu summary').click();await button.click();}
async function stoppedClock(){await page.locator('[data-program-session="resume"]').waitFor();await page.waitForTimeout(300);const before=await page.locator('[data-training-clock]').textContent();await page.waitForTimeout(1600);assert.equal(await page.locator('[data-training-clock]').textContent(),before,'paused clock changed');return before;}
async function capture(name){await page.waitForTimeout(150);const geometry=await page.evaluate(()=>{const header=document.querySelector('.topbar'),clock=header.querySelector('.training-toolbar-clock'),controls=header.querySelector('.training-toolbar-controls');const probe=document.createElement('div');probe.style.cssText='position:absolute;height:var(--app-header-height);visibility:hidden;pointer-events:none';document.body.append(probe);const reserved=Math.ceil(probe.getBoundingClientRect().height);probe.remove();return {width:innerWidth,scroll:document.documentElement.scrollWidth,headerWidth:header.scrollWidth,headerHeight:Math.ceil(header.getBoundingClientRect().height),reserved,clockRight:clock?.getBoundingClientRect().right,actionsLeft:controls?.getBoundingClientRect().left};});report.geometry.push({name,...geometry});assert(geometry.scroll<=geometry.width+1,name+' page overflow');assert(geometry.headerWidth<=geometry.width+1,name+' header overflow');assert.equal(geometry.headerHeight,geometry.reserved,name+' header reserve');assert(geometry.clockRight<=geometry.actionsLeft+1,name+' clock overlaps actions');await page.screenshot({path:join(output,name+'.png'),fullPage:true});}
async function gradeOne(){await page.locator('#review-board [data-square="e2"]').click();await page.locator('#review-board [data-square="e4"]').click();await page.waitForTimeout(500);if(!await page.locator('#grade-panel [data-grade="2"]').isVisible()){await page.locator('#review-board [data-square="g1"]').click();await page.locator('#review-board [data-square="f3"]').click();}await page.locator('#grade-panel [data-grade="2"]').click();await page.waitForTimeout(300);}
async function launchCategory(activity,baseId){const row=page.locator('[data-category-row="'+activity+'"]');await row.waitFor();if(baseId)await row.locator('[data-category-source]').selectOption(String(baseId));await row.locator('[data-plan-action="launch-category"]').first().click();}
async function programRun(activity){return poll(async()=>{const data=await json('/api/training/state');return data.active_runs.find(run=>run.activity===activity);},'active '+activity+' run');}
try{
 await json('/api/setup-resources/complete','POST',{});
 await page.goto(url+'/#/reviews');await page.locator('#review-tab-bases').waitFor();await closeStartup();
 assert.equal(await page.locator('[data-training-session-bar]').count(),0,'preparation must keep normal navigation');
 const reviewBefore=await recordedTime('review');
 await page.locator('.review-bases-table [data-learn="'+fixture.bases[0]+'"]').click();await page.locator('#review-board .chess-board').waitFor();await normalHeader();assert(await page.locator('#session-pause').isVisible());
 await page.waitForTimeout(1200);await page.locator('#session-pause').click();await page.locator('[data-action="resume-stored-review"]').waitFor();await normalHeader();
 await page.reload();await closeStartup();await page.locator('[data-action="resume-stored-review"]').click();await page.locator('#review-board .chess-board').waitFor();await normalHeader();
 await page.evaluate(async()=>{(await import('/static/startup-settings.js')).saveStartupPreferences({page:'reviews',resume:'auto'});});await page.reload();await closeStartup();await page.locator('#review-board .chess-board').waitFor();await normalHeader();
 await page.waitForTimeout(1200);await gradeOne();await page.locator('#session-back').click();await page.locator('#review-tab-bases').waitFor();await normalHeader();
 await poll(async()=>(await recordedTime('review'))>reviewBefore,'ordinary review time credited');check('Ordinary review keeps the normal header and native controls through pause/reload, and records worked time');

 await go('training-plan');await launchCategory('review',fixture.bases[0]);await page.locator('#review-board .chess-board').waitFor();await toolbar();
 const review=await programRun('review'),native=review.native_ref.id;assert.match(page.url(),/training=1/);
 await action('pause');await stoppedClock();await page.reload();await closeStartup();await toolbar();await stoppedClock();assert.equal((await json('/api/training/runs/'+review.id)).native_ref.id,native);
 await action('resume');await page.locator('[data-program-session="pause"]').waitFor();
 await action('return');await page.locator('#tp-tab-today').waitFor();await go('reviews');await page.locator('#review-board .chess-board').waitFor();await normalHeader();assert(await page.locator('#session-pause').isVisible());
 assert.equal((await json('/api/training/runs/'+review.id)).native_ref.id,native);await page.locator('#session-back').click();await page.locator('#tp-tab-today').waitFor();
 await launchCategory('review',fixture.bases[0]);await page.locator('#review-board .chess-board').waitFor();await toolbar();assert.equal((await programRun('review')).id,review.id);check('The same retained programme review keeps the normal header when resumed through the ordinary menu');
 for(const width of [390,320]){await page.setViewportSize({width,height:900});for(const size of [16,24]){await page.evaluate(size=>document.documentElement.style.fontSize=size+'px',size);await capture('planned-review-'+width+'-'+(size===24?'150':'100'));}}
 await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));await page.setViewportSize({width:1440,height:1000});await gradeOne();await action('finish');await page.locator('#tp-tab-today').waitFor();assert.equal((await json('/api/training/runs/'+review.id)).state,'completed');check('Programme review: pause/reload preserves native session, finish once, desktop/320/390px and 150% text');

 await launchCategory('reading',fixture.bases[1]);await page.locator('.analysis-workbench .chess-board').waitFor();await toolbar();
 const reading=await programRun('reading');await page.mouse.move(250,240);await page.waitForTimeout(1300);await action('pause');await stoppedClock();
 assert(await page.locator('[data-reading-toolbar-pause]').isVisible());await page.reload();await closeStartup();await toolbar();await stoppedClock();await action('resume');await page.mouse.move(260,250);await page.waitForTimeout(1300);
 await action('confirm_reading');await poll(async()=>((await json('/api/training/runs/'+reading.id)).quantity||0)>0,'reading confirmation');
 await action('finish');await page.locator('#tp-tab-today').waitFor();assert.equal((await json('/api/training/runs/'+reading.id)).state,'completed');assert.equal(await page.locator('[data-training-session-bar]').count(),0);check('Programme reading: native time pauses on place and on reload, studied confirmation and explicit completion');

 await go('color');await page.locator('[data-color-setup] [type="submit"]').waitFor();await normalHeader();const colorBefore=await recordedTime('color');
 await page.locator('[data-color-setup] select').selectOption('30');await page.locator('[data-color-setup] [type="submit"]').click();await page.locator('[data-color="white"]:not([disabled])').click();await page.waitForTimeout(500);await normalHeader();assert(await page.locator('[data-color-clock]').isVisible());
 await page.locator('[data-color-again]').waitFor({timeout:35000});await normalHeader();assert((await recordedTime('color'))>colorBefore);check('Ordinary color exercise keeps its native countdown and credits time without a Training bar');
 await go('training-plan');await page.locator('[data-category-row="color"] [data-plan-action="launch-category"]').first().click();await page.locator('[data-color-setup] [type="submit"]').click();await page.locator('[data-color="white"]:not([disabled])').click();await toolbar();
 assert.equal(await page.locator('[data-program-session="pause"]').isVisible(),false,'timed challenge offered pause');assert.equal(await page.locator('[data-program-session="resume"]').isVisible(),false);
 assert(await page.locator('[data-color-clock]').isVisible());await page.setViewportSize({width:390,height:844});await capture('color-mobile');await action('return');await poll(async()=>await page.locator('[data-training-session-bar]').count()===0,'normal navigation restored');assert.equal(await page.locator('.topbar.training-toolbar-active').count(),0);
 await page.setViewportSize({width:1440,height:1000});await go('color');await page.locator('[data-color-setup] [type="submit"]').waitFor();await normalHeader();check('My Training color launch shows the bar; returning through the ordinary menu restores the normal header');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
