import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');await mkdir(output,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),report={checks:[],errors:[]};
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
page.on('pageerror',error=>report.errors.push(String(error)));
async function api(path,method='GET',data){const r=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(r.ok(),path+' '+r.status()+' '+await r.text());return r.json();}
async function totals(){const overview=await api('/api/training/overview');return Object.fromEntries(overview.categories.map(c=>[c.id,c.today.duration_ms||0]));}
async function navigate(pageName){const nav=page.locator('.top-nav'),target=nav.locator('[data-page="'+pageName+'"]');if(!await target.isVisible())await nav.locator('.navigation-group:has([data-page="'+pageName+'"])>summary').click();await target.click();await page.waitForURL('**/#/'+pageName+'*');}
async function closeStartup(){const close=page.locator('#modal[open] [data-close]').first();if(await close.isVisible())await close.click();}
async function normalHeader(){assert.equal(await page.locator('[data-training-session-bar]').count(),0);assert.equal(await page.locator('.topbar.training-toolbar-active').count(),0);assert(await page.locator('.top-nav').isVisible());}
async function trainingAnalysis(){await navigate('training-plan');await page.locator('[data-category-row="analysis"] [data-plan-action="launch-category"]').click();await page.locator('[data-training-title]').filter({hasText:/Analyse|Analysis/}).waitFor();}
try{
 await api('/api/setup-resources/complete','POST',{});
 const normal=await api('/api/bases','POST',{name:'Analysis test',settings:{reading_enabled:false}});
 const reading=await api('/api/bases','POST',{name:'Reading test',settings:{reading_enabled:true}});
 const game=await api('/api/entries','POST',{base_id:normal.id,pgn:'[Event "Analysis"]\n\n1. e4 e5 2. Nf3 *'});
 const chapter=await api('/api/entries','POST',{base_id:reading.id,pgn:'[Event "Reading"]\n\n1. d4 d5 2. c4 *'});
 await page.goto(url+'/#/board?entry='+game.id);await page.locator('.analysis-workbench .chess-board').waitFor();await closeStartup();await normalHeader();
 const ordinaryBefore=await totals();await page.waitForTimeout(1500);await navigate('library');assert((await totals()).analysis>=ordinaryBefore.analysis+1000);await normalHeader();report.checks.push('Ordinary saved analysis keeps the normal header and still records active time');
 await trainingAnalysis();assert.match(page.url(),/training=1/);
 await page.waitForTimeout(1500);await page.locator('[data-program-session="pause"]').click();await page.locator('[data-program-session="resume"]').waitFor();
 const paused=(await totals()).analysis;assert(paused>=1000);await page.waitForTimeout(1200);assert.equal((await totals()).analysis,paused);
 await page.reload();await page.locator('[data-program-session="resume"]').waitFor();await closeStartup();await page.waitForTimeout(1200);assert.equal((await totals()).analysis,paused);
 await page.locator('[data-program-session="resume"]').click();await page.waitForTimeout(1200);await page.locator('[data-program-session="finish"]').click();await page.waitForURL('**/#/training-plan');
 assert((await totals()).analysis>=paused+1000);report.checks.push('My Training analysis shows its bar; pause survives reload and navigation flushes once');
 await page.goto(url+'/#/board?entry='+chapter.id);await page.locator('#reading-strip:not([hidden])').waitFor();await closeStartup();
 await normalHeader();const before=await totals();await page.waitForTimeout(2200);await navigate('library');await page.waitForURL('**/#/library');
 const after=await totals();assert.equal(after.analysis,before.analysis);assert(after.reading>=before.reading+1000);report.checks.push('Reading-enabled board records only reading');
 await page.goto(url+'/#/board?entry='+chapter.id);await page.locator('#reading-strip:not([hidden])').waitFor();await normalHeader();await trainingAnalysis();
 const explicit=await totals();await page.waitForTimeout(1200);await page.locator('[data-program-session="finish"]').click();await page.waitForURL('**/#/training-plan');
 const final=await totals();assert(final.analysis>=explicit.analysis+1000);assert.equal(final.reading,explicit.reading);report.checks.push('My Training Analyse launch on reading-enabled game records only analysis');
 assert.deepEqual(report.errors,[]);report.status='passed';console.log(JSON.stringify(report));
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
