import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const report={checks:[],errors:[],requests:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:1050},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',async route=>{
 const request=route.request(),target=new URL(request.url());
 if(target.origin!==url)return route.abort();
 if(request.method()!=='GET')report.requests.push({method:request.method(),path:target.pathname,body:request.postDataJSON()});
 const response=await context.request.fetch(request);await route.fulfill({response});
});
async function json(path,data){const response=data===undefined?await context.request.get(url+path):await context.request.post(url+path,{data});assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function capture(name){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:join(output,name+'.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+' horizontal overflow');}
const batchRequests=()=>report.requests.filter(item=>item.path.endsWith('/games/batch'));
async function submitBatch(){
 const response=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith('/games/batch')&&response.request().method()==='POST');
 await page.locator('#modal [type="submit"]').click();const result=await response;assert(result.ok(),await result.text());
 await page.locator('#modal').waitFor({state:'hidden'});await page.locator('[data-reference-select-all]:enabled').waitFor();
 assert.equal(await page.locator('[data-reference-status] [data-reference-action="refresh"]').count(),0,'Completed mutations must refresh the list without leaving a new-games banner');
 assert.doesNotMatch(await page.locator('[data-reference-status]').innerText(),/De nouvelles parties sont disponibles/);
 return result.json();
}
async function count(expected){await page.waitForFunction(value=>document.querySelector('#base-entry-count')?.textContent===String(value),expected);assert.equal(await page.locator('[data-reference-select]').count(),expected);}
try{

 await json('/api/setup-resources/complete',{});
 const reference=await json('/api/reference-bases',{name:'Mega Database de test',path:process.env.CHESSGYM_TEST_PGN}),personal=await json('/api/bases',{name:'Études de test'});
 assert.equal(reference.entry_count,3);report.base_ids={reference:reference.id,personal:personal.id};
 await page.goto(url+'/#/base?base='+reference.id);await page.locator('[data-reference-select="1"]:enabled').waitFor();await count(3);
 await page.locator('[data-reference-select="1"]').check();
 assert.match(await page.locator('[data-reference-selection]').innerText(),/1 sélectionnée/);
 assert.equal(batchRequests().length,0);await capture('reference-selection-desktop');
 check('Reference rows expose individual selection without mutating their games');
 await page.locator('[data-reference-selection] [data-reference-action="duplicate"]').click();
 assert.equal(await page.locator('#modal [name="target_base_id"]').inputValue(),String(reference.id));
 assert.equal(batchRequests().length,0);await submitBatch();await count(4);
 assert.equal(await page.locator('[data-reference-select="1"]').isChecked(),true);
 assert.deepEqual(batchRequests().at(-1).body,{action:'duplicate',game_ids:[1],target_base_id:reference.id});
 check('Confirming duplication inside the same reference creates an independent row and preserves selection');
 await page.locator('[data-reference-selection] [data-reference-action="duplicate"]').click();
 await page.locator('#modal [name="target_base_id"]').selectOption(String(personal.id));await submitBatch();await count(4);
 let entries=await json('/api/bases/'+personal.id+'/entries');assert.equal(entries.entries.length,1);
 const copied=await json('/api/entries/'+entries.entries[0].id);assert.match(copied.pgn,/Commentaire conservé/);assert.match(copied.pgn,/\(\s*1\.\s+d4/);
 check('Duplication into a personal base preserves comments and variations');
 await page.locator('[data-reference-selection] [data-reference-action="clear"]').click();
 await page.locator('[data-reference-select="2"]').check();await page.locator('[data-reference-selection] [data-reference-action="move"]').click();
 assert.equal(await page.locator('#modal option[value="'+reference.id+'"]').count(),0);
 await page.locator('#modal [name="target_base_id"]').selectOption(String(personal.id));await submitBatch();await count(3);
 assert.equal(await page.locator('[data-reference-select="2"]').count(),0);assert.equal(await page.locator('[data-reference-selection]').isVisible(),false);
 entries=await json('/api/bases/'+personal.id+'/entries');assert.equal(entries.entries.length,2);
 check('Move updates both real databases and removes only the selected source row');
 await page.setViewportSize({width:390,height:844});await page.locator('[data-reference-select="1"]').check();
 await capture('reference-selection-mobile');
 await page.locator('[data-reference-menu="3"]').click();await page.locator('#modal [data-reference-single="delete"]').click();
 assert.match(await page.locator('#modal').innerText(),/Joueur 3/);assert.doesNotMatch(await page.locator('#modal').innerText(),/Joueur 1 contre/);
 const before=batchRequests().length;await capture('reference-delete-confirmation-mobile');assert.equal(batchRequests().length,before);
 await submitBatch();await count(2);assert.equal(await page.locator('[data-reference-select="3"]').count(),0);
 assert.equal(await page.locator('[data-reference-select="1"]').isChecked(),true);
 assert.deepEqual(batchRequests().at(-1).body,{action:'delete',game_ids:[3]});
 check('Mobile row deletion requires confirmation and preserves an unrelated selection');
 await page.setViewportSize({width:1440,height:1050});await capture('reference-actions-complete-desktop');
 const finalReference=await json('/api/reference-bases/'+reference.id+'/games'),finalStatus=await json('/api/reference-bases/'+reference.id+'/status');
 assert.equal(finalReference.total,2);assert.equal(finalStatus.game_count,2);assert.deepEqual(finalReference.entries.map(entry=>entry.id),[1,4]);
 assert.equal((await json('/api/bases/'+personal.id+'/entries')).entries.length,2);
 await page.reload();await page.locator('[data-reference-select="1"]:enabled').waitFor();await count(2);
 assert.equal(await page.locator('[data-reference-selection]').isVisible(),false);
 check('Counts and mutations persist after reload while temporary UI selection resets');
 assert.equal(batchRequests().length,4);assert(!report.requests.some(item=>['/api/setup-resources/install','/api/setup-resources/update'].includes(item.path)));
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
