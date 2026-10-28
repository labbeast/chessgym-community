import test from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage} from '../static/i18n.js';
import {reviewPreferencesHtml,reviewPreferencesPayload} from '../static/review-preferences.js';
import {reviewBasesTableHtml} from '../static/review-bases.js';
import {TestNode} from './metadata_dom.mjs';

globalThis.FormData=class{constructor(form){this.form=form;}get(key){const input=this.form.querySelector('[name="'+key+'"]');return input?.attrs.type==='checkbox'?(input.checked?'on':null):input?.value??null;}};
const bases=[{id:1,name:'Révisions <unsafe>',settings:{review_enabled:true}},{id:2,name:'Deuxième',settings:{review_enabled:true}},{id:3,name:'Inactive',settings:{review_enabled:false}},{id:4,name:'Reference',reference:true,settings:{review_enabled:true}}];
test('maintenance preferences preserve independent base defaults and old server compatibility',()=>{
 const legacy=reviewPreferencesHtml({},true,false);assert.doesNotMatch(legacy,/name="maintenance_/);
 const host=new TestNode();host.innerHTML=reviewPreferencesHtml({review_maintenance:{enabled:false,interval_days:45,daily_limit:3}},true,true);
 const payload=reviewPreferencesPayload(new FormData(host));assert.deepEqual(payload.review_maintenance,{enabled:false,interval_days:45,daily_limit:3});assert.equal('new_limit' in payload.review_defaults,false);
 setLanguage('en');const english=reviewPreferencesHtml({},true,true);assert.match(english,/Maintain mastered cards/);assert.match(english,/Maximum reminders per day/);assert.doesNotMatch(english,/Entretien des acquis/);setLanguage('fr');
});

test('fully mastered databases remain reviewable when maintenance reminders are due',()=>{
 const html=reviewBasesTableHtml([{base_id:1,name:'Mastered',type:'solve',total:12,mastered:12,learned:12,due:0,maintenance_due:2}],bases);
 assert.match(html,/2 rappels d’entretien dus/);assert.match(html,/data-review="1">Réviser/);assert.doesNotMatch(html,/data-review="1" disabled/);
});
