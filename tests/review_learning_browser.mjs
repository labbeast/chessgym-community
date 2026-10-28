import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const report={checks:[],errors:[],geometry:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:960},args:['--no-first-run','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();}
const check=label=>{report.checks.push(label);console.log('PASS '+label);};
async function capture(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.width+1,name+' horizontal overflow');}
async function basesTab(){await page.locator('#review-tab-bases').click();await page.locator('[data-learn]:visible').first().waitFor();}
async function launch(base,selection){await page.locator('[data-'+selection+'="'+base+'"]:visible').click();await page.locator('#review-board .chess-board').waitFor();assert.equal(await page.locator('#modal[open]').count(),0);}
async function saved(){await page.waitForTimeout(1000);const workspace=await json('/api/workspace');return workspace.items.find(item=>item.key==='review')?.data;}
async function returnToReviews(){
 const finish=page.locator('[data-program-session="finish"]');
 if(!await finish.isVisible())await page.locator('[data-training-session-bar] summary').click();
 await finish.click();await page.goto(url+'/#/reviews');await page.locator('#review-tab-bases').waitFor();
}
try{
 await json('/api/setup-resources/complete','POST',{});
 for(const id of fixture.bases)await json('/api/bases/'+id,'PATCH',{settings:{new_limit:0}});
 await page.goto(url+'/#/reviews');await page.locator('#review-tab-bases[aria-selected="true"]').waitFor();assert.equal(await page.locator('#review-tab-daily, #review-tab-settings, [data-daily-form]').count(),0);
 assert.equal(await page.locator('[name="new_limit"]').count(),0);await basesTab();
 const first=fixture.bases[0];
 assert.match(await page.locator('[data-review="'+first+'"]:visible').innerText(),/Réviser · 1/);
 assert.match(await page.locator('[data-learn="'+first+'"]:visible').innerText(),/Apprendre · 2/);
 await capture('review-learn-desktop-fr');await page.setViewportSize({width:390,height:844});await capture('review-learn-mobile-fr');
 await launch(first,'learn');let snapshot=await saved();assert.equal(snapshot.selection,'learn');assert.equal(snapshot.cards.length,2);assert(snapshot.cards.every(card=>card.state==='unseen'));
 await page.locator('#review-board [data-square="e2"]').click();await page.locator('#review-board [data-square="e4"]').click();await page.locator('#grade-panel [data-grade="2"]').click();
 await page.waitForFunction(()=>document.querySelector('.eyebrow')?.textContent.includes('2 /'));
 snapshot=await saved();assert.equal(snapshot.completed,1);const identity=snapshot.session_id;
 await page.locator('[data-program-session="pause"]').click();await saved();await page.reload();
 await page.waitForFunction(()=>document.querySelector('#review-board')||document.querySelector('[data-action="resume-stored-review"]'));
 if(await page.locator('[data-action="resume-stored-review"]').isVisible())await page.locator('[data-action="resume-stored-review"]').click();
 await page.locator('#review-board .chess-board').waitFor();
 if(await page.locator('[data-program-session="resume"]').isVisible())await page.locator('[data-program-session="resume"]').click();
 snapshot=await saved();assert.equal(snapshot.selection,'learn');assert.equal(snapshot.session_id,identity);assert.equal(snapshot.completed,1);await capture('learn-resumed-mobile-fr');
 check('Learn ignores a legacy zero quota, excludes due cards and resumes without repeating an answer');
 await returnToReviews();await basesTab();await launch(first,'review');snapshot=await saved();assert.equal(snapshot.selection,'review');assert.equal(snapshot.cards.length,1);assert(snapshot.cards.every(card=>card.state!=='unseen'));
 check('Review selects only the due card, leaving future and unseen cards out');
 await returnToReviews();
 assert.match(await page.locator('[data-review-all="review"]').innerText(),/Tout réviser · 3/);
 await page.locator('#review-panel-bases [data-list-search-menu]>summary').click();await page.locator('[data-collection-search]').fill('Tactique');await page.locator('[data-collection-search]').press('Enter');
 await page.locator('[data-review-all="review"]').click();await page.locator('#review-board .chess-board').waitFor();snapshot=await saved();
 assert.equal(snapshot.selection,'review');assert.equal(snapshot.total,3);assert.deepEqual(snapshot.goal,{minutes:null,cards:null});assert.deepEqual([...snapshot.base_ids].sort(),[...fixture.bases].sort());assert(snapshot.cards.every(card=>card.state!=='unseen'));
 check('Review all includes due reviews and maintenance from every base despite list filtering, without a preparation dialog or session limit');
 await returnToReviews();await page.locator('[data-review-all="learn"]').click();await page.locator('#review-board .chess-board').waitFor();snapshot=await saved();
 assert.equal(snapshot.selection,'learn');assert.equal(snapshot.total,2);assert.deepEqual(snapshot.goal,{minutes:null,cards:null});assert(snapshot.cards.every(card=>card.state==='unseen'));
 check('Learn all includes only new cards across every enabled base, with session goals reserved for the training plan');
 await returnToReviews();await json('/api/preferences','PATCH',{language:'en'});await page.reload();await basesTab();
 assert.match(await page.locator('[data-learn="'+first+'"]:visible').innerText(),/Learn/);await capture('review-learn-mobile-en');
 await page.locator('[data-base="'+first+'"]:visible').first().click();await page.locator('[data-tab="settings"]').click();await page.locator('#base-settings').waitFor();assert.equal(await page.locator('#base-settings [name="new_limit"]').count(),0);
 check('French and English layouts fit mobile and database settings contain no daily quota');
 await page.goto(url+'/#/training-plan');await page.locator('[data-plan-action="create-program"]').click();
 await page.locator('[data-program-field="name"]').fill('Review and Learn');
 await page.locator('[data-program-action="add"]').click();await page.locator('[data-program-action="add-activity"][data-activity="review"]').click();
 const block=page.locator('[data-block-id]').first();
 const resource=await block.locator('[data-block-field="resource"] option').evaluateAll((options)=>options.map(option=>option.value).find(value=>value.startsWith('base:1:')));
 assert(resource);await block.locator('[data-block-field="resource"]').selectOption(resource);
 await block.locator('[data-training-option="selection"]').selectOption('learn');await page.locator('[data-program-action="save"]').click();await page.locator('[data-program-action="activate"]:not([disabled])').waitFor();
 assert.equal((await json('/api/training/state')).programs.find(item=>item.name==='Review and Learn').definition.blocks[0].options.selection,'learn');
 await page.reload();await page.locator('[data-program-action="toggle"]').first().click();
 assert.equal(await page.locator('[data-training-option="selection"]:visible').inputValue(),'learn');await capture('training-plan-learning-mobile-en');
 await page.locator('[data-training-option="selection"]:visible').selectOption('both');await page.locator('[data-program-action="save"]').click();await page.locator('[data-program-action="activate"]:not([disabled])').waitFor();
 await page.locator('[data-program-action="activate"]').click();await page.locator('[data-activation-effect]').selectOption('now');await page.locator('[data-program-action="confirm-activate"]').click();
 await page.locator('[data-plan-view="week"]').click();await page.locator('[data-plan-action="launch-block"]').first().click();await page.locator('#review-board .chess-board').waitFor();
 snapshot=await saved();assert.equal(snapshot.selection,'both');assert(snapshot.training_run_id);assert.equal(snapshot.cards[0].state==='unseen',false);assert.equal(snapshot.cards[1].state,'unseen');
 check('A training block saves Learn, restores the choice after reload and launches Review + Learn in the correct order');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
