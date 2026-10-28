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
const report={checks:[],errors:[]};page.setDefaultTimeout(12000);
page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function api(path,method='GET',data){const response=await context.request.fetch(url+path,{method,data,headers:{Origin:url}});assert(response.ok(),await response.text());return response.json();}
async function openPuzzles(){
 await page.locator('[data-page="exercises"]').first().evaluate(button=>button.click());
 await page.locator('[data-exercise-page="puzzles"]').click();
}
async function play(uci){
 const pending=page.waitForResponse(response=>response.request().method()==='POST'&&/\/attempts\/[^/]+\/move$/.test(new URL(response.url()).pathname));
 await page.locator('[data-puzzle-board] [data-square="'+uci.slice(0,2)+'"]').click();
 await page.locator('[data-puzzle-board] [data-square="'+uci.slice(2,4)+'"]').click();
 const response=await pending;assert(response.ok(),await response.text());const result=await response.json();
 await page.waitForFunction(combo=>document.querySelector('.puzzle-storm-score')?.textContent.includes('Combo '+combo),result.storm.combo);
 return result;
}
async function capture(name){
 await page.screenshot({path:join(output,name+'.png'),fullPage:true});
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 const geometry=await page.locator('[data-puzzle-board]').evaluate(board=>{const r=board.getBoundingClientRect(),t=document.querySelector('[data-timer]').getBoundingClientRect();return {boardBottom:r.bottom,timerTop:t.top};});
 assert(geometry.timerTop>=geometry.boardBottom-1);
}
try{
 await api('/api/setup-resources/complete','POST',{});
 await page.goto(url);
 await page.getByRole('button',{name:'Continuer vers ma bibliothèque'}).click();
 await openPuzzles();
 await page.locator('[data-mode="storm"]').click();
 await page.locator('[data-filters] [type="submit"]').click();
 await page.locator('[data-storm-combo]').waitFor();
 assert.match(await page.locator('[data-storm-combo]').textContent(),/5 coups.*\+3 s/);
 assert.equal(await page.locator('[data-timer]').textContent(),'3:00');
 const current=(await api('/api/puzzles/history')).attempts[0];
 const initial=await api('/api/puzzles/storm/'+(await api('/api/puzzles/attempts/'+current.id)).session_id);
 assert(initial.attempt.rating>=1000&&initial.attempt.rating<1100);
 const moves=initial.attempt.color==='black'?['e7e5','b8c6']:['g1f3','f1b5'];
 let result;
 for(let index=0;index<5;index++)result=await play(moves[index%2]);
 assert.equal(result.storm.time_delta_seconds,3);assert.equal(result.storm.combo,5);assert.equal(result.storm.score,2);
 assert.match(await page.locator('[data-storm-combo]').textContent(),/7 coups.*\+5 s/);
 assert.equal(await page.locator('[data-time-delta]').textContent(),'+3 s');
 assert(await page.locator('[data-time-delta]').isVisible());
 assert(result.storm.deadline_ms>=result.storm.started_ms+183000);
 assert(result.storm.deadline_ms<result.storm.started_ms+183100); // Server selection time is credited separately.
 await capture('storm-bonus-desktop');report.checks.push('Fifth player move adds 3 seconds, opponent replies do not count, next bonus at 12');
 await page.setViewportSize({width:390,height:844});await capture('storm-combo-mobile');
 const wrong=initial.attempt.color==='black'?'a7a6':'a2a3';
 const failed=await play(wrong);
 assert.equal(failed.storm.time_delta_seconds,-10);assert.equal(failed.storm.combo,0);
 assert(failed.storm.deadline_ms>=result.storm.deadline_ms-10000);
 assert(failed.storm.deadline_ms<result.storm.deadline_ms-9900);
 assert.match(await page.locator('[data-storm-combo]').textContent(),/5 coups.*\+3 s/);
 assert.equal(await page.locator('[data-time-delta]').textContent(),'−10 s');
 await capture('storm-penalty-mobile');report.checks.push('Mistake removes 10 seconds and resets combo progress on mobile');
 await page.reload();await openPuzzles();
 // Restore through the same history route used by the app after reloading.
 await page.locator('[data-tab="history"]').click();
 await page.locator('[data-list-search-menu]>summary').click();
 await page.locator('[data-training-filter="tool"]').selectOption('storm');
 await page.locator('[data-training-open]').first().click();
 await page.locator('[data-storm-combo]').waitFor();
 assert.match(await page.locator('[data-storm-combo]').textContent(),/5 coups.*\+3 s/);
 assert(!await page.locator('[data-time-delta]').isVisible());
 report.checks.push('Reload restores combo without replaying the time notification');
 const html=await page.evaluate(async()=>{
  const {setLanguage}=await import('/static/i18n.js');setLanguage('en');
  const {stormComboHtml}=await import('/static/storm-combo.js');
  return stormComboHtml({combo_progress:{moves:6,target:7,remaining:1,seconds:5}});
 });
 assert.match(html,/Bonus in 1 move: \+5 s/);
 assert.deepEqual(report.errors,[]);report.status='passed';console.log(JSON.stringify(report));
}finally{
 report.body=await page.locator('body').innerText().catch(()=> '');
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();
}
