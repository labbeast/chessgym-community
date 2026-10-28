import test from 'node:test';
import assert from 'node:assert/strict';
import {trainingClockText,trainingToolbarDisplay} from '../static/training-session-bar.js';
import {setLanguage} from '../static/i18n.js';

test('countdowns round up the last second and support hour-long sessions',()=>{
 assert.equal(trainingClockText(1,{countdown:true}),'00:01');
 assert.equal(trainingClockText(754999,{countdown:true}),'12:35');
 assert.equal(trainingClockText(754999),'12:34');
 assert.equal(trainingClockText(3_661_000),'1:01:01');
 assert.equal(trainingClockText(null),'—');
});
test('unknown durations are never converted to elapsed or invented remaining time',()=>{
 const view=trainingToolbarDisplay({clockType:'unknown',elapsedMs:null,remainingMs:null});
 assert.equal(view.clock,'—');assert.equal(view.progress,null);
 const elapsed=trainingToolbarDisplay({clockType:'elapsed',elapsedMs:95000,targetMs:null});
 assert.equal(elapsed.clock,'01:35');assert.equal(elapsed.progress,null);
});
test('programme goals permit explicit overtime while challenge clocks stop at zero',()=>{
 const program={program:true,clockType:'countdown',targetMs:1200000,elapsedMs:1215000,remainingMs:0};
 const view=trainingToolbarDisplay(program);assert.equal(view.clock,'+00:15');assert.equal(view.reached,true);assert.equal(view.progress,1);
 const challenge=trainingToolbarDisplay({...program,program:false});assert.equal(challenge.clock,'00:00');assert.equal(challenge.reached,false);
 const paused=trainingToolbarDisplay({...program,paused:true});assert.equal(paused.clock,'+00:15');assert.match(paused.status,/pause|Paused/);
});
test('quantity progress remains independent of a clock and never exceeds its bounds',()=>{
 const view=trainingToolbarDisplay({clockType:'unknown',progress:{value:8,max:20}});assert.equal(view.progress,.4);assert.equal(view.clock,'—');
 assert.equal(trainingToolbarDisplay({progress:1.4}).progress,1);
 assert.equal(trainingToolbarDisplay({progress:-.2}).progress,0);
});

test('a scoped exercise goal displays counts alongside the actual elapsed timer',()=>{
 setLanguage('en');
 const context={program:true,clockType:'quantity',goalMetric:'quantity',quantityUnit:'positions',remainingQuantity:7,targetQuantity:10,completedQuantity:3,elapsedMs:123000,targetMs:null,progress:.3};
 const view=trainingToolbarDisplay(context);assert.equal(view.clock,'02:03');assert.equal(view.quantity,'3 / 10 exercises');assert.equal(view.progress,.3);assert.equal(view.reached,false);
 const complete=trainingToolbarDisplay({...context,remainingQuantity:0,completedQuantity:12,progress:1});assert.equal(complete.clock,'02:03');assert.equal(complete.quantity,'12 / 10 exercises');assert.equal(complete.reached,true);assert.equal(complete.status,'Target reached');
 const paused=trainingToolbarDisplay({...context,paused:true});assert.equal(paused.clock,'02:03');assert.equal(paused.status,'Paused');
 setLanguage('fr');const cards=trainingToolbarDisplay({...context,quantityUnit:'cards'});assert.equal(cards.quantity,'3 / 10 cartes');
});

test('quantity goals never fabricate time when only a measured count is available',()=>{
 const context={program:true,clockType:'quantity',goalMetric:'quantity',quantityUnit:'cards',remainingQuantity:12,targetQuantity:20,completedQuantity:8};
 const view=trainingToolbarDisplay(context);assert.equal(view.clock,'—');assert.equal(view.quantity,'8 / 20 cartes');
 const timed=trainingToolbarDisplay({...context,elapsedMs:446000,clockLabel:'Temps enregistré'});assert.equal(timed.clock,'07:26');assert.equal(timed.label,'Temps enregistré');
});

test('free review shows its measured card count without inventing a programme goal',()=>{
 const view=trainingToolbarDisplay({activity:'review',clockType:'elapsed',elapsedMs:446000,completed:8,total:20});
 assert.equal(view.clock,'07:26');assert.equal(view.quantity,'8 / 20 cartes');assert.equal(view.reached,false);
});

test('session targets show the remaining episode count alongside the normal timer status',()=>{
 setLanguage('en');
 const view=trainingToolbarDisplay({program:true,clockType:'countdown',goalMetric:'sessions',remainingQuantity:2,targetMs:900000,remainingMs:840000,elapsedMs:60000});
 assert.equal(view.clock,'14:00');assert.equal(view.status,'In progress · 2 sessions remaining');assert.equal(view.reached,false);
 setLanguage('fr');
});
