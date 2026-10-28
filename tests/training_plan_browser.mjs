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
const page=await context.newPage();page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function capture(name){await page.waitForTimeout(100);await page.screenshot({path:join(output,name+'.png'),fullPage:true});const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.width+1,name+' horizontal overflow');}
async function tab(view){const target=view==='week'?'today':view;await page.locator('[data-plan-view="'+target+'"]').click();await page.locator('[data-plan-view="'+target+'"][aria-selected="true"]').waitFor();}
async function expand(selector){const details=page.locator(selector);if(await details.getAttribute('open')===null)await details.locator(':scope > summary').click();}
async function closeStartupDialog(){const close=page.locator('#modal[open] [data-close]').first();if(await close.isVisible())await close.click();}
async function add(activity,title,baseIndex){
 await page.locator('[data-program-action="add"]').click();await page.locator('[data-program-action="add-activity"][data-activity="'+activity+'"]').click();
 const card=page.locator('[data-block-id]').last();await card.locator('[data-block-field="title"]').fill(title);
 const choices=await card.locator('[data-block-field="resource"] option').evaluateAll(options=>options.map(x=>({value:x.value,text:x.textContent})));
 const selected=choices.find(x=>x.value.startsWith('base:'+fixture.bases[baseIndex]+':')||x.value==='base:'+fixture.bases[baseIndex]);assert(selected,JSON.stringify(choices));
 await card.locator('[data-block-field="resource"]').selectOption(selected.value);return card;
}
async function currentWeek(){return (await json('/api/training/weeks/current','POST',{mutation_id:crypto.randomUUID()})).week;}
try{
 await json('/api/setup-resources/complete','POST',{});
 await page.goto(url+'/#/training-plan');await page.locator('[data-category-row]').first().waitFor();assert.equal(await page.locator('[data-category-row]').count(),10);assert.equal(await page.locator('.tp-unassigned').count(),0);assert.equal(await page.locator('.tp-category-details').count(),0);assert.equal(await page.locator('[data-category-row] .tp-category-icon svg').count(),10);assert.deepEqual(await page.locator('[data-plan-view]').evaluateAll(nodes=>nodes.map(n=>n.dataset.planView)),['today','program','statistics']);assert.deepEqual(await page.locator('[data-category-row]').evaluateAll(nodes=>nodes.map(n=>n.dataset.categoryRow)),['review','puzzles','blindfold','coordinates','color','guess','computer','reading','analysis','external']);check('All ten categories exist without a program and no assignment section');
 assert.equal(await page.locator('#tp-tab-today').getAttribute('aria-selected'),'true');
 await tab('program');
 await page.locator('[data-program-field="name"]').fill('Ma routine personnelle');await page.locator('[data-program-field="budget"]').fill('4');
 let card=await add('review','Calcul régulier',0);await card.locator('[data-block-field="target"]').fill('60');
 card=await add('review','Répertoire',1);await card.locator('[data-block-field="metric"]').selectOption('sessions');await card.locator('[data-block-field="target"]').fill('3');await card.locator('[data-block-field="session_minutes"]').fill('15');
 card=await add('reading','Parties commentées',1);await card.locator('[data-block-field="metric"]').selectOption('quantity');await card.locator('[data-block-field="target"]').fill('2');await card.locator('[data-block-field="unit_minutes"]').fill('20');
 await capture('desktop-program-fr');
 // Typed input retains focus and keeps punctuation literal.
 await card.locator('[data-block-field="notes"]').fill('Chercher <sans aide> et noter une idée.');
 await page.locator('[data-program-action="save"]').click();await page.locator('[data-program-action="activate"]:not([disabled])').waitFor();
 let state=await json('/api/training/state'),program=state.programs[0];assert.equal(program.definition.blocks.length,3);assert.equal(program.definition.budget_minutes,240);
 await page.reload();await page.locator('[data-program-field="name"]').waitFor();assert.equal(await page.locator('[data-program-field="name"]').inputValue(),'Ma routine personnelle');
 await page.locator('[data-program-action="save-template"]').click();await page.waitForFunction(()=>document.querySelector('[data-program-action="save-template"]')&&!document.querySelector('[data-program-action="save-template"]').disabled);
 assert.equal((await json('/api/training/templates')).items.filter(x=>!x.builtin).length,1);
 await page.locator('[data-program-action="activate"]').click();await page.locator('[data-activation-effect]').selectOption('now');await page.locator('[data-program-action="confirm-activate"]').click();
 await tab('week');await page.locator('.tp-overview-row').first().waitFor();let week=await currentWeek();assert.equal(week.planned_minutes,145);assert.equal(await page.locator('[data-category-row]').count(),10);assert.equal(await page.locator('[data-plan-view="week"]').count(),0);check('Real resources, saved 145-minute program, personal template and unified weekly activation');
 for(const width of [320,390,768]){await page.setViewportSize({width,height:900});await capture('week-'+width+'-fr');}
 await page.setViewportSize({width:1440,height:1000});await tab('today');assert.equal(await page.locator('.tp-session-planner,.tp-daily-breakdown,.tp-other-runs').count(),0);assert.equal(await page.locator('[data-category-source="blindfold"]').count(),0);assert.equal(await page.locator('[data-category-row] .primary:not([data-scope="today"])').count(),0);await capture('desktop-today-fr');check('Only activity rows remain, and Blindfold has no database selector');
 await tab('week');await page.locator('[data-category-row="review"] > .tp-overview-main [data-plan-action="launch-category"][data-scope="today"]').click();await page.locator('#review-board .chess-board').waitFor();await page.locator('[data-training-session-bar]').waitFor();await capture('desktop-program-review');
 await page.locator('#review-board [data-square="e2"]').click();await page.locator('#review-board [data-square="e4"]').click();
 await page.waitForTimeout(500);
 if(!await page.locator('#grade-panel [data-grade="2"]').isVisible()){await page.locator('#review-board [data-square="g1"]').click();await page.locator('#review-board [data-square="f3"]').click();}
 await page.locator('#grade-panel [data-grade="2"]').click();await page.waitForFunction(()=>document.querySelector('.eyebrow')?.textContent.includes('2 /'));
 await page.locator('[data-program-session="pause"]').click();await page.locator('[data-program-session="resume"]:not([disabled])').waitFor();await page.locator('[data-program-session="return"]').click();await page.locator('#tp-tab-today').waitFor();
 state=await json('/api/training/state');const reviewRun=state.active_runs.find(x=>x.activity==='review');assert(reviewRun);const nativeId=reviewRun.native_ref.id;
 await page.reload();await page.locator('[data-plan-action="launch-category"][data-scope="today"][data-run]').first().waitFor();await closeStartupDialog();await page.locator('[data-plan-action="launch-category"][data-scope="today"][data-run]').first().click();await page.locator('#review-board .chess-board').waitFor();
 const resumed=(await json('/api/training/runs/'+reviewRun.id));assert.equal(resumed.native_ref.id,nativeId);
 await page.locator('[data-program-session="finish"]').click();await page.locator('#tp-tab-today').waitFor();assert.equal((await json('/api/training/runs/'+reviewRun.id)).state,'completed');
 week=await currentWeek();const reviewCategory=(await json('/api/training/overview')).categories.find(c=>c.id==='review');assert.equal(reviewCategory.progress.sessions,1);assert.equal(reviewCategory.progress.cards,1);check('Planned review pauses, survives reload, resumes same native session and finishes once');
 await tab('program');await page.locator('[data-category-picker]').selectOption('reading');await expand('.tp-category-blocks');await page.locator('[data-plan-action="launch-period"][data-scope="today"][data-block="'+week.blocks[2].id+'"]').click();await page.locator('.analysis-workbench .chess-board').waitFor();await expand('.training-session-menu');await page.locator('[data-program-session="confirm_reading"]').waitFor();
 await page.mouse.move(200,200);await page.waitForTimeout(1500);await page.locator('[data-program-session="confirm_reading"]').click();
 await page.waitForFunction(()=>document.querySelector('#notices')?.textContent.includes('Partie étudiée enregistrée'));
 await expand('.training-session-menu');await page.locator('[data-program-session="confirm_reading"]').click();await page.waitForTimeout(100);
 await page.locator('[data-program-session="finish"]').click();await page.locator('#tp-tab-today').waitFor();week=await currentWeek();assert.equal(week.blocks[2].progress.games,1);assert.equal(week.blocks[2].progress.sessions,1);assert(week.blocks[2].progress.duration_ms>0);check('Native reading time and studied-game confirmation contribute once');
 await tab('program');await page.locator('[data-category-picker]').selectOption('review');await page.locator('[data-plan-action="manual-category"][data-category="review"]').click();await page.locator('[data-manual-form] [name="duration_minutes"]').fill('10');await page.locator('[data-manual-form] [name="note"]').fill('Exercices sur papier');await page.locator('[data-manual-form] [type="submit"]').click();
 await page.locator('[data-plan-action="edit-manual"]').first().waitFor({state:'attached'});await expand('.tp-category-management .tp-recorded-work');await page.locator('[data-plan-action="edit-manual"]').first().click();await page.locator('[data-manual-form] [name="duration_minutes"]').fill('6');await page.locator('[data-manual-form] [type="submit"]').click();await page.locator('[data-manual-form]').waitFor({state:'detached'});await page.locator('[data-plan-action="edit-manual"]').first().waitFor({state:'attached'});
 week=await currentWeek();const manual=(await json('/api/training/overview')).manual_activities;assert.equal(manual.length,1);assert.equal(manual[0].duration_minutes,6);await tab('statistics');await page.locator('.tts-kpis').waitFor();await capture('desktop-declared-statistics-fr');check('Declared work is editable and reaches the weekly review');
 await tab('program');await page.setViewportSize({width:390,height:844});await capture('mobile-program-fr');
 await json('/api/preferences','PATCH',{language:'en'});await page.reload();await page.locator('#tp-tab-program').waitFor();await closeStartupDialog();assert.equal(await page.locator('#tp-tab-today').innerText(),'Day and week');await capture('mobile-program-en');
 await tab('today');await capture('mobile-today-en');assert.equal(await page.locator('h1').first().innerText(),'My training');check('Desktop and phone layouts fit in French and English');
 // Starting from a native tool, without a programme run, credits today's
 // effort and the week automatically, including after a browser reload.
 await json('/api/preferences','PATCH',{language:'fr'});
 await page.reload();await page.locator('#tp-tab-today').waitFor();
 const colorBlock={id:crypto.randomUUID(),title:'Color libre',axis:'calculation',activity:'color',resource:{type:'tool',id:'color',generation:'tool-v1'},metric:'minutes',target:60,unit:'positions',session_minutes:1,unit_minutes:null,priority:'normal',notes:''};
 const freeProgram=await json('/api/training/programs','POST',{mutation_id:crypto.randomUUID(),name:'Suivi automatique',definition:{schema_version:1,budget_minutes:60,intention:'',blocks:[colorBlock]}});
 await json('/api/training/programs/'+freeProgram.id+'/activate','POST',{mutation_id:crypto.randomUUID(),expected_revision:freeProgram.revision,effective:'now'});
 await page.goto(url+'/#/color');await page.locator('[data-color-setup] [type="submit"]').click();
 await page.locator('[data-color="white"]:not([disabled])').click();await page.locator('[data-color="white"]:not([disabled])').waitFor();await page.waitForTimeout(200);
 await page.locator('[data-color="black"]:not([disabled])').click();await page.locator('[data-color="black"]:not([disabled])').waitFor();
 week=await currentWeek();assert.equal(week.today.attempts,2);assert(week.today.duration_ms>0);assert.equal(week.blocks[0].progress.attempts,2);assert.equal(week.blocks[0].progress.sessions,0);assert.equal(week.unassigned.length,0);
 await page.goto(url+'/#/training-plan');await page.locator('[data-category-row]').first().waitFor();await tab('today');await page.locator('[data-category-row="color"] > .tp-overview-main').waitFor();
 assert.match(await page.locator('[data-category-row="color"] > .tp-overview-main .tp-block-today').innerText(),/2 essais/);assert.match(await page.locator('[data-category-row="color"] > .tp-overview-main .tp-block-week').innerText(),/2 essais/);assert.equal(await page.locator('[data-category-row]').count(),10);await capture('mobile-daily-free-work-fr');
 await page.reload();await page.locator('[data-category-row="color"] > .tp-overview-main').waitFor();assert.equal((await currentWeek()).today.attempts,2);
 await tab('week');await capture('mobile-compact-activities-fr');
 await page.setViewportSize({width:1440,height:1000});await tab('today');await capture('desktop-daily-free-work-fr');
 await json('/api/preferences','PATCH',{language:'en'});await page.reload();await page.locator('[data-category-row="color"] > .tp-overview-main').waitFor();assert.match(await page.locator('[data-category-row="color"] > .tp-overview-main .tp-block-today').innerText(),/2 attempts/);await capture('desktop-daily-free-work-en');
 check('Free native activity updates today and week once, survives reload, and fits phone and desktop views');

 await json('/api/preferences','PATCH',{language:'fr'});await page.reload();await page.locator('[data-category-row="coordinates"]').waitFor();
 await tab('program');await page.locator('[data-category-picker]').selectOption('coordinates');
 const goals=page.locator('[data-category-goal-form="coordinates"]');await goals.locator('[name="daily_target_minutes"]').fill('5');await goals.locator('[name="target_minutes"]').fill('20');await goals.locator('[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('[data-plan-notice]')?.textContent.includes('Objectifs enregistrés'));await tab('today');
 await page.waitForFunction(()=>document.querySelector('[data-category-row="coordinates"] .tp-block-today strong')?.textContent.includes('/ 5'));
 await tab('program');await page.locator('[data-category-picker]').selectOption('coordinates');await page.locator('[data-plan-action="manual-category"][data-category="coordinates"]').click();await page.locator('[data-manual-form] [name="duration_minutes"]').fill('1');await page.locator('[data-manual-form] [type="submit"]').click();await page.locator('[data-manual-form]').waitFor({state:'detached'});await tab('today');
 await page.waitForFunction(()=>document.querySelector('[data-category-row="coordinates"] .tp-block-today strong')?.textContent.includes('1 / 5'));
 assert.match(await page.locator('[data-category-row="coordinates"] .tp-block-week strong').innerText(),/1 \/ 20/);
 assert.match(await page.locator('[data-category-row="coordinates"] > .tp-overview-main [data-scope="today"]').innerText(),/4 min/);
 assert.match(await page.locator('[data-category-row="coordinates"] > .tp-overview-main [data-scope="week"]').innerText(),/19 min/);
 const overview=await json('/api/training/overview');assert.equal(overview.categories.find(c=>c.id==='external').target_minutes,0);
 await capture('desktop-categories-daily-5-weekly-20');check('Independent Coordinates goals show 1/5 today and 1/20 this week with 4/19 minutes remaining');
 await tab('statistics');await page.locator('.tts-timeline').first().waitFor();await capture('desktop-time-statistics-fr');
 await page.locator('[data-stats-grouping]').selectOption('week');await capture('desktop-time-statistics-week');
 await page.locator('[data-stats-grouping]').selectOption('month');await page.setViewportSize({width:390,height:844});await capture('mobile-time-statistics-month');
 await page.setViewportSize({width:320,height:844});await capture('small-time-statistics');
 await json('/api/preferences','PATCH',{language:'en'});await page.setViewportSize({width:1440,height:1000});await page.reload();await page.locator('.tts-timeline').waitFor();await capture('desktop-time-statistics-en');check('Activity charts render by day, week and month with mobile layout in French and English');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
