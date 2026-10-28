import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only isolated loopback fixtures may be tested');
const report={status:'running',checks:[],errors:[],externalRequests:[],sourceMutations:[],fonts:[],geometry:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
await context.addInitScript(()=>localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'never'})));
const page=await context.newPage();page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
let failSave=false;
await context.route('**/*',async route=>{
 const request=route.request(),parsed=new URL(request.url());if(parsed.origin!==url)return route.abort();
 if(failSave&&request.method()==='PATCH'&&parsed.pathname==='/api/preferences'&&request.postDataJSON()?.font_scale){failSave=false;return route.fulfill({status:503,json:{detail:'Simulated font setting save failure'}});}
 if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
 if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
 if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Engine disabled in isolated fixture.'}});
 return route.continue();
});
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.status()===204?null:response.json();}
async function check(name,action){await action();report.checks.push(name);console.log('PASS '+name);}
async function frame(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function settings(){await page.locator('.top-actions [data-page="settings"]').click();await page.locator('[data-settings-tab="appearance"]').click();await page.locator('#interface-font-scale').waitFor();}
async function setScale(scale){const select=page.locator('#interface-font-scale');if(await select.inputValue()!==String(scale)){await select.selectOption(String(scale));await page.waitForFunction(scale=>!document.querySelector('#interface-font-scale').disabled&&getComputedStyle(document.documentElement).getPropertyValue('--ui-font-scale').trim()===String(scale/100),scale);}await frame();assert.equal((await json('/api/preferences')).font_scale,scale);}
async function fonts(name,selectors){const values=await page.evaluate(selectors=>Object.fromEntries(Object.entries(selectors).map(([name,selector])=>{const node=document.querySelector(selector);if(!node)throw Error('Missing font probe '+selector);return [name,parseFloat(getComputedStyle(node).fontSize)];})),selectors);report.fonts.push({name,...values});return values;}
function scaled(actual,baseline,scale){for(const [key,value] of Object.entries(baseline))assert(Math.abs(actual[key]-value*scale)<.04,`${key}: expected ${value*scale}px, got ${actual[key]}px`);}
async function geometry(name){const value=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,topbarHeight:document.querySelector('.topbar').getBoundingClientRect().height}));report.geometry.push({name,...value});assert(value.scrollWidth<=value.width+1,name+' must not overflow the page horizontally');}
async function boardMenu(){const host=page.locator('details[data-board-menu]:visible').first();if(await host.getAttribute('open')===null)await host.locator(':scope > summary').click();await host.locator('[data-board-menu-content]').waitFor({state:'visible'});return host;}
async function menuFont(){const host=await boardMenu();const value=await host.locator('[data-board-command="new"]').evaluate(node=>parseFloat(getComputedStyle(node).fontSize));await page.keyboard.press('Escape');return value;}
async function openGame(base,id){await page.locator('.brand[data-page="library"]:visible').click();await page.locator('[data-base="'+base+'"]').click();await page.locator('[data-et-action="open"][data-et-id="'+id+'"]').first().click();await page.locator('#board-host .chess-board').waitFor();await page.locator('#move-list .analysis-move-comment').first().waitFor();}
async function screenshot(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});}

try{
 await json('/api/setup-resources/complete','POST',{});
 await json('/api/preferences','PATCH',{language:'en'});
 const base=await json('/api/bases','POST',{name:'Text size regression source',settings:{}});
 const game=await json('/api/entries','POST',{base_id:base.id,title:'Readable annotations',pgn:'[Event "Text size regression"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n1. e4 {A long annotation remains readable when the whole interface is enlarged.} e5 2. Nf3 Nc6 *'});
 const original=await json('/api/entries/'+game.id);
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();await settings();
 const selectors={root:'html',body:'body',title:'h1',heading:'.text-size-settings h2',label:'.text-size-settings label',select:'#interface-font-scale',small:'.text-size-preview small',preview:'.text-size-preview p',hint:'#interface-font-scale-hint',tab:'[data-settings-tab="appearance"] span',header:'.top-actions [data-page="settings"]'};
 let desktopBaseline;
 await check('Every text category and menu scales proportionally at 100, 110, 125 and 150 percent',async()=>{
  await setScale(100);desktopBaseline=await fonts('desktop-100',selectors);const baselineMenu=await menuFont();await screenshot('settings-desktop-100');
  for(const scale of [110,125,150]){await setScale(scale);scaled(await fonts('desktop-'+scale,selectors),desktopBaseline,scale/100);assert(Math.abs(await menuFont()-baselineMenu*scale/100)<.04);await geometry('settings-desktop-'+scale);}
  await screenshot('settings-desktop-150');
 });
 await check('Saved size survives board and piece themes, navigation and a full reload',async()=>{
  await page.locator('[data-appearance-piece="merida"]').click();await page.waitForFunction(()=>document.documentElement.dataset.pieceSet==='merida');
  await page.locator('[data-appearance-board="blue"]').click();await page.waitForFunction(()=>document.documentElement.dataset.boardTheme==='blue');
  await page.locator('[data-theme-choice="sage"]').click();await page.waitForFunction(()=>document.body.dataset.theme==='sage');
  assert.equal((await json('/api/preferences')).font_scale,150);scaled(await fonts('after-theme-changes',selectors),desktopBaseline,1.5);
  await page.locator('.brand[data-page="library"]:visible').click();await page.locator('[data-base="'+base.id+'"]').waitFor();assert.equal(await page.locator('body').evaluate(node=>parseFloat(getComputedStyle(node).fontSize)),desktopBaseline.body*1.5);
  await page.reload();await page.locator('[data-base="'+base.id+'"]').waitFor();await settings();assert.equal(await page.locator('#interface-font-scale').inputValue(),'150');scaled(await fonts('after-reload',selectors),desktopBaseline,1.5);
 });
 await check('Failed save retains the saved selection and displayed text size',async()=>{
  failSave=true;await page.locator('#interface-font-scale').selectOption('110');await page.locator('[data-text-size-status].error').waitFor();
  assert.equal(await page.locator('#interface-font-scale').inputValue(),'150');assert.equal((await json('/api/preferences')).font_scale,150);scaled(await fonts('after-failed-save',selectors),desktopBaseline,1.5);
 });
 await check('Navigation, settings and small text fit desktop and mobile screens at 100 and 150 percent',async()=>{
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:width===1440?900:844});await setScale(100);const baseline=await fonts('width-'+width+'-100',selectors);await geometry('settings-'+width+'-100');
   await setScale(150);scaled(await fonts('width-'+width+'-150',selectors),baseline,1.5);await geometry('settings-'+width+'-150');
   const host=await boardMenu();const panel=host.locator('[data-board-menu-content]');const box=await panel.boundingBox();assert(box.x>=-1&&box.x+box.width<=width+1,'Board menu fits '+width+'px viewport');await geometry('menu-'+width+'-150');await page.keyboard.press('Escape');
   if(width===390)await screenshot('settings-mobile-150');
  }
 });
 await check('Notation, coordinates and dynamic annotation font controls scale exactly once',async()=>{
  await page.setViewportSize({width:1440,height:900});await setScale(100);await openGame(base.id,game.id);
  const boardSelectors={move:'#move-list .analysis-move-san',comment:'#move-list .analysis-move-comment',coordinate:'#board-host .square .file'};
  const baseline=await fonts('board-100',boardSelectors);assert.equal(baseline.comment,13);
  await settings();await setScale(150);await openGame(base.id,game.id);scaled(await fonts('board-150',boardSelectors),baseline,1.5);await geometry('board-desktop-150');
  const controls=page.locator('.analysis-reading-controls:visible');await controls.locator(':scope > summary').click();await controls.locator('[data-reading-action="font-more"]').click();
  assert.equal(await page.locator('#move-list .analysis-move-comment').first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize)),21,'Local 14px annotation setting is multiplied once by 150%');
  await page.keyboard.press('Escape');await screenshot('board-desktop-150');
  await page.setViewportSize({width:390,height:844});await frame();await geometry('board-mobile-150');await screenshot('board-mobile-150');
 });
 await check('Source game unchanged and no application errors',async()=>{
  const current=await json('/api/entries/'+game.id);for(const key of ['pgn','title','revision'])assert.deepEqual(current[key],original[key]);
  assert.deepEqual(report.sourceMutations,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await screenshot('failure').catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify(report,null,2));}
