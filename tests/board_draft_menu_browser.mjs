import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only isolated loopback fixtures may be tested');
const report={status:'running',checks:[],geometry:[],errors:[],consoleErrors:[],expectedFailures:[],externalRequests:[],sourceMutations:[],confirmations:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
await context.addInitScript(()=>localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'never'})));
const page=await context.newPage();page.setDefaultTimeout(15000);
let nextConfirmation=null,missingSource=null,failNextWorkspaceDelete=false;
page.on('pageerror',error=>report.errors.push(String(error)));
page.on('console',message=>{if(message.type()==='error')report.consoleErrors.push({text:message.text(),url:message.location().url});});
page.on('dialog',async dialog=>{const accepted=nextConfirmation===true;report.confirmations.push({message:dialog.message(),accepted,expected:nextConfirmation!==null});nextConfirmation=null;await (accepted?dialog.accept():dialog.dismiss());});
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
page.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
await context.route('**/*',async route=>{
 const request=route.request(),parsed=new URL(request.url());if(parsed.origin!==url)return route.abort();
 if(missingSource&&parsed.pathname==='/api/entries/'+missingSource&&request.method()==='GET'){report.expectedFailures.push({url:request.url(),status:404});return route.fulfill({status:404,json:{detail:'Partie source indisponible dans ce test.'}});}
 if(failNextWorkspaceDelete&&parsed.pathname.startsWith('/api/workspace/')&&request.method()==='DELETE'){failNextWorkspaceDelete=false;report.expectedFailures.push({url:request.url(),status:409});return route.fulfill({status:409,json:{detail:'Version du brouillon modifiée pendant le test.'}});}
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
 if(!await host.count()){const mobile=page.locator('.mobile-navigation');if(await mobile.getAttribute('open')===null)await mobile.locator(':scope > summary').click();host=page.locator('details[data-board-menu]:visible').first();}
 await host.waitFor({state:'visible'});if(await host.getAttribute('open')===null)await host.locator(':scope > summary').click();
 await host.locator('[data-board-menu-content]').waitFor({state:'visible'});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));return host;
}
async function command(name){
 if(name==='library'){await page.locator('.brand[data-page="library"]:visible').click();await page.locator('[data-base]').first().waitFor();return;}
 await (await menu()).locator('[data-board-command="'+name+'"]').click();
}
async function openRecent(identity){await (await menu()).locator('[data-board-recent="'+identity+'"]').click();await page.locator('#board-host .chess-board').waitFor();}
async function openGame(baseId,id){await command('library');await page.locator('[data-base="'+baseId+'"]').click();await page.locator('[data-et-action="open"][data-et-id="'+id+'"]').first().click();await page.locator('#board-host .chess-board').waitFor();}
async function selectMove(path){await page.locator('#move-list [data-path="'+path+'"]').click();await page.waitForFunction(path=>document.querySelector('#move-list .current')?.dataset.path===path,path);}
async function annotate(value){if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]:visible');if(await toggle.count())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}const field=page.locator('#annotation-form textarea');await field.waitFor({state:'visible'});if(value!==undefined)await field.fill(value);return field;}
async function draftItem(identity){return (await menu()).locator('.board-recent-item[data-board-draft="'+identity+'"]');}
async function draftMenu(identity,{method='right'}={}){
 const item=await draftItem(identity);await item.waitFor({state:'visible'});
 if(method==='options')await item.locator('[data-board-draft-options="'+identity+'"]').click();
 else if(method==='keyboard'){await item.locator('.board-recent-row').focus();await page.keyboard.press('Shift+F10');}
 else await item.click({button:'right'});
 const action=page.locator('[data-board-draft-action="rename"]:visible');await action.waitFor({state:'visible'});return action.locator('..');
}
async function rename(identity,name,{cancel=false,method='right'}={}){await draftMenu(identity,{method});await page.locator('[data-board-draft-action="rename"]:visible').click();const modal=page.locator('#modal[open]');await modal.locator('[name="draft_name"]').fill(name);if(cancel)await modal.locator('[data-close]').first().click();else await modal.locator('button[type="submit"]').click();await modal.waitFor({state:'hidden'});}
async function deleteDraft(identity,{accept=true,method='right'}={}){await draftMenu(identity,{method});nextConfirmation=accept;await page.locator('[data-board-draft-action="delete"]:visible').click();await page.waitForFunction(()=>!document.querySelector('[data-board-draft-action="delete"]'));assert.equal(nextConfirmation,null,'Deleting a draft requires an explicit confirmation');}
async function draftTitle(identity){return (await draftItem(identity)).locator('.board-recent-title').innerText();}
async function noDraft(identity){
 const host=await menu();await host.locator('.board-recent-item[data-board-draft="'+identity+'"]').waitFor({state:'detached'});
 assert.equal((await localItem('document:'+identity))?.data??null,null,'The deleted document draft is removed from local storage');
 assert.equal((await localItem('annotation:'+identity))?.data??null,null,'The deleted annotation draft is removed from local storage');
}
async function reloadLibrary(){await page.goto(url+'/#/library');await page.reload();await page.locator('[data-base]').first().waitFor();}
async function capture(name){const host=await menu();if(await page.locator('.mobile-navigation').isVisible())await host.evaluate(node=>node.querySelector('[data-board-command="manage"]').scrollIntoView({block:'end'}));await page.screenshot({path:join(output,name+'.png'),fullPage:true});const geometry=await page.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth}));report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.viewport+1,'No horizontal overflow: '+name);}
async function localItem(key){return page.evaluate(key=>{for(let index=0;index<localStorage.length;index++){const storageKey=localStorage.key(index);if(storageKey.startsWith('chessgym-workspace-v1:')&&storageKey.endsWith(':slot:'+encodeURIComponent(key)))return JSON.parse(localStorage.getItem(storageKey));}return null;},key);}

try{
 await json('/api/setup-resources/complete','POST',{});
 const base=await json('/api/bases','POST',{name:'Base source <à préserver>',settings:{}}),games=[];
 for(let i=1;i<=3;i++)games.push(await json('/api/entries','POST',{base_id:base.id,title:'Partie source '+i,pgn:'[Event "Source originale '+i+'"]\n[White "Joueur"]\n[Black "Adversaire"]\n[Result "*"]\n\n1. e4 {Commentaire source.} e5 2. Nf3 Nc6 *'}));
 const originals=await Promise.all(games.map(game=>json('/api/entries/'+game.id)));
 const first='entry:'+games[0].id,second='entry:'+games[1].id,third='entry:'+games[2].id;
 const note='Annotation locale non appliquée — première partie',alias='Préparation <personnelle> & variante';
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();
 await check('Les parties enregistrées intactes n’exposent aucune action de brouillon',async()=>{await openGame(base.id,games[0].id);const host=await menu();assert.equal(await host.locator('[data-board-draft-options]').count(),0);assert.equal(await host.locator('.board-recent-item[data-board-draft]').count(),0);await page.keyboard.press('Escape');});
 await check('Renommer un brouillon enregistré préserve son PGN et ses annotations non appliquées',async()=>{
  await selectMove('0');await annotate(note);await rename(first,alias);assert.equal(await draftTitle(first),alias);await capture('board-draft-renamed-fr-desktop');await page.keyboard.press('Escape');assert.equal(await (await annotate()).inputValue(),note);assert.equal((await json('/api/entries/'+games[0].id)).title,originals[0].title);
  await command('new');assert.equal(await draftTitle(first),alias);await openRecent(first);await selectMove('0');assert.equal(await (await annotate()).inputValue(),note);
  await command('library');await page.waitForLoadState('networkidle');await reloadLibrary();assert.equal(await draftTitle(first),alias);await openRecent(first);await selectMove('0');assert.equal(await (await annotate()).inputValue(),note);
 });
 await check('Annuler le renommage et la suppression conserve le nom et le brouillon',async()=>{await rename(first,'Nom à annuler',{cancel:true});assert.equal(await draftTitle(first),alias);await deleteDraft(first,{accept:false});assert.equal(await draftTitle(first),alias);await page.keyboard.press('Escape');assert.equal(await (await annotate()).inputValue(),note);});
 await check('Supprimer le brouillon courant recharge la partie source sans modifier la base',async()=>{
  await deleteDraft(first);await noDraft(first);await page.keyboard.press('Escape');await page.locator('#board-host .chess-board').waitFor();await selectMove('0');assert.equal(await (await annotate()).inputValue(),'Commentaire source.');assert.equal(await page.locator('.analysis-page h1').innerText(),originals[0].title);
  await command('library');await reloadLibrary();await noDraft(first);await openRecent(first);await selectMove('0');assert.equal(await (await annotate()).inputValue(),'Commentaire source.');
 });
 await check('Supprimer un autre brouillon ne change pas le document ouvert',async()=>{
  await openGame(base.id,games[1].id);await selectMove('0');await annotate('Brouillon secondaire à retirer');await command('new');await openRecent(first);await selectMove('0.0');const before=await page.locator('#move-list').innerText();
  await deleteDraft(second);await noDraft(second);await page.keyboard.press('Escape');assert.equal(await page.locator('.analysis-page h1').innerText(),originals[0].title);assert.equal(await page.locator('#move-list').innerText(),before);assert.equal(await page.locator('#move-list .current').getAttribute('data-path'),'0.0');
 });
 let freeIdentity;
 await check('Le bouton mobile et le clavier donnent accès au même menu de brouillon',async()=>{
  await command('new');await page.locator('#board-host [data-square="e2"]').click();await page.locator('#board-host [data-square="e4"]').click();await page.locator('#move-list [data-path="0"]').waitFor();await annotate('Brouillon libre de test');
  const data=await waitJson('/api/workspace',value=>value.items.some(item=>item.key.startsWith('annotation:free:')&&item.data?.nodes?.['0']?.comment==='Brouillon libre de test'));freeIdentity=data.items.find(item=>item.key.startsWith('annotation:free:')&&item.data?.nodes?.['0']?.comment==='Brouillon libre de test').key.slice(11);
  await page.setViewportSize({width:390,height:844});await rename(freeIdentity,'Analyse mobile',{method:'options'});assert.equal(await draftTitle(freeIdentity),'Analyse mobile');await capture('board-draft-options-fr-mobile');await draftMenu(freeIdentity,{method:'options'});await page.screenshot({path:join(output,'board-draft-context-fr-mobile.png'),fullPage:true});await page.keyboard.press('Escape');
  const sections=page.locator('.mobile-navigation-group[data-navigation-section]');assert.equal(await sections.count(),3);for(const name of ['library','training','board']){const section=page.locator('.mobile-navigation-group[data-navigation-section="'+name+'"]');if(await section.getAttribute('open')===null)await section.locator(':scope>summary').click();await page.waitForFunction(()=>document.querySelectorAll('.mobile-navigation-group[open]').length===1);assert.notEqual(await section.getAttribute('open'),null);}
  await json('/api/preferences','PATCH',{language:'en'});await command('library');await reloadLibrary();await openRecent(freeIdentity);await draftMenu(freeIdentity,{method:'options'});assert.match(await page.locator('[data-board-draft-action="rename"]:visible').innerText(),/Rename/i);assert.match(await page.locator('[data-board-draft-action="delete"]:visible').innerText(),/Delete/i);await page.screenshot({path:join(output,'board-draft-context-en-mobile.png'),fullPage:true});await page.keyboard.press('Escape');
  await page.setViewportSize({width:1440,height:900});await draftMenu(freeIdentity,{method:'keyboard'});await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.dataset.boardDraftAction),'delete');await page.keyboard.press('Escape');assert.equal(await page.locator('[data-board-draft-action]:visible').count(),0);
 });
 await check('Supprimer une analyse libre courante ouvre un échiquier vide et reste supprimé après rechargement',async()=>{await deleteDraft(freeIdentity);await noDraft(freeIdentity);await page.keyboard.press('Escape');assert.equal(await page.locator('#move-list [data-path]').count(),0);await command('library');await reloadLibrary();assert.equal(await (await menu()).locator('[data-board-recent="'+freeIdentity+'"]').count(),0);assert.equal((await localItem('document:'+freeIdentity))?.data??null,null);});
 await check('Une source disparue laisse un échiquier libre après la suppression confirmée du brouillon',async()=>{
  await openGame(base.id,games[2].id);await selectMove('0');await annotate('Brouillon avec source indisponible');missingSource=games[2].id;await deleteDraft(third);await noDraft(third);await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelectorAll('#move-list [data-path]').length===0);missingSource=null;
  assert.equal((await localItem('document:'+third))?.data??null,null);assert(report.expectedFailures.some(item=>item.status===404));
 });
 await check('Un conflit lors de la suppression conserve le brouillon local',async()=>{
  await openGame(base.id,games[2].id);await selectMove('0');await annotate('Protection conflit de suppression');await page.waitForLoadState('networkidle');await waitJson('/api/workspace',value=>value.items.some(item=>item.key==='document:'+third));failNextWorkspaceDelete=true;await deleteDraft(third);await page.waitForFunction(()=>[...Array(localStorage.length)].some((_,i)=>{const key=localStorage.key(i);if(!key.includes(':slot:'))return false;try{return !!JSON.parse(localStorage.getItem(key))?.conflict;}catch{return false;}}));
  assert.equal(failNextWorkspaceDelete,false);assert((await localItem('document:'+third))?.data?.doc);await menu();assert.equal(await (await draftItem(third)).count(),1);await page.keyboard.press('Escape');assert.equal(await (await annotate()).inputValue(),'Protection conflit de suppression');
  await command('library');await reloadLibrary();assert.equal(await (await draftItem(third)).count(),1);await openRecent(third);await selectMove('0');assert.equal(await (await annotate()).inputValue(),'Protection conflit de suppression');
 });
 await check('Toutes les parties sources sont identiques et aucune requête ne les renomme ou ne les supprime',async()=>{
  for(let i=0;i<games.length;i++){const current=await json('/api/entries/'+games[i].id);for(const field of ['id','base_id','title','pgn','revision'])assert.deepEqual(current[field],originals[i][field],`Preserved ${field} for fixture ${games[i].id}`);}
  assert.deepEqual(report.sourceMutations,[]);assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);assert(report.confirmations.every(item=>item.expected));
  const unexpected=report.consoleErrors.filter(error=>!report.expectedFailures.some(failure=>error.url===failure.url&&error.text.includes(String(failure.status)))&&!(report.expectedFailures.some(failure=>failure.status===409)&&error.url===url+'/static/api.js'&&error.text.startsWith('Error: Version du brouillon modifiée pendant le test.\n')));assert.deepEqual(unexpected,[],'Only deliberately injected 404/409 errors and the matching application conflict notice are expected');
 });
 report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify(report,null,2));}
