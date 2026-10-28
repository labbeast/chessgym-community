import assert from 'node:assert/strict';
import {analysisBoardSize,mobileAnalysisBoardSize,observeAnalysisLayout} from '../static/analysis-layout.js';

class Style{
 constructor(values={}){this.values=new Map(Object.entries(values));this.writes=[];}
 getPropertyValue(name){return this.values.get(name)||'';}
 setProperty(name,value){this.values.set(name,String(value));this.writes.push(['set',name,String(value)]);}
 removeProperty(name){this.values.delete(name);this.writes.push(['remove',name]);}
}
class Classes{
 constructor(){this.values=new Set();}
 toggle(name,enabled){if(enabled)this.values.add(name);else this.values.delete(name);}
 remove(name){this.values.delete(name);}
 contains(name){return this.values.has(name);}
}
function clockBand(height,{top=0,bottom=0,hidden=false}={}){
 return {height,hidden,computed:new Style({'margin-top':top+'px','margin-bottom':bottom+'px'}),getBoundingClientRect(){return {height:this.height};}};
}
function fixture({width=1342,height=658,chartHeight=138.24,toolbarHeight=30,mode='1',tabsHeight=38,panelMin=216,landscape=false,hasEngine=false,clocks=[]}={}){
 const resizeHandlers=new Set(),observers=[];
 globalThis.window={addEventListener(type,fn){assert.equal(type,'resize');resizeHandlers.add(fn);},removeEventListener(type,fn){assert.equal(type,'resize');resizeHandlers.delete(fn);}};
 globalThis.ResizeObserver=class{constructor(callback){this.callback=callback;this.observed=[];this.disconnected=false;observers.push(this);}observe(node){this.observed.push(node);}disconnect(){this.disconnected=true;}};
 globalThis.getComputedStyle=node=>node.computed;
 const charts={computed:new Style({'min-height':chartHeight+'px'})};
 const tabs={height:tabsHeight,getBoundingClientRect(){return {height:this.height};}},engine=hasEngine?{}:null;
 const toolbar={height:toolbarHeight,computed:new Style({'margin-top':'6px','margin-bottom':'0px'}),getBoundingClientRect(){return {height:this.height};}};
 const boardHost={toolbar,clocks,querySelector(selector){return selector==='.board-toolbar'?this.toolbar:null;},querySelectorAll(selector){return selector==='[data-board-clock]'?this.clocks:[];}};
 const workbench={clientWidth:width,clientHeight:height,style:new Style(),classList:new Classes(),computed:new Style({'--analysis-fit':mode,'--analysis-mobile-panel-min':panelMin+'px','--analysis-landscape':landscape?'1':'0','column-gap':'10px','--analysis-column-gap':'8px','--analysis-notation-min':'280px','--analysis-tools-min':'320px'}),querySelector:selector=>selector==='#analysis-charts'?charts:selector==='.analysis-mobile-tabs'?tabs:selector==='#analysis-engine'?engine:null};
 const fit=observeAnalysisLayout(workbench,boardHost);
 return {fit,workbench,boardHost,toolbar,charts,tabs,engine,observers,resizeHandlers,resize(){for(const fn of resizeHandlers)fn();},size(){return Number.parseFloat(workbench.style.getPropertyValue('--analysis-board-size'));}};
}
const tests={
 mobile_portrait_geometry_uses_full_width_even_with_short_height_or_reading_preferences(){
  for(const width of [308,348,378,418,418.5])for(const height of [30,460,590,740])for(const panelMin of [216,280])for(const boardReduced of [false,true]){
   const inputs={width,height,toolbarHeight:34,tabsHeight:38,panelMin,boardReduced};
   const size=mobileAnalysisBoardSize(inputs);
   assert.equal(size,Math.floor(width),'Portrait uses all the screen width; the workspace can scroll if height is short');
  }
 },
 mobile_landscape_geometry_preserves_side_panel_and_toolbar_without_page_scroll(){
  for(const width of [588,655,788,988])for(const height of [244,300,400]){
   const inputs={width,height,toolbarHeight:34,landscape:true},size=mobileAnalysisBoardSize(inputs);
   assert.ok(size>=0);assert.ok(size+300+8<=width,'Landscape reserves the 300 px side panel and 8 px gap');
   assert.ok(size+inputs.toolbarHeight<=height,'The board controls stay inside the landscape workspace');
   assert.ok(size+1+300+8>width||size+1+inputs.toolbarHeight>height);
  }
 },
 mobile_geometry_ignores_desktop_board_reduction_and_never_goes_negative(){
  assert.equal(mobileAnalysisBoardSize({width:418,height:740,toolbarHeight:34,boardReduced:true}),418);
  assert.equal(mobileAnalysisBoardSize({width:988,height:400,toolbarHeight:34,landscape:true,boardReduced:true}),366);
  assert.equal(mobileAnalysisBoardSize({width:308,height:350,toolbarHeight:34,boardReduced:true}),308);
  assert.equal(mobileAnalysisBoardSize({width:200,height:30,toolbarHeight:34}),200);
  assert.equal(mobileAnalysisBoardSize({width:-5,height:300,toolbarHeight:34}),0);
  assert.equal(mobileAnalysisBoardSize({width:300,height:300,toolbarHeight:34,landscape:true}),0);
 },
 mobile_observer_keeps_full_width_through_toolbar_tabs_and_engine_changes(){
  const f=fixture({width:378,height:590,toolbarHeight:28,mode:'2',hasEngine:true}),observer=f.observers[0];
  assert.deepEqual(observer.observed,[f.workbench,f.boardHost,f.engine]);assert.equal(f.size(),378);
  f.workbench.computed.setProperty('--analysis-mobile-panel-min','280px');observer.callback();assert.equal(f.size(),378);
  f.tabs.height=44;observer.callback();assert.equal(f.size(),378);
  f.toolbar.height=40;observer.callback();assert.equal(f.size(),378);
  const before=f.workbench.style.writes.length;observer.callback();assert.equal(f.workbench.style.writes.length,before,'Unchanged engine resize notifications cannot cause an observer feedback loop');
  f.workbench.computed.setProperty('--analysis-mobile-panel-min','216px');observer.callback();assert.equal(f.size(),378);
  f.workbench.clientWidth=418;observer.callback();assert.equal(f.size(),418);f.fit.disconnect();
 },
 observer_switches_between_portrait_landscape_and_desktop_geometry(){
  const f=fixture({width:378,height:590,toolbarHeight:28,mode:'2'});assert.equal(f.size(),378);
  f.workbench.clientWidth=788;f.workbench.clientHeight=300;f.workbench.computed.setProperty('--analysis-landscape','1');f.resize();assert.equal(f.size(),266);
  f.workbench.clientWidth=1342;f.workbench.clientHeight=658;f.workbench.computed.setProperty('--analysis-fit','1');f.resize();assert.equal(f.size(),624);
  f.workbench.clientWidth=378;f.workbench.clientHeight=590;f.workbench.computed.setProperty('--analysis-fit','2');f.workbench.computed.setProperty('--analysis-landscape','0');f.resize();assert.equal(f.size(),378);f.fit.disconnect();
 },
 shrinking_workspace_follows_width_and_recovers_desktop_dimensions(){
  const f=fixture({width:378,height:590,toolbarHeight:28,mode:'2'});assert.equal(f.size(),378);
  f.workbench.clientHeight=200;f.fit.refresh();assert.equal(f.size(),378,'A short portrait keeps the complete full-width board');
  f.workbench.clientWidth=0;f.fit.refresh();assert.equal(f.size(),0,'A detached zero-width workspace cannot retain stale board dimensions');
  f.workbench.clientWidth=378;f.workbench.clientHeight=590;f.fit.refresh();assert.equal(f.size(),378);
  f.workbench.computed.setProperty('--analysis-fit','1');f.fit.refresh();assert.equal(f.size(),0);
  f.workbench.clientWidth=1342;f.fit.refresh();assert.equal(f.size(),556);f.fit.disconnect();
 },
 desktop_geometry_maximizes_central_board_with_controls_and_side_columns(){
  // Available workbench geometry after the compact header, title and page padding.
  const viewports=[{viewport:'1366 x 768',width:1342,height:658,chartHeight:138.24},{viewport:'1920 x 1080',width:1896,height:970,chartHeight:170}];
  for(const {viewport,...geometry} of viewports){
   const inputs={...geometry,toolbarHeight:36,gap:10,notationMin:280,toolsMin:320},size=analysisBoardSize(inputs);
   const previousSize=Math.floor(Math.min(inputs.width-inputs.notationMin-inputs.toolsMin-2*inputs.gap,inputs.height-inputs.chartHeight-inputs.toolbarHeight-8));
   assert.ok(size>0&&Number.isInteger(size),viewport);
   assert.ok(size+inputs.toolbarHeight<=inputs.height,viewport+' fits vertically');
   assert.ok(size+inputs.notationMin+inputs.toolsMin+2*inputs.gap<=inputs.width,viewport+' preserves both tool columns');
   assert.ok(size+1+inputs.toolbarHeight>inputs.height,viewport+' uses available board height');
   assert.ok(size>previousSize,viewport+' gains the height previously used by the graph');
  }
 },
 narrow_desktop_keeps_both_tool_columns_and_never_returns_negative_size(){
  const inputs={width:1076,height:850,toolbarHeight:36,gap:10,notationMin:280,toolsMin:320},size=analysisBoardSize(inputs);
  assert.equal(size+inputs.notationMin+inputs.toolsMin+2*inputs.gap,inputs.width);
  assert.ok(size+inputs.toolbarHeight<inputs.height);
  assert.equal(analysisBoardSize({...inputs,width:500}),0);
  assert.equal(analysisBoardSize({...inputs,height:35}),0);
 },
 collapsed_tools_reserve_the_reclaimed_column_for_notation(){
  for(const geometry of [{width:1076,height:850},{width:1342,height:658},{width:1896,height:970}]){
   const inputs={...geometry,toolbarHeight:36,gap:10,notationMin:280,toolsMin:320};
   const normal=analysisBoardSize(inputs),collapsed=analysisBoardSize({...inputs,toolsCollapsed:true});
   assert.equal(collapsed,normal,'Hiding tools must not enlarge the board at the expense of the annotations');
   const normalNotation=inputs.width-normal-inputs.toolsMin-2*inputs.gap;
   const collapsedNotation=inputs.width-collapsed-inputs.gap;
   assert.equal(collapsedNotation-normalNotation,inputs.toolsMin+inputs.gap);
   assert.ok(collapsedNotation>=inputs.notationMin);
   assert.ok(collapsed+inputs.toolbarHeight<=inputs.height);
  }
 },
 reduced_board_reclaims_width_and_still_fits_short_workspaces(){
  for(const toolsCollapsed of [false,true]){
   const inputs={width:1342,height:658,toolbarHeight:36,toolsCollapsed,boardReduced:true};
   assert.equal(analysisBoardSize(inputs),320);
   assert.equal(analysisBoardSize({...inputs,height:290}),254,'Small heights still constrain the reduced board');
   assert.equal(analysisBoardSize({...inputs,width:290,toolsMin:0}),0,'A collapsed or reduced board cannot overrun the notation minimum and gaps');
  }
 },
 explicit_refresh_applies_reading_preferences_and_restores_normal_geometry(){
  const f=fixture({width:1076,height:850}),normal=f.size();
  f.workbench.classList.toggle('analysis-tools-collapsed',true);f.fit.refresh();
  assert.equal(f.size(),normal);
  f.workbench.classList.toggle('analysis-board-reduced',true);f.fit.refresh();
  assert.equal(f.size(),320);assert.equal(f.workbench.classList.contains('analysis-compact-board'),true);
  f.workbench.classList.toggle('analysis-tools-collapsed',false);f.fit.refresh();assert.equal(f.size(),320);
  f.workbench.classList.toggle('analysis-board-reduced',false);f.fit.refresh();
  assert.equal(f.size(),normal);assert.equal(f.workbench.classList.contains('analysis-compact-board'),false);
  f.fit.disconnect();f.workbench.classList.toggle('analysis-board-reduced',true);f.fit.refresh();
  assert.equal(f.size(),normal,'A retained refresh callback cannot update a detached workspace');
 },
 graph_size_and_presence_do_not_reduce_the_central_board(){
  const inputs={width:1342,height:658,toolbarHeight:36};
  for(const chartHeight of [0,138.24,240,600])assert.equal(analysisBoardSize({...inputs,chartHeight}),622,'The graph occupies the independent tools column');
  const f=fixture(),initial=f.size();
  f.charts.computed.setProperty('min-height','600px');f.observers[0].callback();assert.equal(f.size(),initial);
  f.fit.disconnect();
  const chartless={...f.workbench,querySelector:()=>null},fit=observeAnalysisLayout(chartless,f.boardHost);
  assert.ok(fit,'A temporarily unmounted graph must not prevent board fitting');
  assert.equal(Number.parseFloat(chartless.style.getPropertyValue('--analysis-board-size')),initial);
  assert.deepEqual(f.observers.at(-1).observed,[chartless,f.boardHost]);fit.disconnect();
 },
 short_desktop_keeps_the_central_board_and_controls_visible(){
  const inputs={width:1076,height:490,toolbarHeight:36},size=analysisBoardSize(inputs);
  assert.equal(size,454);assert.equal(size+inputs.toolbarHeight,inputs.height);
  assert.ok(size+280+320+20<=inputs.width);
 },
 temporary_report_controls_fit_below_board_and_release_their_space(){
  const f=fixture(),normal=f.size();f.fit.disconnect();
  const controls={height:70,getBoundingClientRect(){return {height:this.height};}};
  const fit=observeAnalysisLayout(f.workbench,f.boardHost,{extraToolbar:controls}),observer=f.observers.at(-1);
  assert.equal(f.size(),normal-70);assert.ok(observer.observed.includes(controls));
  controls.height=100;observer.callback();assert.equal(f.size(),normal-100,'Wrapped retry buttons must still fit a short desktop');
  fit.disconnect();controls.height=20;observer.callback();assert.equal(f.size(),normal-100);
  const restored=observeAnalysisLayout(f.workbench,f.boardHost);assert.equal(f.size(),normal);restored.disconnect();
 },
 clock_bands_fit_both_players_and_release_hidden_space(){
  for(const geometry of [{mode:'1',width:1342,height:658},{mode:'2',landscape:true,width:788,height:300},{mode:'2',width:378,height:590}]){
   const baseline=fixture(geometry),normal=baseline.size();baseline.fit.disconnect();
   const clocks=[clockBand(18,{top:2,bottom:3}),clockBand(20,{top:1,bottom:2})],f=fixture({...geometry,clocks}),observer=f.observers[0];
   const portrait=geometry.mode==='2'&&!geometry.landscape;
   assert.equal(f.size(),portrait?normal:normal-46,'Both visible players and their spacing fit beside the board controls');
   assert.equal(f.workbench.style.getPropertyValue('--analysis-clock-height'),'46px','The landscape dock accounts for the same visible clock space');
   if(!portrait)assert.ok(f.size()+36+46<=geometry.height,'The whole board column stays within the available height');
   clocks[1].hidden=true;observer.callback();assert.equal(f.size(),portrait?normal:normal-23);assert.equal(f.workbench.style.getPropertyValue('--analysis-clock-height'),'23px');
   clocks[0].hidden=true;observer.callback();assert.equal(f.size(),normal,'Unavailable clocks release all their space');assert.equal(f.workbench.style.getPropertyValue('--analysis-clock-height'),'0px');
   const writes=f.workbench.style.writes.length;observer.callback();assert.equal(f.workbench.style.writes.length,writes,'Unchanged measurements do not rewrite styles');
   f.fit.disconnect();
  }
 },
 replaced_clock_bands_are_remeasured_from_the_stable_host(){
  const clocks=[clockBand(18),clockBand(18)],f=fixture({clocks}),observer=f.observers[0],initial=f.size();
  const replacement=[clockBand(24,{top:2,bottom:2}),clockBand(24,{top:2,bottom:2})];f.boardHost.clocks=replacement;
  observer.callback();assert.equal(f.size(),initial-20);assert.equal(f.workbench.style.getPropertyValue('--analysis-clock-height'),'56px');
  assert.deepEqual(observer.observed,[f.workbench,f.boardHost],'Board renders replace clock nodes, so the stable host owns observation');
  const writes=f.workbench.style.writes.length;clocks[0].height=200;observer.callback();assert.equal(f.size(),initial-20);assert.equal(f.workbench.style.writes.length,writes,'Detached clock elements cannot resize the board');
  f.boardHost.clocks=[];observer.callback();assert.equal(f.size(),initial+36);assert.equal(f.workbench.style.getPropertyValue('--analysis-clock-height'),'0px');
  f.fit.disconnect();f.boardHost.clocks=replacement;observer.callback();assert.equal(f.size(),initial+36,'Late measurements after navigation are ignored');
 },
 observer_reacts_to_workbench_and_toolbar_resizing_without_redundant_writes(){
  const f=fixture(),observer=f.observers[0];assert.deepEqual(observer.observed,[f.workbench,f.boardHost]);assert.equal(f.resizeHandlers.size,1);
  const initial=f.size(),initialWrites=f.workbench.style.writes.length;assert.equal(initial,622);
  observer.callback();assert.equal(f.workbench.style.writes.length,initialWrites);
  f.workbench.clientHeight+=100;observer.callback();assert.equal(f.size(),initial+100);
  f.toolbar.height+=20;observer.callback();assert.equal(f.size(),initial+80);
  f.workbench.clientWidth=950;observer.callback();assert.equal(f.size(),330);assert.equal(f.workbench.classList.contains('analysis-compact-board'),true);
  f.workbench.clientWidth=1342;observer.callback();assert.equal(f.size(),initial+80);assert.equal(f.workbench.classList.contains('analysis-compact-board'),false);
  f.fit.disconnect();
 },
 replaced_board_toolbar_is_remeasured_from_the_stable_host(){
  const f=fixture(),observer=f.observers[0],initial=f.size();
  const replacement={height:58,computed:new Style({'margin-top':'6px','margin-bottom':'0px'}),getBoundingClientRect(){return {height:this.height};}};
  f.boardHost.toolbar=replacement;f.toolbar.height=0;
  observer.callback();assert.equal(f.size(),initial-28,'The current toolbar reserves its own height after a board render');
  assert.deepEqual(observer.observed,[f.workbench,f.boardHost]);
  const writes=f.workbench.style.writes.length;f.toolbar.height=200;observer.callback();
  assert.equal(f.size(),initial-28,'Detached controls cannot change board sizing');assert.equal(f.workbench.style.writes.length,writes);
  replacement.height=38;observer.callback();assert.equal(f.size(),initial-8);
  f.fit.disconnect();
 },
 responsive_mode_switch_clears_inline_size_without_geometry_change(){
  const f=fixture({width:950});assert.equal(f.workbench.classList.contains('analysis-compact-board'),true);
  f.workbench.computed.setProperty('--analysis-fit','0');f.resize();
  assert.equal(f.workbench.style.getPropertyValue('--analysis-board-size'),'');assert.equal(f.workbench.classList.contains('analysis-compact-board'),false);
  f.workbench.computed.setProperty('--analysis-fit','1');f.resize();assert.equal(f.size(),330);assert.equal(f.workbench.classList.contains('analysis-compact-board'),true);
  f.fit.disconnect();
 },
 disconnect_removes_resize_listener_and_ignores_late_observer_delivery(){
  const f=fixture(),observer=f.observers[0],lateWindowCallback=[...f.resizeHandlers][0],before=f.workbench.style.writes.length,initial=f.size();
  f.fit.disconnect();assert.equal(observer.disconnected,true);assert.equal(f.resizeHandlers.size,0);
  f.workbench.clientHeight=1200;observer.callback();lateWindowCallback();f.resize();
  assert.equal(f.workbench.style.writes.length,before);assert.equal(f.size(),initial);
 },
 missing_observer_or_unmounted_elements_are_safe(){
  const f=fixture();f.fit.disconnect();
  assert.equal(observeAnalysisLayout(null,f.toolbar),null);
  assert.equal(observeAnalysisLayout(f.workbench,{querySelector:()=>null}),null);
  delete globalThis.ResizeObserver;assert.equal(observeAnalysisLayout(f.workbench,{querySelector:()=>f.toolbar}),null);
  assert.equal(f.resizeHandlers.size,0);
 },
};
const name=process.argv[2];assert.ok(tests[name],name);await tests[name]();console.log(name+' passed');
