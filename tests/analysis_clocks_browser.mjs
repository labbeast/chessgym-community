import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only an isolated loopback server may be tested');
const report={status:'running',checks:[],geometry:[],errors:[],consoleErrors:[],sourceMutations:[],externalRequests:[],screenshots:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
await context.addInitScript(()=>localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'never'})));
const page=await context.newPage();page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
page.on('dialog',async dialog=>{report.errors.push('Unexpected confirmation: '+dialog.message());await dialog.dismiss();});
page.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
await context.route('**/*',async route=>{
 const parsed=new URL(route.request().url());if(parsed.origin!==url)return route.abort();
 if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
 if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
 if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test isolé.'}});
 return route.continue();
});
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.status()===204?null:response.json();}
async function check(name,action){await action();report.checks.push(name);console.log('PASS '+name);}
async function frame(){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function openGame(base,id){await page.locator('.brand[data-page="library"]:visible').click();await page.locator('[data-base="'+base+'"]').click();await page.locator('[data-et-action="open"][data-et-id="'+id+'"]').first().click();await page.locator('#board-host .chess-board').waitFor();await frame();}
async function selectMove(path){await page.locator('#move-list [data-path="'+path+'"]').click();await page.waitForFunction(value=>document.querySelector('#move-list .current')?.dataset.path===value,path);await frame();}
async function flip(){
 const toolbar=page.locator('#board-host [data-b="flip"]');if(await toolbar.isVisible())return toolbar.click();
 const options=page.locator('details.analysis-more');if(await options.getAttribute('open')===null)await options.locator(':scope>summary').click();
 await options.locator('[data-action="board-flip"]').click();
}
async function clocks(white,black,{flipped=false}={}){
 await page.waitForFunction(({white,black})=>['white','black'].every(side=>{const band=document.querySelector('#board-host [data-board-clock][data-side="'+side+'"]');return band&&!band.hidden&&band.querySelector('.board-clock-value')?.textContent===(side==='white'?white:black);}),{white,black});
 for(const [position,side] of [['top',flipped?'white':'black'],['bottom',flipped?'black':'white']]){
  const band=page.locator('#board-host [data-board-clock="'+position+'"]');assert.equal(await band.getAttribute('data-side'),side);
  assert.equal(await band.locator('.board-clock-name').textContent(),side==='white'?'Alice Horloge':'Benoît Chrono');
  assert.match(await band.locator('.board-clock-value').getAttribute('aria-label'),/Temps restant/);
 }
}
async function capture(name,{clocksVisible=true}={}){
 await frame();await page.screenshot({path:join(output,name+'.png'),fullPage:true});report.screenshots.push(name+'.png');
 const geometry=await page.evaluate(()=>{
  const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const board=document.querySelector('#board-host .chess-board'),top=document.querySelector('[data-board-clock="top"]'),bottom=document.querySelector('[data-board-clock="bottom"]');
  return {viewport:{width:innerWidth,height:innerHeight},scrollWidth:document.documentElement.scrollWidth,font:getComputedStyle(document.body).fontSize,board:box(board),top:top&&!top.hidden?box(top):null,bottom:bottom&&!bottom.hidden?box(bottom):null,moves:[...document.querySelectorAll('#move-list .analysis-move')].filter(node=>node.checkVisibility()).map(node=>({path:node.dataset.path,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,button:box(node),san:box(node.querySelector('.analysis-move-san')),details:box(node.querySelector('.analysis-move-details'))}))};
 });
 report.geometry.push({name,...geometry});const {board,top,bottom,viewport}=geometry;
 assert(geometry.scrollWidth<=viewport.width+1,name+': no horizontal page overflow');
 assert(board?.width>0&&Math.abs(board.width-board.height)<2,name+': the board stays square');
 assert(board.x>=-1&&board.right<=viewport.width+1,name+': the board fits the page width');
 if(clocksVisible){
  assert(top&&bottom,name+': both player clocks remain visible');assert(top.bottom<=board.y+1&&bottom.y>=board.bottom-1,name+': clocks stay above and below the board');
  for(const band of [top,bottom])assert(band.x>=board.x-1&&band.right<=board.right+1,name+': clock bars fit the board width');
  if(viewport.width>850)assert(bottom.bottom<=viewport.height+1,name+': board and clocks fit the desktop or landscape height');
 }else assert(!top&&!bottom,name+': clockless games reserve no visible bands');
 for(const move of geometry.moves){
  assert(move.scrollWidth<=move.clientWidth+1,name+': move '+move.path+' does not overflow');
  if(move.details)assert(move.san.right<=move.details.x+1,name+': SAN and clock/score remain separate for '+move.path);
 }
}

try{
 await json('/api/setup-resources/complete','POST',{});
 await json('/api/preferences','PATCH',{language:'fr'});
 const base=await json('/api/bases','POST',{name:'Pendules historiques · vérification isolée',settings:{}});
 const pgn='[Event "Pendules et variantes"]\n[White "Alice Horloge"]\n[Black "Benoît Chrono"]\n[TimeControl "600+5"]\n[Result "*"]\n\n1. e4 {[%clk 0:09:58]} e5 {[%clk 0:09:57]} 2. Nf3 {[%clk 0:09:40]} Nc6 (2... d6 {[%clk 0:09:45]}) 3. Bc4 {[%clk 0:09:30]} Nf6 {[%clk 0:00:00]} *';
 const timed=await json('/api/entries','POST',{base_id:base.id,title:'Horloges : branche, trou et zéro',pgn});
 const plain=await json('/api/entries','POST',{base_id:base.id,title:'Partie sans horloges enregistrées',pgn:'[White "Alice Horloge"]\n[Black "Benoît Chrono"]\n[TimeControl "600+5"]\n[Result "*"]\n\n1. d4 d5 2. c4 e6 *'});
 const originals=await Promise.all([timed,plain].map(game=>json('/api/entries/'+game.id)));
 const timedDoc=originals[0],path=san=>{const node=timedDoc.nodes.find(node=>node.san===san);assert(node,'Missing fixture move '+san);return node.path;};
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();await openGame(base.id,timed.id);
 await check('Horloges historiques de la position initiale et de chaque joueur',async()=>{
  await page.locator('#board-host [data-b="first"]').click();await clocks('10:00','10:00');
  await selectMove(path('e4'));await clocks('9:58','10:00');await selectMove(path('e5'));await clocks('9:58','9:57');await selectMove(path('Nf3'));await clocks('9:40','9:57');
 });
 await check('La table donne le temps pris par coup et respecte les durées inconnues',async()=>{
  for(const [san,value] of [['e4','7 s'],['e5','8 s'],['Nf3','23 s'],['d6','17 s'],['Bc4','15 s']]){
   const move=page.locator('#move-list .analysis-move[data-path="'+path(san)+'"]');assert.equal((await move.locator('.analysis-move-clock').textContent()).trim(),value);
   for(const attribute of ['aria-label','title'])assert((await move.getAttribute(attribute)).includes('Temps pris pour ce coup : '+value));
  }
  for(const san of ['Nc6','Nf6']){
   const move=page.locator('#move-list [data-path="'+path(san)+'"]');assert.equal(await move.locator('.analysis-move-clock').count(),0,'A missing earlier clock leaves the move duration unknown, even when the remaining clock is zero');
   for(const attribute of ['aria-label','title'])assert(!(await move.getAttribute(attribute)).includes('Temps pris pour ce coup :'));
  }
 });
 await check('Les trous rendent le camp inconnu et les variantes restent indépendantes',async()=>{
  await selectMove(path('Nc6'));await clocks('9:40','—');await selectMove(path('Bc4'));await clocks('9:30','—');await capture('desktop-clock-gap');
  await selectMove(path('d6'));await clocks('9:40','9:45');await capture('desktop-variation');
  await selectMove(path('Bc4'));await clocks('9:30','—');await selectMove(path('Nf6'));await clocks('9:30','0:00');
 });
 for(const [name,width,height] of [['desktop',1440,900],['mobile',390,844],['landscape',900,450]])await check(name+' : pendules, table et retournement sans débordement',async()=>{
  await page.setViewportSize({width,height});await frame();await selectMove(path('e5'));await clocks('9:58','9:57');await capture(name+'-mainline');
  await flip();await clocks('9:58','9:57',{flipped:true});await capture(name+'-flipped');
  await flip();await clocks('9:58','9:57');
 });
 await check('Une cadence seule ne crée ni pendules ni temps dans la table',async()=>{
  await page.setViewportSize({width:1440,height:900});await openGame(base.id,plain.id);
  assert.equal(await page.locator('#board-host [data-board-clock]:visible').count(),0);assert.equal(await page.locator('#move-list .analysis-move-clock').count(),0);
  await capture('desktop-no-clocks',{clocksVisible:false});
 });
 await check('PGN et révisions conservés, aucune mutation de partie ou requête externe',async()=>{
  for(const original of originals){const fresh=await json('/api/entries/'+original.id);for(const key of ['id','base_id','title','pgn','revision'])assert.deepEqual(fresh[key],original[key],key+' unchanged');}
  assert.deepEqual(report.sourceMutations,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify({status:report.status,checks:report.checks,screenshots:report.screenshots,failure:report.failure},null,2));}
