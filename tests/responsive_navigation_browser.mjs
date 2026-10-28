import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const report={status:'running',checks:[],geometry:[],errors:[],consoleErrors:[],sourceMutations:[],externalRequests:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
await context.addInitScript(()=>localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'never'})));
const page=await context.newPage();page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push(String(error)));page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
page.on('dialog',async dialog=>{report.errors.push('Unexpected confirmation: '+dialog.message());await dialog.dismiss();});
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
page.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
await context.route('**/*',async route=>{const parsed=new URL(route.request().url());if(parsed.origin!==url)return route.abort();if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test isolé.'}});return route.continue();});
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),`${method} ${path}: ${response.status()}`);return response.status()===204?null:response.json();}
async function check(name,action){await action();report.checks.push(name);console.log('PASS '+name);}
async function frame(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function mobile(){return page.locator('nav.mobile-navigation').isVisible();}
async function group(name){if(await mobile())return page.locator('.mobile-navigation-group[data-navigation-section="'+name+'"]');return page.locator('.top-nav>.navigation-group').nth(['library','training','board'].indexOf(name));}
async function open(name){const host=await group(name);if(await host.getAttribute('open')===null)await host.locator(':scope>summary').click();await frame();return host;}
async function navigateLibrary(){await (await open('library')).locator('[data-page="library"]').click();await page.locator('[data-base]').first().waitFor();}
async function boardCommand(name){await (await open('board')).locator('[data-board-command="'+name+'"]').click();}
async function annotate(value){if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]:visible');if(await toggle.count())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}const field=page.locator('#annotation-form textarea');await field.waitFor({state:'visible'});if(value!==undefined)await field.fill(value);return field;}
async function screenshot(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});}
async function geometry(name){
 const result=await page.evaluate(()=>{const selector=getComputedStyle(document.querySelector('.mobile-navigation')).display!=='none'?'.mobile-navigation-group[open]':'.top-nav>.navigation-group[open]',host=document.querySelector(selector),panel=host?.querySelector(':scope>.mobile-navigation-dropdown,:scope>.navigation-dropdown,:scope>.navigation-menu-content,:scope>[data-board-menu-content]'),rect=panel?.getBoundingClientRect();return {viewport:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,panel:rect?{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:rect.width,height:rect.height,scrollHeight:panel.scrollHeight,clientHeight:panel.clientHeight}:null};});
 report.geometry.push({name,...result});assert(result.scrollWidth<=result.viewport+1,name+' page width');assert(result.panel,name+' has an open dropdown');if(result.panel){assert(result.panel.left>=-1&&result.panel.right<=result.viewport+1,name+' panel horizontal bounds');assert(result.panel.top>=0&&result.panel.bottom<=result.height+1,name+' panel vertical bounds');}
}
async function visibleLabel(host){return host.locator(':scope>summary .navigation-group-label').evaluate(label=>{const style=getComputedStyle(label),rect=label.getBoundingClientRect();return style.display!=='none'&&style.visibility!=='hidden'&&style.opacity!=='0'&&rect.width>1&&rect.height>1;});}
async function iconBar(){
 assert.equal(await page.locator('nav.mobile-navigation').count(),1);assert.equal(await page.locator('.mobile-navigation-group').count(),3);
 for(const name of ['library','training','board']){const host=await group(name),summary=host.locator(':scope>summary');assert.equal(await summary.locator('svg').count(),1);const label=await summary.getAttribute('aria-label');assert(label?.trim(),name+' icon requires an accessible name');assert.equal(await visibleLabel(host),await host.getAttribute('open')!==null,name+' label shown only while open');const box=await summary.boundingBox();assert(box.x>=0&&box.x+box.width<=page.viewportSize().width+1,name+' icon fits in the header');}
}
async function closedBar(name){const data=await page.evaluate(()=>{const counter=document.querySelector('#analysis-entry-nav-mobile .analysis-entry-counter'),logo=document.querySelector('.brand img');return {counter:counter?{text:counter.textContent,clientWidth:counter.clientWidth,scrollWidth:counter.scrollWidth}:null,logoFilter:getComputedStyle(logo).filter};});report.geometry.push({name,...data});assert.equal(data.logoFilter,'none','The opaque mobile icon must retain its original colors');if(data.counter)assert(data.counter.scrollWidth<=data.counter.clientWidth+1,'The closed mobile game counter is readable');}

try{
 await json('/api/setup-resources/complete','POST',{});
 const base=await json('/api/bases','POST',{name:'Cours de préparation et annotations <à préserver>',settings:{}});
 const games=[];for(let i=1;i<=5;i++)games.push(await json('/api/entries','POST',{base_id:base.id,title:'Partie '+i+' — préparation des variantes et commentaires personnels',pgn:'[Event "Source test"]\n[White "Joueur"]\n[Black "Adversaire"]\n[Result "*"]\n\n1. e4 {Commentaire source.} e5 2. Nf3 Nc6 *'}));
 const originals=await Promise.all(games.map(game=>json('/api/entries/'+game.id)));
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();
 for(const game of games){await navigateLibrary();await page.locator('[data-base="'+base.id+'"]').click();await page.locator('[data-et-action="open"][data-et-id="'+game.id+'"]').first().click();await page.locator('#board-host .chess-board').waitFor();}
 const identity='entry:'+games[4].id,note='Annotation non appliquée préservée depuis les menus mobiles';await page.locator('#move-list [data-path="0"]').click();await annotate(note);
 for(const language of ['fr','en']){
  await json('/api/preferences','PATCH',{language});await navigateLibrary();await page.reload();await page.locator('[data-base]').first().waitFor();await (await open('board')).locator('[data-board-recent="'+identity+'"]').click();await page.locator('#board-host .chess-board').waitFor();await page.locator('#move-list [data-path="0"]').click();assert.equal(await (await annotate()).inputValue(),note);
  for(const [width,height] of [[320,740],[390,844],[900,450],[1440,900]])await check(language+' '+width+'×'+height+' : trois menus accessibles, contenu visible et fermeture correcte',async()=>{
   await page.setViewportSize({width,height});await page.keyboard.press('Escape');await frame();assert.equal(await page.locator('[data-board-command="library"]').count(),0,'Redundant Board library command removed');
   const isMobile=await mobile();if(width<850)assert(isMobile);if(isMobile){await iconBar();await closedBar(language+'-'+width+'-closed');}await screenshot('navigation-'+language+'-'+width+'-closed');
   for(const name of ['library','training','board']){
    const host=await open(name),selector=isMobile?'.mobile-navigation-group[open]':'.top-nav>.navigation-group[open]';assert.equal(await page.locator(selector).count(),1,'Only one top menu opens');if(isMobile)await iconBar();await geometry(language+'-'+width+'-'+name);
    const buttons=host.locator('button:visible');assert(await buttons.count()>0);const last=buttons.last();await last.evaluate(node=>node.scrollIntoView({block:'nearest'}));const box=await last.boundingBox();assert(box.y>=0&&box.y+box.height<=height+1,name+' final action is reachable');
    if(name==='training'||name==='board')await screenshot('navigation-'+language+'-'+width+'-'+name);
   }
   await page.mouse.click(1,1);await frame();assert.equal(await (await group('board')).getAttribute('open'),null,'Outside click closes menu');if(isMobile)await iconBar();
   const host=await open('training');await host.locator(':scope>summary').focus();await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement?.dataset.page),'training-history');await page.keyboard.press('Escape');assert.equal(await host.getAttribute('open'),null);assert(await host.locator(':scope>summary').evaluate(node=>node===document.activeElement));
  });
 }
 await check('Passer par Training puis reprendre le brouillon et ses actions ⋯ conserve les annotations',async()=>{
  await page.setViewportSize({width:390,height:844});await (await open('training')).locator('[data-page="coordinates"]').click();await page.waitForFunction(()=>location.hash.includes('coordinates'));await boardCommand('current');await page.locator('#board-host .chess-board').waitFor();await page.locator('#move-list [data-path="0"]').click();assert.equal(await (await annotate()).inputValue(),note);
  const host=await open('board');await host.locator('[data-board-draft-options="'+identity+'"]').click();await page.locator('[data-board-draft-action="rename"]:visible').waitFor();assert.equal(await page.locator('[data-board-draft-action="delete"]:visible').count(),1);await screenshot('navigation-en-390-draft-actions');await page.locator('[data-board-draft-action="rename"]:visible').click();await page.locator('#modal[open] [name="draft_name"]').fill('Nom annulé');await page.locator('#modal[open] [data-close]').first().click();await page.keyboard.press('Escape');assert.equal(await (await annotate()).inputValue(),note);
 });
 await check('Les parties originales et les brouillons restent intacts sans erreur inattendue',async()=>{
  for(let i=0;i<games.length;i++){const current=await json('/api/entries/'+games[i].id);for(const field of ['id','base_id','title','pgn','revision'])assert.deepEqual(current[field],originals[i][field]);}assert.deepEqual(report.sourceMutations,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await screenshot('failure').catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify(report,null,2));}
