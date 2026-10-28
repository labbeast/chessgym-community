import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const report={checks:[],errors:[],requests:[]};let closing=false;
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:1050},args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
// Windows Chrome may spend about 20 seconds reopening its audio device after reload.
const page=await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror',error=>report.errors.push(String(error)));
// Only long engine transports are simulated. Forms, settings persistence, PGN
// navigation, local explorer statistics and cancellation belong to the real app.
await page.addInitScript(()=>{
 const original=window.fetch.bind(window),requests=[];window.__analysisTransport={requests};
 window.fetch=(input,options={})=>{
  const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
  const live=path==='/api/engine/analyse/stream',evaluate=path==='/api/explorer/evaluate',game=/^\/api\/game-analysis\/\d+$/.test(path)&&options.method==='POST';
  if(!live&&!evaluate&&!game)return original(input,options);
  const payload=JSON.parse(options.body),record={id:requests.length,path,payload,cancelled:false};requests.push(record);
  const reply=body=>Promise.resolve(new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}}));
  if(game)return reply({});
  if(evaluate&&payload.depth==null)return reply({...payload,cp:23,mate:null,depth:12,engine:'Browser test engine',cached:false});
  if(evaluate)return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>{record.cancelled=true;reject(new DOMException('Cancelled','AbortError'));},{once:true}));
  return Promise.resolve(new Response(new ReadableStream({start(controller){
   const cancel=()=>{record.cancelled=true;controller.error(new DOMException('Cancelled','AbortError'));};
   options.signal.addEventListener('abort',cancel,{once:true});
   controller.enqueue(new TextEncoder().encode(JSON.stringify({type:'info',fen:payload.fen,engine:'Browser test engine',lines:[]})+'\n'));
  }}),{headers:{'Content-Type':'application/x-ndjson'}}));
 };
});
await context.route('**/*',async route=>{
 const request=route.request(),target=new URL(request.url());if(target.origin!==url)return route.abort();
 if(request.method()!=='GET')report.requests.push({method:request.method(),path:target.pathname});
 try{await route.fulfill({response:await context.request.fetch(request,{maxRetries:request.method()==='GET'?2:0})});}
 catch(error){if(!closing&&request.failure()?.errorText!=='net::ERR_ABORTED')throw error;}
});
async function json(path,body,method='GET'){
 const response=await context.request.fetch(url+path,{method,data:body});assert(response.ok(),path+' '+response.status()+' '+await response.text());return response.json();
}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function latest(path,after=-1){
 await page.waitForFunction(({path,after})=>window.__analysisTransport.requests.some(item=>item.path===path&&item.id>after),{path,after});
 return page.evaluate(path=>window.__analysisTransport.requests.filter(item=>item.path===path).at(-1),path);
}
async function cancelled(id){await page.waitForFunction(id=>window.__analysisTransport.requests[id]?.cancelled,id);}
const dialog=page.locator('#modal[open]');
async function apply(){await dialog.locator('[type="submit"]').click();await dialog.waitFor({state:'hidden'});}
async function engineSettings(mode,value){
 await page.locator('#analysis-engine [data-b="engine-settings"]').click();
 await dialog.locator('[name="mode"]').selectOption(mode);
 if(mode==='time')await dialog.locator('[name="time_seconds"]').fill(String(value));
 if(mode==='depth')await dialog.locator('[name="depth"]').fill(String(value));
 await page.screenshot({path:join(output,'live-engine-'+mode+'.png'),fullPage:true});
 await apply();
}
try{
 await json('/api/setup-resources/complete',{},'POST');
 const base=await json('/api/bases',{name:'Analysis limits browser test'},'POST');
 const entry=await json('/api/entries',{base_id:base.id,title:'Two moves for navigation',pgn:'[Event "Analysis limits"]\n[Result "*"]\n\n1. e4 e5 *'},'POST');
 await json('/api/explorer/settings',{source:'local',base_ids:[base.id],master_source:'none',show_probability:false},'PATCH');
 await page.goto(url+'/#/library');await page.locator('[data-base="'+base.id+'"]').first().click();
 await page.getByRole('button',{name:'Ouvrir',exact:true}).click();await page.locator('#analysis-engine [data-b="engine-settings"]').waitFor();
 await engineSettings('time','120.5');
 assert.equal((await json('/api/engine/settings')).time_ms,120500);
 await page.reload();await page.locator('#analysis-engine [data-b="engine-settings"]').click();
 assert.equal(await dialog.locator('[name="mode"]').inputValue(),'time');assert.equal(await dialog.locator('[name="time_seconds"]').inputValue(),'120.5');
 await dialog.locator('[data-close]').first().click();
 await page.locator('#analysis-engine [data-b="engine"]').click();
 const timed=await latest('/api/engine/analyse/stream');assert.equal(timed.payload.time_ms,120500);assert.equal(timed.payload.depth,null);
 check('A duration above 60 seconds is saved, survives reload and reaches the live analysis transport unchanged');
 await engineSettings('depth',64);
 const depth=await latest('/api/engine/analyse/stream',timed.id);assert.equal(depth.payload.depth,64);assert.equal(depth.payload.time_ms,null);await cancelled(timed.id);
 assert.equal((await json('/api/engine/settings')).depth,64);
 check('Depth 64 is saved and sends no implicit time limit; changing settings cancels the previous calculation');
 await engineSettings('infinite');
 const unlimited=await latest('/api/engine/analyse/stream',depth.id);assert.equal(unlimited.payload.depth,null);assert.equal(unlimited.payload.time_ms,null);await cancelled(depth.id);
 await page.locator('#board-host [data-b="next"]').click();
 const next=await latest('/api/engine/analyse/stream',unlimited.id);assert.notEqual(next.payload.fen,unlimited.payload.fen);await cancelled(unlimited.id);
 await page.locator('#analysis-engine [data-b="engine"]').click();await cancelled(next.id);
 check('Unlimited mode sends no depth or duration, stops on a position change and stops when the engine is switched off');
 await page.locator('#board-host [data-b="first"]').click();
 await page.locator('[data-analysis-tool="explorer"]').click();
 await page.locator('[data-explorer-action="settings"]:enabled').click();
 await dialog.locator('[name="engine_mode"]').selectOption('depth');await dialog.locator('[name="engine_depth"]').fill('64');
 assert.equal(await dialog.locator('[name="engine_depth"]').getAttribute('max'),null);
 await apply();assert.equal((await json('/api/explorer/settings')).engine_depth,64);
 const explorer=await latest('/api/explorer/evaluate');assert.equal(explorer.payload.depth,64);assert.equal(explorer.payload.time_ms,undefined);
 await page.locator('[data-explorer-action="evaluation"]').click();await cancelled(explorer.id);
 await page.locator('[data-explorer-action="settings"]').click();assert.equal(await dialog.locator('[name="engine_depth"]').inputValue(),'64');
 await dialog.locator('[name="engine_depth"]').scrollIntoViewIfNeeded();
 await page.screenshot({path:join(output,'explorer-depth-64.png'),fullPage:true});await dialog.locator('[data-close]').first().click();
 check('Explorer depth 64 persists without an HTML ceiling or injected duration, and its stop control aborts the calculation');
 await page.locator('#analysis-tab-bilan').click();
 await page.locator('[data-work-action="analysis-settings"]').click();await dialog.locator('[name="depth_mode"]').selectOption('depth');await dialog.locator('[name="depth"]').fill('64');
 assert.equal(await dialog.locator('[name="depth"]').getAttribute('max'),null);assert.equal(await dialog.locator('[name="time_seconds"]').isEnabled(),false);
 await apply();await page.locator('[data-work-action="analyse"]:enabled').click();
 const gameDepth=await latest('/api/game-analysis/'+entry.id);assert.deepEqual(gameDepth.payload,{time_ms:null,depth:64});
 await page.locator('[data-work-action="analysis-settings"]:enabled').click();await dialog.locator('[name="depth_mode"]').selectOption('time');await dialog.locator('[name="time_seconds"]').fill('120.125');
 assert.equal(await dialog.locator('[name="depth"]').isEnabled(),false);
 await page.screenshot({path:join(output,'report-duration-120-seconds.png'),fullPage:true});await apply();await page.locator('[data-work-action="analyse"]:enabled').click();
 const gameTimed=await latest('/api/game-analysis/'+entry.id,gameDepth.id);assert.deepEqual(gameTimed.payload,{time_ms:120125,depth:null});
 check('The game report sends either depth 64 with no duration or 120.125 seconds with no depth');
 report.transports=await page.evaluate(()=>window.__analysisTransport.requests);
 const performanceValues=data=>Object.fromEntries(['profile','total_threads','hash_mb','import_workers'].map(key=>[key,data[key]]));
 const capabilities=await json('/api/resource-settings');
 report.performance={hardware:capabilities.hardware,limits:capabilities.limits,recommendations:capabilities.recommendations};
 await page.goto(url+'/#/settings');await page.locator('[data-settings-tab="performance"]').click();
 const performance=page.locator('#resource-settings'),profile=performance.locator('[name="profile"]');
 await profile.waitFor();await profile.selectOption('custom');
 for(const key of ['total_threads','hash_mb']){
  const input=performance.locator('[name="'+key+'"]');
  assert.equal(Number(await input.getAttribute('min')),capabilities.limits[key].min);
  assert.equal(Number(await input.getAttribute('max')),capabilities.limits[key].max);
  assert.equal(await input.isEnabled(),true);
 }
 const cpu=performance.locator('[name="total_threads"]'),workers=performance.locator('[name="import_workers"]');
 const expectedImportMax=Math.max(1,Math.min(capabilities.limits.import_workers.max,Math.max(1,Number(await cpu.inputValue())-2)));
 assert.equal(Number(await workers.getAttribute('max')),expectedImportMax);
 assert.match(await performance.locator('.resource-hardware').innerText(),/serveur ChessGym/);
 check('Performance fields use the real server CPU/RAM limits and adjust import capacity to the selected CPU budget');
 const before=report.requests.filter(item=>item.path==='/api/resource-settings'&&item.method==='PATCH').length;
 await cpu.fill(String(capabilities.limits.total_threads.max+1));
 await performance.locator('button[type="submit"]').click();
 assert.equal(await cpu.evaluate(input=>input.validity.rangeOverflow),true);
 assert.equal(await performance.locator('form').evaluate(form=>form.checkValidity()),false);
 assert.equal(report.requests.filter(item=>item.path==='/api/resource-settings'&&item.method==='PATCH').length,before);
 assert.deepEqual(performanceValues(await json('/api/resource-settings')),performanceValues(capabilities));
 check('Custom CPU above the server maximum is rejected by the browser without a PATCH or saved-setting change');
 await profile.selectOption('balanced');
 for(const key of ['total_threads','hash_mb','import_workers']){
  const input=performance.locator('[name="'+key+'"]');
  assert.equal(Number(await input.inputValue()),capabilities.recommendations.balanced[key]);
  assert.equal(await input.isEnabled(),false);
 }
 const saved=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/resource-settings'&&response.request().method()==='PATCH');
 await performance.locator('button[type="submit"]').click();const response=await saved;
 assert(response.ok());assert.deepEqual(response.request().postDataJSON(),{profile:'balanced'});
 assert.deepEqual(performanceValues(await json('/api/resource-settings')),capabilities.recommendations.balanced);
 await page.reload();await page.locator('[data-settings-tab="performance"]').click();await profile.waitFor();
 assert.equal(await profile.inputValue(),'balanced');
 for(const key of ['total_threads','hash_mb','import_workers'])assert.equal(Number(await performance.locator('[name="'+key+'"]').inputValue()),capabilities.recommendations.balanced[key]);
 check('Balanced profile fills the server recommendations, saves through the real endpoint and survives a page reload');
 for(const [name,width,height] of [['desktop',1440,1050],['mobile',390,844]]){
  await page.setViewportSize({width,height});await page.evaluate(()=>window.scrollTo(0,0));
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Performance '+name+' horizontal overflow');
  assert(await performance.locator('input,select,button').evaluateAll(nodes=>nodes.every(node=>{const rect=node.getBoundingClientRect();return rect.left>=0&&rect.right<=innerWidth+1;})),'Performance '+name+' clipped controls');
  await page.screenshot({path:join(output,'performance-'+name+'.png'),fullPage:true});
 }
 check('Performance remains readable on desktop and mobile without horizontal overflow or clipped controls');
 assert(!report.requests.some(item=>['/api/setup-resources/install','/api/setup-resources/update','/api/setup-resources/import'].includes(item.path)));
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);report.transports??=await page.evaluate(()=>window.__analysisTransport?.requests||[]);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}
finally{closing=true;await context.unrouteAll({behavior:'ignoreErrors'});await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
