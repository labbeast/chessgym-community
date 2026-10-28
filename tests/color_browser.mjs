import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const report={checks:[],errors:[],geometry:[],libraryMutations:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:900},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
context.on('request',request=>{const path=new URL(request.url()).pathname;if(['POST','PATCH','PUT','DELETE'].includes(request.method())&&/^\/api\/(entries|bases)(\/|$)/.test(path))report.libraryMutations.push({path,method:request.method()});});
async function json(path,method='GET',data){const response=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();}
async function capture(name){await page.waitForFunction(()=>document.querySelectorAll('#notices .notice').length===0,null,{timeout:11000});await page.screenshot({path:join(output,name+'.png'),fullPage:true});const geometry=await page.evaluate(()=>{const question=document.querySelector('.color-question')?.getBoundingClientRect(),buttons=[...document.querySelectorAll('[data-color]')].map(button=>{const r=button.getBoundingClientRect();return{x:r.x,width:r.width,height:r.height};});return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,question:question?{x:question.x,width:question.width,height:question.height}:null,buttons};});report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.width+1,name+' horizontal overflow');assert(geometry.buttons.every(button=>button.height>=44&&button.width>=44),'touch targets');}
function check(label){report.checks.push(label);console.log('PASS '+label);}
const squareColor=square=>(square.charCodeAt(0)-97+Number(square[1])-1)%2?'white':'black';
async function start(selector){const response=page.waitForResponse(response=>response.url()===url+'/api/skills/color'&&response.request().method()==='POST');await page.locator(selector).click();const result=await(await response).json();await page.locator('.color-question').waitFor();return result;}
async function answer(session,{correct=true,keyboard=false}={}){let color=squareColor(session.target.square);if(!correct)color=color==='white'?'black':'white';const response=page.waitForResponse(response=>response.url()===url+'/api/skills/color/'+session.id+'/answer'&&response.request().method()==='POST');
 await page.waitForFunction(()=>!document.querySelector('[data-color]')?.disabled);
 if(keyboard)await page.keyboard.press(color==='white'?'ArrowLeft':'ArrowRight');else await page.locator('[data-color="'+color+'"]').click();
 const updated=await(await response).json();await page.waitForFunction(square=>document.querySelector('.color-question')?.textContent===square.toUpperCase(),updated.target.square);assert.notEqual(updated.target.square,session.target.square);return updated;
}
try{
 await json('/api/setup-resources/complete','POST',{});await page.goto(url+'/#/color');await page.locator('[data-color-setup]').waitFor();await capture('desktop-setup-fr');
 let first=await start('[data-color-setup] [type="submit"]');assert.equal(first.started_at,null);await new Promise(resolve=>setTimeout(resolve,1200));assert.equal(await page.locator('[data-color-clock]').textContent(),'30 s');assert.equal((await json('/api/skills/color/'+first.id)).started_at,null);check('The timer remains stopped until the first answer');
 first=await answer(first,{keyboard:true});assert(first.started_at&&first.deadline-first.started_at===30);first=await answer(first);first=await answer(first,{keyboard:true});assert.equal(first.score,3);assert.equal(first.errors,0);check('Keyboard and buttons answer correctly and start the thirty-second timer');
 await capture('desktop-active-fr');await page.setViewportSize({width:390,height:844});await capture('mobile-active-fr');
 await page.locator('.color-final-score').waitFor({timeout:40000});await page.waitForFunction(()=>document.querySelector('.color-records strong')?.textContent==='3');
 const completed=await json('/api/skills/color/'+first.id);assert.equal(completed.result.record_eligible,true);assert.equal(completed.result.score,3);check('A completed perfect session becomes the personal thirty-second record');
 let second=await start('[data-color-again]');second=await answer(second,{correct:false,keyboard:true});assert.equal(second.errors,1);assert.equal(second.score,0);assert.equal(second.last_answer.correct,false);await page.locator('.color-feedback.incorrect').waitFor();await capture('mobile-wrong-fr');check('An incorrect answer advances to the next square and clearly excludes the session from records');
 for(let i=0;i<5;i++)second=await answer(second,{keyboard:i%2===0});assert.equal(second.score,5);assert.equal(second.errors,1);
 await page.locator('.color-final-score').waitFor({timeout:40000});const failed=await json('/api/skills/color/'+second.id);assert.equal(failed.result.record_eligible,false);assert.equal(failed.result.score,5);
 const history=await json('/api/skills/color/history');assert.equal(history.history.length,2);assert.equal(history.records.length,1);assert.equal(history.records[0].score,3);assert.match(await page.locator('.color-eligibility').textContent(),/hors records/);await capture('mobile-result-fr');check('A higher score with one error remains in history without replacing the perfect record');
 await json('/api/preferences','PATCH',{language:'en'});await page.reload();await page.locator('[data-color-setup]').waitFor();assert.match(await page.locator('.color-training').textContent(),/What color is this square\?/);assert.match(await page.locator('.color-training').textContent(),/Only sessions with 100% correct answers/);await page.locator('[data-training-history]').click();await page.locator('dialog.training-history-dialog .training-history-table tbody tr').first().waitFor();assert.equal(await page.locator('dialog.training-history-dialog .training-history-table tbody tr').count(),2);await capture('mobile-history-en');await page.setViewportSize({width:1440,height:900});await capture('desktop-history-en');check('Saved results and separate duration records remain legible at phone and desktop widths in English');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.libraryMutations,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
