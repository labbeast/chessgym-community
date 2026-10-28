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
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();}
function check(value){report.checks.push(value);console.log('PASS '+value);}
async function navigate(name){const button=page.locator('.top-nav [data-page="'+name+'"]').first();if(await button.count())await button.evaluate(el=>el.click());else await page.evaluate(name=>location.hash='#/'+name,name);await page.waitForFunction(name=>location.hash==='#/'+name,name);}
async function count(selector,expected){await page.waitForFunction(({selector,expected})=>[...document.querySelectorAll(selector)].filter(node=>!node.hidden).length===expected,{selector,expected});}
async function capture(name){await page.screenshot({path:join(output,name+'.png'),fullPage:false});const size=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));report.geometry.push({name,...size});assert(size.scrollWidth<=size.width+1,name+' horizontal overflow');}
async function advanced(){const details=page.locator('[data-game-search]').first();if(!await details.evaluate(el=>el.open))await details.locator('summary').click();}
try{
 await json('/api/setup-resources/complete','POST',{});
 await page.goto(url+'/#/base?base='+fixture.base);await page.locator('[data-et-row]').first().waitFor();
 await page.locator('[data-list-size]').selectOption('25');await count('[data-et-row]',25);
 await page.locator('[data-et-control="search"]').fill('Montreal');await count('[data-et-row]',25);
 await page.locator('[data-et-action="page-next"]').click();await page.waitForFunction(()=>document.querySelector('.list-range')?.textContent.startsWith('26'));
 const firstId=await page.locator('[data-et-row]').first().getAttribute('data-et-row');
 await page.locator('[data-et-action="open"]').first().click();await page.locator('.analysis-page').waitFor();await page.goBack();await page.locator('[data-et-row]').first().waitFor();
 assert.equal(await page.locator('[data-et-control="search"]').inputValue(),'Montreal');assert.equal(await page.locator('[data-list-size]').inputValue(),'25');assert.equal(await page.locator('[data-et-row]').first().getAttribute('data-et-row'),firstId);
 await page.locator('[data-list-clear="query"]').click();await page.waitForFunction(()=>document.querySelector('.list-range')?.textContent.startsWith('1–25'));
 await advanced();await page.locator('[data-game-filter="eco"]').fill('B12');await page.locator('[data-list-dirty]:visible').waitFor();await page.locator('[data-et-action="advanced-apply"]').click();await page.locator('[data-list-clear="eco"]').waitFor();
 await page.locator('[data-game-search] summary').click();await page.locator('[data-list-clear="eco"]').click();assert.equal(await page.locator('[data-game-filter="eco"]').inputValue(),'');
 await capture('desktop-study');check('Study filters, page size and current page survive opening a game and browser back; chips remain usable with advanced search closed');

 await navigate('library');await page.locator('[data-collection-search]').waitFor();
 const created=[];for(let index=0;index<29;index++)created.push(await json('/api/bases','POST',{name:'Écossaise collection '+String(index).padStart(2,'0'),settings:{reading_enabled:true,is_repertoire:true,color:index%2?'black':'white'}}));
 await navigate('reading');await page.locator('[data-collection-search]').fill('ecossaise');await count('.reading-card',25);await capture('desktop-reading');
 await page.locator('[data-collection-size]').selectOption('50');await count('.reading-card',29);await page.locator('[data-collection-action="next"]').isDisabled().then(value=>assert(value));
 await navigate('repertoire');await page.locator('[data-collection-filter="color"]').selectOption('black');await count('.repertoire-card',14);const details=page.locator('[data-list-advanced]');await details.locator('summary').click();await page.locator('[data-collection-filter="primary"]').selectOption('primary');await page.locator('[data-list-dirty]:visible').waitFor();await count('.repertoire-card',14);await page.locator('[data-list-apply]').click();await count('.repertoire-card',0);await page.locator('[data-list-clear="primary"]').click();await count('.repertoire-card',14);
 await navigate('library');await page.locator('[data-collection-search]').fill('ecossaise');await count('.base-card-item',25);await page.locator('[data-collection-action="next"]').click();await count('.base-card-item',4);await capture('desktop-library');await navigate('reading');await navigate('library');assert.equal(await page.locator('[data-collection-search]').inputValue(),'ecossaise');await count('.base-card-item',4);
 await page.locator('[data-collection-action="reset"]').click();await page.locator('[data-collection-size]').selectOption('100');await count('.base-card-item',31);
 await page.locator('[data-base="'+fixture.reference_base+'"]').first().click();await page.locator('[data-reference-game]').first().waitFor();await page.locator('[name="search"]').fill('elodie');await page.locator('[data-list-clear="search"]').waitFor();await page.locator('[data-list-size]').selectOption('25');await count('[data-reference-game]',25);await capture('desktop-reference');check('Collections share live accent-insensitive search, deferred advanced filters, sorting, pagination and independent navigation memory');

 await navigate('guess');await page.locator('[data-game-picker]').waitFor();await page.locator('[data-base]').selectOption(String(fixture.reference_base));await page.locator('[data-entry]').first().waitFor();await advanced();await page.locator('[data-game-filter="last_name"]').fill('labbe');await page.locator('[data-game-filter="first_name"]').fill('elodie');await page.locator('[data-game-filter="eco"]').fill('C45');await page.locator('[data-game-search] button[type="submit"]').click();await count('[data-entry]',1);await capture('desktop-game-picker');check('Exercise game selection uses the shared advanced name/ECO filters against reference games');

 await navigate('training-history');await page.locator('[data-history-sort]').waitFor();await page.locator('[data-history-sort]').selectOption('duration');await page.locator('[data-list-advanced] summary').click();await page.locator('[data-training-filter="date_from"]').fill('2099-01-01');await page.locator('[data-list-dirty]:visible').waitFor();await page.locator('[data-training-apply]').click();await page.locator('[data-list-clear="date_from"]').waitFor();await page.locator('[data-list-clear="date_from"]').click();await page.locator('.training-history-table').waitFor();await capture('desktop-history');check('History supports server sorting, explicit advanced dates and removable applied criteria');

 await page.setViewportSize({width:390,height:844});await capture('mobile-history');await navigate('library');await capture('mobile-library');await page.locator('[data-collection-search]').fill('référence');await count('.base-card-item',1);await page.locator('[data-base="'+fixture.reference_base+'"]').first().click();await page.locator('[data-reference-game]').first().waitFor();await advanced();await capture('mobile-reference');await navigate('guess');await page.locator('[data-game-picker]').waitFor();await advanced();await capture('mobile-game-picker');
 await page.setViewportSize({width:850,height:1000});await navigate('reading');await capture('tablet-reading');check('Desktop, tablet and mobile lists fit without horizontal page overflow');
 assert.deepEqual(report.errors,[]);
}catch(error){report.failure=String(error.stack||error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
