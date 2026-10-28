import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only isolated loopback fixtures may be tested');
const report={status:'running',checks:[],geometry:[],errors:[],externalRequests:[],sourceMutations:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
await context.addInitScript(()=>localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'ask'})));
const page=await context.newPage();page.setDefaultTimeout(15000);
let reviewDueCountOverride;
page.on('pageerror',error=>report.errors.push(String(error)));
context.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
page.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
async function routeRequests(route){
 const parsed=new URL(route.request().url());if(parsed.origin!==url)return route.abort();
 if(parsed.pathname==='/api/training/unfinished'&&reviewDueCountOverride!==undefined)return route.fulfill({json:{activities:[],review_due_count:reviewDueCountOverride}});
 if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
 if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
 if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test isolé.'}});
 return route.continue();
}
await context.route('**/*',routeRequests);
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.status()===204?null:response.json();}
async function check(name,action){await action();report.checks.push(name);console.log('PASS '+name);}
async function waitJson(path,predicate){const end=Date.now()+15000;do{const value=await json(path);if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw Error('Timed out waiting for '+path);}
async function boardMenu(target=page,{touch=false}={}){const host=target.locator('details[data-board-menu]:visible').first();await host.waitFor();if(await host.getAttribute('open')===null)await host.locator(':scope > summary')[touch?'tap':'click']();await host.locator('[data-board-menu-content]').waitFor({state:'visible'});const headings=await host.locator('.board-recent-heading').evaluateAll(nodes=>nodes.map(node=>{const title=node.querySelector('.board-recent-title').getBoundingClientRect(),dot=node.querySelector('.board-activity-dot')?.getBoundingClientRect(),current=node.querySelector('.board-recent-current-label')?.getBoundingClientRect();return {titleRight:title.right,dot:dot?{x:dot.x,right:dot.right}:null,currentX:current?.x};}));for(const row of headings)if(row.dot){assert(row.dot.x>=row.titleRight-1,'Board dots follow their draft title');if(row.currentX!=null)assert(row.currentX>=row.dot.right-1,'Board current label follows the dot');}return host;}
async function manage(target=page,{touch=false}={}){await (await boardMenu(target,{touch})).locator('[data-board-command="manage"]')[touch?'tap':'click']();const modal=target.locator('#modal[open]');await modal.waitFor();return modal;}
async function close(target=page,{touch=false}={}){await target.locator('#modal [data-close]').first()[touch?'tap':'click']();await target.locator('#modal[open]').waitFor({state:'detached'});}
async function library(){await page.locator('.brand[data-page="library"]:visible').click();await page.locator('[data-base]').first().waitFor();await page.waitForLoadState('networkidle');}
async function reload(){await page.reload();await page.locator('[data-base]').first().waitFor();await page.waitForLoadState('networkidle');assert.equal(await page.locator('#modal[open]').count(),0,'Reload must not open Manage drafts automatically');}
async function annotations(value){if(!await page.locator('#annotation-form textarea').isVisible()){const toggle=page.locator('[data-action="toggle-annotations"]:visible');if(await toggle.count())await toggle.click();else await page.locator('#analysis-annotations>summary').click();}const field=page.locator('#annotation-form textarea');await field.waitFor();if(value!==undefined)await field.fill(value);return field;}
async function activityMenu(name,{target=page,dueCount,reviewActive=true,touch=false}={}){
 const mobile=await target.locator('.mobile-navigation').isVisible(),navSelector=mobile?'.mobile-navigation':'.top-nav',navigation=target.locator(navSelector),group=navigation.locator('details:has([data-page="reviews"])');
 if(await group.getAttribute('open')===null)await group.locator(':scope > summary')[touch?'tap':'click']();
 await target.waitForFunction(({selector,count})=>{const node=document.querySelector(selector+' [data-page="reviews"] .navigation-review-count');return node&&(count==null?node.hidden:!node.hidden&&node.textContent==='('+count+')');},{selector:navSelector,count:dueCount});
 const data=await group.evaluate(node=>{const box=item=>{if(!item)return null;const r=item.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};return {language:document.documentElement.lang,rows:[...node.querySelectorAll('[data-page]')].map(button=>({page:button.dataset.page,unfinished:button.dataset.unfinishedActivity==='true',label:box(button.querySelector('.navigation-item-label')),count:button.querySelector('.navigation-review-count')&&!button.querySelector('.navigation-review-count').hidden?box(button.querySelector('.navigation-review-count')):null,dot:button.querySelector('.navigation-activity-dot')&&!button.querySelector('.navigation-activity-dot').hidden?box(button.querySelector('.navigation-activity-dot')):null,accessible:button.getAttribute('aria-label')}))};});
 report.geometry.push({name,activityMenu:data});
 for(const row of data.rows){if(row.count){assert.equal(row.page,'reviews');assert(row.count.x>=row.label.right-1&&row.count.x<=row.label.right+16,'Due count immediately follows Reviews');assert(Math.abs(row.count.y+row.count.height/2-row.label.y-row.label.height/2)<=2,'Due count stays on the label line');}if(row.dot){const previous=row.count||row.label;assert(row.dot.x>=previous.right-1&&row.dot.x<=previous.right+16,'Activity dot follows label and count: '+row.page);assert(Math.abs(row.dot.y+row.dot.height/2-row.label.y-row.label.height/2)<=2,'Dot stays on the label line: '+row.page);}}
 const reviews=data.rows.find(row=>row.page==='reviews'),computer=data.rows.find(row=>row.page==='computer')||data.rows.find(row=>row.page==='exercises'),history=data.rows.find(row=>row.page==='training-history');assert.equal(reviews.unfinished,reviewActive);assert.equal(!!reviews.dot,reviewActive);assert.equal(!!reviews.count,dueCount!=null);assert.equal(computer.unfinished,true);assert(computer.dot);assert.equal(history.unfinished,false);assert.equal(history.dot,null);assert.equal(await navigation.locator('[data-page="library"]').getAttribute('data-unfinished-activity'),null);
 if(reviewActive)assert.equal(reviews.accessible,(data.language==='en'?'Reviews':'Révisions')+(dueCount==null?'':' ('+dueCount+')')+(data.language==='en'?' · unfinished activity':' · activité non terminée'));else assert(!String(reviews.accessible).includes(data.language==='en'?'unfinished activity':'activité non terminée'));
 await target.screenshot({path:join(output,name+'.png'),fullPage:true});await target.keyboard.press('Escape');
}
async function screenshot(name,target=page){
 await target.screenshot({path:join(output,name+'.png'),fullPage:true});
 const geometry=await target.evaluate(()=>{
  const box=node=>{if(!node)return null;const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,lineHeight:parseFloat(s.lineHeight),whiteSpace:s.whiteSpace};};
  const d=document.querySelector('#modal');return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,coarse:matchMedia('(pointer:coarse)').matches,language:document.documentElement.lang,dialog:box(d),rows:[...d.querySelectorAll('.workspace-draft-row')].map(node=>{
   const open=node.querySelector('.workspace-draft-open'),remove=node.querySelector('.workspace-draft-delete'),meta=node.querySelector('.workspace-draft-meta'),style=getComputedStyle(open);
   return {key:open.dataset.workspaceDocument,row:box(node),main:box(node.querySelector('.workspace-draft-main')),open:box(open),heading:box(node.querySelector('.workspace-draft-heading')),title:box(node.querySelector('.workspace-draft-title')),dot:box(node.querySelector('.board-activity-dot')),current:box(node.querySelector('.board-recent-current-label')),meta:box(meta),info:box(meta.querySelector('.board-recent-info')),date:box(meta.querySelector('time')),secondLine:[...meta.querySelectorAll('.board-recent-context,.board-recent-draft,time')].map(box),delete:box(remove),deleteText:remove.textContent.trim(),deleteLabel:remove.getAttribute('aria-label'),deleteColor:getComputedStyle(remove).color,paddingRight:parseFloat(style.paddingRight),gridRows:style.gridTemplateRows.split(' ').map(parseFloat),lineCount:open.children.length};
  })};
 });
 report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.viewport+1,'Page overflows: '+name);assert(geometry.dialog.x>=-1&&geometry.dialog.right<=geometry.viewport+1,'Dialog exceeds viewport: '+name);assert(geometry.dialog.scrollWidth<=geometry.dialog.clientWidth+1,'Dialog content overflows: '+name);
 for(const row of geometry.rows){
  const label=name+' '+row.key,expectedFirst=geometry.coarse?31:17,expectedHeight=geometry.coarse?68:54;
  assert(row.row.scrollWidth<=row.row.clientWidth+1,'Draft row overflows: '+label);assert.equal(row.lineCount,2,'Exactly two direct text lines: '+label);assert.deepEqual(row.gridRows,[expectedFirst,15],'Exactly two fixed grid rows: '+label);assert(Math.abs(row.main.height-expectedHeight)<=1,'Compact draft height: '+label);
  assert(Math.abs(row.heading.height-expectedFirst)<=1&&Math.abs(row.meta.height-15)<=1,'No third text line: '+label);assert(Math.abs(row.meta.y-row.heading.bottom-4)<=1,'Consistent gap between both lines: '+label);assert(row.title.height<=18&&row.title.whiteSpace==='nowrap','Title must stay on one line: '+label);assert(row.title.right<=row.delete.x+1,'Title must not pass under the cross: '+label);
  assert(row.dot&&row.dot.x>=row.title.right-1&&row.dot.right<=row.delete.x+1,'Draft dot follows the title, before the deletion cross: '+label);if(row.current)assert(row.current.x>=row.dot.right-1,'Current label follows the draft dot: '+label);
  for(const text of row.secondLine)assert(text.whiteSpace==='nowrap'&&text.height<=16&&text.y>=row.meta.y-1&&text.bottom<=row.meta.bottom+1,'Metadata and date must share line two: '+label);
  assert(row.date,'Every dated fixture has a visible date: '+label);assert(Math.abs(row.date.right-(row.open.right-row.paddingRight))<=1,'Dates align with the right inner edge: '+label);assert(row.info.right<=row.date.x+1,'Metadata must leave room for the date: '+label);assert(row.date.y>=row.delete.bottom-1,'Date must sit below the cross: '+label);
  assert.equal(row.deleteText,'×','Delete action uses only a cross: '+label);assert.match(row.deleteLabel,geometry.language==='en'?/^Delete draft /:/^Supprimer le brouillon /);const [red,green,blue]=row.deleteColor.match(/[\d.]+/g).map(Number);assert(red>green&&red>blue,'Deletion cross is red: '+label);assert(Math.abs(row.delete.right-row.main.right)<=1&&Math.abs(row.delete.y-row.main.y)<=1,'Cross is anchored at the upper right: '+label);assert(Math.abs((row.delete.y+row.delete.height/2)-(row.heading.y+row.heading.height/2))<=4,'Cross shares the title line: '+label);assert(row.delete.width>=(geometry.coarse?44:30)&&row.delete.height>=(geometry.coarse?44:30),'Cross has a usable pointer target: '+label);
 }
}

try{
 await json('/api/setup-resources/complete','POST',{});
 const base=await json('/api/bases','POST',{name:'Source à conserver',settings:{}});
 const original=await json('/api/entries','POST',{base_id:base.id,title:'Partie enregistrée',pgn:'[Event "Source"]\n[White "Joueur"]\n[Black "Adversaire"]\n[Result "*"]\n\n1. e4 {Source originale} e5 2. Nf3 *'});
 const clean=await json('/api/entries','POST',{base_id:base.id,title:'Partie intacte',pgn:'1. d4 d5 *'});
 const doc=await json('/api/entries/'+original.id),savedIdentity='entry:'+original.id,savedKey='document:'+savedIdentity;
 doc.analysis_dirty=true;doc.title='Brouillon modifié';
 const label='Préparation <personnelle> & variantes — '+('Un nom très long pour contrôler les petits écrans. '.repeat(3));
 const initial=await json('/api/board','POST',{}),diagram=await json('/api/board','POST',{fen:'8/8/8/8/4K3/8/8/4k3 w - - 0 1'});
 initial.workspace_id='empty';initial.title='';initial.headers={Result:'*'};
 const snapshot={doc,path:'0',analysisTool:'explorer'};
 const slots=[['analysis',snapshot],[savedKey,snapshot],['view:'+savedIdentity,{draftLabel:label,path:'0'}],['document:entry:'+clean.id,{doc:await json('/api/entries/'+clean.id)}],['document:free:empty',{doc:initial}]];
 for(let i=0;i<22;i++){const copy=structuredClone(diagram);copy.workspace_id='diagram-'+i;copy.title='Diagramme '+String(i+1).padStart(2,'0');slots.push(['document:free:'+copy.workspace_id,{doc:copy,path:''}]);}
 const computer={version:1,mode:'play',config:{start:'initial',provider:'stockfish',side:'white'},session:{id:'manage-drafts-game',side:'white',headers:{Result:'*'},position:{initial_fen:initial.nodes[0].fen,fen:initial.nodes[0].fen,doc:initial,history:[],path:'',game_over:false},config:{start:'initial',provider:'stockfish',side:'white'}}};
 slots.push(['review',{base,cards:[{entry_id:original.id}],index:0}],['computer',computer]);
 for(const [key,data] of slots)await json('/api/workspace/'+encodeURIComponent(key),'PUT',{expected_revision:0,data});
 await json('/api/preferences','PATCH',{language:'en'});
 const activitySummary=await json('/api/training/unfinished'),actualDueCount=activitySummary.review_due_count;assert(Number.isSafeInteger(actualDueCount)&&actualDueCount>=0,'The real activity endpoint returns a known nonnegative review count');
 await page.goto(url);await page.locator('[data-base="'+base.id+'"]').waitFor();await page.waitForLoadState('networkidle');
 await check('An existing ask preference never opens the draft manager at startup or reload',async()=>{assert.equal(await page.locator('#modal[open]').count(),0);await reload();});
 await check('Activity dots follow labels and the Reviews count matches the real endpoint on desktop and mobile',async()=>{
  for(const width of [1440,390]){await page.setViewportSize({width,height:width===1440?900:844});await activityMenu('unfinished-activities-en-'+width,{dueCount:actualDueCount});}await page.setViewportSize({width:1440,height:900});
 });
 await check('Manage drafts opens explicitly, lists every draft once, and omits all resume cards',async()=>{
  const modal=await manage();await modal.locator('[data-collection-search]').fill('diagramme 01');await modal.locator('[data-collection-search]').press('Enter');await page.waitForFunction(()=>[...document.querySelectorAll('#modal .workspace-draft-row')].filter(node=>!node.hidden).length===1);await modal.locator('[data-collection-action="reset"]').click();assert.equal(await modal.locator('.workspace-draft-row:visible').count(),23);assert.equal(await modal.locator('.dialog-head h2').innerText(),'Manage drafts');assert.equal(await modal.locator('.workspace-draft-row').count(),23,'All 22 free drafts and the saved draft are visible without the Recent list limit');assert.equal(await modal.locator('[data-workspace-document="'+savedKey+'"]').count(),1);assert.equal(await modal.locator('[data-workspace-document="analysis"]').count(),0);assert.equal(await modal.locator('[data-workspace-document="document:entry:'+clean.id+'"],[data-workspace-document="document:free:empty"]').count(),0);assert.equal(await modal.locator('[data-resume-analysis],[data-resume-session],[data-resume-computer],details').count(),0);assert((await modal.innerText()).includes(label.slice(0,160)));await screenshot('manage-drafts-en-desktop');await close();
 });
 await check('Opening a saved draft preserves its PGN, and the current row preserves live annotations',async()=>{
  await manage();await page.locator('[data-workspace-document="'+savedKey+'"]').click();await page.locator('#board-host .chess-board').waitFor();await page.locator('#modal[open]').waitFor({state:'detached'});assert.equal((await json('/api/entries/'+original.id)).pgn,original.pgn);
  const note='Annotation gardée après ouverture du brouillon courant';await annotations(note);await manage();assert.equal(await page.locator('[data-workspace-document="'+savedKey+'"]').count(),1);assert.equal(await page.locator('[data-workspace-document="'+savedKey+'"]').getAttribute('aria-current'),'true');await screenshot('manage-drafts-current-en');await page.locator('[data-workspace-document="'+savedKey+'"]').click();await page.locator('#modal[open]').waitFor({state:'detached'});assert.equal(await (await annotations()).inputValue(),note);assert.equal(await page.locator('#workspace-status').evaluate(node=>node.tagName),'SPAN');await page.locator('#workspace-status').click();assert.equal(await page.locator('#modal[open]').count(),0);assert.equal((await json('/api/entries/'+original.id)).pgn,original.pgn);
  await library();await reload();
 });
 await check('Every draft keeps exactly two compact lines, a right-aligned date and a red cross in both languages at desktop, 390 and 320 px',async()=>{
  for(const language of ['en','fr']){await json('/api/preferences','PATCH',{language});await reload();for(const width of [1440,390,320]){await page.setViewportSize({width,height:width===1440?900:844});await activityMenu('activity-count-'+language+'-'+width,{dueCount:actualDueCount});const modal=await manage();assert.equal(await modal.locator('.dialog-head h2').innerText(),language==='en'?'Manage drafts':'Gérer les brouillons');await screenshot('manage-drafts-'+language+'-'+width);await close();}}await page.setViewportSize({width:1440,height:900});
 });
 await check('Touch controls preserve the two lines and provide a separate 44 px red deletion cross',async()=>{
  const touchContext=await chromium.launchPersistentContext(join(output,'touch-profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:390,height:844},isMobile:true,hasTouch:true,args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
  try{
   await touchContext.addCookies(await context.cookies());await touchContext.route('**/*',routeRequests);touchContext.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});const touchPage=await touchContext.newPage();touchPage.setDefaultTimeout(15000);touchPage.on('pageerror',error=>report.errors.push(String(error)));touchPage.on('request',request=>{const path=new URL(request.url()).pathname;if(!['GET','HEAD'].includes(request.method())&&/^\/api\/entries(?:\/|$)/.test(path)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(path))report.sourceMutations.push({method:request.method(),path});});
   for(const language of ['en','fr']){await json('/api/preferences','PATCH',{language});await touchPage.goto(url+'/#/library');await touchPage.reload();await touchPage.locator('[data-base]').first().waitFor();assert.equal(await touchPage.locator('#modal[open]').count(),0);assert.equal(await touchPage.evaluate(()=>matchMedia('(pointer:coarse)').matches),true);for(const width of [390,320]){await touchPage.setViewportSize({width,height:844});await activityMenu('activity-count-touch-'+language+'-'+width,{target:touchPage,dueCount:actualDueCount,touch:true});await manage(touchPage,{touch:true});await screenshot('manage-drafts-touch-'+language+'-'+width,touchPage);await close(touchPage,{touch:true});}}
   await manage(touchPage,{touch:true});let confirmation='';touchPage.once('dialog',async dialog=>{confirmation=dialog.message();await dialog.dismiss();});await touchPage.locator('[data-delete-workspace="'+savedKey+'"]').tap();assert.match(confirmation,/Supprimer ce brouillon/);assert.equal(await touchPage.locator('[data-workspace-document="'+savedKey+'"]').count(),1,'Cancelling a tap on the cross keeps the draft');assert.equal(await touchPage.locator('#board-host .chess-board').count(),0,'Tapping the cross must never open the draft');await close(touchPage,{touch:true});
  }finally{await touchContext.close();}
 });
 await check('Draft deletion can be cancelled, then removes only the selected draft',async()=>{
  await manage();page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-delete-workspace="document:free:diagram-0"]').click();assert.equal(await page.locator('[data-workspace-document="document:free:diagram-0"]').count(),1);page.once('dialog',dialog=>dialog.accept());await page.locator('[data-delete-workspace="document:free:diagram-0"]').click();await page.locator('[data-workspace-document="document:free:diagram-0"]').waitFor({state:'detached'});assert.equal(await page.locator('.workspace-draft-row').count(),22);assert.equal(await page.locator('[data-workspace-document="'+savedKey+'"]').count(),1);assert.equal((await json('/api/entries/'+original.id)).pgn,original.pgn);await close();
 });
 await check('An empty manager stays explicit even when unfinished review and computer activities remain',async()=>{
  await library();await waitJson('/api/workspace',value=>!value.items.some(item=>item.key==='document:free:diagram-0'));
  const retained=(await json('/api/workspace')).items;for(const item of retained)if(item.key==='analysis'||/^(document:|annotation:|view:)/.test(item.key))await json('/api/workspace/'+encodeURIComponent(item.key)+'?expected_revision='+item.revision,'DELETE');
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('chessgym-workspace-v1:'))localStorage.removeItem(key);});await reload();await manage();assert.equal(await page.locator('.workspace-draft-row').count(),0);assert.equal(await page.locator('.workspace-draft-empty').count(),1);assert.equal(await page.locator('[data-resume-analysis],[data-resume-session],[data-resume-computer]').count(),0);await screenshot('manage-drafts-empty-fr');await close();assert.equal((await json('/api/entries/'+original.id)).pgn,original.pgn);
 });
 await check('Finishing a session hides its dot independently of positive, zero or unknown due counts',async()=>{
  let reviewItem=(await json('/api/workspace')).items.find(item=>item.key==='review');const unfinished=reviewItem.data;
  await json('/api/workspace/review','PUT',{expected_revision:reviewItem.revision,data:{...unfinished,finishedSession:true}});reviewDueCountOverride=7;
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('chessgym-workspace-v1:'))localStorage.removeItem(key);});await reload();await activityMenu('reviews-due-seven-without-resume-dot',{dueCount:7,reviewActive:false});
  reviewItem=(await json('/api/workspace')).items.find(item=>item.key==='review');await json('/api/workspace/review','PUT',{expected_revision:reviewItem.revision,data:unfinished});reviewDueCountOverride=0;
  await page.evaluate(()=>{for(const key of Object.keys(localStorage))if(key.startsWith('chessgym-workspace-v1:'))localStorage.removeItem(key);});await reload();await activityMenu('reviews-due-zero-with-resume-dot',{dueCount:0});
  reviewDueCountOverride=null;await reload();await activityMenu('reviews-count-unknown-with-resume-dot',{dueCount:null});reviewDueCountOverride=undefined;
 });
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.sourceMutations,[],'Managing drafts must not write original entries');report.status='passed';
}catch(error){report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});console.error(error.stack);process.exitCode=1;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();console.log(JSON.stringify(report,null,2));}
