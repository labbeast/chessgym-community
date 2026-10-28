import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only isolated loopback fixtures may be tested');
const report={status:'running',checks:[],geometry:[],errors:[],consoleErrors:[],externalRequests:[],sourceMutations:[],confirmations:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,hasTouch:process.env.CHESSGYM_TEST_TOUCH==='1',viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
await context.addInitScript(()=>localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'never'})));
const page=await context.newPage();page.setDefaultTimeout(15000);
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push(message.text());});
page.on('dialog',async dialog=>{report.confirmations.push(dialog.message());await dialog.accept();});
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
page.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
await context.route('**/*',async route=>{
 const parsed=new URL(route.request().url());if(parsed.origin!==url)return route.abort();
 if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
 if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
 if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test isolé.'}});
 return route.continue();
});
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.status()===204?null:response.json();}
async function waitJson(path,predicate){const end=Date.now()+15000;do{const value=await json(path);if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw Error('Timed out waiting for '+path);}
async function check(name,action){await action();report.checks.push(name);console.log('PASS '+name);}
async function menu(){
 let host=page.locator('details[data-board-menu]:visible').first();
 if(!await host.count()){
  const mobile=page.locator('.mobile-navigation');if(!await mobile.getAttribute('open'))await mobile.locator(':scope > summary').click();
  host=page.locator('details[data-board-menu]:visible').first();
 }
 await host.waitFor({state:'visible'});if(await host.getAttribute('open')===null)await host.locator(':scope > summary').click();
 await host.locator('[data-board-menu-content]').waitFor({state:'visible'});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));return host;
}
async function command(name){const host=await menu();await host.locator('[data-board-command="'+name+'"]').click();}
async function library(){await page.locator('.brand[data-page="library"]').click();await page.locator('[data-base]').first().waitFor();}
async function openRecent(identity){const host=await menu();await host.locator('[data-board-recent="'+identity+'"]').click();await page.locator('#board-host .chess-board').waitFor();}
async function openGame(baseId,id){await library();await page.locator('[data-base="'+baseId+'"]').click();await page.locator('[data-et-action="open"][data-et-id="'+id+'"]').first().click();await page.locator('#board-host .chess-board').waitFor();}
async function selectMove(path){await page.locator('#move-list [data-path="'+path+'"]').click();await page.waitForFunction(path=>document.querySelector('#move-list .current')?.dataset.path===path,path);}
async function annotate(value){
 if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]:visible');if(await toggle.count())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}
 await page.locator('#annotation-form textarea').waitFor({state:'visible'});if(value!==undefined)await page.locator('#annotation-form textarea').fill(value);return page.locator('#annotation-form textarea');
}
async function capture(name){
 const host=await menu();await twoLineRows(name,host);await page.screenshot({path:join(output,name+'.png'),fullPage:true});await host.locator('[data-board-menu-content]').screenshot({path:join(output,name+'-menu.png')});
 const geometry=await host.evaluate(node=>{const rect=node.querySelector('[data-board-menu-content]').getBoundingClientRect();return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,left:rect.left,right:rect.right,width:rect.width,height:rect.height,bodyText:node.textContent.trim()};});
 report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.viewport+1,name+': horizontal overflow');assert(geometry.left>=-1&&geometry.right<=geometry.viewport+1,name+': menu is outside viewport');
}
async function twoLineRows(name,host){
 const layout=await host.evaluate(node=>{
  const rect=element=>{if(!element)return null;const box=element.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height};};
  const line=element=>element?{...rect(element),lineHeight:parseFloat(getComputedStyle(element).lineHeight),whiteSpace:getComputedStyle(element).whiteSpace,overflow:getComputedStyle(element).overflow,textOverflow:getComputedStyle(element).textOverflow,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth,title:element.title,text:element.textContent}:null;
  const list=node.querySelector('.board-recent-list'),current=node.querySelector('[data-board-command="current"]'),actions=node.querySelector('.board-menu-actions');
  return {touch:matchMedia('(pointer:coarse)').matches,currentCount:node.querySelectorAll('[data-board-command="current"]').length,currentFirst:current===list?.firstElementChild?.querySelector('.board-recent-row'),currentIdentity:current?.closest('[data-board-draft]')?.dataset.boardDraft,identities:[...list.querySelectorAll('[data-board-recent]')].map(row=>row.dataset.boardRecent),sectionLabel:!!node.querySelector('.board-menu-label'),actionBorders:actions?[getComputedStyle(actions).borderTopWidth,getComputedStyle(actions).borderBottomWidth]:[],rows:[...list.querySelectorAll('.board-recent-row')].map(row=>({current:row===current,childCount:row.childElementCount,gridRows:getComputedStyle(row).gridTemplateRows.split(' '),title:line(row.querySelector('.board-recent-title')),heading:line(row.querySelector('.board-recent-heading')),meta:line(row.querySelector('.board-recent-meta')),context:line(row.querySelector('.board-recent-context')),draft:line(row.querySelector('.board-recent-draft')),time:line(row.querySelector('time')),options:rect(row.parentElement.querySelector('.board-draft-options')),row:rect(row)}))};
 });
 assert.equal(layout.currentCount,1,name+': current board appears once');assert(layout.currentFirst,name+': current board is first in Recently opened');assert(!layout.sectionLabel,name+': no separate Current board section');
 assert(layout.actionBorders.every(border=>parseFloat(border)===0),name+': no section separators before Recently opened');
 assert.equal(new Set(layout.identities).size,layout.identities.length,name+': no duplicate recent');if(layout.currentIdentity)assert(!layout.identities.includes(layout.currentIdentity),name+': current draft is not duplicated');
 const timeRights=[];
 for(const [index,row] of layout.rows.entries()){
  const label=name+' row '+index;assert(row.heading&&row.meta,label+': exactly two row wrappers');assert.equal(row.childCount,2,label+': only two row wrappers');assert.equal(row.gridRows.length,2,label+': exactly two grid rows');
  assert(row.meta.height<=row.meta.lineHeight+1,label+': metadata stays on one visual line');
  assert(row.heading.bottom<=row.meta.top+1,label+': metadata follows the title');
  assert(row.title.height<=row.title.lineHeight+1,label+': title cannot wrap');assert.equal(row.title.whiteSpace,'nowrap',label+': long title never wraps');assert.equal(row.title.textOverflow,'ellipsis',label+': long title truncates');
  if(row.title.scrollWidth>row.title.clientWidth+1)assert.equal(row.title.title,row.title.text,label+': full title available on hover');
  if(row.context){assert(row.context.height<=row.meta.height+1,label+': context cannot create a third line');assert(row.context.top>=row.meta.top-1&&row.context.bottom<=row.meta.bottom+1,label+': context belongs to second line');if(row.context.scrollWidth>row.context.clientWidth+1)assert.equal(row.context.title,row.context.text,label+': full context available on hover');}
  if(row.draft)assert(row.draft.top>=row.meta.top-1&&row.draft.bottom<=row.meta.bottom+1,label+': draft status belongs to second line');
  if(row.time){assert(row.time.top>=row.meta.top-1&&row.time.bottom<=row.meta.bottom+1,label+': date belongs to second line');assert(row.time.height<=row.meta.height+1,label+': date cannot wrap');timeRights.push(row.time.right);}
  if(row.options){assert(row.title.right<=row.options.left+1,label+': title clears the draft menu');assert(row.options.bottom<=row.meta.top+1,label+': draft menu clears the second line');if(layout.touch)assert(row.options.height>=44&&row.options.width>=44,label+': touch actions remain reachable');}
 }
 if(timeRights.length>1)assert(Math.max(...timeRights)-Math.min(...timeRights)<=1,name+': every timestamp shares the same right edge, including drafts');
 report.geometry.push({name:name+'-rows',...layout});return layout;
}
async function recentRows(){const host=await menu();return host.locator('[data-board-recent]').evaluateAll(nodes=>nodes.map(node=>({identity:node.dataset.boardRecent,title:node.querySelector('.board-recent-title')?.textContent,context:node.querySelector('.board-recent-context')?.textContent,draft:!!node.querySelector('.board-recent-draft'),date:node.querySelector('time')?.getAttribute('datetime'),when:node.querySelector('time')?.textContent})));}
async function reloadLibrary(){await page.goto(url+'/#/library');await page.reload();await page.locator('[data-base]').first().waitFor();}

try{
 await json('/api/setup-resources/complete','POST',{});
 const base=await json('/api/bases','POST',{name:'Cours <échecs> & théorie — contexte volontairement très long pour vérifier la deuxième ligne',settings:{}}),games=[];
 for(let i=1;i<=3;i++)games.push(await json('/api/entries','POST',{base_id:base.id,title:'Partie 0'+i+' <test> & annotations — titre volontairement très long pour vérifier son affichage sur une ligne',pgn:'[Event "Tournoi de test"]\n[White "Joueur '+i+'"]\n[Black "Adversaire"]\n[Result "*"]\n\n1. e4 {Idée source.} e5 2. Nf3 Nc6 *'}));
 const originals=await Promise.all(games.map(game=>json('/api/entries/'+game.id)));
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();
 await check('Menu initial et nouvel échiquier sans créer un faux brouillon',async()=>{
  await command('new');await page.locator('#board-host .chess-board').waitFor();assert.equal(await page.locator('#move-list [data-path]').count(),0);
  const host=await menu();assert.equal(await host.locator('[data-board-command="current"]').count(),1);assert.equal(await host.locator('[data-board-recent]').count(),0);
  await capture('board-menu-pristine-fr-desktop');await page.keyboard.press('Escape');
 });
 await check('Partie enregistrée : titre, base et indice exact sans marquage brouillon',async()=>{
  await openGame(base.id,games[2].id);await page.waitForFunction(()=>document.querySelector('.analysis-entry-counter')?.textContent==='3 / 3');
  const host=await menu(),current=host.locator('[data-board-command="current"]');await page.waitForFunction(()=>[...document.querySelectorAll('[data-board-command="current"]')].some(node=>node.textContent.includes('Partie 3 sur 3')));assert((await current.innerText()).includes(games[2].title));assert((await current.innerText()).includes(base.name));assert.match(await current.innerText(),/Partie 3 sur 3/);assert.equal(await current.locator('.board-recent-draft').count(),0);
  assert.equal(await host.locator('[data-board-menu-content] img').count(),0,'User labels remain escaped text');await capture('board-menu-saved-fr-desktop');await page.keyboard.press('Escape');
 });
 const savedNote='Annotation du coup saisie, mais non appliquée <à conserver>';
 await check('Nouveau conserve les annotations non appliquées de la partie enregistrée',async()=>{
  await selectMove('0');await annotate(savedNote);await library();await command('current');await page.locator('#board-host .chess-board').waitFor();assert.equal(await page.locator('#move-list .current').getAttribute('data-path'),'0');assert.equal(await (await annotate()).inputValue(),savedNote);await command('new');await page.locator('#board-host .chess-board').waitFor();assert.equal(await page.locator('#move-list [data-path]').count(),0);
  const rows=await recentRows(),row=rows.find(item=>item.identity==='entry:'+games[2].id);assert(row);assert.equal(row.draft,true);assert.equal(row.title,games[2].title);assert(row.context.includes(base.name));assert(row.date&&Number.isFinite(Date.parse(row.date)));assert(row.when.trim());
  await openRecent(row.identity);await selectMove('0');assert.equal(await (await annotate()).inputValue(),savedNote);
  assert.equal((await json('/api/entries/'+games[2].id)).pgn,originals[2].pgn);
 });
 await check('Récents enregistrés et navigation précédent/suivant gardent le bon contexte',async()=>{
  await openGame(base.id,games[1].id);await page.waitForFunction(()=>document.querySelector('.analysis-entry-counter')?.textContent==='2 / 3');
  await openRecent('entry:'+games[2].id);await page.waitForFunction(()=>document.querySelector('.analysis-entry-counter')?.textContent==='3 / 3');
  await page.locator('[data-action="entry-prev"]:visible').click();await page.waitForFunction(()=>document.querySelector('.analysis-entry-counter')?.textContent==='2 / 3');
  await command('new');await library();const rows=await recentRows();assert(rows.some(item=>item.identity==='entry:'+games[1].id));assert.equal(rows.filter(item=>item.identity==='entry:'+games[2].id).length,1);
 });
 let freeIdentity;
 const freeNote='Idée libre non appliquée — protéger ce brouillon';
 await check('Nouvelle analyse libre, Nouveau puis reprise : coups et commentaire conservés',async()=>{
  await command('new');await page.locator('#board-host .chess-board').waitFor();
  await page.locator('#board-host [data-square="e2"]').click();await page.locator('#board-host [data-square="e4"]').click();await page.locator('#move-list [data-path="0"]').waitFor();await annotate(freeNote);
  const data=await waitJson('/api/workspace',data=>data.items.some(item=>item.key.startsWith('annotation:free:')&&item.data?.nodes?.['0']?.comment===freeNote));
  freeIdentity=data.items.find(item=>item.key.startsWith('annotation:free:')&&item.data?.nodes?.['0']?.comment===freeNote).key.slice('annotation:'.length);
  await command('new');assert.equal(await page.locator('#move-list [data-path]').count(),0);
  const row=(await recentRows()).find(item=>item.identity===freeIdentity);assert(row?.draft);await openRecent(freeIdentity);await page.locator('#move-list [data-path="0"]').waitFor();assert.equal(await (await annotate()).inputValue(),freeNote);
  await capture('board-menu-drafts-fr-desktop');await page.keyboard.press('Escape');
 });
 await check('Rechargement conserve les récents et permet de reprendre les brouillons',async()=>{
  await library();await waitJson('/api/workspace',data=>data.items.some(item=>item.key==='document:'+freeIdentity));await reloadLibrary();
  const rows=await recentRows();assert(rows.some(item=>item.identity===freeIdentity));assert(rows.some(item=>item.identity==='entry:'+games[2].id));
  await openRecent(freeIdentity);await page.locator('#move-list [data-path="0"]').waitFor();assert.equal(await (await annotate()).inputValue(),freeNote);
  await openRecent('entry:'+games[2].id);await selectMove('0');assert.equal(await (await annotate()).inputValue(),savedNote);
 });
 await check('Le catalogue des récents et les brouillons restent séparés lors d’un changement d’identité',async()=>{
  await library();await page.waitForLoadState('networkidle');await json('/__test__/workspace-identity','POST',{other:true});await reloadLibrary();
  assert.equal((await recentRows()).length,0);assert.equal((await json('/api/workspace')).items.length,0);
  await command('new');assert.equal(await page.locator('#move-list [data-path]').count(),0);
  await json('/__test__/workspace-identity','POST',{other:false});await reloadLibrary();assert((await recentRows()).some(item=>item.identity===freeIdentity));
 });
 await check('Mobile français et anglais : menu lisible, commandes accessibles et fermeture clavier',async()=>{
  await page.setViewportSize({width:390,height:844});await capture('board-menu-fr-mobile');await page.keyboard.press('Escape');
  await json('/api/preferences','PATCH',{language:'en'});await reloadLibrary();const host=await menu();assert.match(await host.innerText(),/Recently opened/i);assert.match(await host.innerText(),/New/i);await capture('board-menu-en-mobile');
  await host.locator('[data-board-command="new"]').focus();await page.keyboard.press('Tab');assert(await page.evaluate(()=>!!document.activeElement?.closest('[data-board-menu]')));await page.keyboard.press('End');assert(await page.evaluate(()=>document.activeElement?.dataset.boardCommand==='manage'));await page.keyboard.press('Home');assert(await page.evaluate(()=>document.activeElement?.tagName==='SUMMARY'));await page.keyboard.press('Escape');
  assert.equal(await host.getAttribute('open'),null);assert(await host.locator(':scope > summary').evaluate(node=>document.activeElement===node));
  await page.setViewportSize({width:320,height:568});await capture('board-menu-en-mobile-narrow');await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:900});await capture('board-menu-en-desktop');await page.keyboard.press('Escape');
 });
 await check('Sauvegarder l’analyse libre remplace le récent brouillon par la partie enregistrée',async()=>{
  assert.deepEqual(report.sourceMutations,[],'The menu never writes a saved PGN');
  await openRecent(freeIdentity);await page.locator('[data-action="save-board"]:visible').first().click();await page.locator('#modal[open]').waitFor();
  await page.locator('#modal [name="base_id"]').selectOption(String(base.id));await page.locator('#modal [name="title"]').fill('Analyse libre sauvegardée');await page.locator('#modal button[type="submit"]').click();
  await page.waitForFunction(()=>document.querySelector('.analysis-page h1')?.textContent==='Analyse libre sauvegardée');
  const entries=await json('/api/bases/'+base.id+'/entries'),saved=entries.entries.find(item=>item.title==='Analyse libre sauvegardée');assert(saved);assert((await json('/api/entries/'+saved.id)).pgn.includes(freeNote));
  await command('new');const rows=await recentRows();assert(!rows.some(item=>item.identity===freeIdentity),'The saved free draft must not remain as an unusable recent');assert(rows.some(item=>item.identity==='entry:'+saved.id&&!item.draft));
 });
 await check('Le menu Travail conservé reste disponible et les PGN originaux sont inchangés',async()=>{
  await command('manage');await page.locator('#modal[open]').waitFor();await page.locator('#modal [data-close]').first().click();
  for(let i=0;i<games.length;i++){const current=await json('/api/entries/'+games[i].id);for(const field of ['id','base_id','title','pgn','revision'])assert.deepEqual(current[field],originals[i][field],`Preserved ${field} for fixture ${games[i].id}`);}
  assert.deepEqual(report.sourceMutations,[{method:'POST',path:'/api/entries'}],'Only explicit Save creates one new game');assert.deepEqual(report.confirmations,[],'Board menu navigation never asks to discard a preserved draft');assert.deepEqual(report.errors,[]);assert.deepEqual(report.consoleErrors,[]);assert.deepEqual(report.externalRequests,[]);
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify(report,null,2));}
