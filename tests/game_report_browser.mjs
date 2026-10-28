import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url);
const {chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only isolated loopback servers may be tested');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const report={status:'running',checks:[],geometry:[],errors:[],externalRequests:[],sourceMutations:[],attempts:[],exerciseRequests:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{
 executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},
 args:['--no-first-run','--no-default-browser-check','--disable-extensions']
});
const page=await context.newPage();page.setDefaultTimeout(12000);
page.on('pageerror',error=>report.errors.push(String(error)));
context.on('request',request=>{
 const path=new URL(request.url()).pathname,entry='/api/entries/'+fixture.source_id;
 if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());
 if(['POST','PUT','PATCH','DELETE'].includes(request.method())&&(path===entry||['move','line','tree','node','undo','redo'].some(action=>path===entry+'/'+action)))report.sourceMutations.push({path,method:request.method()});
 if(path==='/api/game-analysis/'+fixture.source_id+'/exercise'&&request.method()==='POST')report.exerciseRequests.push(request.postDataJSON());
});
await context.route('**/*',async route=>{
 const request=route.request(),parsed=new URL(request.url());
 if(parsed.origin!==url)return route.abort();
 if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
 if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
 if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test isolé.'}});
 if(parsed.pathname==='/api/game-analysis/'+fixture.source_id+'/retry'){
  const body=request.postDataJSON(),finding=fixture.report.findings.find(item=>item.ply===body.ply);
  assert(finding,'Retry must reference a real analysed position');assert.equal(body.fingerprint,fixture.fingerprint);
  const accepted=body.uci===finding.best_uci;report.attempts.push({...body,accepted});
  return route.fulfill({json:{accepted,ply:body.ply,uci:body.uci,fingerprint:fixture.fingerprint,verified:true,loss_win_pct:accepted?0:20}});
 }
 return route.continue();
});
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),method+' '+path+': '+response.status()+' '+await response.text());return response.json();}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name);}
async function tool(name){const desktop=page.locator('.analysis-tool-tabs [data-analysis-tool="'+name+'"]');if(await desktop.isVisible())await desktop.click();else await page.locator('.analysis-mobile-tabs [data-mobile-panel="'+name+'"]').click();}
async function selectMove(path){await page.locator('#move-list [data-path="'+path+'"]').click();await page.waitForFunction(value=>document.querySelector('#move-list .current')?.dataset.path===value,path);}
async function currentPath(){return page.locator('#move-list .current').getAttribute('data-path');}
async function play(host,uci){await page.locator(host+' [data-square="'+uci.slice(0,2)+'"]').click();await page.locator(host+' [data-square="'+uci.slice(2,4)+'"]').click();}
async function annotations(){if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]');if(await toggle.isVisible())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}await page.locator('#annotation-form textarea').waitFor({state:'visible'});}
async function closeAnnotations(){if(!await page.locator('#annotation-form textarea').isVisible())return;const toggle=page.locator('[data-action="toggle-annotations"]');if(await toggle.isVisible())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}
async function waitUntil(fn,label){const end=Date.now()+12000;do{if(await fn())return;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw Error('Timeout: '+label);}
async function sourceUnchanged(){assert.equal((await json('/api/entries/'+fixture.source_id)).pgn,fixture.pgn);assert.deepEqual(report.sourceMutations,[]);}
async function capture(name){
 await page.waitForFunction(()=>!document.querySelector('#notices')?.children.length);
 await page.screenshot({path:join(output,name+'.png'),fullPage:true});
 const geometry=await page.evaluate(()=>{
  const box=node=>{if(!node)return null;const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,visible:node.checkVisibility()&&r.width>0&&r.height>0};};
  const visible=selector=>[...document.querySelectorAll(selector)].find(node=>node.checkVisibility());
  return {viewport:{width:innerWidth,height:innerHeight},scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,board:box(visible('.chess-board')),report:box(visible('.report-repertoire')),moment:box(visible('.report-moment')),timeline:box(visible('.report-impact')),session:box(visible('.report-session-board'))};
 });
 report.geometry.push({name,...geometry});
 assert(geometry.scrollWidth<=geometry.viewport.width+1,name+': horizontal page overflow');
 assert(geometry.board?.width>0,name+': missing board');assert(Math.abs(geometry.board.width-geometry.board.height)<2,name+': board is not square');
 assert(geometry.board.x>=-1&&geometry.board.x+geometry.board.width<=geometry.viewport.width+1,name+': board extends outside viewport');
 return geometry;
}
const target=fixture.report.findings.find(item=>item.ply===5);
assert(target&&target.best_uci==='f1b5','Expected a real 3.Bc4 finding and legal Bb5 alternative');
try{
 await json('/api/setup-resources/complete','POST',{});
 // The document endpoint exports canonical PGN. Compare against its own initial
 // snapshot; the Python harness separately checks the exact SQLite source text.
 fixture.pgn=(await json('/api/entries/'+fixture.source_id)).pgn;
 await page.goto(url);
 await page.locator('[data-base="'+fixture.study_base+'"]').click();
 await page.locator('[data-et-action="open"][data-et-id="'+fixture.source_id+'"]').first().click();
 await page.locator('#move-list').waitFor();
 await tool('bilan');
 await check('Résumé : camp personnel, répertoire principal, timeline et cartes compactes',async()=>{
  await page.locator('.report-impact').waitFor();await page.locator('[data-work-action="repertoire-exit"]').waitFor({state:'attached'});
  assert.equal(await page.locator('[data-analysis-side]').inputValue(),'white');
  assert.match(await page.locator('.report-repertoire').textContent(),/Espagnole principale/);
  assert.match(await page.locator('.report-repertoire').textContent(),/3\. Bc4/);
  const repertoire=await json('/api/game-analysis/'+fixture.source_id+'/repertoire?color=white');assert.equal(repertoire.covered_plies,4);assert.equal(repertoire.total_plies,10);
  assert(await page.locator('.report-moment-list button').count()>0);
  const geometry=await capture('desktop-summary');assert(geometry.report?.visible&&geometry.timeline?.visible);
  await page.setViewportSize({width:1440,height:720});await capture('desktop-summary-720');await page.setViewportSize({width:1440,height:900});
  if(!await page.locator('[data-work-action="repertoire-exit"]').isVisible())await page.locator('.report-opening-details>summary').click();
  await page.locator('[data-work-action="repertoire-exit"]').click();
  await page.waitForFunction(path=>document.querySelector('#move-list .current')?.dataset.path===path,target.before_path);
  await sourceUnchanged();
 });
 const draft='Note personnelle à conserver pendant toute la recherche.';
 await check('Brouillon local, sélection de moment et navigation entre moments',async()=>{
  await selectMove('0');await annotations();await page.locator('#annotation-form textarea').fill(draft);
  await page.locator('#annotation-form button[type="submit"]').click();
  await closeAnnotations();
  await tool('bilan');await page.locator('.report-impact-targets [data-ply="5"]').click();
  await page.locator('.report-moment').waitFor();assert.equal(await currentPath(),target.before_path);
  assert.equal(await page.locator('.report-moment-title [data-ply]').getAttribute('data-ply'),'5');
  const next=page.locator('[data-work-action="moment-next"]'),previous=page.locator('[data-work-action="moment-previous"]');
  const nav=await next.isEnabled()?next:previous;await nav.click();
  await page.waitForFunction(()=>document.querySelector('.report-moment-title [data-ply]')?.dataset.ply!=='5');
  assert.notEqual(await page.locator('.report-moment-title [data-ply]').getAttribute('data-ply'),'5');
  await page.locator('[data-work-action="report-view"][data-view="summary"]').click();
  await page.locator('.report-impact-targets [data-ply="5"]').click();
  await page.locator('.report-moment').waitFor({state:'visible'});
  assert.match(await page.locator('#workspace-status').textContent(),/Brouillon/);
  await capture('desktop-moment');await sourceUnchanged();
 });
 let beforeMoves,beforePath;
 await check('Réessai : moteur et coups masqués, tentative refusée puis bonne décision',async()=>{
  beforeMoves=await page.locator('#move-list').innerHTML();beforePath=await currentPath();
  await page.locator('#analysis-engine [data-b="engine"]').click();
  assert.equal(await page.locator('#analysis-engine [data-b="engine"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-work-action="retry-position"]').click();
  await page.locator('.report-session-board').waitFor();
  assert(!(await page.locator('#move-list').isVisible()));assert(!(await page.locator('#analysis-engine').isVisible()));
  assert(!(await page.locator('[data-session-engine]').isVisible()));assert(!(await page.locator('.report-session-moves').isVisible()));
  assert.equal(await page.locator('.report-solution').count(),0);
  await capture('desktop-retry');
  await play('[data-session-board]',target.uci);
  await page.waitForFunction(()=>document.querySelector('.report-session-status')?.textContent.includes('Essaie encore'));
  assert.equal(report.attempts.at(-1).accepted,false);assert(!(await page.locator('.report-session-moves').isVisible()));
  await play('[data-session-board]',target.best_uci);
  await page.waitForFunction(()=>document.querySelector('.report-session-status')?.textContent.includes('Bien trouvé'));
  assert.equal(report.attempts.at(-1).accepted,true);assert(await page.locator('.report-session-moves').isVisible());
  await capture('desktop-solved');
  await page.locator('[data-report-session="played"]').click();
  await page.waitForFunction(()=>document.querySelector('.report-session-moves')?.textContent.includes('Bc4'));
  const moves=page.locator('.report-session-moves [data-path]');assert(await moves.count()>1);await moves.last().click();
  await page.locator('[data-report-session="alternative"]').click();
  await page.waitForFunction(()=>document.querySelector('.report-session-moves')?.textContent.includes('Bb5'));
  await page.locator('.report-session-moves [data-path]').last().click();
  await capture('desktop-comparison');
  await page.locator('[data-report-session="finish"]').click();
  await page.locator('.report-session-board').waitFor({state:'detached'});
  assert.equal(await currentPath(),beforePath);assert.equal(await page.locator('#move-list').innerHTML(),beforeMoves);
  assert.equal(await page.locator('#analysis-engine [data-b="engine"]').getAttribute('aria-pressed'),'true');
  assert.match(await page.locator('#workspace-status').textContent(),/Brouillon/);await sourceUnchanged();
  await selectMove('0');await annotations();assert.equal(await page.locator('#annotation-form textarea').inputValue(),draft);
  await closeAnnotations();
  await selectMove(beforePath);await page.locator('#analysis-engine [data-b="engine"]').click();
 });
 await check('Exercice manuel depuis le bilan : aucune solution injectée, provenance enregistrée',async()=>{
  await page.locator('[data-work-action="exercise"]').click();
  await page.locator('.exercise-editor-dialog[open]').waitFor();
  assert.equal(await page.locator('[data-exercise-moves] [data-path]').count(),0);
  await page.locator('.exercise-editor-dialog [name="base_id"]').selectOption(String(fixture.exercise_base));
  await page.locator('.exercise-editor-dialog [name="title"]').fill('Décision créée manuellement depuis le bilan');
  await play('[data-exercise-board]','f1b5');
  await page.waitForFunction(()=>document.querySelector('[data-exercise-moves]')?.textContent.includes('Bb5'));
  await play('[data-exercise-board]','a7a6');
  await page.waitForFunction(()=>document.querySelector('[data-exercise-moves]')?.textContent.includes('a6'));
  await capture('desktop-manual-exercise');
  await page.locator('[data-exercise-action="save"]').click();
  await page.locator('.exercise-editor-dialog[open]').waitFor({state:'detached'});
  await waitUntil(async()=>{const value=await json('/api/game-analysis/'+fixture.source_id);return value.findings.find(item=>item.ply===5)?.exercise_ids?.length>0;},'linked exercise');
  const value=await json('/api/game-analysis/'+fixture.source_id),exerciseId=value.findings.find(item=>item.ply===5).exercise_ids[0],exercise=await json('/api/entries/'+exerciseId);
  assert.equal(exercise.base_id,fixture.exercise_base);assert(exercise.pgn.includes('Bb5')&&exercise.pgn.includes('a6'));
  assert(exercise.pgn.includes('[FEN "'+target.fen+'"]'));assert.equal(report.exerciseRequests.length,1);
  assert.equal(report.exerciseRequests[0].fingerprint,fixture.fingerprint);assert.equal(report.exerciseRequests[0].ply,5);await sourceUnchanged();
 });
 await check('Mobile 390 × 844 : résumé, moment et réessai sans débordement',async()=>{
  await page.setViewportSize({width:390,height:844});await tool('bilan');
  await page.locator('[data-work-action="report-view"][data-view="summary"]').click();
  const summary=await capture('mobile-summary');assert(summary.report?.visible&&summary.timeline?.visible);
  await page.locator('.report-moment-list button').last().scrollIntoViewIfNeeded();await capture('mobile-priorities');
  await page.locator('.report-impact-targets [data-ply="5"]').click();await page.locator('.report-moment').waitFor({state:'visible'});await capture('mobile-moment');
  const path=await currentPath();await page.locator('[data-work-action="retry-position"]').click();
  await page.locator('.report-session-board').waitFor();assert(!(await page.locator('.report-session-moves').isVisible()));
  assert(!(await page.locator('.report-moment').textContent()).includes('Bonne décision retrouvée'),'A fresh retry must not retain the previous success message');
  await capture('mobile-retry');await play('[data-session-board]','f1b5');
  await page.waitForFunction(()=>document.querySelector('.report-session-status')?.textContent.includes('Bien trouvé'));
  await capture('mobile-solved');await page.locator('[data-report-session="finish"]').click();
  assert.equal(await currentPath(),path);await sourceUnchanged();
 });
 await check('Réinitialisation avec coups légaux retardés : retour immédiat sans rouvrir la séance',async()=>{
  await page.setViewportSize({width:1440,height:900});await tool('bilan');
  await page.locator('[data-work-action="moment-solution"]').click();
  await page.locator('[data-work-action="compare-alternative"]').click();
  await page.locator('[data-report-session="reset"]').waitFor();
  await page.waitForFunction(()=>document.querySelector('.report-session-moves')?.textContent.includes('Bb5'));
  const path=await currentPath();let held,release;
  const requestSeen=new Promise(resolve=>release=resolve);
  const delay=async route=>{held=route;release();};
  await page.route('**/api/legal?*',delay);
  try{
   await page.locator('[data-report-session="reset"]').click();await requestSeen;
   assert(!(await page.locator('[data-session-engine]').isVisible()));assert(!(await page.locator('.report-session-moves').isVisible()));
   await page.locator('[data-report-session="finish"]').click();
   assert.equal(await page.locator('.report-session-board').count(),0);
   const completed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/legal');
   await held.continue();held=null;await completed;
   await page.waitForFunction(()=>!document.querySelector('.report-session-active')&&!document.querySelector('[data-work-action="retry-position"]')?.disabled);
   assert.equal(await currentPath(),path);assert(await page.locator('#analysis-engine').isVisible());await sourceUnchanged();
  }finally{if(held)await held.continue();await page.unroute('**/api/legal?*',delay);}
 });
 await check('Retour et navigation quittent la session sans modifier la partie ni perdre le brouillon',async()=>{
  await page.setViewportSize({width:1440,height:900});await tool('bilan');
  await page.locator('#analysis-engine [data-b="engine"]').click();
  assert.equal(await page.locator('#analysis-engine [data-b="engine"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-work-action="retry-position"]').click();await page.locator('.report-session-board').waitFor();
  await page.locator('.top-nav .navigation-group').filter({has:page.locator('[data-page="library"]')}).locator(':scope > summary').click();
  await page.locator('.top-nav [data-page="library"]').click();
  await page.locator('.report-session-board').waitFor({state:'detached'});
  await page.locator('.top-nav [data-board-menu] > summary').click();
  await page.locator('.top-nav [data-board-command="current"]').click();
  await page.locator('#move-list').waitFor();assert.match(await page.locator('#workspace-status').textContent(),/Brouillon/);
  assert.equal(await page.locator('#analysis-engine [data-b="engine"]').getAttribute('aria-pressed'),'true');
  await selectMove('0');await annotations();assert.equal(await page.locator('#annotation-form textarea').inputValue(),draft);
  await sourceUnchanged();assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure=String(error.stack||error);console.error(report.failure);await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
