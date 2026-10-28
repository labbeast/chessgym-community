import assert from 'node:assert/strict';
import {readingControlsHtml,mountReadingControls,applyDisplayPreferences,getMoveDisplayPreferences} from '../static/reading-controls.js';
const DEFAULTS={toolsCollapsed:false,boardReduced:false,fontSize:13,evaluationMode:'loss',timeMode:'elapsed',highlightEvaluation:true,highlightTime:true};
function fixture({saved=null,readError=false,writeError=false,noDocument=false}={}){
 const listeners=new Set(),changeListeners=new Set(),writes=[],changes=[],presets=[],classes=new Set(),properties=new Map(),rootProperties=new Map();
 const controls=new Map(['tools','board','font-less','font-more','reset','touch','preset-reading','preset-analysis','preset-repertoire'].map(action=>[action,{dataset:{readingAction:action},textContent:'',disabled:false,attributes:new Map(),setAttribute(name,value){this.attributes.set(name,value);},closest(){return this;}}]));
 const settings=new Map(['evaluationMode','timeMode','highlightEvaluation','highlightTime'].map(key=>[key,{dataset:{readingSetting:key},value:'',checked:false,disabled:false,closest(){return this;}}]));
 const output={textContent:''};
 const host={open:true,querySelector(selector){return selector==='[data-reading-size]'?output:controls.get(selector.match(/data-reading-action="([^"]+)"/)?.[1])||settings.get(selector.match(/data-reading-setting="([^"]+)"/)?.[1])||null;},contains(node){return [...controls.values(),...settings.values()].includes(node);},addEventListener(type,fn){assert.ok(['click','change'].includes(type));(type==='click'?listeners:changeListeners).add(fn);},removeEventListener(type,fn){assert.ok(['click','change'].includes(type));(type==='click'?listeners:changeListeners).delete(fn);}};
 const workbench={classList:{toggle(name,enabled){if(enabled)classes.add(name);else classes.delete(name);}},style:{setProperty(name,value){properties.set(name,value);}}};
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(key){assert.equal(key,'chessgym.reading');if(readError)throw Error('unavailable');return saved;},setItem(key,value){if(writeError)throw Error('unavailable');writes.push([key,JSON.parse(value)]);saved=value;}}});
 if(noDocument)delete globalThis.document;else globalThis.document={documentElement:{dataset:{},style:{setProperty(name,value){rootProperties.set(name,value);}}}};
 const controller=mountReadingControls(host,{workbench,onLayoutChange:state=>changes.push(state),onPresetChange:value=>presets.push(value)});
 return {controller,host,workbench,controls,settings,output,listeners,changeListeners,writes,changes,presets,classes,properties,rootProperties,change(key,value){const target=settings.get(key);if(typeof value==='boolean')target.checked=value;else target.value=value;for(const fn of changeListeners)fn({target});},click(action){const target=controls.get(action);for(const fn of listeners)fn({target});}};
}
const savedLayout=value=>Object.fromEntries(Object.keys(DEFAULTS).map(key=>[key,value[key]]));
const tests={
 markup_is_compact_accessible_and_uses_local_click_actions(){
  const html=readingControlsHtml();
  assert.ok(html.startsWith('<details class="analysis-reading-controls"><summary'));assert.ok(html.includes('>Affichage</summary>'));
  assert.match(html,/class="analysis-reading-options"/);
  for(const action of ['tools','board','font-less','font-more','reset'])assert.match(html,new RegExp('data-reading-action="'+action+'"'));
  assert.match(html,/Texte des annotations/);assert.match(html,/aria-live="polite"/);
  assert.equal((html.match(/aria-pressed="false"/g)||[]).length,6);
  assert.doesNotMatch(html,/onkeydown|onkeypress|onclick/);
 },
 mount_applies_defaults_and_saved_settings_without_writing_storage(){
  const f=fixture();assert.deepEqual(f.controller.state,DEFAULTS);assert.deepEqual(f.changes,[DEFAULTS]);assert.equal(f.writes.length,0);
  assert.equal(f.properties.get('--analysis-comment-size'),'13px');assert.equal(f.output.textContent,'13 px');
  const g=fixture({saved:JSON.stringify({toolsCollapsed:true,boardReduced:true,fontSize:16})});
  assert.deepEqual(g.controller.state,{...DEFAULTS,toolsCollapsed:true,boardReduced:true,fontSize:16});
  assert.equal(g.classes.has('analysis-tools-collapsed'),true);assert.equal(g.classes.has('analysis-board-reduced'),true);
  assert.equal(g.controls.get('tools').textContent,'Afficher les outils');assert.equal(g.controls.get('board').textContent,'Agrandir l’échiquier');
  assert.equal(g.controls.get('tools').attributes.get('aria-pressed'),'true');assert.equal(g.rootProperties.get('--analysis-comment-size'),'16px');assert.equal(g.writes.length,0);
 },
 toggles_persist_and_keep_the_reading_menu_open(){
  const f=fixture();f.click('tools');f.click('board');
  assert.deepEqual(f.controller.state,{...DEFAULTS,toolsCollapsed:true,boardReduced:true,fontSize:13});assert.equal(f.host.open,true);
  assert.equal(f.writes.at(-1)[0],'chessgym.reading');assert.deepEqual(savedLayout(f.writes.at(-1)[1]),f.controller.state);
  f.click('tools');f.click('board');assert.deepEqual(f.controller.state,DEFAULTS);assert.equal(f.classes.size,0);
  assert.equal(f.controls.get('tools').attributes.get('aria-pressed'),'false');assert.equal(f.controls.get('board').attributes.get('aria-pressed'),'false');
  assert.equal(f.controls.get('tools').textContent,'Masquer les outils');assert.equal(f.controls.get('board').textContent,'Réduire l’échiquier');
  assert.equal(f.changes.length,5);
 },
 font_limits_are_enforced_and_reset_restores_all_preferences(){
  const f=fixture();for(let i=0;i<20;i++)f.click('font-more');
  assert.equal(f.controller.state.fontSize,18);assert.equal(f.controls.get('font-more').disabled,true);assert.equal(f.controls.get('font-less').disabled,false);assert.equal(f.writes.length,5);
  assert.equal(f.properties.get('--analysis-comment-size'),'18px');assert.equal(f.output.textContent,'18 px');
  for(let i=0;i<20;i++)f.click('font-less');assert.equal(f.controller.state.fontSize,11);assert.equal(f.controls.get('font-less').disabled,true);assert.equal(f.controls.get('font-more').disabled,false);
  f.click('tools');f.click('board');f.click('reset');assert.deepEqual(f.controller.state,DEFAULTS);assert.equal(f.classes.size,0);
  assert.equal(f.controls.get('font-less').disabled,false);assert.equal(f.controls.get('font-more').disabled,false);assert.deepEqual(savedLayout(f.writes.at(-1)[1]),DEFAULTS);
 },
 malformed_storage_and_non_boolean_values_cannot_break_layout(){
  for(const saved of ['{broken','null','[]','true','"hello"',JSON.stringify({toolsCollapsed:'true',boardReduced:1,fontSize:'18'})]){
   const f=fixture({saved});assert.deepEqual(f.controller.state,DEFAULTS);assert.equal(f.writes.length,0);
  }
  assert.equal(fixture({saved:'{"fontSize":900}'}).controller.state.fontSize,18);
  assert.equal(fixture({saved:'{"fontSize":-2}'}).controller.state.fontSize,11);
  assert.equal(fixture({saved:'{"fontSize":14.4}'}).controller.state.fontSize,14);
 },
 denied_storage_and_absent_document_remain_usable(){
  const f=fixture({readError:true,writeError:true,noDocument:true});assert.deepEqual(f.controller.state,DEFAULTS);
  f.click('tools');f.click('font-more');assert.equal(f.controller.state.toolsCollapsed,true);assert.equal(f.controller.state.fontSize,14);assert.equal(f.changes.length,3);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw Error('blocked getter');}});
  const controller=mountReadingControls(f.host,{workbench:f.workbench});assert.deepEqual(controller.state,DEFAULTS);controller.update({boardReduced:true});assert.equal(controller.state.boardReduced,true);controller.disconnect();
  delete globalThis.localStorage;
 },
 public_update_validates_persists_and_returns_isolated_state(){
  const f=fixture({saved:'{"toolsCollapsed":true,"fontSize":15}'});
  f.controller.update({toolsCollapsed:false});assert.equal(f.classes.has('analysis-tools-collapsed'),false);assert.equal(f.writes.length,1);
  f.controller.update({boardReduced:'yes',toolsCollapsed:1,fontSize:'99',unknown:true});assert.equal(f.writes.length,1);assert.deepEqual(f.controller.state,{...DEFAULTS,fontSize:15});
  f.controller.update({boardReduced:true,fontSize:24});assert.equal(f.controller.state.fontSize,18);assert.equal(f.controller.state.boardReduced,true);
  const copy=f.controller.state;copy.fontSize=1;f.changes.at(-1).toolsCollapsed=true;assert.equal(f.controller.state.fontSize,18);assert.equal(f.controller.state.toolsCollapsed,false);
  f.controller.update(null);f.controller.update([]);f.controller.update({fontSize:NaN});assert.equal(f.writes.length,2);
 },
 cleanup_removes_own_listener_and_prevents_late_changes(){
  const f=fixture(),handler=[...f.listeners][0];assert.equal(f.listeners.size,1);f.controller.disconnect();assert.equal(f.listeners.size,0);
  f.click('tools');handler({target:f.controls.get('tools')});f.controller.update({boardReduced:true});assert.deepEqual(f.controller.state,DEFAULTS);assert.equal(f.writes.length,0);assert.equal(f.changes.length,1);
  f.controller.disconnect();assert.equal(f.listeners.size,0);
 },
 absent_hosts_and_unrelated_clicks_are_ignored(){
  const f=fixture(),handler=[...f.listeners][0];assert.equal(mountReadingControls(null,{workbench:f.workbench}),null);assert.equal(mountReadingControls(f.host),null);
  handler({target:{closest(){return {dataset:{readingAction:'tools'}};}}});handler({target:{}});handler({target:null});assert.deepEqual(f.controller.state,DEFAULTS);assert.equal(f.changes.length,1);
 },
 presets_remember_independent_adjustments_without_navigation_on_mount(){
  const f=fixture();assert.equal(f.presets.length,0);f.click('preset-reading');
  assert.deepEqual(f.controller.state,{...DEFAULTS,toolsCollapsed:true,boardReduced:true,fontSize:16});f.click('font-more');
  f.click('preset-repertoire');assert.deepEqual(f.controller.state,DEFAULTS);assert.equal(f.presets.at(-1).tool,'explorer');
  f.click('tools');f.click('preset-reading');assert.equal(f.controller.state.fontSize,17);
  const saved=JSON.stringify(f.writes.at(-1)[1]),g=fixture({saved});assert.equal(g.controller.preset,'reading');assert.equal(g.controller.state.fontSize,17);assert.equal(g.presets.length,0);
  g.click('preset-repertoire');assert.equal(g.controller.state.toolsCollapsed,true);g.click('reset');assert.equal(g.controller.state.toolsCollapsed,false);
  g.click('preset-reading');assert.equal(g.controller.state.fontSize,17);g.click('reset');assert.equal(g.controller.state.fontSize,16);
 },
 touch_comfort_persists_and_applies_before_analysis_mount(){
  const f=fixture();assert.equal(globalThis.document.documentElement.dataset.touchComfort,'false');f.click('touch');
  assert.equal(f.controller.touchComfort,true);assert.equal(globalThis.document.documentElement.dataset.touchComfort,'true');
  f.click('preset-reading');assert.equal(f.controller.touchComfort,true);assert.equal(f.controls.get('touch').attributes.get('aria-pressed'),'true');
  globalThis.document.documentElement.dataset.touchComfort='false';assert.equal(applyDisplayPreferences(),true);assert.equal(globalThis.document.documentElement.dataset.touchComfort,'true');
  f.click('touch');assert.equal(applyDisplayPreferences(),false);
 },
};
tests.move_preferences_restore_migrate_and_validate=()=>{
 const f=fixture({saved:JSON.stringify({fontSize:16,evaluationMode:'position',timeMode:'remaining',highlightEvaluation:false,highlightTime:false})});
 assert.equal(f.settings.get('evaluationMode').value,'position');assert.equal(f.settings.get('timeMode').value,'remaining');
 assert.equal(f.settings.get('highlightEvaluation').checked,false);assert.equal(f.settings.get('highlightTime').checked,false);
 assert.deepEqual(getMoveDisplayPreferences(),{evaluationMode:'position',timeMode:'remaining',highlightEvaluation:false,highlightTime:false});
 const g=fixture({saved:JSON.stringify({fontSize:15,evaluationMode:'unknown',timeMode:null,highlightEvaluation:'false',highlightTime:0})});
 assert.deepEqual(g.controller.state,{...DEFAULTS,fontSize:15});
 g.controller.update({evaluationMode:'unknown',timeMode:'unknown',highlightEvaluation:1,highlightTime:'false'});assert.equal(g.writes.length,0);
 assert.equal(f.writes.length,0);
};
tests.move_controls_keep_profiles_and_reset_independent=()=>{
 const f=fixture();f.change('evaluationMode','position');f.change('timeMode','remaining');f.change('highlightEvaluation',false);f.change('highlightTime',false);
 assert.equal(f.host.open,true);assert.equal(f.writes.length,4);assert.equal(f.controller.state.evaluationMode,'position');assert.equal(f.controller.state.highlightTime,false);
 f.click('preset-reading');assert.equal(f.controller.state.evaluationMode,'loss');assert.equal(f.controller.state.timeMode,'elapsed');
 f.change('highlightTime',false);f.click('preset-analysis');assert.equal(f.controller.state.evaluationMode,'position');assert.equal(f.controller.state.timeMode,'remaining');
 const g=fixture({saved:JSON.stringify(f.writes.at(-1)[1])});assert.equal(g.controller.state.highlightEvaluation,false);assert.equal(g.controller.state.timeMode,'remaining');
 g.click('reset');assert.deepEqual(g.controller.state,DEFAULTS);g.click('preset-reading');assert.equal(g.controller.state.highlightTime,false);
 const late=[...g.changeListeners][0],before={...g.controller.state};g.controller.disconnect();assert.equal(g.changeListeners.size,0);
 g.settings.get('timeMode').value='remaining';late({target:g.settings.get('timeMode')});assert.deepEqual(g.controller.state,before);
};
tests.move_controls_have_labelled_native_inputs=()=>{
 const html=readingControlsHtml();
 assert.ok(html.includes('<legend>Informations des coups</legend>'));
 for(const key of ['evaluationMode','timeMode'])assert.match(html,new RegExp('<label>[^<]+<select data-reading-setting="'+key+'">'));
 for(const key of ['highlightEvaluation','highlightTime'])assert.match(html,new RegExp('<input type="checkbox" data-reading-setting="'+key+'">'));
 assert.match(html,/plus de 5 % et 10 % du temps de départ/);
};
const name=process.argv[2];
if(name){assert.ok(tests[name],name);await tests[name]();console.log(name+' passed');}
else for(const [label,test] of Object.entries(tests)){await test();console.log(label+' passed');}

