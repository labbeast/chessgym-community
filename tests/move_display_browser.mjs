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
  if(viewport.width>850&&!name.endsWith('display-menu'))assert(bottom.bottom<=viewport.height+1,name+': board and clocks fit the desktop or landscape height');
 }else assert(!top&&!bottom,name+': clockless games reserve no visible bands');
 for(const move of geometry.moves){
  assert(move.scrollWidth<=move.clientWidth+1,name+': move '+move.path+' does not overflow');
  if(move.details)assert(move.san.right<=move.details.x+1,name+': SAN and clock/score remain separate for '+move.path);
 }
}

async function displayOpen(){const menu=page.locator('details.analysis-reading-controls');if(!await menu.isVisible()){const more=page.locator('details.analysis-more');if(await more.getAttribute('open')===null)await more.locator(':scope>summary').click();}if(await menu.getAttribute('open')===null)await menu.locator(':scope>summary').click();return menu;}
async function setDisplay(key,value){const menu=await displayOpen(),control=menu.locator('[data-reading-setting="'+key+'"]');if(typeof value==='boolean')await control.setChecked(value);else await control.selectOption(value);await frame();}
async function closeDisplay(){const menu=page.locator('details.analysis-reading-controls');if(await menu.getAttribute('open')!==null)await menu.locator(':scope>summary').click();const more=page.locator('details.analysis-more');if(await more.getAttribute('open')!==null)await more.locator(':scope>summary').click();await frame();}
try{
 await json('/api/setup-resources/complete','POST',{});
 await json('/api/preferences','PATCH',{language:'fr'});
 const base=await json('/api/bases','POST',{name:'Affichage des coups · vérification isolée',settings:{}});
 const pgn='[Event "Pertes et temps"]\n[White "Alice Horloge"]\n[Black "Benoît Chrono"]\n[TimeControl "600+5"]\n[Result "*"]\n\n{[%eval 1.50]} 1. e4 $1 {[%eval 0.00] [%clk 0:09:35]} e5 {[%eval 2.00] [%clk 0:09:20]} 2. Nf3 {[%eval 1.30] [%clk 0:08:39]} Nc6 {[%eval 1.30] [%clk 0:08:25]} (2... d6 {[%eval 0.00] [%clk 0:08:50]}) 3. Bc4 Nf6 {[%eval 1.00] [%clk 0:07:25]} *';
 const timed=await json('/api/entries','POST',{base_id:base.id,title:'Pertes blanc/noir, seuils et annotations',pgn});
 const plain=await json('/api/entries','POST',{base_id:base.id,title:'Partie sans évaluations ni horloges',pgn:'[White "Alice Horloge"]\n[Black "Benoît Chrono"]\n[TimeControl "600+5"]\n[Result "*"]\n\n1. d4 d5 2. c4 e6 *'});
 const originals=await Promise.all([timed,plain].map(game=>json('/api/entries/'+game.id)));
 const timedDoc=originals[0],path=san=>{const node=timedDoc.nodes.find(node=>node.san===san);assert(node,'Missing fixture move '+san);return node.path;};
 const move=san=>page.locator('#move-list .analysis-move[data-path="'+path(san)+'"]');
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();await openGame(base.id,timed.id);
 await check('Perte des Blancs et des Noirs, variantes et annotations conservées',async()=>{
  for(const [san,loss,severity] of [['e4','−1,50','mistake'],['e5','−2,00','blunder'],['Nf3','−0,70','inaccuracy'],['Nc6','0,00',null],['d6','0,00',null]]){
   assert.equal((await move(san).locator('.analysis-move-score').textContent()).trim(),loss,san+' move loss');
   assert.equal(await move(san).getAttribute('data-eval-severity'),severity,san+' classification');
  }
  assert.equal((await move('e4').locator('.analysis-move-nags').textContent()).trim(),'!','Original PGN annotation stays intact');
  assert.equal(await move('e4').locator('.analysis-move-judgement').count(),1,'Automatic classification stays separate');
  for(const san of ['Bc4','Nf6'])assert.equal((await move(san).locator('.analysis-move-score').textContent()).trim(),'—','Missing evaluation never becomes zero');
 });
 await check('Temps avec incrément et seuils stricts de 5 % et 10 % du budget initial',async()=>{
  for(const [san,time,severity] of [['e4','30 s',null],['e5','45 s','moderate'],['Nf3','1:01','high'],['Nc6','1:00','moderate'],['d6','35 s','moderate'],['Nf6','1:05','high']]){
   assert.equal((await move(san).locator('.analysis-move-clock').textContent()).trim(),time,san+' duration');
   assert.equal(await move(san).getAttribute('data-time-severity'),severity,san+' time severity');
  }
  assert.equal(await move('Bc4').getAttribute('data-time-severity'),null,'Unknown duration has no warning');
 });
 await check('Les accents restent distincts sur le coup sélectionné',async()=>{
  await selectMove(path('e5'));await clocks('9:35','9:20');
  const colors=await move('e5').evaluate(node=>({score:getComputedStyle(node.querySelector('.analysis-move-score')).color,clock:getComputedStyle(node.querySelector('.analysis-move-clock')).color,current:node.classList.contains('current')}));
  assert(colors.current);assert.notEqual(colors.score,colors.clock,'Evaluation and clock have distinct colors on selected move');
  await capture('desktop-loss-and-time');
 });
 await check('Choisir évaluation totale et temps restant préserve la position',async()=>{
  await setDisplay('evaluationMode','position');await setDisplay('timeMode','remaining');
  assert.equal((await move('e5').locator('.analysis-move-score').textContent()).trim(),'+2,00');
  assert.equal((await move('e5').locator('.analysis-move-clock').textContent()).trim(),'9:20');
  assert.equal(await move('e5').locator('.analysis-move-score').getAttribute('data-eval-mode'),'position');
  assert.equal(await move('e5').locator('.analysis-move-clock').getAttribute('data-time-mode'),'remaining');
  assert.equal(await move('e5').getAttribute('aria-current'),'true');await clocks('9:35','9:20');
  const hint=await page.locator('.analysis-display-hint').evaluate(node=>({whiteSpace:getComputedStyle(node).whiteSpace,textOverflow:getComputedStyle(node).textOverflow,scroll:node.scrollWidth,client:node.clientWidth}));assert.equal(hint.whiteSpace,'normal','Time-threshold help wraps instead of being truncated');assert.notEqual(hint.textOverflow,'ellipsis');assert(hint.scroll<=hint.client+1,'Time-threshold help fits');await capture('desktop-display-menu');await closeDisplay();
 });
 await check('Chaque accent peut être désactivé indépendamment',async()=>{
  await setDisplay('highlightEvaluation',false);assert.equal(await move('e5').getAttribute('data-eval-severity'),null);assert.equal(await move('e5').getAttribute('data-time-severity'),'moderate');
  await setDisplay('highlightTime',false);assert.equal(await move('e5').getAttribute('data-time-severity'),null);
  await setDisplay('highlightEvaluation',true);assert.equal(await move('e5').getAttribute('data-eval-severity'),'blunder');assert.equal(await move('e5').getAttribute('data-time-severity'),null);
  await closeDisplay();
 });
 await check('Les préférences survivent au rechargement',async()=>{
  await page.reload();await page.locator('.brand[data-page="library"]:visible').waitFor();await openGame(base.id,timed.id);
  assert.equal((await move('e5').locator('.analysis-move-score').textContent()).trim(),'+2,00');assert.equal((await move('e5').locator('.analysis-move-clock').textContent()).trim(),'9:20');
  assert.equal(await move('e5').getAttribute('data-eval-severity'),'blunder');assert.equal(await move('e5').getAttribute('data-time-severity'),null);
  await setDisplay('evaluationMode','loss');await setDisplay('timeMode','elapsed');await setDisplay('highlightTime',true);await closeDisplay();
 });
 for(const [name,width,height] of [['mobile',390,844],['landscape',900,450]])await check(name+' : lecture, accents et options sans débordement',async()=>{
  await page.setViewportSize({width,height});await frame();await selectMove(path('e5'));await capture(name+'-loss-and-time');
  await displayOpen();await capture(name+'-display-menu');
  const optionGeometry=await page.locator('.analysis-reading-options').evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth,scroll:node.scrollWidth,client:node.clientWidth};});
  assert(optionGeometry.left>=-1&&optionGeometry.right<=optionGeometry.width+1,'Options fit viewport width');assert(optionGeometry.scroll<=optionGeometry.client+1,'Options contents fit');
  await setDisplay('timeMode','remaining');assert.equal((await move('e5').locator('.analysis-move-clock').textContent()).trim(),'9:20');await setDisplay('timeMode','elapsed');await closeDisplay();
 });
 await check('Les données absentes ne déclenchent pas de faux signalement',async()=>{
  await page.setViewportSize({width:1440,height:900});await openGame(base.id,plain.id);
  assert.equal(await page.locator('#move-list [data-eval-severity],#move-list [data-time-severity]').count(),0);
  for(const score of await page.locator('#move-list .analysis-move-score').allTextContents())assert.equal(score.trim(),'—');
  await capture('desktop-missing-data',{clocksVisible:false});
 });
 await check('Les options et détails du coup restent utilisables en anglais',async()=>{
  await json('/api/preferences','PATCH',{language:'en'});await page.reload();await page.locator('.brand[data-page="library"]:visible').waitFor();await openGame(base.id,timed.id);
  const menu=await displayOpen();assert.equal(await menu.locator('select[data-reading-setting="evaluationMode"] option[value="loss"]').textContent(),'Loss vs. best move');
  assert.equal((await move('e4').locator('.analysis-move-score').textContent()).trim(),'−1.50');
  const title=await move('e5').getAttribute('title');assert.doesNotMatch(title,/Évaluation|Temps pris|Gaffe|Blancs|Noirs|Perte par rapport/);await closeDisplay();
  await capture('desktop-english');
 });
 for(const theme of ['pearl','sand'])await check('Contraste lisible du thème clair '+theme,async()=>{
  await json('/api/preferences','PATCH',{theme});await page.reload();await page.locator('.brand[data-page="library"]:visible').waitFor();await openGame(base.id,timed.id);await selectMove(path('e5'));
  const contrasts=await page.locator('#move-list [data-eval-severity] .analysis-move-score,#move-list [data-time-severity] .analysis-move-clock').evaluateAll(nodes=>nodes.map(node=>{
   const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,1,1);
   const chain=[];for(let ancestor=node;ancestor;ancestor=ancestor.parentElement)chain.push(ancestor);for(const ancestor of chain.reverse()){ctx.fillStyle=getComputedStyle(ancestor).backgroundColor;ctx.fillRect(0,0,1,1);}const bg=[...ctx.getImageData(0,0,1,1).data].slice(0,3);
   const color=getComputedStyle(node).color;ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const fg=[...ctx.getImageData(0,0,1,1).data].slice(0,3);
   const luminance=rgb=>rgb.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);const a=luminance(bg),b=luminance(fg);
   return {text:node.textContent,color,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
  }));
  for(const item of contrasts)assert(item.contrast>=4.5,theme+': '+item.text+' contrast '+item.contrast);await capture('desktop-'+theme);
 });
 await check('PGN et révisions conservés, aucune mutation de partie ou requête externe',async()=>{
  for(const original of originals){const fresh=await json('/api/entries/'+original.id);for(const key of ['id','base_id','title','pgn','revision'])assert.deepEqual(fresh[key],original[key],key+' unchanged');}
  assert.deepEqual(report.sourceMutations,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify({status:report.status,checks:report.checks,screenshots:report.screenshots,failure:report.failure},null,2));}
