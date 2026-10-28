import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const languages=['fr','en','es','de','pt','it','ru','zh-CN','ja','ko','ar','hi'];
const panelsOnly=process.env.CHESSGYM_TEST_LANGUAGE_PANELS_ONLY==='1';
const report={checks:[],errors:[],requests:[]};
let closing=false;
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:1050},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
// Windows Chrome may spend about 20 seconds reopening its audio device after reload.
const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',async route=>{
 const request=route.request(),target=new URL(request.url());if(target.origin!==url)return route.abort();
 if(request.method()!=='GET'){
  report.requests.push({method:request.method(),path:target.pathname});
  if(target.pathname.startsWith('/api/app-updates'))throw new Error('Language verification must never change or install application updates.');
 }
 // Retry a reset local keep-alive connection only for read-only requests.
 try{await route.fulfill({response:await context.request.fetch(request,{maxRetries:request.method()==='GET'?2:0})});}
 catch(error){if(!closing&&request.failure()?.errorText!=='net::ERR_ABORTED')throw error;}
});
async function json(path,body,method='GET'){
 const response=await context.request.fetch(url+path,{method,data:body});
 assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();
}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function capture(name){await page.waitForFunction(()=>document.querySelectorAll('#notices .notice').length===0);await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(output,name+'.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' horizontal overflow');}
async function settings(){await page.goto(url+'/#/settings');await page.locator('[data-settings-tab="general"]').click();await page.locator('#interface-language').waitFor();}
async function select(code){
 const stored=await json('/api/preferences');
 const saved=stored.language===code?Promise.resolve():page.waitForResponse(response=>response.url().endsWith('/api/preferences')&&response.request().method()==='PATCH');
 await page.locator('#interface-language').selectOption(code);await saved;
 await page.waitForFunction(code=>document.documentElement.lang===code,code);
 assert.equal((await json('/api/preferences')).language,code);
 assert.equal(await page.locator('html').getAttribute('dir'),code==='ar'?'rtl':'ltr');
}
async function installation(code){
 const dictionary=(await import('../static/locales/'+code+'.js')).default;
 await page.setViewportSize({width:1440,height:1050});
 await settings();await select(code);await page.locator('[data-settings-tab="installation"]').click();
 await page.locator('#app-updates-settings [data-app-update-status] p').first().waitFor();
 for(const selector of ['details.app-update-automation','details.setup-resource-automation']){
  const disclosure=page.locator(selector);if(!await disclosure.evaluate(node=>node.open))await disclosure.locator(':scope > summary').click();
 }
 await page.locator('#setup-resources-settings [data-setup-settings] [name="automatic_updates"]').waitFor();
 assert.equal(await page.locator('#app-updates-settings [data-app-update-check]').count(),1);
 assert.equal(await page.locator('#app-updates-settings [data-app-update-install]').count(),1);
 assert.equal(await page.locator('#app-updates-settings [data-app-update-restart]').isVisible(),false);
 assert.equal(await page.locator('#app-updates-settings [name="automatic_updates"]').isChecked(),false);
 const updateState=await json('/api/app-updates');
 const version=page.locator('#app-updates-settings [data-app-update-status] bdi').first();
 assert.equal(await version.getAttribute('dir'),'ltr');assert.equal(await version.textContent(),updateState.current_version||'—');
 assert.equal(await page.locator('#setup-resources-settings [name="automatic_updates"]').isChecked(),false);
 assert.notEqual((await page.locator('.app-updates-panel h2').textContent()).trim(),'Mise à jour de ChessGym');
 assert.equal(await page.locator('.setup-examples h3').textContent(),dictionary['Essayer ChessGym en quelques minutes']);
 // Long newly translated licensing/import text and Windows path examples must
 // render in the selected language, including on narrow and RTL layouts.
 await page.locator('[data-setup-disclosure="manual"] > summary').click();
 await page.locator('[data-setup-disclosure="edition-lumbra-otb-elite"] > summary').click();
 const edition=page.locator('[data-setup-disclosure="edition-lumbra-otb-elite"]');
 assert((await edition.textContent()).includes(dictionary['Par Michael Jansen. Usage non commercial avec attribution; une licence distincte est nécessaire pour un usage commercial.']));
 const pathKey=Object.keys(dictionary).find(key=>key.startsWith('Ex. C:'));
 assert.equal(await edition.locator('[data-lumbra-path]').getAttribute('placeholder'),dictionary[pathKey]);
 assert.equal(await page.locator('html').getAttribute('dir'),code==='ar'?'rtl':'ltr');
 await capture(code+'-installation-desktop');
 await page.setViewportSize({width:390,height:844});
 const checkboxLayout=await page.locator('#app-updates-settings label.checkbox').evaluate(label=>{
  const input=label.querySelector('input').getBoundingClientRect(),text=[...label.childNodes].find(node=>node.nodeType===3&&node.textContent.trim());
  const range=document.createRange();range.selectNodeContents(text);const first=range.getClientRects()[0];
  return {inputTop:input.top,textTop:first.top};
 });
 assert(Math.abs(checkboxLayout.inputTop-checkboxLayout.textTop)<8,code+' checkbox must align with its label');
 await capture(code+'-installation-mobile');
}
async function squares(){
 await page.waitForFunction(()=>document.querySelectorAll('#board-host [data-square]').length===64);
 return page.locator('#board-host .chess-board').evaluate(board=>Object.fromEntries(['a8','h8','a1'].map(name=>{
  const rect=board.querySelector('[data-square="'+name+'"]').getBoundingClientRect();
  return [name,{x:rect.x,y:rect.y,width:rect.width,height:rect.height}];
 })));
}
try{
 await json('/api/setup-resources/complete',{},'POST');
 const base=await json('/api/bases',{name:'Révisions'},'POST');
 const entry=await json('/api/entries',{base_id:base.id,title:'Bibliothèque',pgn:'[Event "Révisions"]\n[White "Bien"]\n[Black "Révisions"]\n[Result "*"]\n\n{تعليق شخصي et note française} 1. e4 {Bien} *'},'POST');
 const original=await json('/api/entries/'+entry.id);
 for(const code of languages.filter(code=>!['fr','en'].includes(code)))await installation(code);
 check('All ten secondary languages show translated onboarding, resource licenses, import paths and automation controls on desktop/mobile without overflow or update requests');
 if(!panelsOnly){
 await page.setViewportSize({width:1440,height:1050});
 await settings();
 assert.deepEqual(await page.locator('#interface-language option').evaluateAll(nodes=>nodes.map(node=>node.value)),languages);
 for(const code of languages){
  await select(code);
  const unchanged=await json('/api/entries/'+entry.id);
  assert.equal(unchanged.pgn,original.pgn);assert.equal(unchanged.title,original.title);assert.deepEqual(unchanged.headers,original.headers);
 }
 check('All twelve language choices save through the real local endpoint and preserve PGN, player names and annotations');
 await select('ar');await page.reload();await page.locator('#interface-language').waitFor();
 assert.equal(await page.locator('#interface-language').inputValue(),'ar');assert.equal(await page.locator('html').getAttribute('dir'),'rtl');
 await capture('arabic-settings-desktop');
 await page.goto(url+'/#/board');await page.locator('#board-host .chess-board').waitFor();
 const {a8,h8,a1}=await squares();
 assert(a8.x<h8.x,'Arabic must not mirror board files');assert(a8.y<a1.y,'White orientation must not reverse ranks');
 await page.locator('#board-host [data-b="flip"]').click();
 const {a8:flippedA8,h8:flippedH8,a1:flippedA1}=await squares();
 assert(flippedA8.x>flippedH8.x);assert(flippedA8.y>flippedA1.y);
 await page.locator('#board-host [data-b="flip"]').click();
 await capture('arabic-board-desktop');
 await page.setViewportSize({width:390,height:844});await capture('arabic-board-mobile');
 check('Arabic direction persists across reload; board orientation and flip remain correct on desktop/mobile');
 await settings();await select('zh-CN');await capture('chinese-settings-mobile');
 await page.reload();await page.locator('#interface-language').waitFor();assert.equal(await page.locator('#interface-language').inputValue(),'zh-CN');
 check('Chinese language persists after reload on a phone-sized screen');
 }
 assert(!report.requests.some(item=>item.path.startsWith('/api/app-updates')));
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{closing=true;await context.unrouteAll({behavior:'ignoreErrors'});await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
