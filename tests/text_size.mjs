import test from 'node:test';
import assert from 'node:assert/strict';
import {applyTextSize,bindTextSizeSettings,fontScale,textSizeSettingsHtml} from '../static/text-size.js';
import {setLanguage} from '../static/i18n.js';
import {PreferencesService} from '../static/preferences-store.js';

const styles=new Map();
globalThis.document={documentElement:{style:{setProperty:(key,value)=>styles.set(key,value)}}};

function controls(value='100'){
 const select={value,disabled:false},status={textContent:'',classList:{add(){},remove(){}}};
 return {select,status,querySelector:selector=>selector==='#interface-font-scale'?select:status};
}

test('saved percentages scale the root and malformed preferences use normal size',()=>{
 for(const value of [100,110,125,150]){
  assert.equal(applyTextSize({font_scale:value}),value);
  assert.equal(styles.get('--ui-font-scale'),String(value/100));
 }
 for(const value of [undefined,null,'125',true,0,99,200,Infinity,{},[]])assert.equal(fontScale({font_scale:value}),100);
 assert.equal(applyTextSize(null),100);
 assert.equal(styles.get('--ui-font-scale'),'1');
});

test('the setting shows the saved size and translates its help and preview',()=>{
 setLanguage('en');
 const html=textSizeSettingsHtml({font_scale:125});
 assert.match(html,/<option value="125" selected>125 %<\/option>/);
 assert.match(html,/Text size throughout the interface/);
 assert.match(html,/Text preview/);
 assert.match(html,/saved in ChessGym/);
 assert.doesNotMatch(html,/Agrandit|Aperçu|Normale/);
 setLanguage('fr');
});

test('a successful save changes global text without overwriting unrelated preferences',async()=>{
 const host=controls(),writes=[],saved=[];
 bindTextSizeSettings(host,{preferencesService:{async patch(change){writes.push(change);return {font_scale:125,piece_set:'merida'};}},onSaved:value=>saved.push(value)});
 host.select.value='125';await host.select.onchange();
 assert.deepEqual(writes,[{font_scale:125}]);
 assert.equal(styles.get('--ui-font-scale'),'1.25');
 assert.equal(host.select.disabled,false);
 assert.equal(saved[0].piece_set,'merida');
 assert.match(host.status.textContent,/enregistrée/);
});

test('failed saves keep the last saved size and allow retry',async()=>{
 applyTextSize({font_scale:110});
 const host=controls('110');let fail=true;
 bindTextSizeSettings(host,{preferencesService:{async patch(){if(fail)throw Error('Connexion interrompue');return {font_scale:150};}}});
 host.select.value='150';await host.select.onchange();
 assert.equal(host.select.value,'110');
 assert.equal(styles.get('--ui-font-scale'),'1.1');
 assert.equal(host.select.disabled,false);
 assert.match(host.status.textContent,/Connexion interrompue/);
 fail=false;host.select.value='150';await host.select.onchange();
 assert.equal(styles.get('--ui-font-scale'),'1.5');
});

test('stale replies cannot change a replacement screen and duplicate changes wait for the save',async()=>{
 applyTextSize({font_scale:100});
 const host=controls();let current=true,resolve,calls=0;
 bindTextSizeSettings(host,{isCurrent:()=>current,preferencesService:{patch(){calls++;return new Promise(done=>{resolve=done;});}}});
 host.select.value='150';const pending=host.select.onchange();
 assert.equal(host.select.disabled,true);
 await host.select.onchange();assert.equal(calls,1);
 current=false;resolve({font_scale:150});await pending;
 assert.equal(styles.get('--ui-font-scale'),'1');
});

test('navigation keeps queued account saves and applies the size on the next screen',async()=>{
 const host=controls(),writes=[];let release,current=true;
 const service=new PreferencesService({request:async(url,{body})=>{
  writes.push(body);
  if(body.theme)await new Promise(done=>{release=done;});
  return body;
 }});
 service.open('reader',{initial:{font_scale:100}});
 service.subscribe(applyTextSize);
 const themeSave=service.patch({theme:'sage'});
 await Promise.resolve();
 bindTextSizeSettings(host,{preferencesService:service,isCurrent:()=>current,canSave:()=>true});
 host.select.value='150';const sizeSave=host.select.onchange();
 current=false;release();await themeSave;await sizeSave;
 assert.deepEqual(writes,[{theme:'sage'},{font_scale:150}]);
 assert.equal(service.get().font_scale,150);
 assert.equal(styles.get('--ui-font-scale'),'1.5');
 assert.doesNotMatch(host.status.textContent,/enregistrée/);
});
