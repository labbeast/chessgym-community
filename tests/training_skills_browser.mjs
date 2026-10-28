import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const browser=await chromium.launch({executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,args:['--no-first-run','--disable-extensions']});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const report={checks:[],geometry:[],errors:[],external:[]};
page.setDefaultTimeout(12000);page.on('pageerror',error=>report.errors.push(String(error)));
page.on('request',request=>{if(!request.url().startsWith(url)&&!request.url().startsWith('data:'))report.external.push(request.url());});
async function api(path,method='GET',data){const response=await context.request.fetch(url+path,{method,data,headers:{Origin:url}});assert(response.ok(),await response.text());return response.json();}
async function nav(name){await page.locator('[data-page="'+name+'"]').first().evaluate(button=>button.click());await page.locator('.training-skill-view').waitFor();}
async function capture(name,selector='.skill-square-grid'){
 await page.screenshot({path:join(output,name+'.png'),fullPage:true});
 const geometry=await page.locator(selector).first().evaluate(board=>{const r=board.getBoundingClientRect();return {width:r.width,height:r.height,left:r.left,right:r.right,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth};});
 report.geometry.push({name,...geometry});assert(Math.abs(geometry.width-geometry.height)<2);assert(geometry.scrollWidth<=geometry.viewport+1);assert(geometry.left>=-1&&geometry.right<=geometry.viewport+1);
 if(geometry.viewport===390)assert(geometry.width>=386,'mobile board should use full width');
}
async function checkCenteredTarget(){
 const result=await page.locator('.skill-coordinate-board').evaluate(board=>{
  const target=board.querySelector('.skill-target'),a=board.getBoundingClientRect(),b=target.getBoundingClientRect();
  const x=a.left+a.width/2,y=a.top+a.height/2;
  return {dx:Math.abs(x-b.left-b.width/2),dy:Math.abs(y-b.top-b.height/2),pointerEvents:getComputedStyle(target).pointerEvents,hits:[[-2,-2],[2,-2],[-2,2],[2,2]].map(([dx,dy])=>document.elementFromPoint(x+dx,y+dy)?.closest('[data-square]')?.dataset.square)};
 });
 assert(result.dx<1&&result.dy<1,'target must be centered on the actual board');
 assert.equal(result.pointerEvents,'none');assert(result.hits.every(square=>['d4','e4','d5','e5'].includes(square)),'center overlay must allow clicks on all four central squares');
}
try{
 await api('/api/setup-resources/complete','POST',{});await page.goto(url);await page.locator('[data-page="coordinates"]').first().waitFor({state:'attached'});
 await page.evaluate(async()=>{const module=await import('/static/training-skills.js');const tick=module.CoordinateView.prototype.tick;module.CoordinateView.prototype.tick=function(){window.coordinateDebug={disposed:this.disposed,busy:this.busy,remaining:this.remaining(),session:this.session,now:Date.now(),offset:this.offset};return tick.call(this);};});
 await nav('coordinates');await page.selectOption('[name=mode]','notation');await page.selectOption('[name=orientation]','black');await page.check('[name=coordinates]');await page.locator('[data-coordinate-setup] [type=submit]').click();
 await page.locator('.skill-target').waitFor();const target=(await page.locator('.skill-target').textContent()).slice(-2);const wrongCenter=target==='d4'?'e4':'d4';await page.locator('[data-square="'+wrongCenter+'"]').click();await page.waitForFunction(()=>document.querySelector('.skill-livehint')?.textContent==='Essaie encore');assert.equal((await page.locator('.skill-target').textContent()).slice(-2),target);await page.locator('[data-square="'+target+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-score]')?.textContent==='1');
 await checkCenteredTarget();await capture('coordinates-desktop');await page.setViewportSize({width:390,height:844});await checkCenteredTarget();await capture('coordinates-mobile');report.checks.push('Coordinate prompt centered on desktop/mobile, central squares clickable through overlay, wrong answer keeps target');
 await page.locator('[data-coordinate-again]').waitFor({timeout:35000});assert((await api('/api/skills/coordinates/history')).records[0].score===1);report.checks.push('Coordinates: real timed score and account record, both orientations and mobile geometry');
 await page.locator('[data-training-history]').click();await page.locator('dialog.training-history-dialog .training-history-table tbody tr').first().waitFor();assert.equal(await page.locator('dialog.training-history-dialog .training-history-table tbody tr').count(),1);await page.locator('dialog.training-history-dialog [data-training-detail]').first().click();await page.locator('.training-history-detail').waitFor();await page.screenshot({path:join(output,'coordinates-history-mobile.png'),fullPage:true});await page.locator('dialog.training-history-dialog [data-history-dialog-close]').first().click();
 await page.setViewportSize({width:1440,height:1000});await nav('blindfold');await page.locator('[data-custom-set]').waitFor();
 assert.equal(await page.locator('[data-rated-puzzle]').count(),2);assert.equal(await page.locator('[data-blind-setup]').count(),0);
 await page.screenshot({path:join(output,'blindfold-simple-menu-desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'blindfold-simple-menu-mobile.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.setViewportSize({width:1440,height:1000});await page.selectOption('[data-custom-set]','reconstruct');await page.locator('[name=entry_id] option').waitFor({state:'attached'});await page.fill('[name=max_moves]','2');await page.locator('[data-blind-setup] [type=submit]').click();await page.locator('[data-ready]').waitFor();
 assert((await page.locator('.skill-prompt').textContent()).includes('Cf3'));assert(await page.locator('.skill-square-grid').count()===0);await page.locator('[data-ready]').click();await page.locator('.skill-palette').waitFor();assert(await page.locator('.skill-prompt').count()===0);
 await page.locator('[data-piece="K"]').click();await page.locator('[data-square="e1"]').click();await page.locator('[data-piece="k"]').click();await page.locator('[data-square="e8"]').click();await capture('reconstruction-desktop');await page.setViewportSize({width:390,height:844});await capture('reconstruction-mobile');
 await page.locator('[data-verify]').click();await page.locator('.skill-result-banner').waitFor();assert(await page.locator('.skill-comparison').count()===1);assert((await page.locator('.skill-comparison').textContent()).includes('Pièces manquantes'));await page.locator('[data-result-board] [data-b=prev]').click();await capture('reconstruction-result-mobile','[data-result-board] .chess-board');report.checks.push('Reconstruction: first two full moves hidden on ready, editor, comparison and board navigation');
 await page.locator('[data-new]').click();await page.selectOption('[data-custom-set]','opening');await page.locator('[data-blind-setup] [type=submit]').click();await page.locator('[data-ready]').waitFor();await page.locator('[data-ready]').click();await page.locator('.skill-square-grid').waitFor();assert(await page.locator('.skill-square-grid img').count()===0);assert(await page.locator('.skill-prompt').count()===0);
 await capture('blindfold-opening-mobile');await page.locator('[data-square=f1]').click();await page.locator('[data-square=b5]').click();await page.waitForFunction(()=>document.querySelector('.skill-played')?.textContent.includes('a6'));assert(await page.locator('.skill-square-grid img').count()===0);await page.locator('[data-square=b5]').click();await page.locator('[data-square=a4]').click();await page.locator('.skill-palette').waitFor();
 assert.equal(await page.locator('[data-result-board]').count(),0);assert.equal(await page.locator('.skill-prompt').count(),0);assert.equal(await page.locator('.skill-played').count(),0);assert.equal(await page.locator('.skill-square-grid img').count(),0);
 await capture('blindfold-final-reconstruction-mobile');
 const finalPlacement='r1bqkbnr/1ppp1ppp/p1n5/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R',expected={};
 finalPlacement.split('/').forEach((row,rank)=>{let file=0;for(const piece of row){if(/[1-8]/.test(piece))file+=Number(piece);else expected['abcdefgh'[file++]+(8-rank)]=piece;}});
 for(const piece of new Set(Object.values(expected))){await page.locator('[data-piece="'+piece+'"]').click();for(const [square,p] of Object.entries(expected))if(p===piece)await page.locator('[data-square="'+square+'"]').click();}
 await page.locator('[data-verify]').click();await page.locator('.skill-result-banner.success').waitFor();assert.equal(await page.locator('.skill-comparison').count(),1);await capture('blindfold-final-exact-mobile','[data-result-board] .chess-board');
 report.checks.push('Opening blindfold: final solution transitions to an empty reconstruction board without a revealed target; all 32 correctly placed pieces succeed');
 await page.locator('[data-new]').click();await page.selectOption('[data-custom-set]','positions');await page.fill('[name=max_pieces]','32');await page.selectOption('[name=input]','text');await page.uncheck('[name=hide_prompt]');await page.locator('[data-blind-setup] [type=submit]').click();await page.locator('[data-ready]').waitFor();assert((await page.locator('.skill-description').textContent()).includes('roi'));await page.locator('[data-ready]').click();await page.locator('[name=move]').waitFor();assert(await page.locator('.skill-square-grid').count()===0);assert(await page.locator('.skill-description').count()===1);await page.fill('[name=move]','Fb5');await page.locator('[data-blind-answer] [type=submit]').click();await page.waitForFunction(()=>document.querySelector('.skill-played')?.textContent.includes('a6'));await page.fill('[name=move]','Fa4');await page.locator('[data-blind-answer] [type=submit]').click();await page.locator('.skill-palette').waitFor();assert.equal(await page.locator('.skill-description').count(),0);assert.equal(await page.locator('[data-result-board]').count(),0);
 await page.locator('[data-piece="K"]').click();await page.locator('[data-square=e2]').click();await page.locator('[data-verify]').click();await page.locator('.skill-result-banner').waitFor();assert.equal(await page.locator('.skill-result-banner.success').count(),0);assert.match(await page.locator('.skill-comparison').textContent(),/Pièces manquantes/);await page.setViewportSize({width:1440,height:1000});await capture('blindfold-final-incorrect-desktop','[data-result-board] .chess-board');report.checks.push('Endgame blindfold: typed answers followed by hidden description, reconstruction errors and separate move/position outcomes');
 const original=await api('/api/entries/'+fixture.entry_id);assert(original.pgn.includes('1. e4'));assert.equal((await api('/api/skills/blindfold/history')).history.length,3);await page.locator('[data-training-history]').click();await page.locator('dialog.training-history-dialog .training-history-table tbody tr').first().waitFor();assert.equal(await page.locator('dialog.training-history-dialog .training-history-table tbody tr').count(),3);await page.locator('dialog.training-history-dialog [data-training-detail]').first().click();await page.locator('.training-history-detail').waitFor();await page.screenshot({path:join(output,'blindfold-history-desktop.png'),fullPage:true});assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);
 const {checkRatedBlindfold}=await import('./blindfold_rated_browser.mjs');await checkRatedBlindfold({page,api,nav,capture,output,report});
 report.status='passed';console.log(JSON.stringify(report));
}finally{report.debug=await page.evaluate(()=>({coordinate:window.coordinateDebug,notices:document.querySelector('#notices')?.textContent,body:document.body.innerText.slice(0,1500)}));await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();}
