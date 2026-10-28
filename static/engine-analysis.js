import {t,ui,locale} from './i18n.js';
import {api} from './api.js';
// Reuse completed analyses only for the exact position and search settings.
const completed=new Map(),CAPACITY=128,TTL=5*60*1000;
let selectedEngine={name:'Stockfish',identity:null},engineEpoch=0,statusCheckedAt=0,statusRequest=null;
export function analysisEngineName(){return selectedEngine.name||t('Moteur');}
export function applyAnalysisEngine(value){
 if(!value||typeof value!=='object')return false;
 const identity=value.identity??null,changed=identity!==selectedEngine.identity;
 if(changed)clearAnalysisCache();
 selectedEngine={name:value.name||t('Moteur'),identity};statusCheckedAt=Date.now();return changed;
}
export function refreshAnalysisEngine(){
 // Keep the fresh-status path synchronous so cached positions render immediately.
 if(selectedEngine.identity===null||Date.now()-statusCheckedAt<5000)return false;
 if(statusRequest)return statusRequest;
 const epoch=engineEpoch;
 const request=api('/api/engine/status').then(value=>epoch===engineEpoch?applyAnalysisEngine(value):false).finally(()=>{if(statusRequest===request)statusRequest=null;});
 statusRequest=request;return request;
}
export const ANALYSIS_SETTINGS=Object.freeze({multipv:3,time_ms:1000});
const keyFor=(fen,settings)=>JSON.stringify([fen,settings.multipv,settings.time_ms,settings.depth??null]);
export function cachedAnalysis(fen,settings=ANALYSIS_SETTINGS){
 const key=keyFor(fen,settings),entry=completed.get(key);if(!entry)return null;
 if(Date.now()-entry.at>=TTL){completed.delete(key);return null;}
 completed.delete(key);completed.set(key,entry);return structuredClone(entry.result);
}
export function clearAnalysisCache(){completed.clear();engineEpoch++;statusCheckedAt=0;}
function remember(fen,settings,result){const key=keyFor(fen,settings);completed.delete(key);completed.set(key,{at:Date.now(),result:structuredClone(result)});while(completed.size>CAPACITY)completed.delete(completed.keys().next().value);}
function cancelled(){return new DOMException(t('Analyse annulée.'),'AbortError');}
export async function streamAnalysis(fen,{settings=ANALYSIS_SETTINGS,signal,refresh=false,onUpdate=()=>{}}={}){
 const epoch=engineEpoch;
 const response=await fetch('/api/engine/analyse/stream',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({fen,...settings,refresh}),signal});
 if(!response.ok){let detail;try{detail=(await response.json()).detail;}catch{}throw new Error(typeof detail==='string'?detail:t('Le moteur ne répond pas comme prévu.'));}
 if(!response.body?.getReader)throw new Error(t('Le flux d’analyse est indisponible.'));
 const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',done=false;
 const consume=line=>{
  if(!line.trim())return;if(signal?.aborted||epoch!==engineEpoch)throw cancelled();
  let event;try{event=JSON.parse(line);}catch{throw new Error(t('Le moteur a renvoyé une analyse illisible.'));}
  if(event.type==='error')throw new Error(typeof event.detail==='string'?event.detail:t('L’analyse a été interrompue.'));
  if(!['info','done'].includes(event.type)||event.fen!==fen||!Array.isArray(event.lines))throw new Error(t('Cette analyse ne correspond pas à la position affichée.'));
  const result={fen,engine:event.engine,lines:event.lines,cached:!!event.cached};
  // Cache before exposing the object: previews attach promises to their local PV.
  if(event.type==='done'){remember(fen,settings,result);done=true;}
  onUpdate(result,event.type);
 };
 try{
  while(!done){if(signal?.aborted||epoch!==engineEpoch)throw cancelled();const next=await reader.read();if(signal?.aborted||epoch!==engineEpoch)throw cancelled();buffer+=decoder.decode(next.value||new Uint8Array(),{stream:!next.done});
   if(buffer.length>4*1024*1024)throw new Error(t('Le flux d’analyse est trop volumineux.'));
   let newline;while(!done&&(newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);consume(line);}
   if(next.done){if(!done&&buffer.trim())consume(buffer);if(!done)throw new Error(t('L’analyse a été interrompue avant la fin.'));break;}
  }
 }finally{try{await reader.cancel();}catch{}reader.releaseLock?.();}
}
