// Project live native measurements over the server's accepted counters. Keeping
// samples for the previous source avoids a countdown jump between exercises.
export class TrainingToolbarProgress {
 constructor(){this.runId=null;this.samples=new Map();}
 reset(){this.runId=null;this.samples.clear();}
 elapsed(run,native){
  if(this.runId!==run.id){this.reset();this.runId=run.id;}
  if(!Array.isArray(run.native_progress))return null;
  const valid=typeof native?.measurementMs==='number'&&Number.isFinite(native.measurementMs);
  if(valid&&native.programId===run.id&&native.nativeId!=null){
   const key=native.sourceTool+':'+native.nativeId;
   this.samples.set(key,Math.max(this.samples.get(key)||0,native.measurementMs));
  }
  const recorded=new Map(run.native_progress.map(item=>[item.tool+':'+item.source_id,Math.max(0,item.duration_ms||0)]));
  let elapsed=Math.max(0,run.duration_ms||0);
  for(const [key,value] of this.samples)elapsed+=Math.max(0,value-(recorded.get(key)||0));
  return valid||this.samples.size?elapsed:null;
 }
}
