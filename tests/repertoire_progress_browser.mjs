import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;assert.equal(new URL(url).hostname,'127.0.0.1');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8')),report={status:'running',checks:[],errors:[],geometry:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:960},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',async route=>{const parsed=new URL(route.request().url());if(parsed.origin!==url)return route.abort();if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test.'}});return route.continue();});
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),method+' '+path+' '+response.status()+' '+await response.text());return response.json();}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function tool(name){const desktop=page.locator('.analysis-tool-tabs [data-analysis-tool="'+name+'"]');if(await desktop.isVisible())await desktop.click();else await page.locator('.analysis-mobile-tabs [data-mobile-panel="'+name+'"]').click();}
async function move(path){await page.locator('#move-list [data-path="'+path+'"]').click();await page.waitForFunction(path=>document.querySelector('#move-list .current')?.dataset.path===path,path);}
async function waitFor(fn){const end=Date.now()+10000;do{if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw new Error('Expected persisted state was not reached');}
async function capture(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});const geometry=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth}));report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.width+1,name+' overflow');}
try{
 await json('/api/setup-resources/complete','POST',{});
 const study=(await json('/api/bases','POST',{name:'Transposition source'})).id,repertoire=(await json('/api/bases','POST',{name:'Ordres alternatifs',settings:{is_repertoire:true,color:'white'}})).id;
 await json('/api/bases/'+study+'/import','POST',{pgn:'[Event "Source Nf3"]\n\n1. Nf3 d5 2. d4 Nf6 *'});
 await json('/api/bases/'+repertoire+'/import','POST',{pgn:'[Event "Ordre d4"]\n\n1. d4 d5 2. Nf3 Nf6 {Une note de répertoire.} 3. c4 e6 *'});
 const source=(await json('/api/bases/'+study+'/entries')).entries[0].id,target=(await json('/api/bases/'+repertoire+'/entries')).entries[0].id;
 const initial=(await json('/api/entries/'+source)).pgn;
 await check('Transposition: full move order, exact source branch, retained annotation',async()=>{
  await page.goto(url+'/#/board?entry='+source);await page.locator('#move-list').waitFor();await move('0.0.0.0');
  if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]');if(await toggle.isVisible())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}
  await page.locator('#annotation-form textarea').fill('Brouillon conservé pendant la transposition.');
  await tool('repertoire');await page.locator('[data-repertoire-action="transposition-toggle"]').click();await page.locator('[data-repertoire-action="transposition-base"]').selectOption(String(repertoire));await page.locator('[data-repertoire-action="transposition-search"]').click();
  await page.locator('.transposition-matches li').waitFor();assert.match(await page.locator('.transposition-line').textContent(),/1. d4/);assert.match(await page.locator('.transposition-comment').textContent(),/Une note de répertoire/);await capture('transpositions-desktop');
  await page.locator('[data-repertoire-action="transposition-open"]').click();await page.waitForURL('**entry='+target);await page.waitForFunction(()=>document.querySelector('#move-list .current')?.dataset.path==='0.0.0.0');
  assert.equal((await json('/api/entries/'+source)).pgn,initial);
  await page.goto(url+'/#/board?entry='+source);await page.locator('#move-list').waitFor();await move('0.0.0.0');if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]');if(await toggle.isVisible())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}assert.equal(await page.locator('#annotation-form textarea').inputValue(),'Brouillon conservé pendant la transposition.');
 });
 await check('Transpositions: mobile and English display',async()=>{
  await json('/api/preferences','PATCH',{language:'en'});await page.setViewportSize({width:390,height:844});await page.reload();await page.locator('.analysis-mobile-tabs [data-mobile-panel="moves"]').click();await move('0.0.0.0');await tool('repertoire');await page.locator('[data-repertoire-action="transposition-toggle"]').click();await page.locator('[data-repertoire-action="transposition-base"]').selectOption(String(repertoire));await page.locator('[data-repertoire-action="transposition-search"]').click();await page.locator('.transposition-matches li').waitFor();assert.match(await page.locator('.repertoire-transpositions').textContent(),/Different move order/);await page.waitForFunction(()=>!document.querySelector('#notices')?.children.length);await page.locator('[data-repertoire-action="transposition-open"]').scrollIntoViewIfNeeded();await capture('transpositions-mobile-en');await page.locator('[data-repertoire-action="transposition-open"]').click();await page.waitForURL('**entry='+target);await page.waitForFunction(()=>document.querySelector('#move-list .current')?.dataset.path==='0.0.0.0');
 });
 await check('Game report: reviewed moment and hint persist through reload',async()=>{
  await json('/api/preferences','PATCH',{language:'fr'});await page.setViewportSize({width:1440,height:960});await page.goto(url+'/#/board?entry='+fixture.source_id);await page.locator('#move-list').waitFor();await tool('bilan');await page.locator('.report-impact-targets [data-ply="5"]').click();await page.locator('.report-moment').waitFor();await page.locator('[data-work-action="moment-hint"]').click();await page.locator('[data-work-action="moment-reviewed"]').click();
  const read=()=>json('/api/game-analysis/'+fixture.source_id+'/progress?fingerprint='+fixture.fingerprint);await waitFor(async()=>{const item=(await read()).items.find(item=>item.ply===5);return item?.state.outcome==='reviewed'&&item?.state.hint;});await page.reload();await page.locator('#move-list').waitFor();await tool('bilan');await page.locator('.report-impact-targets [data-ply="5"]').click();await page.locator('.report-moment').waitFor();await page.locator('[data-work-action="moment-reset-progress"]').waitFor();assert.match(await page.locator('.report-result').textContent(),/Moment revu/);await capture('report-progress-desktop');
  await page.setViewportSize({width:390,height:844});await tool('bilan');await page.locator('[data-work-action="moment-reset-progress"]').scrollIntoViewIfNeeded();await capture('report-progress-mobile');assert.match(await page.locator('.report-result').textContent(),/Moment revu/);assert(await page.locator('[data-work-action="moment-reset-progress"]').isVisible());
  await page.locator('[data-work-action="moment-reset-progress"]').click();await waitFor(async()=>{const item=(await read()).items.find(item=>item.ply===5);return item&&item.state.outcome===null&&!item.state.hint;});
 });
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error.stack||error);await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await writeFile(join(output,'completion-browser-report.json'),JSON.stringify(report,null,2));await context.close();}
