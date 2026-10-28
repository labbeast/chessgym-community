import {api} from './api.js';
import {t} from './i18n.js';
import {newId} from './identifiers.js';

let writes=Promise.resolve(),context=0;
const failed=[];
export function resetAnalysisContext(){context++;failed.splice(0);}
export const flushAnalysisWrites=()=>writes;

// Reading and analysis share an editor, but never the same measured interval.
export function boardStudyActivity(doc,bases=[],{analysisOnly=false,readingRun=false}={}){
 if(readingRun)return 'reading';
 if(analysisOnly)return 'analysis';
 return doc?.id&&(doc.reading?.enabled||bases.some(base=>Number(base.id)===Number(doc.base_id)&&base.settings?.reading_enabled))?'reading':'analysis';
}

export class AnalysisTimeTracker{
 constructor({doc={},paused=false,request=api,onError=()=>{},document:page=globalThis.document,window:win=globalThis.window,
  now=()=>globalThis.performance.now(),setInterval:every=(...args)=>globalThis.setInterval(...args),clearInterval:stop=(...args)=>globalThis.clearInterval(...args)}={}){
  Object.assign(this,{request,onError,page,win,now,stop});
  this.source={visit_id:newId(),title:String(doc.title||'Analyse').slice(0,200),...(doc.id?{entry_id:doc.id}:{})};
  this.context=context;this.pendingMs=0;this.totalMs=0;this.paused=!!paused;this.disposed=false;this.listeners=[];
  this.lastTick=this.lastActivity=now();this.active=this.foreground();
  const activity=()=>{this.tick();this.lastActivity=now();};
  for(const name of ['pointerdown','keydown','wheel','touchstart'])this.listen(page,name,activity);
  this.listen(page,'visibilitychange',()=>{this.tick();this.active=this.foreground();if(this.active)this.lastActivity=now();else this.flush();});
  this.listen(win,'blur',()=>{this.tick();this.active=false;this.flush();});
  this.listen(win,'focus',()=>{this.tick();this.active=this.foreground();this.lastActivity=now();});
  this.listen(win,'pagehide',()=>{this.tick();this.active=false;this.flush();});
  this.listen(win,'pageshow',()=>{this.tick();this.active=this.foreground();this.lastActivity=now();});
  this.timer=every(()=>{this.tick();this.flush();},15000);
 }
 foreground(){return this.page?.visibilityState!=='hidden'&&this.page?.hasFocus?.()!==false;}
 listen(surface,event,callback){surface?.addEventListener?.(event,callback,{passive:true});this.listeners.push([surface,event,callback]);}
 elapsedSinceTick(){return !this.active||this.paused||this.disposed?0:Math.max(0,Math.min(this.now(),this.lastActivity+90000)-this.lastTick);}
 toolbarElapsedMs(){return this.totalMs+this.elapsedSinceTick();}
 tick(){const elapsed=this.elapsedSinceTick();this.pendingMs+=elapsed;this.totalMs+=elapsed;this.lastTick=this.now();}
 send(payload){
  const epoch=this.context;
  const work=async()=>{
   if(epoch!==context)return;
   try{await this.request('/api/training/analysis-time',{method:'POST',body:payload,keepalive:true});}
   catch(error){if(epoch===context){failed.push({payload,request:this.request,epoch});if(!this.disposed)this.onError(error);}}
  };
  writes=writes.then(work,work);return writes;
 }
 retry(){
  const queued=failed.splice(0);
  for(const item of queued){
   if(item.epoch!==context)continue;
   const work=async()=>{if(item.epoch!==context)return;try{await item.request('/api/training/analysis-time',{method:'POST',body:item.payload,keepalive:true});}catch(error){if(item.epoch===context){failed.push(item);if(!this.disposed)this.onError(error);}}};
   writes=writes.then(work,work);
  }
  return writes;
 }
 flush(){
  if(this.context!==context)return writes;
  this.retry();
  while(this.pendingMs>=1){const duration_ms=Math.min(90000,Math.floor(this.pendingMs));this.pendingMs-=duration_ms;this.send({...this.source,duration_ms,mutation_id:newId()});}
  return writes;
 }
 async settle(){this.tick();await this.flush();await this.retry();if(this.context===context&&failed.length)throw new Error(t('Le temps d’analyse n’a pas pu être enregistré. Réessaie avant de quitter.'));}
 async pause(){if(this.disposed||this.paused)return;this.tick();this.paused=true;await this.flush();}
 resume(){if(this.disposed||!this.paused)return;this.paused=false;this.lastTick=this.lastActivity=this.now();this.active=this.foreground();}
 dispose({flush=true}={}){
  if(this.disposed)return;if(flush){this.tick();this.flush();}this.disposed=true;
  this.stop(this.timer);for(const [surface,event,callback] of this.listeners)surface?.removeEventListener?.(event,callback);this.listeners=[];
  this.toolbarPauseOverlay?.remove();this.toolbarPauseOverlay=null;
  for(const {node,inert} of this.toolbarPauseRegions||[])node.inert=inert;this.toolbarPauseRegions=[];
 }
}
