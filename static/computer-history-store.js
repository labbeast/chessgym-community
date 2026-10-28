import {t} from './i18n.js';
import {computerSessionSnapshot} from './computer-workspace.js';
import {newId as id} from './identifiers.js';

const clone=value=>structuredClone(value);
const semantic=snapshot=>{const s=snapshot.session,p=s.position;return JSON.stringify({id:s.id,side:s.side,baseline:s.baseline,config:s.config,headers:s.headers,initial_fen:p.initial_fen,history:p.history,resigned:!!s.resigned,timeout:s.timeout||null,paused:s.paused===true,clock:s.clock||null,activity:s.activity||null});};
const eventKey=snapshot=>{const s=snapshot.session;return JSON.stringify([s.position.history,s.headers,s.resigned,s.timeout,s.paused===true,s.clock?.paused,s.clock?.expired]);};

// The outbox survives a new game, a closed tab and an interrupted response.
// Only confirmed positions are archived; the workspace owns unconfirmed intent.
export class ComputerHistoryStore {
 constructor({request,storage,onChange=()=>{},delay=400,clockDelay=10000}={}){
  this.request=request;this.onChange=onChange;this.delay=delay;this.clockDelay=clockDelay;this.epoch=0;this.ready=false;this.records=new Map();this.timer=null;this.tail=Promise.resolve();
  try{this.storage=storage===undefined?globalThis.localStorage:storage;}catch{this.storage=null;}
 }
 open(user,{namespace='initial',enabled=true}={}){
  this.close();this.enabled=enabled;this.prefix='chessgym-computer-history-v1:'+encodeURIComponent(user)+':'+encodeURIComponent(namespace);this.records=new Map();this.localError=null;this.corrupt=false;
  try{
   const saved=JSON.parse(this.storage?.getItem(this.prefix)||'{}');
   for(const [key,value] of Object.entries(saved.records||{}))if(value&&typeof value==='object')this.records.set(key,value);
  }catch{this.corrupt=true;this.localError=t('L’historique local est illisible. Sa copie est conservée.');}
  this.ready=true;this.onChange();this.schedule();
 }
 close(){clearTimeout(this.timer);this.timer=null;this.controller?.abort();this.epoch++;this.ready=false;this.enabled=false;this.tail=Promise.resolve();}
 info(gameId){const item=this.records.get(gameId);return {pending:!!item?.pending,conflict:!!item?.conflict,error:item?.error||this.localError||null,autoCopyError:item?.autoCopyError||null};}
 persist(){
  if(!this.ready||this.corrupt)return false;
  try{
   if(!this.storage)throw new Error(t('Stockage de cet appareil indisponible.'));
   // Retain all unsent games and only a bounded set of acknowledged revisions.
   const records=[...this.records],ack=records.filter(([,v])=>!v.pending).slice(-128),dirty=records.filter(([,v])=>v.pending);
   this.storage.setItem(this.prefix,JSON.stringify({records:Object.fromEntries([...ack,...dirty])}));this.localError=null;return true;
  }catch(error){this.localError=error.message||String(error);return false;}
 }
 record(snapshot){
  if(!this.ready||!this.enabled)return null;
  const saved=computerSessionSnapshot(snapshot);if(!saved?.session?.id)return null;
  saved.pendingMove=null;const gameId=saved.session.id,key=semantic(saved),event=eventKey(saved);
  const item=this.records.get(gameId)||{revision:0,version:0};
  if(item.signature===key)return gameId;
  const urgent=event!==item.event;item.pending=saved;item.signature=key;item.event=event;item.version++;item.error=null;
  this.records.set(gameId,item);this.persist();this.onChange(gameId);this.schedule(urgent?this.delay:this.clockDelay);return gameId;
 }
 async prepare(snapshot){
  const local=computerSessionSnapshot(snapshot),gameId=local?.session?.id;
  if(!this.ready||!this.enabled||!gameId||this.records.has(gameId))return snapshot;
  if(this.corrupt)throw new Error(this.localError);
  const epoch=this.epoch,controller=this.controller=new AbortController();let document;
  const current=()=>this.ready&&this.enabled&&epoch===this.epoch;
  try{document=await this.request('/api/computer/games/'+encodeURIComponent(gameId),{signal:controller.signal});}
  catch(error){
   if(!current()||error.name==='AbortError')throw Object.assign(new Error('Aborted'),{name:'AbortError'});
   if(error.status!==404)throw error;
   if(!this.records.has(gameId)){this.records.set(gameId,{revision:0,version:0});this.persist();}
   return snapshot;
  }finally{if(this.controller===controller)this.controller=null;}
  if(!current())throw Object.assign(new Error('Aborted'),{name:'AbortError'});
  if(this.records.has(gameId))return snapshot;
  const remote=computerSessionSnapshot(document?.snapshot),a=local.session,b=remote?.session;
  const prefix=(first,second)=>first.length<=second.length&&first.every((move,index)=>move===second[index]);
  const engineConfig=session=>JSON.stringify([session.config?.provider,session.config?.provider==='maia'?(session.config.level??1500):(session.config?.skill??10),session.config?.provider==='maia'?null:(session.config?.time_ms??500)]);
  const clocksCompatible=b&&(!a.clock&&!b.clock||a.clock&&b.clock&&a.clock.version===b.clock.version&&a.clock.initial_ms===b.clock.initial_ms&&a.clock.increment_ms===b.clock.increment_ms&&(!a.clock.expired||!b.clock.expired||a.clock.expired===b.clock.expired));
  const compatible=b&&b.id===gameId&&a.position.initial_fen===b.position.initial_fen&&a.side===b.side&&a.baseline===b.baseline&&engineConfig(a)===engineConfig(b)&&clocksCompatible;
  const forward=compatible&&prefix(b.position.history,a.position.history),backward=compatible&&prefix(a.position.history,b.position.history);
  const outcome=session=>(session.resigned||session.timeout||session.position.game_over)&&session.headers.Result!=='*'?session.headers.Result:null;
  const localResult=outcome(a),remoteResult=b&&outcome(b),same=compatible&&a.position.history.length===b.position.history.length;
  if(!compatible||(!forward&&!backward)||(same&&localResult&&remoteResult&&localResult!==remoteResult)||(forward&&!same&&remoteResult)){
   const error=t('Cette partie a des suites différentes sur cet appareil et dans l’historique. Les deux copies sont conservées.');
   this.records.set(gameId,{revision:document?.revision||0,version:1,pending:local,signature:semantic(local),event:eventKey(local),conflict:true,error});this.persist();this.onChange(gameId);throw new Error(error);
  }
  this.adopt(document);
  const withActivity=value=>{
   // A pause on either copy of the same untimed position requires an explicit
   // resume; merely opening another device must not restart a paused game.
   const paused=same&&!a.clock&&(a.paused===true||b.paused===true);
   if(!a.activity&&!b.activity&&!paused)return value;const result=clone(value);
   if(a.activity||b.activity)result.session.activity={version:1,elapsed_ms:Math.max(a.activity?.elapsed_ms||0,b.activity?.elapsed_ms||0)};
   if(paused)result.session.paused=true;return result;
  };
  // A terminal result on another device must not become an unfinished game
  // simply because its final move sequence is identical to this local copy.
  if(backward&&(!forward||(remoteResult&&!localResult)))return withActivity(remote);
  if(same&&a.clock){
   const combined=clone(local),clock=combined.session.clock,minimum=(first,second)=>({white:Math.min(first.white,second.white),black:Math.min(first.black,second.black)});
   clock.remaining=minimum(a.clock.remaining,b.clock.remaining);clock.expired=a.clock.expired||b.clock.expired||null;clock.paused=true;clock.running=null;
   const checkpoints=new Map();
   for(const item of [...(a.clock.history||[]),...(b.clock.history||[])]){
    const previous=checkpoints.get(item.ply);checkpoints.set(item.ply,previous?minimum(previous,item.remaining):clone(item.remaining));
   }
   // Takebacks use these checkpoints. Reconcile them too, otherwise undo could
   // return time that was already consumed on the other device.
   clock.history=[...checkpoints].sort(([first],[second])=>first-second).map(([ply,remaining])=>({ply,remaining}));
   return withActivity(combined);
  }
  return withActivity(snapshot);
 }
 adopt(document){
  if(!document?.id||!document.snapshot)return false;
  const previous=this.records.get(document.id);
  if(previous?.pending||previous?.conflict)throw new Error(t('Une copie locale de cette partie attend sa synchronisation. Elle est conservée avant d’ouvrir une autre version.'));
  this.records.set(document.id,{revision:document.revision,version:0,signature:semantic(document.snapshot),event:eventKey(document.snapshot),autoCopyError:document.auto_copy_error||null});
  this.persist();this.onChange(document.id);return true;
 }
 schedule(delay=this.delay){
  if(!this.ready||!this.enabled||this.corrupt)return;
  const due=Date.now()+delay;if(this.timer&&this.timerDue<=due)return;
  clearTimeout(this.timer);this.timerDue=due;this.timer=setTimeout(()=>{this.timer=null;void this.flush();},delay);
 }
 flush(gameId=null){
  clearTimeout(this.timer);this.timer=null;const epoch=this.epoch;
  const run=async()=>{
   if(!this.ready||!this.enabled||epoch!==this.epoch||this.corrupt)return;
   for(const [key,item] of this.records){
    if(gameId&&gameId!==key||!item.pending||item.conflict)continue;
    // At most two versions per pass; new clock ticks cannot keep a flush alive.
    for(let pass=0;pass<2&&item.pending;pass++){
     if(epoch!==this.epoch)return;
     if(!item.sent){item.sent={version:item.version,body:{snapshot:clone(item.pending),expected_revision:item.revision,mutation_id:id()}};this.persist();}
     const sent=item.sent,controller=this.controller=new AbortController();
     try{
      const result=await this.request('/api/computer/games/'+encodeURIComponent(key),{method:'PUT',body:sent.body,signal:controller.signal});
      if(epoch!==this.epoch)return;
      item.revision=result.revision;item.error=null;item.autoCopyError=result.auto_copy_error||null;delete item.sent;
      if(item.version===sent.version)delete item.pending;
      this.persist();this.onChange(key);
     }catch(error){
      if(epoch!==this.epoch||error.name==='AbortError')return;
      item.error=error.message||String(error);if(error.status===409)item.conflict=true;
      this.persist();this.onChange(key);break;
     }finally{if(this.controller===controller)this.controller=null;}
    }
   }
   // A targeted archive must not consume another game's scheduled upload.
   // Failed games already attempted by this pass are never retried in a loop.
   if(gameId&&epoch===this.epoch&&[...this.records].some(([key,item])=>key!==gameId&&item.pending&&!item.conflict))this.schedule();
  };
  this.tail=this.tail.then(run,run);return this.tail;
 }
 async archive(snapshot){
  const gameId=this.record(snapshot);if(!gameId)return;
  await this.flush(gameId);const info=this.info(gameId);
  if(info.pending||info.conflict)throw new Error(info.error||t('La partie reste conservée sur cet appareil. Réessaie sa synchronisation avant de commencer une autre partie.'));
 }
}
