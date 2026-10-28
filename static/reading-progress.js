import {t,ui,locale} from './i18n.js';
import {api,esc} from './api.js';

export function mainlineNodes(doc){
 const map=new Map((doc?.nodes||[]).map(n=>[n.path,n])),line=[],seen=new Set();let node=map.get('');
 while(node&&!seen.has(node.path)){line.push(node);seen.add(node.path);node=map.get(node.children?.[0]);}
 return line;
}
export function savedReadingNode(doc,path,sourceLine=doc?.analysis_source_line??mainlineNodes(doc)){
 const line=mainlineNodes(doc);
 for(let i=0;i<line.length&&i<sourceLine.length;i++){
  if(line[i].path!==sourceLine[i].path||line[i].fen!==sourceLine[i].fen)return null;
  if(line[i].path===path)return {node:line[i],index:i};
 }
 return null;
}
export function readingPercent(value){return Math.max(0,Math.min(100,Number(value)||0)).toLocaleString(locale(),{maximumFractionDigits:1})+' %';}
export function readingTime(seconds){
 if(seconds==null)return t('À estimer');
 const n=Math.max(0,Math.round(Number(seconds)||0));
 if(n<60)return n+' s';if(n<3600)return Math.round(n/60)+' min';
 return Math.floor(n/3600)+' h '+String(Math.floor(n%3600/60)).padStart(2,'0');
}
export function readingSettingsHtml(base){
 return ui('<section class="panel reading-settings"><h2>Lecture</h2><label class="check"><input type="checkbox" name="reading_enabled" ')+(base.settings?.reading_enabled?'checked':'')+ui('> Suivre la lecture de cette base</label><p class="hint">Le signet avance avec les coups de la ligne principale. Un clic droit sur un coup permet de le déplacer manuellement, y compris vers un coup antérieur.</p><div class="actions"><button type="button" data-reading-bulk="read" ')+(!base.settings?.reading_enabled?'disabled':'')+ui('>Tout marquer comme lu</button><button type="button" data-reading-bulk="unread" ')+(!base.settings?.reading_enabled?'disabled':'')+ui('>Tout marquer comme non lu</button></div><p class="hint">Le temps réellement passé est conservé. Enregistre les réglages pour activer le suivi.</p></section>');
}
export function readingDashboardHtml(bases){
 if(!bases.length)return ui('<div class="empty"><h2>Aucune lecture en cours</h2><p>Active « Suivre la lecture » dans les réglages d’une base de cours ou de parties.</p><button data-page="library">Ouvrir la bibliothèque</button></div>');
 return '<div class="reading-grid">'+bases.map(b=>'<section class="panel reading-card"><div class="reading-card-heading"><h2>'+esc(b.name)+'</h2><strong>'+readingPercent(b.percent)+'</strong></div><progress max="100" value="'+(Number(b.percent)||0)+'" aria-label="'+esc(t('Lecture de {name}',{name:b.name}))+'"></progress><div class="reading-card-stats"><span><strong>'+b.completed_entries+' / '+b.total_entries+ui('</strong> parties lues</span><span><strong>')+readingTime(b.active_seconds)+ui('</strong> de lecture</span><span><strong>')+readingTime(b.remaining_seconds)+ui('</strong> restant estimé</span></div><div class="actions"><button class="primary" data-reading-continue="')+b.base_id+'" '+(!b.continue_entry_id?'disabled':'')+ui('>Continuer la lecture</button><button data-reading-bookmark="')+b.base_id+'" '+(!b.last_entry_id?'disabled':'')+ui('>Dernier signet</button><button data-base="')+b.base_id+ui('">Parties</button></div></section>')).join('')+ui('</div><p class="hint reading-estimate-note">La progression porte sur la ligne principale. Le temps exclut les onglets masqués et les périodes sans activité. L’estimation se précise avec ton rythme de lecture.</p>');
}
export function readingStripHtml(reading){
 if(!reading?.enabled)return '';
 return ui('<span class="reading-strip-label">Lecture <strong>')+readingPercent(reading.percent)+'</strong>'+(reading.completed?t(' · Terminée'):'')+ui('</span><button type="button" data-reading-jump title="Revenir au signet de cette partie">⚑ Signet</button><button type="button" data-reading-next>Continuer</button><button type="button" data-reading-overview title="Voir toutes les lectures">Lectures</button><button type="button" data-reading-retry hidden>Réessayer</button>');
}
export function readingBaseSummaryHtml(base,entries){
 if(!base.settings?.reading_enabled)return '';
 if(!entries)return ui('<div class="reading-base-summary"><span>Suivi de lecture activé</span><button type="button" data-page="reading">Voir mes lectures</button></div>');
 const tracked=entries.map(e=>e.reading).filter(r=>r?.enabled),total=tracked.reduce((sum,r)=>sum+Math.max(1,r.total_moves),0),read=tracked.reduce((sum,r)=>sum+(r.total_moves?r.read_moves:Number(r.completed)),0);
 return ui('<div class="reading-base-summary"><span>Lecture <strong>')+readingPercent(total?100*read/total:0)+'</strong> · '+tracked.filter(r=>r.completed).length+' / '+entries.length+ui(' parties lues</span><button type="button" data-page="reading">Voir mes lectures</button></div>');
}

// Serialize writes across board replacement, so an old heartbeat cannot undo a
// manual bookmark. Unique receipts make retrying an uncertain response safe.
let writes=Promise.resolve();
let readingContext=0;
const failedByEntry=new Map();
export function resetReadingContext(){readingContext++;failedByEntry.clear();}
export const flushReadingWrites=()=>writes;
const receipt=()=>globalThis.crypto?.randomUUID?.()||Date.now()+'-'+Math.random().toString(36).slice(2);
export class ReadingTracker{
 constructor({doc,path='',training_run_id=null,paused=false,request=api,onUpdate=()=>{},onError=()=>{},document:page=globalThis.document,window:win=globalThis.window,now=()=>Date.now(),setInterval:every=(...args)=>globalThis.setInterval(...args),clearInterval:stop=(...args)=>globalThis.clearInterval(...args),setTimeout:later=(...args)=>globalThis.setTimeout(...args),clearTimeout:cancel=(...args)=>globalThis.clearTimeout(...args)}={}){
  // Window timer methods require their Window receiver. Keep defaults wrapped
  // when storing them on a tracker; native methods reject this.cancel(...).
  Object.assign(this,{doc,request,onUpdate,onError,page,win,now,every,stop,later,cancel});this.reading=doc.reading;this.pending=null;this.seconds=0;this.lastTick=now();this.lastActivity=now();this.lastPath=null;this.failed=failedByEntry.get(doc.id)||[];failedByEntry.set(doc.id,this.failed);this.listeners=[];this.disposed=false;
  this.paused=!!paused;this.toolbarActiveMs=0;this.toolbarAcceptedMs=0;this.toolbarReceipts=new Set();
  this.visitId=receipt();this.visitSequence=0;this.visitRecorded=false;this.lastViewed=null;this.context=readingContext;
  // Capture the context before visit() schedules its very first write. Never
  // attach a programme retroactively to payloads already queued or retried.
  this.training_run_id=training_run_id||null;
  this.captureSource(doc);
  this.active=page?.visibilityState!=='hidden'&&page?.hasFocus?.()!==false;
  this.activity=()=>{this.tick();this.lastActivity=this.now();};
  for(const type of ['pointerdown','keydown','wheel','touchstart'])this.listen(page,type,this.activity);
  this.listen(page,'visibilitychange',()=>{this.tick();this.active=page.visibilityState!=='hidden'&&page.hasFocus?.()!==false;if(!this.active)this.flush({endVisit:true});else this.lastActivity=this.now();});
  this.listen(win,'blur',()=>{this.tick();this.active=false;this.flush({endVisit:true});});this.listen(win,'focus',()=>{this.tick();this.active=page.visibilityState!=='hidden';this.lastActivity=this.now();});
  this.listen(win,'pagehide',()=>{this.tick();this.active=false;this.flush({endVisit:true});});
  this.timer=every(()=>{this.tick();this.flush();},15000);
  this.visit(doc,path);
 }
 listen(el,type,fn){el?.addEventListener?.(type,fn,{passive:true});this.listeners.push([el,type,fn]);}
 captureSource(doc){
  this.sourceInput=doc.analysis_source_line;
  this.sourceLine=(doc.analysis_source_line??mainlineNodes(doc)).map(({path,fen})=>({path,fen}));
  this.sourceKey=doc.reading?.content_key;
 }
 savedNode(path){return this.sourceKey===this.reading?.content_key?savedReadingNode(this.doc,path,this.sourceLine):null;}
 toolbarElapsedMs(){
  const pending=this.disposed||this.paused||!this.active?0:Math.min(Math.max(0,this.now()-this.lastTick),Math.max(0,this.lastActivity+90000-this.lastTick));
  return this.toolbarActiveMs+pending;
 }
 toolbarRecordedMs(){return this.toolbarAcceptedMs;}
 async pause(){if(this.disposed||this.paused)return;this.tick();this.paused=true;await this.flush({endVisit:true});}
 resume(){if(this.disposed||!this.paused)return;this.paused=false;this.lastTick=this.lastActivity=this.now();this.active=this.page?.visibilityState!=='hidden'&&this.page?.hasFocus?.()!==false;}
 tick(){
  const t=this.now(),elapsed=Math.max(0,t-this.lastTick),activeUntil=this.lastActivity+90000;
  if(!this.disposed&&!this.paused&&this.active){const accepted=Math.min(elapsed,Math.max(0,activeUntil-this.lastTick));this.seconds+=accepted/1000;this.toolbarActiveMs+=accepted;}
  this.lastTick=t;
 }
 visit(doc,path){
  if(this.disposed||doc.id!==this.doc.id)return;
  this.doc=doc;
  if(doc.reading?.content_key!==this.reading?.content_key){this.reading=doc.reading;this.pending=null;this.lastPath=null;this.lastViewed=null;if(!Array.isArray(doc.analysis_source_line))this.captureSource(doc);}
  if(Array.isArray(doc.analysis_source_line)&&doc.analysis_source_line!==this.sourceInput){this.captureSource(doc);this.lastPath=null;this.lastViewed=null;}
  if(!this.reading?.enabled||this.manualBusy||this.paused)return;
  this.tick();this.lastActivity=this.now();
  const saved=this.savedNode(path),identity=path+'\0'+(saved?.node.fen??'draft');
  if(identity===this.lastPath)return;this.lastPath=identity;
  if(!saved||saved.index>this.reading.total_moves)return;
  const {node,index}=saved;this.lastViewed={path,fen:node.fen};
  if(!this.pending||index>=this.pending.index)this.pending={path,index,fen:node.fen};
  this.cancel(this.debounce);this.debounce=this.later(()=>this.flush(),300);
 }
 send(payload){
  const context=this.context;
  const work=async()=>{
   if(context!==readingContext)return null;
   try{const result=await this.request('/api/entries/'+this.doc.id+'/reading',{method:'POST',body:payload,keepalive:true});
    if(context!==readingContext)return null;
    if(this.toolbarReceipts.delete(payload.request_id))this.toolbarAcceptedMs+=Math.max(0,payload.active_seconds||0)*1000;
    if(payload.content_key===this.reading?.content_key){this.reading=result;this.doc.reading=result;if(!this.disposed)this.onUpdate(result);}return result;
   }catch(error){if(context!==readingContext)return null;this.failed.push(payload);if(!this.disposed)this.onError(error);return null;}
  };
  writes=writes.then(work,work);return writes;
 }
 flush({endVisit=false}={}){
  if(this.context!==readingContext)return writes;
  this.cancel(this.debounce);this.debounce=null;
  const seconds=Math.min(60,Math.floor(this.seconds)),pending=this.pending;
  if(!this.reading?.enabled||this.manualBusy||(!pending&&!seconds&&!(endVisit&&this.visitRecorded)))return writes;
  const path=pending?.path??this.reading.bookmark_path??'',node=this.sourceLine.find(n=>n.path===path);
  // Time spent exploring a draft may count as reading time, but a heartbeat
  // must retain the saved bookmark/FEN rather than the edited tree's position.
  if(this.sourceKey!==this.reading.content_key||!node)return writes;
  this.seconds-=seconds;this.pending=null;
  const payload={mode:'visit',path,fen:pending?.fen??node?.fen,content_key:this.reading.content_key,revision:this.reading.revision,active_seconds:seconds,request_id:receipt(),visit_path:this.lastViewed?.path??path,visit_fen:this.lastViewed?.fen??node.fen,visit_id:this.visitId,visit_sequence:++this.visitSequence,visit_end:endVisit,...(this.training_run_id?{training_run_id:this.training_run_id}:{})};
  this.toolbarReceipts.add(payload.request_id);
  this.visitRecorded=true;if(endVisit){this.visitId=receipt();this.visitSequence=0;this.visitRecorded=false;}
  return this.send(payload);
 }
 async bookmark(path){
  const saved=this.savedNode(path);
  if(this.disposed||this.manualBusy||!this.reading?.enabled||!saved)return false;
  this.tick();const flushed=this.flush();this.manualBusy=true;
  try{await flushed;
   if(this.failed.length)throw new Error(t('Réessaie l’enregistrement de la lecture avant de déplacer le signet.'));
   const result=await this.send({mode:'bookmark',path,fen:saved.node.fen,content_key:this.reading.content_key,revision:this.reading.revision,active_seconds:0,request_id:receipt()});
   return !!result;
  }finally{this.manualBusy=false;}
 }
 async retry(){
  const pending=this.failed.splice(0);for(const payload of pending)await this.send(payload);
  if(this.failed.length){
   // A revision/content conflict requires the current server bookmark, never a
   // forced replay that could erase a manual reset made on another device.
   try{const current=await this.request('/api/entries/'+this.doc.id+'/reading');
    if(this.failed.some(p=>p.content_key!==current.content_key||p.revision!==current.revision)){
     this.failed.splice(0);this.pending=null;this.reading=current;this.doc.reading=current;if(!this.disposed)this.onUpdate(current);
    }
   }catch{}
  }
  return !this.failed.length;
 }
 async settle(){this.tick();await this.flush();if(this.failed.length&&!await this.retry())throw new Error(t('Le suivi de lecture n’a pas pu être enregistré. Réessaie avant de changer de partie.'));}
 dispose({flush=true}={}){if(this.disposed)return;if(flush){this.tick();this.flush({endVisit:true});}this.disposed=true;
  this.toolbarPauseOverlay?.remove();this.toolbarPauseOverlay=null;
  for(const {node,inert} of this.toolbarPauseRegions||[])node.inert=inert;this.toolbarPauseRegions=[];
  this.stop(this.timer);this.cancel(this.debounce);for(const [el,type,fn] of this.listeners)el?.removeEventListener?.(type,fn);this.listeners=[];}
}
