import test from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage} from '../static/i18n.js';
import {globalSettingsHtml} from '../static/settings-page.js';
import {startupPreferences,saveStartupPreferences,startupSettingsHtml} from '../static/startup-settings.js';
import {resourcePayload,resourceSettingsHtml} from '../static/resource-settings.js';
import {backupSettingsPayload,backupSettingsHtml} from '../static/backup-settings.js';
import {learningPayload,learningSettingsHtml} from '../static/learning-settings.js';

test('startup preferences validate independently from account settings',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 assert.deepEqual(startupPreferences(storage),{page:'library',resume:'never'});
 saveStartupPreferences({page:'reviews',resume:'auto'},storage);
 assert.deepEqual(startupPreferences(storage),{page:'reviews',resume:'auto'});
 saveStartupPreferences({page:'unknown',resume:'destroy'},storage);
 assert.deepEqual(startupPreferences(storage),{page:'library',resume:'never'});
 assert.deepEqual(startupPreferences({getItem(){throw new Error('blocked')}}),{page:'library',resume:'never'});
});
test('legacy startup prompts become initial-screen preferences without changing the chosen page',()=>{
 for(const resume of ['ask','invalid',undefined]){
  const saved={page:'board',resume};
  assert.deepEqual(startupPreferences({getItem:()=>JSON.stringify(saved)}),{page:'board',resume:'never'});
  let stored;
  assert.deepEqual(saveStartupPreferences(saved,{setItem:(key,value)=>{stored=JSON.parse(value);}}),{page:'board',resume:'never'});
  assert.deepEqual(stored,{page:'board',resume:'never'});
 }
});
test('startup settings offer automatic resume and the initial screen without a popup choice',()=>{
 for(const language of ['en','fr']){
  setLanguage(language);
  const html=startupSettingsHtml();
  assert.match(html,/<select name="page">/);
  assert.match(html,/<option value="auto">/);
  assert.match(html,/<option value="never" selected>/);
  assert.doesNotMatch(html,/<option value="ask"/);
  assert.doesNotMatch(html,/Proposer la reprise/);
 }
 setLanguage('fr');
});
test('forms preserve empty goals and explicit resource budgets',()=>{
 assert.deepEqual(learningPayload(new Map([['timezone','America/Toronto'],['start_hour','4'],['minutes',''],['cards','30']])),{study_day:{timezone:'America/Toronto',start_hour:4},review_session_defaults:{minutes:null,cards:30}});
 assert.deepEqual(resourcePayload(new Map([['profile','custom'],['total_threads','14'],['hash_mb','128'],['import_workers','12']])),{profile:'custom',total_threads:14,hash_mb:128,import_workers:12});
 assert.deepEqual(backupSettingsPayload(new Map([['enabled','on'],['keep','7'],['interval_hours','24'],['destination',' C:/backup ']])),{enabled:true,keep:7,interval_hours:24,destination:'C:/backup'});
});
test('settings are bilingual and never translate or interpret custom base names',()=>{
 setLanguage('en');
 assert.match(startupSettingsHtml(),/On startup/);
 assert.match(resourceSettingsHtml(),/Server performance/);
 assert.match(backupSettingsHtml(),/Backups/);
 const html=learningSettingsHtml({},[{id:1,name:'Bibliothèque <script>mine</script>'},{id:2,name:'Reference',reference:true}]);
 assert.match(html,/Study day and sessions/);
 assert.match(html,/Bibliothèque &lt;script&gt;mine&lt;\/script&gt;/);
 assert.doesNotMatch(html,/data-default-base="2"/);
 setLanguage('fr');
});

test('local settings contain no account, password or sign-out controls',()=>{
 const html=globalSettingsHtml({status:{username:'private-legacy-name',local_mode:true,capabilities:{setup_resources:true}}});
 assert.match(html,/data-settings-tab="installation"/);
 assert.doesNotMatch(html,/data-settings-tab="account"|data-action="logout"|type="password"|private-legacy-name|Compte personnel/);
});
