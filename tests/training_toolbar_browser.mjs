import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import {dirname,resolve,join,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..'),require=createRequire(import.meta.url);
const {chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const output=process.env.CHESSGYM_TEST_OUTPUT||join(repo,'.tmp','training-toolbar-browser');
await mkdir(output,{recursive:true});
const index=await readFile(join(repo,'static','index.html'),'utf8');
const links=(index.match(/<link[^>]+rel="stylesheet"[^>]*>/g)||[]).join('');
const fixture='<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">'+links+'</head><body data-theme="copper"><header class="topbar"><button class="brand" data-page="library" aria-label="Chess Gym, bibliothèque"><picture><source media="(max-width:850px), (max-width:1000px) and (max-height:500px)" srcset="/static/icons/chessgym-32.png?v=1"><img src="/static/logo.png" alt="Chess Gym"></picture></button><nav class="top-nav"><button id="normal-menu">Bibliothèque</button></nav><div class="top-actions"><button id="normal-settings">Réglages</button></div></header><div class="shell"><main id="fixture-main">Exercice de révision <button id="session-pause">Pause native</button><button id="session-settings">Réglages</button><span data-training-session-slot></span></main></div><script type="module">import {TrainingSessionBar} from "/static/training-session-bar.js";window.originalBrand=document.querySelector(".brand");window.originalPicture=originalBrand.querySelector("picture");window.originalLogo=originalBrand.querySelector("img");window.originalBrandMarkup=originalBrand.outerHTML;window.value={id:"test",activity:"review",title:"Défense sicilienne · entraînement des ouvertures",program:true,active:true,completed:8,total:20,targetMs:1200000,remainingMs:754000,elapsedMs:446000,clockType:"countdown",clockLabel:"Séance",canPause:true,canFinish:true};window.actions=[];window.toolbar=new TrainingSessionBar(document.querySelector("header"),{observeHost:document.querySelector("main"),getContext:()=>window.value,onAction:async action=>{actions.push(action);if(window.rejectAction)throw Error("Enregistrement à réessayer");if(action==="pause")value.paused=true;if(action==="resume")value.paused=false;if(action==="finish"||action==="return")window.value=null;}});</script></body></html>';
const url='http://chessgym.test';
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900}});
const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
await context.route('**/*',async route=>{const requested=new URL(route.request().url());if(requested.origin!==url)return route.abort();if(requested.pathname==='/')return route.fulfill({contentType:'text/html',body:fixture});try{const path=resolve(repo,'.'+requested.pathname);assert(path.startsWith(join(repo,'static')+sep));await route.fulfill({contentType:({'.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'})[extname(path)]||'application/octet-stream',body:await readFile(path)});}catch{await route.fulfill({status:404,body:''});}});
async function unchangedBrand(){
 assert.equal(await page.locator('header .brand').count(),1);assert.equal(await page.locator('header img').count(),1);assert(await page.locator('header .brand img').isVisible());
 assert(await page.evaluate(()=>document.querySelector('.brand')===originalBrand&&originalBrand.querySelector('picture')===originalPicture&&originalBrand.querySelector('img')===originalLogo&&originalBrand.outerHTML===originalBrandMarkup));
}
async function headerGeometry(){
 return page.evaluate(()=>{
  const header=document.querySelector('header'),bar=document.querySelector('[data-training-session-bar]'),brand=document.querySelector('.brand'),logo=brand.querySelector('img');
  const chrome=()=>{const style=getComputedStyle(header),brandStyle=getComputedStyle(brand),imageStyle=getComputedStyle(logo),rect=header.getBoundingClientRect(),image=logo.getBoundingClientRect();return {height:rect.height,background:style.backgroundColor,border:style.borderBottom,padding:style.padding,gap:style.gap,brand:{width:image.width,height:image.height,filter:imageStyle.filter,padding:brandStyle.padding,background:brandStyle.backgroundColor}};};
  const actual=chrome();header.classList.remove('training-toolbar-active');bar.hidden=true;const normal=chrome();bar.hidden=false;header.classList.add('training-toolbar-active');
  const clock=document.querySelector('.training-toolbar-clock').getBoundingClientRect(),controls=document.querySelector('.training-toolbar-controls').getBoundingClientRect(),home=document.querySelector('.training-toolbar-home').getBoundingClientRect(),brandRect=brand.getBoundingClientRect(),pause=document.querySelector('.training-toolbar-pause');
  const probe=document.createElement('div');probe.style.cssText='position:absolute;visibility:hidden;pointer-events:none;height:var(--app-header-height)';document.body.append(probe);const reservedHeight=probe.getBoundingClientRect().height;probe.remove();
  return {actual,normal,viewport:innerWidth,scroll:document.documentElement.scrollWidth,headerScroll:header.scrollWidth,height:Math.ceil(header.getBoundingClientRect().height),variable:Math.ceil(reservedHeight),clockRight:clock.right,controlsLeft:controls.left,homeRight:home.right,clockLeft:clock.left,brandRight:brandRect.right,homeLeft:home.left,clockFont:parseFloat(getComputedStyle(document.querySelector('[data-training-clock]')).fontSize),pauseOverflow:pause.scrollWidth>pause.clientWidth,inlineHeight:document.documentElement.style.getPropertyValue('--app-header-height')};
 });
}
try{
 await page.goto(url);await page.locator('[data-training-clock]').waitFor();
 assert.equal(await page.locator('#normal-menu').isVisible(),false);assert.equal(await page.locator('#session-pause').isVisible(),false);assert(await page.locator('#session-settings').isVisible());assert.equal(await page.locator('[data-training-session-slot]').isVisible(),false);
 assert.equal(await page.locator('[data-training-clock]').textContent(),'12:34');
 await unchangedBrand();assert.match(await page.locator('[data-training-quantity]').textContent(),/8 \/ 20 (cartes|cards)/);assert.equal(await page.locator('.training-toolbar-home').textContent(),'Training');
 assert.equal(await page.locator('[data-program-session="pause"]').textContent(),'Pause');assert.equal(await page.locator('[data-program-session="pause"] span[aria-hidden]').count(),0);
 await page.screenshot({path:join(output,'compact-desktop.png'),fullPage:true});
 await page.locator('.training-session-menu summary').click();
 await page.evaluate(()=>{window.clockNode=document.querySelector('[data-training-clock]');window.summaryNode=document.querySelector('summary');window.summaryNode.focus();value.remainingMs-=1500;toolbar.render();});
 assert(await page.evaluate(()=>document.activeElement===window.summaryNode&&document.querySelector('[data-training-clock]')===window.clockNode&&document.querySelector('details').open));
 await page.keyboard.press('Escape');assert.equal(await page.locator('details').evaluate(el=>el.open),false);
 await page.evaluate(()=>{window.originalOnAction=toolbar.onAction;toolbar.onAction=async(...args)=>{await new Promise(resolve=>window.releaseBusyAction=resolve);return originalOnAction(...args);};});
 await page.locator('[data-program-session="pause"]').click();assert.equal(await page.locator('header .brand').isEnabled(),false);assert.equal(await page.locator('[data-program-session="pause"]').isEnabled(),false);
 await page.evaluate(()=>releaseBusyAction());await page.locator('[data-program-session="resume"]').waitFor();await page.locator('header .brand:enabled').waitFor();await unchangedBrand();await page.evaluate(()=>toolbar.onAction=originalOnAction);
 await page.locator('[data-program-session="resume"]').click();assert.equal(await page.locator('[data-program-session="pause"]').count(),1);
 await page.evaluate(()=>window.rejectAction=true);await page.locator('[data-program-session="pause"]').click();await page.locator('.training-toolbar-error').waitFor();assert.match(await page.locator('.training-toolbar-error').textContent(),/réessayer/);assert.deepEqual((await headerGeometry()).actual,(await headerGeometry()).normal,'Errors must not resize or restyle the header');await page.evaluate(()=>{window.rejectAction=false;toolbar.error='';toolbar.render();});
 for(const width of [1440,850,650,390,320]){
  await page.setViewportSize({width,height:900});
  for(const scale of [16,24]){
   await page.evaluate(scale=>document.documentElement.style.fontSize=scale+'px',scale);await page.waitForTimeout(100);
   const geometry=await headerGeometry();await unchangedBrand();
   assert.deepEqual(geometry.actual,geometry.normal,'Original header and logo styles changed: '+JSON.stringify({width,scale,geometry}));
   assert.equal(geometry.height,width<=850?44:46);assert.equal(geometry.inlineHeight,'');
   assert(geometry.scroll<=width+1,JSON.stringify({width,scale,geometry}));
   assert(geometry.headerScroll<=width+1,JSON.stringify({width,scale,geometry}));
   assert(geometry.clockRight<=geometry.controlsLeft+1,JSON.stringify({width,scale,geometry}));
   assert(geometry.homeRight<=geometry.clockLeft+1,JSON.stringify({width,scale,geometry}));
   assert(geometry.brandRight<=geometry.homeLeft+1,JSON.stringify({width,scale,geometry}));
   assert(geometry.clockFont<=scale*.875,'The timer must use normal toolbar typography');
   assert.equal(geometry.pauseOverflow,false,'The textual pause control must fit');assert(await page.locator('[data-program-session="pause"]').isVisible());
   assert.equal(geometry.height,geometry.variable);
   await page.locator('[data-program-session="pause"]').click();assert.equal(await page.locator('[data-program-session="resume"]').textContent(),'Reprendre');
   const pausedGeometry=await headerGeometry();assert(pausedGeometry.scroll<=width+1);assert(pausedGeometry.clockRight<=pausedGeometry.controlsLeft+1);assert.equal(pausedGeometry.pauseOverflow,false);
   await page.locator('[data-program-session="resume"]').click();
  }
 }
 await page.screenshot({path:join(output,'mobile-large-text.png'),fullPage:true});
 await page.locator('.training-session-menu summary').click();
 assert.equal(await page.locator('[data-program-session="finish"]').count(),1);
 assert(await page.locator('[data-program-session="finish"]').isVisible());
 await page.locator('[data-program-session="finish"]').click();await page.locator('.topbar:not(.training-toolbar-active)').waitFor();
 assert.equal(await page.locator('.training-toolbar-active').count(),0);assert(await page.locator('#session-pause').isVisible());
 await unchangedBrand();assert(await page.locator('#normal-settings').isVisible());
 assert.equal(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--app-header-height')),'');
 await page.evaluate(()=>{value={id:'challenge',activity:'color',clockType:'countdown',remainingMs:30000,targetMs:60000,elapsedMs:30000,canPause:false,canFinish:false};toolbar.render();});
 assert.equal(await page.locator('[data-program-session="pause"]').isVisible(),false);
 assert.equal(await page.locator('[data-program-session="finish"]').isVisible(),false);
 await page.evaluate(()=>{value={id:'scoped-quantity',activity:'puzzles',program:true,goalScope:'week',goalMetric:'quantity',clockType:'quantity',quantityUnit:'positions',remainingQuantity:47,targetQuantity:50,completedQuantity:3,elapsedMs:123000,progress:.06,canPause:false,canFinish:true};toolbar.render();});
 assert.equal(await page.locator('[data-training-clock]').textContent(),'02:03');
 assert.match(await page.locator('[data-training-quantity]').textContent(),/3 \/ 50 (exercices|exercises)/);
 await page.locator('.training-session-menu summary').click();
 assert.match(await page.locator('.training-toolbar-goal strong').textContent(),/50/);
 assert.doesNotMatch(await page.locator('.training-toolbar-goal strong').textContent(),/:/);
 assert.match(await page.locator('[data-training-details-quantity]').textContent(),/3 \/ 50 (exercices|exercises)/);assert.match(await page.locator('[data-training-details-clock]').textContent(),/02:03/);
 await page.keyboard.press('Escape');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:join(output,'mobile-scoped-quantity.png'),fullPage:true});
 await page.evaluate(()=>{value={...value,elapsedMs:null};toolbar.render();});assert.equal(await page.locator('[data-training-clock]').textContent(),'—');
 await page.evaluate(()=>{value={...value,id:'scoped-sessions',activity:'reading',goalMetric:'sessions',clockType:'countdown',quantityUnit:'sessions',remainingQuantity:2,targetQuantity:2,targetMs:900000,remainingMs:840000,elapsedMs:60000};toolbar.render();});
 assert.equal(await page.locator('[data-training-clock]').textContent(),'14:00');
 assert.match(await page.locator('[data-training-status]').textContent(),/2 (séances restantes|sessions remaining)/);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.locator('.training-toolbar-home').click();assert.equal(await page.locator('[data-training-session-bar]').count(),0);assert(await page.evaluate(()=>actions.at(-1)==='return'));await unchangedBrand();
 await page.evaluate(()=>toolbar.dispose());assert.equal(await page.locator('#normal-settings').isVisible(),true);
 assert.deepEqual(errors,[]);console.log('PASS original logo/header preserved, compact timer/counts, stable menu, text pause/resume, errors, navigation restoration, 320–1440px and 100–150% text');
}catch(error){await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}finally{await context.close();}
