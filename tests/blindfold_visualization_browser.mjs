import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url);
const {chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const browser=await chromium.launch({executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,args:['--no-first-run','--disable-extensions']});
const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();
const report={checks:[],geometry:[],errors:[],external:[]};
page.setDefaultTimeout(12000);
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('request',request=>{if(!request.url().startsWith(url)&&!request.url().startsWith('data:'))report.external.push(request.url());});

async function api(path,method='GET',data){
 const response=await context.request.fetch(url+path,{method,data,headers:{Origin:url}});
 assert(response.ok(),await response.text());return response.json();
}
async function nav(){
 await page.goto(url+'/#/blindfold');
 await page.locator('.training-skill-view').waitFor();
}
async function active(){return (await api('/api/skills/blindfold/overview')).active_session;}
async function reload(){await page.reload();await page.locator('.training-skill-view').waitFor();}
async function customize(mode){
 await page.locator('[data-training-settings]').click();
 const dialog=page.locator('.training-settings-dialog');
 await dialog.locator('[name=mode]').selectOption(mode);
 await dialog.locator('[name=rated]').uncheck();
 await dialog.locator('[name=rating_min]').fill('1400');
 await dialog.locator('[name=rating_max]').fill('1400');
 if(mode==='positions')await dialog.locator('[name=max_pieces]').fill('32');
 else await dialog.locator('[name=max_moves]').fill('10');
 await dialog.locator('[name=hide_prompt]').check();
 await dialog.locator('[name=reconstruct_after]').check();
 await dialog.locator('[name=input]').selectOption('text');
 await dialog.locator('[type=submit]').click();
 await page.locator('[data-start-custom]').click();
 await page.locator('[data-ready]').waitFor();
}
async function capture(name){
 await page.evaluate(()=>new Promise(resolve=>{window.scrollTo(0,0);requestAnimationFrame(()=>requestAnimationFrame(resolve));}));
 await page.screenshot({path:join(output,name+'.png'),fullPage:true});
 const geometry=await page.locator('.skill-stage').evaluate(stage=>{
  const rect=stage.getBoundingClientRect();
  return {left:rect.left,right:rect.right,width:rect.width,viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth};
 });
 report.geometry.push({name,...geometry});
 assert(geometry.scrollWidth<=geometry.viewport+1,`${name}: no page overflow`);
 assert(geometry.left>=-1&&geometry.right<=geometry.viewport+1,`${name}: stage fits viewport`);
 const overflowing=await page.locator('.skill-piece-group').evaluateAll(groups=>groups.filter(group=>group.scrollWidth>group.clientWidth+1).map(group=>group.textContent));
 assert.deepEqual(overflowing,[],`${name}: grouped lists wrap within their rows`);
}
async function assertGroups(){
 const session=await active(),position=session.prompt.position;
 assert.equal(session.puzzle_id,'abc12');
 const groups=await page.locator('.skill-description .skill-piece-group').evaluateAll(rows=>rows.map(row=>({
  text:row.textContent,images:[...row.querySelectorAll('img')].map(img=>({src:img.getAttribute('src'),alt:img.alt,loaded:img.complete&&img.naturalWidth>0}))
 })));
 const expected=[];
 for(const color of ['white','black']){
  for(const piece of new Set(position[color].map(item=>item.piece))){
   expected.push({piece,src:`/static/pieces/${color==='white'?'w':'b'}${piece.toUpperCase()}.svg`,
    squares:position[color].filter(item=>item.piece===piece).map(item=>item.square).sort()});
  }
 }
 assert.equal(groups.length,expected.length,'one row per piece type and color');
 for(const group of expected){
  const found=groups.filter(row=>row.images.some(img=>img.src===group.src));
  assert.equal(found.length,1,`one icon group for ${group.piece}`);
  assert.equal(found[0].images.length,1,'one image in each group');
  assert(found[0].images[0].loaded,`loaded ${group.src}`);
  assert(found[0].images[0].alt.trim(),'piece icons have accessible labels');
  assert.deepEqual((found[0].text.match(/[a-h][1-8]/g)||[]).sort(),group.squares);
 }
 assert.equal(expected.find(group=>group.piece==='P').squares.length,8);
 assert.equal(expected.find(group=>group.piece==='p').squares.length,8);
 report.groups=groups;
}
function seconds(text){
 const value=text.match(/\d+(?::\d+)?(?:[.,]\d+)?/)[0];
 return value.includes(':')?value.split(':').reduce((total,n)=>total*60+Number(n),0):Number(value.replace(',','.'));
}
async function play(move){
 await page.locator('[name=move]').fill(move);
 await page.locator('[data-blind-answer] [type=submit]').click();
}

try{
 await api('/api/setup-resources/complete','POST',{});
 await nav();
 await customize('positions');
 await page.locator('.skill-description img').first().waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.skill-description img')].every(img=>img.complete&&img.naturalWidth>0));
 await assertGroups();
 assert.match(await page.locator('.skill-description').textContent(),/Blancs/);
 assert.match(await page.locator('.skill-description').textContent(),/Noirs/);
 await capture('positions-grouped-desktop-fr');
 await page.setViewportSize({width:390,height:844});await capture('positions-grouped-mobile-fr');
 report.checks.push('Positions group all 32 pieces into 12 type/color rows, one correct loaded icon per group, all squares retained, no repeated pawn icon');

 await api('/api/preferences','PATCH',{language:'en'});await reload();
 await page.locator('.skill-description').waitFor();
 await assertGroups();
 assert.match(await page.locator('.skill-description').textContent(),/White/);
 assert.match(await page.locator('.skill-description').textContent(),/Black/);
 await capture('positions-grouped-mobile-en');
 report.checks.push('Grouped position labels and icon accessibility verified in English');
 await page.locator('[data-new]').click();await page.locator('[data-start-custom]').waitFor();
 await api('/api/preferences','PATCH',{language:'fr'});await reload();
 await page.setViewportSize({width:1440,height:1000});await customize('opening');
 assert.match(await page.locator('.skill-prompt').textContent(),/Cf3/);
 const clock=page.locator('[data-preparation-clock]');await clock.waitFor();
 const startClock=seconds(await clock.textContent()),sessionBefore=await active();
 await page.waitForFunction(initial=>{
  const text=document.querySelector('[data-preparation-clock]')?.textContent;
  return text&&text!==initial;
 },await clock.textContent());
 await page.waitForTimeout(1100);
 const advancedClock=seconds(await clock.textContent());
 assert(advancedClock>startClock,'visualization clock advances before ready');
 await capture('opening-visualization-desktop-fr');
 await reload();await clock.waitFor();
 const resumedClock=seconds(await clock.textContent()),resumed=await active();
 assert.equal(resumed.id,sessionBefore.id);
 assert(resumedClock>=advancedClock,'reload preserves visualization time');
 assert(resumed.preparation_ms>sessionBefore.preparation_ms);
 await page.locator('[data-ready]').click();await page.locator('[name=move]').waitFor();
 assert.equal(await page.locator('.skill-prompt').count(),0,'ready hides the move prompt');
 const ready=await active(),frozenClock=await clock.textContent();
 await page.waitForTimeout(1300);
 assert.equal(await clock.textContent(),frozenClock,'visualization clock freezes after ready');
 assert.equal((await active()).preparation_ms,ready.preparation_ms,'server preparation time freezes after ready');
 await page.setViewportSize({width:390,height:844});await capture('opening-ready-mobile-fr');
 await play('Fb5');await page.waitForFunction(()=>document.querySelector('.skill-played')?.textContent.includes('a6'));
 await play('Fa4');await page.locator('.skill-palette').waitFor();
 assert.equal(await clock.textContent(),frozenClock,'visualization time remains frozen during reconstruction');
 assert.equal(await page.locator('.skill-prompt').count(),0);
 const expected={};
 'r1bqkbnr/1ppp1ppp/p1n5/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R'.split('/').forEach((row,rank)=>{let file=0;for(const piece of row){if(/[1-8]/.test(piece))file+=Number(piece);else expected['abcdefgh'[file++]+(8-rank)]=piece;}});
 for(const piece of new Set(Object.values(expected))){
  await page.locator(`[data-piece="${piece}"]`).click();
  for(const [square,p] of Object.entries(expected))if(p===piece)await page.locator(`[data-square="${square}"]`).click();
 }
 await page.locator('[data-verify]').click();await page.locator('.skill-result-banner.success').waitFor();
 const complete=await api('/api/skills/blindfold/'+ready.id),result=complete.result;
 assert.equal(result.preparation_ms,ready.preparation_ms);
 assert(result.preparation_ms>=2000,'nonzero visualization time recorded');
 assert(result.elapsed_ms>0);
 const preparationResult=page.locator('[data-preparation-time]');await preparationResult.waitFor();
 assert.equal(seconds(await preparationResult.textContent()),Math.round(result.preparation_ms/1000));
 assert.match(await page.locator('.skill-result-banner').textContent(),/Temps total/);
 assert.equal(seconds(await page.locator('[data-total-time]').textContent()),Math.round((result.preparation_ms+result.elapsed_ms)/1000),'result total includes visualization and active exercise');
 report.timing={startClock,advancedClock,resumedClock,frozenClock,preparation_ms:result.preparation_ms,elapsed_ms:result.elapsed_ms};
 await capture('opening-result-mobile-fr');
 await page.setViewportSize({width:1440,height:1000});await capture('opening-result-desktop-fr');
 report.checks.push('Opening visualization timer advances, survives reload, freezes at ready and throughout reconstruction, and result includes visualization and total time');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);
 report.status='passed';console.log(JSON.stringify(report));
}catch(error){
 report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;
}finally{
 report.body=await page.locator('body').innerText();
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();
}
