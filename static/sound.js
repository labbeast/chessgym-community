// Bundled Kenney CC0 sounds; provenance is in sounds/kenney/README.md.
export const DEFAULT_SOUND=Object.freeze({enabled:true,volume:.35,moves:true,feedback:true,navigation:false});
export const SOUND_FILES=Object.freeze({move:'move.wav',capture:'capture.wav',castle:'move.wav',correct:'correct.wav',incorrect:'incorrect.wav',complete:'complete.wav'});
const feedback=new Set(['correct','incorrect','complete']);
export function soundSettings(value={}){
 const result={...DEFAULT_SOUND};
 for(const key of ['enabled','moves','feedback','navigation'])if(typeof value?.[key]==='boolean')result[key]=value[key];
 if(typeof value?.volume==='number'&&Number.isFinite(value.volume))result.volume=Math.max(0,Math.min(1,value.volume));
 return result;
}
export function moveSound(san=''){return /^[O0]-[O0]/.test(san)?'castle':san.includes('x')?'capture':'move';}
export class SoundPlayer {
 constructor({contextFactory=()=>{const C=globalThis.AudioContext||globalThis.webkitAudioContext;return C?new C():null;},fetchAudio=url=>globalThis.fetch(url)}={}){
  this.contextFactory=contextFactory;this.fetchAudio=fetchAudio;this.context=null;this.settings={...DEFAULT_SOUND};this.lastFeedback=-Infinity;
  this.buffers=new Map();this.loading=new Map();this.resuming=null;
 }
 configure(value){this.settings=soundSettings(value);}
 load(file){
  if(this.buffers.has(file))return Promise.resolve(this.buffers.get(file));
  if(!this.loading.has(file)){
   const loading=Promise.resolve().then(()=>this.fetchAudio(new URL('./sounds/kenney/'+file,import.meta.url)))
    .then(response=>{if(!response.ok)throw new Error('Sound unavailable');return response.arrayBuffer();})
    .then(bytes=>this.context.decodeAudioData(bytes))
    .then(buffer=>{this.buffers.set(file,buffer);return buffer;})
    .finally(()=>this.loading.delete(file));
   this.loading.set(file,loading);
  }
  return this.loading.get(file);
 }
 unlock(){
  if(!this.settings.enabled||this.settings.volume===0)return;
  try{
   this.context??=this.contextFactory();if(!this.context||this.context.state==='closed')return;
   if(this.context.state==='suspended'&&!this.resuming)this.resuming=Promise.resolve(this.context.resume()).catch(()=>{}).finally(()=>{this.resuming=null;});
   // First interaction warms the small local samples for subsequent moves.
   for(const file of new Set(Object.values(SOUND_FILES)))void this.load(file).catch(()=>{});
  }catch{}
 }
 play(event,{navigation=false,preview=false}={}){
  const p=this.settings,kind=feedback.has(event)?'feedback':'moves';
  if(!p.enabled||p.volume===0||(!preview&&(!p[kind]||navigation&&!p.navigation)))return false;
  if(!Object.hasOwn(SOUND_FILES,event))return false;
  this.unlock();const ctx=this.context;if(!ctx||ctx.state==='closed')return false;
  // A correction/result should remain audible over an immediately preceding move.
  const now=ctx.currentTime;if(kind==='moves'&&now-this.lastFeedback<.12)return false;
  if(kind==='feedback')this.lastFeedback=now;
  const requestedAt=performance.now(),file=SOUND_FILES[event];
  const start=buffer=>{
   // Do not replay stale moves after a slow load, or after sound was muted.
   // Previews retain the form's volume while its saved settings are restored.
   const current=preview?p:this.settings;
   if(ctx.state!=='running'||performance.now()-requestedAt>1000||!current.enabled||current.volume===0||(!preview&&(!current[kind]||navigation&&!current.navigation)))return false;
   if(kind==='moves'&&ctx.currentTime-this.lastFeedback<.12)return false;
   try{
    const source=ctx.createBufferSource(),gain=ctx.createGain();source.buffer=buffer;gain.gain.value=current.volume;
    source.connect(gain);gain.connect(ctx.destination);source.onended=()=>{source.disconnect();gain.disconnect();};source.start();return true;
   }catch{return false;}
  };
  if(this.buffers.has(file)&&ctx.state==='running')return start(this.buffers.get(file));
  void Promise.all([this.load(file),this.resuming]).then(([buffer])=>start(buffer)).catch(()=>{});
  return true;
 }
}
export const soundPlayer=new SoundPlayer();
export function configureSound(preferences){soundPlayer.configure(preferences?.sound||preferences||{});}
export function playSound(event,options){return soundPlayer.play(event,options);}
let listening=false;
export function installSoundGestures(){if(listening||!globalThis.document)return;listening=true;for(const event of ['pointerdown','keydown'])document.addEventListener(event,()=>soundPlayer.unlock(),{capture:true,passive:true});}
