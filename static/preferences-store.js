import {api} from './api.js';

const clone=value=>structuredClone(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
export function mergePreferences(current,patch){
 const result={...current};
 for(const [key,value] of Object.entries(patch||{}))result[key]=object(value)?mergePreferences(object(result[key])?result[key]:{},value):clone(value);
 return result;
}

// All account preference writes share one recoverable queue. Late replies from
// an old login or restore epoch never reach the next account's UI.
export class PreferencesService {
 constructor({request=api}={}){this.request=request;this.listeners=new Set();this.close();}
 open(owner,{initial={},epoch='initial'}={}){this.close();this.owner=owner;this.accountEpoch=epoch;this.value=clone(initial);return this.get();}
 close(){this.generation=(this.generation||0)+1;this.owner=null;this.value={};this.tail=Promise.resolve();}
 get(){return clone(this.value);}
 subscribe(listener){this.listeners.add(listener);return()=>this.listeners.delete(listener);}
 patch(partial,{isCurrent=()=>true}={}){
  const generation=this.generation,payload=clone(partial);
  const run=async()=>{
   if(generation!==this.generation||!this.owner||!isCurrent())return null;
   const result=await this.request('/api/preferences',{method:'PATCH',body:payload});
   if(generation!==this.generation)return null;
   this.value=mergePreferences(this.value,result||payload);
   const value=this.get();for(const listener of this.listeners)listener(value);
   return isCurrent()?value:null;
  };
  const result=this.tail.then(run,run);this.tail=result.catch(()=>{});return result;
 }
}
export const preferencesService=new PreferencesService();
