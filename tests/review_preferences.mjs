import {setLanguage} from '../static/i18n.js';
import assert from 'node:assert/strict';
import {reviewDefaults,reviewMultipliers,reviewPreferencesHtml,reviewPreferencesPayload,bindReviewPreferences} from '../static/review-preferences.js';
import {TestNode} from './metadata_dom.mjs';
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const values=new Map(Object.entries({auto_mastery_days:'180',again:'10',hard:'2',medium:'5',easy:'10',new_limit:'',multiplier_hard:'1.2',multiplier_medium:'2',multiplier_easy:'3'}));
globalThis.FormData=class{constructor(form){this.values=form.values;}get(key){return this.values.get(key);}};
globalThis.document={getElementById:()=>({append(){}}),createElement:()=>({remove(){}})};
const timeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms)=>{const timer=timeout(fn,ms);if(ms>1000)timer.unref?.();return timer;};
function fixture(options={}){
 const host=new TestNode();host.innerHTML=reviewPreferencesHtml({},true);const form=host.querySelector('[id="review-preferences"]');form.values=new Map(values);form.removeAttribute=key=>delete form.attrs[key];const query=host.querySelector.bind(host);host.querySelector=selector=>selector==='#review-preferences'?form:query(selector);
 bindReviewPreferences(host,{supported:true,...options});return {host,form,submit:()=>form.onsubmit({preventDefault(){}})};
}
const tests={
 async queued_preferences_cannot_write_after_account_change(){
  let owner=true,release;const calls=[];const first=fixture({request:async(url,options)=>{calls.push(options);return await new Promise(resolve=>release=resolve);}});const second=fixture({canSave:()=>owner,request:async()=>{calls.push('wrong-account');return {};}});
  const a=first.submit(),b=second.submit();await tick();owner=false;release({auto_mastery_days:180});await a;await b;assert.equal(calls.length,1);assert.equal(second.form.getAttribute('aria-busy'),null);
 },
 english_defaults_are_translated_and_values_stay_numeric(){
  setLanguage('en');const html=reviewPreferencesHtml({auto_mastery_days:240,review_defaults:{hard:3}},true);assert.match(html,/Automatic mastery/);assert.match(html,/Interval growth/);assert.match(html,/name="multiplier_hard" type="number" value="1.2"[^>]*max="10"/);assert.match(html,/Initial values for new databases/);assert.doesNotMatch(html,/name="new_limit"/);assert.match(html,/name="hard" type="number" value="3"/);assert.match(html,/value="240"/);assert.doesNotMatch(html,/Maîtrise automatique|Enregistrer les révisions/);setLanguage('fr');
 },
 defaults_limits_and_capability_are_explicit(){
  assert.equal(reviewPreferencesHtml({},false),'');const html=reviewPreferencesHtml({},true);assert.match(html,/value="180"[^>]*max="3650"/);assert.match(html,/Valeurs initiales des nouvelles bases/);assert.doesNotMatch(html,/name="new_limit"/);assert.match(html,/ne change pas les bases existantes/);assert.deepEqual(reviewDefaults(),{again:10,hard:2,medium:5,easy:10});assert.deepEqual(reviewDefaults({review_defaults:{again:20,hard:1,new_limit:0}}),{again:20,hard:1,medium:5,easy:10});
  const body=reviewPreferencesPayload(values);assert.deepEqual(body,{auto_mastery_days:180,review_defaults:{again:10,hard:2,medium:5,easy:10},review_multipliers:{hard:1.2,medium:2,easy:3}});assert.deepEqual(reviewMultipliers(),{hard:1.2,medium:2,easy:3});const custom=new Map(values);custom.set('multiplier_hard','0.5');assert.equal(reviewPreferencesPayload(custom).review_multipliers.hard,0.5);const zero=new Map(values);zero.set('new_limit','0');assert.equal('new_limit' in reviewPreferencesPayload(zero).review_defaults,false);
 },
 async save_serializes_forms_and_recovers_after_failure(){
  const calls=[],pending=[],saved=[];const request=(url,options)=>{calls.push({url,options});return new Promise((resolve,reject)=>pending.push({resolve,reject}));};
  const first=fixture({request,onSaved:p=>saved.push(p)}),second=fixture({request,onSaved:p=>saved.push(p)});second.form.values.set('auto_mastery_days','365');
  const task1=first.submit(),task2=second.submit();await tick();assert.equal(calls.length,1);assert.equal(calls[0].options.body.auto_mastery_days,180);assert.equal(first.form.getAttribute('aria-busy'),'true');
  const log=console.error;console.error=()=>{};try{pending[0].reject(Error('indisponible'));await task1;await tick();}finally{console.error=log;}
  assert.equal(calls.length,2);assert.equal(calls[1].options.body.auto_mastery_days,365);assert.equal(first.form.values.get('hard'),'2');pending[1].resolve({auto_mastery_days:365,review_defaults:{again:10,hard:2,medium:5,easy:10}});await task2;assert.equal(saved.length,1);assert.equal(saved[0].auto_mastery_days,365);assert.equal(second.form.getAttribute('aria-busy'),null);
 },
 async old_server_and_stale_form_cannot_submit(){
  let calls=0;const host=new TestNode();host.innerHTML=reviewPreferencesHtml({},true);bindReviewPreferences(host,{supported:false,request:async()=>{calls++;}});assert.equal(host.querySelector('[id="review-preferences"]').onsubmit,undefined);
  const f=fixture({isCurrent:()=>false,request:async()=>{calls++;}});await f.submit();assert.equal(calls,0);
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario],scenario);await tests[scenario]();
