import assert from 'node:assert/strict';
import {batchMetadataFields,batchMetadataPatch,editBatchMetadata,editMetadata} from '../static/metadata.js';
import {dialogFactory} from './metadata_dom.mjs';
const games=[{id:1,title:'A',headers:{Event:'First',White:'Alice',Result:'1-0',Annotator:'A',FEN:'root',SetUp:'1'}},{id:2,title:'B',headers:{Event:'Second',White:'Alice',Result:'0-1',Annotator:'B',Variant:'standard'}}];
function fixture(onSubmit=async()=>{}){const dialogs=[],dialog=editBatchMetadata(games,{baseName:'Cours <privés>',onSubmit,openModal:dialogFactory(dialogs)});return {dialog,form:dialog.querySelector('form'),row:name=>dialog.querySelector('[data-bm-field="'+name+'"]')};}
function action(f,name,value){const row=f.row(name),control=row.querySelector('[data-bm-action]');control.value=value;f.form.emit('change',control);return row.querySelector('[data-bm-value]');}
const tests={
 mixed_values_are_clear_and_structural_fields_excluded(){
  const fields=batchMetadataFields(games);assert.equal(fields[0].name,'Event');assert.equal(fields[0].label,'Tournoi / événement');assert.equal(fields[0].mixed,true);assert.equal(fields[0].value,'');assert.deepEqual(fields.find(f=>f.name==='White'),{name:'White',label:'Joueur avec les blancs',mixed:false,value:'Alice',custom:false});assert.equal(fields.find(f=>f.name==='Annotator').mixed,true);assert.ok(!fields.some(f=>['FEN','SetUp','Variant'].includes(f.name)));
  const f=fixture();assert.match(f.dialog.innerHTML,/Valeurs différentes dans la sélection/);assert.match(f.dialog.innerHTML,/Cours &lt;privés&gt;/);assert.ok(f.dialog.querySelectorAll('[data-bm-action]').every(el=>el.value==='keep'));assert.ok(f.dialog.querySelectorAll('[data-bm-value]').every(el=>el.disabled));
 },
 patch_only_applies_explicit_fields_and_clear_is_null(){
  assert.deepEqual(batchMetadataPatch([{name:'Event',action:'set',value:'Open'},{name:'White',action:'keep',value:'Alice'},{name:'Site',action:'clear',value:'Old'}]),{Event:'Open',Site:null});
  assert.throws(()=>batchMetadataPatch([{name:'Event',action:'set',value:''}]),/Effacer/);assert.throws(()=>batchMetadataPatch([{name:'Event',action:'keep',value:'Open'}]),/au moins/);
 },
 invalid_or_duplicate_custom_fields_are_rejected(){
  for(const name of ['FEN','SetUp','Variant','Bad name','_starts_wrong'])assert.throws(()=>batchMetadataPatch([{name,action:'set',value:'x',custom:true}]));
  assert.throws(()=>batchMetadataPatch([{name:'white',action:'set',value:'A',custom:true}]),/champ prévu/);
  assert.throws(()=>batchMetadataPatch([{name:'Annotator',action:'clear'},{name:'Annotator',action:'set',value:'A'}]),/deux fois/);
  assert.throws(()=>batchMetadataPatch([{name:'Result',action:'set',value:'draw'}]),/résultat/);
  assert.deepEqual(batchMetadataPatch([{name:'X-Source',action:'set',value:'Book',custom:true},{name:'Tag:foo',action:'clear',custom:true}]),{'X-Source':'Book','Tag:foo':null});
  assert.throws(()=>batchMetadataPatch([{name:'Event',action:'set',value:'x'.repeat(2001)}]),/longue/);
 },
 async controls_opt_in_clear_and_revert_preserve_original_values(){
  const patches=[],f=fixture(async patch=>patches.push(patch));assert.equal(f.dialog.querySelector('[type=submit]').disabled,true);
  const input=action(f,'Event','set');assert.equal(input.disabled,false);assert.equal(input.required,true);input.value='My tournament';assert.equal(f.dialog.querySelector('[type=submit]').disabled,false);
  action(f,'Event','keep');assert.equal(input.disabled,true);assert.equal(f.dialog.querySelector('[type=submit]').disabled,true);
  action(f,'White','clear');assert.equal(f.row('White').querySelector('[data-bm-value]').value,'Alice');await f.dialog.settings.onSubmit(null,f.form);assert.deepEqual(patches,[{White:null}]);
 },
 async custom_fields_can_be_added_without_affecting_existing_tags(){
  const patches=[],f=fixture(async patch=>patches.push(patch));f.dialog.querySelector('[data-bm-add]').onclick();const row=f.dialog.querySelector('[data-bm-extra]').lastElementChild;assert.equal(row.querySelector('[data-bm-action]').value,'set');row.querySelector('[data-bm-name]').value='Study';row.querySelector('[data-bm-value]').value='Endgames';await f.dialog.settings.onSubmit(null,f.form);assert.deepEqual(patches,[{Study:'Endgames'}]);
 },
 async pending_submission_locks_every_control_and_escape_until_callback_finishes(){
  let release;const f=fixture(()=>new Promise(resolve=>release=resolve));action(f,'Event','set').value='Open';const pending=f.dialog.settings.onSubmit(null,f.form);
  assert.ok(f.form.querySelectorAll('button,input,select').every(el=>el.disabled));assert.equal(f.form.getAttribute('aria-busy'),'true');assert.equal(f.dialog.emit('cancel').defaultPrevented,true);
  release();await pending;assert.equal(f.form.getAttribute('aria-busy'),'false');assert.equal(f.dialog.listeners.has('cancel'),false);assert.equal(f.row('Event').querySelector('[data-bm-value]').disabled,false);assert.equal(f.row('White').querySelector('[data-bm-value]').disabled,true);assert.equal(f.dialog.querySelector('[data-close]').disabled,false);assert.equal(f.dialog.querySelector('[type=submit]').disabled,false);
 },
 no_selection_is_rejected_and_individual_editor_remains_exported(){
  assert.throws(()=>editBatchMetadata([]),/Sélectionne/);assert.equal(typeof editMetadata,'function');
 }
};
const scenario=process.argv[2];assert.ok(tests[scenario],scenario);await tests[scenario]();console.log('ok '+scenario);
