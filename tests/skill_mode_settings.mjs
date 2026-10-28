import test,{beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const sources={
 'api.js':`export const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';export const api=(...args)=>globalThis.request(...args);export const esc=value=>String(value??'');export const option=(value,label,selected)=>'<option value="'+value+'"'+(String(value)===String(selected)?' selected':'')+'>'+label+'</option>';export const fail=error=>{throw error;};export const time=value=>String(value);`,
 'training-history.js':`export const openTrainingHistory=options=>globalThis.openHistory(options);`,
 'training-statistics.js':`export const openTrainingStatistics=options=>globalThis.openStats(options);`,
 'training-settings.js':`export const openTrainingSettings=options=>globalThis.openSettings(options);`,
 'board.js':`export class Board{dispose(){}}`,
 'sound.js':`export const playSound=()=>{};`,
};
registerHooks({load(url,context,next){const source=Object.entries(sources).find(([name])=>url.endsWith('/static/'+name))?.[1];return source===undefined?next(url,context):{format:'module',shortCircuit:true,source};}});
const {CoordinateView,BlindfoldView}=await import('../static/training-skills.js');
const {ColorTrainingView}=await import('../static/color-training.js');
const host=()=>({innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]});
const makeForm=(values={})=>({values,elements:Object.fromEntries(Object.entries(values).map(([key,value])=>[key,{value,checked:!!value}])),querySelector:()=>null,querySelectorAll:()=>[]});
globalThis.FormData=class extends Map{constructor(form){super(Object.entries(form.values).filter(([,value])=>value!==false));}};
let settings,statistics,saves,requests;
beforeEach(()=>{
 settings=[];statistics=[];saves=[];requests=[];
 globalThis.request=async(...args)=>{requests.push(args);throw Error('Unexpected API write or read');};
 globalThis.openStats=async options=>{const dialog={options,closed:false,close(){this.closed=true;}};statistics.push(dialog);return dialog;};
 globalThis.openHistory=async()=>({close(){}});
 globalThis.openSettings=options=>{
  const form=makeForm({mode:'opening'}),submit={disabled:false},fields={innerHTML:''};
  const dialog={options,form,open:true,close(){this.open=false;},querySelector:selector=>selector==='form'?form:selector==='[type=submit]'?submit:fields};
  settings.push(dialog);options.onReady?.(form,dialog);return dialog;
 };
});

test('saved preferences accept only supported fields and values',()=>{
 const coordinates=new CoordinateView(host(),{initialSettings:{mode:'mixed',orientation:'black',duration:60,coordinates:true,session:{id:'bad'}}});
 assert.deepEqual(coordinates.config,{mode:'mixed',orientation:'black',duration:60,coordinates:true});assert.equal(coordinates.session,undefined);
 const invalid=new CoordinateView(host(),{initialSettings:{mode:'bad',orientation:'bad',duration:-1,coordinates:'false'}});
 assert.deepEqual(invalid.config,{mode:'coordinates',orientation:'white',duration:30,coordinates:false});
 const blind=new BlindfoldView(host(),{initialSettings:{mode:'endgame',input:'text',rating_min:500,rating_max:3000,max_moves:20,max_pieces:9,hide_prompt:false,reconstruct_after:false,base_id:8,entry_id:88,document:{nodes:[]}}});
 // Legacy endgame preferences migrate to the current Positions mode.
 assert.equal(blind.config.mode,'positions');assert.equal(blind.config.max_pieces,9);assert.equal(blind.config.hide_prompt,false);assert.equal(blind.baseId,8);assert.equal(blind.config.entry_id,88);assert.equal(blind.config.document,undefined);assert.equal(blind.config.base_id,undefined);
 const color=new ColorTrainingView(host(),{initialSettings:{duration:60}});assert.equal(color.duration,60);color.dispose();
 const badColor=new ColorTrainingView(host(),{initialSettings:{duration:31}});assert.equal(badColor.duration,30);badColor.dispose();
});

test('settings fields reuse each mode options without a start button',()=>{
 const coordinates=new CoordinateView(host());coordinates.showSettings();
 assert.match(settings[0].options.html,/name="mode"/);assert.match(settings[0].options.html,/name="orientation"/);assert.match(settings[0].options.html,/name="duration"/);assert.match(settings[0].options.html,/name="coordinates"/);
 const blind=new BlindfoldView(host(),{initialSettings:{rated:false}});blind.showSettings();assert.match(settings[1].options.html,/name="rating_min"/);assert.match(settings[1].options.html,/name="reconstruct_after"/);
 const color=new ColorTrainingView(host());color.showSettings();assert.match(settings[2].options.html,/name="duration"/);
 for(const dialog of settings)assert.doesNotMatch(dialog.options.html,/<form|type="submit"|Préparer l’exercice|>Commencer</);
 coordinates.dispose();blind.dispose();color.dispose();
});

test('saving coordinate preferences preserves a completed result and cancel never persists',()=>{
 const view=new CoordinateView(host(),{onSettingsChange:value=>saves.push(value)});view.render=()=>{};
 const result={id:'completed',finished:true,result:{score:9}};view.session=result;
 view.showSettings();settings[0].close();assert.equal(view.config.duration,30);assert.equal(saves.length,0);
 view.showSettings();settings[1].options.onSubmit(new Map([['mode','notation'],['orientation','random'],['duration','60'],['coordinates','on']]));
 assert.equal(view.session,result);assert.equal(view.config.duration,60);assert.equal(view.config.mode,'notation');assert.equal(saves.length,1);assert.notEqual(saves[0],view.config);assert.deepEqual(requests,[]);view.dispose();
});

test('saving Color duration preserves the result and persists only the preference',()=>{
 const view=new ColorTrainingView(host(),{onSettingsChange:value=>saves.push(value)});view.render=()=>{};
 const result={id:'completed',finished:true,result:{score:10}};view.session=result;
 view.showSettings();settings[0].options.onSubmit(new Map([['duration','60']]));
 assert.equal(view.session,result);assert.equal(view.duration,60);assert.deepEqual(saves,[{duration:60}]);assert.deepEqual(requests,[]);view.dispose();
});

test('blindfold settings save a draft including unchecked choices without replacing the result',()=>{
 const view=new BlindfoldView(host(),{initialSettings:{rated:false},onSettingsChange:value=>saves.push(value)});view.render=()=>{};view.baseId=8;
 const result={id:'completed',finished:true,result:{success:true}};view.session=result;
 view.showSettings();const form=makeForm({mode:'positions',rated:false,input:'text',rating_min:'500',rating_max:'2500',max_pieces:'8',hide_prompt:false,reconstruct_after:false});
 settings[0].options.onSubmit(new FormData(form),form);
 assert.equal(view.session,result);assert.equal(view.config.mode,'positions');assert.equal(view.config.rated,false);assert.equal(view.config.max_pieces,8);assert.equal(view.config.reconstruct_after,false);assert.equal(view.config.hide_prompt,false);assert.equal(saves[0].base_id,8);assert.equal(view.config.base_id,undefined);assert.deepEqual(requests,[]);view.dispose();
});

test('rated blindfold settings allow optional reconstruction and hide manual difficulty',()=>{
 const view=new BlindfoldView(host(),{onSettingsChange:value=>saves.push(value)});view.render=()=>{};
 view.showSettings();
 assert.match(settings[0].options.html,/name="rated" checked/);
 assert.doesNotMatch(settings[0].options.html,/name="(?:rating_min|rating_max)"/);
 assert.match(settings[0].options.html,/name="reconstruct_after" checked/);
 const form=makeForm({mode:'positions',rated:true,input:'text',hide_prompt:false,reconstruct_after:false});
 settings[0].options.onSubmit(new FormData(form),form);
 assert.equal(view.config.rated,true);assert.equal(view.config.hide_prompt,true);assert.equal(view.config.reconstruct_after,false);
 assert.equal(saves[0].reconstruct_after,false);assert.deepEqual(requests,[]);view.dispose();
});

test('active sessions cannot open settings or statistics or replace an earlier preference',async()=>{
 for(const View of [CoordinateView,BlindfoldView,ColorTrainingView]){
  const view=new View(host(),{onSettingsChange:value=>saves.push(value)});view.render=()=>{};view.showSettings();const saved=settings.at(-1);
  const current={id:'active',finished:false};view.session=current;view.showSettings();await view.showStatistics();
  saved.options.onSubmit(new Map([['duration','60']]),makeForm({mode:'endgame'}));
  assert.equal(view.session,current);assert.equal(saves.length,0);assert.equal(statistics.length,0);view.dispose();
 }
 assert.equal(settings.length,3);assert.deepEqual(requests,[]);
});

test('statistics are scoped to each mode, disposed with the view, and do not change results',async()=>{
 for(const [View,tool] of [[CoordinateView,'coordinates'],[BlindfoldView,'blindfold'],[ColorTrainingView,'color']]){
  const view=new View(host());view.session={id:'completed',finished:true};const result=view.session;
  await view.showStatistics();assert.equal(statistics.at(-1).options.tool,tool);assert.equal(view.session,result);
  view.dispose();assert.equal(statistics.at(-1).closed,true);
 }
 assert.deepEqual(requests,[]);
});

test('a statistics dialog resolving after disposal is immediately closed',async()=>{
 let release;globalThis.openStats=()=>new Promise(resolve=>release=resolve);
 const view=new CoordinateView(host()),pending=view.showStatistics();
 while(!release)await new Promise(resolve=>setImmediate(resolve));view.dispose();
 const dialog={closed:false,close(){this.closed=true;}};release(dialog);await pending;assert.equal(dialog.closed,true);assert.equal(view.statisticsDialog,undefined);
});

test('restoring reconstruction preferences uses the saved base and catalogue page',async()=>{
 const view=new BlindfoldView(host(),{initialSettings:{mode:'reconstruct',base_id:8,entry_id:88}});view.render=()=>{};
 globalThis.request=async url=>{requests.push(url);if(url.endsWith('/history'))return {history:[]};if(url.endsWith('/bases'))return {bases:[{id:1,name:'First'},{id:8,name:'Saved'}]};return {entries:[{id:88,title:'Saved game'}],total:120,offset:50};};
 await view.load();assert.equal(view.baseId,8);assert.equal(view.config.entry_id,88);assert.equal(view.entryOffset,50);assert.match(requests.at(-1),/\/api\/bases\/8\/entries.*around_id=88/);view.dispose();
});
