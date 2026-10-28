import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceControlsHtml,resourceHardwareHtml,resourceLimits,resourceImportMaximum,bindResourceSettings} from '../static/resource-settings.js';
import {setLanguage} from '../static/i18n.js';

const data={profile:'custom',total_threads:4,hash_mb:128,import_workers:2,
 hardware:{cpu_count:4,cpu_known:true,memory_mb:4096,memory_known:true},
 limits:{total_threads:{min:1,max:4},hash_mb:{min:32,max:2048},import_workers:{min:1,max:2},reserved_memory_mb:2048},
 recommendations:{economy:{total_threads:3,hash_mb:128,import_workers:1},balanced:{total_threads:3,hash_mb:256,import_workers:1}},
 effective:{engine_threads:1,engine_hash_mb:64,import_workers:2}};

test('CPU and cache fields use detected hardware bounds, not fixed maxima',()=>{
 setLanguage('en');
 const html=resourceControlsHtml(data);
 assert.match(html,/name="total_threads"[^>]*min="1" max="4"/);
 assert.match(html,/name="hash_mb"[^>]*min="32" max="2048"/);
 assert.match(html,/name="import_workers"[^>]*min="1" max="2"/);
 assert.match(html,/4096 MB/);
 assert.match(html,/System reserve: 2048 MB/);
 assert.ok(html.includes('Balanced (recommended)'));
 assert.match(html,/does not cap ChessGym/);
 assert.doesNotMatch(html,/max="128"/);
 setLanguage('fr');
});

test('unknown hardware is explicit and falls back to a conservative bound',()=>{
 setLanguage('en');
 const unknown={hardware:{cpu_count:1,cpu_known:false,memory_mb:null,memory_known:false}};
 const html=resourceHardwareHtml(unknown),limits=resourceLimits(unknown);
 assert.match(html,/CPU detection unavailable/);
 assert.match(html,/RAM detection unavailable/);
 assert.equal(limits.total_threads.max,1);
 assert.equal(limits.hash_mb.max,128);
 assert.equal(resourceImportMaximum(1,limits),1);
 setLanguage('fr');
});

test('editing the CPU budget reduces import concurrency and presets preview their real values',async()=>{
 const inputs=Object.fromEntries(['profile','total_threads','hash_mb','import_workers'].map(key=>[key,{value:String(data[key]),disabled:false,max:''}]));
 const output=()=>({textContent:''});
 const custom={querySelectorAll:()=>Object.entries(inputs).filter(([key])=>key!=='profile').map(([,value])=>value)};
 const elements={'[data-resource-custom]':custom,'[data-resource-effective]':output(),'[data-resource-preview]':output(),'[data-resource-small]':output(),'[data-resource-result]':output()};
 const button={disabled:false},form={elements:{namedItem:key=>inputs[key]},querySelector:()=>button};
 elements.form=form;
 const root={innerHTML:'',querySelector:selector=>elements[selector]};
 const dispose=bindResourceSettings({querySelector:()=>root},{request:async()=>data});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(inputs.import_workers.max,'2');
 inputs.total_threads.value='1';custom.oninput();
 assert.equal(inputs.import_workers.max,'1');
 assert.equal(inputs.import_workers.value,'1');
 assert.match(elements['[data-resource-small]'].textContent,/l’une après l’autre/);
 inputs.profile.value='balanced';inputs.profile.onchange();
 assert.equal(inputs.total_threads.value,'3');
 assert.equal(inputs.hash_mb.value,'256');
 assert.equal(inputs.import_workers.value,'1');
 assert.equal(inputs.total_threads.disabled,true);
 inputs.profile.value='custom';inputs.profile.onchange();
 assert.equal(inputs.total_threads.disabled,false);
 assert.equal(inputs.hash_mb.value,'256');
 dispose();
});
