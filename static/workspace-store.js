import {t} from './i18n.js';
// Local writes are synchronous; remote writes are serialized and use CAS.
// A conflict never overwrites either copy. The caller must resolve it explicitly.
export class WorkspaceStore {
 constructor({request,storage,onChange=()=>{},delay=700}={}){this.request=request;try{this.storage=storage===undefined?globalThis.localStorage:storage;}catch(error){this.storage=null;this.localError=error;}this.onChange=onChange;this.delay=delay;this.items=new Map();this.enabled=false;this.ready=false;this.user=null;this.timer=null;this.tail=Promise.resolve();this.epoch=0;}
 async open(user,{remote=false,namespace="initial"}={}){
  this.close();const epoch=this.epoch;this.user=String(user||'');this.enabled=remote;this.prefix='chessgym-workspace-v1:'+encodeURIComponent(this.user)+(namespace!=='initial'?':epoch:'+encodeURIComponent(namespace):'');this.items=new Map();this.persisted=new Map();this.manifestKeys=null;this.loadedKeys=new Set();this.quarantined=new Set();this.manifestCorrupt=false;this.localError=null;
  try{
   const saved=JSON.parse(this.storage?.getItem(this.prefix)||'{}');
   if(saved.format===2){
    if(!Array.isArray(saved.keys))throw new Error('Invalid workspace manifest');
    for(const key of saved.keys){
     this.loadedKeys.add(key);
     try{const value=JSON.parse(this.storage?.getItem(this.slotKey(key))||'null');if(value&&typeof value==='object')this.items.set(key,value);}
     catch{this.quarantined.add(key);}
    }
   }else for(const [key,value]of Object.entries(saved))if(value&&typeof value==='object')this.items.set(key,value);
  }catch{this.manifestCorrupt=true;}
  if(this.manifestCorrupt||this.quarantined.size)this.localError=new Error(t('Un brouillon local est illisible. Sa copie est conservée; les autres brouillons restent disponibles.'));
  if(remote){try{const result=await this.request('/api/workspace');if(epoch!==this.epoch)return;for(const remote of result.items||[]){const local=this.items.get(remote.key);if(!local)this.items.set(remote.key,{...remote,dirty:false,version:0});else if(local.dirty||local.retainedAfterDiscard){if(local.revision!==remote.revision&&JSON.stringify(local.data)!==JSON.stringify(remote.data))local.conflict=remote;else if(JSON.stringify(local.data)===JSON.stringify(remote.data))Object.assign(local,remote,{dirty:false,conflict:null,retainedAfterDiscard:false});}else this.items.set(remote.key,{...remote,dirty:false,version:0});}
   const keys=new Set((result.items||[]).map(item=>item.key));for(const[key,item]of this.items)if(!keys.has(key)&&item.revision){if(item.dirty)item.conflict={key,revision:0,data:null};else this.items.delete(key);}
  }catch(error){if(epoch!==this.epoch)return;this.loadError=error;}}
  if(epoch!==this.epoch)return;this.ready=true;this.persist();this.onChange();this.schedule();
 }
 close(){clearTimeout(this.timer);this.timer=null;this.epoch++;this.ready=false;this.enabled=false;this.user=null;this.loadError=null;this.tail=Promise.resolve();}
 get(key){const item=this.items.get(key);return item?.data==null?null:structuredClone(item.data);}
 info(key){const item=this.items.get(key);return {dirty:!!item?.dirty||!!item?.retainedAfterDiscard,conflict:item?.conflict||null,error:item?.error||(item?.retainedAfterDiscard?t('La suppression est incomplète. Cette copie reste conservée sur cet appareil.'):null)||this.loadError||this.localError,remote:this.enabled,saved:!!item&&!item.dirty&&!item.conflict&&!item.retainedAfterDiscard};}
 set(key,data){const old=this.items.get(key)||{revision:0,version:0};if(JSON.stringify(old.data)===JSON.stringify(data))return;this.items.set(key,{...old,key,data:structuredClone(data),dirty:true,version:(old.version||0)+1,updated_at:new Date().toISOString(),error:null,retainedAfterDiscard:false});this.persist();this.onChange(key);this.schedule();}
 remove(key){this.set(key,null);}
 slotKey(key){return this.prefix+':slot:'+encodeURIComponent(key);}
 persist(){
  if(!this.ready)return;
  try{
   if(!this.storage)throw new Error('Stockage de cet appareil indisponible.');
   if(this.manifestCorrupt)throw this.localError;
   this.persisted||=new Map();
   for(const [key,item]of this.items){
    if(this.quarantined?.has(key))continue;
    const signature=[item,item.version,item.revision,item.dirty,item.conflict,item.error,item.retainedAfterDiscard],old=this.persisted.get(key);
    if(!old||signature.some((value,index)=>value!==old[index])){this.storage.setItem(this.slotKey(key),JSON.stringify(item));this.persisted.set(key,signature);}
   }
   const keys=JSON.stringify([...new Set([...this.items.keys(),...(this.quarantined||[])])]);
   if(keys!==this.manifestKeys){this.storage.setItem(this.prefix,'{"format":2,"keys":'+keys+'}');this.manifestKeys=keys;}
   for(const key of new Set([...this.persisted.keys(),...(this.loadedKeys||[])]))if(!this.items.has(key)&&!this.quarantined?.has(key)){if(this.storage.removeItem)this.storage.removeItem(this.slotKey(key));else this.storage.setItem(this.slotKey(key),'null');this.persisted.delete(key);this.loadedKeys?.delete(key);}
   if(!this.quarantined?.size)this.localError=null;
  }catch(error){this.localError=error;}
 }
 schedule(){clearTimeout(this.timer);if(this.enabled&&this.ready&&!this.loadError)this.timer=setTimeout(()=>void this.flush(),this.delay);}
 flush(){clearTimeout(this.timer);const epoch=this.epoch;const run=async()=>{if(epoch!==this.epoch||!this.ready||!this.enabled||this.loadError)return;for(const[key,item]of this.items){if(!item.dirty||item.conflict||this.quarantined?.has(key))continue;const version=item.version,data=structuredClone(item.data),revision=item.revision;
   try{const result=await this.request('/api/workspace/'+encodeURIComponent(key)+(data===null?'?expected_revision='+revision:''),{method:data===null?'DELETE':'PUT',...(data===null?{}:{body:{expected_revision:revision,data}})});if(epoch!==this.epoch)return;const current=this.items.get(key);current.revision=result?.revision||0;current.error=null;if(current.version===version){current.dirty=false;if(data===null)this.items.delete(key);}this.persist();this.onChange(key);}
   catch(error){if(epoch!==this.epoch)return;const current=this.items.get(key);current.error=error.message;if(error.status===409){let conflict;try{conflict=await this.request('/api/workspace/'+encodeURIComponent(key));}catch{conflict={unavailable:true};}if(epoch!==this.epoch)return;this.items.get(key).conflict=conflict;}this.persist();this.onChange(key);}
  }};this.tail=this.tail.then(run,run);return this.tail;}
 // Unlike a tombstone write, an explicit discard keeps the local content
 // until all acknowledgements arrive. A conflict never destroys the local copy.
 discard(keys){
  clearTimeout(this.timer);const epoch=this.epoch,selected=[...new Set(keys)].filter(key=>this.items.has(key));
  const versions=new Map(selected.map(key=>[key,this.items.get(key).version]));
  const unchanged=()=>epoch===this.epoch&&this.ready&&selected.every(key=>this.items.get(key)?.version===versions.get(key));
  const run=async()=>{
   if(!unchanged())throw new Error(t('Le brouillon a changé. Rouvre la liste avant de le supprimer.'));
   if(this.enabled&&this.loadError)throw new Error(t('La synchronisation est indisponible. Le brouillon reste conservé.'));
   if(selected.some(key=>this.items.get(key).conflict))throw new Error(t('Résous le conflit avant de supprimer ce brouillon.'));
   for(const key of selected){
    const item=this.items.get(key);
    if(this.enabled){
     try{await this.request('/api/workspace/'+encodeURIComponent(key)+'?expected_revision='+item.revision,{method:'DELETE'});}
     catch(error){
      if(epoch!==this.epoch)throw error;
      if(error.status===409){let conflict;try{conflict=await this.request('/api/workspace/'+encodeURIComponent(key));}catch{conflict={unavailable:true};}if(epoch!==this.epoch)throw error;const current=this.items.get(key);if(current){current.conflict=conflict;current.error=error.message;}}
      this.persist();this.onChange(key);throw error;
     }
     if(epoch!==this.epoch)throw new Error(t('L’espace ouvert a changé.'));
     const current=this.items.get(key);
     if(current){current.revision=0;current.dirty=current.version!==versions.get(key);current.error=null;current.retainedAfterDiscard=!current.dirty;}
     this.persist();
     if(!unchanged()){this.schedule();throw new Error(t('Le brouillon a changé. Rouvre la liste avant de le supprimer.'));}
    }
   }
   if(!unchanged())throw new Error(t('Le brouillon a changé. Rouvre la liste avant de le supprimer.'));
   selected.forEach(key=>this.items.delete(key));this.persist();this.onChange();
  };
  this.tail=this.tail.then(run,run);return this.tail;
 }
 async resolve(key,choice){const epoch=this.epoch,item=this.items.get(key),version=item?.version;if(!item?.conflict)return;const remote=await this.request('/api/workspace/'+encodeURIComponent(key));if(epoch!==this.epoch)return;if(this.items.get(key)!==item||item.version!==version)throw new Error('Le brouillon a changé. Vérifie la nouvelle version avant de choisir.');if(choice==='remote'){this.items.set(key,{...remote,dirty:false,version:(item.version||0)+1});}else{item.revision=remote.revision;item.conflict=null;item.error=null;item.retainedAfterDiscard=false;item.dirty=true;}this.persist();this.onChange(key);if(choice==='local')await this.flush();}
}
