import assert from 'node:assert/strict';
import {START} from '../static/api.js';
import {ExplorerProbability,probabilityContext,probabilityDisplay,probabilityHtml} from '../static/explorer-probability.js';
const settings={source:'lichess',base_ids:[],speeds:['rapid'],ratings:[1600,1800],repertoire_color:'white',show_probability:true};
function board(){return {path:'0.0',doc:{nodes:[{path:'',parent:null,fen:START},{path:'0',parent:'',uci:'e2e4',fen:'after-e4'},{path:'0.0',parent:'0',uci:'e7e5',fen:'shared-position'},{path:'1',parent:'',uci:'d2d4',fen:'after-d4'},{path:'1.0',parent:'1',uci:'d7d5',fen:'shared-position'}]},node(){return this.doc.nodes.find(n=>n.path===this.path);}};}
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
function setup(){const b=board(),s={...settings},requests=[],updates=[];let active=true;const manager=new ExplorerProbability({getContext:()=>probabilityContext(b,s),isActive:()=>active&&s.show_probability,onChange:()=>updates.push(manager.state),delay:10,request:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve}))});return {b,s,manager,requests,updates,setActive:value=>active=value};}
function answer(request,probability=.01,extra={}){return {fen:request.options.body.fen,start_fen:START,repertoire_color:request.options.body.settings.repertoire_color,status:'ok',probability,stale:false,conditional_root:false,...extra};}
const tests={
 local_filter_key_is_normalized_and_comparison_filters_do_not_change_probability(){
  const b=board(),local={...settings,source:'local',base_ids:[7],local_filters:{rating_min:1600,rating_max:2000,speeds:['rapid','unknown']}},context=probabilityContext(b,local);
  assert.equal(context.key,probabilityContext(b,{...local,local_filters:{speeds:['unknown','rapid','rapid'],rating_max:2000,rating_min:1600}}).key);
  for(const patch of [{rating_min:1800},{rating_max:2200},{speeds:['blitz']}])assert.notEqual(context.key,probabilityContext(b,{...local,local_filters:{...local.local_filters,...patch}}).key);
  assert.equal(context.key,probabilityContext(b,{...local,master_source:'lichess',master_speeds:['bullet'],master_ratings:[2500],master_local_filters:{rating_min:2500,speeds:['classical']}}).key);
  assert.equal(probabilityContext(b,settings).key,probabilityContext(b,{...settings,local_filters:{rating_min:2500,speeds:['unknown']}}).key);
  assert.deepEqual(context.settings.local_filters,local.local_filters);
 },
 async local_filter_changes_cancel_stale_probability_and_start_new_request(){
  const {manager,requests,s}=setup();s.source='local';s.local_filters={rating_min:1600,rating_max:null,speeds:[]};manager.update({immediate:true});const first=requests.at(-1);s.local_filters={rating_min:1800,rating_max:2000,speeds:['rapid']};manager.update({immediate:true});assert.equal(first.options.signal.aborted,true);assert.equal(requests.length,2);first.resolve(answer(first,.8));await settle();assert.equal(manager.state.value,null);requests.at(-1).resolve(answer(requests.at(-1),.2));await settle();assert.equal(manager.state.value.probability,.2);
  s.master_local_filters={rating_min:2700,rating_max:null,speeds:['classical']};manager.update({immediate:true});assert.equal(requests.length,2);assert.equal(manager.state.value.probability,.2);manager.dispose();
 },
 branch_path_is_current_variation_and_settings_key_is_relevant(){
  const b=board(),a=probabilityContext(b,settings);assert.deepEqual(a.moves,['e2e4','e7e5']);b.path='1.0';const alt=probabilityContext(b,settings);assert.deepEqual(alt.moves,['d2d4','d7d5']);assert.equal(a.fen,alt.fen);assert.notEqual(a.key,alt.key);
  assert.notEqual(a.key,probabilityContext(board(),{...settings,repertoire_color:'black'}).key);assert.notEqual(a.key,probabilityContext(board(),{...settings,ratings:[2000]}).key);
  assert.equal(a.key,probabilityContext(board(),{...settings,engine_depth:30,master_source:'local',ratings:[1800,1600]}).key);
  b.path='';assert.deepEqual(probabilityContext(b,settings).moves,[]);b.doc.nodes[0].fen='8/8/8/8/8/8/K7/7k b - - 0 1';assert.equal(probabilityContext(b,settings).conditional_root,true);
 },
 malformed_history_is_unknown_not_one_hundred_percent(){
  const b=board();b.doc.nodes[1].parent='0.0';assert.equal(probabilityContext(b,settings),null);delete b.doc;assert.equal(probabilityContext(b,settings),null);
 },
 numeric_display_handles_zero_unknown_and_rare_rates(){
  assert.deepEqual(probabilityDisplay({status:'ok',probability:.01}).text,'1 %');assert.equal(probabilityDisplay({status:'ok',probability:.01}).ratio,'≈ 1 sur 100');
  assert.equal(probabilityDisplay({status:'ok',probability:1}).ratio,'≈ 1 sur 1');assert.equal(probabilityDisplay({status:'ok',probability:0}).ratio,'non observée');assert.equal(probabilityDisplay({status:'unavailable',probability:null}).text,'—');assert.equal(probabilityDisplay({status:'ok',probability:.000001}).text,'< 0,01 %');assert.doesNotMatch(probabilityDisplay({status:'ok',probability:1e-320}).ratio,/Infinity/);
  const html=probabilityHtml({loading:false,value:{status:'ok',probability:.01,conditional_root:true,stale:true}},{conditional_root:true});assert.match(html,/Depuis le diagramme/);assert.match(html,/Seules les réponses adverses/);assert.match(html,/pas depuis le début/);assert.match(html,/Dernières statistiques/);
 },
 async debounce_sends_only_latest_branch_and_preserves_own_moves(){
  const {b,manager,requests}=setup();manager.update();b.path='1.0';manager.update();assert.equal(requests.length,0);await delay(25);assert.equal(requests.length,1);assert.deepEqual(requests[0].options.body.moves,['d2d4','d7d5']);assert.equal(requests[0].options.body.settings.repertoire_color,'white');requests[0].resolve(answer(requests[0]));await settle();assert.equal(manager.state.value.probability,.01);manager.dispose();
 },
 async same_fen_different_branch_rejects_late_result(){
  const {b,manager,requests}=setup();manager.update({immediate:true});b.path='1.0';manager.update({immediate:true});assert.equal(requests[0].options.signal.aborted,true);requests[0].resolve(answer(requests[0],.9));await settle();assert.equal(manager.state.value,null);requests[1].resolve(answer(requests[1],.02));await settle();assert.equal(manager.state.value.probability,.02);manager.dispose();
 },
 async changing_side_filters_or_visibility_cancels_and_never_accepts_late(){
  const {s,manager,requests,setActive}=setup();manager.update({immediate:true});s.repertoire_color='black';manager.update({immediate:true});assert.equal(requests[0].options.signal.aborted,true);requests[0].resolve(answer(requests[0]));await settle();assert.equal(manager.state.value,null);
  s.ratings=[2200];manager.update({immediate:true});assert.equal(requests[1].options.signal.aborted,true);setActive(false);manager.update();assert.equal(requests[2].options.signal.aborted,true);requests[2].resolve(answer(requests[2]));await settle();assert.equal(manager.state.value,null);setActive(true);manager.update({immediate:true});assert.equal(requests.length,4);const count=requests.length;manager.dispose();assert.equal(requests.at(-1).options.signal.aborted,true);requests.at(-1).resolve(answer(requests.at(-1)));await settle();assert.equal(manager.state.value,null);manager.update();assert.equal(requests.length,count);
 },
 async cache_is_bounded_uses_complete_results_and_honors_refresh(){
  const {b,manager,requests}=setup();manager.update({immediate:true});requests[0].resolve(answer(requests[0]));await settle();b.path='1.0';manager.update({immediate:true});requests[1].resolve(answer(requests[1],.02));await settle();b.path='0.0';manager.update({immediate:true});assert.equal(requests.length,2);assert.equal(manager.state.value.probability,.01);manager.update({force:true,immediate:true});assert.equal(requests.length,3);requests[2].resolve(answer(requests[2],.03));await settle();assert.equal(manager.state.value.probability,.03);
  for(let i=0;i<70;i++){b.doc.nodes[2].uci='move-'+i;manager.update({immediate:true});requests.at(-1).resolve(answer(requests.at(-1)));await settle();}assert.equal(manager.cache.size,64);manager.dispose();assert.equal(manager.cache.size,0);
 },
 async unavailable_malformed_and_hidden_do_not_fabricate_probability(){
  const {manager,requests,s}=setup();manager.update({immediate:true});requests[0].resolve(answer(requests[0],null,{status:'unavailable',message:'Aucun échantillon'}));await settle();assert.equal(manager.cache.size,0);assert.equal(probabilityDisplay(manager.state.value).text,'—');manager.update({immediate:true,force:true});requests[1].resolve(answer(requests[1],2));await settle();assert.equal(manager.state.value.status,'unavailable');s.show_probability=false;manager.update();const n=requests.length;manager.update({immediate:true});assert.equal(requests.length,n);manager.dispose();
 }
};
const name=process.argv[2];assert.ok(tests[name]);await tests[name]();console.log(name+' passed');
