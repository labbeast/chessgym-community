import test from 'node:test';
import assert from 'node:assert/strict';
import {setLanguage} from '../static/i18n.js';
import {globalSettingsHtml} from '../static/settings-page.js';
import {appUpdateRunning,appUpdateStatusHtml,appUpdatesSettingsHtml,bindAppUpdates} from '../static/app-updates.js';

const snapshot={current_version:'0.1.0',supported:true,reason:null,settings:{automatic_updates:false,interval_hours:168},available:null,job:null,restart_required:false};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
function host(){
 const parts=new Map(),part=selector=>{if(!parts.has(selector))parts.set(selector,{innerHTML:'',textContent:'',disabled:false,checked:false,hidden:false,classList:{toggle(){}}});return parts.get(selector);};
 const root={innerHTML:'',querySelector:part};return {root,parts,querySelector:()=>root};
}
function click(page,key){page.root.onclick({target:{closest:()=>({disabled:false,dataset:{[key]:''}})}});}
function submit(page){page.root.onsubmit({target:{matches:()=>true},preventDefault(){}});}

test('application updates are available in Installation through their own capability',()=>{
 assert.doesNotMatch(globalSettingsHtml(),/id="app-updates-settings"/);
 const html=globalSettingsHtml({status:{capabilities:{app_updates:true}}});
 assert.match(html,/data-settings-tab="installation"/);assert.match(html,/id="app-updates-settings"/);
});
test('version metadata and errors are escaped and ready updates explain the restart',()=>{
 const html=appUpdateStatusHtml({...snapshot,current_version:'<bad>',available:{version:'<new>'},supported:false,reason:'<reason>',restart_required:true,job:{state:'running',progress:300,stage:'<stage>',error:'<error>'}});
 assert.match(html,/&lt;bad&gt;/);assert.match(html,/&lt;error&gt;/);assert.match(html,/value="100"/);assert.doesNotMatch(html,/<bad>|<new>|<reason>|<stage>|<error>/);
 assert.match(html,/conserve tes données/);
 assert.equal(appUpdateRunning({state:'ready'}),false);assert.equal(appUpdateRunning({state:'checking'}),true);
});
test('update UI translates its instructions',()=>{
 setLanguage('en');assert.match(appUpdatesSettingsHtml(),/ChessGym updates/);assert.match(appUpdateStatusHtml(snapshot),/Installed version: <bdi dir="ltr">0.1.0<\/bdi>/);setLanguage('fr');
});
test('unsupported copies explain why and permit disabling already enabled automation',async()=>{
 const page=host();const binding=bindAppUpdates(page,{request:async()=>({...snapshot,supported:false,reason:'Modified files',settings:{automatic_updates:true}})});await tick();
 assert.equal(page.parts.get('[data-app-update-check]').disabled,true);
 assert.equal(page.parts.get('[data-app-update-install]').disabled,true);
 assert.equal(page.parts.get('[name="automatic_updates"]').disabled,false);
 assert.match(page.parts.get('[data-app-update-status]').innerHTML,/Modified files/);binding.dispose();
});
test('checking refreshes the available release and preparing offers controlled restart',async()=>{
 const page=host(),calls=[];let data=structuredClone(snapshot);
 const binding=bindAppUpdates(page,{request:async(url,options)=>{calls.push([url,options]);if(url.endsWith('/check'))data={...snapshot,available:{version:'0.2.0'}};if(url.endsWith('/install'))data={...data,job:{state:'ready'},restart_required:true};return data;}});await tick();
 click(page,'appUpdateCheck');await tick();assert.equal(page.parts.get('[data-app-update-install]').disabled,false);
 click(page,'appUpdateInstall');await tick();assert.equal(page.parts.get('[data-app-update-restart]').hidden,false);assert.equal(page.parts.get('[data-app-update-install]').disabled,true);
 assert.deepEqual(calls.filter(x=>x[1].method==='POST').map(x=>x[0]),['/api/app-updates/check','/api/app-updates/install']);binding.dispose();
});
test('weekly app automation requires explicit save and keeps an edited checkbox during polling',async()=>{
 const page=host(),calls=[];let pending={...snapshot,job:{state:'running',stage:'Preparing',progress:30}};
 const binding=bindAppUpdates(page,{pollMs:5,request:async(url,options)=>{calls.push([url,options]);return pending;}});await tick();
 page.parts.get('[name="automatic_updates"]').checked=true;page.root.onchange({target:{name:'automatic_updates'}});
 await new Promise(resolve=>setTimeout(resolve,12));assert.equal(page.parts.get('[name="automatic_updates"]').checked,true);assert.equal(calls.filter(x=>x[1].method==='PATCH').length,0);
 pending={...snapshot,settings:{automatic_updates:true}};submit(page);await tick();
 const saved=calls.find(x=>x[1].method==='PATCH');assert.deepEqual(saved[1].body,{automatic_updates:true,interval_hours:168});binding.dispose();
});
test('restart flushes the workspace before making the request and reconnects after connection loss',async()=>{
 const page=host(),order=[];let restarting=false,reconnected=false;
 const binding=bindAppUpdates(page,{pollMs:5,beforeRestart:async()=>order.push('flush'),onRestarted:()=>{reconnected=true;},request:async(url)=>{
  if(url.endsWith('/restart')){order.push('request');restarting=true;throw new Error('Connection closed');}
  return restarting?{...snapshot,current_version:'0.2.0',job:{state:'completed'}}:{...snapshot,restart_required:true,job:{state:'ready'}};
 }});await tick();click(page,'appUpdateRestart');await new Promise(resolve=>setTimeout(resolve,20));assert.deepEqual(order,['flush','request','flush']);assert.equal(reconnected,true);binding.dispose();
});
test('restart is not sent when pending local work cannot be flushed',async()=>{
 const page=host(),calls=[];const binding=bindAppUpdates(page,{beforeRestart:async()=>{throw new Error('Unsaved work');},request:async(url)=>{calls.push(url);return {...snapshot,restart_required:true};}});await tick();
 click(page,'appUpdateRestart');await tick();assert.deepEqual(calls,['/api/app-updates']);assert.equal(page.parts.get('[data-app-update-message]').textContent,'Unsaved work');binding.dispose();
});
test('busy restart is reported without pretending the server is restarting',async()=>{
 const page=host();const binding=bindAppUpdates(page,{request:async(url)=>{if(url.endsWith('/restart')){const error=new Error('Analysis running');error.status=409;throw error;}return {...snapshot,restart_required:true};}});await tick();
 click(page,'appUpdateRestart');await tick();assert.equal(page.parts.get('[data-app-update-message]').textContent,'Analysis running');assert.equal(page.parts.get('[data-app-update-restart]').disabled,false);binding.dispose();
});
test('leaving settings aborts pending work and ignores late responses',async()=>{
 const page=host();let release,signal;const binding=bindAppUpdates(page,{request:async(url,options)=>{signal=options.signal;return new Promise(resolve=>release=resolve);}});binding.dispose();release(snapshot);await tick();
 assert.equal(signal.aborted,true);assert.equal(page.root.onclick,null);assert.equal(page.parts.get('[data-app-update-status]')?.innerHTML||'','');
});


test('rollback remains visible and does not report a successful restart',async()=>{
 const page=host();let restarted=0,requested=false;
 const binding=bindAppUpdates(page,{pollMs:5,onRestarted:()=>restarted++,request:async(url)=>{
  if(url.endsWith('/restart')){requested=true;return {...snapshot,restart_required:true,job:{state:'restarting'}};}
  return requested?{...snapshot,job:{state:'failed',stage:'La version précédente a été restaurée.',error:'Startup failed'}}:{...snapshot,restart_required:true,job:{state:'ready'}};
 }});
 await tick();click(page,'appUpdateRestart');await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(restarted,0);assert.equal(page.parts.get('[data-app-update-message]').textContent,'Startup failed');
 assert.equal(page.parts.get('[data-app-update-check]').disabled,false);binding.dispose();
});

test('an automatic update refreshes the interface even when shutdown happened between polls',async()=>{
 const page=host();let restarted=0,calls=0;
 const binding=bindAppUpdates(page,{pollMs:5,onRestarted:()=>restarted++,request:async()=>{
  calls++;return calls===1?{...snapshot,restart_required:true,job:{state:'ready'}}:{...snapshot,current_version:'0.2.0',job:{state:'completed'}};
 }});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(restarted,1);assert.equal(page.parts.get('[data-app-update-check]').disabled,false);binding.dispose();
});

test('a transient initial connection failure retries and restores usable controls',async()=>{
 const page=host();let calls=0;
 const binding=bindAppUpdates(page,{pollMs:5,request:async()=>{if(++calls===1)throw new Error('Temporary connection failure');return snapshot;}});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(calls,2);assert.equal(page.parts.get('[data-app-update-check]').disabled,false);binding.dispose();
});

test('an accepted install with a lost response is recovered from server status',async()=>{
 const page=host();let installing=false;
 const binding=bindAppUpdates(page,{pollMs:100,request:async(url)=>{
  if(url.endsWith('/install')){installing=true;throw new Error('Response lost');}
  return installing?{...snapshot,job:{state:'running',stage:'Preparing release'}}:{...snapshot,available:{version:'0.2.0'}};
 }});
 await tick();click(page,'appUpdateInstall');await tick();
 assert.match(page.parts.get('[data-app-update-status]').innerHTML,/Preparing release/);
 assert.equal(page.parts.get('[data-app-update-install]').disabled,true);binding.dispose();
});


test('automatic restart never reloads when current local work cannot be saved',async()=>{
 const page=host();let restarted=0,calls=0,flushed=0;
 const binding=bindAppUpdates(page,{pollMs:5,beforeRestart:async()=>{flushed++;throw new Error('Unsaved local work');},onRestarted:()=>restarted++,request:async()=>{
  calls++;return calls===1?{...snapshot,restart_required:true,job:{state:'ready'}}:{...snapshot,current_version:'0.2.0',job:{state:'completed'}};
 }});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(flushed,1);assert.equal(restarted,0);
 assert.equal(page.parts.get('[data-app-update-message]').textContent,'Unsaved local work');
 assert.equal(page.parts.get('[data-app-update-check]').disabled,false);binding.dispose();
});

test('version values stay left to right and escaped inside RTL status text',()=>{
 setLanguage('ar');const html=appUpdateStatusHtml({...snapshot,current_version:'0.1.0-alpha.1',available:{version:'<new>&'}});
 assert.match(html,/<bdi dir="ltr">0.1.0-alpha.1<\/bdi>/);
 assert.match(html,/<bdi dir="ltr">&lt;new&gt;&amp;<\/bdi>/);setLanguage('fr');
});


test('enabled automation is observed from idle through restart and completion',async()=>{
 const page=host();let calls=0,restarted=0,flushed=0;
 const enabled={...snapshot,settings:{automatic_updates:true,interval_hours:168}};
 const binding=bindAppUpdates(page,{pollMs:5,beforeRestart:async()=>flushed++,onRestarted:()=>restarted++,request:async()=>{
  calls++;if(calls===1)return enabled;
  if(calls===2)return {...enabled,restart_required:true,job:{state:'restarting'}};
  return {...enabled,current_version:'0.2.0',job:{state:'completed'}};
 }});
 await new Promise(resolve=>setTimeout(resolve,35));
 assert.ok(calls>=3);assert.equal(restarted,1);assert.equal(flushed,1);
 assert.equal(page.parts.get('[data-app-update-check]').disabled,false);binding.dispose();
});

test('a restart request lost before reaching the server leaves restart available',async()=>{
 const page=host();let restarted=0;
 const binding=bindAppUpdates(page,{pollMs:5,onRestarted:()=>restarted++,request:async(url)=>{
  if(url.endsWith('/restart'))throw new Error('Request lost');
  return {...snapshot,restart_required:true,job:{state:'ready'}};
 }});
 await tick();click(page,'appUpdateRestart');await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(restarted,0);assert.equal(page.parts.get('[data-app-update-restart]').disabled,false);
 assert.equal(page.parts.get('[data-app-update-message]').textContent,'Mise à jour prête. Redémarrage nécessaire.');binding.dispose();
});
