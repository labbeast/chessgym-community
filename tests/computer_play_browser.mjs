import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const report={checks:[],errors:[],sourceMutations:[],geometry:[]};
let context,page;
async function openBrowser(profile='profile'){
 context=await chromium.launchPersistentContext(join(output,profile),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
 page=await context.newPage();page.setDefaultTimeout(15000);
 page.on('pageerror',error=>report.errors.push(String(error)));
 context.on('request',request=>{const path=new URL(request.url()).pathname;if(['POST','PATCH','PUT','DELETE'].includes(request.method())&&fixture.sources.some(id=>path==='/api/entries/'+id||path.startsWith('/api/entries/'+id+'/')&&!path.endsWith('/seen')))report.sourceMutations.push({path,method:request.method()});});
 await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
}
await openBrowser();
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();}
async function waitWorkspace(predicate){const deadline=Date.now()+15000;do{const saved=await json('/api/workspace/computer');if(predicate(saved.data))return saved;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);throw Error('Computer session did not reach the server workspace');}
async function assertMoves(expected){await page.waitForFunction(count=>document.querySelectorAll('.computer-moves [data-path]').length===count,expected);}
async function navigate(name){await page.evaluate(name=>document.querySelector('[data-page="'+name+'"]').click(),name);}
async function play(uci){const host='.computer-page [data-board]';await page.locator(host+' [data-square="'+uci.slice(0,2)+'"]').click();await page.locator(host+' [data-square="'+uci.slice(2,4)+'"]').click();}
async function humanTurn(){await page.waitForFunction(()=>['À toi de jouer','Your turn'].includes(document.querySelector('.computer-status strong')?.textContent));}
async function engineResponse(action){const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/computer/move'&&response.request().method()==='POST',{timeout:30000});await action();const response=await pending;assert(response.ok(),await response.text());const result=await response.json();await humanTurn();return result;}
async function capture(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});const geometry=await page.evaluate(()=>{const node=document.querySelector('.computer-page .chess-board'),r=node?.getBoundingClientRect();return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,board:r?{x:r.x,width:r.width,height:r.height}:null};});report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.width+1,name+' horizontal overflow');assert(geometry.board?.width>0&&Math.abs(geometry.board.width-geometry.board.height)<2,name+' square board');}
function check(label){report.checks.push(label);console.log('PASS '+label);}
try{
 await json('/api/setup-resources/complete','POST',{});await page.goto(url);await page.locator('[data-base]').first().waitFor();
 await navigate('computer');await page.locator('[data-setup]').waitFor();
 assert.equal(await page.locator('[name="provider"] option[value="maia"]').textContent(),'Maia 3');
 await page.locator('[name="strength"]').selectOption('0');await page.locator('[name="time_ms"]').selectOption('100');
 await capture('desktop-setup');await page.locator('[data-setup] [type="submit"]').click();await humanTurn();
 const stockfish=await engineResponse(()=>play('e2e4'));assert.deepEqual(stockfish.history.slice(0,1),['e2e4']);assert.equal(stockfish.history.length,2);assert.equal(await page.locator('.computer-moves [data-path]').count(),2);
 await capture('desktop-stockfish');check('Stockfish level 0 plays a legal reply and exposes complete move history');
 await page.reload();await humanTurn();await assertMoves(2);assert.match(await page.locator('.computer-heading h1').textContent(),/Stockfish.*0/);
 const savedStockfish=await waitWorkspace(data=>data?.session?.position.history.length===2);
 assert.equal(savedStockfish.data.config.provider,'stockfish');assert.equal(savedStockfish.data.config.skill,0);assert.equal(savedStockfish.data.config.time_ms,100);assert.equal(savedStockfish.data.session.side,'white');assert.deepEqual(savedStockfish.data.session.position.history,stockfish.history);
 check('Reload immediately after a reply retains both moves, opponent, strength, time and human side');
 await navigate('library');await page.locator('[data-base]').first().waitFor();await navigate('computer');await humanTurn();assert.equal(await page.locator('.computer-moves [data-path]').count(),2);check('Section navigation resumes the same game without an extra engine move');
 await navigate('library');await page.locator('[data-base]').first().waitFor();let releaseOpponents,opponentsEntered;
 const opponentsGate=new Promise(resolve=>releaseOpponents=resolve),opponentsReady=new Promise(resolve=>opponentsEntered=resolve);
 await context.route('**/api/computer/opponents',async route=>{opponentsEntered();await opponentsGate;try{await route.continue();}catch{}});
 await navigate('computer');await opponentsReady;await navigate('library');await page.locator('[data-base]').first().waitFor();releaseOpponents();await context.unroute('**/api/computer/opponents');
 await navigate('computer');await humanTurn();assert.equal(await page.locator('.computer-moves [data-path]').count(),2);check('Leaving during opponent loading cannot erase the suspended game');
 await page.locator('[data-undo]').click();await page.waitForFunction(()=>document.querySelectorAll('.computer-moves [data-path]').length===0);await humanTurn();check('Takeback returns both plies to the human turn');
 await page.locator('[data-resign]').click();await page.locator('.computer-status.lost').waitFor();assert.match(await page.locator('.computer-status').textContent(),/0-1/);
 await page.reload();await page.locator('.computer-status.lost').waitFor();assert.match(await page.locator('.computer-status').textContent(),/0-1/);assert.equal(await page.locator('[data-resign]').count(),0);
 await waitWorkspace(data=>data?.session?.resigned&&data.session.headers.Result==='0-1');check('Resigned result survives reload and does not restart the engine');
 await page.locator('[data-new]').click();await page.locator('[name="provider"]').selectOption('maia');
 assert.deepEqual(await page.locator('[name="strength"] option').evaluateAll(options=>options.map(option=>Number(option.value))),Array.from({length:21},(_,i)=>600+i*100));
 assert.match(await page.locator('[data-strength-label]').textContent(),/Lichess/);
 await capture('desktop-maia3-setup');await page.setViewportSize({width:390,height:844});await capture('mobile-maia3-setup');await page.setViewportSize({width:1440,height:900});
 await page.locator('[name="strength"]').selectOption('1500');await page.locator('[name="side"]').selectOption('black');
 const maia=await engineResponse(()=>page.locator('[data-setup] [type="submit"]').click());assert.equal(maia.history.length,1);assert.equal(maia.turn,'black');
 await page.setViewportSize({width:390,height:844});await capture('mobile-maia');assert.equal(await page.locator('.computer-page .chess-board [data-square]').first().getAttribute('data-square'),'h1');check('Real Maia 3 starts as White, with a flipped mobile board for the human');
 const firstMaia=await waitWorkspace(data=>data?.config.provider==='maia'&&data.session?.position.history.length===1);assert.equal(firstMaia.data.session.headers.White,'Maia 3 · 1500');
 await context.route('**/api/workspace/computer',route=>route.request().method()==='PUT'?route.fulfill({status:503,json:{detail:'Temporary persistence outage for the isolated test'}}):route.continue());
 const afterBlack=await engineResponse(()=>play('e7e5'));assert.equal(afterBlack.history[1],'e7e5');assert.equal(afterBlack.history.length,3);
 assert.equal((await json('/api/workspace/computer')).data.session.position.history.length,1);
 const resumeUrl=page.url();await context.close();await openBrowser();await page.goto(resumeUrl);await humanTurn();await assertMoves(3);
 assert.equal(await page.locator('.computer-heading h1').textContent(),'Maia 3 · 1500');assert.equal(await page.locator('.computer-page .chess-board [data-square]').first().getAttribute('data-square'),'h1');
 const savedMaia=await waitWorkspace(data=>data?.session?.position.history.length===3&&data.config.provider==='maia');assert.deepEqual(savedMaia.data.session.position.history,afterBlack.history);assert.equal(savedMaia.data.session.side,'black');
 check('Closing the entire browser during a persistence outage restores the local game and synchronizes it afterwards');
 // A fresh browser has neither cookies nor localStorage. Its recovered game
 // must therefore come from the same automatic local profile on the server.
 await context.close();await openBrowser('second-device');await page.goto(resumeUrl);await humanTurn();await assertMoves(3);
 assert.equal(await page.locator('.computer-heading h1').textContent(),'Maia 3 · 1500');assert.equal(await page.locator('.computer-page .chess-board [data-square]').first().getAttribute('data-square'),'h1');check('A fresh browser without login restores the local profile’s server copy without a library save');
 await page.setViewportSize({width:390,height:844});
 await page.locator('[data-resign]').click();await page.locator('[data-new]').click();await page.locator('[name="side"]').selectOption('white');await page.locator('[name="start"]').selectOption('fen');
 await page.locator('[name="fen"]').fill('7k/8/5KQ1/8/8/8/8/8 w - - 0 1');await page.locator('[data-setup] [type="submit"]').click();await humanTurn();await play('g6g7');await page.locator('.computer-status.won').waitFor();assert.match(await page.locator('.computer-status').textContent(),/1-0/);await capture('mobile-checkmate');check('Custom FEN starts correctly and checkmate has a clear final result');
 await page.locator('[data-analyse]').click();await page.locator('dialog.analysis-dialog .chess-board').waitFor();await page.locator('dialog.analysis-dialog [data-close]').first().click();await page.locator('.computer-status.won').waitFor();check('Finished game opens in isolated analysis without leaving or resetting the computer game');
 await page.setViewportSize({width:1440,height:900});await page.goto(url+'/#/board?entry='+fixture.entry_id);await page.locator('#move-list [data-path="0.1"]').waitFor();await page.locator('#move-list [data-path="0.1"]').click();await page.waitForFunction(()=>document.querySelector('#move-list .current')?.dataset.path==='0.1');
 await page.locator('.analysis-more>summary').click();await page.locator('[data-action="computer-current"]').click();await page.locator('[data-setup]').waitFor();assert.equal(await page.locator('[name="start"]').inputValue(),'analysis');
 await page.locator('[name="provider"]').selectOption('maia');await page.locator('[data-setup] [type="submit"]').click();await humanTurn();assert.equal(await page.locator('.computer-moves [data-path]').count(),2);
 const branch=await engineResponse(()=>play('g1f3'));assert.deepEqual(branch.history.slice(0,3),['e2e4','c7c5','g1f3']);
 await navigate('board');await page.locator('#move-list [data-path="0.1"]').waitFor();assert.equal(await page.locator('#move-list .current').getAttribute('data-path'),'0.1');assert.match(await page.locator('#move-list').textContent(),/Keep annotation/);assert.match(await page.locator('#move-list').textContent(),/Keep variation/);
 assert.equal(await page.locator('#move-list [data-path]').count(),5);check('Analysis launch keeps selected variation/history and preserves source board, annotations and cursor');
 // A delayed reply must not apply after navigation; resume can make one fresh request.
 await navigate('computer');await humanTurn();let held=false,release;const gate=new Promise(resolve=>release=resolve);
 await context.route('**/api/computer/move',async route=>{if(!held){held=true;await gate;}try{await route.continue();}catch{}});
 const position=branch;const legal=position.legal_moves[0];await play(legal);await page.waitForFunction(()=>document.querySelector('.computer-status.thinking'));await navigate('library');await page.locator('[data-base]').first().waitFor();release();
 await context.unroute('**/api/computer/move');await navigate('computer');await humanTurn();assert.equal(await page.locator('.computer-moves [data-path]').count(),6);check('Leaving during engine calculation cancels the view and resumes exactly one reply');
 const beforeReload=await waitWorkspace(data=>data?.session?.position.history.length===6);let pendingHeld=false,releasePending;const pendingGate=new Promise(resolve=>releasePending=resolve);
 await context.route('**/api/computer/move',async route=>{if(!pendingHeld){pendingHeld=true;await pendingGate;}try{await route.continue();}catch{}});
 await play(beforeReload.data.session.position.legal_moves[0]);await page.waitForFunction(()=>document.querySelector('.computer-status.thinking'));
 await page.reload();await humanTurn();await assertMoves(8);releasePending();await context.unroute('**/api/computer/move');
 const afterReload=await waitWorkspace(data=>data?.session?.position.history.length===8);assert.deepEqual(afterReload.data.session.position.history.slice(0,6),beforeReload.data.session.position.history);assert.equal(afterReload.data.session.position.history[6],beforeReload.data.session.position.legal_moves[0]);
 check('Reload during engine calculation retains the acknowledged human move and resumes exactly one reply');
 let validationHeld=false,releaseValidation,validationEntered;const validationGate=new Promise(resolve=>releaseValidation=resolve),validationReady=new Promise(resolve=>validationEntered=resolve);
 await context.route('**/api/computer/position',async route=>{if(!validationHeld&&route.request().postDataJSON()?.move){validationHeld=true;validationEntered();await validationGate;}try{await route.continue();}catch{}});
 const pendingHumanMove=afterReload.data.session.position.legal_moves[0];await play(pendingHumanMove);await validationReady;
 await page.reload();await humanTurn();await assertMoves(10);releaseValidation();await context.unroute('**/api/computer/position');
 const afterValidation=await waitWorkspace(data=>data?.session?.position.history.length===10);assert.deepEqual(afterValidation.data.session.position.history.slice(0,8),afterReload.data.session.position.history);assert.equal(afterValidation.data.session.position.history[8],pendingHumanMove);assert.equal(afterValidation.data.pendingMove,null);
 check('Reload before human-move validation finishes restores that move once and receives exactly one engine reply');
 await json('/api/preferences','PATCH',{language:'en'});await page.reload();await humanTurn();await assertMoves(10);assert.equal(await page.locator('.computer-heading h1').textContent(),'Maia 3 · 1500');assert.match(await page.locator('.computer-heading').textContent(),/White/);check('English labels load while preserving the resumed game');
 const finalWorkspace=await waitWorkspace(data=>data?.session?.position.history.length===10);assert(finalWorkspace.revision>0);report.finalComputerWorkspace={revision:finalWorkspace.revision,provider:finalWorkspace.data.config.provider,plies:finalWorkspace.data.session.position.history.length};
 assert.deepEqual(report.sourceMutations,[]);assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
