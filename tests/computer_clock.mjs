import assert from 'node:assert/strict';
import {ComputerClock,newClock,clockSettings,clockText} from '../static/computer-clock.js';
const cases={
 presets_and_custom_limits_are_explicit(){
  assert.equal(clockSettings({}),null);assert.equal(newClock({time_control:'unlimited'}),null);
  assert.deepEqual(clockSettings({time_control:'15+10'}),{initial_ms:900000,increment_ms:10000});
  assert.deepEqual(clockSettings({time_control:'custom',clock_minutes:10.008,clock_increment:.3}),{initial_ms:600000,increment_ms:0});
  assert.deepEqual(clockSettings({time_control:'custom',clock_minutes:.1,clock_increment:180}),{initial_ms:6000,increment_ms:180000});
  for(const c of [{time_control:'unknown'},{time_control:'custom',clock_minutes:0,clock_increment:0},{time_control:'custom',clock_minutes:181,clock_increment:0},{time_control:'custom',clock_minutes:1,clock_increment:-1},{time_control:'custom',clock_minutes:1,clock_increment:181},{time_control:'custom',clock_minutes:Infinity,clock_increment:0}])assert.throws(()=>clockSettings(c));
 },
 reload_never_charges_closed_browser_time(){
  let now=100;const s=newClock({time_control:'5+0'}),clock=new ComputerClock(s,{now:()=>now});clock.start('white');now=2600;clock.read();assert.equal(s.remaining.white,297500);
  const saved=structuredClone(s);now=999999999;const reopened=new ComputerClock(saved,{now:()=>now});assert(saved.paused);assert.equal(saved.running,null);assert.equal(reopened.read().remaining.white,297500);
  reopened.start('white');now+=4000;assert.equal(reopened.read().remaining.white,293500);assert.equal(saved.remaining.black,300000);
 },
 pause_stops_both_clocks_and_preserves_active_elapsed_time(){
  let now=0;const s=newClock({time_control:'10+0'}),clock=new ComputerClock(s,{now:()=>now});clock.start('black');now=4200;clock.pause();now+=100000;clock.read();assert.equal(s.remaining.black,595800);assert.equal(s.remaining.white,600000);
  clock.start('black');now+=600;clock.read();assert.equal(s.remaining.black,595200);
 },
 held_proposals_have_no_latency_cost_or_early_increment(){
  let now=0;const s=newClock({time_control:'15+10'}),clock=new ComputerClock(s,{now:()=>now});clock.start('white');now=3000;clock.hold();now=60000;clock.read();assert.equal(s.remaining.white,897000);assert.equal(s.history.length,1);
  assert(clock.commit('white',1));assert.equal(s.remaining.white,907000);assert.equal(s.running,'black');assert.equal(s.history[1].remaining.black,900000);
  now+=1000;clock.read();assert.equal(s.remaining.black,899000);
 },
 flag_fall_cannot_be_rescued_with_increment(){
  let now=0;const s=newClock({time_control:'custom',clock_minutes:.1,clock_increment:10}),clock=new ComputerClock(s,{now:()=>now});clock.start('white');now=6000;assert.equal(clock.hold(),'white');assert.equal(s.remaining.white,0);assert(s.paused);assert.equal(clock.commit('white',1),false);assert.equal(clock.start('white'),false);assert.equal(s.history.length,1);
 },
 undo_restores_both_sides_and_truncates_obsolete_clock_history(){
  let now=0;const s=newClock({time_control:'custom',clock_minutes:1,clock_increment:2},8),clock=new ComputerClock(s,{now:()=>now});clock.start('black');now=4000;clock.commit('black',9);now+=7000;clock.commit('white',10);assert.deepEqual(s.remaining,{white:55000,black:58000});
  assert(clock.restore(8));assert.deepEqual(s.remaining,{white:60000,black:60000});assert.deepEqual(s.history.map(x=>x.ply),[8]);assert(s.paused);clock.start('black');now+=1000;clock.commit('black',9);assert.equal(s.remaining.black,61000);assert.deepEqual(s.history.map(x=>x.ply),[8,9]);
 },
 final_move_freezes_clock_and_clock_labels_round_up(){
  let now=0;const s=newClock({time_control:'3+0'}),clock=new ComputerClock(s,{now:()=>now});clock.start('white');now=2000;clock.commit('white',1,{finished:true});now+=10000;clock.read();assert.equal(s.remaining.white,178000);assert(s.paused);
  assert.equal(clockText(0),'0:00');assert.equal(clockText(1),'0:01');assert.equal(clockText(61001),'1:02');assert.equal(clockText(3600000),'60:00');
 },
};
const scenario=process.argv[2];assert(cases[scenario]);await cases[scenario]();console.log(scenario+' passed');
