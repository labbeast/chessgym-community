import assert from 'node:assert/strict';
import {START} from '../static/api.js';
import {clockSeconds,formatClock,positionClocks} from '../static/analysis-clocks.js';

const root=(fen=START)=>({path:'',parent:null,fen,uci:null,clock:null});
const move=(path,parent,turn,clock)=>({path,parent,fen:'position '+turn+' - - 0 1',uci:'a1a2',clock});
const document=()=>({headers:{TimeControl:'600+5'},nodes:[root(),move('0','','b',603),move('0.0','0','w',598),move('0.0.0','0.0','b',null),move('0.0.0.0','0.0.0','w',590)]});
const clocks=(white,black,available=true)=>({white,black,available});
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}

const tests={
 strict_seconds_preserve_zero_and_reject_coercion(){
  for(const value of [null,undefined,'0','590',false,true,NaN,Infinity,-Infinity,-1,{},[],new Number(2)])assert.equal(clockSeconds(value),null);
  for(const value of [0,.4,590,3600.25])assert.equal(clockSeconds(value),value);
 },
 formatting_handles_fractions_hours_and_minute_boundaries(){
  for(const value of [null,undefined,'0',NaN,Infinity,-1])assert.equal(formatClock(value),'—');
  for(const [value,text] of [[0,'0:00'],[.4,'0:00.4'],[12.34,'0:12.3'],[12.96,'0:13.0'],[59.9,'0:59.9'],[59.99,'1:00'],[60,'1:00'],[61.6,'1:02'],[3599.6,'1:00:00'],[3661,'1:01:01']])assert.equal(formatClock(value),text);
 },
 absent_move_clocks_never_infer_time_from_headers_or_root(){
  for(const doc of [null,{}, {nodes:[]}, {headers:{TimeControl:'600+5'},nodes:[{...root(),clock:500},move('0','','b',null)]}])assert.deepEqual(positionClocks(doc),clocks(null,null,false));
  const doc=document();doc.nodes.forEach(node=>{node.clock=null;node.elapsed=10;});
  assert.deepEqual(positionClocks(doc,'0.0'),clocks(null,null,false));
 },
 standard_root_initializes_both_sides_and_clocks_are_after_moves(){
  const doc=document();
  assert.deepEqual(positionClocks(doc),clocks(600,600));
  assert.deepEqual(positionClocks(doc,'0'),clocks(603,600));
  assert.deepEqual(positionClocks(doc,'0.0'),clocks(603,598));
  doc.headers.TimeControl='300';assert.deepEqual(positionClocks(doc),clocks(300,300));
  doc.headers.TimeControl='0+5';assert.deepEqual(positionClocks(doc),clocks(0,0));
 },
 missing_or_invalid_own_annotations_clear_only_that_side(){
  const doc=document();
  assert.deepEqual(positionClocks(doc,'0.0.0'),clocks(null,598));
  assert.deepEqual(positionClocks(doc,'0.0.0.0'),clocks(null,590));
  doc.nodes[4].clock='590';assert.deepEqual(positionClocks(doc,'0.0.0.0'),clocks(null,null));
  doc.nodes.push(move('0.0.0.0.0','0.0.0.0','b',0));
  assert.deepEqual(positionClocks(doc,'0.0.0.0.0'),clocks(0,null));
 },
 variation_clocks_follow_parents_without_mixing_siblings(){
  const doc=document();doc.nodes.unshift(move('7.4','7','w',null),move('7','','b',500));
  assert.deepEqual(positionClocks(doc,'7'),clocks(500,600));
  assert.deepEqual(positionClocks(doc,'7.4'),clocks(500,null));
  assert.deepEqual(positionClocks(doc,'0.0'),clocks(603,598));
  assert.deepEqual(positionClocks(doc,'0.0.0.0'),clocks(null,590));
 },
 black_to_move_custom_root_uses_parent_turn_without_initial_inference(){
  const doc={headers:{TimeControl:'600+5'},nodes:[root('8/8/8/8/8/8/8/K6k b - - 0 20'),move('0','','w',590),move('0.0','0','b',550)]};
  assert.deepEqual(positionClocks(doc),clocks(null,null));
  assert.deepEqual(positionClocks(doc,'0'),clocks(null,590));
  assert.deepEqual(positionClocks(doc,'0.0'),clocks(550,590));
 },
 complex_controls_and_nonexact_start_fen_do_not_infer_initial_clocks(){
  for(const control of ['?','-','40/7200:3600','*60','600+5:300','600.5+2',' 600+5',600,null]){
   const doc=document();doc.headers.TimeControl=control;
   assert.deepEqual(positionClocks(doc),clocks(null,null));assert.deepEqual(positionClocks(doc,'0'),clocks(603,null));
  }
  const doc=document();doc.nodes[0].fen=START.replace('0 1','1 1');
  assert.deepEqual(positionClocks(doc),clocks(null,null));
 },
 availability_is_document_wide_and_zero_is_real_data(){
  const doc={headers:{TimeControl:'600+5'},nodes:[root(),move('0','','b',null),move('7','','b',0)]};
  assert.deepEqual(positionClocks(doc),clocks(600,600));
  assert.deepEqual(positionClocks(doc,'0'),clocks(null,600));
  assert.deepEqual(positionClocks(doc,'7'),clocks(0,600));
 },
 flip_does_not_swap_colors_or_mutate_documents(){
  const doc=freeze(document()),before=JSON.stringify(doc);
  const normal=positionClocks(doc,'0.0');
  assert.deepEqual(positionClocks({...doc,flipped:true,orientation:'black'},'0.0'),normal);
  assert.equal(JSON.stringify(doc),before);
 },
 updates_to_annotations_remain_visible_with_the_same_document(){
  const doc=document();assert.deepEqual(positionClocks(doc,'0.0'),clocks(603,598));
  doc.nodes[1].clock=400;doc.nodes[2].clock=0;
  assert.deepEqual(positionClocks(doc,'0.0'),clocks(400,0));
  doc.nodes.forEach(node=>node.clock=null);assert.deepEqual(positionClocks(doc,'0.0'),clocks(null,null,false));
 },
 broken_parent_chains_and_cycles_return_unknown_without_looping(){
  const doc=document();assert.deepEqual(positionClocks(doc,'absent'),clocks(null,null));
  doc.nodes.push(move('orphan','missing','b',100));assert.deepEqual(positionClocks(doc,'orphan'),clocks(null,null));
  doc.nodes.push(move('cycle-a','cycle-b','b',100),move('cycle-b','cycle-a','w',200));
  assert.deepEqual(positionClocks(doc,'cycle-a'),clocks(null,null));
  doc.nodes.push(move('self','self','b',100));assert.deepEqual(positionClocks(doc,'self'),clocks(null,null));
 }
};

const name=process.argv[2];assert.ok(tests[name],'Unknown scenario '+name);tests[name]();console.log(name+' passed');
