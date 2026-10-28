import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url);
const {chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const report={checks:[],errors:[],geometry:[],stormTransitions:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(String(e)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function json(path,method='GET',data){const r=await context.request.fetch(url+path,{method,...(data?{data}:{})});assert(r.ok(),await r.text());return r.json();}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function play(uci){await page.locator('[data-puzzle-board] [data-square="'+uci.slice(0,2)+'"]').click();await page.locator('[data-puzzle-board] [data-square="'+uci.slice(2,4)+'"]').click();}
async function latestAttempt(){const row=(await json('/api/puzzles/history')).attempts[0];assert(row);return json('/api/puzzles/attempts/'+row.id);}
async function immediateStormTransition(uci,state){
 const requests=[],record=request=>requests.push({path:new URL(request.url()).pathname,method:request.method()});page.on('request',record);
 try{
  const responseReady=page.waitForResponse(response=>response.request().method()==='POST'&&/\/api\/puzzles\/attempts\/[^/]+\/move$/.test(new URL(response.url()).pathname)).then(response=>({response,receivedAt:performance.now()}));
  await play(uci);const {response,receivedAt}=await responseReady,result=await response.json();
  assert.equal(response.request().postDataJSON().advance_storm,true);assert.equal(result.attempt.status,state==='success'?'completed':'revealed');assert.equal(result.next_attempt.status,'active');assert.equal(result.storm.current_attempt,result.next_attempt.id);assert(result.next_attempt.legal.moves.length);
  await page.locator('[data-storm-last-result][data-state="'+state+'"]').waitFor();
  await page.waitForFunction(()=>!!document.querySelector('[data-puzzle-board] .chess-board')&&!document.querySelector('[data-puzzle-board] .square:disabled')&&document.querySelector('.puzzle-feedback')?.dataset.state==='active');
  const readyMs=performance.now()-receivedAt;report.stormTransitions.push({state,readyMs:Math.round(readyMs),attempt:result.next_attempt.id});assert(readyMs<500,'next Storm board should be ready within 500 ms of its response, got '+readyMs);
  assert.equal(await page.locator('.puzzle-feedback:not([data-state="active"])').count(),0);assert.equal(await page.locator('[data-next]').count(),0);
  // The supplied legal moves must already work: selecting a piece immediately
  // paints a legal destination, without another legal-move network round trip.
  const first=result.next_attempt.legal.moves[0],source=page.locator('[data-puzzle-board] [data-square="'+first.slice(0,2)+'"]');
  await source.click();await page.locator('[data-puzzle-board] [data-square="'+first.slice(2,4)+'"] .legal-dot').waitFor();await source.click();
  assert(!requests.some(request=>request.method==='POST'&&/\/storm\/[^/]+\/next$/.test(request.path)),JSON.stringify(requests));
  assert(!requests.some(request=>request.path==='/api/legal'),JSON.stringify(requests));
  return result;
 }finally{page.off('request',record);}
}
async function compactNavigation(language){
 const buttons=page.locator('.puzzle-header nav.tabs>button');assert.equal(await buttons.count(),4);
 const labels=(await buttons.allTextContents()).map(text=>text.replace('⚙','').trim());assert.deepEqual(labels,language==='en'?['Play','History','Statistics','Settings']:['Jouer','Historique','Statistiques','Réglages']);
 assert(await page.locator('.puzzle-header nav.tabs [data-puzzle-settings]').isVisible());
 const boxes=await buttons.evaluateAll(items=>items.map(item=>{const r=item.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};}));assert(Math.max(...boxes.map(r=>r.y))-Math.min(...boxes.map(r=>r.y))<=1);assert(Math.max(...boxes.map(r=>r.h))-Math.min(...boxes.map(r=>r.h))<=1);
 assert.equal(await page.locator('.puzzle-compact-status,.puzzle-result-badge').count(),0);assert.equal(await page.locator('.puzzle-attempt-panel>header [data-exit]').count(),1);
 assert(await page.locator('[data-puzzle-board]').evaluate(element=>element===element.parentElement.firstElementChild));
 await page.evaluate(()=>window.puzzleNavigationBoard=document.querySelector('[data-puzzle-board] .chess-board'));
 await page.locator('[data-puzzle-settings]').click();await page.locator('#modal .puzzle-copy-settings').waitFor();assert(await page.locator('#modal [name="enabled"]').isVisible());await page.locator('#modal [data-close]').first().click();await page.locator('#modal').waitFor({state:'hidden'});
 assert(await page.evaluate(()=>window.puzzleNavigationBoard===document.querySelector('[data-puzzle-board] .chess-board')));
}
async function timerBelowBoard(){
 const geometry=await page.locator('.puzzle-storm-timer [data-timer]').evaluate(timer=>{const r=timer.getBoundingClientRect(),b=document.querySelector('[data-puzzle-board]').getBoundingClientRect();return{top:r.top,center:r.x+r.width/2,boardBottom:b.bottom,boardCenter:b.x+b.width/2,fontSize:parseFloat(getComputedStyle(timer).fontSize)};});
 assert(geometry.top>=geometry.boardBottom-1);assert(Math.abs(geometry.center-geometry.boardCenter)<=2);assert(geometry.fontSize>=24);
}
async function finalPosition(){await page.locator('[data-solution] .current .analysis-move-san').filter({hasText:'Nc6'}).waitFor();assert.equal(await page.locator('[data-puzzle-board] [data-square="b8"] img').count(),0);assert.equal(await page.locator('[data-puzzle-board] [data-square="c6"] img').count(),1);}
async function screenshot(name){await page.locator('#notices .notice').last().waitFor({state:'hidden'});await page.screenshot({path:join(output,name+'.png'),fullPage:!await page.locator('dialog[open]').count()});const g=await page.evaluate(()=>{const r=document.querySelector('[data-puzzle-board] .chess-board')?.getBoundingClientRect();return {width:innerWidth,scroll:document.documentElement.scrollWidth,board:r?{x:r.x,y:r.y,width:r.width,height:r.height}:null};});report.geometry.push({name,...g});assert(g.scroll<=g.width+1);if(g.board){assert(Math.abs(g.board.width-g.board.height)<2);assert(g.board.x>=-1&&g.board.x+g.board.width<=g.width+1);}}
try{
 await json('/api/setup-resources/complete','POST',{});await page.goto(url);
 await page.locator('.navigation-group summary').filter({hasText:'Entraînement'}).click();await page.locator('.top-nav [data-page="puzzles"]').click();
 await check('Standard and custom sets, saved filters',async()=>{await page.locator('[data-filters]').waitFor();assert.equal(await page.locator('[name="selection"]').inputValue(),'standard');assert.equal(await page.locator('[data-custom-filters]').count(),0);await page.locator('[name="selection"]').selectOption('custom');await page.locator('[name="color"]').selectOption('black');await page.locator('[name="rating_min"]').fill('1400');await page.locator('[name="rating_max"]').fill('1600');await page.locator('[data-save-set]').click();await page.locator('#modal [name="name"]').fill('My forks');await page.locator('#modal [type="submit"]').click();await page.locator('#modal').waitFor({state:'hidden'});await page.locator('[name="selection"]').selectOption('standard');assert.equal(await page.locator('[data-custom-filters]').count(),0);await page.locator('[name="selection"]').selectOption({label:'My forks'});assert.equal(await page.locator('[name="color"]').inputValue(),'black');await screenshot('desktop-setup');});
 await check('Settings during a puzzle preserve position and copy errors once',async()=>{
  await page.locator('[data-filters] [type="submit"]').click();await page.locator('[data-puzzle-board] .chess-board').waitFor();
  await page.locator('[data-puzzle-settings]').click();await page.locator('#modal [name="enabled"]').check();await page.locator('#modal [name="base"]').selectOption({label:'Puzzle failures'});await screenshot('desktop-settings');await page.locator('#modal [type="submit"]').click();await page.locator('#modal').waitFor({state:'hidden'});
  assert.equal((await json('/api/puzzles/overview')).profile.settings.auto_copy_base_id,1);
  await play('d7d5');await page.getByText('Ce n’est pas la solution. Réessaie.',{exact:true}).waitFor();await page.locator('[data-copied-notice]:visible').waitFor();await play('e7e5');await page.getByText('Bien joué !',{exact:true}).waitFor();
  const before=(await json('/api/puzzles/overview')).active;assert(before.copied_entry_id);
  await page.evaluate(()=>window.puzzleBoardBeforeSettings=document.querySelector('[data-puzzle-board] .chess-board'));
  await page.locator('[data-puzzle-settings]').click();await page.locator('#modal [name="enabled"]').uncheck();await page.locator('#modal [type="submit"]').click();await page.locator('#modal').waitFor({state:'hidden'});
  assert(await page.evaluate(()=>window.puzzleBoardBeforeSettings===document.querySelector('[data-puzzle-board] .chess-board')));const after=(await json('/api/puzzles/overview')).active;assert.equal(after.version,before.version);assert.deepEqual(after.positions,before.positions);assert.equal(after.copied_entry_id,before.copied_entry_id);
  await page.locator('[data-puzzle-settings]').click();await page.locator('#modal [name="enabled"]').check();await page.locator('#modal [type="submit"]').click();await page.locator('#modal').waitFor({state:'hidden'});assert.equal((await json('/api/puzzles/overview')).active.copied_entry_id,before.copied_entry_id);
  await play('b8c6');await page.locator('[data-next]').waitFor();assert.equal(await page.locator('.puzzle-feedback').getAttribute('data-state'),'errors');assert.match(await page.locator('.puzzle-feedback').textContent(),/retravailler/);assert.equal((await json('/api/puzzles/overview')).profile.rated_count,1);await finalPosition();await screenshot('desktop-completed');
 });
 await check('Successful puzzle has green check and keeps final position',async()=>{await page.locator('[data-next]').click();await page.locator('.puzzle-feedback[data-state="active"]').waitFor();await play('e7e5');await page.getByText('Bien joué !',{exact:true}).waitFor();await play('b8c6');await page.locator('.puzzle-feedback[data-state="success"]').waitFor();assert.match(await page.locator('.puzzle-feedback').textContent(),/✓.*Réussi/);assert.equal(await page.locator('.puzzle-feedback').getAttribute('role'),'status');await finalPosition();await screenshot('desktop-success');assert.equal((await json('/api/puzzles/overview')).profile.rated_count,2);});
 await check('History includes wrong moves and solution navigation',async()=>{await page.locator('[data-tab="history"]').click();await page.locator('[data-training-filter="outcome"]').selectOption('failure');await page.locator('[data-training-open]').first().click();await page.locator('.puzzle-event-list').waitFor();assert.match(await page.locator('.puzzle-event-list').textContent(),/d5/);await finalPosition();await page.locator('[data-solution] [data-path]').first().click();await screenshot('desktop-history-detail');});
 await check('Exercise draft uses exact puzzle moves and preserves the explored board',async()=>{
  await page.locator('[data-solution] .analysis-move-san').filter({hasText:'Nc6'}).click();await finalPosition();await play('d2d4');await page.locator('[data-solution] .current .analysis-move-san').filter({hasText:'d4'}).waitFor();
  const before=(await json('/api/bases/1/entries')).entries.length;
  await page.evaluate(()=>window.exerciseSourceBoard=document.querySelector('[data-puzzle-board] .chess-board'));
  await page.locator('[data-create-exercise]').click();await page.locator('.exercise-editor-dialog[open]').waitFor();
  const moves=await page.locator('[data-exercise-moves] .analysis-move-san').allTextContents();assert.deepEqual(moves.map(move=>move.replace(/^⚑/,'')),['e5','Nf3','Nc6']);assert.equal(await page.locator('[data-exercise-board] [data-square="e7"] img').count(),1);assert.equal(await page.locator('[data-exercise-board] [data-square="b8"] img').count(),1);
  await screenshot('desktop-puzzle-exercise');await page.locator('.exercise-editor-dialog [data-exercise-action="close"]').first().click();assert.equal((await json('/api/bases/1/entries')).entries.length,before);assert(await page.evaluate(()=>window.exerciseSourceBoard===document.querySelector('[data-puzzle-board] .chess-board')));
  await page.locator('[data-create-exercise]').click();await page.locator('.exercise-editor-dialog [name="title"]').fill('Manual puzzle exact');await page.locator('.exercise-editor-dialog [name="base_id"]').selectOption('1');await page.locator('[data-exercise-action="save"]').click();await page.locator('.exercise-editor-dialog').waitFor({state:'detached'});
  const entries=(await json('/api/bases/1/entries')).entries;assert.equal(entries.length,before+1);const entry=await json('/api/entries/'+entries.find(e=>e.title==='Manual puzzle exact').id);const doc=await json('/api/board','POST',{pgn:entry.pgn});assert.deepEqual(doc.nodes.filter(n=>n.uci).map(n=>n.uci),['e7e5','g1f3','b8c6']);assert.equal(doc.nodes[0].fen.split(' ')[1],'b');assert(doc.headers.PuzzleId?.startsWith('Black'));
  assert(await page.evaluate(()=>window.exerciseSourceBoard===document.querySelector('[data-puzzle-board] .chess-board')));await page.locator('[data-solution] .current .analysis-move-san').filter({hasText:'d4'}).waitFor();await page.locator('[data-solution] .analysis-move-san').filter({hasText:'Nc6'}).click();
 });
 await check('Statistics and mobile geometry',async()=>{await page.locator('[data-tab="stats"]').click();await page.locator('.puzzle-rating-chart').waitFor();await page.setViewportSize({width:390,height:844});await screenshot('mobile-statistics');await page.locator('[data-tab="play"]').click();await page.locator('[data-puzzle-board]').waitFor();await finalPosition();await screenshot('mobile-completed');});
 await check('Custom Storm uses saved filters and separates records',async()=>{await page.locator('[data-exit]').click();await page.locator('[data-mode="storm"]').click();assert.equal(await page.locator('[name="selection"] option:checked').textContent(),'My forks');await screenshot('mobile-custom-storm-setup');await page.locator('[data-start]').click();await page.locator('[data-timer]').waitFor();assert.match(await page.locator('.puzzle-attempt-panel>header').textContent(),/My forks/);const attempt=await latestAttempt();assert.equal(attempt.color,'black');assert.equal(attempt.rating,1500);await play('e7e5');await page.getByText('Bien joué !',{exact:true}).waitFor();await play('b8c6');await page.waitForFunction(()=>document.querySelector('.puzzle-storm-score>strong')?.textContent==='1');await page.locator('[data-exit]').click();await page.locator('[name="selection"]').selectOption('standard');});
 let clockStorm,clockAttempt,firstStormMove,secondStormMove;
 await check('Storm stays at 3:00 before a move, including a single piece-selection click',async()=>{
  await page.locator('[data-start]').click();await page.locator('[data-timer]').waitFor();
  const d0=await json('/api/puzzles/overview');assert.equal(d0.storm.best,0);assert.equal(d0.storm.records.find(r=>r.name==='My forks').best,1);
  const row=(await json('/api/puzzles/history')).attempts[0];clockAttempt=await json('/api/puzzles/attempts/'+row.id);clockStorm=clockAttempt.session_id;assert(clockStorm);
  const white=clockAttempt.color==='white';firstStormMove=white?'g1f3':'e7e5';secondStormMove=white?'f1b5':'b8c6';
  async function untouchedClock(){const state=await json('/api/puzzles/storm/'+clockStorm);assert.equal(state.storm.clock_started,false);assert.equal(state.storm.remaining_ms,180000);assert.equal(state.attempt.version,clockAttempt.version);assert.equal(await page.locator('[data-timer]').textContent(),'3:00');}
  await untouchedClock();await timerBelowBoard();await screenshot('mobile-storm-ready');
  await page.setViewportSize({width:1440,height:900});await timerBelowBoard();await screenshot('desktop-storm-ready');await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(1300);await untouchedClock();
  await page.locator('[data-puzzle-board] [data-square="'+firstStormMove.slice(0,2)+'"]').click();await page.waitForTimeout(1300);await untouchedClock();
 });
 await check('The first legal Storm move starts the clock and the next puzzle does not reset it',async()=>{
  // The source piece is already selected: only the destination commits the move.
  await page.locator('[data-puzzle-board] [data-square="'+firstStormMove.slice(2,4)+'"]').click();await page.getByText('Bien joué !',{exact:true}).waitFor();
  const first=(await json('/api/puzzles/storm/'+clockStorm)).storm;assert.equal(first.clock_started,true);assert(first.remaining_ms<=180000&&first.remaining_ms>175000);
  await page.waitForTimeout(1300);const elapsed=(await json('/api/puzzles/storm/'+clockStorm)).storm;assert.equal(elapsed.clock_started,true);assert(elapsed.remaining_ms<first.remaining_ms-1000);assert.notEqual(await page.locator('[data-timer]').textContent(),'3:00');
  await immediateStormTransition(secondStormMove,'success');await page.waitForFunction(()=>document.querySelector('.puzzle-storm-score>strong')?.textContent==='1');
  const next=await json('/api/puzzles/storm/'+clockStorm);assert.equal(next.storm.clock_started,true);assert.equal(next.storm.deadline_ms,first.deadline_ms);assert.notEqual(next.attempt.id,clockAttempt.id);assert(next.storm.remaining_ms<elapsed.remaining_ms);assert.notEqual(await page.locator('[data-timer]').textContent(),'3:00');
 });
 await check('History cannot hide the board while a Storm timer is running',async()=>{
  const before=await json('/api/puzzles/storm/'+clockStorm);
  assert(await page.locator('[data-tab="history"]').isDisabled());assert(await page.locator('[data-tab="stats"]').isDisabled());await page.waitForTimeout(1300);
  const after=await json('/api/puzzles/storm/'+clockStorm);assert.equal(after.storm.clock_started,true);assert.equal(after.storm.deadline_ms,before.storm.deadline_ms);assert(after.storm.remaining_ms<before.storm.remaining_ms-1000);assert.equal(after.attempt.id,before.attempt.id);assert.equal(await page.locator('.puzzle-feedback').getAttribute('data-state'),'active');assert.notEqual(await page.locator('[data-timer]').textContent(),'3:00');
  await screenshot('mobile-storm');assert.equal((await json('/api/puzzles/overview')).profile.rated_count,2);
 });
 await check('Storm mistakes copy to their own base and can become exact exercise drafts',async()=>{
  await page.locator('.puzzle-feedback[data-state="active"]').waitFor();await page.locator('[data-puzzle-settings]').click();assert(!await page.locator('#modal [name="storm_enabled"]').isChecked());await page.locator('#modal [name="storm_enabled"]').check();await page.locator('#modal [name="storm_base"]').selectOption('2');await screenshot('mobile-storm-copy-settings');await page.locator('#modal [type="submit"]').click();await page.locator('#modal').waitFor({state:'hidden'});
  const settings=(await json('/api/puzzles/overview')).profile.settings;assert.equal(settings.auto_copy_base_id,1);assert.equal(settings.storm_auto_copy_base_id,2);
  const current=await latestAttempt(),result=await immediateStormTransition(current.color==='white'?'f1c4':'d7d5','errors');assert.equal(result.attempt.id,current.id);assert.match(await page.locator('[data-storm-last-result]').textContent(),/Puzzle précédent : manqué.*Déjà copié/s);await json('/__test/storm/'+current.session_id+'/expire','POST',{});const expiredNext=await latestAttempt();await play(expiredNext.color==='white'?'g1f3':'e7e5');await page.locator('.storm-results').waitFor();await page.locator('[data-storm-review="'+current.id+'"]').click();await page.locator('.puzzle-event-list').waitFor();const detail=await json('/api/puzzles/attempts/'+current.id);assert.equal(detail.mode,'storm');assert(detail.copied_entry_id);assert.equal((await json('/api/entries/'+detail.copied_entry_id)).base_id,2);
  await page.locator('[data-create-exercise]').click();await page.locator('.exercise-editor-dialog[open]').waitFor();assert.equal(await page.locator('.exercise-editor-dialog [name="base_id"]').inputValue(),'2');assert.equal(await page.locator('[data-exercise-moves] .analysis-move-san').count(),detail.solution.length);await screenshot('mobile-storm-exercise');await page.locator('.exercise-editor-dialog [name="title"]').fill('Manual Storm exact');await page.locator('[data-exercise-action="save"]').click();await page.locator('.exercise-editor-dialog').waitFor({state:'detached'});const saved=(await json('/api/bases/2/entries')).entries.find(e=>e.title==='Manual Storm exact');assert(saved);const savedDoc=await json('/api/entries/'+saved.id);const solutionDoc=await json('/api/board','POST',{pgn:savedDoc.pgn});assert.deepEqual(solutionDoc.nodes.filter(n=>n.uci).map(n=>n.uci),detail.solution);assert.equal((await json('/api/puzzles/overview')).profile.rated_count,2);
 });
 await check('A delayed final Storm response cannot replace History or Return, and Play resumes the server puzzle',async()=>{
  async function startFresh(){
   if(await page.locator('[data-exit]').count()){const summary=(await page.locator('[data-exit]').textContent()).includes('Bilan');await page.locator('[data-exit]').click();if(summary)await page.locator('.storm-results').waitFor();}
   if(await page.locator('.storm-results [data-home]').count())await page.locator('.storm-results [data-home]').click();
   await page.locator('[data-mode="storm"]').click();await page.locator('[data-start]').click();await page.locator('[data-timer]').waitFor();
   return latestAttempt();
  }
  for(const destination of ['history','return']){
   const current=await startFresh(),pattern=url+'/api/puzzles/attempts/'+current.id+'/move';
   let serverReady,release;const ready=new Promise(resolve=>{serverReady=resolve;}),held=new Promise(resolve=>{release=resolve;});
   await page.route(pattern,async route=>{const response=await route.fetch(),body=await response.json();serverReady(body);await held;await route.fulfill({response});});
   try{
    const delivered=page.waitForResponse(pattern);
    await play(current.color==='white'?'f1c4':'d7d5');const result=await ready;assert(result.next_attempt);assert.notEqual(result.next_attempt.id,current.id);
    if(destination==='history'){await page.locator('[data-exit]').click();await page.locator('[data-tab="history"]').click();await page.locator('[data-training-filter="tool"]').waitFor();}
    else{await page.locator('[data-exit]').click();await page.locator('[data-start]').waitFor();}
    const before=(await json('/api/puzzles/history')).total;release();await (await delivered).finished();
    // Allow the browser to consume the delivered response and paint a frame.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal((await json('/api/puzzles/history')).total,before);
    assert.equal(await page.locator('[data-puzzle-board]').count(),0);
    assert(await page.locator(destination==='history'?'.training-history-filters':'[data-start]').isVisible());
    if(destination==='history'){
     await page.locator('[data-training-filter="tool"]').selectOption('storm');await page.locator('[data-training-open]').first().waitFor();await page.locator('[data-training-open]').first().click();await page.locator('.puzzle-feedback[data-state="active"]').waitFor();
     const restored=await json('/api/puzzles/storm/'+current.session_id);assert.equal(restored.attempt.id,result.next_attempt.id);assert.equal(restored.attempt.version,0);assert.equal((await json('/api/puzzles/history')).total,before);assert.equal(await page.locator('[data-next]').count(),0);
    }
   }finally{release();await page.unroute(pattern);}
  }
 });
 await check('Unfiltered custom Storm never borrows the standard record',async()=>{assert.equal(await page.locator('[name="selection"]').inputValue(),'standard');assert(Number(await page.locator('[data-profile-value]').textContent())>=1);await page.locator('[name="selection"]').selectOption('custom');assert.equal(await page.locator('[data-profile-value]').textContent(),'0');await page.locator('[data-puzzle-settings]').click();assert(await page.locator('#modal [name="enabled"]').isChecked());await screenshot('mobile-settings');await page.locator('#modal [data-close]').first().click();await page.locator('[name="selection"]').selectOption('standard');await screenshot('mobile-standard-setup');});
 let completedStorm,stormSummary;
 await check('Storm expires into a chronological summary of solved, failed and incomplete puzzles',async()=>{
  await page.locator('[data-start]').click();await page.locator('[data-timer]').waitFor();
  const first=(await json('/api/puzzles/history')).attempts[0];completedStorm=(await json('/api/puzzles/attempts/'+first.id)).session_id;assert(completedStorm);
  assert(await page.locator('[data-tab="history"]').isDisabled());await page.locator('[data-timer]').waitFor();
  assert.equal(await page.locator('.puzzle-feedback').getAttribute('data-state'),'active');assert.equal(await page.locator('[data-create-exercise]').count(),0);
  const pendingClock=(await json('/api/puzzles/storm/'+completedStorm)).storm;assert.equal(pendingClock.clock_started,false);assert.equal(pendingClock.remaining_ms,180000);assert.equal(await page.locator('[data-timer]').textContent(),'3:00');
  const white=(await json('/api/puzzles/attempts/'+first.id)).color==='white';
  await play(white?'g1f3':'e7e5');await page.getByText('Bien joué !',{exact:true}).waitFor();await play(white?'f1b5':'b8c6');
  await page.waitForFunction(()=>document.querySelector('.puzzle-storm-score>strong')?.textContent==='1');await page.locator('.puzzle-feedback[data-state="active"]').waitFor();
  await immediateStormTransition(white?'f1c4':'d7d5','errors');
  const before=await json('/api/puzzles/storm/'+completedStorm+'/attempts');assert.equal(before.summary.total,3);assert.equal(before.summary.solved,1);assert.equal(before.summary.failed,1);assert.equal(before.summary.incomplete,1);assert.equal(before.attempts[2].status,'active');
  await json('/__test/storm/'+completedStorm+'/expire','POST',{});
  // A normal move request discovers the server expiry and opens the real summary.
  await play(white?'g1f3':'e7e5');await page.locator('.storm-results').waitFor();
  stormSummary=await json('/api/puzzles/storm/'+completedStorm+'/attempts');assert.equal(stormSummary.storm.status,'completed');assert.equal(stormSummary.storm.score,1);assert.equal(stormSummary.storm.mistakes,1);assert.equal(stormSummary.attempts[2].status,'expired');
  assert.deepEqual(stormSummary.attempts.map(a=>a.outcome),['solved','failed','incomplete']);
  assert.deepEqual(await page.locator('[data-storm-attempt]').evaluateAll(rows=>rows.map(r=>r.dataset.stormAttempt)),stormSummary.attempts.map(a=>a.id));
  for(const outcome of ['solved','failed','incomplete'])assert.equal(await page.locator('.storm-results-status[data-outcome="'+outcome+'"]').count(),1);
  assert.equal(await page.locator('[data-storm-exercise]:disabled').count(),0);assert.equal((await json('/api/puzzles/overview')).profile.rated_count,2);
  await page.setViewportSize({width:1440,height:900});await screenshot('desktop-storm-summary');
 });
 await check('Storm summary filters and review return retain the selected subset',async()=>{
  for(const outcome of ['solved','failed','incomplete']){
   await page.locator('[data-storm-filter="'+outcome+'"]').click();assert.equal(await page.locator('[data-storm-attempt]').count(),1);assert.equal(await page.locator('[data-storm-attempt]').getAttribute('data-outcome'),outcome);assert.equal(await page.locator('[data-storm-filter="'+outcome+'"]').getAttribute('aria-pressed'),'true');
  }
  await page.locator('[data-storm-filter="failed"]').click();const failed=stormSummary.attempts.find(a=>a.outcome==='failed');
  await page.locator('[data-storm-review="'+failed.id+'"]').click();await page.locator('.puzzle-event-list').waitFor();assert.equal(await page.locator('[data-exit]').textContent(),'← Bilan');assert.equal(await page.locator('.puzzle-feedback').getAttribute('data-state'),'errors');
  const detail=await json('/api/puzzles/attempts/'+failed.id);assert(detail.events.some(e=>e.correct===0));assert((await page.locator('.puzzle-event-list').textContent()).includes(detail.events.find(e=>e.correct===0).san));
  await page.locator('[data-exit]').click();await page.locator('.storm-results').waitFor();assert.equal(await page.locator('[data-storm-filter="failed"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-storm-attempt]').getAttribute('data-storm-attempt'),failed.id);
 });
 await check('Storm summary exercise cancellation and saving preserve summary and exact solution',async()=>{
  const failed=stormSummary.attempts.find(a=>a.outcome==='failed'),source=await json('/api/puzzles/attempts/'+failed.id),expected=await json('/api/board','POST',{pgn:source.solution_pgn}),before=(await json('/api/bases/2/entries')).entries.length;
  const button=page.locator('[data-storm-exercise="'+failed.id+'"]');await button.click();await page.locator('.exercise-editor-dialog[open]').waitFor();
  assert.deepEqual((await page.locator('[data-exercise-moves] .analysis-move-san').allTextContents()).map(move=>move.replace(/^⚑/,'')),expected.nodes.filter(n=>n.uci).map(n=>n.san));
  await page.locator('.exercise-editor-dialog [data-exercise-action="close"]').first().click();await page.locator('.exercise-editor-dialog').waitFor({state:'detached'});assert.equal((await json('/api/bases/2/entries')).entries.length,before);assert.equal(await page.locator('[data-storm-filter="failed"]').getAttribute('aria-pressed'),'true');assert(await button.isEnabled());
  await button.click();await page.locator('.exercise-editor-dialog [name="title"]').fill('Storm summary exact');await page.locator('.exercise-editor-dialog [name="base_id"]').selectOption('2');await screenshot('desktop-storm-summary-exercise');await page.locator('[data-exercise-action="save"]').click();await page.locator('.exercise-editor-dialog').waitFor({state:'detached'});
  const entries=(await json('/api/bases/2/entries')).entries;assert.equal(entries.length,before+1);const saved=await json('/api/entries/'+entries.find(e=>e.title==='Storm summary exact').id),savedDoc=await json('/api/board','POST',{pgn:saved.pgn});
  assert.deepEqual(savedDoc.nodes.filter(n=>n.uci).map(n=>n.uci),expected.nodes.filter(n=>n.uci).map(n=>n.uci));assert.deepEqual(savedDoc.headers,expected.headers);assert.equal(savedDoc.nodes[0].fen,expected.nodes[0].fen);assert.deepEqual(await json('/api/puzzles/attempts/'+failed.id),source);
  assert(await page.locator('.storm-results').isVisible());assert.equal(await page.locator('[data-storm-filter="failed"]').getAttribute('aria-pressed'),'true');assert(await button.isEnabled());
 });
 await check('Mobile Storm summary, incomplete puzzle review, and reopening from statistics',async()=>{
  await page.setViewportSize({width:390,height:844});await page.locator('[data-storm-filter="all"]').click();await screenshot('mobile-storm-summary');
  const incomplete=stormSummary.attempts.find(a=>a.outcome==='incomplete');await page.locator('[data-storm-filter="incomplete"]').click();await page.locator('[data-storm-review="'+incomplete.id+'"]').click();await page.locator('.puzzle-event-list').waitFor();assert.equal(await page.locator('.puzzle-feedback').getAttribute('data-state'),'expired');await screenshot('mobile-storm-summary-review');await page.locator('[data-exit]').click();await page.locator('.storm-results').waitFor();assert.equal(await page.locator('[data-storm-filter="incomplete"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-storm-exercise="'+incomplete.id+'"]').click();await page.locator('.exercise-editor-dialog[open]').waitFor();await screenshot('mobile-storm-summary-exercise');await page.locator('.exercise-editor-dialog [data-exercise-action="close"]').first().click();await page.locator('.exercise-editor-dialog').waitFor({state:'detached'});assert(await page.locator('.storm-results').isVisible());
  await page.locator('[data-tab="stats"]').click();await page.locator('[data-storm-summary="'+completedStorm+'"]').click();await page.locator('.storm-results').waitFor();assert.equal(await page.locator('[data-storm-filter="incomplete"]').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('[data-storm-attempt]').getAttribute('data-storm-attempt'),incomplete.id);
  assert.equal((await json('/api/puzzles/overview')).profile.rated_count,2);
 });
 const completedClassic=(await json('/api/puzzles/history')).attempts.find(a=>a.mode==='classic'&&a.status==='completed');assert(completedClassic);
 for(const language of ['fr','en'])await check('Compact four-button navigation, intact settings modal and no board banner ('+language+', desktop and mobile)',async()=>{
  await json('/api/preferences','PATCH',{language});await page.goto(url+'/#/puzzles');await page.reload();await page.locator('[data-tab="history"]').click();await page.locator('[data-training-open]').first().waitFor();const rows=await json('/api/training/history?tool=puzzles');const index=rows.items.findIndex(item=>item.id===completedClassic.id);assert(index>=0);await page.locator('[data-training-open="'+index+'"]').click();await page.locator('[data-puzzle-board] .chess-board').waitFor();
  for(const [device,viewport] of [['desktop',{width:1440,height:900}],['mobile',{width:390,height:844}]]){
   await page.setViewportSize(viewport);await compactNavigation(language);await screenshot(device+'-puzzle-navigation-'+language);
  }
  await page.locator('[data-exit]').click();await page.locator('[data-filters]').waitFor();
 });
 assert.deepEqual(report.errors,[]);report.status='passed';
}finally{await writeFile(join(output,'results.json'),JSON.stringify(report,null,2));await context.close();}
