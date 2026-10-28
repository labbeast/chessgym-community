import {setLanguage,getLanguage} from '../static/i18n.js';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const boardMock=String.raw`export function makeDoc(){return {headers:{Result:'*'},nodes:[{path:'',parent:null,fen:'root',children:['0'],comment:'',nags:[]},{path:'0',parent:'',fen:'after',san:'e4',children:[],comment:'',nags:[]}]};}export function serialize(doc){return JSON.stringify(doc);}export function movesHtml(){return '';}export function clocksHtml(){return '';}export function pieces(){return {};}export class Board{constructor(host,opts){Object.assign(this,{host,...opts,disposed:false,engineOn:false,flipped:false,busy:false,inputLocked:false});}dispose(){this.disposed=true;}node(){return this.doc.nodes.find(n=>n.path===this.path)||this.doc.nodes[0];}async setDoc(doc,path){this.doc=doc;this.path=path;}renderBoard(){}setAnalysisReport(report){this.lastReport=report;}async go(path){this.path=path;this.onChange?.(this);}control(action){if(action==='engine')this.engineOn=!this.engineOn;}}`;
registerHooks({load(url,context,nextLoad){
 if(url.endsWith('/static/training-session-bar.js'))return {format:'module',shortCircuit:true,source:'export class TrainingSessionBar{constructor(){}render(){}dispose(){}}'};
 if(process.argv[2]?.startsWith('training_history_')){
  if(url.endsWith('/static/training-history.js'))return {format:'module',shortCircuit:true,source:String.raw`export const TRAINING_HISTORY_TOOLS={reading:'Lecture',puzzles:'Puzzles',color:'Color',guess:'Deviner le coup'};export const historyDuration=value=>String(value);export class TrainingHistoryView{constructor(host,options){this.host=host;this.options=options;(globalThis.trainingHistoryPanels??=[]).push(this);}async load(){}dispose(){this.disposed=true;}}export async function openTrainingHistory(options){const dialog={options,open:true,handlers:new Map(),addEventListener(name,handler){this.handlers.set(name,handler);},close(){this.open=false;this.closed=true;this.handlers.get('close')?.();}};(globalThis.trainingHistoryDialogs??=[]).push(dialog);if(globalThis.historyDialogGate)await globalThis.historyDialogGate;return dialog;}`};
  if(url.endsWith('/static/computer-history.js'))return {format:'module',shortCircuit:true,source:'export function openComputerSettings(){}export class ComputerHistoryView{constructor(host,options){this.host=host;this.options=options;this.opened=[];(globalThis.computerHistoryPanels??=[]).push(this);}async load(){}async openTrainingRecord(record){this.opened.push(record);}dispose(){this.disposed=true;}}'};
  for(const [file,kind,name] of [['puzzles','puzzles','PuzzleView'],['color-training','color','ColorTrainingView'],['guess-move','guess','GuessMoveView'],['computer-play','computer','ComputerPlayView']]){
   if(url.endsWith('/static/'+file+'.js'))return {format:'module',shortCircuit:true,source:`export class ${name}{constructor(host,options){this.host=host;this.options=options;this.kind='${kind}';this.opened=[];(globalThis.trainingPanels??=[]).push(this);}snapshot(){return null;}async load(snapshot){this.loaded=snapshot;this.session=snapshot?.session;await globalThis.trainingLoads?.get(this.kind);}async openTrainingRecord(record){this.opened.push(record);}dispose(){this.disposed=true;}}`};
  }
 }
 if(url.endsWith('/static/reference-library.js'))return {format:'module',shortCircuit:true,source:'export class ReferenceLibrary{constructor(host,options){this.host=host;this.options=options;this.disposed=false;(globalThis.referencePanels??=[]).push(this);}dispose(){this.disposed=true;}}export function referenceImportDialog(options){globalThis.referenceImportOptions=options;}export function referenceStatusLabel(){return "Référence";}'};
 if(url.endsWith('/static/repertoire-coverage.js'))return {format:'module',shortCircuit:true,source:'export function coverageProbability(value){return {percent:String((Number(value)||0)*100)+"%",odds:Number(value)>0?"1/"+Math.round(1/value):"—"};}export class RepertoireCoverage{constructor(host,options){this.host=host;this.options=options;this.disposed=false;this.ready=Promise.resolve();globalThis.coveragePanels.push(this);}dispose(){this.disposed=true;}}'};
 if(url.endsWith('/static/review-statistics.js'))return {format:'module',shortCircuit:true,source:'export class ReviewStatistics{constructor(host,options){this.host=host;this.options=options;globalThis.statisticsPanels.push(this);}dispose(){this.disposed=true;}}'};
 if(url.endsWith('/static/entry-table.js'))return {format:'module',shortCircuit:true,source:'export class EntryTable{constructor(host,options){this.host=host;this.options=options;this.updates=[];globalThis.entryTables.push(this);}update(value){this.updates.push(value);}dispose(){this.disposed=true;}}'};
 if(url.endsWith('/static/exercise-editor.js'))return {format:'module',shortCircuit:true,source:'export function openExerciseEditor(options){globalThis.exerciseEditors.push(options);return options;}'};
 if(url.endsWith('/static/board.js'))return {format:'module',shortCircuit:true,source:boardMock};
 if(url.endsWith('/static/position-panel.js'))return {format:'module',shortCircuit:true,source:'export class PositionPanel{constructor(host,options){this.host=host;this.options=options;this.visible=options.visible;this.initialVisible=options.visible;this.visibility=[options.visible];this.updates=[];this.disposed=false;this.ready=Promise.resolve();globalThis.positionPanels.push(this);}update(){this.updates.push({board:this.options.board,fen:this.options.board.node().fen,path:this.options.board.path});}setVisible(value){this.visible=value;this.visibility.push(value);}dispose(){this.disposed=true;}}'};
 if(url.endsWith('/static/explorer.js'))return {format:'module',shortCircuit:true,source:'export class OpeningExplorer{constructor(host,options){this.options=options;this.visible=options.visible;this.initialVisible=options.visible;this.visibility=[options.visible];globalThis.explorerPanels.push(this);}update(){}setVisible(value){this.visible=value;this.visibility.push(value);}dispose(){}}'};
 if(url.endsWith('/static/played-games.js'))return {format:'module',shortCircuit:true,source:'export class PlayedGamesPanel{constructor(){}dispose(){}}export class GameAnalysisPanel{constructor(host,options){this.options=options;globalThis.analysisPanels.push(this);}update(){}dispose(){this.disposed=true;}}'};
 if(url.endsWith('/static/analysis-charts.js'))return {format:'module',shortCircuit:true,source:'export class AnalysisCharts{constructor(){this.reports=[];globalThis.chartPanels.push(this);}update(){}updateReport(report){this.reports.push(report);}dispose(){this.disposed=true;}}'};
 if(url.endsWith('/static/repertoire-panel.js'))return {format:'module',shortCircuit:true,source:'export class RepertoirePanel{constructor(host,options){this.host=host;this.options=options;this.disposed=false;(globalThis.repertoirePanels??=[]).push(this);}update(){}render(){}dispose(){this.disposed=true;}}'};
 if(url.endsWith('/static/metadata.js'))return {format:'module',shortCircuit:true,source:'export function editMetadata(doc,options){globalThis.metadataCallbacks.push({doc,options});}'};
 if(url.endsWith('/static/review.js'))return {format:'module',shortCircuit:true,source:String.raw`export const reviewSessionFinished=s=>s.index>=s.cards.length;function board(){return {disposed:false,node(){return {fen:globalThis.reviewPosition||"after"};}};}export function startReview(host,base,options){const session={host,base,options,index:2,completed:2,cards:[{id:31},{id:32},{id:33}]};globalThis.reviewSessions.push(session);globalThis.currentReviewSession=session;globalThis.activeReviewBoard=board();}export function stopReview(){if(globalThis.activeReviewBoard)globalThis.activeReviewBoard.disposed=true;globalThis.activeReviewBoard=null;}export function suspendReview(options){if(!globalThis.activeReviewBoard||globalThis.reviewSuspendBlocked)return null;const snapshot={session:globalThis.currentReviewSession,options};globalThis.reviewSuspendCalls.push(snapshot);stopReview();return snapshot;}export async function prepareReviewResume(snapshot){globalThis.reviewPrepareCalls.push(snapshot);return globalThis.reviewPrepareImpl?await globalThis.reviewPrepareImpl(snapshot):{snapshot};}export function resumeReview(host,prepared){globalThis.reviewResumeCalls.push({host,prepared});if(globalThis.reviewResumeImpl)return globalThis.reviewResumeImpl(host,prepared);globalThis.currentReviewSession=prepared.snapshot.session;globalThis.activeReviewBoard=board();return true;}export function snapshotReview(){return null;}export function reviewSnapshotData(value){return value;}export function reviewAssistance(){}export function reviewFen(){}export function reviewBoard(){return globalThis.activeReviewBoard||null;}export function reviewToolbarState(){return null;}export function pauseReviewToolbar(){return false;}export function resumeReviewToolbar(){return false;}export function reviewTrainingContext(){return null;}export async function settleReviewTraining(){return null;}`};
 if(url.endsWith('/static/appearance.js'))return {format:'module',shortCircuit:true,source:'export function pieceUrl(){return "";}export function applyAppearance(){}export function appearanceSettingsHtml(){return "";}export function bindAppearanceSettings(){}'};
 const result=nextLoad(url,context);if(url.endsWith('/static/api.js'))result.source=String(result.source).replace('export function modal(', 'function originalModal(')+'\nexport function modal(title,html,options={}){const dialog={title,html,options};globalThis.dialogs.push(dialog);return dialog;}';if(url.endsWith('/static/app.js'))result.source=String(result.source)+'\nexport {boot,restoreStartup,resumeComputerHistory,renameBoardDraft,applyRenameBoardDraft,deleteBoardDraft,boardMenuAction,newAnalysisBoard,openTrainingRecord,showReadingHistory,switchWorkspaceIdentity,restoreRoute,restoreAnalysis,state,openEntry,openReviewEntry,launchReview,navigate,action,editTree,editHistory,selectAnalysisTool,selectReviewView,moveMenu,freeHistory,baseAppearanceEditor,moveLibraryBase,status,backupSettingsHtml,workspace,drafts,baseSettings,changeLanguage,languageSettingsHtml};';return result;
}});
class Element{constructor(){this.dataset={};this.attributes=new Map();this.handlers=new Map();this.children=[];const classes=new Set(),styles=new Map();this.classList={add(...names){names.forEach(name=>classes.add(name));},remove(...names){names.forEach(name=>classes.delete(name));},contains(name){return classes.has(name);},toggle(name,force){const enabled=force??!classes.has(name);if(enabled)classes.add(name);else classes.delete(name);return enabled;}};this.style={setProperty(key,value){styles.set(key,String(value));},getPropertyValue(key){return styles.get(key)||'';},removeProperty(key){styles.delete(key);}};this.disabled=false;}addEventListener(type,fn){this.handlers.set(type,fn);}removeEventListener(type,fn){if(this.handlers.get(type)===fn)this.handlers.delete(type);}querySelectorAll(){return [];}querySelector(){return null;}contains(node){return node===this||this.children.some(child=>child===node||child.contains?.(node));}closest(selector){return selector==='[data-reading-action]'&&this.dataset.readingAction?this:null;}setAttribute(key,value){this.attributes.set(key,String(value));}getAttribute(key){return this.attributes.get(key)??null;}removeAttribute(key){this.attributes.delete(key);}append(n){this.children.push(n);}click(){(globalThis.downloadUrls??=[]).push(this.href);}remove(){}focus(){document.activeElement=this;}}
const reviewTabs=['bases','statistics','history'].map(view=>{const tab=new Element();tab.dataset.reviewView=view;return tab;});
let tabItems=[],tabPanels=[];const tabList=new Element();tabList.querySelectorAll=()=>tabItems;
const topbar=new Element(),workbench=new Element(),readingHost=new Element(),readingSize=new Element(),readingActions=new Map(['tools','board','font-less','font-more','reset'].map(action=>{const button=new Element();button.dataset.readingAction=action;return [action,button];}));
readingHost.children=[...readingActions.values(),readingSize];readingHost.querySelector=selector=>selector==='[data-reading-size]'?readingSize:readingActions.get(selector.match(/data-reading-action="([^"]+)"/)?.[1])||null;
function clickReading(action){const listener=readingHost.handlers.get('click');assert.equal(typeof listener,'function','Reading controls are mounted');listener({target:readingActions.get(action)});}
const elements=new Map(),controls=new Map(['undo','redo','move-menu','save-board','save-as','resume-review','toggle-annotations'].map(k=>[k,new Element()]));
globalThis.MutationObserver=class{observe(){}disconnect(){}};
globalThis.document={addEventListener(){},removeEventListener(){},body:new Element(),documentElement:new Element(),getElementById:id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);},querySelectorAll:selector=>selector==='[data-review-view]'?reviewTabs:selector==='[data-analysis-tool]'||selector==='.analysis-tool-tabs [data-analysis-tool]'?tabItems:selector==='.analysis-tool-content'?tabPanels:[],querySelector:selector=>{if(selector==='.topbar')return topbar;if(selector==='.analysis-tool-tabs')return tabList;if(selector==='.analysis-workbench')return workbench;if(selector==='.analysis-reading-controls')return readingHost;const key=selector.match(/data-action="([^"]+)"/)?.[1];return controls.get(key)||null;},createElement:()=>new Element()};
const savedPreferences=new Map();
globalThis.window=new Element();globalThis.localStorage={getItem:key=>savedPreferences.get(key)??null,setItem:(key,value)=>savedPreferences.set(key,String(value))};globalThis.statisticsPanels=[];globalThis.entryTables=[];globalThis.exerciseEditors=[];globalThis.metadataCallbacks=[];globalThis.explorerPanels=[];globalThis.positionPanels=[];globalThis.analysisPanels=[];globalThis.chartPanels=[];globalThis.reviewSessions=[];globalThis.reviewSuspendCalls=[];globalThis.reviewPrepareCalls=[];globalThis.reviewResumeCalls=[];globalThis.dialogs=[];globalThis.confirm=()=>true;
const timers=globalThis.setTimeout;globalThis.setTimeout=(fn,ms)=>{const timer=timers(fn,ms);timer.unref?.();return timer;};
const intervals=globalThis.setInterval;globalThis.setInterval=(fn,ms)=>{const timer=intervals(fn,ms);timer.unref?.();return timer;};
const earlyResponses=new Map();class DeferredResponses extends Map{get(key){const handler=super.get(key);return handler?value=>{if(super.get(key)===handler)super.delete(key);handler(value);}:value=>earlyResponses.set(key,value);}set(key,resolve){super.set(key,resolve);if(earlyResponses.has(key)){const value=earlyResponses.get(key);earlyResponses.delete(key);super.delete(key);resolve(value);}return this;}}
const pending=new DeferredResponses(),requests=[];
const entryMutations=()=>requests.filter(r=>r.method!=='GET'&&/^\/api\/entries(?:\/|$)/.test(r.url)&&!/^\/api\/entries\/\d+\/(?:seen|reading)$/.test(r.url));
// Leaving analysis may flush measured time; source edits and grading remain explicit.
const nonTimingWrites=()=>requests.filter(r=>r.method!=='GET'&&r.url!=='/api/training/analysis-time');
const localDocument=doc=>ui.drafts.overlay(doc);
function assertNoEntryMutation(){assert.deepEqual(entryMutations(),[],'Editing and navigation keep the source PGN unchanged until explicit Save');}
globalThis.coveragePanels=[];
globalThis.fetch=async(url,settings={})=>{if(process.env.CHESSGYM_TEST_TRACE)console.error(url,settings.method||'GET');let payload;requests.push({url,method:settings.method||'GET',body:settings.body?JSON.parse(settings.body):undefined});
 if(url==='/api/status')payload=globalThis.bootStatus||{authenticated:true,setup_required:false,local_mode:true,username:'local-test',capabilities:{}};
 else if(url==='/api/preferences'&&(!settings.method||settings.method==='GET'))payload=globalThis.bootPreferences||{};
 else if(/\/api\/entries\/\d+\/reading$/.test(url))payload={enabled:false};
 else if(url==='/api/reading')payload={bases:[]};
 else if(url==='/api/training/analysis-time')payload={credit_id:'analysis-test-credit',duration_ms:requests.at(-1).body.duration_ms};
 else if(url==='/api/library')payload=globalThis.libraryPayload||{bases:[],folders:[]};
 else payload=await new Promise(resolve=>pending.set(url,resolve));
 return {ok:!payload?.__httpError,status:payload?.__httpError||200,headers:{get:()=> 'application/json'},json:async()=>payload};
};
const ui=await import('../static/app.js');const {makeDoc}=await import('../static/board.js');
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};await settle();
function entry(id){return {...makeDoc(),id,base_id:7,title:'Partie '+id,start_path:'0',history:{can_undo:true,can_redo:true}};}
async function open(id){const task=ui.openEntry(id);pending.get('/api/entries/'+id)(entry(id));await task;}
async function openTestBase(){
 globalThis.libraryPayload={bases:[{id:7,name:'Exercices',entry_count:2,settings:{review_enabled:true}},{id:8,name:'Finales',entry_count:0,settings:{}}],folders:[]};
 const task=ui.navigate('base',{baseId:7});await settle();pending.get('/api/bases/7/entries')({entries:[entry(1),entry(2)]});await task;return entryTables.at(-1);
}
async function openBaseEntry(id=1,ids=[1,2,3]){
 const table=await openTestBase();table.visible=ids.map(entry);
 const opening=table.options.onOpenEntry(id);pending.get('/api/entries/'+id)(entry(id));await opening;
 return table;
}
async function showCoverageBase(){
 globalThis.libraryPayload={bases:[{id:7,name:'Répertoire noir',entry_count:2,settings:{is_repertoire:true,color:'black'}},{id:8,name:'Autre base',entry_count:0,settings:{}}],folders:[]};
 ui.state.tab='coverage';const showing=ui.navigate('base',{baseId:7,keepTab:true});await settle();pending.get('/api/bases/7/entries')({entries:[entry(1),entry(2)]});await showing;return coveragePanels.at(-1);
}
function assertEntryCounter(index,total){
 for(const suffix of ['desktop','mobile'])assert.match(document.getElementById('analysis-entry-nav-'+suffix).innerHTML,new RegExp('>'+index+' / '+total+'</output>'));
}
function annotationDraft(value){
 const form=document.getElementById('annotation-form'),textarea=new Element();textarea.value=value;
 form.querySelector=selector=>selector==='[name="comment"]'?textarea:null;
 form.querySelectorAll=selector=>selector==='textarea,input,button'?[textarea]:[];
 return textarea;
}
async function showReviewPage(){
 globalThis.libraryPayload={bases:[{id:7,name:'Exercices',entry_count:2,settings:{review_enabled:true}},{id:8,name:'Historique',entry_count:0,settings:{review_enabled:false}}],folders:[]};
 const navigation=ui.navigate('reviews');await settle();pending.get('/api/reviews')({bases:[{base_id:7,name:'Exercices',type:'solve',total:2,unseen:1,learning:0,learned:1,due:1}]});await navigation;
}
function prepareSettingsForm(){
 const form=document.getElementById('base-settings'),type=new Element(),other=new Element();type.value='solve';form.elements={type};form.querySelectorAll=()=>[type,other];
 form.values=new Map(Object.entries({name:'Mes exercices',folder_id:'',tags:'tactique',type:'solve',mode:'hybrid',engine:'stockfish',side:'turn',goal:'win',color:'white',again:'10',hard:'1',medium:'3',easy:'7',max:'720',new_limit:'10',skill:'10'}));
 globalThis.FormData=class{constructor(source){this.values=new Map(source.values);}get(key){return this.values.get(key)??null;}has(key){return this.values.has(key);}};
 return {form,type,other};
}
async function showBaseSettings(){
 await openTestBase();ui.state.tab='settings';const parts=prepareSettingsForm();const showing=ui.navigate('base',{baseId:7,keepTab:true});await settle();pending.get('/api/bases/7/entries')({entries:[]});await showing;return {...parts,editor:ui.baseAppearanceEditor};
}

function prepareMobileAnalysis({commands=false}={}){
 const mobileTabs=new Element(),media=new Element();media.matches=true;window.matchMedia=()=>media;
 let commandNodes=null;
 if(commands){
  const home=new Element(),actions=new Element(),menu=new Element(),more=new Element(),title=new Element(),dock=document.getElementById('analysis-command-dock'),save=controls.get('save-board');
  commandNodes={home,actions,menu,more,title,dock,save,reading:readingHost};
  for(const node of Object.values(commandNodes)){
   node.remove=function(){if(this.parentElement){const siblings=this.parentElement.children;siblings.splice(siblings.indexOf(this),1);this.parentElement=null;}};
   node.append=function(child){child.remove();this.children.push(child);child.parentElement=this;};
   node.prepend=function(child){child.remove();this.children.unshift(child);child.parentElement=this;};
   node.insertBefore=function(child,anchor){if(!anchor){this.append(child);return;}assert.equal(anchor.parentElement,this);child.remove();this.children.splice(this.children.indexOf(anchor),0,child);child.parentElement=this;};
   Object.defineProperty(node,'nextSibling',{configurable:true,get(){return this.parentElement?.children[this.parentElement.children.indexOf(this)+1]||null;}});
  }
  home.append(title);home.append(actions);actions.append(readingHost);actions.append(save);actions.append(more);more.append(menu);
  actions.querySelector=selector=>selector==='.analysis-reading-controls'?readingHost:selector==='.analysis-more-actions'?menu:null;
  const query=document.querySelector;document.querySelector=selector=>selector==='.analysis-page>.page-title>.actions'?actions:query(selector);
 }
 let mobileItems=[],toolbarBilan;
 const getAll=document.querySelectorAll;
 document.querySelectorAll=selector=>selector==='[data-analysis-tool]'?[...tabItems,...(toolbarBilan?[toolbarBilan]:[])]:getAll(selector);
 workbench.querySelector=selector=>{
  if(selector!=='.analysis-mobile-tabs')return null;
  const html=document.getElementById('app').innerHTML;
  mobileItems=[...html.matchAll(/data-mobile-panel="([^"]+)"/g)].map(match=>{const tab=new Element();tab.dataset.mobilePanel=match[1];tab.closest=selector=>selector==='[data-mobile-panel]'?tab:null;return tab;});
  mobileTabs.children=mobileItems;mobileTabs.querySelectorAll=()=>mobileItems;
  tabItems=mobileItems.filter(tab=>['explorer','bilan','repertoire','position'].includes(tab.dataset.mobilePanel)).map(tab=>{const item=new Element();item.dataset.analysisTool=tab.dataset.mobilePanel;item.setAttribute('role','tab');return item;});
  tabPanels=tabItems.map(tab=>document.getElementById('analysis-tool-'+tab.dataset.analysisTool));
  toolbarBilan=mobileItems.some(tab=>tab.dataset.mobilePanel==='bilan')?new Element():null;if(toolbarBilan)toolbarBilan.dataset.analysisTool='bilan';
  return mobileTabs;
 };
 return {tabs:mobileTabs,media,commands:commandNodes,change(matches){media.matches=matches;media.handlers.get('change')?.();},get items(){return mobileItems;},get bilan(){return toolbarBilan;},click(id){const tab=mobileItems.find(item=>item.dataset.mobilePanel===id);assert.ok(tab,'The mobile tab exists: '+id);mobileTabs.handlers.get('click')({target:tab});}};
}

function preparePositionTabs(){
 tabItems=['explorer','position','bilan','repertoire'].map(id=>{const tab=new Element();tab.dataset.analysisTool=id;tab.setAttribute('role','tab');return tab;});
 tabPanels=tabItems.map(tab=>document.getElementById('analysis-tool-'+tab.dataset.analysisTool));
 return id=>tabItems.find(tab=>tab.dataset.analysisTool===id);
}

async function prepareBoot({hash='',page='board',resume='auto',slots={}}={}){
 globalThis.bootStatus={authenticated:true,username:'boot-user',workspace_epoch:'initial',capabilities:{}};
 globalThis.bootPreferences={theme:'copper',language:'fr'};
 savedPreferences.set('chessgym.startup.v1',JSON.stringify({page,resume}));
 globalThis.location={hash};window.location=globalThis.location;const history=[];
 window.history={state:null,replaceState(value,title,url){this.state=value;history.push({kind:'replace',url});location.hash=url;},pushState(value,title,url){this.state=value;history.push({kind:'push',url});location.hash=url;}};
 await ui.workspace.open('boot-user');for(const [key,value]of Object.entries(slots))ui.workspace.set(key,value);requests.length=0;return history;
}
function retainedComputer(id='retained-game',runId=null){return {version:1,mode:'play',config:{provider:'stockfish',side:'white'},displayPath:'0',session:{id,side:'white',training_run_id:runId,config:{provider:'stockfish',side:'white'},position:{initial_fen:'root',fen:'after',path:'0',history:[{uci:'e2e4'}],doc:makeDoc(),game_over:false}}};}
const submitEvent=()=>({preventDefault(){}});
const tests={
 async boot_local_first_launch_opens_installation_before_a_deep_link(){
  const history=await prepareBoot({hash:'#/board?entry=1',slots:{analysis:{doc:entry(2),path:'0'}}});
  globalThis.bootStatus={authenticated:true,setup_required:false,local_mode:true,username:'boot-user',workspace_epoch:'initial',resources_setup_required:true,capabilities:{setup_resources:true}};
  await ui.boot();
  assert.equal(ui.state.page,'settings');assert.deepEqual(history,[{kind:'replace',url:'#/settings'}]);
  assert.equal(requests.some(request=>request.url==='/api/entries/1'||request.url==='/api/entries/2'),false);
  assert.equal(requests.some(request=>['/api/setup','/api/login','/api/logout'].includes(request.url)),false);
  const html=document.getElementById('app').innerHTML;
  assert.match(html,/data-settings-tab="installation"/);assert.doesNotMatch(html,/auth-form|type="password"|data-settings-tab="account"|class="account"|data-action="logout"/);
 },
 async boot_explicit_board_restores_own_view_without_loading_another_analysis(){
  const target={...entry(1),start_path:'',analysis_dirty:true};target.nodes[1].comment='Local source note';
  const history=await prepareBoot({hash:'#/board?entry=1',slots:{analysis:{doc:entry(2),path:''},'document:entry:1':{doc:target,path:''},'view:entry:1':{path:'0',flipped:true,analysisTool:'position',analysisMobilePanel:'position'}}});
  const mounts=analysisPanels.length,task=ui.boot();await settle();pending.get('/api/entries/1')({...entry(1),start_path:''});await task;
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.board.path,'0');assert.equal(ui.state.board.flipped,true);assert.equal(ui.state.analysisTool,'position');assert.equal(ui.state.doc.nodes[1].comment,'Local source note');
  assert.equal(analysisPanels.length,mounts+1,'Boot mounts the explicit document only once');assert.equal(requests.filter(r=>r.url==='/api/entries/1').length,1);assert.equal(requests.some(r=>r.url==='/api/entries/2'),false);assert.deepEqual(history,[{kind:'replace',url:'#/board?entry=1'}]);assertNoEntryMutation();
 },
 async boot_auto_analysis_mounts_once_and_preserves_actions_during_source_check(){
  const history=await prepareBoot({slots:{analysis:{doc:entry(1),path:'0'}}}),mounts=analysisPanels.length;
  const task=ui.boot();await settle();assert.equal(ui.state.doc.id,1);const board=ui.state.board;await board.go('');const textarea=annotationDraft('Typed while checking the saved source');
  pending.get('/api/entries/1')(entry(1));await task;
  assert.equal(ui.state.board,board);assert.equal(ui.state.board.path,'');assert.equal(textarea.value,'Typed while checking the saved source');assert.equal(analysisPanels.length,mounts+1,'No temporary blank board is exposed before the retained analysis');assert.deepEqual(history,[{kind:'replace',url:'#/board?entry=1'}]);assertNoEntryMutation();
 },
 async boot_explicit_library_is_not_replaced_by_automatic_analysis(){
  const history=await prepareBoot({hash:'#/library',slots:{analysis:{doc:entry(1),path:'0'},computer:retainedComputer()}});await ui.boot();
  assert.equal(ui.state.page,'library');assert.equal(ui.state.board,null);assert.equal(requests.some(r=>r.url==='/api/entries/1'),false);assert.deepEqual(history,[{kind:'replace',url:'#/library'}]);
 },
 async boot_auto_review_resumes_without_mounting_the_dashboard(){
  const history=await prepareBoot({page:'reviews',slots:{review:{base:{id:7,name:'Review'},session:{cards:[{id:1}],index:0}},analysis:{doc:entry(1),path:'0'}}});
  await ui.boot();assert.equal(ui.state.page,'reviews');assert.equal(reviewResumeCalls.length,1);assert.equal(requests.some(r=>r.url==='/api/reviews'),false);assert.equal(requests.some(r=>r.url==='/api/entries/1'),false);assert.deepEqual(history,[{kind:'replace',url:'#/reviews'}]);
 },

 async board_draft_rename_changes_only_workspace_alias_and_keeps_it_after_navigation(){
  await ui.workspace.open('draft-alias',{remote:false});await open(1);const source=ui.state.doc;annotationDraft('Personal note');document.getElementById('annotation-form').oninput();
  const before=structuredClone(source),retained=ui.workspace.get('document:entry:1');assert.equal(await ui.applyRenameBoardDraft('entry:1','  My study alias  '),true);
  assert.equal(ui.workspace.get('view:entry:1').draftLabel,'My study alias');assert.deepEqual(source,before);assert.deepEqual(ui.workspace.get('document:entry:1'),retained);assert.equal(ui.drafts.get(source,'0').comment,'Personal note');
  await ui.state.board.go('');await ui.navigate('library');await ui.boardMenuAction('current');assert.equal(ui.workspace.get('view:entry:1').draftLabel,'My study alias');assert.equal(ui.state.doc.title,before.title);assertNoEntryMutation();
 },
 async board_draft_rename_noncurrent_does_not_change_the_active_document(){
  await ui.workspace.open('draft-alias-other',{remote:false});await open(2);const active=ui.state.doc,board=ui.state.board;
  const doc={...makeDoc(),workspace_id:'alias-other',title:'Original draft title'},snapshot={doc,path:'0'};ui.workspace.set('document:free:alias-other',snapshot);ui.workspace.set('view:free:alias-other',{path:'0',flipped:true});
  assert.equal(await ui.applyRenameBoardDraft('free:alias-other','Archived calculation'),true);assert.equal(ui.workspace.get('view:free:alias-other').draftLabel,'Archived calculation');assert.equal(ui.workspace.get('view:free:alias-other').flipped,true);assert.deepEqual(ui.workspace.get('document:free:alias-other'),snapshot);assert.equal(ui.state.doc,active);assert.equal(ui.state.board,board);assertNoEntryMutation();
 },
 async board_draft_rename_form_is_bounded_and_cancel_or_invalid_targets_do_not_write(){
  await ui.workspace.open('draft-alias-form',{remote:false});await open(1);annotationDraft('Keep');document.getElementById('annotation-form').oninput();const original=structuredClone(ui.state.doc);
  const before=dialogs.length;await ui.renameBoardDraft('entry:1');assert.equal(dialogs.length,before+1);const dialog=dialogs.at(-1);assert.match(dialog.html,/name="draft_name"/);assert.match(dialog.html,/maxlength="160"/);assert.equal(ui.workspace.get('view:entry:1').draftLabel,undefined,'Opening or canceling the form does not rename');
  assert.throws(()=>ui.applyRenameBoardDraft('entry:999','Wrong target'),/plus disponible/);assert.equal(ui.workspace.get('view:entry:999'),null);
  assert.throws(()=>ui.applyRenameBoardDraft('entry:1','   '),/1 à 160/);assert.throws(()=>ui.applyRenameBoardDraft('entry:1','x'.repeat(161)),/1 à 160/);assert.equal(ui.workspace.get('view:entry:1').draftLabel,undefined);
  assert.equal(ui.applyRenameBoardDraft('entry:1','x'.repeat(160)),true);assert.equal(ui.workspace.get('view:entry:1').draftLabel.length,160);assert.deepEqual(ui.state.doc,original);
  await ui.workspace.open('other-draft-alias-account',{remote:false});ui.workspace.set('document:entry:1',{doc:{...entry(1),analysis_dirty:true},path:'0'});ui.workspace.set('view:entry:1',{path:'0'});assert.throws(()=>dialog.options.onSubmit(new Map([['draft_name','Old account rename']])),/espace ouvert a changé/);assert.equal(ui.workspace.get('view:entry:1').draftLabel,undefined);assertNoEntryMutation();
 },
 async board_draft_delete_current_saved_reloads_source_and_removes_all_related_slots(){
  await ui.workspace.open('draft-delete-saved',{remote:false});await open(1);const original=structuredClone(ui.state.doc);annotationDraft('Discard this local note');document.getElementById('annotation-form').oninput();await ui.applyRenameBoardDraft('entry:1','Local alias');
  const deleting=ui.deleteBoardDraft('entry:1');await settle();assert(pending.has('/api/entries/1'));pending.get('/api/entries/1')(original);assert.equal(await deleting,true);
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.title,original.title);assert.equal(ui.state.doc.nodes[1].comment,original.nodes[1].comment);assert.equal(ui.state.doc.analysis_dirty,false);assert.equal(ui.state.board.inputLocked,false);
  for(const key of ['document:entry:1','annotation:entry:1','view:entry:1','analysis'])assert.equal(ui.workspace.get(key),null,key+' removed');assertNoEntryMutation();
 },
 async board_draft_delete_current_free_resets_the_board_without_touching_source_games(){
  await ui.workspace.open('draft-delete-free',{remote:false});await open(1);const free=structuredClone(ui.state.doc);delete free.id;delete free.base_id;free.workspace_id='delete-free';free.title='Disposable calculation';ui.state.doc=free;ui.state.board.doc=free;await ui.state.board.go('0');annotationDraft('Disposable note');document.getElementById('annotation-form').oninput();
  assert.equal(await ui.deleteBoardDraft('free:delete-free'),true);assert.notEqual(ui.state.doc,free);assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.path,'');assert.equal(ui.state.entryNavigation,null);
  for(const key of ['document:free:delete-free','annotation:free:delete-free','view:free:delete-free'])assert.equal(ui.workspace.get(key),null,key+' removed');assertNoEntryMutation();
 },
 async board_draft_delete_noncurrent_and_cancel_preserve_the_active_board(){
  await ui.workspace.open('draft-delete-other',{remote:false});await open(1);annotationDraft('Other draft');document.getElementById('annotation-form').oninput();await open(2);annotationDraft('');document.getElementById('annotation-form').oninput();const current=ui.state.doc,board=ui.state.board;
  globalThis.confirm=()=>false;assert.equal(await ui.deleteBoardDraft('entry:1'),false);assert(ui.workspace.get('document:entry:1'));assert(ui.workspace.get('annotation:entry:1'));
  globalThis.confirm=()=>true;const before=requests.length;assert.equal(await ui.deleteBoardDraft('entry:1'),true);assert.equal(ui.state.doc,current);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(board.inputLocked,false);assert.equal(ui.workspace.get('document:entry:1'),null);assert.equal(ui.workspace.get('annotation:entry:1'),null);assert.equal(ui.workspace.get('view:entry:1'),null);assert.equal(ui.workspace.get('analysis').doc.id,2);assert(!requests.slice(before).some(request=>request.url==='/api/entries/1'));assertNoEntryMutation();
 },
 async board_draft_delete_missing_source_clears_draft_and_returns_to_a_free_board(){
  await ui.workspace.open('draft-delete-missing',{remote:false});await open(1);annotationDraft('Source removed elsewhere');document.getElementById('annotation-form').oninput();const deleting=ui.deleteBoardDraft('entry:1');await settle();pending.get('/api/entries/1')({__httpError:404,detail:'Source missing'});assert.equal(await deleting,true);
  assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.path,'');assert.equal(ui.state.entryNavigation,null);for(const key of ['document:entry:1','annotation:entry:1','view:entry:1','analysis'])assert.equal(ui.workspace.get(key),null,key+' removed');assertNoEntryMutation();
 },
 async board_draft_delete_cas_conflict_preserves_content_and_releases_editor_lock(){
  await ui.workspace.open('draft-delete-conflict',{remote:false});await open(1);annotationDraft('Never lose this conflict');document.getElementById('annotation-form').oninput();const source=ui.state.doc,before=ui.workspace.get('document:entry:1'),calls=[];ui.workspace.delay=60000;ui.workspace.enabled=true;
  ui.workspace.request=async(url,options={})=>{calls.push({url,method:options.method||'GET'});if(options.method==='DELETE')throw Object.assign(new Error('Workspace conflict'),{status:409});return {key:decodeURIComponent(url.slice(url.lastIndexOf('/')+1)),revision:2,data:before};};
  const deleting=ui.deleteBoardDraft('entry:1');await settle();pending.get('/api/entries/1')(entry(1));await assert.rejects(deleting,/Workspace conflict/);
  assert.equal(ui.state.doc,source);assert.deepEqual(ui.workspace.get('document:entry:1'),before);assert.equal(ui.drafts.get(source,'0').comment,'Never lose this conflict');assert.equal(ui.state.board.inputLocked,false);assert(calls.some(call=>call.method==='DELETE'));assertNoEntryMutation();ui.workspace.close();
 },
 async board_draft_delete_epoch_change_during_source_fetch_never_discards_the_new_account(){
  await ui.workspace.open('draft-delete-old-account',{remote:false});await open(1);annotationDraft('Old account note');document.getElementById('annotation-form').oninput();const discard=ui.workspace.discard.bind(ui.workspace),calls=[];ui.workspace.discard=keys=>{calls.push(keys);return discard(keys);};
  const deleting=ui.deleteBoardDraft('entry:1');await settle();assert(pending.has('/api/entries/1'));ui.switchWorkspaceIdentity('draft-delete-new-account:initial');await ui.workspace.open('draft-delete-new-account',{remote:false});
  const other={doc:{...entry(1),title:'New account draft',analysis_dirty:true},path:'0'};ui.workspace.set('document:entry:1',other);ui.workspace.set('annotation:entry:1',{nodes:{'0':{comment:'New account note'}}});ui.workspace.set('view:entry:1',{path:'0',draftLabel:'New account alias'});ui.workspace.set('analysis',other);
  pending.get('/api/entries/1')(entry(1));assert.equal(await deleting,false);assert.equal(calls.length,0,'No discard may begin after the workspace epoch changes');assert.deepEqual(ui.workspace.get('document:entry:1'),other);assert.equal(ui.workspace.get('annotation:entry:1').nodes['0'].comment,'New account note');assert.equal(ui.workspace.get('view:entry:1').draftLabel,'New account alias');assertNoEntryMutation();
 },
 async board_draft_delete_changed_snapshot_during_source_fetch_is_preserved(){
  await ui.workspace.open('draft-delete-version',{remote:false});await open(1);annotationDraft('Confirmed old note');document.getElementById('annotation-form').oninput();const deleting=ui.deleteBoardDraft('entry:1');await settle();assert(pending.has('/api/entries/1'));
  const newer=ui.workspace.get('document:entry:1');newer.doc.title='Newer work arrived';ui.workspace.set('document:entry:1',newer);pending.get('/api/entries/1')(entry(1));let outcome;try{outcome=await deleting;}catch(error){assert.match(error.message,/changé|changed/i);outcome=false;}assert.equal(outcome,false);assert.deepEqual(ui.workspace.get('document:entry:1'),newer);assert.equal(ui.drafts.get(ui.state.doc,'0').comment,'Confirmed old note');assert.equal(ui.state.board.inputLocked,false);assertNoEntryMutation();
 },
 async board_menu_current_cancels_pending_recent_without_replacing_the_board(){
  await open(1);const source=ui.state.doc,board=ui.state.board;board.flipped=true;board.engineOn=true;annotationDraft('Keep current note');
  ui.workspace.set('view:entry:2',{path:'0',flipped:false,entryNavigation:null});
  const opening=ui.boardMenuAction(undefined,'entry:2');await settle();assert(pending.has('/api/entries/2'),'Recent saved entry is loading');
  assert.equal(await ui.boardMenuAction('current'),true);pending.get('/api/entries/2')(entry(2));assert.equal(await opening,false);
  assert.equal(ui.state.doc,source);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(board.flipped,true);assert.equal(board.engineOn,true);assert.equal(ui.drafts.get(source,'0').comment,'Keep current note');assertNoEntryMutation();
 },
 async board_menu_new_preserves_free_document_notes_and_view_without_confirmation(){
  await open(1);const source=structuredClone(ui.state.doc);delete source.id;delete source.base_id;delete source.history;source.workspace_id='free-menu-test';source.title='Local calculation';source.nodes[1].comment='Original comment';
  ui.state.doc=source;ui.state.board.doc=source;await ui.state.board.go('0');ui.state.board.flipped=true;ui.state.board.engineOn=true;ui.state.board.drawings=[{from:'e2',to:'e4',color:'green'}];annotationDraft('Unapplied note');
  let confirmations=0;globalThis.confirm=()=>{confirmations++;return false;};assert.equal(await ui.boardMenuAction('new'),true);
  assert.equal(confirmations,0);assert.notEqual(ui.state.doc,source);assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.path,'');assert.equal(ui.state.entryNavigation,null);
  const retained=ui.workspace.get('document:free:free-menu-test'),view=ui.workspace.get('view:free:free-menu-test');
  assert.equal(retained.doc.title,'Local calculation');assert.equal(retained.doc.nodes[1].comment,'Original comment');assert.equal(ui.drafts.get(retained.doc,'0').comment,'Unapplied note');assert.equal(view.path,'0');assert.equal(view.flipped,true);assert.equal(view.engineOn,true);assert.deepEqual(view.drawings,[{from:'e2',to:'e4',color:'green'}]);
  assert.equal(await ui.boardMenuAction(undefined,'free:free-menu-test'),true);assert.equal(ui.state.doc.title,'Local calculation');assert.equal(ui.state.path,'0');assert.equal(ui.state.board.flipped,true);assert.equal(ui.state.board.engineOn,true);assert.equal(ui.drafts.get(ui.state.doc,'0').comment,'Unapplied note');assertNoEntryMutation();
 },
 async board_menu_recent_restores_saved_view_without_rewriting_the_source(){
  await open(1);const original=structuredClone(ui.state.doc);ui.state.board.flipped=true;ui.state.board.engineOn=true;ui.state.board.drawings=[{square:'e4',color:'blue'}];await ui.state.board.go('');
  await open(2);assert.equal(ui.workspace.get('document:entry:1'),null,'A saved game needs only compact view metadata');
  const reopening=ui.boardMenuAction(undefined,'entry:1');await settle();assert(pending.has('/api/entries/1'));pending.get('/api/entries/1')(original);assert.equal(await reopening,true);
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.path,'');assert.equal(ui.state.board.flipped,true);assert.equal(ui.state.board.engineOn,true);assert.deepEqual(ui.state.board.drawings,[{square:'e4',color:'blue'}]);assertNoEntryMutation();
 },
 async board_menu_account_change_invalidates_pending_recent(){
  await open(1);ui.workspace.set('view:entry:2',{path:'0',flipped:true});const opening=ui.boardMenuAction(undefined,'entry:2');await settle();assert(pending.has('/api/entries/2'));
  ui.switchWorkspaceIdentity('other-account:initial');const other=ui.state.doc;pending.get('/api/entries/2')(entry(2));assert.equal(await opening,false);
  assert.equal(ui.state.doc,other);assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.page,'library');assert.equal(ui.state.board,null);assertNoEntryMutation();
 },
 async changing_language_preserves_analysis_drafts_and_serializes_preferences(){
  await open(1);ui.state.doc.title='Révisions';const source=ui.state.doc;annotationDraft('Bien');await ui.navigate('settings');ui.status.username='tester';ui.status.capabilities={review_preferences:true};(await import('../static/preferences-store.js')).preferencesService.open('tester',{initial:ui.state.preferences});
  const first=ui.changeLanguage('en');await settle();assert.equal(getLanguage(),'en');assert.match(document.getElementById('app').innerHTML,/Library/);assert.match(document.getElementById('app').innerHTML,/Interface language/);assert.equal(ui.state.doc,source);assert.equal(source.title,'Révisions');assert.equal(ui.drafts.get(source,'0').comment,'Bien');
  const second=ui.changeLanguage('fr');await settle();assert.equal(requests.filter(r=>r.url==='/api/preferences'&&r.method==='PATCH').length,1);pending.get('/api/preferences')({language:'en'});await first;await settle();pending.get('/api/preferences')({language:'fr'});await second;assert.equal(getLanguage(),'fr');assert.equal(ui.state.preferences.language,'fr');assert.equal(ui.drafts.get(source,'0').comment,'Bien');
  ui.status.capabilities={};const before=requests.length;await ui.changeLanguage('en');assert.equal(requests.length,before,'old server keeps language locally without an unsupported PATCH');setLanguage('fr');
 },
 async retired_daily_limits_are_absent_and_review_intervals_are_preserved(){
  const source={id:7,name:'Base',settings:{},entry_count:0};let html=ui.baseSettings(source);assert.doesNotMatch(html,/name="new_limit"/);assert.match(html,/name="hard" type="number" value="2"/);assert.match(html,/name="medium" type="number" value="5"/);assert.match(html,/name="easy" type="number" value="10"/);assert.match(html,/name="again" type="number" value="10"/);
  html=ui.baseSettings({...source,settings:{new_limit:10,hard:1,medium:3,easy:7}});assert.doesNotMatch(html,/name="new_limit"/);assert.match(html,/name="hard" type="number" value="1"/);
  ui.state.preferences.review_defaults={again:20,hard:3,medium:7,easy:12,new_limit:50};html=ui.baseSettings(source);assert.match(html,/name="hard" type="number" value="3"/);assert.doesNotMatch(html,/name="new_limit"/);
  const {form}=await showBaseSettings();const saving=form.onsubmit(submitEvent());const request=requests.filter(r=>r.url==='/api/bases/7'&&r.method==='PATCH').at(-1);assert.equal('new_limit' in request.body.settings,false);pending.get('/api/bases/7')({});await settle();pending.get('/api/bases/7/entries')({entries:[]});await saving;
 },
 async reviews_default_to_bases_without_daily_session_configuration(){
  ui.status.capabilities={daily_review_sessions:true};ui.state.reviewView='daily';await showReviewPage();
  assert.equal(ui.state.reviewView,'bases');const html=document.getElementById('app').innerHTML;
  assert.match(html,/id="review-tab-bases"[^>]*aria-selected="true"/);assert.doesNotMatch(html,/review-tab-daily|review-tab-settings|data-daily-form/);
  assert.match(html,/data-review-all="review">Tout réviser · 1/);assert.match(html,/data-review-all="learn">Tout apprendre · 1/);
  ui.selectReviewView('daily');ui.selectReviewView('settings');assert.equal(ui.state.reviewView,'bases');
 },
 async manual_review_launches_directly_without_session_goal_dialog(){
  ui.status.capabilities={review_sessions:true,daily_review_sessions:true};await showReviewPage();await ui.launchReview(7,'learn');
  assert.equal(dialogs.length,0);assert.equal(reviewSessions.at(-1).options.selection,'learn');assert.deepEqual(reviewSessions.at(-1).options.goal,{minutes:null,cards:null});
 },

 async backup_buttons_are_capability_gated_and_full_download_requires_confirmation(){
  globalThis.downloadUrls=[];ui.status.capabilities={};assert.doesNotMatch(ui.backupSettingsHtml(),/backup-personal/);await ui.action('backup-personal');assert.equal(downloadUrls.length,0);
  globalThis.confirm=()=>false;await ui.action('backup-full');assert.equal(downloadUrls.length,0);globalThis.confirm=()=>true;await ui.action('backup-full');assert.deepEqual(downloadUrls,['/api/backup']);
  ui.status.capabilities={personal_backup:true};assert.match(ui.backupSettingsHtml(),/backup-personal/);await ui.action('backup-personal');assert.equal(downloadUrls.at(-1),'/api/backup?mode=personal');await ui.action('backup-full');assert.equal(downloadUrls.at(-1),'/api/backup?mode=full');assert.equal(requests.some(r=>r.url.includes('/api/backup')),false,'Only the download URL is prepared; no archive is produced in this test');
 },
 async annotation_capture_before_move_retains_multiple_nodes_until_explicit_save(){
  await open(1);const board=ui.state.board,source=ui.state.doc;annotationDraft('First draft');await board.go('');annotationDraft('Root draft');await board.go('0');assert.match(document.getElementById('annotation-editor').innerHTML,/First draft/);
  // The adapter does not parse textarea DOM, so restore the visible field explicitly.
  annotationDraft('First draft');const saving=ui.action('save-board'),request=requests.at(-1),doc=JSON.parse(request.body.pgn);assert.equal(doc.nodes[0].comment,'Root draft');assert.equal(doc.nodes[1].comment,'First draft');assert.equal(source.nodes[0].comment,'');pending.get('/api/entries/1')(doc);await saving;assert.equal(ui.drafts.has(ui.state.doc),false);
 },

 async repertoire_analysis_gap_keeps_annotation_local_rechecks_then_opens_full_line(){
  await open(1);ui.state.library.bases=[{id:7,name:'Répertoire noir',settings:{is_repertoire:true,color:'black',primary:true}}];const board=ui.state.board,panel=repertoirePanels.at(-1),textarea=annotationDraft('Note à conserver avant la lacune');let validated=0;const gap={pgn:'[Result "*"]\n\n1. e4 c5 *',san:'c5'},context={baseId:7,color:'black',filters:{ratings:[1800],speeds:['rapid']},partial:true,isCurrent:()=>true,validateGap:async()=>{validated++;assert.match(localDocument(ui.state.doc).nodes[1].comment,/Note à conserver/);return true;}};
  const opening=panel.options.onExploreGap(gap,context);await settle();assertNoEntryMutation();assert.match(localDocument(ui.state.doc).nodes[1].comment,/Note à conserver/);assert.equal(requests.at(-1).url,'/api/board');assert.equal(validated,0);
  const target=makeDoc();target.nodes[1].children=['0.0'];target.nodes.push({path:'0.0',parent:'0',fen:'gap',san:'c5',children:[],comment:'',nags:[]});pending.get('/api/board')(target);assert.equal(await opening,true);assert.equal(validated,1);assert.equal(ui.state.doc,target);assert.equal(ui.state.path,'0.0');assert.equal(target.base_id,7);assert.equal(target.id,undefined);assert.equal(ui.state.board.flipped,true);assert.equal(panel.disposed,true);assert.equal(board.disposed,true);assert.deepEqual(target.explorer_profile,{source:'lichess',ratings:[1800],speeds:['rapid'],repertoire_color:'black',show_probability:true});await ui.action('save-board');assert.match(dialogs.at(-1).html,/<option value="7" selected>|<select name="base_id"/);
 },
 async repertoire_analysis_gap_failed_parse_or_stale_result_keeps_local_analysis(){
  await open(1);const board=ui.state.board,source=ui.state.doc,panel=repertoirePanels.at(-1),textarea=annotationDraft('Ne pas effacer cette note'),context={baseId:7,color:'white',filters:{ratings:[1600],speeds:['rapid']},validateGap:async()=>false};
  const failed=panel.options.onExploreGap({pgn:'1. e4 *'},context);pending.get('/api/board')({__httpError:503,detail:'Analyse indisponible'});await assert.rejects(failed,/Analyse indisponible/);assert.equal(ui.state.doc,source);assert.equal(textarea.value,'Ne pas effacer cette note');assert.equal(textarea.disabled,false);assert.equal(board.inputLocked,false);assertNoEntryMutation();
  const stale=panel.options.onExploreGap({pgn:'1. e4 *'},context);await settle();pending.get('/api/board')(makeDoc());assert.equal(await stale,false);assert.equal(ui.state.board,board);assert.equal(ui.state.doc.id,1);assert.match(localDocument(ui.state.doc).nodes[1].comment,/Ne pas effacer cette note/);assert.equal(board.disposed,false);assert.equal(panel.disposed,false);assert.equal(board.inputLocked,false);assert.equal(textarea.disabled,false);assertNoEntryMutation();
 },
 async repertoire_analysis_gap_late_navigation_and_move_changes_are_ignored(){
  await open(1);const source=ui.state.doc,board=ui.state.board,panel=repertoirePanels.at(-1),context={baseId:7,color:'white',filters:{ratings:[1600],speeds:['rapid']},isCurrent:()=>true};
  const moved=panel.options.onExploreGap({pgn:'1. e4 *'},context);await board.go('');pending.get('/api/board')(makeDoc());assert.equal(await moved,false);assert.equal(ui.state.doc,source);assert.equal(board.disposed,false);
  const late=panel.options.onExploreGap({pgn:'1. d4 *'},context),respond=pending.get('/api/board');await ui.navigate('library');respond(makeDoc());assert.equal(await late,false);assert.equal(ui.state.page,'library');assert.equal(ui.state.doc,source);assert.equal(panel.disposed,true);const count=requests.length;assert.equal(await panel.options.onExploreGap({pgn:'stale'},context),false);assert.equal(requests.length,count);
 },
 async repertoire_analysis_gap_declined_free_analysis_retains_draft(){
  await open(1);await ui.action('reset-board');const board=ui.state.board,panel=repertoirePanels.at(-1),textarea=annotationDraft('Brouillon libre');globalThis.confirm=()=>false;const count=requests.length;
  assert.equal(await panel.options.onExploreGap({pgn:'1. e4 *'},{baseId:7,color:'white',filters:{ratings:[1600],speeds:['rapid']}}),false);assert.equal(requests.length,count);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(panel.disposed,false);assert.equal(textarea.value,'Brouillon libre');assert.match(localDocument(ui.state.doc).nodes[0].comment,/Brouillon libre/);assert.equal(board.inputLocked,false);
 },
 async repertoire_analysis_coverage_link_preserves_workspace(){
  await open(1);const board=ui.state.board,source=ui.state.doc,panel=repertoirePanels.at(-1),textarea=annotationDraft('Conserver pendant le bilan');globalThis.libraryPayload={bases:[{id:7,name:'Répertoire',entry_count:2,settings:{is_repertoire:true,color:'white'}}],folders:[]};
  const count=requests.filter(r=>r.method==='PATCH').length,opening=panel.options.onOpenCoverage(7);await settle();pending.get('/api/bases/7/entries')({entries:[]});await opening;assert.equal(ui.state.page,'base');assert.equal(ui.state.tab,'coverage');assert.equal(ui.state.doc,source);assert.equal(panel.disposed,true);await ui.navigate('board');assert.equal(ui.state.doc,source);assert.match(document.getElementById('annotation-editor').innerHTML,/Conserver pendant le bilan/);assert.equal(requests.filter(r=>r.method==='PATCH').length,count,'Changing sections retains a draft without committing the PGN');assert.equal(board.disposed,true);assert.equal(textarea.disabled,false);
 },
 async reference_base_lists_without_loading_study_entries_and_disposes(){
  globalThis.libraryPayload={bases:[{id:17,name:'Maîtres',reference:true,entry_count:100000,settings:{},reference_status:{status:'running',imported:100000}},{id:7,name:'Études',entry_count:0,settings:{}}],folders:[]};
  const count=entryTables.length;await ui.navigate('base',{baseId:17});const panel=referencePanels.at(-1);
  assert.equal(ui.state.page,'base');assert.equal(entryTables.length,count);assert.ok(!requests.some(r=>r.url==='/api/bases/17/entries'));assert.match(document.getElementById('app').innerHTML,/reference-library/);assert.doesNotMatch(document.getElementById('app').innerHTML,/data-action="import"|data-action="new-entry"/);
  panel.options.onStatus({status:'completed',imported:120000});assert.equal(ui.state.library.bases[0].entry_count,120000);assert.equal(document.getElementById('base-entry-count').textContent,120000);
  panel.options.onStatus({status:'running',game_count:120000,imported:0});assert.equal(ui.state.library.bases[0].entry_count,120000);assert.equal(document.getElementById('base-entry-count').textContent,120000);
  await ui.navigate('library');assert.equal(panel.disposed,true);assert.equal(await panel.options.onOpenGame(1,{isCurrent:()=>true}),false);assert.ok(!requests.some(r=>r.url==='/api/reference-bases/17/games/1'));
 },
 async reference_game_opens_full_tree_as_copy_and_excludes_reference_destinations(){
  globalThis.libraryPayload={bases:[{id:17,name:'Maîtres',reference:true,entry_count:100000,settings:{}},{id:7,name:'Études',entry_count:0,settings:{}}],folders:[]};
  await ui.navigate('library');
  const task=ui.openEntry('reference:17:22');const doc=entry(22);doc.title='Partie de maître';doc.nodes.push({path:'1',parent:'',fen:'variation',san:'d4',children:[],comment:'Note',nags:[1]});doc.nodes[0].children.push('1');doc.reference_source={base_id:17,game_id:22};pending.get('/api/reference-bases/17/games/22')(doc);await task;
  assert.equal(ui.state.page,'board');assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.doc.base_id,undefined);assert.equal(ui.state.doc.nodes.length,3);assert.equal(ui.state.doc.nodes[2].comment,'Note');assert.ok(!requests.some(r=>r.url.startsWith('/api/entries/22')));
  await ui.action('save-board');const dialog=dialogs.at(-1);assert.match(dialog.html,/value="7"/);assert.doesNotMatch(dialog.html,/value="17"/);await ui.action('make-exercise');assert.deepEqual(exerciseEditors.at(-1).bases.map(b=>b.id),[7]);assert.deepEqual(explorerPanels.at(-1).options.getBases().map(b=>b.id),[17,7]);
 },
 async reference_position_ignores_clock_counters_and_keeps_local_source_annotation(){
  await open(1);const source=ui.state.doc;annotationDraft('Mon commentaire');const panel=positionPanels.at(-1),fen='8/8/8/8/8/8/K7/7k w - - 0 1';const opening=panel.options.onOpenEntry('reference:17:22',{path:'0',fen,isCurrent:()=>true});await settle();
  assertNoEntryMutation();assert.equal(localDocument(source).nodes[1].comment,'Mon commentaire');
  const target={...makeDoc(),reference_source:{base_id:17,game_id:22},title:'Référence'};target.nodes[1].fen='8/8/8/8/8/8/K7/7k w - - 53 81';pending.get('/api/reference-bases/17/games/22')(target);await opening;
  assert.equal(ui.state.path,'0');assert.equal(ui.state.doc.reference_source.game_id,22);assert.equal(ui.state.doc.id,undefined);assert.notEqual(ui.state.doc,source);assert.ok(!requests.some(r=>r.url.startsWith('/api/entries/reference:')));
 },
 async reference_late_open_cannot_replace_another_page(){
  await open(1);const original=ui.state.doc,task=ui.openEntry('reference:17:22');await ui.navigate('library');pending.get('/api/reference-bases/17/games/22')({...makeDoc(),reference_source:{base_id:17,game_id:22}});assert.equal(await task,false);assert.equal(ui.state.page,'library');assert.equal(ui.state.doc,original);
 },
 async existing_navigation_resumes_review_from_library_and_preserves_analysis(){
  await open(1);const source=ui.state.doc;await ui.state.board.go('');ui.state.board.flipped=true;ui.state.board.engineOn=true;ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];
  await ui.launchReview(7);const session=reviewSessions.at(-1),review=activeReviewBoard,starts=reviewSessions.length;
  const mobileMenu=new Element();mobileMenu.open=true;const originalQuery=document.querySelectorAll;document.querySelectorAll=selector=>selector==='.mobile-navigation-group[open]'?[mobileMenu]:originalQuery(selector);await ui.navigate('reviews');document.querySelectorAll=originalQuery;assert.equal(mobileMenu.open,false);assert.equal(activeReviewBoard,review);assert.equal(reviewSessions.length,starts);assert.equal(reviewSuspendCalls.length,0,'The Révisions menu keeps the current attempt mounted');
  await ui.navigate('library');assert.equal(ui.state.page,'library');assert.equal(reviewSuspendCalls.length,1);assert.equal(reviewSuspendCalls[0].options.assisted,false);assert.equal(ui.state.doc,source);
  assert.equal(await ui.navigate('reviews'),true);assert.equal(ui.state.page,'reviews');assert.equal(currentReviewSession,session);assert.equal(session.completed,2);assert.equal(session.index,2);assert.equal(reviewSessions.length,starts);assert.equal(reviewResumeCalls.length,1);
  await ui.navigate('board');assert.equal(ui.state.doc,source);assert.equal(ui.state.path,'');assert.equal(ui.state.board.path,'');assert.equal(ui.state.board.flipped,true);assert.equal(ui.state.board.engineOn,true);
  const html=document.getElementById('app').innerHTML;assert.doesNotMatch(html,/global-engine|workspace-shortcut/);assert.match(html,/data-page="reviews"/);assert.match(html,/data-board-menu/);assert.match(html,/data-board-command="current"/);assert.match(html,/id="analysis-engine"/);
 },
 async existing_navigation_waits_for_review_move_before_leaving(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);const review=activeReviewBoard,session=currentReviewSession;
  globalThis.reviewSuspendBlocked=true;assert.equal(await ui.navigate('board'),false);assert.equal(ui.state.page,'reviews');assert.equal(activeReviewBoard,review);assert.equal(review.disposed,false);assert.equal(reviewSuspendCalls.length,0);
  globalThis.reviewSuspendBlocked=false;assert.equal(await ui.navigate('board'),true);assert.equal(review.disposed,true);assert.equal(reviewSuspendCalls[0].session,session);assert.equal(reviewSuspendCalls[0].options.assisted,false);
 },
 async explicit_review_exit_returns_to_base_list_and_clears_resume(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);const session=currentReviewSession;
  const closing=session.options.onClose();await settle();pending.get('/api/reviews')({bases:[]});await closing;assert.equal(ui.state.page,'reviews');assert.equal(activeReviewBoard,null);assert.equal(reviewSuspendCalls.length,0);
  await ui.navigate('board');const dashboard=ui.navigate('reviews');await settle();pending.get('/api/reviews')({bases:[]});await dashboard;assert.equal(reviewPrepareCalls.length,0);assert.equal(reviewResumeCalls.length,0);assert.match(document.getElementById('app').innerHTML,/Aucune base à réviser/);
 },
 async review_navigation_from_library_failure_keeps_session_for_retry(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);const session=currentReviewSession;await ui.navigate('library');
  globalThis.reviewPrepareImpl=()=>{throw new Error('Connexion temporairement indisponible');};await assert.rejects(ui.navigate('reviews'),/Connexion temporairement/);assert.equal(ui.state.page,'library');assert.equal(ui.state.board,null);
  globalThis.reviewPrepareImpl=null;assert.equal(await ui.navigate('reviews'),true);assert.equal(currentReviewSession,session);assert.equal(reviewPrepareCalls.length,2);assert.equal(reviewResumeCalls.length,1);assert.equal(session.completed,2);
 },
 async position_tab_preserves_analysis_and_only_runs_while_visible(){
  const tab=preparePositionTabs();await open(1);const board=ui.state.board,doc=ui.state.doc,panel=positionPanels.at(-1),explorer=explorerPanels.at(-1),editor=document.getElementById('annotation-editor'),textarea=annotationDraft('Ma note en cours'),history=JSON.stringify(ui.freeHistory),count=requests.length;
  assert.equal(panel.options.board,board);assert.equal(panel.initialVisible,false);assert.equal(panel.visible,false);assert.equal(panel.host,document.getElementById('position-search'));assert.equal(panel.disposed,false);
  assert.match(document.getElementById('app').innerHTML,/data-analysis-tool="position"/);assert.match(document.getElementById('app').innerHTML,/data-mobile-panel="position"/);editor.innerHTML='Annotation conservée';board.engineOn=true;
  tab('position').onclick();assert.equal(ui.state.analysisTool,'position');assert.equal(panel.visible,true);assert.equal(explorer.visible,false);assert.equal(document.getElementById('analysis-tool-position').hidden,false);assert.equal(tab('position').getAttribute('aria-selected'),'true');
  clickReading('tools');assert.equal(panel.visible,false);assert.equal(workbench.classList.contains('analysis-tools-collapsed'),true);tab('position').onclick();assert.equal(panel.visible,true);assert.equal(workbench.classList.contains('analysis-tools-collapsed'),false);
  tab('repertoire').onclick();assert.equal(panel.visible,false);tab('explorer').onclick();assert.equal(explorer.visible,true);assert.equal(panel.visible,false);
  assert.equal(ui.state.board,board);assert.equal(ui.state.doc,doc);assert.equal(board.engineOn,true);assert.equal(board.disposed,false);assert.equal(textarea.value,'Ma note en cours');assert.equal(editor.innerHTML,'Annotation conservée');assert.equal(JSON.stringify(ui.freeHistory),history);assert.equal(requests.length,count);
  tab('position').onclick();await board.go('');assert.equal(panel.updates.at(-1).fen,'root');assert.equal(panel.updates.at(-1).path,'');assert.equal(panel.updates.at(-1).board,board);
  const leaving=ui.navigate('library');await leaving;assert.equal(panel.disposed,true);
 },
 async position_mobile_tab_and_rotation_preserve_board_and_visibility(){
  const mobile=prepareMobileAnalysis();await open(1);const board=ui.state.board,doc=ui.state.doc,panel=positionPanels.at(-1),textarea=annotationDraft('Note mobile à garder');board.engineOn=true;
  assert.equal(panel.initialVisible,false);assert.equal(panel.visible,false);assert.equal(workbench.dataset.mobilePanel,'moves');mobile.click('position');assert.equal(ui.state.analysisMobilePanel,'position');assert.equal(ui.state.analysisTool,'position');assert.equal(panel.visible,true);assert.equal(explorerPanels.at(-1).visible,false);assert.equal(workbench.dataset.mobilePanel,'position');
  mobile.change(false);assert.equal(panel.visible,true);mobile.change(true);assert.equal(panel.visible,true);mobile.click('moves');assert.equal(panel.visible,false);mobile.click('charts');assert.equal(panel.visible,false);mobile.click('explorer');assert.equal(panel.visible,false);assert.equal(explorerPanels.at(-1).visible,true);mobile.click('position');assert.equal(panel.visible,true);
  assert.equal(ui.state.board,board);assert.equal(ui.state.doc,doc);assert.equal(board.engineOn,true);assert.equal(board.path,'0');assert.equal(board.disposed,false);assert.equal(textarea.value,'Note mobile à garder');assert.equal(positionPanels.length,1);
  const leaving=ui.navigate('library');await leaving;assert.equal(panel.disposed,true);
 },
 async position_result_keeps_annotation_local_then_opens_full_game_at_exact_variation(){
  preparePositionTabs();await open(1);ui.selectAnalysisTool('position');const board=ui.state.board,panel=positionPanels.at(-1);localDocument(ui.state.doc).nodes[1].comment='Note originale [%eval 0.4]';const textarea=annotationDraft('Note avant de consulter la correspondance');
  const opening=panel.options.onOpenEntry(2,{path:'0.1',fen:'variation',isCurrent:()=>true});await settle();assertNoEntryMutation();assert.match(localDocument(ui.state.doc).nodes[1].comment,/Note avant de consulter la correspondance/);assert.match(localDocument(ui.state.doc).nodes[1].comment,/\[%eval 0\.4\]/);assert.equal(requests.at(-1).url,'/api/entries/2');assert.equal(requests.at(-1).method,'GET');assert.equal(textarea.disabled,true);
  const target=entry(2);target.nodes[0].children=['0','1'];target.nodes[1].children=['0.0','0.1'];target.nodes.push({path:'0.0',parent:'0',fen:'mainline',san:'e5',children:[],comment:'Suite principale',nags:[]},{path:'0.1',parent:'0',fen:'variation',san:'c5',children:[],comment:'La position cherchée',nags:[1]},{path:'1',parent:'',fen:'side-root',san:'d4',children:[],comment:'Autre ouverture',nags:[]});pending.get('/api/entries/2')(target);assert.equal(await opening,true);
  assert.equal(ui.state.doc,target);assert.equal(ui.state.board.doc,target);assert.equal(ui.state.path,'0.1');assert.equal(ui.state.board.path,'0.1');assert.equal(ui.state.doc.nodes.length,5);assert.equal(ui.state.doc.nodes[3].comment,'La position cherchée');assert.deepEqual(ui.state.doc.nodes[3].nags,[1]);assert.equal(board.disposed,true);assert.equal(panel.disposed,true);
 },
 async position_failed_open_keeps_current_analysis_and_local_draft(){
  preparePositionTabs();await open(1);ui.selectAnalysisTool('position');const board=ui.state.board,source=ui.state.doc,panel=positionPanels.at(-1),textarea=annotationDraft('Ne pas perdre cette note'),args={path:'0',fen:'after',isCurrent:()=>true};
  for(const [status,message]of [[503,'Chargement indisponible'],[404,'Partie supprimée']]){const failedLoad=panel.options.onOpenEntry(2,args);await settle();assert.equal(requests.at(-1).url,'/api/entries/2');assertNoEntryMutation();pending.get('/api/entries/2')({__httpError:status,detail:message});await assert.rejects(failedLoad,new RegExp(message));assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(board.disposed,false);assert.equal(panel.disposed,false);assert.match(localDocument(ui.state.doc).nodes[1].comment,/Ne pas perdre cette note/);assert.equal(textarea.value,'Ne pas perdre cette note');assert.equal(textarea.disabled,false);assert.equal(board.inputLocked,false);}
 },
 async position_stale_callbacks_and_late_open_cannot_replace_another_page(){
  preparePositionTabs();await open(1);ui.selectAnalysisTool('position');const source=ui.state.doc,panel=positionPanels.at(-1),args={path:'0',fen:'after',isCurrent:()=>true};
  const count=requests.length;assert.equal(await panel.options.onOpenEntry(2,{...args,isCurrent:()=>false}),false);assert.equal(requests.length,count);
  const opening=panel.options.onOpenEntry(2,args),respond=pending.get('/api/entries/2');await ui.navigate('library');respond(entry(2));assert.equal(await opening,false);assert.equal(ui.state.page,'library');assert.equal(ui.state.doc,source);assert.equal(ui.state.board,null);assert.equal(panel.disposed,true);
  const after=requests.length;assert.equal(await panel.options.onOpenEntry(3,args),false);assert.equal(requests.length,after);
 },
 async position_changing_source_move_invalidates_pending_result_open(){
  preparePositionTabs();await open(1);ui.selectAnalysisTool('position');const board=ui.state.board,source=ui.state.doc,panel=positionPanels.at(-1),opening=panel.options.onOpenEntry(2,{path:'0',fen:'after',isCurrent:()=>true});
  await board.go('');pending.get('/api/entries/2')(entry(2));assert.equal(await opening,false);assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(board.path,'');assert.equal(ui.state.path,'');assert.equal(board.disposed,false);assert.equal(panel.disposed,false);assert.equal(board.inputLocked,false);
 },
 async position_declined_free_analysis_open_preserves_annotation_snapshot(){
  preparePositionTabs();await open(1);await ui.action('reset-board');ui.selectAnalysisTool('position');const board=ui.state.board,panel=positionPanels.at(-1),textarea=annotationDraft('Brouillon libre à garder');globalThis.confirm=()=>false;const count=requests.length;
  assert.equal(await panel.options.onOpenEntry(2,{path:'0',fen:'after',isCurrent:()=>true}),false);assert.equal(requests.length,count);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(panel.disposed,false);assert.equal(ui.state.doc.id,undefined);assert.equal(textarea.value,'Brouillon libre à garder');assert.match(localDocument(ui.state.doc).nodes[0].comment,/Brouillon libre à garder/);assert.equal(ui.state.path,'');assert.equal(board.inputLocked,false);
 },
 async repertoire_coverage_tab_mounts_and_disposes_without_replacing_cached_analysis(){
  await open(1);const source=ui.state.doc,panel=await showCoverageBase();assert.equal(panel.options.baseId,7);assert.equal(panel.host,document.getElementById('repertoire-coverage'));assert.equal(panel.disposed,false);assert.match(document.getElementById('app').innerHTML,/data-tab="coverage" aria-pressed="true">À compléter/);assert.equal(ui.state.doc,source);
  await ui.navigate('library');assert.equal(panel.disposed,true);const count=requests.length;assert.equal(await panel.options.onExplore({pgn:'stale'},{color:'black',filters:{ratings:[1600],speeds:['rapid']}}),false);assert.equal(requests.length,count);assert.equal(ui.state.doc,source);
 },
 async repertoire_coverage_gap_opens_full_line_with_filters_orientation_and_save_destination(){
  await open(1);const source=ui.state.doc,sourceBefore=structuredClone(source),panel=await showCoverageBase(),gap={pgn:'[Event "À compléter"]\n\n1. e4 c5 *',san:'c5'},filters={ratings:[1400,1600],speeds:['blitz','rapid']};
  const opening=panel.options.onExplore(gap,{color:'black',filters});await settle();assert.equal(requests.at(-1).url,'/api/board');assert.equal(requests.at(-1).method,'POST');assert.deepEqual(requests.at(-1).body,{pgn:gap.pgn});
  const doc=makeDoc();doc.nodes[1].children=['0.0'];doc.nodes.push({path:'0.0',parent:'0',fen:'sicilian',san:'c5',children:[],comment:'',nags:[]});pending.get('/api/board')(doc);assert.equal(await opening,true);
  assert.equal(panel.disposed,true);assert.equal(ui.state.page,'board');assert.equal(ui.state.doc,doc);assert.equal(doc.id,undefined);assert.equal(doc.base_id,7);assert.equal(ui.state.path,'0.0');assert.equal(ui.state.board.path,'0.0');assert.equal(ui.state.board.flipped,true);assert.equal(ui.state.analysisTool,'explorer');assert.equal(ui.state.analysisMobilePanel,'explorer');assert.equal(ui.state.entryNavigation,null);assert.deepEqual(source,sourceBefore);
  assert.deepEqual(explorerPanels.at(-1).options.settingsOverride,{source:'lichess',...filters,repertoire_color:'black',show_probability:true});
  await ui.action('save-board');const dialog=dialogs.at(-1);assert.match(dialog.html,/<option value="7" selected>/);assert.equal(requests.some(r=>r.method==='PATCH'),false);
  const form=new Map([['base_id','7'],['title','Réponse Sicilienne']]),saving=dialog.options.onSubmit(form);await settle();assert.equal(requests.at(-1).url,'/api/entries');assert.equal(requests.at(-1).body.base_id,7);assert.deepEqual(JSON.parse(requests.at(-1).body.pgn).nodes,doc.nodes);pending.get('/api/entries')({...doc,id:90,title:'Réponse Sicilienne'});await saving;assert.equal(ui.state.doc.id,90);assert.equal(source.id,1);assert.deepEqual(source,sourceBefore);
 },
 async repertoire_coverage_rejected_and_late_gap_opens_preserve_active_document(){
  await open(1);const source=ui.state.doc,panel=await showCoverageBase(),context={color:'black',filters:{ratings:[1600],speeds:['rapid']}},failed=panel.options.onExplore({pgn:'bad'},context);pending.get('/api/board')({__httpError:400,detail:'PGN incorrect'});await assert.rejects(failed,/PGN incorrect/);assert.equal(ui.state.doc,source);assert.equal(ui.state.page,'base');assert.equal(panel.disposed,false);
  const late=panel.options.onExplore({pgn:'good'},context),respond=pending.get('/api/board');await ui.navigate('library');respond(makeDoc());assert.equal(await late,false);assert.equal(ui.state.page,'library');assert.equal(ui.state.doc,source);assert.equal(ui.state.board,null);
 },
 async repertoire_coverage_declined_open_keeps_unsaved_analysis(){
  const panel=await showCoverageBase(),source=ui.state.doc;globalThis.confirm=()=>false;const count=requests.length;
  assert.equal(await panel.options.onExplore({pgn:'ignored'},{color:'black',filters:{ratings:[1600],speeds:['rapid']}}),false);assert.equal(requests.length,count);assert.equal(ui.state.doc,source);assert.equal(ui.state.page,'base');assert.equal(panel.disposed,false);
 },
 async entry_navigation_captures_visible_order_and_stops_at_both_ends(){
  await openBaseEntry(1,[4,1,3]);assert.deepEqual(ui.state.entryNavigation,{baseId:7,ids:[4,1,3]});assertEntryCounter(2,3);
  assert.equal(requests.filter(r=>r.url==='/api/bases/7/entries').length,1,'The visible table already supplies the filtered order');
  const oldBoard=ui.state.board,next=ui.action('entry-next');await settle();assert.equal(requests.at(-1).url,'/api/entries/3');pending.get('/api/entries/3')(entry(3));assert.equal(await next,true);assert.equal(oldBoard.disposed,true);assertEntryCounter(3,3);
  let count=requests.length;assert.equal(await ui.action('entry-next'),false);assert.equal(requests.length,count,'Next never wraps around to the first game');
  for(const id of [1,4]){const previous=ui.action('entry-prev');await settle();assert.equal(requests.at(-1).url,'/api/entries/'+id);pending.get('/api/entries/'+id)(entry(id));assert.equal(await previous,true);}
  assertEntryCounter(1,3);count=requests.length;assert.equal(await ui.action('entry-prev'),false);assert.equal(requests.length,count,'Previous never wraps around');
  assert.equal(requests.some(r=>r.url==='/api/entries/2'),false,'A filtered-out game is not part of this navigation');
 },
 async entry_navigation_ignores_busy_boards_and_rapid_repeated_clicks(){
  await openBaseEntry();const board=ui.state.board,count=requests.length;
  board.busy=true;assert.equal(await ui.action('entry-next'),false);board.busy=false;board.inputLocked=true;assert.equal(await ui.action('entry-next'),false);board.inputLocked=false;assert.equal(requests.length,count);
  const first=ui.action('entry-next');assert.equal(board.inputLocked,true);assert.equal(controls.get('save-board').disabled,true);
  assert.equal(await ui.action('entry-next'),false);assert.equal(await ui.action('entry-prev'),false);await settle();assert.equal(requests.filter(r=>r.url==='/api/entries/2').length,1);
  pending.get('/api/entries/2')(entry(2));assert.equal(await first,true);assert.equal(ui.state.doc.id,2);assertEntryCounter(2,3);assert.equal(ui.state.board.inputLocked,false);assert.equal(controls.get('save-board').disabled,false);
 },
 async entry_navigation_keeps_annotation_local_and_preserves_failed_draft(){
  await openBaseEntry();const board=ui.state.board,source=ui.state.doc;localDocument(source).nodes[1].comment='Original [%eval 0.4]';const textarea=annotationDraft('Précision avant la partie suivante');
  const failed=ui.action('entry-next');await settle();assert.equal(requests.at(-1).url,'/api/entries/2');assert.equal(requests.at(-1).method,'GET');assertNoEntryMutation();assert.equal(textarea.disabled,true);
  assert.match(localDocument(source).nodes[1].comment,/Précision avant la partie suivante/);assert.match(localDocument(source).nodes[1].comment,/\[%eval 0\.4\]/);
  pending.get('/api/entries/2')({__httpError:503,detail:'Chargement indisponible'});await assert.rejects(failed,/Chargement indisponible/);assert.equal(ui.state.doc,source);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(board.inputLocked,false);assert.equal(textarea.disabled,false);assert.equal(textarea.value,'Précision avant la partie suivante');assertEntryCounter(1,3);
  const retry=ui.action('entry-next');await settle();assert.equal(requests.at(-1).url,'/api/entries/2');assert.equal(requests.at(-1).method,'GET');pending.get('/api/entries/2')(entry(2));assert.equal(await retry,true);assert.equal(ui.state.doc.id,2);assertEntryCounter(2,3);assertNoEntryMutation();
 },
 async entry_navigation_failed_load_keeps_board_and_missing_target_is_removed(){
  await openBaseEntry();const board=ui.state.board,source=ui.state.doc;
  const failed=ui.action('entry-next');pending.get('/api/entries/2')({__httpError:503,detail:'Chargement indisponible'});await assert.rejects(failed,/Chargement indisponible/);assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(board.disposed,false);assert.equal(board.inputLocked,false);assertEntryCounter(1,3);
  const missing=ui.action('entry-next');pending.get('/api/entries/2')({__httpError:404,detail:'Partie supprimée'});await assert.rejects(missing,/Partie supprimée/);assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.deepEqual(ui.state.entryNavigation.ids,[1,3]);assertEntryCounter(1,2);
  const next=ui.action('entry-next');await settle();assert.equal(requests.at(-1).url,'/api/entries/3');pending.get('/api/entries/3')(entry(3));await next;assertEntryCounter(2,2);
 },
 async entry_navigation_late_load_cannot_replace_another_page(){
  await openBaseEntry();const source=ui.state.doc,next=ui.action('entry-next'),respond=pending.get('/api/entries/2');await ui.navigate('library');respond(entry(2));assert.equal(await next,false);assert.equal(ui.state.page,'library');assert.equal(ui.state.doc,source);assert.equal(ui.state.board,null);
 },
 async entry_navigation_moved_target_is_removed_without_replacing_current_game(){
  await openBaseEntry();const source=ui.state.doc,board=ui.state.board,next=ui.action('entry-next');pending.get('/api/entries/2')({...entry(2),base_id:8});await assert.rejects(next,/déplacée/);
  assert.equal(ui.state.doc,source);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(board.inputLocked,false);assert.deepEqual(ui.state.entryNavigation.ids,[1,3]);assertEntryCounter(1,2);
 },
 async entry_navigation_batch_changes_prune_context_without_replacing_current_game(){
  const table=await openBaseEntry(),source=ui.state.doc,board=ui.state.board;
  await table.options.onChanged({action:'delete',entry_ids:[2],source_base_id:7,count:1});assert.deepEqual(ui.state.entryNavigation.ids,[1,3]);assertEntryCounter(1,2);
  await table.options.onChanged({action:'move',entry_ids:[3],source_base_id:7,target_base_id:8,count:1});assert.deepEqual(ui.state.entryNavigation.ids,[1]);assertEntryCounter(1,1);assert.equal(ui.state.doc,source);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);
 },
 async entry_navigation_source_identity_change_invalidates_pending_load(){
  await openBaseEntry();const source=ui.state.doc,board=ui.state.board,next=ui.action('entry-next');source.base_id=8;pending.get('/api/entries/2')(entry(2));assert.equal(await next,false);
  assert.equal(ui.state.doc,source);assert.equal(ui.state.doc.base_id,8);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(board.inputLocked,false);
 },
 async entry_navigation_fallback_populates_counter_without_replacing_analysis(){
  await openTestBase();await open(1);const board=ui.state.board,source=ui.state.doc,panels=analysisPanels.length;board.engineOn=true;await board.go('');const textarea=annotationDraft('Lecture en cours');assert.equal(document.getElementById('analysis-entry-nav-mobile').innerHTML,'Analyse');
  pending.get('/api/bases/7/entries')({entries:[entry(3),entry(1),entry(2)]});await settle();assertEntryCounter(2,3);assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(board.path,'');assert.equal(board.engineOn,true);assert.equal(board.disposed,false);assert.equal(textarea.value,'Lecture en cours');assert.equal(analysisPanels.length,panels);assert.equal(requests.filter(r=>r.url==='/api/entries/1').length,1);
 },
 async entry_navigation_stale_fallback_cannot_replace_new_game_context(){
  await openTestBase();await open(1);const oldResponse=pending.get('/api/bases/7/entries');await open(2);const board=ui.state.board;pending.get('/api/bases/7/entries')({entries:[entry(2),entry(6)]});await settle();assertEntryCounter(1,2);
  oldResponse({entries:[entry(1),entry(5),entry(9)]});await settle();assert.deepEqual(ui.state.entryNavigation,{baseId:7,ids:[2,6]});assertEntryCounter(1,2);assert.equal(ui.state.board,board);assert.equal(ui.state.doc.id,2);
 },
 async entry_navigation_source_identity_change_invalidates_pending_fallback(){
  await openTestBase();await open(1);const board=ui.state.board,source=ui.state.doc;source.base_id=8;pending.get('/api/bases/7/entries')({entries:[entry(1),entry(2)]});await settle();
  assert.equal(ui.state.entryNavigation,null);assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(document.getElementById('analysis-entry-nav-mobile').innerHTML,'Analyse');
 },
 async entry_navigation_free_analysis_hides_game_controls(){
  await openBaseEntry();await ui.action('reset-board');assert.equal(ui.state.doc.id,undefined);assert.equal(document.getElementById('analysis-entry-nav-desktop').innerHTML,'');assert.equal(document.getElementById('analysis-entry-nav-mobile').innerHTML,'Analyse');assert.doesNotMatch(document.getElementById('app').innerHTML,/data-action="entry-(prev|next)"/);
  const count=requests.length;assert.equal(await ui.action('entry-prev'),false);assert.equal(await ui.action('entry-next'),false);assert.equal(requests.length,count);
 },
 async entry_navigation_from_review_keeps_return_button_and_session_progress(){
  await showReviewPage();await ui.launchReview(7);const session=reviewSessions.at(-1),opening=session.options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;
  pending.get('/api/bases/7/entries')({entries:[entry(9),entry(10)]});await settle();assertEntryCounter(1,2);
  const next=ui.action('entry-next');pending.get('/api/entries/10')(entry(10));await next;assertEntryCounter(2,2);assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);
  await ui.action('resume-review');assert.equal(currentReviewSession,session);assert.equal(session.completed,2);assert.equal(session.index,2);assert.deepEqual(session.cards,[{id:31},{id:32},{id:33}]);assert.equal(reviewSessions.length,1);assert.equal(reviewResumeCalls.length,1);assert.equal(ui.state.page,'reviews');
 },
 async new_entry_is_marked_seen_only_after_analysis_mount_and_without_blocking_it(){
  const source={...entry(1),is_new:true,seen_at:null},content=JSON.stringify(source.nodes);
  ui.state.entries=[structuredClone(source)];
  const opening=ui.openEntry(1);pending.get('/api/entries/1')(source);await opening;
  assert.equal(ui.state.board.doc,source);assert.equal(source.is_new,true,'The analysis opens while the status write is pending');
  const writes=()=>requests.filter(r=>r.url==='/api/entries/1/seen');
  assert.equal(writes().length,1);assert.equal(writes()[0].method,'POST');assert.deepEqual(writes()[0].body,{});
  await ui.navigate('library');await ui.navigate('board');assert.equal(writes().length,1,'Repeated mounts share the pending status write');
  const board=ui.state.board;board.path='0.1';
  pending.get('/api/entries/1/seen')({is_new:false,seen_at:'2026-10-21T12:00:00Z'});await settle();
  assert.equal(source.is_new,false);assert.equal(source.seen_at,'2026-10-21T12:00:00Z');assert.equal(ui.state.entries[0].is_new,false);
  assert.equal(ui.state.board,board);assert.equal(board.path,'0.1');assert.equal(JSON.stringify(source.nodes),content);
  await ui.navigate('library');await ui.navigate('board');assert.equal(writes().length,1,'An already seen analysis needs no extra writes');
  assert.equal(requests.some(r=>r.method==='PATCH'||r.url.includes('/grade')),false);
 },
 async stale_opens_and_metadata_reads_do_not_mark_entries_seen(){
  const first=ui.openEntry(1),second=ui.openEntry(2);
  pending.get('/api/entries/2')({...entry(2),is_new:true});await second;
  pending.get('/api/entries/1')({...entry(1),is_new:true});await first;
  assert.equal(requests.some(r=>r.url==='/api/entries/1/seen'),false);
  const board=ui.state.board,doc=ui.state.doc;
  const table=await openTestBase(),metadata=table.options.onMetadata(1);
  pending.get('/api/entries/1')({...entry(1),is_new:true});await metadata;
  assert.equal(requests.some(r=>r.url==='/api/entries/1/seen'),false,'Reading PGN metadata is not opening the analysis');
  pending.get('/api/entries/2/seen')({is_new:false,seen_at:'2026-10-21T12:00:00Z'});await settle();
  assert.equal(ui.state.page,'base');assert.equal(ui.state.doc,doc);assert.equal(doc.is_new,false);assert.equal(board.disposed,true);
 },
 async failed_seen_write_keeps_analysis_and_retries_on_next_open(){
  const source={...entry(1),is_new:true,seen_at:null},opening=ui.openEntry(1);
  pending.get('/api/entries/1')(source);await opening;const board=ui.state.board;
  pending.get('/api/entries/1/seen')({__httpError:503,detail:'Statut indisponible'});await settle();
  assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(source.is_new,true);
  await ui.navigate('library');await ui.navigate('board');
  assert.equal(requests.filter(r=>r.url==='/api/entries/1/seen').length,2);
  pending.get('/api/entries/1/seen')({is_new:false,seen_at:'2026-10-21T12:00:00Z'});await settle();assert.equal(source.is_new,false);
 },
 async mobile_command_dock_preserves_reading_and_quick_save_draft_across_rotation(){
  const mobile=prepareMobileAnalysis({commands:true}),c=mobile.commands;await open(1);
  const board=ui.state.board,source=ui.state.doc,form=document.getElementById('annotation-form'),textarea=new Element();textarea.value='Brouillon depuis le téléphone';form.querySelector=selector=>selector==='[name="comment"]'?textarea:null;form.querySelectorAll=selector=>selector==='textarea,input,button'?[textarea]:[];
  assert.equal(c.actions.parentElement,c.dock);assert.equal(readingHost.parentElement,c.menu);assert.equal(c.save,document.querySelector('[data-action="save-board"]'));
  const readingHandler=readingHost.handlers.get('click');clickReading('font-more');const size=workbench.style.getPropertyValue('--analysis-comment-size');assert.equal(size,'14px');assert.equal(textarea.value,'Brouillon depuis le téléphone');
  const saving=ui.action('save-board'),request=requests.at(-1),snapshot=JSON.parse(request.body.pgn);assert.equal(request.url,'/api/entries/1');assert.match(snapshot.nodes[1].comment,/Brouillon depuis le téléphone/);assert.equal(c.save.disabled,true);
  mobile.change(false);assert.equal(c.actions.parentElement,c.home);assert.deepEqual(c.actions.children,[readingHost,c.save,c.more]);assert.equal(c.save.disabled,true);assert.equal(readingHost.handlers.get('click'),readingHandler);assert.equal(workbench.style.getPropertyValue('--analysis-comment-size'),size);
  mobile.change(true);assert.equal(c.actions.parentElement,c.dock);await ui.action('save-board');assert.equal(requests.filter(item=>item.method==='PATCH'&&item.url==='/api/entries/1').length,1);
  pending.get('/api/entries/1')(snapshot);await saving;assert.equal(c.save.disabled,false);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(board.path,'0');assert.equal(ui.state.doc.nodes[1].comment,snapshot.nodes[1].comment);assert.equal(source.id,1);
  const stale=mobile.media.handlers.get('change');await ui.navigate('library');assert.equal(c.actions.parentElement,c.home);assert.equal(readingHost.parentElement,c.actions);assert.equal(readingHost.handlers.has('click'),false);stale();assert.equal(c.actions.parentElement,c.home);
 },
 async mobile_annotation_button_toggles_existing_editor_and_accessible_state(){
  const mobile=prepareMobileAnalysis();await open(1);mobile.click('explorer');
  const board=ui.state.board,source=ui.state.doc,panel=document.getElementById('analysis-annotations'),editor=document.getElementById('annotation-editor'),button=controls.get('toggle-annotations');editor.innerHTML='Annotation en cours';panel.open=false;
  await ui.action('toggle-annotations');assert.equal(panel.open,true);assert.equal(button.getAttribute('aria-expanded'),'true');assert.equal(workbench.dataset.mobilePanel,'moves');assert.equal(editor.innerHTML,'Annotation en cours');
  await ui.action('toggle-annotations');assert.equal(panel.open,false);assert.equal(button.getAttribute('aria-expanded'),'false');assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(editor.innerHTML,'Annotation en cours');
  panel.open=true;panel.handlers.get('toggle')();assert.equal(button.getAttribute('aria-expanded'),'true');panel.open=false;panel.handlers.get('toggle')();assert.equal(button.getAttribute('aria-expanded'),'false');
 },
 async mobile_more_commands_use_current_board_and_pgn_copy_handler(){
  prepareMobileAnalysis({commands:true});await open(1);const first=ui.state.board,firstCalls=[];first.control=action=>firstCalls.push(action);
  await ui.action('board-copy-fen');await ui.action('board-flip');assert.deepEqual(firstCalls,['copy-fen','flip']);
  await open(2);const second=ui.state.board,secondCalls=[];second.control=action=>secondCalls.push(action);await ui.action('board-flip');assert.deepEqual(secondCalls,['flip']);assert.deepEqual(firstCalls,['copy-fen','flip']);
  const copies=[];Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async value=>copies.push(value)}}});
  second.doc.nodes[1].comment='Current local note';second.doc.pgn='Old server PGN';const before=requests.length;await second.onCopyPgn();assert.equal(copies.length,1);assert.equal(JSON.parse(copies[0]).nodes[1].comment,'Current local note');assert.equal(requests.length,before,'Copy exports the displayed local document without reloading the stored PGN');assert.equal(ui.state.board,second);assert.equal(second.path,'0');
 },
 async mobile_analysis_tabs_preserve_drafts_board_and_pause_hidden_explorer(){
  const mobile=prepareMobileAnalysis();await open(1);
  const board=ui.state.board,doc=ui.state.doc,path=ui.state.path,editor=document.getElementById('annotation-editor'),engine=document.getElementById('analysis-engine');
  const explorer=explorerPanels.at(-1),chart=chartPanels.at(-1),report=analysisPanels.at(-1),source=JSON.stringify(doc),history=JSON.stringify(ui.freeHistory),before=requests.length;
  editor.innerHTML='Commentaire mobile non enregistré';engine.innerHTML='Trois lignes Stockfish';board.engineOn=true;
  assert.equal(explorer.initialVisible,false,'The explorer must start hidden before its constructor can issue requests');assert.equal(explorer.visible,false);assert.equal(workbench.dataset.mobilePanel,'moves');
  for(const id of ['explorer','position','charts','repertoire','bilan','moves']){
   mobile.click(id);assert.equal(ui.state.analysisMobilePanel,id);assert.equal(workbench.dataset.mobilePanel,id);assert.equal(explorer.visible,id==='explorer');
   assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(ui.state.doc,doc);assert.equal(board.doc,doc);assert.equal(ui.state.path,path);assert.equal(board.path,path);assert.equal(JSON.stringify(doc),source);assert.equal(JSON.stringify(ui.freeHistory),history);
   assert.equal(editor.innerHTML,'Commentaire mobile non enregistré');assert.equal(engine.innerHTML,'Trois lignes Stockfish');assert.equal(board.engineOn,true);
   assert.equal(explorerPanels.at(-1),explorer);assert.equal(chartPanels.at(-1),chart);assert.equal(analysisPanels.at(-1),report);assert.equal(requests.length,before);
  }
 },
 async mobile_toolbar_opens_bilan_and_return_to_moves_follows_current_move(){
  const mobile=prepareMobileAnalysis();await open(1);
  const board=ui.state.board,doc=ui.state.doc,editor=document.getElementById('annotation-editor'),list=document.getElementById('move-list'),move=new Element();
  move.dataset.path='0';move.getBoundingClientRect=()=>({top:320,height:24});list.querySelectorAll=selector=>['.move[data-path]','[data-path]'].includes(selector)?[move]:[];list.getBoundingClientRect=()=>({top:100});list.clientHeight=200;list.clientTop=0;list.scrollTop=0;
  editor.innerHTML='Mon brouillon';mobile.bilan.onclick();assert.equal(workbench.dataset.mobilePanel,'bilan');assert.equal(ui.state.analysisTool,'bilan');assert.equal(explorerPanels.at(-1).visible,false);assert.equal(tabPanels.find(panel=>panel===document.getElementById('analysis-tool-bilan')).hidden,false);
  mobile.click('moves');assert.equal(list.scrollTop,212,'The selected move returns near the top so its annotation is readable');assert.equal(list.style.getPropertyValue('--analysis-move-tail'),'168px');
  assert.equal(ui.state.board,board);assert.equal(ui.state.doc,doc);assert.equal(ui.state.path,'0');assert.equal(editor.innerHTML,'Mon brouillon');assert.equal(explorerPanels.at(-1).visible,false);
 },
 async mobile_missing_saved_game_tab_falls_back_and_old_tab_events_are_detached(){
  const mobile=prepareMobileAnalysis();await open(1);mobile.click('bilan');
  const oldHandler=mobile.tabs.handlers.get('click'),oldTab=mobile.items.find(item=>item.dataset.mobilePanel==='bilan');
  await ui.action('reset-board');assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.analysisMobilePanel,'moves');assert.equal(workbench.dataset.mobilePanel,'moves');
  assert.equal(mobile.items.some(item=>item.dataset.mobilePanel==='bilan'),false);assert.equal(explorerPanels.at(-1).initialVisible,false);
  oldHandler({target:oldTab});assert.equal(ui.state.analysisMobilePanel,'moves');assert.equal(workbench.dataset.mobilePanel,'moves');assert.equal(ui.state.path,'');
  mobile.click('charts');const stale=mobile.tabs.handlers.get('click'),staleTab=mobile.items.find(item=>item.dataset.mobilePanel==='explorer');await ui.navigate('library');assert.equal(mobile.tabs.handlers.has('click'),false);
  stale({target:staleTab});assert.equal(ui.state.page,'library');assert.equal(ui.state.analysisMobilePanel,'charts');
 },
 async library_cards_render_tree_logos_and_sibling_drag_handles(){
  globalThis.libraryPayload={bases:[{id:7,name:'Cours <b>',folder_id:2,entry_count:3,settings:{},tags:['Annotations']},{id:8,name:'Finales',entry_count:0,settings:{},logo:{kind:'icon',icon:'rook'}}],folders:[{id:1,name:'Études'},{id:2,name:'Cours',parent_id:1}]};
  await ui.navigate('library');const html=document.getElementById('app').innerHTML;assert.match(html,/folder-children-1/);assert.match(html,/class="folder-name">Cours<\/span>/);assert.match(html,/class="base-logo"/);assert.match(html,/data-library-base="7"/);assert.match(html,/Cours &lt;b&gt;/);assert.match(html,/data-context-name="Cours &lt;b&gt;"/);
  let nesting=0;for(const tag of html.match(/<\/?button\b[^>]*>/g)){nesting+=tag.startsWith('</')?-1:1;assert.ok(nesting<=1&&nesting>=0,'Logo and drag handle cannot create nested buttons');}assert.equal(nesting,0);
 },
 async base_logo_settings_save_locks_form_and_sends_only_changed_logo(){
  const {form,type,other,editor}=await showBaseSettings();editor.choice={kind:'icon',icon:'book'};editor.changed=true;
  const saving=form.onsubmit(submitEvent());await settle();const writes=requests.filter(r=>r.url==='/api/bases/7'&&r.method==='PATCH');assert.equal(writes.length,1);assert.deepEqual(writes[0].body.logo,{kind:'icon',icon:'book'});assert.equal(writes[0].body.settings.max,720);assert.equal(type.disabled,true);assert.equal(other.disabled,true);assert.equal(editor.disabled,true);
  await form.onsubmit(submitEvent());assert.equal(requests.filter(r=>r.url==='/api/bases/7'&&r.method==='PATCH').length,1);pending.get('/api/bases/7')({});await settle();pending.get('/api/bases/7/entries')({entries:[]});await saving;assert.equal(editor.disposed,true);
  const next=ui.baseAppearanceEditor;assert.equal(next.changed,undefined);const unchanged=form.onsubmit(submitEvent());await settle();const last=requests.filter(r=>r.url==='/api/bases/7'&&r.method==='PATCH').at(-1);assert.equal(Object.hasOwn(last.body,'logo'),false);pending.get('/api/bases/7')({});await settle();pending.get('/api/bases/7/entries')({entries:[]});await unchanged;
 },
 async base_logo_failed_save_preserves_image_for_retry_and_loading_prevents_submit(){
  const {form,type,editor}=await showBaseSettings();editor.loading=true;await form.onsubmit(submitEvent());assert.equal(requests.some(r=>r.method==='PATCH'),false);assert.equal(type.disabled,false);
  editor.loading=false;editor.choice={kind:'image',data_url:'data:image/png;base64,aGVsbG8='};editor.changed=true;
  const saving=form.onsubmit(submitEvent());pending.get('/api/bases/7')({__httpError:400,detail:'Image invalide'});await saving;assert.equal(editor.disposed,false);assert.equal(editor.disabled,false);assert.equal(type.disabled,false);assert.equal(ui.baseAppearanceEditor,editor);assert.deepEqual(editor.getPatch(),{kind:'image',data_url:'data:image/png;base64,aGVsbG8='});
  const retry=form.onsubmit(submitEvent());assert.equal(requests.filter(r=>r.method==='PATCH').length,2);pending.get('/api/bases/7')({});await settle();pending.get('/api/bases/7/entries')({entries:[]});await retry;
 },
 async stale_logo_save_cannot_replace_a_new_settings_editor(){
  const {form,editor}=await showBaseSettings();editor.choice={kind:'icon',icon:'book'};editor.changed=true;const oldSubmit=form.onsubmit,saving=oldSubmit(submitEvent());const respond=pending.get('/api/bases/7');
  await ui.navigate('library');elements.delete('base-settings');const newer=prepareSettingsForm();ui.state.tab='settings';const opening=ui.navigate('base',{baseId:7,keepTab:true});await settle();pending.get('/api/bases/7/entries')({entries:[]});await opening;
  const next=ui.baseAppearanceEditor;next.choice={kind:'icon',icon:'puzzle'};next.changed=true;const writeCount=requests.filter(r=>r.method==='PATCH').length;await oldSubmit(submitEvent());assert.equal(requests.filter(r=>r.method==='PATCH').length,writeCount);
  respond({});await settle();pending.get('/api/bases/7/entries')({entries:[]});await saving;assert.equal(ui.baseAppearanceEditor,next);assert.equal(next.disposed,false);assert.deepEqual(next.getPatch(),{kind:'icon',icon:'puzzle'});assert.equal(document.getElementById('base-settings'),newer.form);assert.equal(editor.disposed,true);
 },

 async review_statistics_tabs_preserve_filters_and_cached_analysis(){
  await open(1);const source=ui.state.doc;await showReviewPage();assert.equal(statisticsPanels.length,0);assert.match(document.getElementById('app').innerHTML,/review-tab-statistics/);
  reviewTabs[1].onclick();const first=statisticsPanels.at(-1);assert.deepEqual(first.options.options,{baseId:null,days:90,historyMetric:'count'});assert.equal(ui.state.doc,source);assert.equal(ui.state.path,'0');
  first.options.onOptionsChange({baseId:7,days:30,historyMetric:'time'});reviewTabs[0].onclick();assert.equal(first.disposed,true);assert.equal(ui.state.reviewView,'bases');reviewTabs[1].onclick();
  assert.deepEqual(statisticsPanels.at(-1).options.options,{baseId:7,days:30,historyMetric:'time'});assert.equal(ui.state.doc,source);await ui.navigate('board');assert.equal(statisticsPanels.at(-1).disposed,true);assert.equal(ui.state.board.doc,source);
 },
 async review_statistics_late_callbacks_cannot_navigate_or_change_filters(){
  await showReviewPage();ui.selectReviewView('statistics');const panel=statisticsPanels.at(-1),options={...ui.state.reviewStatisticsOptions};
  const opening=panel.options.onOpenBase(7);await settle();pending.get('/api/bases/7/entries')({entries:[entry(1)]});await opening;assert.equal(ui.state.page,'base');assert.equal(panel.disposed,true);
  panel.options.onOptionsChange({baseId:8,days:365});await panel.options.onOpenBase(8);await panel.options.onReviewBase(7);assert.equal(ui.state.page,'base');assert.equal(ui.state.baseId,7);assert.deepEqual(ui.state.reviewStatisticsOptions,options);assert.equal(reviewSessions.length,0);
 },
 async review_statistics_launch_and_close_session_refresh_dashboard_without_background_panel(){
  await showReviewPage();ui.selectReviewView('statistics');const panel=statisticsPanels.at(-1);panel.options.onOptionsChange({baseId:7,days:7,historyMetric:'count'});
  await panel.options.onReviewBase(8);assert.equal(reviewSessions.length,0,'Disabled bases do not launch a review');
  await panel.options.onReviewBase(7);assert.equal(panel.disposed,true);assert.equal(statisticsPanels.length,1,'Preparing a session must not mount a hidden statistics component');assert.equal(reviewSessions.length,1);
  ui.selectReviewView('bases');assert.equal(ui.state.reviewView,'statistics','Dashboard tabs cannot replace a live review');
  const close=reviewSessions[0].options.onClose();await settle();pending.get('/api/reviews')({bases:[]});await close;assert.equal(statisticsPanels.length,2);assert.deepEqual(statisticsPanels.at(-1).options.options,{baseId:7,days:7,historyMetric:'count'});
 },
 async review_statistics_resume_preserves_session_without_mounting_dashboard(){
  await showReviewPage();ui.selectReviewView('statistics');await statisticsPanels.at(-1).options.onReviewBase(7);const session=reviewSessions[0];
  const opening=session.options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;const before=statisticsPanels.length;
  await ui.action('resume-review');assert.equal(statisticsPanels.length,before);assert.equal(currentReviewSession,session);assert.equal(currentReviewSession.completed,2);assert.equal(currentReviewSession.index,2);assert.equal(reviewResumeCalls.length,1);
 },
 async review_statistics_tabs_support_keyboard_without_moving_cached_board(){
  await open(1);await showReviewPage();let stopped=0,prevented=0;const event=key=>({key,preventDefault(){prevented++;},stopPropagation(){stopped++;}});
  reviewTabs[0].onkeydown(event('End'));assert.equal(ui.state.reviewView,'statistics');assert.equal(document.activeElement,document.getElementById('review-tab-statistics'));
  reviewTabs[1].onkeydown(event('ArrowLeft'));assert.equal(ui.state.reviewView,'history');reviewTabs[0].onkeydown(event('ArrowRight'));assert.equal(ui.state.reviewView,'history');reviewTabs[1].onkeydown(event('Home'));assert.equal(ui.state.reviewView,'bases');
  assert.equal(stopped,4);assert.equal(prevented,4);assert.equal(ui.state.path,'0');assert.equal(ui.state.doc.id,1);
 },
 async review_statistics_remains_available_with_no_reviewable_base(){
  globalThis.libraryPayload={bases:[],folders:[]};const navigation=ui.navigate('reviews');await settle();pending.get('/api/reviews')({bases:[]});await navigation;assert.match(document.getElementById('app').innerHTML,/Aucune base à réviser/);reviewTabs[1].onclick();assert.equal(statisticsPanels.length,1);assert.equal(ui.state.reviewView,'statistics');assert.match(document.getElementById('app').innerHTML,/id="review-panel-statistics"[^>]*>/);
 },

 async batch_metadata_start_cancels_pending_open_before_mutation_finishes(){
  await open(2);const table=await openTestBase(),opening=table.options.onOpenEntry(1);const respond=pending.get('/api/entries/1');
  table.options.onBatchStart({action:'metadata',entry_ids:[1],headers:{Event:'Open'}});respond(entry(1));assert.equal(await opening,false);assert.equal(ui.state.page,'base');assert.equal(table.disposed,undefined,'An old opening cannot unmount the saving table or unlock its modal');assert.equal(ui.state.doc.id,2);
 },

 async batch_metadata_preserves_cached_tree_and_quick_save_uses_new_headers(){
  await open(1);const source=ui.state.doc;source.headers.Event='Ancien tournoi';source.nodes[1].comment='Commentaire à conserver';const nodes=structuredClone(source.nodes),table=await openTestBase();
  const summary={id:1,base_id:7,title:'Partie 1',headers:{...source.headers,Event:'Open du club'},updated_at:'2026-10-20T20:00:00+00:00',history:{can_undo:true,can_redo:false}};
  const change=table.options.onChanged({action:'metadata',entry_ids:[1,2],source_base_id:7,headers:{Event:'Open du club'},updated_entries:[summary],count:2});await settle();pending.get('/api/bases/7/entries')({entries:[summary,entry(2)]});await change;
  assert.equal(ui.state.doc,source);assert.deepEqual(ui.state.doc.nodes,nodes);assert.equal(ui.state.path,'0');assert.equal(ui.state.doc.headers.Event,'Open du club');assert.equal(ui.state.doc.history.can_redo,false);assert.equal(table.updates.length,1);assert.equal(entryTables.length,1);
  await ui.navigate('board');const saving=ui.action('save-board');const body=requests.at(-1).body;assert.equal(JSON.parse(body.pgn).headers.Event,'Open du club');assert.equal(body.start_path,'0');pending.get('/api/entries/1')({...source});await saving;
 },
 async batch_metadata_late_completion_preserves_visible_draft_and_engine(){
  await open(1);const table=await openTestBase();await ui.navigate('board');const board=ui.state.board,source=ui.state.doc;board.engineOn=true;board.flipped=true;
  const form=document.getElementById('annotation-form'),textarea=new Element();textarea.value='Note encore en saisie';form.querySelector=selector=>selector==='[name="comment"]'?textarea:null;form.querySelectorAll=()=>[];
  const count=requests.length;await table.options.onChanged({action:'metadata',entry_ids:[1],source_base_id:7,headers:{White:'Alice'},updated_entries:[{id:1,headers:{Result:'*',White:'Alice'},title:'Alice — Bob',updated_at:'2026-10-20T20:00:00+00:00',history:{can_undo:true,can_redo:false}}]});
  assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(board.path,'0');assert.equal(board.engineOn,true);assert.equal(board.flipped,true);assert.equal(board.disposed,false);assert.equal(textarea.value,'Note encore en saisie');assert.equal(source.nodes[1].comment,'');assert.equal(source.title,'Alice — Bob');assert.equal(requests.length,count,'A disposed table must not reopen its old page');
 },
 async batch_metadata_cadence_refreshes_times_without_replacing_tree_or_draft(){
  await open(1);ui.state.doc.headers.TimeControl='600+5';ui.state.doc.nodes[1].elapsed=30;ui.state.doc.nodes[0].comment='[%emt 0:00:03]';ui.state.doc.nodes[0].elapsed=3;
  const table=await openTestBase();await ui.navigate('board');const source=ui.state.doc,board=ui.state.board,nodes=source.nodes;
  const list=document.getElementById('move-list'),move=new Element();move.dataset.path='0';move.closest=selector=>selector==='.move[data-path]'?move:null;list.children=[move];list.querySelectorAll=selector=>selector==='[data-path]'?[move]:[];
  let notation=list.innerHTML,renderCount=0;Object.defineProperty(list,'innerHTML',{configurable:true,get:()=>notation,set:value=>{notation=value;renderCount++;}});
  await board.go('0');assert.match(notation,/Temps pris pour ce coup : 30 s/);list.scrollTop=117;move.focus();
  const initialRenderCount=renderCount;
  const form=document.getElementById('annotation-form'),textarea=new Element();textarea.value='Texte en cours';form.querySelector=selector=>selector==='[name="comment"]'?textarea:null;
  const change=table.options.onChanged({action:'metadata',entry_ids:[1],source_base_id:7,headers:{TimeControl:'300+5'},updated_entries:[{id:1,headers:{Result:'*',TimeControl:'300+5'},title:'Partie 1',updated_at:'2026-10-20T20:00:00+00:00'}]});await settle();
  assert.equal(source.nodes[1].elapsed,null,'Old inferred times cannot remain visible');assert.equal(source.nodes[0].elapsed,3,'Explicit thinking time is independent of cadence');
  assert.doesNotMatch(notation,/analysis-move-clock/,'The old duration disappears while cadence is recalculated');assert.equal(renderCount,initialRenderCount+1);assert.equal(list.scrollTop,117);assert.equal(document.activeElement,move);
  const refreshed=structuredClone(source);refreshed.nodes[1].elapsed=5;refreshed.nodes[1].clock=295;pending.get('/api/entries/1')(refreshed);await change;
  assert.equal(ui.state.doc,source);assert.equal(source.nodes,nodes);assert.equal(ui.state.board,board);assert.equal(source.nodes[1].elapsed,5);assert.equal(textarea.value,'Texte en cours');assert.match(document.getElementById('node-info').innerHTML,/Temps du coup : 5 s/);
  assert.match(notation,/Temps pris pour ce coup : 5 s/,'The refreshed duration appears without another navigation');assert.equal(renderCount,initialRenderCount+2);assert.equal(list.scrollTop,117);assert.equal(document.activeElement,move);
  await board.go('');await board.go('0');assert.equal(renderCount,initialRenderCount+2,'Cursor navigation still reuses the notation DOM');
 },
 async batch_metadata_stale_summary_and_time_response_cannot_replace_newer_analysis(){
  await open(1);const table=await openTestBase();await ui.navigate('board');ui.state.doc.updated_at='2026-10-20T21:00:00+00:00';ui.state.doc.headers.Event='Modification récente';
  await table.options.onChanged({action:'metadata',entry_ids:[1],source_base_id:7,updated_entries:[{id:1,headers:{Result:'*',Event:'Ancienne réponse'},title:'Ancien',updated_at:'2026-10-20T20:00:00+00:00'}]});assert.equal(ui.state.doc.headers.Event,'Modification récente');
  const source=ui.state.doc;const change=table.options.onChanged({action:'metadata',entry_ids:[1],source_base_id:7,updated_entries:[{id:1,headers:{Result:'*',TimeControl:'300+5'},title:'Partie 1',updated_at:'2026-10-20T22:00:00+00:00'}]});await settle();const respond=pending.get('/api/entries/1');
  await open(2);const newSource=ui.state.doc,newBoard=ui.state.board;respond({...source,nodes:source.nodes.map(n=>({...n,elapsed:999}))});await change;assert.equal(ui.state.doc,newSource);assert.equal(ui.state.board,newBoard);assert.equal(ui.state.doc.id,2);assert.notEqual(ui.state.doc.nodes[1].elapsed,999);
 },
 async batch_metadata_invalidates_pending_open_with_stale_headers(){
  await open(2);const table=await openTestBase(),opening=table.options.onOpenEntry(1);const respond=pending.get('/api/entries/1');
  const changed=table.options.onChanged({action:'metadata',entry_ids:[1],source_base_id:7,updated_entries:[{id:1,headers:{Result:'*',Event:'Open'},title:'Partie 1'}]});await settle();pending.get('/api/bases/7/entries')({entries:[entry(1),entry(2)]});await changed;
  respond(entry(1));assert.equal(await opening,false);assert.equal(ui.state.doc.id,2);assert.equal(ui.state.page,'base');
 },
 async batch_metadata_preserves_paused_review_session(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);const session=reviewSessions.at(-1);
  const opening=session.options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;const snapshot=reviewSuspendCalls[0];
  const table=await openTestBase();const changed=table.options.onChanged({action:'metadata',entry_ids:[9],source_base_id:7,updated_entries:[{id:9,headers:{Result:'*',Event:'Finales pratiques'},title:'Partie 9',updated_at:'2026-10-20T20:00:00+00:00'}]});await settle();pending.get('/api/bases/7/entries')({entries:[entry(9)]});await changed;
  await ui.navigate('board');assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);await ui.action('resume-review');assert.equal(reviewPrepareCalls[0],snapshot);assert.equal(currentReviewSession,session);assert.equal(currentReviewSession.completed,2);assert.equal(currentReviewSession.index,2);
 },

 async entry_table_metadata_ignores_busy_or_moved_source(){
  await open(1);const table=await openTestBase(),editing=table.options.onMetadata(1),dialogsBefore=metadataCallbacks.length;
  table.busy=true;pending.get('/api/entries/1')(entry(1));await editing;assert.equal(metadataCallbacks.length,dialogsBefore,'No stale metadata dialog during a batch');table.busy=false;
  const retry=table.options.onMetadata(1),respond=pending.get('/api/entries/1');
  const moved=table.options.onChanged({action:'move',entry_ids:[1],source_base_id:7,target_base_id:8,count:1});await settle();pending.get('/api/bases/7/entries')({entries:[entry(2)]});await moved;
  respond(entry(1));await retry;assert.equal(metadataCallbacks.length,dialogsBefore,'Metadata loaded before the move must not open afterward');assert.equal(ui.state.doc.base_id,8);
 },

 async entry_table_batch_refresh_preserves_controller_and_inclusion(){
  await open(1);const table=await openTestBase();assert.equal(table.options.entries.length,2);
  const refresh=table.options.onChanged({action:'review',entry_ids:[1,2],source_base_id:7,selected:false,count:2});await settle();
  assert.equal(ui.state.doc.selected,false);pending.get('/api/bases/7/entries')({entries:[{...entry(1),selected:false},{...entry(2),selected:false}]});await refresh;
  assert.equal(entryTables.length,1,'A batch refresh must preserve table filters and sorting');assert.equal(table.disposed,undefined);assert.equal(table.updates.length,1);assert.equal(table.updates[0].entries[0].selected,false);assert.equal(document.getElementById('base-entry-count').textContent,2);
  await ui.navigate('library');assert.equal(table.disposed,true);
 },
 async entry_table_delete_detaches_cached_analysis_without_losing_content(){
  await open(1);ui.state.doc.nodes[1].comment='Analyse conservée';const source=ui.state.doc,table=await openTestBase();
  const removal=table.options.onChanged({action:'delete',entry_ids:[1],source_base_id:7,count:1});await settle();pending.get('/api/bases/7/entries')({entries:[entry(2)]});await removal;
  assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.doc.base_id,undefined);assert.equal(ui.state.doc.history,undefined);assert.deepEqual(ui.state.doc.nodes,source.nodes);assert.equal(ui.state.path,'0');
  await ui.navigate('board');const count=requests.length;ui.action('save-board');assert.equal(requests.length,count,'The deleted ID must never receive a quick-save');assert.match(dialogs.at(-1).title,/Sauvegarder/);assert.equal(ui.state.board.doc.id,undefined);
 },
 async entry_table_late_delete_preserves_visible_annotation_draft(){
  await open(1);const table=await openTestBase();await ui.navigate('board');const previous=ui.state.board;previous.flipped=true;previous.engineOn=true;
  const form=document.getElementById('annotation-form'),textarea=new Element();textarea.value='Texte pendant suppression';form.querySelector=selector=>selector==='[name="comment"]'?textarea:null;form.querySelectorAll=()=>[];
  const sourceRequests=()=>requests.filter(request=>!['/api/training/analysis-time','/api/training/unfinished'].includes(request.url)).length;
  const readCount=sourceRequests();await table.options.onChanged({action:'delete',entry_ids:[1],source_base_id:7,count:1});
  assert.equal(ui.state.page,'board');assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.doc.nodes[1].comment,textarea.value);assert.equal(ui.state.path,'0');assert.equal(previous.disposed,true);assert.equal(ui.state.board.flipped,true);assert.equal(sourceRequests(),readCount,'A disposed table cannot reload its old base; activity timing and badges remain independent');
 },
 async entry_table_move_updates_cached_identity_and_copy_keeps_analysis(){
  await open(1);const table=await openTestBase();await ui.navigate('board');const source=ui.state.doc,board=ui.state.board;
  await table.options.onChanged({action:'duplicate',entry_ids:[9],source_base_id:7,target_base_id:8,count:1});assert.equal(ui.state.doc,source);assert.equal(ui.state.doc.base_id,7);
  await table.options.onChanged({action:'move',entry_ids:[1],source_base_id:7,target_base_id:8,count:1});assert.equal(ui.state.doc,source);assert.equal(ui.state.doc.base_id,8);assert.equal(ui.state.board,board);assert.equal(board.doc.base_id,8);assert.equal(ui.state.path,'0');
  await table.options.onChanged({action:'delete',entry_ids:[1],source_base_id:7,count:1});assert.equal(ui.state.doc.id,1,'A stale operation from another source base cannot detach the moved game');
 },
 async entry_table_late_refresh_does_not_replace_new_page(){
  await open(1);const table=await openTestBase(),refresh=table.options.onChanged({action:'review',entry_ids:[1],source_base_id:7,selected:false,count:1});await settle();const finish=pending.get('/api/bases/7/entries');
  await ui.navigate('board');const board=ui.state.board;finish({entries:[]});await refresh;assert.equal(ui.state.page,'board');assert.equal(ui.state.board,board);assert.equal(table.updates.length,0);assert.equal(board.doc.selected,false);
 },
 async entry_table_metadata_refresh_keeps_same_table_and_handles_refresh_error(){
  await open(1);const table=await openTestBase(),editing=table.options.onMetadata(1);pending.get('/api/entries/1')(entry(1));await editing;
  const saving=metadataCallbacks.at(-1).options.onSaved({...entry(1),title:'Finale intéressante'});await settle();pending.get('/api/bases/7/entries')({entries:[{...entry(1),title:'Finale intéressante'},entry(2)]});await saving;
  assert.equal(entryTables.length,1);assert.equal(table.updates.length,1);assert.equal(ui.state.doc.title,'Finale intéressante');
  const refresh=table.options.onChanged({action:'review',entry_ids:[1],source_base_id:7,selected:false,count:1});await settle();pending.get('/api/bases/7/entries')({__httpError:503,detail:'Liste indisponible'});await refresh;assert.equal(ui.state.doc.selected,false,'The mutation remains successful even if refresh fails');
 },
 async entry_table_delete_invalidates_pending_open_response(){
  await open(2);const table=await openTestBase(),opening=table.options.onOpenEntry(1);const respond=pending.get('/api/entries/1');
  const removed=table.options.onChanged({action:'delete',entry_ids:[1],source_base_id:7,count:1});await settle();pending.get('/api/bases/7/entries')({entries:[entry(2)]});await removed;
  respond(entry(1));assert.equal(await opening,false);assert.equal(ui.state.doc.id,2);assert.equal(ui.state.page,'base');
 },

 async review_return_keeps_annotation_local_before_preparing_session(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);
  const opening=reviewSessions.at(-1).options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;
  const textarea=annotationDraft('Précision saisie avant de reprendre'),source=ui.state.doc,board=ui.state.board;
  globalThis.reviewPrepareImpl=()=>{throw new Error('Révision indisponible');};await assert.rejects(ui.action('resume-review'),/Révision indisponible/);assertNoEntryMutation();assert.equal(reviewPrepareCalls.length,1);assert.equal(ui.state.board,board);assert.equal(ui.state.doc,source);assert.equal(textarea.disabled,false);assert.equal(textarea.value,'Précision saisie avant de reprendre');
  globalThis.reviewPrepareImpl=null;await ui.action('resume-review');assert.equal(reviewPrepareCalls.length,2);assert.equal(reviewResumeCalls.length,1);assert.equal(ui.state.page,'reviews');assert.equal(localDocument(ui.state.doc).nodes[1].comment,textarea.value);assertNoEntryMutation();await ui.navigate('board');assert.equal(ui.state.doc.id,9);assert.equal(localDocument(ui.state.doc).nodes[1].comment,'Précision saisie avant de reprendre');assertNoEntryMutation();
 },
 async review_return_preserves_free_analysis_without_replacement_confirmation(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);
  const opening=reviewSessions.at(-1).options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;
  const board=ui.state.board,unsaved=makeDoc();ui.state.doc=unsaved;board.doc=unsaved;board.flipped=true;board.engineOn=true;board.arrows=2;board.drawings=[{orig:'e2',dest:'e4'}];globalThis.confirm=()=>{throw new Error('No replacement confirmation is needed when preserving both workspaces');};
  assert.equal(await ui.action('resume-review'),true);assert.equal(reviewPrepareCalls.length,1);assert.equal(reviewResumeCalls.length,1);assert.equal(ui.state.doc,unsaved);assert.equal(board.disposed,true);
  await ui.navigate('board');assert.equal(ui.state.doc,unsaved);assert.equal(ui.state.board.doc,unsaved);assert.equal(ui.state.board.flipped,true);assert.equal(ui.state.board.engineOn,true);assert.equal(ui.state.board.arrows,2);assert.deepEqual(ui.state.board.drawings,[{orig:'e2',dest:'e4'}]);assert.equal(ui.state.path,'0');assert.equal(reviewSuspendCalls.at(-1).options.assisted,false);
 },

 async review_return_mount_failure_restores_analysis_and_retry_button(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);
  const opening=reviewSessions.at(-1).options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;
  const source=ui.state.doc;await ui.state.board.go('');globalThis.reviewResumeImpl=()=>{throw new Error('Affichage temporairement impossible');};
  await assert.rejects(ui.action('resume-review'),/Affichage temporairement impossible/);assert.equal(ui.state.page,'board');assert.equal(ui.state.doc,source);assert.equal(ui.state.path,'');assert.equal(ui.state.board.doc,source);assert.equal(ui.state.board.path,'');assert.equal(ui.state.board.disposed,false);assert.equal(ui.state.board.inputLocked,false);assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);
  globalThis.reviewResumeImpl=null;await ui.action('resume-review');assert.equal(reviewPrepareCalls.length,2);assert.equal(reviewPrepareCalls[1],reviewSuspendCalls[0]);assert.equal(reviewResumeCalls.length,2);assert.equal(ui.state.page,'reviews');
 },

 async review_return_retains_session_through_quick_save_and_rerender(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);
  const session=reviewSessions.at(-1),source=entry(9),opening=session.options.onEditEntry({entry_id:9,path:'0',fen:'after'});
  pending.get('/api/entries/9')(source);assert.equal(await opening,true);
  assert.equal(reviewSuspendCalls.length,1);const snapshot=reviewSuspendCalls[0];assert.equal(snapshot.session,session);assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);assert.match(document.getElementById('app').innerHTML,/Retour à la révision/);
  const board=ui.state.board;source.nodes[1].comment='Solution clarifiée';const saving=ui.action('save-board');pending.get('/api/entries/9')(structuredClone(source));await saving;
  assert.equal(reviewSuspendCalls.length,1);assert.equal(ui.state.board,board);assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);
  await ui.navigate('library');await ui.navigate('board');assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);
  const current=ui.state.board,starts=reviewSessions.length,mutations=nonTimingWrites(),savedNodes=structuredClone(ui.state.doc.nodes);
  await ui.action('resume-review');assert.equal(ui.state.page,'reviews');assert.equal(current.disposed,true);assert.equal(reviewPrepareCalls.length,1);assert.equal(reviewPrepareCalls[0],snapshot);assert.equal(reviewResumeCalls.length,1);assert.equal(reviewResumeCalls[0].prepared.snapshot,snapshot);assert.equal(currentReviewSession,session);assert.equal(currentReviewSession.index,2);assert.equal(currentReviewSession.completed,2);assert.equal(reviewSessions.length,starts,'Resuming must never start a new queue or lose already graded cards');assert.deepEqual(nonTimingWrites(),mutations,'Returning to a session does not submit an extra grade or edit its source');assert.deepEqual(ui.state.doc.nodes,savedNodes);assert.equal(ui.state.doc.nodes[1].comment,'Solution clarifiée');
  await ui.navigate('board');assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/,'Leaving the resumed session keeps it available again');assert.equal(reviewSuspendCalls.at(-1).session,session);
 },
 async review_return_preparation_failure_keeps_editor_and_allows_retry(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);
  const opening=reviewSessions.at(-1).options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;
  const source=ui.state.doc,board=ui.state.board,snapshot=reviewSuspendCalls[0];let rejectPreparation;globalThis.reviewPrepareImpl=()=>new Promise((resolve,reject)=>{rejectPreparation=reject;});
  const returning=ui.action('resume-review');await settle();assert.equal(ui.state.page,'board');assert.equal(ui.state.doc,source);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(reviewResumeCalls.length,0,'Preparing a refreshed exercise must keep the analysis mounted');
  rejectPreparation(new Error('La révision est indisponible'));await assert.rejects(returning,/révision est indisponible/);assert.equal(ui.state.page,'board');assert.equal(ui.state.doc,source);assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);
  globalThis.reviewPrepareImpl=null;await ui.action('resume-review');assert.equal(reviewPrepareCalls.length,2);assert.equal(reviewPrepareCalls[1],snapshot);assert.equal(reviewResumeCalls.length,1);assert.equal(ui.state.page,'reviews');
 },
 async review_return_rejects_busy_duplicate_and_stale_attempts(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);
  const opening=reviewSessions.at(-1).options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;
  const board=ui.state.board;board.busy=true;await ui.action('resume-review');board.busy=false;board.inputLocked=true;await ui.action('resume-review');board.inputLocked=false;assert.equal(reviewPrepareCalls.length,0,'Returning is unavailable while a move or edit is pending');
  let finish;globalThis.reviewPrepareImpl=snapshot=>new Promise(resolve=>{finish=()=>resolve({snapshot});});const returning=ui.action('resume-review');await settle();await ui.action('resume-review');assert.equal(reviewPrepareCalls.length,1,'Repeated clicks must not duplicate the preparation');
  await ui.navigate('library');finish();await returning;assert.equal(ui.state.page,'library');assert.equal(reviewResumeCalls.length,0,'A late preparation cannot replace the newly selected page');
  await ui.navigate('board');assert.match(document.getElementById('app').innerHTML,/data-action="resume-review"/);globalThis.reviewPrepareImpl=null;await ui.action('resume-review');assert.equal(reviewPrepareCalls.length,2);assert.equal(reviewResumeCalls.length,1);assert.equal(ui.state.page,'reviews');
 },
 async starting_new_review_invalidates_old_paused_session(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}},{id:8,name:'Autre séance',settings:{}}];await ui.launchReview(7);
  const opening=reviewSessions.at(-1).options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')(entry(9));await opening;
  let finish;globalThis.reviewPrepareImpl=snapshot=>new Promise(resolve=>{finish=()=>resolve({snapshot});});const returning=ui.action('resume-review');await settle();ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}},{id:8,name:'Autre séance',settings:{}}];await ui.launchReview(8);const newest=reviewSessions.at(-1);finish();await returning;
  assert.equal(ui.state.page,'reviews');assert.equal(currentReviewSession,newest);assert.equal(newest.base.id,8);assert.equal(activeReviewBoard.disposed,false);assert.equal(reviewResumeCalls.length,0,'Starting another review invalidates an older pending return');
  await ui.navigate('board');assert.equal(reviewSuspendCalls.at(-1).session,newest);globalThis.reviewPrepareImpl=null;const count=reviewPrepareCalls.length;await ui.action('resume-review');assert.equal(reviewPrepareCalls.length,count+1);assert.equal(currentReviewSession,newest);
 },

 async save_controls_recover_after_move_without_extra_toolbar_refresh(){
  await open(1);ui.state.library.bases=[{id:7,name:'Exercices',settings:{}}];const board=ui.state.board,source=ui.state.doc;
  board.busy=true;board.onChange(board);
  const count=requests.length,metadataCount=metadataCallbacks.length,dialogCount=dialogs.length;
  await ui.action('save-board');await ui.action('save-as');await ui.action('metadata');
  assert.equal(requests.length,count);assert.equal(metadataCallbacks.length,metadataCount);assert.equal(dialogs.length,dialogCount,'Handlers still reject edits while a board move is pending');
  board.busy=false;
  assert.equal(controls.get('save-board').disabled,false,'Completing the move must leave quick save usable without another render');assert.equal(controls.get('save-as').disabled,false);
  board.inputLocked=true;await ui.action('metadata');board.inputLocked=false;assert.equal(metadataCallbacks.length,metadataCount);
  const save=ui.action('save-board');assert.equal(requests.at(-1).method,'PATCH');assert.equal(controls.get('save-board').disabled,true);assert.equal(controls.get('save-as').disabled,true);
  pending.get('/api/entries/1')(structuredClone(source));await save;
  assert.equal(controls.get('save-board').disabled,false);assert.equal(controls.get('save-as').disabled,false);assert.equal(ui.state.board,board);
  await ui.action('metadata');assert.equal(metadataCallbacks.length,metadataCount+1,'Editing becomes available again after the operation');
 },

 async review_edit_opens_complete_source_with_variations(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{review_enabled:true}}];await ui.launchReview(7);
  const options=reviewSessions.at(-1).options,review=activeReviewBoard;
  assert.equal(typeof options.onEditEntry,'function');assert.equal(options.onPosition,undefined);
  const source=entry(9);source.headers={White:'Auteur',Black:'Défenseur',Result:'*'};source.nodes[1].children=['0.0','0.1'];source.nodes.push({path:'0.0',parent:'0',fen:'suite',san:'e5',children:[],comment:'Solution commentée',nags:[1]},{path:'0.1',parent:'0',fen:'variante',san:'c5',children:[],comment:'Variante importante',nags:[5]});
  const task=options.onEditEntry({entry_id:9,path:'0',fen:'after'});await settle();assert.equal(requests.at(-1).url,'/api/entries/9');assert.equal(requests.at(-1).method,'GET');pending.get('/api/entries/9')(source);assert.equal(await task,true);
  assert.equal(ui.state.page,'board');assert.equal(ui.state.doc,source);assert.equal(ui.state.doc.id,9);assert.equal(ui.state.doc.base_id,7);assert.equal(ui.state.path,'0');assert.equal(ui.state.board.path,'0');assert.equal(ui.state.board.doc.nodes.length,4);assert.equal(ui.state.board.doc.nodes[3].comment,'Variante importante');assert.equal(review.disposed,true);
  assert.match(document.getElementById('move-list').innerHTML,/e5/);assert.match(document.getElementById('move-list').innerHTML,/c5/);assert.deepEqual(nonTimingWrites(),[],'Opening an exercise never submits a grade or changes its source');assertNoEntryMutation();
 },
 async review_edit_resolves_changed_path_without_losing_source(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];
  for(const [fen,expected] of [['moved-position','1'],['position-removed','0']]){
   await ui.launchReview(7);const source=entry(9);source.nodes[0].children.push('1');source.nodes.push({path:'1',parent:'',fen:'moved-position',san:'d4',children:[],comment:'Autre ligne',nags:[]});
   const task=reviewSessions.at(-1).options.onEditEntry({entry_id:9,path:'missing',fen});pending.get('/api/entries/9')(source);assert.equal(await task,true);
   assert.equal(ui.state.doc,source);assert.equal(ui.state.path,expected);assert.equal(ui.state.board.path,expected);assert.equal(ui.state.doc.nodes.length,3);
  }
 },
 async review_edit_declined_failed_or_stale_keeps_active_document(){
  await open(1);ui.state.library.bases=[{id:7,name:'Mes exercices',settings:{}}];await ui.launchReview(7);
  const source=ui.state.doc,review=activeReviewBoard,options=reviewSessions.at(-1).options;ui.state.doc=makeDoc();const unsaved=ui.state.doc;globalThis.confirm=()=>false;const count=requests.length;
  assert.equal(await options.onEditEntry({entry_id:9,path:'0',fen:'after'}),false);assert.equal(requests.length,count);assert.equal(ui.state.doc,unsaved);assert.equal(activeReviewBoard,review);assert.equal(review.disposed,false);globalThis.confirm=()=>true;ui.state.doc=source;
  await assert.rejects(options.onEditEntry({entry_id:0,path:'0',fen:'after'}),/introuvable/);assert.equal(ui.state.doc,source);
  const failed=options.onEditEntry({entry_id:9,path:'0',fen:'after'});pending.get('/api/entries/9')({__httpError:404,detail:'Partie supprimée'});await assert.rejects(failed,/Partie supprimée/);assert.equal(ui.state.doc,source);assert.equal(activeReviewBoard,review);assert.equal(review.disposed,false);
  const stale=options.onEditEntry({entry_id:9,path:'0',fen:'after'});await ui.navigate('library');pending.get('/api/entries/9')(entry(9));assert.equal(await stale,false);assert.equal(ui.state.page,'library');assert.equal(ui.state.doc,source);assert.equal(reviewSuspendCalls.length,1,'Only the explicit library navigation pauses the review');assert.equal(reviewSuspendCalls[0].options.assisted,false);
 },
 async quick_save_keeps_identity_full_tree_and_exercise_start(){
  await open(1);const board=ui.state.board,source=ui.state.doc;source.nodes[1].children=['0.0','0.1'];source.nodes.push({path:'0.0',parent:'0',fen:'after-e5',san:'e5',children:[],comment:'Suite principale',nags:[1]},{path:'0.1',parent:'0',fen:'after-c5',san:'c5',children:[],comment:'Variante à conserver',nags:[5]});await board.go('0.1');board.engineOn=true;const panels=analysisPanels.length,charts=chartPanels.length;
  const task=ui.action('save-board'),request=requests.at(-1);assert.equal(request.method,'PATCH');assert.equal(request.url,'/api/entries/1');assert.equal(request.body.title,'Partie 1');assert.equal(request.body.start_path,'0');assert.equal(request.body.view_path,'0.1');assert.deepEqual(JSON.parse(request.body.pgn).nodes,source.nodes);assert.equal(dialogs.length,0);assert.equal(board.inputLocked,true);
  const count=requests.length;await ui.action('save-board');assert.equal(requests.length,count,'Repeated clicks cannot submit duplicate saves');
  pending.get('/api/entries/1')({...structuredClone(source),history:{can_undo:true,can_redo:false}});await task;
  assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(board.path,'0.1');assert.equal(ui.state.path,'0.1');assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.base_id,7);assert.equal(ui.state.doc.start_path,'0');assert.equal(ui.state.doc.nodes.length,4);assert.equal(board.engineOn,true);assert.equal(board.inputLocked,false);assert.equal(analysisPanels.length,panels);assert.equal(chartPanels.length,charts);
 },
 async live_evaluation_persists_draft_reopens_and_saves_without_report(){
  await open(1);const board=ui.state.board,source=ui.state.doc;board.storedEvaluation=()=>null;source.nodes[1].comment='Existing idea [%clk 0:09:42]';source.nodes[1].nags=[1,250];
  const typed='My annotation still being edited',textarea=annotationDraft(typed);assert.equal(typeof board.onEvaluation,'function');assert.equal(board.lastReport,undefined,'no full-game analysis was loaded');
  board.onEvaluation(board,{path:'0',fen:'after',line:{cp:55,depth:16}});
  assert.equal(ui.state.doc,source,'automatic analysis keeps the editor document identity stable');assert.equal(board.doc,source);assert.equal(source.analysis_dirty,true);assert.match(source.nodes[1].comment,/\[%eval 0[.]55,16\]/);assert.match(source.nodes[1].comment,/\[%clk 0:09:42\]/);assert.equal(textarea.value,typed,'the active annotation field is not replaced');
  const local=localDocument(source);assert.match(local.nodes[1].comment,/My annotation still being edited/);assert.match(local.nodes[1].comment,/\[%eval 0[.]55,16\]/);assert.ok(local.nodes[1].nags.includes(250),'unknown annotation symbols are preserved');
  const retained=ui.workspace.get('document:entry:1');assert.equal(retained.doc.analysis_dirty,true);assert.match(retained.doc.nodes[1].comment,/\[%eval 0[.]55,16\]/);assert.match(retained.doc.pgn,/\[%eval 0[.]55,16\]/);assert.match(ui.freeHistory.current.doc.nodes[1].comment,/\[%eval 0[.]55,16\]/);assertNoEntryMutation();
  await open(2);annotationDraft('');await open(1);const reopened=ui.state.board;reopened.storedEvaluation=()=>null;assert.equal(reopened.doc.analysis_dirty,true);assert.match(reopened.node().comment,/\[%eval 0[.]55,16\]/);assert.match(document.getElementById('annotation-editor').innerHTML,/My annotation still being edited/);
  annotationDraft(typed);const saving=ui.action('save-board'),request=requests.at(-1),snapshot=JSON.parse(request.body.pgn);assert.equal(request.method,'PATCH');assert.equal(request.url,'/api/entries/1');assert.equal(request.body.explicit_save,true);assert.match(snapshot.nodes[1].comment,/My annotation still being edited/);assert.match(snapshot.nodes[1].comment,/\[%eval 0[.]55,16\]/);assert.match(snapshot.nodes[1].comment,/\[%clk 0:09:42\]/);
  const duringSave=JSON.stringify(reopened.doc);assert.equal(reopened.inputLocked,true);reopened.onEvaluation(reopened,{path:'0',fen:'after',line:{cp:90,depth:22}});assert.equal(JSON.stringify(reopened.doc),duringSave,'an engine callback cannot modify the snapshot while saving');
  pending.get('/api/entries/1')({...snapshot,pgn:request.body.pgn});await saving;assert.equal(ui.state.doc.analysis_dirty,false);assert.match(ui.state.doc.nodes[1].comment,/\[%eval 0[.]55,16\]/);assert.equal(ui.drafts.has(ui.state.doc),false);
 },
 async live_evaluation_save_as_keeps_scores_received_during_post(){
  await open(1);ui.state.library.bases=[{id:7,name:'Exercices',settings:{}}];const board=ui.state.board,source=ui.state.doc;board.storedEvaluation=()=>null;
  board.onEvaluation(board,{path:'0',fen:'after',line:{cp:20,depth:12}});annotationDraft('Annotation included in the copy');await ui.action('save-as');const dialog=dialogs.at(-1);
  const saving=dialog.options.onSubmit(new Map([['base_id','7'],['title','Copy with continued analysis']])),request=requests.at(-1),snapshot=JSON.parse(request.body.pgn);assert.match(snapshot.nodes[1].comment,/\[%eval 0[.]20,12\]/);
  board.onEvaluation(board,{path:'0',fen:'after',line:{cp:85,depth:23}});assert.match(source.nodes[1].comment,/\[%eval 0[.]85,23\]/);assert.match(JSON.parse(request.body.pgn).nodes[1].comment,/\[%eval 0[.]20,12\]/,'the already submitted request remains its original snapshot');
  pending.get('/api/entries')({...snapshot,id:99,title:'Copy with continued analysis',revision:'copy-revision',pgn:request.body.pgn});await saving;
  assert.equal(ui.state.doc.id,99);assert.equal(ui.state.doc.revision,'copy-revision');assert.equal(ui.state.doc.analysis_dirty,true,'deeper analysis received during POST remains a draft above the saved revision');assert.match(ui.state.doc.nodes[1].comment,/\[%eval 0[.]85,23\]/);assert.match(ui.state.doc.nodes[1].comment,/Annotation included in the copy/);assert.match(ui.state.doc.pgn,/\[%eval 0[.]85,23\]/);
  const retained=ui.workspace.get('document:entry:99');assert.equal(retained.doc.analysis_dirty,true);assert.equal(retained.doc.revision,'copy-revision');assert.match(retained.doc.nodes[1].comment,/\[%eval 0[.]85,23\]/);assert.equal(source.id,1);
 },
 async live_evaluation_quick_save_keeps_deferred_score_received_during_patch(){
  await open(1);const board=ui.state.board;board.storedEvaluation=()=>null;board.onEvaluation(board,{path:'0',fen:'after',line:{cp:20,depth:12}});annotationDraft('Saved annotation');
  const saving=ui.action('save-board'),request=requests.at(-1),snapshot=JSON.parse(request.body.pgn);assert.equal(board.inputLocked,true);assert.match(snapshot.nodes[1].comment,/\[%eval 0[.]20,12\]/);
  const pendingEvaluation={path:'0',fen:'after',seq:7,type:'done',result:{lines:[{cp:90,depth:24}]}};board.deferredEngineResult=pendingEvaluation;board.engineUpdateIsCurrent=update=>update===pendingEvaluation;
  pending.get('/api/entries/1')({...snapshot,revision:'saved-revision',pgn:request.body.pgn});await saving;
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.revision,'saved-revision');assert.equal(ui.state.doc.analysis_dirty,true);assert.match(ui.state.doc.nodes[1].comment,/\[%eval 0[.]90,24\]/);assert.match(ui.state.doc.nodes[1].comment,/Saved annotation/);assert.match(ui.state.doc.pgn,/\[%eval 0[.]90,24\]/);assert.equal(pendingEvaluation.evaluationRecorded,true,'the deferred score is consumed before replacing the board document');assert.equal(board.inputLocked,false);
  const retained=ui.workspace.get('document:entry:1');assert.equal(retained.doc.revision,'saved-revision');assert.equal(retained.doc.analysis_dirty,true);assert.match(retained.doc.nodes[1].comment,/\[%eval 0[.]90,24\]/);assert.match(JSON.parse(request.body.pgn).nodes[1].comment,/\[%eval 0[.]20,12\]/);
 },
 async live_evaluation_quick_save_ignores_stale_deferred_score(){
  await open(1);const board=ui.state.board;board.storedEvaluation=()=>null;board.onEvaluation(board,{path:'0',fen:'after',line:{cp:20,depth:12}});
  const saving=ui.action('save-board'),request=requests.at(-1),snapshot=JSON.parse(request.body.pgn),stale={path:'0',fen:'after',seq:1,type:'done',result:{lines:[{cp:990,depth:30}]}};board.deferredEngineResult=stale;board.engineUpdateIsCurrent=()=>false;
  pending.get('/api/entries/1')({...snapshot,revision:'saved-revision',pgn:request.body.pgn});await saving;
  assert.equal(ui.state.doc.analysis_dirty,false);assert.match(ui.state.doc.nodes[1].comment,/\[%eval 0[.]20,12\]/);assert.doesNotMatch(ui.state.doc.nodes[1].comment,/\[%eval 9[.]90,30\]/);assert.notEqual(stale.evaluationRecorded,true,'a stale response cannot be accepted solely because its path and FEN match');
 },
 async live_evaluation_save_as_includes_progress_after_dialog_open(){
  await open(1);ui.state.library.bases=[{id:7,name:'Exercices',settings:{}}];const board=ui.state.board,source=ui.state.doc;board.storedEvaluation=()=>null;
  board.onEvaluation(board,{path:'0',fen:'after',line:{cp:20,depth:12}});await ui.action('save-as');const dialog=dialogs.at(-1);assert.match(dialog.title,/Enregistrer sous/);assertNoEntryMutation();
  annotationDraft('Latest annotation after opening the dialog');board.onEvaluation(board,{path:'0',fen:'after',line:{cp:75,depth:20}});assert.equal(ui.state.doc,source,'the saved dialog still targets this document');assert.match(source.nodes[1].comment,/\[%eval 0[.]75,20\]/);
  const saving=dialog.options.onSubmit(new Map([['base_id','7'],['title','Copy with latest evaluation']])),request=requests.at(-1),snapshot=JSON.parse(request.body.pgn);assert.equal(request.method,'POST');assert.equal(request.url,'/api/entries');assert.match(snapshot.nodes[1].comment,/\[%eval 0[.]75,20\]/);assert.doesNotMatch(snapshot.nodes[1].comment,/\[%eval 0[.]20,12\]/);assert.match(snapshot.nodes[1].comment,/Latest annotation after opening the dialog/);
  pending.get('/api/entries')({...snapshot,id:99,title:'Copy with latest evaluation',pgn:request.body.pgn});await saving;assert.equal(ui.state.doc.id,99);assert.equal(source.id,1);assert.match(ui.state.doc.nodes[1].comment,/\[%eval 0[.]75,20\]/);assert.match(ui.state.doc.nodes[1].comment,/Latest annotation after opening the dialog/);
 },
 async quick_save_includes_annotation_draft_and_preserves_pgn_directives(){
  await open(1);const board=ui.state.board,source=ui.state.doc,node=source.nodes[1];node.comment='Ancienne explication [%eval 0.4] [%clk 0:14:22]';node.nags=[1,250];source.pgn='cached PGN before edits';
  const form=document.getElementById('annotation-form'),textarea=new Element(),nag=new Element(),disabledButton=new Element();textarea.value='Mon explication révisée';nag.value='3';disabledButton.disabled=true;
  form.querySelector=selector=>selector==='[name="comment"]'?textarea:null;form.querySelectorAll=selector=>selector==='input[name="nag"]:checked'?[nag]:selector==='textarea,input,button'?[textarea,nag,disabledButton]:[];
  const before=structuredClone(source),task=ui.action('save-board'),body=requests.at(-1).body,snapshot=JSON.parse(body.pgn);
  assert.match(snapshot.nodes[1].comment,/Mon explication révisée/);assert.match(snapshot.nodes[1].comment,/\[%eval 0\.4\]/);assert.match(snapshot.nodes[1].comment,/\[%clk 0:14:22\]/);assert.deepEqual(snapshot.nodes[1].nags,[3,250]);assert.deepEqual(source,before,'A pending save must not discard the existing document or mutate its draft');assert.equal(textarea.disabled,true);assert.equal(nag.disabled,true);assert.equal(disabledButton.disabled,true);
  snapshot.pgn=body.pgn;pending.get('/api/entries/1')(snapshot);await task;
  assert.equal(ui.state.board,board);assert.equal(ui.state.doc.nodes[1].comment,snapshot.nodes[1].comment);assert.equal(ui.state.doc.id,1);assert.equal(ui.state.path,'0');assert.equal(textarea.disabled,false);assert.equal(nag.disabled,false);assert.equal(disabledButton.disabled,true);
 },
 async quick_save_failure_and_late_response_preserve_active_analysis(){
  await open(1);const source=ui.state.doc,board=ui.state.board;source.nodes[1].comment='Notes conservées en cas de panne';
  const failed=ui.action('save-board');pending.get('/api/entries/1')({__httpError:503,detail:'Sauvegarde indisponible'});await assert.rejects(failed,/Sauvegarde indisponible/);assert.equal(ui.state.doc,source);assert.equal(ui.state.board,board);assert.equal(board.inputLocked,false);assert.equal(board.disposed,false);
  const count=requests.length;board.busy=true;await ui.action('save-board');board.busy=false;board.inputLocked=true;await ui.action('save-board');board.inputLocked=false;assert.equal(requests.length,count);
  const late=ui.action('save-board'),finish=pending.get('/api/entries/1');await open(2);const current=ui.state.doc,currentBoard=ui.state.board;finish({...entry(1),title:'Ancienne réponse'});await late;assert.equal(ui.state.doc,current);assert.equal(ui.state.board,currentBoard);assert.equal(ui.state.doc.id,2);assert.equal(currentBoard.disposed,false);assert.equal(currentBoard.inputLocked,false);assert.equal(controls.get('undo').disabled,true);
 },
 async save_as_creates_copy_and_unsaved_save_requests_destination(){
  await open(1);ui.state.library.bases=[{id:7,name:'Exercices',settings:{}}];const original=ui.state.doc;await ui.state.board.go('');const count=requests.length;
  await ui.action('save-as');assert.equal(requests.length,count);const copy=dialogs.at(-1);assert.match(copy.title,/Enregistrer sous/);assert.match(copy.html,/nouvelle copie/);assert.doesNotMatch(copy.html,/name="copy"/);assert.equal(ui.state.doc,original);
  const task=copy.options.onSubmit(new Map([['base_id','7'],['title','Copie de travail']]));const request=requests.at(-1);assert.equal(request.method,'POST');assert.equal(request.url,'/api/entries');assert.equal(request.body.base_id,7);assert.equal(request.body.title,'Copie de travail');assert.equal(request.body.explicit_save,true);assert.equal(request.body.start_path,'0','Copying a saved exercise retains its start, rather than the browsed position');assert.deepEqual(JSON.parse(request.body.pgn).nodes,original.nodes);
  pending.get('/api/entries')({...structuredClone(original),id:99,title:'Copie de travail'});await task;assert.equal(ui.state.doc.id,99);assert.equal(original.id,1);assert.equal(ui.state.path,'');
  ui.state.library.bases=[{id:7,name:'Exercices',settings:{}}];const free=makeDoc();ui.state.doc=free;ui.state.board.doc=free;ui.state.path='0';ui.state.board.path='0';const requestsBefore=requests.length;await ui.action('save-board');const save=dialogs.at(-1);assert.match(save.title,/Sauvegarder la partie/);assert.equal(requests.length,requestsBefore);assert.equal(ui.state.doc,free);
 },
 async save_dialog_stale_submit_cannot_save_another_document(){
  await open(1);ui.state.library.bases=[{id:7,name:'Exercices',settings:{}}];await ui.action('save-as');const dialog=dialogs.at(-1);await open(2);const count=requests.length;await assert.rejects(dialog.options.onSubmit(new Map([['base_id','7'],['title','Copie dépassée']])),/partie ouverte a changé/);assert.equal(requests.length,count);assert.equal(ui.state.doc.id,2);
 },

 async exercise_editor_preserves_saved_and_unsaved_analysis(){
  await open(1);ui.state.library.bases=[{id:2,name:'Exercices',settings:{review_enabled:true,type:'solve'}}];
  for(const saved of [true,false]){
   if(!saved){ui.state.doc=makeDoc();ui.state.doc.nodes[0].comment='Mes idées';ui.state.board.doc=ui.state.doc;}
   const board=ui.state.board,doc=ui.state.doc,before=structuredClone(doc),path=ui.state.path;
   const annotation=document.getElementById('annotation-editor');annotation.innerHTML='Commentaire non enregistré';
   await ui.action('make-exercise');const editor=exerciseEditors.at(-1);
   assert.equal(editor.sourceDoc,doc);assert.equal(editor.sourcePath,path);assert.equal(editor.flipped,board.flipped);
   await editor.onCreated({entry:{id:99},baseId:2});
   assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(ui.state.doc,doc);assert.deepEqual(doc,before);assert.equal(ui.state.path,path);assert.equal(annotation.innerHTML,'Commentaire non enregistré');
  }
  const count=exerciseEditors.length;ui.state.board.busy=true;await ui.action('make-exercise');ui.state.board.busy=false;ui.state.board.inputLocked=true;await ui.action('make-exercise');ui.state.board.inputLocked=false;assert.equal(exerciseEditors.length,count);
 },
 async navigation_preserves_analysis_across_all_main_pages(){
  const appHost=document.getElementById('app');let html='',navigation=[];
  Object.defineProperty(appHost,'innerHTML',{configurable:true,get(){return html;},set(value){html=value;navigation=[...value.matchAll(/<button\b([^>]*\bdata-page="([^"]+)"[^>]*)>/g)].map(match=>{const button=new Element();button.dataset.page=match[2];const active=match[1].match(/aria-current="([^"]+)"/)?.[1];if(active)button.setAttribute('aria-current',active);return button;});}});
  const queryAll=document.querySelectorAll;document.querySelectorAll=selector=>selector==='[data-page]'?navigation:queryAll(selector);
  async function clickPage(page){
   if(page==='board'){assert.match(html,/data-board-command="current"/);await ui.boardMenuAction('current');assert.equal(ui.state.page,'board');return;}
   const link=navigation.find(button=>button.dataset.page===page);assert.ok(link,'Navigation disponible vers '+page);assert.equal(typeof link.onclick,'function');
   const task=link.onclick();await settle();
   if(page==='played')pending.get('/api/entries?played=true')({entries:[]});
   if(page==='reviews'||page==='repertoire')pending.get('/api/reviews')({bases:[]});
   await task;assert.equal(ui.state.page,page);
  }
  await open(42);const source=ui.state.doc;assert.equal(ui.state.path,'0');
  for(const page of ['library','played','repertoire','reviews','settings']){
   const previousBoard=ui.state.board,previousChart=chartPanels.at(-1),previousAnalysis=analysisPanels.at(-1),panelsBefore=chartPanels.length;
   await clickPage(page);
   assert.equal(previousBoard.disposed,true);assert.equal(previousChart.disposed,true);assert.equal(previousAnalysis.disposed,true);assert.equal(ui.state.board,null);
   assert.equal(ui.state.doc,source);assert.equal(ui.state.path,'0');
   await clickPage('board');
   assert.equal(ui.state.doc,source);assert.equal(ui.state.path,'0');assert.equal(ui.state.board.path,'0');assert.equal(ui.state.board.doc,source);
   assert.notEqual(ui.state.board,previousBoard);assert.equal(ui.state.board.disposed,false);assert.equal(chartPanels.length,panelsBefore+1);
   assert.match(html,/<details class="navigation-group board-navigation"[^>]*data-board-menu[^>]*data-active="true"/);assert.match(html,/data-board-command="current"/);
  }
 },
 async report_refresh_keeps_context_menu_anchor(){
  await open(1);const list=document.getElementById('move-list'),anchor=new Element();anchor.dataset.path='0';anchor.isConnected=true;
  list.querySelectorAll=()=>[anchor];ui.moveMenu.menu={remove(){}};ui.moveMenu.anchor=new Element();ui.moveMenu.selectedPath='0';
  analysisPanels.at(-1).options.onReport({status:'done',positions:[{path:'0',fen:'after',cp:20}],findings:[]});
  assert.equal(ui.moveMenu.anchor,anchor);assert.equal(anchor.getAttribute('aria-expanded'),'true');ui.moveMenu.close(true);assert.equal(document.activeElement,anchor);assert.equal(anchor.getAttribute('aria-expanded'),'false');
 },
 async report_refresh_preserves_annotation_and_ignores_previous_game(){
  await open(1);const panel=analysisPanels.at(-1),chart=chartPanels.at(-1),editor=document.getElementById('annotation-editor'),list=document.getElementById('move-list');
  assert.equal(ui.state.board.engineHost,document.getElementById('analysis-engine'));
  editor.innerHTML='Brouillon personnel en cours';list.scrollTop=173;
  panel.options.onReport({status:'done',positions:[{path:'0',fen:'after',cp:42,depth:18}],findings:[]});
  assert.equal(ui.state.board.lastReport.positions[0].cp,42);assert.match(list.innerHTML,/\+0[,.]42/);assert.equal(editor.innerHTML,'Brouillon personnel en cours');assert.equal(list.scrollTop,173);assert.equal(chart.reports.length,1);
  await open(2);const nextChart=chartPanels.at(-1),nextHtml=list.innerHTML;panel.options.onReport({status:'done',positions:[{path:'0',fen:'after',cp:900}],findings:[]});assert.equal(chart.reports.length,1);assert.equal(nextChart.reports.length,0);assert.equal(list.innerHTML,nextHtml);
  analysisPanels.at(-1).options.onReport(null);assert.doesNotMatch(list.innerHTML,/\+0[,.]42/);
 },
 async variation_selection_preserves_analysis_and_annotation_draft(){
  await open(1);const board=ui.state.board,doc=board.doc,panel=analysisPanels.at(-1),chart=chartPanels.at(-1);
  const current=doc.nodes.find(node=>node.path==='0');
  current.children=['0.0','0.1'];
  doc.nodes.push({path:'0.0',parent:'0',fen:'after-e5',san:'e5',children:[],comment:'Continuation principale',nags:[]},{path:'0.1',parent:'0',fen:'after-c5',san:'c5',children:[],comment:'Autre défense',nags:[]});
  const candidate=doc.nodes.find(node=>node.path==='0.1'),original=JSON.stringify(doc);
  const list=document.getElementById('move-list'),editor=document.getElementById('annotation-editor'),engine=document.getElementById('analysis-engine');
  const initialReport={status:'done',positions:[{path:'0',fen:'after',cp:42}],findings:[]};
  panel.options.onReport(initialReport);
  editor.innerHTML='Brouillon personnel non enregistré';engine.innerHTML='Analyse Stockfish en cours';board.engineOn=true;list.scrollTop=173;
  board.selectedVariation=()=>candidate;
  assert.equal(typeof board.onVariationChange,'function');board.onVariationChange(board);
  const button=html=>[...html.matchAll(/<button\b([^>]*)>/g)].find(match=>/\bdata-path="0\.1"/.test(match[1]))?.[1];
  assert.match(button(list.innerHTML),/\bvariation-choice\b/);assert.doesNotMatch(button(list.innerHTML),/\baria-current\b/);
  assert.match(list.innerHTML,/\bdata-path="0"[^>]*aria-current="true"/);
  assert.equal(board.path,'0');assert.equal(ui.state.path,'0');assert.equal(board.doc,doc);assert.equal(ui.state.doc,doc);assert.equal(JSON.stringify(doc),original);
  assert.equal(editor.innerHTML,'Brouillon personnel non enregistré');assert.equal(engine.innerHTML,'Analyse Stockfish en cours');assert.equal(board.engineOn,true);
  assert.equal(board.lastReport,initialReport);assert.equal(chart.reports.length,1);
  list.scrollTop=247;
  panel.options.onReport({status:'done',positions:[{path:'0.1',fen:'after-c5',cp:21}],findings:[]});
  assert.match(button(list.innerHTML),/\bvariation-choice\b/);assert.doesNotMatch(button(list.innerHTML),/\baria-current\b/);assert.match(list.innerHTML,/\+0[,.]21/);
  assert.equal(list.scrollTop,247);assert.equal(board.selectedVariation(),candidate);assert.equal(board.path,'0');assert.equal(JSON.stringify(doc),original);
  assert.equal(editor.innerHTML,'Brouillon personnel non enregistré');assert.equal(engine.innerHTML,'Analyse Stockfish en cours');assert.equal(chart.reports.length,2);
 },
 async reading_controls_preserve_analysis_history_and_annotation_draft(){
  for(const saved of [true,false]){
   await open(1);
   if(!saved){
    const doc=makeDoc();ui.freeHistory.reset(doc,'0');
    doc.nodes[1].comment='Première annotation';ui.freeHistory.record(doc,'0');
    doc.nodes[1].comment='Annotation suivante';ui.freeHistory.record(doc,'0');
    const previous=ui.freeHistory.take('undo');ui.state.doc=previous.doc;ui.state.board.doc=previous.doc;ui.state.path=previous.path;ui.state.board.path=previous.path;
    assert.deepEqual(ui.freeHistory.flags(),{can_undo:true,can_redo:true});
   }
   const board=ui.state.board,doc=ui.state.doc,source=JSON.stringify(doc),history=JSON.stringify(ui.freeHistory),path=ui.state.path;
   const editor=document.getElementById('annotation-editor'),engine=document.getElementById('analysis-engine'),list=document.getElementById('move-list');
   const explorer=explorerPanels.at(-1),panel=analysisPanels.at(-1),chart=chartPanels.at(-1),panelCount=analysisPanels.length,chartCount=chartPanels.length,requests=pending.size;
   editor.innerHTML='Commentaire non enregistré';engine.innerHTML='Variantes Stockfish en cours';board.engineOn=true;list.scrollTop=211;
   const unchanged=()=>{
    assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(ui.state.doc,doc);assert.equal(board.doc,doc);
    assert.equal(ui.state.path,path);assert.equal(board.path,path);assert.equal(JSON.stringify(doc),source);assert.equal(JSON.stringify(ui.freeHistory),history);
    assert.equal(editor.innerHTML,'Commentaire non enregistré');assert.equal(engine.innerHTML,'Variantes Stockfish en cours');assert.equal(board.engineOn,true);assert.equal(list.scrollTop,211);
    assert.equal(explorerPanels.at(-1),explorer);assert.equal(analysisPanels.at(-1),panel);assert.equal(chartPanels.at(-1),chart);assert.equal(analysisPanels.length,panelCount);assert.equal(chartPanels.length,chartCount);assert.equal(pending.size,requests);
   };
   assert.equal(explorer.visible,true);
   clickReading('tools');assert.equal(workbench.classList.contains('analysis-tools-collapsed'),true);assert.equal(explorer.visible,false);unchanged();
   clickReading('board');assert.equal(workbench.classList.contains('analysis-board-reduced'),true);assert.equal(explorer.visible,false);unchanged();
   clickReading('font-more');assert.equal(workbench.style.getPropertyValue('--analysis-comment-size'),'14px');assert.equal(document.documentElement.style.getPropertyValue('--analysis-comment-size'),'14px');unchanged();
   clickReading('tools');assert.equal(workbench.classList.contains('analysis-tools-collapsed'),false);assert.equal(explorer.visible,true);unchanged();
   clickReading('reset');assert.equal(workbench.classList.contains('analysis-board-reduced'),false);assert.equal(workbench.style.getPropertyValue('--analysis-comment-size'),'13px');unchanged();
  }
 },
 async selecting_bilan_reopens_collapsed_tools_without_recreating_analysis(){
  tabItems=['explorer','bilan','repertoire'].map(id=>{const el=new Element();el.dataset.analysisTool=id;el.setAttribute('role','tab');return el;});
  tabPanels=tabItems.map(tab=>document.getElementById('analysis-tool-'+tab.dataset.analysisTool));
  await open(1);const board=ui.state.board,doc=ui.state.doc,editor=document.getElementById('annotation-editor'),explorer=explorerPanels.at(-1),panel=analysisPanels.at(-1);
  editor.innerHTML='Note personnelle à conserver';const source=JSON.stringify(doc),history=JSON.stringify(ui.freeHistory);
  clickReading('tools');assert.equal(explorer.visible,false);assert.equal(workbench.classList.contains('analysis-tools-collapsed'),true);
  tabItems[1].onclick();
  assert.equal(ui.state.analysisTool,'bilan');assert.equal(workbench.classList.contains('analysis-tools-collapsed'),false);assert.equal(readingActions.get('tools').getAttribute('aria-pressed'),'false');
  assert.equal(tabPanels[1].hidden,false);assert.equal(tabPanels[0].hidden,true);assert.equal(explorer.visible,false);
  tabItems[0].onclick();assert.equal(explorer.visible,true);assert.equal(tabPanels[0].hidden,false);
  assert.equal(ui.state.board,board);assert.equal(board.disposed,false);assert.equal(ui.state.doc,doc);assert.equal(JSON.stringify(doc),source);assert.equal(JSON.stringify(ui.freeHistory),history);
  assert.equal(editor.innerHTML,'Note personnelle à conserver');assert.equal(analysisPanels.at(-1),panel);
 },
 async reading_preferences_restore_and_old_controls_disconnect(){
  await open(1);const oldListener=readingHost.handlers.get('click');
  clickReading('tools');clickReading('board');clickReading('font-more');
  const display=JSON.parse(localStorage.getItem('chessgym.reading'));
  assert.deepEqual({toolsCollapsed:display.toolsCollapsed,boardReduced:display.boardReduced,fontSize:display.fontSize},{toolsCollapsed:true,boardReduced:true,fontSize:14});
  assert.equal(display.preset,'analysis');assert.deepEqual(display.profiles.analysis,{toolsCollapsed:true,boardReduced:true,fontSize:14,evaluationMode:'loss',timeMode:'elapsed',highlightEvaluation:true,highlightTime:true});
  await open(2);const board=ui.state.board,doc=ui.state.doc;
  assert.equal(workbench.classList.contains('analysis-tools-collapsed'),true);assert.equal(workbench.classList.contains('analysis-board-reduced'),true);assert.equal(workbench.style.getPropertyValue('--analysis-comment-size'),'14px');
  assert.equal(explorerPanels.at(-1).visible,false);assert.notEqual(readingHost.handlers.get('click'),oldListener);
  oldListener({target:readingActions.get('reset')});
  assert.equal(workbench.classList.contains('analysis-tools-collapsed'),true);assert.equal(workbench.style.getPropertyValue('--analysis-comment-size'),'14px','a stale control cannot change the new workspace');
  clickReading('reset');assert.equal(explorerPanels.at(-1).visible,true);assert.equal(workbench.classList.contains('analysis-tools-collapsed'),false);assert.equal(workbench.classList.contains('analysis-board-reduced'),false);assert.equal(workbench.style.getPropertyValue('--analysis-comment-size'),'13px');
  assert.equal(ui.state.board,board);assert.equal(ui.state.doc,doc);
  await ui.navigate('library');assert.equal(readingHost.handlers.has('click'),false,'leaving analysis disconnects the reading controls');
 },
 async tool_tabs_preserve_content_and_own_arrow_keys(){
  tabItems=['explorer','bilan','repertoire'].map(id=>{const el=new Element();el.dataset.analysisTool=id;el.setAttribute('role','tab');return el;});
  tabPanels=tabItems.map(tab=>document.getElementById('analysis-tool-'+tab.dataset.analysisTool));
  await open(1);const annotation=document.getElementById('annotation-editor');annotation.innerHTML='Texte non enregistré';ui.selectAnalysisTool('bilan',{focus:true});
  assert.equal(tabPanels[1].hidden,false);assert.equal(explorerPanels.at(-1).visible,false);assert.equal(tabPanels[0].hidden,true);assert.equal(tabItems[1].getAttribute('aria-selected'),'true');assert.equal(document.activeElement,tabItems[1]);
  let prevented=false,stopped=false;tabList.handlers.get('keydown')({target:tabItems[1],key:'ArrowRight',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.ok(prevented&&stopped);assert.equal(ui.state.analysisTool,'repertoire');assert.equal(tabPanels[1].hidden,true);assert.equal(annotation.innerHTML,'Texte non enregistré');assert.equal(document.activeElement,tabItems[2]);
  tabItems[0].onclick();assert.equal(ui.state.analysisTool,'explorer');assert.equal(explorerPanels.at(-1).visible,true);assert.equal(tabPanels[0].hidden,false);assert.equal(annotation.innerHTML,'Texte non enregistré');
 },
 async annotations_open_below_moves_without_switching_left_tools(){
  tabItems=['explorer','bilan','repertoire'].map(id=>{const el=new Element();el.dataset.analysisTool=id;el.setAttribute('role','tab');return el;});
  tabPanels=tabItems.map(tab=>document.getElementById('analysis-tool-'+tab.dataset.analysisTool));
  const textarea=new Element(),query=document.querySelector;document.querySelector=selector=>selector==='#annotation-form textarea'?textarea:query(selector);
  await open(1);const dock=document.getElementById('analysis-annotations'),label=document.getElementById('annotation-position');
  const html=document.getElementById('app').innerHTML;
  assert.doesNotMatch(html,/data-analysis-tool="annotation"/);assert.match(html,/<details[^>]*id="analysis-annotations"/);
  for(const active of ['explorer','repertoire']){
   ui.selectAnalysisTool(active);dock.open=false;await ui.editTree('annotate','0');
   assert.equal(ui.state.path,'0');assert.equal(dock.open,true);assert.equal(document.activeElement,textarea);assert.match(label.textContent,/e4/);
   assert.equal(ui.state.analysisTool,active);assert.equal(explorerPanels.at(-1).visible,active==='explorer');assert.equal(tabPanels[active==='explorer'?0:2].hidden,false);
   await ui.state.board.go('');assert.equal(dock.open,true);assert.equal(label.textContent,'Position initiale');assert.equal(ui.state.analysisTool,active);
   await ui.state.board.go('0');assert.equal(dock.open,true);assert.match(label.textContent,/e4/);
   dock.open=false;await ui.state.board.go('');assert.equal(dock.open,false);
  }
 },
 async late_annotation_navigation_does_not_open_another_game(){
  await open(1);const previous=ui.state.board;let finish;
  previous.go=()=>new Promise(resolve=>{finish=resolve;});const task=ui.editTree('annotate','0');
  await open(2);const dock=document.getElementById('analysis-annotations');dock.open=false;document.activeElement=null;
  finish();await task;assert.equal(ui.state.doc.id,2);assert.equal(dock.open,false);assert.equal(document.activeElement,null);
 },
 async workspace_identity_change_discards_old_editor_before_same_entry_reload(){
  ui.switchWorkspaceIdentity('alice:initial');await open(1);const old=ui.state.board;ui.state.doc.nodes[1].comment='old database';
  ui.switchWorkspaceIdentity('alice:restored');assert(old.disposed);assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.path,'');assert.equal(ui.state.entryNavigation,null);
  const fresh=entry(1);fresh.nodes[1].comment='restored database';const opening=ui.restoreRoute({page:'board',entryId:1});pending.get('/api/entries/1')(fresh);await opening;
  assert.equal(ui.state.doc.nodes[1].comment,'restored database');const current=ui.state.doc;ui.switchWorkspaceIdentity('alice:restored');assert.equal(ui.state.doc,current);
  ui.switchWorkspaceIdentity('bob:initial');assert.equal(ui.state.doc.id,undefined);assert.equal(ui.state.doc.nodes[1].comment,'');
 },
 async open_latest_request_and_navigation(){
  const first=ui.openEntry(1),second=ui.openEntry(2);pending.get('/api/entries/2')(entry(2));await second;assert.equal(ui.state.doc.id,2);pending.get('/api/entries/1')(entry(1));await first;assert.equal(ui.state.doc.id,2);
  const third=ui.openEntry(3);await ui.navigate('library');pending.get('/api/entries/3')(entry(3));await third;assert.equal(ui.state.page,'library');assert.equal(ui.state.doc.id,2);
 },
 async metadata_does_not_replace_new_document(){
  await open(1);await ui.action('metadata');const old=metadataCallbacks.at(-1);await open(2);await old.options.onSaved({...entry(1),title:'Retour tardif'});assert.equal(ui.state.doc.id,2);
  await ui.action('metadata');const same=metadataCallbacks.at(-1);const newer={...ui.state.doc,title:'Modification plus récente'};ui.state.board.doc=newer;ui.state.doc=newer;await same.options.onSaved({...entry(2),title:'Ancienne réponse'});assert.equal(ui.state.doc.title,'Modification plus récente');await ui.action('metadata');const inPlace=metadataCallbacks.at(-1);ui.state.doc.nodes[1].comment='Annotation plus récente';await inPlace.options.onSaved({...entry(2),title:'Réponse précédente'});assert.equal(ui.state.doc.nodes[1].comment,'Annotation plus récente');
 },
 async metadata_preserves_evaluation_progress_while_dialog_is_open(){
  await open(1);const source=ui.state.doc,board=ui.state.board;source.nodes[1].comment='Existing idea [%clk 0:09:42]';board.storedEvaluation=()=>null;
  await ui.action('metadata');const editor=metadataCallbacks.at(-1),updated={...structuredClone(source),title:'New title',analysis_dirty:true,headers:{...source.headers,TimeControl:'600+5'}};
  updated.nodes[1].elapsed=23;
  board.onEvaluation(board,{path:'0',fen:'after',line:{cp:42,depth:20}});
  assert.match(source.nodes[1].comment,/\[%eval 0[.]42,20\]/);
  await editor.options.onSaved(updated);
  assert.equal(ui.state.doc.title,'New title');assert.equal(ui.state.doc.headers.TimeControl,'600+5');assert.equal(ui.state.doc.nodes[1].elapsed,23,'Metadata-derived timing stays updated');
  assert.equal(ui.state.doc.nodes[1].comment,'Existing idea [%clk 0:09:42] [%eval 0.42,20]');assert.match(ui.state.doc.pgn,/\[%eval 0[.]42,20\]/);assert.equal(ui.state.doc.analysis_dirty,true);assertNoEntryMutation();
 },
 async cached_evaluation_flushes_after_local_editor_unlocks(){
  await open(1);const board=ui.state.board;board.storedEvaluation=()=>null;let flushes=0;
  board.flushEngineUpdate=()=>{assert.equal(board.inputLocked,false);flushes++;board.onEvaluation(board,{path:board.path,fen:board.node().fen,line:{cp:40,depth:16+flushes}});};
  const editing=ui.editTree('delete','0');await settle();const edited=makeDoc();edited.nodes=edited.nodes.slice(0,1);edited.nodes[0].children=[];
  pending.get('/api/board/tree')({doc:edited,path:'',changed:true});await editing;
  assert.equal(flushes,1);assert.match(board.node().comment,/\[%eval 0[.]40,17\]/);
  await ui.editHistory('undo');assert.equal(flushes,2);assert.match(board.node().comment,/\[%eval 0[.]40,18\]/);
  await ui.editHistory('redo');assert.equal(flushes,3);assert.match(board.node().comment,/\[%eval 0[.]40,19\]/);
  annotationDraft('New annotation');await document.getElementById('annotation-form').onsubmit(submitEvent());
  assert.equal(flushes,4);assert.match(board.node().comment,/New annotation/);assert.match(board.node().comment,/\[%eval 0[.]40,20\]/);assertNoEntryMutation();
 },
 async saved_tree_and_history_remain_local_until_explicit_save(){
  const source={...entry(1),revision:'revision-before-edit'},opening=ui.openEntry(1);pending.get('/api/entries/1')(source);await opening;assert.equal(source.analysis_dirty,false);const board=ui.state.board;
  const editing=ui.editTree('delete','0');await settle();assert.equal(requests.at(-1).url,'/api/board/tree');assert.equal(requests.at(-1).method,'POST');const request=requests.at(-1);assert.equal(request.body.action,'delete');assert.equal(request.body.path,'0');assert.equal(JSON.parse(request.body.pgn).id,1);
  const edited=makeDoc();edited.nodes=edited.nodes.slice(0,1);edited.nodes[0].children=[];pending.get('/api/board/tree')({doc:edited,path:'',changed:true});await editing;
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.base_id,7);assert.equal(ui.state.doc.revision,'revision-before-edit');assert.equal(ui.state.doc.analysis_dirty,true);assert.equal(ui.state.doc.nodes.length,1);assertNoEntryMutation();
  await ui.editHistory('undo');assert.equal(ui.state.doc.nodes.length,2);assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.revision,'revision-before-edit');assertNoEntryMutation();
  await ui.editHistory('redo');assert.equal(ui.state.doc.nodes.length,1);assert.equal(ui.state.doc.analysis_dirty,true);assertNoEntryMutation();assert.equal(ui.state.board,board);
  const saving=ui.action('save-board');assert.equal(entryMutations().length,1);const save=entryMutations()[0];assert.equal(save.url,'/api/entries/1');assert.equal(save.method,'PATCH');assert.equal(save.body.expected_revision,'revision-before-edit');assert.equal(save.body.explicit_save,true);assert.equal(JSON.parse(save.body.pgn).nodes.length,1);
  pending.get('/api/entries/1')({...ui.state.doc,revision:'revision-after-save'});await saving;assert.equal(ui.state.doc.analysis_dirty,false);assert.equal(ui.state.doc.revision,'revision-after-save');assert.deepEqual(ui.freeHistory.flags(),{can_undo:false,can_redo:false});
 },
 async saved_metadata_is_local_and_navigation_never_persists_it(){
  await open(1);const source=ui.state.doc;source.revision='source-revision';await ui.action('metadata');const editor=metadataCallbacks.at(-1);assert.equal(editor.options.persist,false);
  const updated={...structuredClone(source),title:'Titre personnel',analysis_dirty:true,headers:{...source.headers,Event:'Tournoi local'}};await editor.options.onSaved(updated);
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.revision,'source-revision');assert.equal(ui.state.doc.title,'Titre personnel');assert.equal(ui.state.doc.headers.Event,'Tournoi local');assert.equal(ui.state.doc.analysis_dirty,true);assertNoEntryMutation();
  await ui.navigate('library');await ui.navigate('board');assert.equal(ui.state.doc.headers.Event,'Tournoi local');assert.equal(ui.state.doc.analysis_dirty,true);assertNoEntryMutation();
  await ui.editHistory('undo');assert.equal(ui.state.doc.headers.Event,undefined);assertNoEntryMutation();await ui.editHistory('redo');assert.equal(ui.state.doc.headers.Event,'Tournoi local');assertNoEntryMutation();
 },
 async saved_annotation_apply_is_local_and_preserves_directives(){
  await open(1);const source=ui.state.doc;source.revision='annotation-revision';source.nodes[1].comment='Original [%eval 0.4] [%clk 0:10:00]';source.nodes[1].nags=[1,250];
  const textarea=annotationDraft('Plan personnel'),form=document.getElementById('annotation-form'),nag=new Element();nag.value='3';form.querySelectorAll=selector=>selector==='input[name="nag"]:checked'?[nag]:selector==='textarea,input,button'?[textarea,nag]:[];
  globalThis.FormData=class{constructor(source){assert.equal(source,form);}get(key){return key==='comment'?textarea.value:null;}getAll(key){return key==='nag'?['3']:[];}};
  assert.match(document.getElementById('annotation-editor').innerHTML,/Appliquer l’annotation/);await form.onsubmit({...submitEvent(),target:form});
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.revision,'annotation-revision');assert.match(ui.state.doc.nodes[1].comment,/Plan personnel/);assert.match(ui.state.doc.nodes[1].comment,/\[%eval 0\.4\]/);assert.match(ui.state.doc.nodes[1].comment,/\[%clk 0:10:00\]/);assert.deepEqual(ui.state.doc.nodes[1].nags,[3,250]);assert.equal(ui.state.doc.analysis_dirty,true);assertNoEntryMutation();
 },
 async reopening_saved_entry_restores_local_tree_before_further_annotation(){
  const stored={...entry(1),revision:'source-revision'};
  stored.nodes[1].children=['0.0','0.1'];stored.nodes.push({path:'0.0',parent:'0',fen:'after-e5',san:'e5',uci:'e7e5',children:[],comment:'Original main line',nags:[]},{path:'0.1',parent:'0',fen:'after-c5',san:'c5',uci:'c7c5',children:[],comment:'Keep this variation',nags:[]});
  const opening=ui.openEntry(1);pending.get('/api/entries/1')(structuredClone(stored));await opening;
  const editing=ui.editTree('delete','0.0'),edited=structuredClone(stored);edited.nodes=edited.nodes.filter(node=>node.san!=='e5');edited.nodes[1].children=['0.0'];edited.nodes[2].path='0.0';delete edited.id;delete edited.base_id;delete edited.revision;
  pending.get('/api/board/tree')({doc:edited,path:'0',changed:true});await editing;assert.equal(ui.state.doc.analysis_dirty,true);assert.equal(ui.state.doc.nodes.some(node=>node.san==='e5'),false);assert.equal(ui.state.doc.nodes.find(node=>node.san==='c5').comment,'Keep this variation');assertNoEntryMutation();
  await open(2);const returning=ui.openEntry(1);pending.get('/api/entries/1')(structuredClone(stored));await returning;
  assert.equal(ui.state.doc.id,1);assert.equal(ui.state.doc.revision,'source-revision');assert.equal(ui.state.doc.analysis_dirty,true);assert.equal(ui.state.doc.nodes.some(node=>node.san==='e5'),false,'Reopening uses the retained edited tree instead of the original server tree');assert.equal(ui.state.doc.nodes.find(node=>node.san==='c5').comment,'Keep this variation');assertNoEntryMutation();
  annotationDraft('New note after reopening');await document.getElementById('annotation-form').onsubmit(submitEvent());
  const retained=ui.workspace.get('document:entry:1').doc;assert.equal(retained.nodes.some(node=>node.san==='e5'),false);assert.equal(retained.nodes.find(node=>node.san==='c5').comment,'Keep this variation');assert.equal(retained.nodes.find(node=>node.path===ui.state.path).comment,'New note after reopening');assert.equal(retained.analysis_dirty,true);assertNoEntryMutation();
 },
 async restoring_older_revision_marks_draft_without_replacing_content(){
  const original={...entry(1),revision:'old-revision'},opening=ui.openEntry(1);pending.get('/api/entries/1')(original);await opening;assert.equal(ui.state.doc.analysis_dirty,false);
  const snapshot={doc:structuredClone(ui.state.doc),path:'0'},restoring=ui.restoreAnalysis(snapshot);await settle();const newer={...entry(1),revision:'new-revision',title:'Changed on another device'};newer.nodes[1].comment='Newer stored annotation';pending.get('/api/entries/1')(newer);assert.equal(await restoring,true);
  assert.equal(ui.state.doc.revision,'old-revision');assert.equal(ui.state.doc.title,'Partie 1');assert.equal(ui.state.doc.nodes[1].comment,'');assert.equal(ui.state.doc.analysis_dirty,true);assert.equal(document.getElementById('workspace-status').dataset.state,'draft');assert.equal(ui.workspace.get('document:entry:1').doc.analysis_dirty,true);assertNoEntryMutation();
 },
 async mutation_completion_unlocks_current_toolbar(){
  await open(1);const task=ui.editTree('delete','0');assert.equal(controls.get('undo').disabled,true);await open(2);assert.equal(controls.get('undo').disabled,true);
  pending.get('/api/board/tree')({doc:makeDoc(),path:'',changed:true});await task;assert.equal(ui.state.doc.id,2);assert.equal(ui.state.board.inputLocked,false);assert.equal(controls.get('save-board').disabled,false);assert.equal(controls.get('undo').disabled,true);assert.equal(controls.get('redo').disabled,true);assertNoEntryMutation();
 }
};
const trainingTick=async()=>{await new Promise(resolve=>setImmediate(resolve));await settle();};
const prepareTraining=()=>{document.getElementById('training-view').isConnected=true;globalThis.trainingPanels=[];globalThis.trainingLoads=new Map();globalThis.trainingHistoryDialogs=[];};
Object.assign(tests,{
 async training_history_startup_computer_takes_priority_over_saved_analysis(){
  prepareTraining();const snapshot=retainedComputer();await prepareBoot({hash:'#/library',slots:{computer:snapshot,analysis:{doc:entry(1),path:'0'}}});await ui.boot();requests.length=0;
  await ui.restoreStartup({page:'computer'},{hasRoute:false,startup:{page:'computer',resume:'auto'}});await trainingTick();
  assert.equal(ui.state.page,'computer');assert.equal(trainingPanels.at(-1).loaded.session.id,snapshot.session.id);assert.equal(requests.some(r=>r.url==='/api/entries/1'),false,'The selected computer destination must not be replaced by a retained analysis');assertNoEntryMutation();
 },

 async training_history_boot_auto_computer_restores_the_saved_game(){
  prepareTraining();const snapshot=retainedComputer();const history=await prepareBoot({slots:{computer:snapshot}});await ui.boot();await trainingTick();
  assert.equal(ui.state.page,'computer');assert.equal(trainingPanels.filter(p=>p.kind==='computer').length,1);assert.equal(trainingPanels.at(-1).loaded.session.id,snapshot.session.id);assert.deepEqual(history,[{kind:'replace',url:'#/computer'}]);
 },
 async training_history_explicit_computer_choice_clears_old_programme_relaunch(){
  prepareTraining();const run={id:'old-run',activity:'computer',state:'active',block:{title:'Old block'}};await prepareBoot({hash:'#/library',slots:{'training-plan-active':{run,resume_on_tool:true}}});await ui.boot();
  const snapshot=retainedComputer('chosen-history-game','selected-run'),opening=ui.resumeComputerHistory(snapshot,{id:snapshot.session.id});await settle();pending.get('/api/computer/games/'+snapshot.session.id)({id:snapshot.session.id,revision:2,snapshot});await opening;await trainingTick();
  assert.equal(ui.state.page,'computer');assert.equal(ui.workspace.get('training-plan-active').resume_on_tool,false);assert.equal(ui.workspace.get('training-plan-active').run.id,'old-run');assert.equal(ui.workspace.get('computer').session.training_run_id,'selected-run');assert.equal(trainingPanels.at(-1).loaded.session.id,'chosen-history-game');assert.equal(requests.some(r=>r.url==='/api/training/runs/old-run'),false,'Opening an explicit game must not relaunch the retained programme');assertNoEntryMutation();
 },

 async training_history_computer_selection_survives_page_teardown(){
  prepareTraining();await ui.navigate('computer');await trainingTick();const play=trainingPanels.find(panel=>panel.kind==='computer');assert(play);
  const selected={tool:'computer',id:'selected-computer-game'};
  play.options.onHistory(selected);await trainingTick();
  assert.equal(ui.state.page,'computer-history');assert.equal(play.disposed,true);
  assert.deepEqual(computerHistoryPanels.at(-1).opened,[selected]);assertNoEntryMutation();
 },
 async training_history_late_launch_cannot_open_in_another_tool(){
  prepareTraining();let release;trainingLoads.set('puzzles',new Promise(resolve=>release=resolve));
  await ui.openTrainingRecord({tool:'puzzles',id:'old-puzzle'});await trainingTick();const old=trainingPanels.find(panel=>panel.kind==='puzzles');assert(old);assert.equal(old.opened.length,0);
  await ui.navigate('color');await trainingTick();const current=trainingPanels.find(panel=>panel.kind==='color');assert(current);assert(old.disposed);
  release();await trainingTick();assert.equal(ui.state.page,'color');assert.deepEqual(current.opened,[]);assert.deepEqual(old.opened,[]);assertNoEntryMutation();
 },
 async training_history_latest_record_targets_only_its_own_tool(){
  prepareTraining();let release;trainingLoads.set('guess',new Promise(resolve=>release=resolve));
  await ui.openTrainingRecord({tool:'guess',id:'old-game'});await trainingTick();const old=trainingPanels.find(panel=>panel.kind==='guess');assert(old);
  const selected={tool:'color',id:'latest-round'};await ui.openTrainingRecord(selected);await trainingTick();const current=trainingPanels.find(panel=>panel.kind==='color');assert.deepEqual(current.opened,[selected]);
  release();await trainingTick();assert.deepEqual(old.opened,[]);assert.equal(ui.state.page,'color');assertNoEntryMutation();
 },
 async training_history_account_change_discards_pending_record(){
  prepareTraining();let release;trainingLoads.set('puzzles',new Promise(resolve=>release=resolve));
  await ui.openTrainingRecord({tool:'puzzles',id:'private-result'});await trainingTick();const old=trainingPanels[0];assert(old);
  ui.switchWorkspaceIdentity('another-user');assert(old.disposed);release();await trainingTick();assert.deepEqual(old.opened,[]);assert.equal(ui.state.page,'library');assertNoEntryMutation();
 },
 async training_history_reading_dialog_closes_on_navigation_and_rejects_stale_open(){
  prepareTraining();await ui.navigate('reading');await ui.showReadingHistory();const dialog=trainingHistoryDialogs.at(-1);assert(dialog.open);
  await ui.navigate('library');assert(dialog.closed);requests.length=0;assert.equal(await dialog.options.onOpen({tool:'reading',metrics:{entry_id:5}}),false);assert.deepEqual(requests,[]);
  let release;globalThis.historyDialogGate=new Promise(resolve=>release=resolve);await ui.navigate('reading');const opening=ui.showReadingHistory();await settle();const delayed=trainingHistoryDialogs.at(-1);await ui.navigate('library');release();await opening;assert(delayed.closed);delete globalThis.historyDialogGate;
 },
 async training_history_reading_source_opens_exact_recorded_move_without_saving(){
  prepareTraining();const opening=ui.openTrainingRecord({tool:'reading',metrics:{entry_id:5,last_path:''}});pending.get('/api/entries/5')(entry(5));await opening;assert.equal(ui.state.doc.id,5);assert.equal(ui.state.board.path,'');assertNoEntryMutation();
  await assert.rejects(()=>ui.openTrainingRecord({tool:'reading',metrics:{}}),/source/);assertNoEntryMutation();
 }
});
const selected=process.argv[2];assert.ok(tests[selected],'unknown test '+selected);await tests[selected]();console.log(selected+' passed');
