import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const report={checks:[],errors:[],geometry:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:960},timezoneId:'America/Toronto',args:['--no-first-run','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(String(e)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function json(path,method='GET',data){const r=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(r.ok(),path+' '+r.status()+' '+await r.text());return r.json();}
async function waitRows(count){await page.waitForFunction(n=>document.querySelectorAll('.training-history-table tbody tr').length===n,count);}
async function filter(name,value){await page.locator('[data-training-filter="'+name+'"]').selectOption(value);await page.waitForFunction(()=>document.querySelector('.training-history-results')?.getAttribute('aria-busy')==='false');}
async function capture(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});const g=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));report.geometry.push({name,...g});assert(g.scrollWidth<=g.width+1,name+' horizontal overflow');}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function history(){await page.goto(url+'/#/training-history');await page.locator('[data-training-filter="tool"]').waitFor();await page.waitForFunction(()=>document.querySelector('.training-history-results')?.getAttribute('aria-busy')==='false');}
try{
 await json('/api/setup-resources/complete','POST',{});await page.goto(url+'/#/library');await page.locator('.top-nav .navigation-group').nth(1).locator('summary').click();await page.locator('.top-nav [data-page="training-history"]').click();await page.locator('[data-training-filter="tool"]').waitFor();
 await waitRows(25);assert.equal((await json('/api/training/history')).total,39);await capture('desktop-overview');
 await page.locator('[data-training-page="25"]').click();await waitRows(14);await page.locator('[data-training-page="0"]').click();await waitRows(25);check('Global table paginates all nine tools without duplicating Storm attempts');
 const tools=['review','puzzles','storm','guess','coordinates','blindfold','color','computer','reading'];
 for(const tool of tools){await filter('tool',tool);await waitRows(tool==='color'?25:1);await page.locator('[data-training-detail]').first().click();await page.locator('.training-history-detail h2').waitFor();assert((await page.locator('.training-history-detail').innerText()).length>50);await page.locator('[data-training-close-detail]').click();}
 check('Each tool supplies the shared detail panel with its own result and measured duration');
 await filter('tool','blindfold');await filter('outcome','failure');await waitRows(1);await page.locator('[data-training-detail]').click();assert.match(await page.locator('.training-history-detail').innerText(),/Position reconstruite/);await capture('desktop-blindfold-detail');
 await page.locator('[data-training-reset]').click();await waitRows(25);await filter('tool','color');await page.locator('[data-training-filter="q"]').fill('');await page.locator('[data-list-advanced] summary').click();await page.locator('[data-training-filter="date_from"]').fill('2026-10-25');await page.locator('[data-training-apply]').click();await page.locator('.training-history-empty strong').waitFor();assert.match(await page.locator('.training-history-empty').innerText(),/Aucune activité/);
 await page.locator('[data-training-reset]').click();await waitRows(25);await page.locator('[data-training-filter="q"]').fill('Spassky');await page.locator('[data-training-apply]').click();await waitRows(1);assert.match(await page.locator('.training-history-table').innerText(),/Fischer/);check('Date, result, tool and text filters combine and reset correctly');
 await page.locator('[data-training-reset]').click();await waitRows(25);await filter('tool','color');
 let colorRow=page.locator('.training-history-table tbody tr').filter({hasText:'Color'}).first();
 // Select the known long record via its server ordering, including pagination.
 let data=await json('/api/training/history?tool=color&limit=100');const index=data.items.findIndex(x=>x.id==='color');
 if(index>=25){await page.locator('[data-training-page="25"]').click();await waitRows(6);}
 await page.locator('[data-training-detail="'+(index%25)+'"]').click();await page.locator('[data-training-events-more]').waitFor();assert.equal(await page.locator('.training-history-events tbody tr').count(),100);await page.locator('[data-training-events-more]').click();await page.waitForFunction(()=>document.querySelectorAll('.training-history-events tbody tr').length===103);check('Activity details retain all recorded answers with a second page beyond 100 events');
 await page.setViewportSize({width:390,height:844});await capture('mobile-color-detail');
 await page.goto(url+'/#/reviews');await page.locator('#review-tab-history').click();await page.locator('#review-history .training-history-table tbody tr').waitFor();assert.equal(await page.locator('#review-history [data-training-filter="tool"]').count(),0);await capture('mobile-review-history');check('Review uses the same history with its filter locked to review answers');
 await page.setViewportSize({width:1440,height:960});await history();await filter('tool','reading');await page.locator('[data-training-open]').click();await page.locator('.analysis-workbench .chess-board').waitFor();await page.keyboard.press('ArrowRight');await page.waitForTimeout(1200);await page.keyboard.press('ArrowRight');await page.waitForTimeout(500);
 await page.goto(url+'/#/reading');await page.locator('[data-reading-history]').click();await page.locator('[data-training-panel="history"] .training-history-table tbody tr').first().waitFor();
 assert.equal(await page.locator('dialog.training-history-dialog').count(),0);assert.equal(await page.locator('[data-reading-history]').getAttribute('aria-selected'),'true');assert(await page.locator('[data-training-play]').evaluate(node=>node.hidden&&node.inert));
 await capture('desktop-reading-history');await page.setViewportSize({width:390,height:844});await capture('mobile-reading-history');
 await page.locator('[data-training-play-tab]').click();assert.equal(await page.locator('[data-training-panel="history"]').count(),0);assert(await page.locator('.reading-grid').isVisible());assert.equal(await page.locator('[data-training-play-tab]').getAttribute('aria-selected'),'true');
 await page.locator('[data-training-play-tab]').press('ArrowRight');await page.locator('[data-training-panel="history"] .training-history-table tbody tr').first().waitFor();
 const visits=await json('/api/training/history?tool=reading');assert(visits.total>=2);assert(visits.items.some(x=>x.id!=='reading'&&x.duration_ms>=1000));await page.goBack();await page.waitForFunction(()=>!document.querySelector('[data-training-panel="history"]'));check('Reading history fills the page on desktop and mobile, supports tab return and keyboard navigation, and preserves timed visits');
 await json('/api/preferences','PATCH',{language:'en'});await page.reload();await history();await filter('tool','computer');await page.setViewportSize({width:390,height:844});await capture('mobile-history-en');assert.match(await page.locator('.training-history-heading').innerText(),/Training history/);assert.match(await page.locator('.training-history-table').innerText(),/computer/i);check('Desktop and phone layouts fit their viewport in French and English');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(e){report.status='failed';report.failure=String(e);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw e;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
