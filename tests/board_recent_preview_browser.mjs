import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only isolated loopback fixtures may be tested');
const report={status:'running',checks:[],errors:[],externalRequests:[],sourceMutations:[],geometry:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
const startup=()=>localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'never'}));
await context.addInitScript(startup);
const page=await context.newPage();page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
let delayed=null;
async function routeRequests(route){
 const request=route.request(),parsed=new URL(request.url());if(parsed.origin!==url)return route.abort();
 if(delayed&&request.method()==='GET'&&parsed.pathname==='/api/entries/'+delayed.id){const pending=delayed;delayed=null;pending.started();await pending.wait;return route.continue();}
 if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
 if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
 if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Engine disabled in isolated fixture.'}});
 return route.continue();
}
await context.route('**/*',routeRequests);
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.status()===204?null:response.json();}
async function waitJson(path,predicate){const end=Date.now()+15000;do{const value=await json(path);if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw Error('Timed out waiting for '+path);}
async function check(name,action){await action();report.checks.push(name);console.log('PASS '+name);}
async function menu(target=page){const host=target.locator('details[data-board-menu]:visible').first();await host.waitFor({state:'visible'});if(await host.getAttribute('open')===null)await host.locator(':scope > summary').click();await host.locator('[data-board-menu-content]').waitFor({state:'visible'});return host;}
async function command(name){await (await menu()).locator('[data-board-command="'+name+'"]').click();}
async function library(){await page.locator('.brand[data-page="library"]:visible').click();await page.locator('[data-base]').first().waitFor();}
async function openGame(base,id){await library();await page.locator('[data-base="'+base+'"]').click();await page.locator('[data-et-action="open"][data-et-id="'+id+'"]').first().click();await page.locator('#board-host .chess-board').waitFor();}
async function selectMove(path){await page.locator('#move-list [data-path="'+path+'"]').click();await page.waitForFunction(path=>document.querySelector('#move-list .current')?.dataset.path===path,path);}
async function reload(){await page.goto(url+'/#/library');await page.reload();await page.locator('[data-base]').first().waitFor();}
async function recent(identity){return (await menu()).locator('[data-board-recent="'+identity+'"]');}
async function preview(fen,flipped=false,target=page){
 const tip=target.locator('.board-recent-preview:visible');await tip.waitFor();
 await target.waitForFunction(({fen,flipped})=>[...document.querySelectorAll('.board-recent-preview')].some(node=>node.dataset.fen===fen&&node.dataset.flipped===String(flipped)),{fen,flipped});
 assert.equal(await tip.locator('.board-recent-preview-square').count(),64);
 assert.equal(await tip.locator('.board-recent-preview-square').first().getAttribute('data-square'),flipped?'h1':'a8');
 assert.equal(await tip.locator('button,input,a').count(),0,'The preview cannot edit or navigate the board');
 assert.equal(await tip.locator('img').count(),32,'The fixture position retains every piece');
 const geometry=await tip.evaluate(node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height,viewportWidth:innerWidth,viewportHeight:innerHeight};});
 assert(geometry.left>=0&&geometry.right<=geometry.viewportWidth&&geometry.top>=0&&geometry.bottom<=geometry.viewportHeight,'The preview remains within the viewport');
 assert(geometry.width<=260&&geometry.height<=300,'The preview remains small');report.geometry.push(geometry);return tip;
}
async function hidden(target=page){await target.locator('.board-recent-preview:visible').waitFor({state:'hidden'});}
function holdEntry(id){let started,release;const start=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{release=resolve;});delayed={id,started,wait};return {start,release};}
async function started(pending){await Promise.race([pending.start,new Promise((_,reject)=>setTimeout(()=>reject(Error('Expected a cold saved-entry preview fetch')),12000))]);}
async function localItem(key){return page.evaluate(key=>{for(let index=0;index<localStorage.length;index++){const storageKey=localStorage.key(index);if(storageKey.startsWith('chessgym-workspace-v1:')&&storageKey.endsWith(':slot:'+encodeURIComponent(key)))return JSON.parse(localStorage.getItem(storageKey));}return null;},key);}

try{
 await json('/api/setup-resources/complete','POST',{});
 await json('/api/preferences','PATCH',{language:'en'});
 const base=await json('/api/bases','POST',{name:'Preview regression source',settings:{}}),games=[];
 for(let i=1;i<=3;i++)games.push(await json('/api/entries','POST',{base_id:base.id,title:'Saved preview '+i,pgn:'[Event "Hover regression"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *'}));
 const originals=await Promise.all(games.map(game=>json('/api/entries/'+game.id)));
 const paths=['0.0','0.0.0','0'];
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();
 for(let i=0;i<games.length;i++){
  await openGame(base.id,games[i].id);await selectMove(paths[i]);
  if(i===0)await page.locator('#board-host [data-b="flip"]').click();
 }
 await command('new');await page.locator('#board-host .chess-board').waitFor();
 await page.locator('#board-host [data-square="d2"]').click();await page.locator('#board-host [data-square="d4"]').click();await page.locator('#move-list [data-path="0"]').waitFor();
 await page.locator('#board-host [data-square="d7"]').click();await page.locator('#board-host [data-square="d5"]').click();await page.locator('#move-list [data-path="0.0"]').waitFor();await selectMove('0');
 await command('new');await library();
 const stored=await waitJson('/api/workspace',data=>data.items.some(item=>item.key.startsWith('document:free:')&&item.data?.doc?.nodes?.some(node=>node.path==='0.0')));
 const draft=stored.items.find(item=>item.key.startsWith('document:free:')&&item.data?.doc?.nodes?.some(node=>node.path==='0.0'));
 const draftIdentity=draft.key.slice('document:'.length),draftFen=draft.data.doc.nodes.find(node=>node.path==='0').fen;
 await reload();
 await check('Library section labels removed; Manage drafts matches New Board color',async()=>{
  const libraryMenu=page.locator('details.navigation-group:visible').filter({has:page.locator('summary', {hasText:'Library'})}).first();
  await libraryMenu.locator(':scope > summary').click();const text=await libraryMenu.innerText();assert(!/^Databases$/m.test(text));assert(!/^My content$/m.test(text));await page.keyboard.press('Escape');
  const host=await menu(),colors=await host.evaluate(node=>['new','manage'].map(command=>getComputedStyle(node.querySelector('[data-board-command="'+command+'"]').firstElementChild||node.querySelector('[data-board-command="'+command+'"]')).color));assert.equal(colors[0],colors[1]);
  await page.keyboard.press('Escape');
 });
 await check('Clean saved recent previews the last active mid-game position and flipped orientation',async()=>{
  const identity='entry:'+games[0].id,view=(await localItem('view:'+identity)).data;
  assert.equal(view.path,paths[0]);assert.equal(view.flipped,true);assert.equal((await localItem('document:'+identity))?.data??null,null,'Clean saved source need not retain a draft PGN');
  const before=page.url(),row=await recent(identity);await row.hover();await preview(originals[0].nodes.find(node=>node.path===paths[0]).fen,true);
  assert.equal(page.url(),before,'Hover does not navigate');assert.equal(await page.locator('#board-host').count(),0,'Hover does not open an analysis board');
  await page.screenshot({path:join(output,'saved-recent-preview.png'),fullPage:true});
  await page.mouse.move(1000,750);await hidden();await page.keyboard.press('Escape');
 });
 await check('Draft recent previews its last active move without navigating or editing',async()=>{
  const before=page.url(),row=await recent(draftIdentity);await row.hover();await preview(draftFen);
  assert.equal(page.url(),before);await page.screenshot({path:join(output,'draft-recent-preview.png'),fullPage:true});
  await page.mouse.move(1000,750);await hidden();await page.keyboard.press('Escape');
 });
 await check('Keyboard focus displays the preview and Escape removes it',async()=>{
  await (await recent(draftIdentity)).focus();await preview(draftFen);await page.keyboard.press('Escape');await hidden();assert.equal(await page.locator('details[data-board-menu]:visible').first().getAttribute('open'),null);
 });
 await check('A delayed saved preview cannot replace a newer hovered draft',async()=>{
  await reload();const pending=holdEntry(games[1].id);
  try{await (await recent('entry:'+games[1].id)).hover();await started(pending);await (await recent(draftIdentity)).hover();await preview(draftFen);pending.release();await page.waitForLoadState('networkidle');await preview(draftFen);}finally{pending.release();}
  await page.keyboard.press('Escape');await hidden();
 });
 await check('Closing the menu suppresses an in-flight preview response',async()=>{
  await reload();const pending=holdEntry(games[2].id);
  try{await (await recent('entry:'+games[2].id)).hover();await started(pending);await page.keyboard.press('Escape');pending.release();await page.waitForLoadState('networkidle');await hidden();}finally{pending.release();}
 });
 await check('Touch on a recent still opens the game without a hover preview',async()=>{
  const mobile=await context.browser().newContext({storageState:await context.storageState(),hasTouch:true,isMobile:true,viewport:{width:390,height:844}});await mobile.addInitScript(startup);await mobile.route('**/*',routeRequests);
  try{const phone=await mobile.newPage();phone.setDefaultTimeout(15000);await phone.goto(url);await phone.locator('[data-base]').first().waitFor();const host=await menu(phone),row=host.locator('[data-board-recent="'+draftIdentity+'"]');await row.dispatchEvent('pointerover',{pointerType:'touch',isPrimary:true});await phone.waitForTimeout(300);await hidden(phone);await row.tap();await phone.locator('#board-host .chess-board').waitFor();await hidden(phone);assert.equal(await phone.locator('#move-list .current').getAttribute('data-path'),'0');await phone.screenshot({path:join(output,'touch-recent-open.png'),fullPage:true});}finally{await mobile.close();}
 });
 await check('Previewing preserves source PGNs and produces no application errors',async()=>{
  for(let i=0;i<games.length;i++){const current=await json('/api/entries/'+games[i].id);for(const field of ['pgn','title','revision'])assert.deepEqual(current[field],originals[i][field]);}
  assert.deepEqual(report.sourceMutations,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{if(delayed)delayed.started();await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify(report,null,2));}
