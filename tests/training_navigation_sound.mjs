import assert from 'node:assert/strict';
import {SoundPlayer,moveSound} from '../static/sound.js';
import {NAV_GROUPS,activeNavigationGroup,desktopNavigationHtml,mobileNavigationHtml,navigationLabel} from '../static/main-navigation.js';
import {boardMenuHtml} from '../static/board-menu.js';
import {routeFromHash,routeHash} from '../static/section-navigation.js';
import {setLanguage} from '../static/i18n.js';

const flushAudio=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
function audioHarness({fetchSample,decodeSample,resume}={}){
 const requests=[],decodes=[],played=[];let created=0;
 const context={
  state:resume?'suspended':'running',currentTime:1,destination:{},
  resume(){return resume().then(()=>{context.state='running';});},
  async decodeAudioData(bytes){const file=new TextDecoder().decode(bytes);decodes.push(file);return decodeSample?decodeSample(file):{file};},
  createGain(){return {gain:{value:0},connect(){},disconnect(){}};},
  createBufferSource(){return {buffer:null,connect(gain){this.gain=gain;},disconnect(){},start(){played.push({file:this.buffer.file,volume:this.gain.gain.value});}};}
 };
 const sound=new SoundPlayer({contextFactory:()=>{created++;return context;},fetchAudio:async url=>{
  assert.match(url.pathname,/\/sounds\/kenney\//);const file=url.pathname.split('/').at(-1);requests.push(file);
  if(fetchSample)await fetchSample(file);
  return {ok:true,arrayBuffer:async()=>new TextEncoder().encode(file).buffer};
 }});
 return {sound,context,requests,decodes,played,get created(){return created;}};
}

const audio=audioHarness(),{sound,context}=audio;
sound.configure({enabled:false});assert.equal(sound.play('move'),false);assert.equal(audio.created,0);
sound.configure({enabled:true,volume:0});assert.equal(sound.play('correct'),false);assert.equal(audio.created,0);
sound.configure({navigation:false});assert.equal(sound.play('move',{navigation:true}),false);assert.equal(audio.created,0);
assert.equal(sound.play('unknown'),false);assert.equal(audio.created,0);assert.deepEqual(audio.requests,[]);
sound.configure({volume:.42});
assert.equal(sound.play('capture'),true);assert.equal(sound.play('capture'),true);
await flushAudio();
assert.deepEqual(audio.played,[{file:'capture.wav',volume:.42},{file:'capture.wav',volume:.42}]);
const samples=['capture.wav','complete.wav','correct.wav','incorrect.wav','move.wav'];
assert.deepEqual([...audio.requests].sort(),samples);assert.deepEqual([...audio.decodes].sort(),samples);
for(const event of ['move','castle','correct','incorrect','complete']){context.currentTime++;assert.equal(sound.play(event),true);}
assert.deepEqual(audio.played.slice(2).map(note=>note.file),['move.wav','move.wav','correct.wav','incorrect.wav','complete.wav']);
assert.equal(sound.play('move'),false,'feedback must remain audible over an immediately following move');
assert.equal(audio.requests.length,5);assert.equal(audio.decodes.length,5);assert.equal(audio.created,1);

const previous=audio.played.length;
sound.configure({moves:false});assert.equal(sound.play('move'),false);assert.equal(audio.played.length,previous);assert.equal(sound.play('correct'),true);
sound.configure({feedback:false});assert.equal(sound.play('complete'),false);
sound.configure({navigation:true});context.currentTime++;assert.equal(sound.play('castle',{navigation:true}),true);
sound.configure({enabled:false});assert.equal(sound.play('capture'),false);assert.equal(audio.played.length,previous+2);

// The first gesture may need both the sample and the browser's audio resume.
const resumed=deferred(),first=audioHarness({resume:()=>resumed.promise});
assert.equal(first.sound.play('capture'),true);await flushAudio();assert.deepEqual(first.played,[]);
resumed.resolve();await flushAudio();assert.deepEqual(first.played,[{file:'capture.wav',volume:.35}]);

// A preference changed during loading applies before the pending sound starts.
for(const preferences of [{enabled:false},{volume:0},{moves:false},{navigation:false}]){
 const pending=deferred(),queued=audioHarness({fetchSample:file=>file==='move.wav'?pending.promise:undefined});
 queued.sound.configure({navigation:true});assert.equal(queued.sound.play('move',{navigation:true}),true);
 queued.sound.configure(preferences);pending.resolve();await flushAudio();assert.deepEqual(queued.played,[]);
}

// A settings preview keeps the temporary slider volume when saved settings return.
const previewReady=deferred(),preview=audioHarness({fetchSample:file=>file==='move.wav'?previewReady.promise:undefined});
preview.sound.configure({moves:false,volume:.73});assert.equal(preview.sound.play('move',{preview:true}),true);
preview.sound.configure({enabled:false,volume:.2});previewReady.resolve();await flushAudio();
assert.deepEqual(preview.played,[{file:'move.wav',volume:.73}]);

// Download/decode failures are contained, and a later interaction can retry.
const unhandled=[],onUnhandled=error=>unhandled.push(error);process.on('unhandledRejection',onUnhandled);
try{
 for(const stage of ['fetch','decode']){
  let failing=true;
  const retry=audioHarness({
   fetchSample:async file=>{if(stage==='fetch'&&failing&&file==='move.wav')throw new Error('Offline');},
   decodeSample:async file=>{if(stage==='decode'&&failing&&file==='move.wav')throw new Error('Bad audio');return {file};}
  });
  assert.equal(retry.sound.play('move'),true);await flushAudio();assert.deepEqual(retry.played,[]);
  failing=false;assert.equal(retry.sound.play('move'),true);await flushAudio();
  assert.deepEqual(retry.played,[{file:'move.wav',volume:.35}]);
  assert.equal(retry.requests.filter(file=>file==='move.wav').length,2);
 }
 assert.deepEqual(unhandled,[]);
}finally{process.off('unhandledRejection',onUnhandled);}
assert.equal(moveSound('O-O-O'),'castle');assert.equal(moveSound('Nxe5+'),'capture');assert.equal(moveSound('e4'),'move');

for(const page of ['puzzles','guess','blindfold','coordinates','color','reviews','reading','computer','computer-history','training-history']){assert.equal(activeNavigationGroup(page),'training');assert.equal(routeFromHash(routeHash({page})).page,page);}
assert(desktopNavigationHtml('computer-history').includes('data-page="exercises" aria-current="page"'));
assert(mobileNavigationHtml('computer-history').includes('data-page="exercises" aria-current="page"'));
assert.equal(activeNavigationGroup('base'),'library');assert.equal(activeNavigationGroup('board'),null);
assert.deepEqual(NAV_GROUPS[0].items.map(([id])=>id),['library','played','repertoire']);
const desktop=desktopNavigationHtml('guess'),mobile=mobileNavigationHtml('guess');
assert(desktop.includes('data-page="exercises" aria-current="page"'));assert(mobile.includes('data-page="exercises" aria-current="page"'));
assert.equal((desktop.match(/<details class="navigation-group(?: [^"]*)?"/g)||[]).length,3);
const boardMenu=boardMenuHtml({current:{identity:'entry:1',title:'A saved game',draft:false},recents:[{identity:'free:draft',title:'My draft',draft:true}]});
function assertMobileMenus(page,active,labels){
 const html=mobileNavigationHtml(page,{boardMenu});
 assert.match(html,/^<nav class="mobile-navigation" aria-label="[^"]+">/);
 assert.doesNotMatch(html,/☰|<details class="mobile-navigation"/);
 const menus=[...html.matchAll(/<details\b([^>]*data-navigation-section="([^"]+)"[^>]*)><summary\b([^>]*)>/g)];
 assert.deepEqual(menus.map(([, ,id])=>id),['library','training','board']);
 for(const [,attributes,id,summary] of menus){
  assert.doesNotMatch(attributes,/\sopen(?:\s|=|$)/,id+' must start closed, including the active menu');
  assert.match(attributes,new RegExp('data-active="'+(id===active)+'"'));
  assert.match(summary,new RegExp('aria-label="'+labels[id]+'"'),id+' icon must retain an accessible name');
 }
 assert.equal((html.match(/<svg class="navigation-icon"/g)||[]).length,3);
 assert.equal((html.match(/class="mobile-navigation-dropdown"/g)||[]).length,3);
 assert.doesNotMatch(html,/data-board-command="library"/);
 // The Board contents still expose current, new and saved drafts through this dropdown.
 for(const command of ['current','new','manage'])assert.match(html,new RegExp('data-board-command="'+command+'"'));
 assert.match(html,/data-board-recent="free:draft"/);
}
setLanguage('fr');
const frenchLabels={library:'Bibliothèque',training:'Entraînement',board:'Échiquier'};
assertMobileMenus('guess','training',frenchLabels);
assertMobileMenus('base','library',frenchLabels);
assertMobileMenus('board','board',frenchLabels);
assertMobileMenus('settings',null,frenchLabels);
setLanguage('en');
assert(desktopNavigationHtml('puzzles').includes('Training'));
assert(mobileNavigationHtml('coordinates').includes('Exercises'));assert.equal(navigationLabel('coordinates'),'Coordinates');
assertMobileMenus('computer-history','training',{library:'Library',training:'Training',board:'Board'});
setLanguage('fr');
console.log('PASS sounds, account-independent controls, grouped navigation and history routes');
