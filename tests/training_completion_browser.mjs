import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const require=createRequire(import.meta.url),{chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1');
const fixture=JSON.parse(await readFile(join(output,'fixture.json'),'utf8'));
const report={checks:[],errors:[],geometry:[]};
const context=await chromium.launchPersistentContext(join(output,'profile'),{executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,viewport:{width:1440,height:1000},args:['--no-first-run','--disable-extensions']});
const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',error=>report.errors.push(String(error)));
await context.route('**/*',route=>new URL(route.request().url()).origin!==url?route.abort():route.continue());
async function json(path,method='GET',data){const r=await context.request.fetch(url+path,{method,...(data===undefined?{}:{data})});assert(r.ok(),path+' '+r.status()+' '+await r.text());return r.json();}
function check(label){report.checks.push(label);console.log('PASS '+label);}
async function poll(fn,label){for(let i=0;i<100;i++){const value=await fn();if(value)return value;await page.waitForTimeout(100);}throw Error('Timed out: '+label);}
async function capture(name){await page.screenshot({path:join(output,name+'.png'),fullPage:true});const g=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth}));report.geometry.push({name,...g});assert(g.scroll<=g.width+1,name+' horizontal overflow');}
async function dismissStartup(){const close=page.locator('#modal[open] [data-close]').first();if(await close.isVisible())await close.click();}
async function tab(view){await page.locator('[data-plan-view="'+view+'"]').click();await page.locator('[data-plan-view="'+view+'"][aria-selected="true"]').waitFor();}
async function week(){return (await json('/api/training/weeks/current','POST',{mutation_id:crypto.randomUUID()})).week;}
async function activeRun(blockId){return poll(async()=>{const data=await json('/api/training/state');return data.active_runs.find(r=>r.block_id===blockId);},'active programme run');}
async function nativeRef(id){return poll(async()=>{const r=await json('/api/training/runs/'+id);return r.native_ref;},'native reference');}
async function launch(block){
 await tab('week');await page.locator('[data-plan-action="launch-block"][data-block="'+block.id+'"]').click();
 const setup={puzzles:'[data-filters]',guess:'[data-game-picker]',computer:'[data-setup]',blindfold:'[data-start-custom]',coordinates:'[data-coordinate-setup]',color:'[data-color-setup]'};
 await page.locator(setup[block.activity]).waitFor();
 assert.equal(await page.locator('[data-training-session-bar]').count(),0,'Native preparation keeps the normal navigation');
 return activeRun(block.id);
}
async function returnProgram({menu=false}={}){
 if(menu){await page.locator('[data-training-session-bar] summary').click();await page.locator('[data-training-return]').click();}
 else await page.locator('.training-toolbar-home').click();
 await page.locator('#tp-tab-today').waitFor();
}
async function finishRun(run){
 const finish=page.locator('[data-program-session="finish"]');
 if(!await finish.isVisible())await page.locator('[data-training-session-bar] summary').click();
 await finish.click();await page.locator('#tp-tab-today').waitFor();assert.equal((await json('/api/training/runs/'+run.id)).state,'completed');
}
async function move(host,uci){await page.locator(host+' [data-square="'+uci.slice(0,2)+'"]').click();await page.locator(host+' [data-square="'+uci.slice(2,4)+'"]').click();}
try{
 await json('/api/setup-resources/complete','POST',{});
 // Exercise an explicit opt-out and its later re-enabling; default-on free
 // attribution is covered by training_plan_browser.mjs.
 await json('/api/training/assistance/settings','PATCH',{mutation_id:crypto.randomUUID(),expected_revision:0,auto_assign:false});
 const state=await json('/api/training/state'),resources=state.resources;
 const spec=[['puzzles','Calcul',{mode:'classic',rated:false,selection:'custom',filters:{rating_min:800,rating_max:900,color:'white'}}],['puzzles','Storm',{mode:'storm',selection:'custom',filters:{rating_min:800,rating_max:900,color:'white'}}],['guess','Deviner',{side:'both'}],['computer','Partie',{provider:'stockfish',skill:0,time_ms:100,side:'white',time_control:'unlimited'}],['blindfold','Visualisation',{mode:'positions',rated:false,max_pieces:3,rating_min:800,rating_max:900,reconstruct_after:false,input:'board'}],['coordinates','Coordonnées',{mode:'coordinates',duration:30,orientation:'black',coordinates:false}],['color','Couleurs',{duration:60}]];
 const blocks=spec.map(([activity,title,options])=>{const r=resources.find(r=>activity==='guess'?r.type==='base'&&r.id===fixture.base_id:r.type==='tool'&&r.id===activity);assert(r,'Missing tool '+activity);return {id:crypto.randomUUID(),title,activity,axis:'personal',resource:{type:r.type,id:r.id,name:r.name,generation:r.generation},metric:'minutes',target:60,unit:['guess','computer'].includes(activity)?'games':'positions',session_minutes:20,unit_minutes:null,priority:'normal',notes:'',options};});
 const program=await json('/api/training/programs','POST',{mutation_id:crypto.randomUUID(),name:'Programme complet',definition:{schema_version:1,budget_minutes:480,intention:'',blocks}});
 await json('/api/training/programs/'+program.id+'/activate','POST',{mutation_id:crypto.randomUUID(),expected_revision:program.revision,effective:'now'});
 await page.goto(url+'/#/training-plan');await page.locator('#tp-tab-today').waitFor();await dismissStartup();await tab('week');assert.equal(await page.locator('.tp-week-block [data-plan-action="launch-block"]').count(),7);
 await capture('seven-tools-desktop-fr');check('All seven native modes are available as automatic programme blocks');

 let run=await launch(blocks[0]);await page.locator('[data-filters] [type="submit"]').click();await page.locator('[data-puzzle-board] .chess-board').waitFor();let ref=await nativeRef(run.id);const original=ref.id;
 await page.locator('[data-training-session-bar]').waitFor();assert.equal(await page.locator('[data-program-session="pause"]').isVisible(),false,'Classic puzzles do not promise a native pause');await returnProgram({menu:true});await page.reload();await page.locator('[data-plan-action="resume-run"]').first().waitFor();await dismissStartup();await page.locator('[data-plan-action="resume-run"][data-run="'+run.id+'"]').click();await page.locator('[data-puzzle-board] .chess-board').waitFor();assert.equal((await nativeRef(run.id)).id,original);
 await move('[data-puzzle-board]','g6g7');await page.locator('.puzzle-feedback[data-state="success"]').waitFor();await finishRun(run);assert.equal((await week()).blocks.find(b=>b.id===blocks[0].id).progress.positions,1);check('Classic puzzle: real solution, return/reload/resume without a fake pause or duplicate attempt/credit');

 run=await launch(blocks[1]);await page.locator('[data-filters] [type="submit"]').click();await page.locator('[data-timer]').waitFor();ref=await nativeRef(run.id);assert.equal(ref.tool,'storm');await move('[data-puzzle-board]','g6g7');await page.waitForFunction(()=>document.querySelector('.puzzle-storm-score>strong')?.textContent==='1');await json('/__test/storm/'+ref.id+'/expire','POST',{});await move('[data-puzzle-board]','g6g7');await page.locator('.storm-results').waitFor();await finishRun(run);const stormWeek=await week(),stormLinks=stormWeek.activities.filter(a=>a.run_id===run.id&&a.history);assert.equal(stormLinks.length,1);assert.equal(stormLinks[0].tool,'storm');check('Storm: parent-only attribution, actual answer, native expiry and one programme episode');

 run=await launch(blocks[2]);await page.locator('[data-game-picker] [data-entry]').first().click();await page.locator('[data-guess-launch] [type="submit"]').click();await page.locator('.guess-workbench .chess-board').waitFor();ref=await nativeRef(run.id);assert.equal((await json('/api/guess-move/sessions/'+ref.id)).side,'both');
 for(const uci of ['e2e4','e7e5','g1f3']){await move('.guess-workbench [data-board]',uci);await page.locator('[data-continue]').waitFor();await page.locator('[data-continue]').click();await page.locator('[data-continue]').waitFor({state:'hidden'});}
 await poll(async()=>{const s=await json('/api/guess-move/sessions/'+ref.id);return s.completed;},'finished guess game');await finishRun(run);check('Guess the move: real source base and both-sides options, persisted native result');

 run=await launch(blocks[3]);await page.locator('[data-setup] [type="submit"]').click();await page.locator('.computer-page .chess-board').waitFor();await move('.computer-page [data-board]','e2e4');await page.waitForFunction(()=>document.querySelectorAll('.computer-moves [data-path]').length===2);ref=await nativeRef(run.id);
 await page.locator('[data-program-session="pause"]').click();await page.locator('[data-training-session-bar][data-paused="true"]').waitFor();await page.locator('.computer-status.paused').waitFor();assert.equal(await page.locator('#tp-tab-today').count(),0,'Pause keeps the current activity visible');
 await returnProgram();await page.locator('[data-plan-action="resume-run"][data-run="'+run.id+'"]').click();await page.locator('.computer-page .chess-board').waitFor();assert.equal((await nativeRef(run.id)).id,ref.id);assert.equal(await page.locator('.computer-moves [data-path]').count(),2);
 await page.locator('[data-program-session="resume"]').click();await page.locator('[data-training-session-bar][data-paused="false"]').waitFor();await page.locator('[data-resign]').click();await page.locator('.computer-status.lost').waitFor();await finishRun(run);check('Computer: actual engine reply, in-place pause, same archived game and explicit resume, measured activity flushed before finish');

 run=await launch(blocks[4]);await page.locator('[data-start-custom]').click();await page.locator('[data-ready]').waitFor();ref=await nativeRef(run.id);const blind=await json('/api/skills/blindfold/'+ref.id);assert.equal(blind.config.mode,'positions');assert.equal(blind.config.max_pieces,3);await page.locator('[data-ready]').click();await move('.skill-square-grid','g6g7');await page.locator('.skill-result-banner').waitFor();await finishRun(run);check('Blindfold: configured position/piece load, real answer and programme attribution');

 run=await launch(blocks[5]);await page.locator('[data-coordinate-setup] [type="submit"]').click();await page.locator('.skill-target').waitFor();ref=await nativeRef(run.id);const target=(await page.locator('.skill-target').textContent()).slice(-2);await page.locator('[data-square="'+target+'"]').click();await page.waitForFunction(()=>document.querySelector('[data-score]')?.textContent==='1');await json('/__test/coordinates/'+ref.id+'/expire','POST',{});await json('/api/skills/coordinates/'+ref.id+'/finish','POST',{});await page.reload();await page.locator('[data-coordinate-again]').waitFor();await dismissStartup();await finishRun(run);assert.equal((await week()).blocks.find(b=>b.id===blocks[5].id).progress.positions,1);check('Coordinates: black orientation, accepted answer, native expiry and reload');

 run=await launch(blocks[6]);assert.equal(await page.locator('[data-color-setup] [name="duration"]').inputValue(),'60');await page.locator('[data-color-setup] [type="submit"]').click();await page.locator('.color-question').waitFor();ref=await nativeRef(run.id);
 for(let i=0;i<3;i++){const s=await json('/api/skills/color/'+ref.id),square=s.target.square,color=((square.charCodeAt(0)-97)+Number(square[1]))%2?'black':'white';await page.waitForTimeout(150);await page.locator('[data-color="'+color+'"]').click();await poll(async()=>{const v=await json('/api/skills/color/'+ref.id);return v.answered>=i+1;},'color answer');}
 await json('/__test/color/'+ref.id+'/expire','POST',{});await json('/api/skills/color/'+ref.id+'/finish','POST',{});await page.reload();await page.locator('[data-color-again]').waitFor();await dismissStartup();await capture('color-result-with-programme');await finishRun(run);assert.equal((await week()).blocks.find(b=>b.id===blocks[6].id).progress.positions,3);check('Color: configured duration and three native answers counted exactly once');

 await tab('week');await page.locator('[data-plan-action="open-assistance"]').click();await page.locator('[data-plan-action="toggle-auto-assignment"]').waitFor();let assistance=await json('/api/training/assistance');assert.equal(assistance.settings.auto_assign,false);assert(assistance.suggestions.length>0,'Recorded native units should yield an estimate');
 await page.locator('[data-plan-action="preview-adjustment"]').first().click();await page.locator('[data-plan-action="apply-adjustment"]').waitFor();const before=await json('/api/training/programs/'+program.id);await page.locator('[data-plan-action="apply-adjustment"]').click();await poll(async()=>{const p=await json('/api/training/programs/'+program.id);return p.revision>before.revision;},'explicit adjustment');check('Observed-duration suggestion stays unchanged until explicitly applied');
 await page.locator('[data-plan-action="toggle-auto-assignment"]').click();await poll(async()=>(await json('/api/training/assistance')).settings.auto_assign,'auto-assignment opt-in');
 const free=await json('/api/skills/color','POST',{duration:60});await json('/api/skills/color/'+free.id+'/answer','POST',{color:'white',index:free.index,nonce:free.nonce});await json('/__test/color/'+free.id+'/expire','POST',{});await json('/api/skills/color/'+free.id+'/finish','POST',{});const automatic=(await week()).activities.find(a=>a.history?.identity===free.id);assert(automatic);assert.equal(automatic.block_id,blocks[6].id);check('Opt-in unique attribution assigns real free work without manual duplication');
 await page.locator('[data-plan-action="close-assistance"]').click();await page.locator('[data-plan-action="duplicate-week"]').first().click();await page.locator('[data-duplicate-name]').fill('Semaine réutilisée');const count=(await json('/api/training/state')).programs.length;await page.locator('[data-plan-action="confirm-duplicate"]').click();await page.locator('[data-program-field="name"]').waitFor();const next=await json('/api/training/state');assert.equal(next.programs.length,count+1);const copy=next.programs.find(p=>p.name==='Semaine réutilisée');assert.equal(copy.status,'draft');assert.equal(next.current_program_id,program.id);assert(copy.definition.blocks.every(b=>!blocks.some(old=>old.id===b.id)));check('Week reuse previews and creates an independent draft without results or activation');
 await page.locator('[data-program-action="toggle"]').first().click();await page.setViewportSize({width:390,height:844});await capture('native-options-mobile-fr');await tab('week');await page.locator('[data-plan-action="open-assistance"]').click();await page.locator('[data-plan-action="toggle-auto-assignment"]').waitFor();await capture('assistance-mobile-fr');
 await json('/api/preferences','PATCH',{language:'en'});await page.reload();await page.locator('#tp-tab-week').waitFor();await dismissStartup();await page.locator('[data-plan-action="open-assistance"]').click();await page.locator('[data-plan-action="toggle-auto-assignment"]').waitFor();await capture('assistance-mobile-en');assert.match(await page.locator('.tp-assistance').innerText(),/Assistance and adjustments/);check('Phone layouts and assistance translations fit in French and English');
 assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.failure=String(error);await page.screenshot({path:join(output,'failure.png'),fullPage:true});throw error;}finally{await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));await context.close();}
