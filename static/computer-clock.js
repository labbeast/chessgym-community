// Only monotonic, visible play time is charged. No wall-clock timestamp is
// persisted: loading a saved clock always starts paused, including after sleep.
const other=side=>side==='white'?'black':'white';
const copy=value=>structuredClone(value);
const presets={'3+0':[3,0],'5+0':[5,0],'10+0':[10,0],'15+10':[15,10],'30+0':[30,0]};
export function clockSettings(config={}){
 const mode=config.time_control||'unlimited';if(mode==='unlimited')return null;
 const [minutes,increment]=presets[mode]||(mode==='custom'?[Number(config.clock_minutes),Number(config.clock_increment)]:[]);
 if(!Number.isFinite(minutes)||minutes<.1||minutes>180||!Number.isFinite(increment)||increment<0||increment>180)throw new Error('invalid_clock');
 return {initial_ms:Math.round(minutes*60)*1000,increment_ms:Math.round(increment)*1000};
}
export function newClock(config,ply=0){
 const settings=clockSettings(config);if(!settings)return null;
 const remaining={white:settings.initial_ms,black:settings.initial_ms};
 return {version:1,...settings,remaining,paused:true,running:null,expired:null,history:[{ply,remaining:copy(remaining)}]};
}
export function clockText(milliseconds){
 const total=Math.max(0,Math.ceil(Number(milliseconds)/1000)),seconds=total%60,minutes=Math.floor(total/60);
 return minutes+':'+String(seconds).padStart(2,'0');
}
export class ComputerClock {
 constructor(state,{now=()=>performance.now()}={}){
  this.state=state;this.now=now;this.last=null;this.held=false;
  state.paused=true;state.running=null;
 }
 read(){
  const s=this.state,current=this.now();
  if(this.last!==null&&!s.paused&&!this.held&&s.running&&!s.expired){
   s.remaining[s.running]=Math.max(0,s.remaining[s.running]-Math.max(0,current-this.last));
   if(s.remaining[s.running]===0){s.expired=s.running;s.paused=true;s.running=null;}
  }
  this.last=!s.paused&&!this.held&&s.running&&!s.expired?current:null;return s;
 }
 start(side){if(this.state.expired)return false;this.state.paused=false;this.state.running=side;this.held=false;this.last=this.now();return true;}
 hold(){this.read();this.held=true;this.last=null;return this.state.expired;}
 pause(){this.read();this.state.paused=true;this.state.running=null;this.held=false;this.last=null;return this.state.expired;}
 commit(side,ply,{finished=false}={}){
  this.read();const s=this.state;if(s.expired)return false;
  s.remaining[side]+=s.increment_ms;s.history=s.history.filter(item=>item.ply<ply);
  s.history.push({ply,remaining:copy(s.remaining)});this.held=false;
  if(finished)this.pause();else if(!s.paused)this.start(other(side));return true;
 }
 restore(ply){
  this.pause();const s=this.state,entry=[...s.history].reverse().find(item=>item.ply<=ply);
  if(!entry)return false;s.remaining=copy(entry.remaining);s.history=s.history.filter(item=>item.ply<=ply);s.expired=null;return true;
 }
}
