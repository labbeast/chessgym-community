import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--disable-extensions']});
const page=await context.newPage(),errors=[],checks=[],geometry=[];
page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
async function api(path,method='GET',data){const r=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(r.ok(),path+': '+await r.text());return r.json();}
async function go(id){const mobile=await page.locator('.mobile-navigation').isVisible();const nav=page.locator(mobile?'.mobile-navigation':'.top-nav');const target=nav.locator('[data-page="'+id+'"]');if(!await target.isVisible()){if(mobile)await nav.locator('summary').click();else await nav.locator('.navigation-group:has([data-page="'+id+'"])>summary').click();}await target.click();await page.waitForURL('**/#/'+id+'*');}
async function capture(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});const value=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,headers:document.querySelectorAll('.topbar').length}));assert(value.scroll<=value.width+1,name+' horizontal overflow');assert.equal(value.headers,1);geometry.push({name,...value});}
try{
 await api('/api/setup-resources/complete','POST',{});
 await page.goto(url);await page.locator('.topbar').waitFor();
 for(const id of ['reading','reviews','repertoire','played','coordinates','blindfold','guess','puzzles']){await go(id);await page.locator('#main .loading').waitFor({state:'detached'});assert(!await page.locator('[data-retry-training]').count(),id+' failed to mount');}
 checks.push('All grouped destinations mount');
 await page.goBack();await page.waitForURL('**/#/guess');await page.goForward();await page.waitForURL('**/#/puzzles');checks.push('Browser back and forward stay in the application');
 await page.locator('.top-actions [data-page="settings"]').click();await page.locator('[data-settings-tab="sounds"]').click();
 await page.locator('#sound-preferences [name="enabled"]').uncheck();await page.locator('#sound-preferences [name="navigation"]').check();
 await page.locator('#sound-preferences [name="volume"]').fill('27');await page.locator('#sound-preferences [type="submit"]').click();
 await page.locator('[data-sound-result]').filter({hasText:'enregistrés'}).waitFor();assert.deepEqual((await api('/api/preferences')).sound,{enabled:false,volume:.27,moves:true,feedback:true,navigation:true});
 await page.reload();await page.locator('#sound-preferences [name="enabled"]').waitFor();assert.equal(await page.locator('#sound-preferences [name="enabled"]').isChecked(),false);assert.equal(await page.locator('#sound-preferences [name="volume"]').inputValue(),'27');checks.push('Sound preferences persist across reload');
 await capture('desktop-sound-settings');
 await page.setViewportSize({width:390,height:844});
 await go('coordinates');await page.locator('#main .loading').waitFor({state:'detached'});await capture('mobile-training-navigation');
 await page.locator('.mobile-navigation>summary').click();await capture('mobile-training-menu');await page.keyboard.press('Escape');assert.equal(await page.locator('.mobile-navigation').getAttribute('open'),null);
 for(const id of ['library','reviews','board']){await go(id);await capture('mobile-'+id);}
 await api('/api/preferences','PATCH',{language:'en'});await page.goto(url+'/#/coordinates');await page.reload();await page.locator('.topbar').waitFor();await page.locator('.mobile-navigation>summary').click();assert.match(await page.locator('.mobile-navigation').textContent(),/Training/);assert.match(await page.locator('.mobile-navigation').textContent(),/Guess the move/);checks.push('Mobile menu, English labels, one header and no horizontal overflow');
 assert.equal((await api('/api/entries/'+fixture.source_id)).headers.Event,'Entraînement du bilan');assert.deepEqual(errors,[]);checks.push('No browser exception');
 console.log(JSON.stringify({checks,geometry},null,2));
}finally{await writeFile(join(output,'navigation-report.json'),JSON.stringify({checks,geometry,errors},null,2));await context.close();}
