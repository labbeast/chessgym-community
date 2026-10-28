import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
registerHooks({load(url,context,next){
 if(url.endsWith('/static/sound.js'))return {format:'module',shortCircuit:true,source:'export const playSound=name=>globalThis.sounds.push(name);'};
 return next(url,context);
}});
globalThis.sounds=[];
const listeners=new Map();
globalThis.document={addEventListener:(event,fn)=>listeners.set(event,fn),removeEventListener:(event,fn)=>{if(listeners.get(event)===fn)listeners.delete(event);},querySelector:()=>null};
const {ColorTrainingView,colorChoicesHtml,colorRecordsHtml,colorRecordEligible}=await import('../static/color-training.js');
const {setLanguage}=await import('../static/i18n.js');
const scenario=process.argv[2],host={innerHTML:'',querySelector:()=>null,querySelectorAll:()=>[]};
const initial=()=>({id:'s',config:{duration:30},target:{square:'a1'},index:0,nonce:'nonce-zero',score:0,errors:0,answered:0,started_at:null,deadline:null,server_time:100,finished:false,result:null,last_answer:null});
const create=request=>{const view=new ColorTrainingView(host,{request,now:()=>100000});view.render=()=>{};view.accept(initial());return view;};
const later=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
if(scenario==='clock_starts_with_first_answer_and_uses_server_time'){
 let now=100000;const view=new ColorTrainingView(host,{now:()=>now});view.accept(initial());now=110000;assert.equal(view.remaining(),30);
 view.accept({...initial(),started_at:110,deadline:140,server_time:110});assert.equal(view.remaining(),30);now=120100;assert.equal(view.remaining(),20);now=150000;assert.equal(view.remaining(),0);view.dispose();
}
if(scenario==='answer_receipt_prevents_duplicate_click_and_advances_wrong_answer'){
 const pending=later(),calls=[];const view=create(async(...args)=>{calls.push(args);return pending.promise;});
 const first=view.answer('white'),second=view.answer('white');assert.equal(calls.length,1);assert.deepEqual(calls[0][1].body,{index:0,nonce:'nonce-zero',color:'white'});
 pending.resolve({...initial(),index:1,nonce:'nonce-one',errors:1,answered:1,target:{square:'h2'},last_answer:{index:0,square:'a1',color:'white',correct:false}});await Promise.all([first,second]);
 assert.equal(view.session.target.square,'h2');assert.equal(view.session.errors,1);assert.equal(view.session.score,0);assert.equal(sounds.at(-1),'incorrect');assert.equal(view.busy,false);view.dispose();
}
if(scenario==='lost_answer_response_recovers_without_resubmitting'){
 const calls=[];const view=create(async(path,options)=>{calls.push([path,options]);if(options?.method==='POST')throw Error('Lost response');return {...initial(),index:1,nonce:'new-nonce',score:1,target:{square:'a2'}};});
 await view.answer('black');assert.equal(calls.length,2);assert.equal(calls[1][0],'/api/skills/color/s');assert.equal(view.session.score,1);assert.equal(view.busy,false);view.dispose();
}
if(scenario==='recover_locks_answers_and_ignores_obsolete_session'){
 const gate=later(),calls=[];const view=create(async(...args)=>{calls.push(args);return gate.promise;});
 const recovered=view.recover();assert.equal(view.busy,true);await view.answer('white');await view.recover();assert.equal(calls.length,1);
 gate.resolve({...initial(),index:1,nonce:'next',score:1});await recovered;assert.equal(view.session.score,1);assert.equal(view.busy,false);
 const pending=later();view.request=()=>pending.promise;const obsolete=view.recover();view.session={...initial(),id:'other'};pending.resolve({...initial(),score:9});await obsolete;assert.equal(view.session.id,'other');assert.equal(view.session.score,0);view.dispose();
}
if(scenario==='stale_history_errors_do_not_overwrite_current_view'){
 const pending=later();const view=create(()=>pending.promise);const old=view.load();view.sequence++;view.error='current';pending.reject(Error('stale'));await old;assert.equal(view.error,'current');
 const finishing=later();view.request=()=>finishing.promise;view.session={...initial(),finished:true,result:{record_eligible:true}};const completed=view.completed();view.sequence++;finishing.reject(Error('old result'));await completed;assert.equal(view.error,'current');view.dispose();
}
if(scenario==='keyboard_respects_browser_shortcuts_forms_and_dialogs'){
 const view=create(()=>{}),answers=[];view.answer=async color=>answers.push(color);let prevented=0;
 const event=extra=>({key:'ArrowLeft',preventDefault:()=>prevented++,...extra});
 view.key(event({}));view.key(event({key:'ArrowRight'}));assert.deepEqual(answers,['white','black']);assert.equal(prevented,2);
 for(const modifier of ['altKey','ctrlKey','metaKey','shiftKey','isComposing','repeat','defaultPrevented'])view.key(event({[modifier]:true}));
 view.key(event({target:{closest:()=>({})}}));document.querySelector=()=>({});view.key(event({}));document.querySelector=()=>null;
 assert.equal(answers.length,2);view.session.finished=true;view.key(event({}));assert.equal(answers.length,2);view.dispose();assert.equal(listeners.has('keydown'),false);
}
if(scenario==='record_eligibility_is_explicit_and_durations_are_separate'){
 assert.equal(colorRecordEligible({accuracy:100,errors:1,record_eligible:false}),false);assert.equal(colorRecordEligible({accuracy:100}),false);assert.equal(colorRecordEligible({record_eligible:true}),true);
 const html=colorRecordsHtml({records:[{duration:60,score:99},{config:{duration:30},score:12}],history:[{finished_at:100,duration:30,score:10,errors:1,accuracy:90.9,record_eligible:false}]});
 assert(html.indexOf('>12</strong>')<html.indexOf('>99</strong>'));assert(!html.includes('90.9 % ✓'));assert.match(colorChoicesHtml(true),/data-color="white" disabled/);
 const view=create(()=>{});view.session={...initial(),finished:true,result:{score:10,accuracy:100,errors:1,record_eligible:false}};assert.match(view.sessionHtml(),/Résultat hors records/);assert.doesNotMatch(view.sessionHtml(),/Sans faute/);view.dispose();
}
if(scenario==='english_and_untrusted_square_text_are_safe'){
 const view=create(()=>{});setLanguage('en');assert.match(view.setupHtml(),/The timer starts with your first answer/);assert.match(view.setupHtml(),/Duration/);assert.match(colorChoicesHtml(),/>White</);assert.match(colorChoicesHtml(),/>Dark</);
 view.session.target.square='<svg onload=alert(1)>';const html=view.sessionHtml();assert(!html.includes('<SVG'));assert(html.includes('&lt;SVG'));setLanguage('fr');view.dispose();
}
if(scenario==='settings_cannot_replace_session_during_replay'){
 const gate=later(),elements=new Map(),scope={innerHTML:'',querySelector:selector=>elements.get(selector)||null,querySelectorAll:()=>[...elements.values()]};
 const settings={disabled:false,addEventListener:(event,callback)=>settings.click=callback};elements.set('[data-color-settings]',settings);
 const view=new ColorTrainingView(scope,{request:()=>gate.promise,now:()=>100000});view.session={...initial(),finished:true,result:{record_eligible:true}};view.render();const replay=view.start(30);assert(settings.disabled);settings.click();assert.equal(view.session.finished,true);
 gate.resolve({...initial(),id:'new'});await replay;assert.equal(view.session.id,'new');assert.equal(settings.disabled,false);view.dispose();
}
if(scenario==='disposed_answer_is_ignored_and_premature_finish_is_retried'){
 const gate=later();const view=create(()=>gate.promise);const answer=view.answer('black');view.dispose();gate.resolve({...initial(),score:1});await answer;assert.equal(view.session.score,0);
 const second=create(async()=>{throw Object.assign(Error('Early'),{status:409});});second.session.deadline=100;await second.finish();assert.equal(second.error,'');assert.equal(second.busy,false);assert.equal(second.session.finished,false);second.dispose();
}
console.log('PASS '+scenario);
