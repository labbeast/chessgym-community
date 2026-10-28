import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const require=createRequire(import.meta.url);
const {chromium}=require(join(process.env.CHESSGYM_TEST_NODE_MODULES,'playwright'));
const url=process.env.CHESSGYM_TEST_URL,output=process.env.CHESSGYM_TEST_OUTPUT;
assert.equal(new URL(url).hostname,'127.0.0.1','Only isolated loopback fixtures may be tested');
const boards=['brown','blue','green','slate','walnut','sand','olive','ocean','lavender','rose','ice','graphite'];
const pieces=['cburnett','merida','chessnut','celtic','fantasy','shapes','pirouetti','spatial'];
const themes=['copper','sage','midnight','plum','forest','pearl','sand','contrast'];
const selectors={theme:'data-theme-choice',piece_set:'data-appearance-piece',board_theme:'data-appearance-board'};
const choices=Object.values(selectors).map(attribute=>'['+attribute+']').join(',');
const report={status:'running',checks:[],geometry:[],errors:[],externalRequests:[],boardColors:[],uiColors:[],pieceAssets:[]};
const browser=await chromium.launch({executablePath:process.env.CHESSGYM_TEST_BROWSER,headless:true,args:['--no-first-run','--no-default-browser-check','--disable-extensions']});
const context=await browser.newContext({viewport:{width:1440,height:900}});
let failNextSave=false,holdNextSave=false,heldRoute=null;
async function configure(target){
 await target.addInitScript(()=>{try{localStorage.setItem('chessgym.startup.v1',JSON.stringify({page:'library',resume:'never'}));}catch{}});
 target.on('request',request=>{if(new URL(request.url()).origin!==url)report.externalRequests.push(request.url());});
 target.on('page',opened=>opened.on('pageerror',error=>report.errors.push(String(error))));
 await target.route('**/*',async route=>{
  const request=route.request(),parsed=new URL(request.url());
  if(parsed.origin!==url)return route.abort();
  if(parsed.pathname==='/api/preferences'&&request.method()==='PATCH'){
   if(failNextSave){failNextSave=false;return route.fulfill({status:503,json:{detail:'Échec de sauvegarde simulé.'}});}
   if(holdNextSave){holdNextSave=false;heldRoute=route;return;}
  }
  if(parsed.pathname==='/api/explorer')return route.fulfill({json:{moves:[],primary:{status:'ok',complete:true,total:0,label:'Test local'},masters:{status:'disabled',total:0}}});
  if(parsed.pathname.startsWith('/api/explorer/probability'))return route.fulfill({json:{status:'unavailable',probability:null}});
  if(parsed.pathname.startsWith('/api/engine/')&&!parsed.pathname.endsWith('/settings'))return route.fulfill({status:503,json:{detail:'Moteur désactivé pour le test isolé.'}});
  return route.continue();
 });
}
await configure(context);
const page=await context.newPage(),boardPage=await context.newPage();
page.setDefaultTimeout(15000);boardPage.setDefaultTimeout(15000);
async function json(path,method='GET',data,target=context){
 const response=await target.request.fetch(url+path,{method,...(data===undefined?{}:{data})});
 assert(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);
 return response.json();
}
async function waitJson(predicate){const end=Date.now()+15000;do{const value=await json('/api/preferences');if(predicate(value))return value;await new Promise(resolve=>setTimeout(resolve,80));}while(Date.now()<end);throw Error('Timed out waiting for preferences');}
async function check(name,action){if(process.env.CHESSGYM_BROWSER_CHECK&&!name.includes(process.env.CHESSGYM_BROWSER_CHECK))return;await action();report.checks.push(name);console.log('PASS '+name);}
async function settings(target=page){
 await target.goto(url+'/#/settings');
 await target.locator('[data-settings-tab="appearance"]').click();
 await target.locator('[data-settings-panel="appearance"]').waitFor({state:'visible'});
}
async function select(key,id){
 const button=page.locator('['+selectors[key]+'="'+id+'"]');
 await button.click();
 await waitJson(prefs=>prefs[key]===id);
 await page.waitForFunction(({attribute,id})=>document.querySelector('['+attribute+'="'+id+'"]')?.getAttribute('aria-pressed')==='true'&&!document.querySelector('['+attribute+'="'+id+'"]')?.disabled,{attribute:selectors[key],id});
 assert.equal(await page.locator('['+selectors[key]+'][aria-pressed="true"]').count(),1);
}
async function renderedBoard(){
 await boardPage.goto(url+'/#/board');await boardPage.reload();
 await boardPage.locator('#board-host .chess-board').waitFor();
 await boardPage.waitForFunction(()=>[...document.querySelectorAll('#board-host .chess-board img')].length===32&&[...document.querySelectorAll('#board-host .chess-board img')].every(image=>image.complete&&image.naturalWidth>0));
 return boardPage.locator('#board-host .chess-board');
}
async function screenshot(name,target=page){
 await target.evaluate(()=>window.scrollTo(0,0));
 await target.screenshot({path:join(output,name+'.png'),fullPage:true});
 const geometry=await target.evaluate(()=>({viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('[data-settings-panel="appearance"] button')].filter(node=>node.getBoundingClientRect().right>innerWidth+1).map(node=>node.textContent)}));
 report.geometry.push({name,...geometry});assert(geometry.scrollWidth<=geometry.viewport+1,'No horizontal overflow: '+name+': '+JSON.stringify(geometry));
}
async function readable(locator,label){
 const metrics=await locator.first().evaluate(node=>{
  const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
  let surface=node,background=getComputedStyle(surface).backgroundColor;
  while(surface.parentElement&&background==='rgba(0, 0, 0, 0)'){surface=surface.parentElement;background=getComputedStyle(surface).backgroundColor;}
  const text=getComputedStyle(node).color,luminance=color=>rgb(color).map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const foreground=luminance(text),back=luminance(background);return {text,background,ratio:(Math.max(foreground,back)+.05)/(Math.min(foreground,back)+.05)};
 });
 (report.readability??=[]).push({label,...metrics});assert(metrics.ratio>=4.5,label+' must have readable text contrast: '+JSON.stringify(metrics));
}
try{
 await json('/api/setup-resources/complete','POST',{});
 await settings();
 await check('Les 28 choix sont proposés et toutes les illustrations chargent localement',async()=>{
  for(const [key,ids]of [['theme',themes],['piece_set',pieces],['board_theme',boards]])assert.deepEqual(await page.locator('['+selectors[key]+']').evaluateAll((nodes,attribute)=>nodes.map(node=>node.getAttribute(attribute)),selectors[key]),ids);
  await page.waitForFunction(()=>[...document.querySelectorAll('[data-settings-panel="appearance"] img')].length>0&&[...document.querySelectorAll('[data-settings-panel="appearance"] img')].every(image=>image.complete&&image.naturalWidth>0));
  const assets=pieces.flatMap(set=>['w','b'].flatMap(color=>['K','Q','R','B','N','P'].map(piece=>({set,piece:color+piece,path:'/static/pieces/'+(set==='cburnett'?'':set+'/')+color+piece+'.svg'}))));
  report.pieceAssets=await page.evaluate(async assets=>Promise.all(assets.map(async asset=>{
   const loaded=await new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth>0&&image.naturalHeight>0);image.onerror=()=>resolve(false);image.src=asset.path;});
   const response=await fetch(asset.path);return {...asset,loaded,status:response.status,body:await response.text()};
  })),assets);
  assert.equal(report.pieceAssets.length,96);assert(report.pieceAssets.every(asset=>asset.loaded&&asset.status===200&&/<svg[\s>]/.test(asset.body)),'All 12 pieces in each set must load as SVG');
  const silhouettes=pieces.map(set=>report.pieceAssets.filter(asset=>asset.set===set).map(asset=>asset.body).join('\n'));
  assert.equal(new Set(silhouettes).size,pieces.length,'Piece sets must contain different artwork');
  report.pieceAssets=report.pieceAssets.map(({body,...asset})=>asset);
 });
 await check('Les 8 apparences modifient les couleurs de l’interface et se sauvegardent',async()=>{
  for(const id of themes){
   await select('theme',id);assert.equal(await page.locator('body').getAttribute('data-theme'),id);
   report.uiColors.push(await page.locator('body').evaluate((node,id)=>{const style=getComputedStyle(node);return {id,background:style.backgroundColor,text:style.color,accent:style.getPropertyValue('--accent').trim(),surface:style.getPropertyValue('--surface').trim()};},id));
  }
  assert.equal(new Set(report.uiColors.map(({background,text,accent,surface})=>JSON.stringify({background,text,accent,surface}))).size,themes.length,'Each interface theme must visibly differ');
 });
 await check('Les 12 couleurs se retrouvent sur les vraies cases de l’échiquier',async()=>{
  for(const id of boards){
   await select('board_theme',id);const board=await renderedBoard();
   assert.equal(await boardPage.locator('html').getAttribute('data-board-theme'),id);
   const light=await board.locator('.square.light').first().evaluate(node=>getComputedStyle(node).backgroundColor);
   const dark=await board.locator('.square.dark').first().evaluate(node=>getComputedStyle(node).backgroundColor);
   assert.notEqual(light,dark);report.boardColors.push({id,light,dark});
  }
  assert.equal(new Set(report.boardColors.map(({light,dark})=>light+'/'+dark)).size,boards.length,'Every board palette must visibly differ');
 });
 await check('Les 8 jeux de pièces sont utilisés sur l’échiquier et dans les aperçus',async()=>{
  for(const id of pieces){
   await select('piece_set',id);const board=await renderedBoard(),prefix='/static/pieces/'+(id==='cburnett'?'':id+'/');
   const paths=await board.locator('img').evaluateAll(nodes=>nodes.map(node=>new URL(node.src).pathname));
   assert.equal(paths.length,32);assert(paths.every(path=>path.startsWith(prefix)&&(!id||id!=='cburnett'||!path.slice(prefix.length).includes('/'))));
   assert.equal(new Set(paths).size,12,'Initial position displays all white and black piece kinds');
   assert((await page.locator('[data-appearance-board] img').evaluateAll(nodes=>nodes.map(node=>new URL(node.src).pathname))).every(path=>path.startsWith(prefix)),'All board previews follow the chosen piece set');
  }
 });
 await check('Une sauvegarde en cours désactive les choix puis confirme le résultat',async()=>{
  holdNextSave=true;await page.locator('[data-theme-choice="plum"]').click();
  await page.waitForFunction(()=>/Enregistrement|Saving/.test(document.querySelector('[data-appearance-status]')?.textContent||''));
  assert(heldRoute,'The preference request is held by this test');
  assert(await page.locator(choices).evaluateAll(nodes=>nodes.length===28&&nodes.every(node=>node.disabled)),'Every appearance choice is disabled during the pending save');
  assert.equal((await json('/api/preferences')).theme,'contrast');
  const pending=heldRoute;heldRoute=null;await pending.continue();await waitJson(prefs=>prefs.theme==='plum');
  await page.waitForFunction(()=>document.querySelector('[data-theme-choice="plum"]')?.getAttribute('aria-pressed')==='true'&&!document.querySelector('[data-theme-choice="plum"]')?.disabled);
 });
 await check('Un échec conserve le choix enregistré et permet de réessayer',async()=>{
  for(const [key,id]of [['theme','forest'],['piece_set','fantasy'],['board_theme','ocean']]){
   const before=await json('/api/preferences');failNextSave=true;await page.locator('['+selectors[key]+'="'+id+'"]').click();
   await page.waitForFunction(()=>document.querySelector('[data-appearance-status]')?.classList.contains('error')&&document.querySelector('[data-appearance-status]')?.textContent.includes('simulé'));
   assert.equal((await json('/api/preferences'))[key],before[key]);
   assert.equal(await page.locator('['+selectors[key]+'="'+before[key]+'"]').getAttribute('aria-pressed'),'true');
   assert.equal(await page.locator(choices).evaluateAll(nodes=>nodes.some(node=>node.disabled)),false);
  }
  await select('theme','pearl');await select('piece_set','celtic');await select('board_theme','lavender');
 });
 await check('Les choix persistent après rechargement et ouverture du même profil local dans un autre contexte',async()=>{
  await page.reload();await page.locator('[data-settings-panel="appearance"]').waitFor({state:'visible'});
  for(const [key,id]of [['theme','pearl'],['piece_set','celtic'],['board_theme','lavender']])assert.equal(await page.locator('['+selectors[key]+'="'+id+'"]').getAttribute('aria-pressed'),'true');
  const second=await browser.newContext({viewport:{width:1440,height:900}});await configure(second);
  try{
   const other=await second.newPage();await settings(other);
   for(const [key,id]of [['theme','pearl'],['piece_set','celtic'],['board_theme','lavender']])assert.equal(await other.locator('['+selectors[key]+'="'+id+'"]').getAttribute('aria-pressed'),'true');
   assert.equal(await other.locator('body').getAttribute('data-theme'),'pearl');
  }finally{await second.close();}
 });
 await check('Français et anglais : aperçu lisible, contrôles accessibles et aucun débordement à 390 et 320 px',async()=>{
  for(const language of ['fr','en']){
   await page.locator('[data-settings-tab="general"]').click();await page.locator('#interface-language').selectOption(language);
   await waitJson(prefs=>prefs.language===language);await page.waitForFunction(language=>document.documentElement.lang===language,language);
   await page.locator('[data-settings-tab="appearance"]').click();
   const text=await page.locator('[data-settings-panel="appearance"]').innerText();
   if(language==='en'){assert.match(await page.locator('[data-settings-tab="appearance"]').innerText(),/Appearance/);assert.doesNotMatch(text,/Échiquier|échiquier|Pièces|Brun classique|Enregistrement|Jeu de pièces/);}
   for(const width of [1440,390,320]){await page.setViewportSize({width,height:width===1440?900:844});await screenshot('appearance-'+language+'-'+width);}
   await page.setViewportSize({width:1440,height:900});
  }
  const choice=page.locator('[data-theme-choice="sand"]');await choice.focus();await page.keyboard.press('Enter');await waitJson(prefs=>prefs.theme==='sand');
  await page.waitForFunction(()=>document.querySelector('[data-appearance-status]')?.textContent==='Appearance saved.');
  await renderedBoard();await screenshot('board-celtic-lavender-sand',boardPage);
 });
 await check('Thèmes clairs : réglages d’entraînement, statistiques et statuts restent lisibles',async()=>{
  const base=await json('/api/bases','POST',{name:'Contraste des révisions',settings:{review_enabled:true,type:'solve',mode:'hybrid'}});
  await json('/api/entries','POST',{base_id:base.id,title:'Position de contraste',pgn:'[Result "*"]\n\n1. e4 e5 *'});
  for(const theme of ['pearl','sand']){
   await page.setViewportSize({width:1440,height:900});await settings();await select('theme',theme);
   await readable(page.locator('[data-appearance-status]'),theme+' saved status');
   failNextSave=true;await page.locator('[data-theme-choice="forest"]').click();
   await page.waitForFunction(()=>document.querySelector('[data-appearance-status]')?.classList.contains('error'));
   await readable(page.locator('[data-appearance-status]'),theme+' error status');
   await page.setViewportSize({width:390,height:844});await page.locator('[data-theme-choice="forest"]').scrollIntoViewIfNeeded();
   const status=await page.locator('[data-appearance-status]').boundingBox();assert(status&&status.y>=0&&status.y+status.height<=844-70,'Mobile status stays above bottom navigation');
   await page.screenshot({path:join(output,'appearance-'+theme+'-mobile-status.png')});
   await page.setViewportSize({width:1440,height:900});await page.goto(url+'/#/color');
   await page.locator('[data-training-settings]').click();await page.locator('.skill-settings').waitFor({state:'visible'});
   await readable(page.locator('.skill-settings label'),theme+' training settings label');
   await readable(page.locator('.skill-settings p'),theme+' training settings hint');
   await screenshot('training-settings-'+theme);
   await page.locator('[data-training-play-tab]').click();await page.locator('[data-color-setup] button[type="submit"]').click();
   for(const correct of [true,false]){
    const square=(await page.locator('.color-question').innerText()).trim().toLowerCase();
    let answer=(square.charCodeAt(0)-97+Number(square[1])-1)%2===0?'black':'white';if(!correct)answer=answer==='black'?'white':'black';
    await page.locator('[data-color="'+answer+'"]').click();
    await page.locator('.color-feedback.'+(correct?'correct':'incorrect')).waitFor();
    await readable(page.locator('.color-feedback'),theme+' '+(correct?'correct':'incorrect')+' answer');
   }
   await screenshot('training-feedback-'+theme);
   await page.goto(url+'/#/reviews');await page.locator('[data-review-view="statistics"]').click();
   await page.locator('#review-statistics .review-progress-legend strong').first().waitFor();
   await readable(page.locator('#review-statistics .review-progress-legend strong'),theme+' review counts');
   await readable(page.locator('#review-statistics .review-progress-legend span'),theme+' review legend');
   await screenshot('review-statistics-'+theme);
  }
 });
 await check('Logo des thèmes clairs : le pictogramme mobile garde son dessin',async()=>{
  for(const theme of ['pearl','sand']){
   await settings();await select('theme',theme);await page.setViewportSize({width:390,height:844});
   await page.waitForFunction(()=>{const source=document.querySelector('.brand img')?.currentSrc;return source&&new URL(source).pathname.endsWith('/chessgym-32.png');});
   const logo=await page.locator('.brand img').evaluate(node=>({source:node.currentSrc,filter:getComputedStyle(node).filter}));
   assert.equal(logo.filter,'none',theme+' mobile logo preserves its opaque icon artwork');
   (report.logos??=[]).push({theme,...logo});await page.evaluate(()=>window.scrollTo(0,0));
   await page.screenshot({path:join(output,'logo-'+theme+'-mobile.png')});
  }
 });
 assert(report.checks.length>0,'No browser scenario matched');
 assert.deepEqual(report.errors,[],'Unexpected browser runtime errors');
 assert.deepEqual(report.externalRequests,[],'Appearance resources must remain local');
 report.status='passed';
}catch(error){
 report.status='failed';report.failure={message:error.message,stack:error.stack,url:page.url()};
 await page.screenshot({path:join(output,'failure.png'),fullPage:true}).catch(()=>{});
 await writeFile(join(output,'failure.html'),await page.content()).catch(()=>{});
 console.error(error.stack);process.exitCode=1;
}finally{
 if(heldRoute)await heldRoute.abort().catch(()=>{});
 await writeFile(join(output,'report.json'),JSON.stringify(report,null,2));
 await browser.close();console.log(JSON.stringify(report,null,2));
}
