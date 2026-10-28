import {t} from './i18n.js';
import {newId} from './identifiers.js';

const clone=value=>structuredClone(value);
const empty=()=>({outcome:null,hint:false,revealed:false,attempts:0});
const recordKey=(entryId,fingerprint)=>Number(entryId)+':'+fingerprint;
const valid=(entryId,fingerprint)=>Number.isSafeInteger(Number(entryId))&&Number(entryId)>0&&/^[0-9a-f]{64}$/.test(fingerprint);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const integer=(value,min=0)=>Number.isSafeInteger(value)&&value>=min;
const validState=value=>object(value)&&[null,'reviewed','solved','revealed','missed','cancelled'].includes(value.outcome)&&typeof value.hint==='boolean'&&typeof value.revealed==='boolean'&&integer(value.attempts)&&value.attempts<=100000;
function validRecord(key,record){
 if(!object(record)||!valid(record.entryId,record.fingerprint)||key!==recordKey(record.entryId,record.fingerprint)||!object(record.items)||!object(record.pending))return false;
 const moment=(ply,item,min)=>/^[1-9]\d*$/.test(ply)&&Number(ply)<=1000&&object(item)&&item.ply===Number(ply)&&integer(item.revision,min)&&validState(item.state);
 if(!Object.entries(record.items).every(([ply,item])=>moment(ply,item,1)))return false;
 return Object.entries(record.pending).every(([ply,change])=>{
  if(!/^[1-9]\d*$/.test(ply)||Number(ply)>1000||!object(change)||!validState(change.state)||!integer(change.revision)||!integer(change.version,1))return false;
  if(change.remote&&!moment(ply,change.remote,0))return false;
  const sent=change.sent,body=sent?.body;
  return !sent||(object(sent)&&integer(sent.version,1)&&sent.version<=change.version&&object(body)&&body.fingerprint===record.fingerprint&&body.ply===Number(ply)&&body.expected_revision===change.revision&&typeof body.mutation_id==='string'&&body.mutation_id.length>=8&&body.mutation_id.length<=160&&validState(body.state));
 });
}
const normalized=state=>({outcome:['reviewed','solved','revealed','missed','cancelled'].includes(state?.outcome)?state.outcome:null,hint:state?.hint===true,revealed:state?.revealed===true,attempts:Number.isSafeInteger(state?.attempts)?Math.max(0,Math.min(100000,state.attempts)):0});

export class GameReportProgressStore{
 constructor({request,storage,delay=200}={}){this.request=request;this.delay=delay;this.listeners=new Set();this.records=new Map();this.epoch=0;this.ready=false;this.tail=Promise.resolve();try{this.storage=storage===undefined?globalThis.localStorage:storage;}catch{this.storage=null;}}
 open(user,{namespace='initial'}={}){
  this.close();this.prefix='chessgym-report-progress-v1:'+encodeURIComponent(user)+':'+encodeURIComponent(namespace);this.records=new Map();this.localError=null;this.corrupt=false;
  try{const saved=JSON.parse(this.storage?.getItem(this.prefix)||'{}');if(!object(saved)||(saved.records!==undefined&&!object(saved.records)))throw new Error('Invalid progress');for(const [key,record] of Object.entries(saved.records||{})){if(!validRecord(key,record))throw new Error('Invalid progress');record.loading=false;this.records.set(key,record);}}
  catch{this.corrupt=true;this.localError=t('Le suivi local des bilans est illisible. Sa copie est conservée.');}
  this.ready=true;this.notify();this.schedule();
 }
 close(){clearTimeout(this.timer);this.timer=null;for(const controller of this.controllers||[])controller.abort();this.controllers=new Set();this.ready=false;this.epoch++;this.tail=Promise.resolve();this.notify();}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 notify(){for(const listener of this.listeners)listener();}
 get(entryId,fingerprint){return this.records.get(recordKey(entryId,fingerprint));}
 ensure(entryId,fingerprint){if(!valid(entryId,fingerprint))throw new Error(t('Identité de bilan invalide.'));const key=recordKey(entryId,fingerprint);let record=this.records.get(key);if(!record){record={entryId:Number(entryId),fingerprint,items:{},pending:{},error:null};this.records.set(key,record);}return record;}
 persist(){if(!this.ready||this.corrupt)return false;try{if(!this.storage)throw new Error(t('Stockage de cet appareil indisponible.'));const rows=[...this.records],dirty=rows.filter(([,record])=>Object.keys(record.pending).length),clean=rows.filter(([,record])=>!Object.keys(record.pending).length).slice(-32);this.storage.setItem(this.prefix,JSON.stringify({records:Object.fromEntries([...clean,...dirty])}));this.localError=null;return true;}catch(error){this.localError=error.message||String(error);return false;}}
 snapshot(entryId,fingerprint){
  const record=this.get(entryId,fingerprint),items=clone(record?.items||{}),pending=Object.entries(record?.pending||{});
  for(const [ply,change] of pending)items[ply]={...(items[ply]||{ply:Number(ply),revision:change.revision}),state:clone(change.state)};
  return {items:Object.values(items),pending:pending.length,loaded:!!record?.loaded,loading:!!record?.loading,error:this.localError||record?.error||pending.find(([,change])=>change.error)?.[1].error||null,
   conflicts:pending.filter(([,change])=>change.conflict).map(([ply,change])=>({ply:Number(ply),local:clone(change.state),remote:clone(change.remote?.state||empty()),remoteKnown:!!change.remote})),sourceChanged:!!record?.sourceChanged};
 }
 async read(record){const controller=new AbortController(),epoch=this.epoch;this.controllers.add(controller);try{const response=await this.request('/api/game-analysis/'+record.entryId+'/progress?fingerprint='+record.fingerprint,{signal:controller.signal});if(!this.ready||epoch!==this.epoch)throw Object.assign(new Error('Aborted'),{name:'AbortError'});return response;}finally{this.controllers.delete(controller);}}
 adopt(record,response){const remote=Object.fromEntries(response.items.map(item=>[item.ply,clone(item)]));for(const [ply,item] of Object.entries(record.items))if(item.revision>(remote[ply]?.revision||0))remote[ply]=item;record.items=remote;for(const [ply,change] of Object.entries(record.pending)){if(change.conflict)change.remote=remote[ply]||{ply:Number(ply),revision:0,state:empty()};else if(!change.sent&&change.revision!==(remote[ply]?.revision||0)){change.conflict=true;change.remote=remote[ply]||{ply:Number(ply),revision:0,state:empty()};change.error=t('Ce moment a été modifié sur un autre appareil. Compare les deux suivis avant de choisir.');}}record.error=null;record.sourceChanged=false;record.loaded=true;}
 async load(entryId,fingerprint){if(!this.ready||this.corrupt)return false;const record=this.ensure(entryId,fingerprint);if(record.loading)return false;const epoch=this.epoch;record.loading=true;this.notify();try{const response=await this.read(record);this.adopt(record,response);this.persist();return true;}catch(error){if(epoch!==this.epoch||error.name==='AbortError')return false;record.error=error.message;if(error.reason==='report-source-changed')record.sourceChanged=true;return false;}finally{if(epoch===this.epoch){record.loading=false;this.notify();}}}
 record(entryId,fingerprint,ply,state){
  if(!this.ready||this.corrupt)throw new Error(this.localError||t('Le suivi du bilan n’est pas prêt.'));
  if(!Number.isSafeInteger(ply)||ply<1||ply>1000)throw new Error(t('Moment de bilan invalide.'));
  const record=this.ensure(entryId,fingerprint),previous=record.pending[ply];if(record.sourceChanged)throw new Error(t('Recharge le bilan avant de modifier son suivi.'));
  const next=normalized(state),current=previous?.state||record.items[ply]?.state;if(JSON.stringify(next)===JSON.stringify(current))return;
  const change=previous||{revision:record.items[ply]?.revision||0,version:0};change.state=next;change.version++;if(!change.conflict)change.error=null;record.pending[ply]=change;record.error=null;this.persist();this.notify();this.schedule();
 }
 schedule(){if(!this.ready||this.corrupt)return;clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;void this.flush();},this.delay);}
 flush(entryId=null,fingerprint=null){
  clearTimeout(this.timer);this.timer=null;const epoch=this.epoch;
  const run=async()=>{
   if(!this.ready||this.corrupt||epoch!==this.epoch)return;
   for(const record of this.records.values()){
    if(entryId!==null&&recordKey(entryId,fingerprint)!==recordKey(record.entryId,record.fingerprint)||record.sourceChanged)continue;
    for(const [ply,change] of Object.entries(record.pending)){
     if(epoch!==this.epoch)return;if(change.conflict)continue;
     for(let pass=0;pass<2&&record.pending[ply]===change;pass++){
      if(!change.sent){change.sent={version:change.version,body:{fingerprint:record.fingerprint,ply:Number(ply),state:clone(change.state),expected_revision:change.revision,mutation_id:newId()}};this.persist();}
      const sent=change.sent,controller=new AbortController();this.controllers.add(controller);
      try{
       const response=await this.request('/api/game-analysis/'+record.entryId+'/progress',{method:'PUT',body:sent.body,signal:controller.signal});if(epoch!==this.epoch)return;
       // A retried receipt can acknowledge an older write after a newer device update was read.
       if(response.item.revision>=(record.items[ply]?.revision||0))record.items[ply]=response.item;change.revision=response.item.revision;change.error=null;delete change.sent;if(change.version===sent.version)delete record.pending[ply];this.persist();this.notify();
      }catch(error){
       if(epoch!==this.epoch||error.name==='AbortError')return;change.error=error.message||String(error);
       if(error.status===409){if(error.reason==='report-source-changed')record.sourceChanged=true;else {change.conflict=true;try{this.adopt(record,await this.read(record));}catch{}}}
       if(epoch!==this.epoch)return;this.persist();this.notify();break;
      }finally{this.controllers.delete(controller);}
     }
    }
   }
  };
  this.tail=this.tail.then(run,run);return this.tail;
 }
 async retry(entryId,fingerprint){const record=this.get(entryId,fingerprint);if(!record)return;await this.load(entryId,fingerprint);return this.flush(entryId,fingerprint);}
 async resolve(entryId,fingerprint,ply,choice){
  if(!['local','remote'].includes(choice))return false;const record=this.get(entryId,fingerprint),change=record?.pending?.[ply];if(!change?.conflict||!this.ready)return false;
  const epoch=this.epoch,previousRevision=change.remote?.revision,response=await this.read(record);if(epoch!==this.epoch||record.pending[ply]!==change)return false;
  this.adopt(record,response);const remote=record.items[ply]||{ply,revision:0,state:empty()};
  if(previousRevision!==undefined&&previousRevision!==remote.revision){this.persist();this.notify();throw new Error(t('Le suivi a encore changé sur un autre appareil. Compare les nouvelles valeurs avant de choisir.'));}
  if(choice==='remote')delete record.pending[ply];else record.pending[ply]={revision:remote.revision,version:change.version+1,state:clone(change.state),error:null};
  record.error=null;this.persist();this.notify();if(choice==='local')await this.flush(entryId,fingerprint);return true;
 }
}
