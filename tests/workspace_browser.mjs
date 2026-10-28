import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const require=createRequire(import.meta.url);
const {chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert(new URL(url).hostname==='127.0.0.1','Only isolated loopback servers may be tested');
const report={status:'running',checks:[],geometry:[],errors:[],externalRequests:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{
 executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},
 args:['--no-first-run','--no-default-browser-check','--disable-extensions']
});
const page=await context.newPage();
page.setDefaultTimeout(12000);
page.on('pageerror',error=>report.errors.push(String(error)));
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
await context.route('**/*',async route=>{
 const request=route.request(),parsed=new URL(request.url());
 if(parsed.origin!==url)return route.abort();
 if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
 if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
 if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test isolé.'}});
 return route.continue();
});
async function json(path,method='GET',data){
 const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});
 assert(response.ok(),method+' '+path+': '+response.status()+' '+await response.text());
 return response.json();
}
async function waitJson(path,predicate){const deadline=Date.now()+12000;do{const data=await json(path);if(predicate(data))return data;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<deadline);throw Error('Timed out waiting for '+path);}
async function check(name,fn){if(process.env.CHESSGYM_BROWSER_CHECK&&!name.includes(process.env.CHESSGYM_BROWSER_CHECK))return;await fn();report.checks.push(name);console.log('PASS '+name);}
async function dismissModal(){if(await page.locator('#modal[open]').count())await page.locator('#modal [data-close]').first().click();}
async function boardMenu(target=page){
 const menu=target.locator('details[data-board-menu]:visible').first();await menu.waitFor();
 if(await menu.getAttribute('open')===null)await menu.locator(':scope > summary').click();
 await menu.locator('[data-board-menu-content]').waitFor({state:'visible'});return menu;
}
async function manageDrafts(){await (await boardMenu()).locator('[data-board-command="manage"]').click();await page.locator('#modal[open]').waitFor();}
async function noStartupPopup(target=page){await target.locator('.topbar').waitFor();assert.equal(await target.locator('#modal[open]').count(),0,'Opening ChessGym must not show the draft manager automatically');}
async function resumeDraft(key){await noStartupPopup();await manageDrafts();await page.locator('[data-workspace-document="'+key+'"]').click();await page.locator('#modal[open]').waitFor({state:'detached'});}
async function resumeStoredReview(target=page,{touch=false}={}){
 await noStartupPopup(target);const resume=target.locator('[data-action="resume-stored-review"]:visible');
 if(await resume.count())await resume[touch?'tap':'click']();else await nav('reviews',target,{touch});
 await target.locator('#review-board').waitFor();
}
async function nav(id,target=page,{touch=false}={}){
 if(id==='board'){await (await boardMenu(target)).locator('[data-board-command="current"]')[touch?'tap':'click']();return;}
 const action=target.locator('.top-actions [data-page="'+id+'"]');
 if(await action.isVisible()){await action.click();return;}
 const mobile=await target.locator('.mobile-navigation').isVisible(),navigation=target.locator(mobile?'.mobile-navigation':'.top-nav');
 const link=navigation.locator('[data-page="'+id+'"]');
 if(!await link.isVisible())await navigation.locator('details:has([data-page="'+id+'"])>summary')[touch?'tap':'click']();
 await link[touch?'tap':'click']();
}
async function settingsTab(id){
 await page.locator('[data-settings-tab="'+id+'"]').click();
 await page.locator('[data-settings-panel="'+id+'"]').waitFor({state:'visible'});
 assert.equal(await page.locator('[data-settings-tab="'+id+'"]').getAttribute('aria-selected'),'true');
}
async function selectMove(path){
 await page.locator('#move-list [data-path="'+path+'"]').click();
 await page.waitForFunction(path=>document.querySelector('#move-list .current')?.dataset.path===path,path);
}
async function annotations(){
 if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]');if(await toggle.isVisible())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}
 await page.locator('#annotation-form textarea').waitFor({state:'visible'});
}
async function displayMenu(){
 let summary=page.locator('.analysis-reading-controls>summary');
 if(!await summary.isVisible()){
  await page.locator('.analysis-more>summary:visible').first().click();
 }
 if(!await page.locator('[data-reading-action="preset-reading"]').isVisible())await summary.click();
}
async function closeDisplay(){
 await page.evaluate(()=>document.querySelectorAll('details.analysis-reading-controls,details.analysis-more').forEach(node=>node.open=false));
}
async function capture(name,{boardRequired=true}={}){
 await page.screenshot({path:join(output,name+'.png'),fullPage:true});
 const geometry=await page.evaluate(()=>{
  const box=node=>{if(!node)return null;const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,visible:(node.checkVisibility?node.checkVisibility():style.display!=='none'&&style.visibility!=='hidden')&&r.width>0&&r.height>0,text:(node.textContent||'').trim().slice(0,80)};};
  const board=document.querySelector('.analysis-page .chess-board,.review-page .chess-board');
  const badge=document.getElementById('workspace-status');
  const controls=[...document.querySelectorAll('.analysis-command-dock button,.board-toolbar button,.notation-actions button,.review-actions button,.review-tabs button')].map(box).filter(r=>r.visible);
  return {viewport:{width:innerWidth,height:innerHeight},scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,board:box(board),badge:box(badge),controls,touch:document.documentElement.dataset.touchComfort};
 });
 report.geometry.push({name,...geometry});
 assert(geometry.scrollWidth<=geometry.viewport.width+1,name+': horizontal page overflow');
 if(boardRequired){assert(geometry.board?.width>0,name+': board missing');assert(Math.abs(geometry.board.width-geometry.board.height)<2,name+': board is not square');assert(geometry.board.x>=-1&&geometry.board.x+geometry.board.width<=geometry.viewport.width+1,name+': board extends beyond viewport');}
 const r=geometry.badge;
 if(r?.visible)assert(r.x>=-1&&r.x+r.width<=geometry.viewport.width+1,name+': status badge outside viewport');
 return geometry;
}
try{
 await json('/api/setup-resources/complete','POST',{});
 const study=await json('/api/bases','POST',{name:'Cours de test',settings:{reading_enabled:true}});
 const studyGame=await json('/api/entries','POST',{base_id:study.id,title:'Cours annoté — étude de test',pgn:'[Event "Cours"]\n[White "White"]\n[Black "Black"]\n[Result "*"]\n\n1. e4 {Idée initiale.} e5 {Réponse initiale.} 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 *'});
 const practice=await json('/api/bases','POST',{name:'Exercices de test',settings:{review_enabled:true,type:'solve',mode:'hybrid',new_limit:10}});
 await json('/api/entries','POST',{base_id:practice.id,title:'Exercice un',pgn:'[Event "Un"]\n\n1. e4 e5 2. Nf3 *'});
 await json('/api/entries','POST',{base_id:practice.id,title:'Exercice deux',pgn:'[Event "Deux"]\n\n1. d4 d5 2. c4 *'});
 await page.goto(url);
 await page.locator('[data-base="'+study.id+'"]').waitFor();
 await check('Échiquier initial sans brouillon, nettoyage ciblé et suppression explicite',async()=>{
  await nav('board');await page.locator('#workspace-status').waitFor();assert.equal(await page.locator('#workspace-status').textContent(),'Analyse libre');
  await nav('library');assert(!(await json('/api/workspace')).items.some(item=>item.key==='analysis'||item.key.startsWith('document:')));
  const initial={headers:{Result:'*'},workspace_id:'empty-test',nodes:[{path:'',parent:null,fen:'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',san:null,uci:null,comment:'',nags:[],children:[],clock:null,elapsed:null}]};
  const diagram=await json('/api/board','POST',{fen:'8/8/8/8/4K3/8/8/4k3 w - - 0 1'});diagram.workspace_id='diagram-test';
  const annotated=structuredClone(initial);annotated.workspace_id='notes-test';annotated.nodes[0].comment='Préparer ce chapitre';
  for(const [key,data]of [['document:free:empty-test',{doc:initial}],['analysis',{doc:initial}],['document:free:diagram-test',{doc:diagram}],['annotation:free:diagram-test',{nodes:{'':{comment:'À garder',nags:[],fen:diagram.nodes[0].fen,uci:null}}}],['document:free:notes-test',{doc:annotated}]])await json('/api/workspace/'+key,'PUT',{expected_revision:0,data});
  await page.reload();await page.locator('[data-base="'+study.id+'"]').waitFor();
  await waitJson('/api/workspace',data=>!data.items.some(item=>['analysis','document:free:empty-test'].includes(item.key)));
  const items=(await json('/api/workspace')).items;assert(items.some(item=>item.key==='document:free:diagram-test'));assert(items.some(item=>item.key==='document:free:notes-test'));
  await nav('board');assert.equal(await page.locator('#workspace-status').textContent(),'Analyse libre');await manageDrafts();
  await page.locator('[data-workspace-document="document:free:diagram-test"]').click();await page.locator('#move-list').waitFor();assert((await page.locator('#workspace-status').textContent()).startsWith('Brouillon'));
  await manageDrafts();
  page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-delete-workspace="document:free:diagram-test"]').click();assert(await page.locator('[data-workspace-document="document:free:diagram-test"]').count());
  page.once('dialog',dialog=>dialog.accept());await page.locator('[data-delete-workspace="document:free:diagram-test"]').click();
  await page.waitForFunction(()=>document.querySelector('#workspace-status')?.textContent==='Analyse libre');await dismissModal();
  await nav('library');await nav('board');assert.equal(await page.locator('#workspace-status').textContent(),'Analyse libre');
  const remaining=(await json('/api/workspace')).items;assert(!remaining.some(item=>item.key.includes('diagram-test')||item.key==='analysis'));assert(remaining.some(item=>item.key==='document:free:notes-test'));
  await page.reload();await page.locator('#workspace-status').waitFor();assert.equal(await page.locator('#workspace-status').textContent(),'Analyse libre');assert.equal(await page.locator('#modal[open]').count(),0);
  await nav('library');
 });
 await check('Navigation sections, Back/Forward et absence de passage historique par coup',async()=>{
  await page.locator('[data-base="'+study.id+'"]').click();
  await page.locator('[data-et-action="open"][data-et-id="'+studyGame.id+'"]').first().click();
  await page.locator('#move-list').waitFor();
  const history=await page.evaluate(()=>window.history.length);
  await selectMove('0');await selectMove('0.0');await selectMove('0.0.0');
  assert.equal(await page.evaluate(()=>window.history.length),history);
  await nav('reading');
  await page.waitForURL('**/#/reading');
  await page.goBack();await page.waitForURL('**/#/board?entry='+studyGame.id);
  await page.locator('#move-list').waitFor();
  await page.goBack();await page.waitForURL('**/#/base?base='+study.id);await page.locator('[data-et-id="'+studyGame.id+'"]').first().waitFor();await page.waitForLoadState('networkidle');
  await page.goForward();await page.waitForURL('**/#/board?entry='+studyGame.id);
  await page.locator('#move-list').waitFor();await page.waitForLoadState('networkidle');
 });
 const firstDraft='Draft e4 — conservé après rechargement',secondDraft='Draft e5 <texte littéral>';
 await check('Annotations non enregistrées sur deux coups, rechargement puis sauvegarde du PGN',async()=>{
  await selectMove('0');await annotations();
  await page.locator('#annotation-form textarea').fill(firstDraft);
  await selectMove('0.0');await annotations();
  await page.locator('#annotation-form textarea').fill(secondDraft);
  assert(!(await json('/api/entries/'+studyGame.id)).pgn.includes('Draft e4'));
  await page.reload();
  await resumeDraft('document:entry:'+studyGame.id);
  await page.locator('#move-list').waitFor();
  await selectMove('0');await annotations();
  assert.equal(await page.locator('#annotation-form textarea').inputValue(),firstDraft);
  await selectMove('0.0');await annotations();
  assert.equal(await page.locator('#annotation-form textarea').inputValue(),secondDraft);
  await page.locator('[data-action="save-board"]:visible').first().click();
  await page.waitForFunction(()=>document.querySelector('#notices')?.textContent.includes('Modifications sauvegardées'));
  const saved=await json('/api/entries/'+studyGame.id);
  assert(saved.pgn.includes(firstDraft)&&saved.pgn.includes(secondDraft));
 });
 await check('Variantes temporaires : original intact après navigation et rechargement, sauvegarde explicite',async()=>{
  await nav('library');
  await page.locator('[data-base="'+study.id+'"]').click();
  await page.locator('[data-et-action="open"][data-et-id="'+studyGame.id+'"]').first().click();
  await page.locator('#move-list').waitFor();
  const original=(await json('/api/entries/'+studyGame.id)).pgn,mutations=[];
  const record=request=>{const path=new URL(request.url()).pathname,entry='/api/entries/'+studyGame.id,edits=path===entry||['move','line','tree','node','undo','redo'].some(action=>path===entry+'/'+action);if(edits&&['POST','PUT','PATCH','DELETE'].includes(request.method()))mutations.push(path);};
  page.on('request',record);
  try{
   await selectMove('0.0');
   await page.locator('#board-host [data-square="f1"]').click();
   await page.locator('#board-host [data-square="c4"]').click();
   await page.locator('#move-list [data-path="0.0.1"]').waitFor();
   await annotations();await page.locator('#annotation-form textarea').fill('Variante explorée temporairement');
   await page.locator('#annotation-form button[type="submit"]').click();
   assert.equal((await json('/api/entries/'+studyGame.id)).pgn,original);
   const other=await json('/api/entries','POST',{base_id:study.id,title:'Autre partie pour navigation',pgn:'[Event "Autre"]\n\n1. d4 d5 *'});
   await nav('library');await page.locator('[data-base="'+study.id+'"]').click();
   await page.locator('[data-et-action="open"][data-et-id="'+other.id+'"]').first().click();
   await page.locator('#move-list').waitFor();
   await nav('library');await page.locator('[data-base="'+study.id+'"]').click();
   await page.locator('[data-et-action="open"][data-et-id="'+studyGame.id+'"]').first().click();
   await page.locator('#move-list [data-path="0.0.1"]').waitFor();
   assert.equal((await json('/api/entries/'+studyGame.id)).pgn,original);
   await nav('library');await nav('board');
   await page.locator('#move-list [data-path="0.0.1"]').waitFor();
   assert.equal((await json('/api/entries/'+studyGame.id)).pgn,original);
   await page.reload();await resumeDraft('document:entry:'+studyGame.id);
   await page.locator('#move-list [data-path="0.0.1"]').waitFor();
   await selectMove('0.0.1');await annotations();
   assert.equal(await page.locator('#annotation-form textarea').inputValue(),'Variante explorée temporairement');
   assert.equal((await json('/api/entries/'+studyGame.id)).pgn,original);
   assert.deepEqual(mutations,[],'Exploring, annotations and navigation must never write the saved PGN');
   assert((await page.locator('#workspace-status').textContent()).startsWith('Brouillon'));
   await page.locator('[data-action="save-board"]:visible').first().click();
   const saved=await waitJson('/api/entries/'+studyGame.id,data=>data.pgn.includes('Variante explorée temporairement'));
   assert(saved.pgn.includes('Bc4')&&saved.pgn!==original);
   assert.equal(mutations.length,1,'The explicit Save button should be the only original-game write');
  }finally{page.off('request',record);}
 });
 await check('Préréglages persistants et vues d’analyse aux trois tailles',async()=>{
  await displayMenu();
  await page.locator('[data-reading-action="preset-reading"]').click();
  assert.equal(await page.locator('[data-reading-size]').textContent(),'16 px');
  await page.locator('[data-reading-action="touch"]').click();
  await closeDisplay();
  if(await page.locator('#analysis-annotations').getAttribute('open')!==null){const toggle=page.locator('[data-action="toggle-annotations"]');if(await toggle.isVisible())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}
  await page.waitForFunction(()=>document.querySelectorAll('#notices .notice').length===0);
  assert.equal(await page.locator('html').getAttribute('data-touch-comfort'),'true');
  for(const size of [{width:1440,height:900},{width:390,height:844},{width:844,height:390}]){
   await page.setViewportSize(size);
   await page.waitForTimeout(250);
   await capture('analysis-'+size.width+'x'+size.height);
  }
  await page.setViewportSize({width:1440,height:900});
  await displayMenu();await page.locator('[data-reading-action="preset-analysis"]').click();await closeDisplay();
  await page.reload();await noStartupPopup();await page.locator('#move-list').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-touch-comfort'),'true');
  await displayMenu();
  assert.equal(await page.locator('[data-reading-action="preset-analysis"]').getAttribute('aria-pressed'),'true');
  await closeDisplay();
 });
 await check('Révision, analyse complète et reprise après rechargement sans perte de progression',async()=>{
  await nav('reviews');
  await page.locator('[data-learn="'+practice.id+'"]:visible').click();
  await page.locator('#modal button[type="submit"]').click();
  await page.locator('#review-board').waitFor();
  await page.locator('#reveal-answer').click();
  await page.locator('#grade-panel [data-grade="2"]').click();
  await page.waitForFunction(()=>document.querySelector('.review-page .eyebrow')?.textContent.includes('2 / 2'));
  const title=await page.locator('.review-page .page-title h1').textContent();
  await page.locator('#analyse-position').click();
  await page.locator('#move-list [data-path="0.0.0"]').waitFor();
  await page.locator('[data-action="resume-review"]:visible').click();
  await page.locator('#review-board').waitFor();
  assert.equal(await page.locator('.review-page .page-title h1').textContent(),title);
  await page.reload();
  await resumeStoredReview();
  await page.locator('#review-board').waitFor();
  assert((await page.locator('.review-page .eyebrow').textContent()).includes('2 / 2'));
  assert.equal(await page.locator('.review-page .page-title h1').textContent(),title);
  for(const size of [{width:1440,height:900},{width:390,height:844},{width:844,height:390}]){
   await page.setViewportSize(size);
   await page.waitForTimeout(250);
   await capture('review-'+size.width+'x'+size.height);
  }
 });
 await check('Reprise sur un second appareil sans stockage local initial',async()=>{
  await waitJson('/api/workspace',result=>result.items?.some(item=>item.key==='review'&&(item.data?.cards?.[item.data.index]?.session_index??item.data?.index)===1));
  const second=await chromium.launchPersistentContext(join(output,'second-profile'),{
   executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:390,height:844},isMobile:true,hasTouch:true,
   args:['--no-first-run','--no-default-browser-check','--disable-extensions']
  });
  try{
   second.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
   await second.route('**/*',route=>new URL(route.request().url()).origin===url?route.continue():route.abort());
   const statusResponse=await second.request.get(url+'/api/status');
   assert(statusResponse.ok());assert.equal((await statusResponse.json()).authenticated,true);
   const other=await second.newPage();
   other.on('pageerror',error=>report.errors.push(String(error)));
   await other.goto(url);
   await resumeStoredReview(other,{touch:true});
   await other.locator('#review-board').waitFor();
   assert((await other.locator('.review-page .eyebrow').textContent()).includes('2 / 2'));
   assert.equal(await other.locator('.review-page .page-title h1').textContent(),'Exercice deux');
   await other.screenshot({path:join(output,'review-second-device-390x844.png'),fullPage:true});
  }finally{await second.close();}
 });
 await check('Statistiques de révision en deux colonnes avec espacement constant',async()=>{
  await page.setViewportSize({width:1440,height:900});
  await page.locator('#session-back').click();
  await page.locator('[data-review-view="statistics"]').click();
  await page.locator('.rs-column').nth(1).waitFor();
  const columns=await page.locator('.rs-column').evaluateAll(nodes=>nodes.map(node=>({
   x:node.getBoundingClientRect().x,width:node.getBoundingClientRect().width,
   cards:[...node.children].map(card=>{const r=card.getBoundingClientRect();return {y:r.y,bottom:r.bottom,title:card.querySelector('h2')?.textContent};})
  })));
  assert.equal(columns.length,2);assert(columns[1].x>columns[0].x+columns[0].width);
  for(const column of columns)for(let index=1;index<column.cards.length;index++){
   const gap=column.cards[index].y-column.cards[index-1].bottom;
   assert(Math.abs(gap-14)<1,'Statistics card gap is '+gap);
  }
  assert(await page.locator('.review-progress-track').count()>0);
  assert.equal(await page.locator('.rs-card .review-progress-legend').first().locator('li').count(),4);
  assert(!(await page.locator('.review-statistics').innerText()).includes('En apprentissage'));
  assert(!(await page.locator('.review-statistics').innerText()).includes('En cours'));
  assert.equal(await page.locator('.rs-welcome').count(),0,'Real completed review must populate statistics');
  report.statisticsColumns=columns;
  await page.screenshot({path:join(output,'review-statistics-1440x900.png'),fullPage:true});
 });
 await check('Préférences globales : seuil personnalisable et apprentissage sans quota',async()=>{
  await nav('settings');await settingsTab('reviews');
  await page.locator('#review-preferences').waitFor();
  assert.equal(await page.locator('#review-preferences [name="auto_mastery_days"]').inputValue(),'180');
  await page.locator('#review-preferences details>summary').click();
  for(const [key,value] of Object.entries({again:'10',hard:'2',medium:'5',easy:'10'}))
   assert.equal(await page.locator('#review-preferences [name="'+key+'"]').inputValue(),value);
  await page.locator('#review-preferences [name="auto_mastery_days"]').fill('240');
  await page.locator('#review-preferences button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-review-preferences-result]')?.textContent==='Réglages enregistrés.');
  assert.equal((await json('/api/preferences')).auto_mastery_days,240);
  assert.equal((await json('/api/library')).bases.find(base=>base.id===practice.id).settings.new_limit,10);
  await page.screenshot({path:join(output,'review-preferences-1440x900.png'),fullPage:true});
 });
 await check('Anglais persistant, multiplicateur global effectif et contenu PGN intact',async()=>{
  await settingsTab('general');await page.locator('#interface-language').selectOption('en');
  await page.waitForFunction(()=>document.documentElement.lang==='en'&&document.querySelector('.top-nav .navigation-group:has([data-page="library"])>summary')?.textContent.includes('Library'));
  await waitJson('/api/preferences',data=>data.language==='en');assert.deepEqual(await page.locator('[data-settings-tab]').allTextContents(),['General','Appearance','Sounds','Reviews','Performance','Backups','Account']);await settingsTab('reviews');
  assert((await page.locator('#review-preferences').innerText()).includes('Interval growth'));
  assert.equal(await page.locator('#review-preferences [name="auto_mastery_days"]').inputValue(),'240');
  await page.locator('#review-preferences [name="multiplier_hard"]').fill('2.5');
  await page.locator('#review-preferences button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-review-preferences-result]')?.textContent==='Settings saved.');
  const prefs=await json('/api/preferences');assert.equal(prefs.language,'en');assert.equal(prefs.review_multipliers.hard,2.5);assert.equal(prefs.review_defaults.new_limit,null);
  await page.screenshot({path:join(output,'english-settings-1440x900.png'),fullPage:true});
  const bilingualBase=await json('/api/bases','POST',{name:'Révisions',settings:{review_enabled:true,type:'solve',mode:'hybrid'}});
  const bilingualGame=await json('/api/entries','POST',{base_id:bilingualBase.id,title:'Révisions',pgn:'[Event "Révisions"]\n[White "Bien"]\n[Black "Révisions"]\n[Result "*"]\n\n{Bien} 1. e4 {Bien} *'});
  let queue=await json('/api/bases/'+bilingualBase.id+'/queue?all=true');
  assert.equal(queue.cards.length,1);assert.equal(queue.cards[0].settings.multipliers.hard,2.5);
  const grade=async card=>json('/api/reviews/'+encodeURIComponent(card.id)+'/grade','POST',{grade:1,elapsed_ms:1000,request_id:randomUUID(),content_key:card.content_key});
  const first=await grade(queue.cards[0]);assert.equal(first.interval_days,2);assert.equal(first.state,'learned');
  queue=await json('/api/bases/'+bilingualBase.id+'/queue?all=true');const second=await grade(queue.cards[0]);assert.equal(second.interval_days,5,'The global multiplier saved through the form must affect scheduling');
  report.multiplierResult={factor:prefs.review_multipliers.hard,first:first.interval_days,second:second.interval_days};
  await nav('library');await page.locator('[data-base="'+bilingualBase.id+'"]').click();
  assert((await page.locator('#main').innerText()).includes('Révisions'));
  await page.locator('[data-et-action="open"][data-et-id="'+bilingualGame.id+'"]').first().click();await page.locator('#move-list').waitFor();
  assert((await page.locator('.analysis-reading-controls>summary').textContent()).includes('Display'));
  assert((await page.locator('[data-action="make-exercise"]').textContent()).includes('Exercise'));
  assert((await page.locator('[data-action="metadata"]').textContent()).includes('PGN info'));
  assert((await page.locator('.analysis-tool-tabs [data-analysis-tool="repertoire"]').textContent()).includes('Repertoire'));
  await selectMove('0');await annotations();assert.equal(await page.locator('#annotation-form textarea').inputValue(),'Bien');
  await page.locator('#annotation-form textarea').fill('Révisions — Bien');
  await page.reload();await resumeDraft('document:entry:'+bilingualGame.id);await page.locator('#move-list').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'),'en');assert((await page.locator('.top-nav [data-page="reviews"]').textContent()).includes('Reviews'));
  await selectMove('0');await annotations();assert.equal(await page.locator('#annotation-form textarea').inputValue(),'Révisions — Bien');
  const unchanged=await json('/api/entries/'+bilingualGame.id);assert.equal(unchanged.title,'Révisions');assert.equal(unchanged.headers.White,'Bien');assert(unchanged.pgn.includes('{ Bien }')||unchanged.pgn.includes('{Bien}'));assert(!unchanged.pgn.includes('Révisions — Bien'),'Changing language and reloading must not commit an annotation draft');
  for(const size of [{width:1440,height:900},{width:390,height:844}]){await page.setViewportSize(size);await page.waitForTimeout(200);await capture('english-analysis-'+size.width+'x'+size.height);}
  await page.setViewportSize({width:1440,height:900});await manageDrafts();
  const deleteSaved=page.locator('[data-delete-workspace="document:entry:'+bilingualGame.id+'"]');assert.equal(await deleteSaved.textContent(),'×');assert.match(await deleteSaved.getAttribute('aria-label'),/^Delete.*Révisions/);
  let deletionPrompt='';page.once('dialog',async dialog=>{deletionPrompt=dialog.message();await dialog.accept();});await deleteSaved.click();
  await page.waitForFunction(()=>document.querySelector('#notices')?.textContent.includes('Draft deleted.'));assert(deletionPrompt.startsWith('Delete this draft'));
  await dismissModal();assert.equal((await json('/api/entries/'+bilingualGame.id)).pgn,unchanged.pgn);
  assert(!(await json('/api/workspace')).items.some(item=>item.key==='document:entry:'+bilingualGame.id||item.key==='annotation:entry:'+bilingualGame.id));
  await json('/api/entries','POST',{base_id:bilingualBase.id,title:'Révisions',pgn:unchanged.pgn});
  await page.setViewportSize({width:1440,height:900});await nav('reviews');
  await page.locator('[data-review-view="bases"]').click();await page.locator('[data-learn="'+bilingualBase.id+'"]:visible').waitFor();
  assert.equal(await page.locator('#review-panel-bases>.review-progress-legend').locator('li').count(),4);
  report.unlearnedColors=await page.locator('.review-progress-unlearned').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).backgroundColor));assert(report.unlearnedColors.length>0);assert(report.unlearnedColors.every(color=>color==='rgb(150, 150, 150)'));
  for(const size of [{width:1440,height:900},{width:390,height:844}]){await page.setViewportSize(size);await page.waitForTimeout(200);await capture('english-review-overview-'+size.width+'x'+size.height,{boardRequired:false});}
  await page.locator('[data-learn="'+bilingualBase.id+'"]:visible').click();await page.locator('#modal button[type="submit"]').click();await page.locator('#review-board').waitFor();
  assert.equal(await page.locator('.review-page .page-title h1').textContent(),'Révisions');assert.equal(await page.locator('#reveal-answer').textContent(),'Show answer');await page.locator('#reveal-answer').click();await page.waitForFunction(()=>document.querySelector('#solution-panel .explanation')?.textContent==='Bien');assert((await page.locator('#solution-panel').textContent()).includes('Bien'));
  assert.equal(await page.locator('#grade-panel [data-grade="1"]').textContent(),'Hard');assert(!(await page.locator('.attempt-counts').innerText()).match(/erreur|aide/));
  for(const size of [{width:1440,height:900},{width:390,height:844}]){await page.setViewportSize(size);await page.waitForTimeout(200);await capture('english-review-'+size.width+'x'+size.height);}
  await page.setViewportSize({width:1440,height:900});await nav('settings');await settingsTab('general');await page.locator('#interface-language').selectOption('fr');
  await page.waitForFunction(()=>document.documentElement.lang==='fr'&&document.querySelector('.top-nav .navigation-group:has([data-page="library"])>summary')?.textContent.includes('Bibliothèque'));
  await waitJson('/api/preferences',data=>data.language==='fr');await settingsTab('reviews');
  assert.equal(await page.locator('#review-preferences [name="multiplier_hard"]').inputValue(),'2.5');assert.equal(await page.locator('#review-preferences [name="auto_mastery_days"]').inputValue(),'240');
 });

 await check('Nouveaux réglages : journée, objectifs, ressources, sauvegarde vérifiée et démarrage',async()=>{
  await nav('settings');await settingsTab('reviews');await page.locator('#learning-preferences').waitFor();
  await page.locator('#learning-preferences [name="timezone"]').fill('America/Toronto');
  await page.locator('#learning-preferences [name="start_hour"]').fill('4');
  await page.locator('#learning-preferences [name="minutes"]').fill('15');await page.locator('#learning-preferences [name="cards"]').fill('3');
  await page.locator('#learning-preferences button[type="submit"]').click();
  await waitJson('/api/preferences',p=>p.study_day.timezone==='America/Toronto'&&p.study_day.start_hour===4&&p.review_session_defaults.cards===3);
  const details=page.locator('details').filter({has:page.locator('[data-defaults-preview]')});await details.locator('summary').click();
  await page.locator('[data-default-base="'+practice.id+'"]').check();await page.locator('[data-defaults-preview]').click();
  await page.locator('#modal button[type="submit"]').waitFor();assert((await page.locator('#modal').innerText()).includes('Exercices de test'));
  await page.locator('#modal button[type="submit"]').click();await page.locator('#modal[open]').waitFor({state:'hidden'});assert.equal((await json('/api/library')).bases.find(b=>b.id===practice.id).settings.new_limit,10);
  await settingsTab('performance');await page.locator('#resource-settings select[name="profile"]').selectOption('economy');await page.locator('#resource-settings button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-resource-result]')?.textContent.includes('enregistrés'));
  const resources=await json('/api/resource-settings');assert.equal(resources.settings?.profile??resources.profile,'economy');
  await settingsTab('backups');await page.locator('[data-backup-create]').click();await page.waitForFunction(()=>document.querySelector('[data-backup-result]')?.textContent.includes('créée et vérifiée'));
  await page.locator('[data-backup-verify]').first().click();await page.waitForFunction(()=>document.querySelector('[data-backup-result]')?.textContent.includes('Sauvegarde valide'));
  await settingsTab('general');await page.locator('#startup-preferences [name="page"]').selectOption('library');await page.locator('#startup-preferences [name="resume"]').selectOption('never');await page.locator('#startup-preferences button[type="submit"]').click();
  await page.goto(url);await page.locator('#library-content').waitFor();assert.equal(await page.locator('#modal[open]').count(),0);
  await nav('settings');await settingsTab('general');assert.equal(await page.locator('#startup-preferences [name="resume"]').inputValue(),'never');
  assert.equal(await page.locator('#startup-preferences [name="resume"] option[value="ask"]').count(),0,'Automatic startup prompts are no longer offered');
  for(const size of [{width:1440,height:900},{width:390,height:844}]){await page.setViewportSize(size);await capture('settings-new-'+size.width+'x'+size.height,{boardRequired:false});}
  await page.setViewportSize({width:1440,height:900});
 });
 await check('Onglets des réglages : clavier, saisie conservée, reprise et vues PC/mobile',async()=>{
  await page.setViewportSize({width:1440,height:900});if(process.env.CHESSGYM_BROWSER_CHECK)await json('/api/backups/create','POST',{});await nav('settings');
  const ids=['general','appearance','sounds','reviews','engines','installation','performance','backups'];
  assert.deepEqual(await page.locator('[data-settings-tab]').evaluateAll(nodes=>nodes.map(n=>n.dataset.settingsTab)),ids);
  for(const id of ids){
   const button=page.locator('[data-settings-tab="'+id+'"]');assert.equal(await button.getAttribute('role'),'tab');
   const panel=page.locator('[data-settings-panel="'+id+'"]');assert.equal(await panel.getAttribute('role'),'tabpanel');
   assert.equal(await button.getAttribute('aria-controls'),await panel.getAttribute('id'));
  }
  await settingsTab('reviews');const draftField=page.locator('#review-preferences [name="auto_mastery_days"]');
  const original=await draftField.inputValue();await draftField.fill('333');
  await page.evaluate(()=>{window.settingsDraftNode=document.querySelector('#review-preferences [name="auto_mastery_days"]');});
  for(const id of ids){await settingsTab(id);assert.equal(await page.locator('[data-settings-panel]:visible').count(),1);}
  await settingsTab('appearance');await page.locator('[data-theme-choice="sage"]').click();await waitJson('/api/preferences',data=>data.theme==='sage');
  await page.locator('[data-theme-choice="copper"]').click();await waitJson('/api/preferences',data=>data.theme==='copper');
  await settingsTab('reviews');assert.equal(await draftField.inputValue(),'333');
  assert(await page.evaluate(()=>window.settingsDraftNode===document.querySelector('#review-preferences [name="auto_mastery_days"]')));
  assert.equal((await json('/api/preferences')).auto_mastery_days,Number(original),'Changing tabs must not save the form');
  await draftField.fill(original);
  await settingsTab('general');const first=page.locator('[data-settings-tab="general"]');await first.focus();
  for(const [key,id]of [['ArrowRight','appearance'],['ArrowLeft','general'],['End','backups'],['Home','general']]){
   await page.keyboard.press(key);await page.waitForFunction(id=>document.activeElement?.dataset.settingsTab===id,id);
   assert.equal(await page.locator('[data-settings-tab="'+id+'"]').getAttribute('aria-selected'),'true');
   assert.equal(await page.locator('[data-settings-panel="'+id+'"]').isVisible(),true);
  }
  await settingsTab('performance');await page.reload();await noStartupPopup();
  await page.locator('[data-settings-panel="performance"]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-settings-tab="performance"]').getAttribute('aria-selected'),'true');
  await page.evaluate(()=>document.documentElement.dataset.touchComfort='true');
  for(const size of [{width:1440,height:900},{width:390,height:844}]){
   await page.setViewportSize(size);
   for(const id of ids){
    await settingsTab(id);const geometry=await capture('settings-tab-'+id+'-'+size.width+'x'+size.height,{boardRequired:false});
    const panel=await page.locator('[data-settings-panel="'+id+'"]').boundingBox();
    assert(panel&&panel.x>=-1&&panel.x+panel.width<=geometry.viewport.width+1,'Settings panel extends beyond viewport: '+id);
   }
  }
  await page.setViewportSize({width:390,height:844});await settingsTab('reviews');
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));
  await settingsTab('backups');
  report.settingsTabScroll=await page.evaluate(()=>({scrollY,tabBottom:document.querySelector('.settings-tabs').getBoundingClientRect().bottom,panelTop:document.querySelector('[data-settings-panel="backups"]').getBoundingClientRect().top}));
  await capture('settings-tab-scroll-transition-390x844',{boardRequired:false});
  assert(report.settingsTabScroll.panelTop>=report.settingsTabScroll.tabBottom-1,'The newly selected settings panel starts behind the sticky tabs');
  await page.evaluate(()=>window.scrollTo(0,0));await page.setViewportSize({width:1440,height:900});
 });
 await check('60 parties : pagination, sélection multi-pages, navigation puis révision par lots et reprise',async()=>{
  const batch=await json('/api/bases','POST',{name:'Lot de 60 exercices',settings:{review_enabled:true,type:'solve',mode:'hybrid',new_limit:null,new_order:'pgn'}});
  const pgn=Array.from({length:60},(_,i)=>'[Event "Exercice '+String(i+1).padStart(2,'0')+'"]\n[Date "2026.10.22"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 *').join('\n\n');
  const imported=await json('/api/bases/'+batch.id+'/import','POST',{pgn});assert.equal(imported.imported,60);
  await nav('library');await page.locator('[data-base="'+batch.id+'"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-et-row]').length===50);
  const first=await page.locator('[data-et-row]').first().getAttribute('data-et-row');await page.locator('[data-et-select="'+first+'"]').check();
  await page.locator('[data-et-action="page-next"]').click();await page.waitForFunction(()=>document.querySelectorAll('[data-et-row]').length===10);
  const fiftyFirst=await page.locator('[data-et-row]').first().getAttribute('data-et-row');await page.locator('[data-et-select="'+fiftyFirst+'"]').check();assert((await page.locator('[data-et-selection]').innerText()).includes('2 sélectionnées'));
  await page.locator('[data-et-action="open"][data-et-id="'+fiftyFirst+'"]').first().click();await page.waitForFunction(()=>document.querySelector('.analysis-entry-counter')?.textContent==='51 / 60');
  await page.locator('[data-action="entry-prev"]:visible').click();await page.waitForFunction(()=>document.querySelector('.analysis-entry-counter')?.textContent==='50 / 60');
  await page.locator('#game-analysis [data-work-action="analyse"]').waitFor({state:'attached'});await page.waitForFunction(()=>!document.querySelector('#game-analysis [data-work-action="analyse"]')?.disabled);await selectMove('0');await page.evaluate(()=>window.testMoveNode=document.querySelector('#move-list [data-path="0"]'));await selectMove('0.0');assert(await page.evaluate(()=>window.testMoveNode===document.querySelector('#move-list [data-path="0"]')));
  await page.goto(url+'/#/reviews');await dismissModal();await page.locator('[data-learn="'+batch.id+'"]:visible').click();
  await page.locator('#modal [name="cards"]').fill('1');await page.locator('#modal [name="minutes"]').fill('');await page.locator('#modal button[type="submit"]').click();await page.locator('#review-board').waitFor();
  await page.locator('#master-card').click();await page.locator('[data-session-continue]').waitFor();await page.locator('[data-session-continue]').click();
  for(let i=2;i<=21;i++){await page.waitForFunction(i=>document.querySelector('.review-page .eyebrow')?.textContent.includes(i+' / 60'),i);await page.locator('#master-card').click();}
  await page.waitForFunction(()=>document.querySelector('.review-page .eyebrow')?.textContent.includes('22 / 60'));
  const synced=await waitJson('/api/workspace',data=>{const s=data.items.find(i=>i.key==='review')?.data;return s?.session_id&&s.cards[s.index]?.session_index===21&&s.completed===21;});
  const before=synced.items.find(item=>item.key==='review').data;assert(before.cards.length<=20);assert.equal(before.completed,21);
  await page.reload();await resumeStoredReview();await page.waitForFunction(()=>document.querySelector('.review-page .eyebrow')?.textContent.includes('22 / 60'));
  const after=(await json('/api/workspace')).items.find(item=>item.key==='review').data;assert.equal(after.session_id,before.session_id);assert.equal(after.completed,21);
  await capture('batch-review-1440x900');await page.setViewportSize({width:390,height:844});await capture('batch-review-390x844');
 });
 assert(report.checks.length>0,'No browser scenario matched');
 assert.deepEqual(report.errors,[],'Unexpected browser runtime errors');
 assert.deepEqual(report.externalRequests,[],'Unexpected external requests');
 report.status='passed';
}catch(error){
 report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};
 await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});
 console.error(error.stack);
 process.exitCode=1;
}finally{
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
 await context.close();
 console.log(JSON.stringify(report,null,2));
}

