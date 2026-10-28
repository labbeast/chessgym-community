import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const report={checks:[],errors:[],requests:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:1050},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
// Windows Chrome may spend about 20 seconds reopening its audio device after reload.
const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',error=>report.errors.push(String(error)));
// Forward genuine HTTP through Playwright's transport; this also works on hosts
// where browser child processes cannot connect directly to the loopback server.
await context.route('**/*',async route=>{
 const request=route.request(),target=new URL(request.url());
 if(target.origin!==url)return route.abort();
 if(request.method()!=='GET')report.requests.push({method:request.method(),path:target.pathname});
 const response=await context.request.fetch(request);
 await route.fulfill({response});
});
async function json(path){const response=await context.request.get(url+path);assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function capture(name){await page.locator('#app-updates-settings [data-app-update-status] p').first().waitFor();await page.waitForFunction(()=>document.querySelectorAll('#notices .notice').length===0);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(output,name+'.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' overflow');}
const disclosure=id=>page.locator('[data-setup-disclosure="'+id+'"]');
const isOpen=target=>target.evaluate(node=>node.open);
async function settingsTab(id){await page.locator('[data-settings-tab="'+id+'"]').click();}
try{
 await page.goto(url+'/#/board');
 assert.equal(await page.locator('#auth-form,input[type="password"]').count(),0);
 await page.locator('[data-settings-tab="installation"][aria-selected="true"]').waitFor();
 assert.equal(await page.locator('[data-settings-tab="account"]').count(),0);
 await page.locator('[data-setup-install-button]:enabled').waitFor();
 assert.equal(new URL(page.url()).hash,'#/settings');
 let status=await json('/api/status');assert.equal(status.authenticated,true);assert.equal(status.setup_required,false);assert.equal(status.resources_setup_required,true);assert.equal(status.capabilities.setup_resources,true);
 assert.deepEqual(await page.locator('input[name="resource"]:checked').evaluateAll(nodes=>nodes.map(node=>node.value)),['stockfish-latest']);
 assert.equal(await page.locator('[data-setup-settings] [name="automatic_updates"]').isChecked(),false);
 assert.match(await page.locator('[data-setup-selection-count]').innerText(),/\b1\b/);
 assert.equal(await isOpen(disclosure('databases')),false);assert.equal(await isOpen(disclosure('manual')),false);
 assert.equal(await isOpen(page.locator('details.setup-resource-automation')),false);
 assert.equal(await page.locator('[data-setup-onboarding]').isVisible(),true);
 await page.locator('#app-updates-settings [data-app-update-status] p').first().waitFor();
 assert.equal(await page.locator('[data-app-update-install]').isVisible(),false);
 check('A fresh local profile opens Installation directly from an existing board URL, without login or password');
 await capture('owner-onboarding-desktop');

 await disclosure('databases').locator(':scope > summary').click();
 await page.locator('input[value="lichess-puzzles"]').check();
 assert.match(await page.locator('[data-setup-selection-count]').innerText(),/\b2\b/);
 await settingsTab('general');await settingsTab('installation');
 assert.equal(await isOpen(disclosure('databases')),true);
 assert.equal(await page.locator('input[value="lichess-puzzles"]').isChecked(),true);
 assert.match(await page.locator('[data-setup-selection-count]').innerText(),/\b2\b/);
 await page.locator('input[value="lichess-puzzles"]').uncheck();
 assert.match(await page.locator('[data-setup-selection-count]').innerText(),/\b1\b/);
 await disclosure('databases').locator(':scope > summary').click();
 assert.equal(await page.locator('input[value="lichess-puzzles"]').isVisible(),false);
 check('Optional database disclosure and selected count remain consistent across Settings tabs');

 await disclosure('manual').locator(':scope > summary').click();
 await disclosure('edition-lumbra-otb-elite').locator(':scope > summary').click();
 const draftPath='C:\\Downloads\\My chess databases\\elite.7z';
 await page.locator('[data-lumbra-path="lumbra-otb-elite"]').fill(draftPath);
 await page.locator('[data-lumbra-masters="lumbra-otb-elite"]').check();
 await settingsTab('general');await settingsTab('installation');
 assert.equal(await isOpen(disclosure('manual')),true);assert.equal(await isOpen(disclosure('edition-lumbra-otb-elite')),true);
 assert.equal(await page.locator('[data-lumbra-path="lumbra-otb-elite"]').inputValue(),draftPath);
 assert.equal(await page.locator('[data-lumbra-masters="lumbra-otb-elite"]').isChecked(),true);
 assert.match(await page.locator('[data-setup-selection-count]').innerText(),/\b1\b/);
 await capture('manual-import-expanded-desktop');
 await disclosure('manual').locator(':scope > summary').click();
 check('Manual imports keep their open edition and unfinished path without entering the download selection');

 await page.setViewportSize({width:390,height:844});await capture('owner-onboarding-mobile');
 const completion=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/setup-resources/complete'&&response.request().method()==='POST');
 await page.locator('[data-setup-complete]').click();assert((await completion).ok());
 await page.waitForURL('**/#/library');
 assert.equal(await page.locator('#main h1').first().textContent(),'Bibliothèque');
 status=await json('/api/status');assert.equal(status.resources_setup_required,false);
 let resources=await json('/api/setup-resources');assert.equal(resources.setup_complete,true);assert.equal(resources.job,null);
 check('Skipping setup opens the library and persists completion through the real local endpoint');
 await page.reload();await page.locator('#main h1').filter({hasText:'Bibliothèque'}).waitFor();
 await page.goto(url);await page.locator('#main h1').filter({hasText:'Bibliothèque'}).waitFor();assert.equal(new URL(page.url()).hash,'#/library');
 assert.equal(await page.locator('[data-setup-install-button]').count(),0);
 check('Reloading and a fresh root visit keep the library without reopening onboarding');
 await page.goto(url+'/#/settings');await page.locator('[data-settings-tab="installation"]').click();await page.locator('[data-setup-install-button]:enabled').waitFor();
 assert.equal(await page.locator('input[value="lichess-puzzles"]').isChecked(),false);assert.equal(await page.locator('input[value="lichess-games"]').isChecked(),false);
 assert.equal(await page.locator('[data-setup-onboarding]').isVisible(),false);
 assert.equal(await isOpen(disclosure('databases')),false);assert.equal(await isOpen(disclosure('manual')),false);
 await capture('installation-return-mobile');
 check('Installation remains available later and Lichess databases remain opt-in');

 const demoBefore=await json('/api/demo');assert.equal(demoBefore.installed,false);assert.equal(demoBefore.bases.length,0);
 const demoInstalled=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/demo'&&response.request().method()==='POST');
 await page.locator('[data-setup-examples-add]').click();assert((await demoInstalled).ok());
 await page.locator('[data-setup-example="reading"]').waitFor();
 const demoAfter=await json('/api/demo');assert.equal(demoAfter.installed,true);assert.equal(demoAfter.bases.length,3);
 assert.equal(await page.locator('[data-setup-examples-add]').count(),0);
 await capture('starter-examples-ready-mobile');
 for(const activity of ['reading','repertoire','guess']){
  await page.locator('[data-setup-example="'+activity+'"]').click();await page.waitForURL('**/#/'+activity);
  await page.goto(url+'/#/settings');await settingsTab('installation');await page.locator('[data-setup-example="reading"]').waitFor();
  assert.deepEqual((await json('/api/demo')).bases,demoAfter.bases);
 }
 check('One click installs three local examples and every activity opens without downloads or duplicates');

 await settingsTab('general');
 const languageSaved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/preferences'&&response.request().method()==='PATCH');
 await page.locator('#interface-language').selectOption('en');await languageSaved;
 await page.waitForFunction(()=>document.documentElement.lang==='en');
 await settingsTab('installation');await page.locator('[data-setup-install-button]:enabled').waitFor();
 assert.equal(await page.locator('.setup-resources-panel h2').innerText(),'Engines and databases');
 assert.equal(await page.locator('[data-setup-onboarding]').isVisible(),false);
 assert.equal(await page.locator('[data-setup-install-button]').innerText(),'Download and configure');
 await capture('installation-english-mobile');
 await page.setViewportSize({width:1440,height:1050});await capture('installation-english-desktop');
 check('Completed setup stays compact and translated on desktop and mobile');
 const readingExample=demoAfter.examples.find(item=>item.key==='reading');
 const disabled=await context.request.patch(url+'/api/bases/'+readingExample.base_id,{data:{settings:{reading_enabled:false}}});assert(disabled.ok());
 await page.reload();await page.locator('[data-setup-example="library"]').waitFor();
 assert.equal(await page.locator('[data-setup-example="reading"]').count(),0);
 await page.locator('[data-setup-example="library"]').click();await page.waitForURL('**/#/library');
 assert.equal((await json('/api/demo')).examples.find(item=>item.key==='reading').mode_enabled,false);
 check('A manually disabled example stays disabled and opens its library instead');
 assert(!report.requests.some(item=>['/api/setup-resources/install','/api/setup-resources/update','/api/setup-resources/import'].includes(item.path)));
 assert(!report.requests.some(item=>['/api/setup','/api/login','/api/logout'].includes(item.path)),'Local onboarding must not call account endpoints');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
