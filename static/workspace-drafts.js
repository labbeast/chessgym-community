import {START} from './api.js';

// Deliberately conservative: a diagram, annotation or edited PGN header is work,
// even when there is no move. View preferences alone do not make a draft.
export function analysisIdentity(doc){return doc?.id?'entry:'+doc.id:doc?.workspace_id?'free:'+doc.workspace_id:null;}
export function isPristineAnalysis(snapshot,annotation){
 const doc=snapshot?.doc,root=doc?.nodes?.[0];
 if(!doc||doc.id||!Array.isArray(doc.nodes)||doc.nodes.length!==1||!root||root.path!==''||root.fen!==START)return false;
 if(root.san||root.uci||root.comment?.trim()||root.starting_comment?.trim()||root.nags?.length||root.children?.length||root.clock!=null||root.elapsed!=null)return false;
 if(doc.title?.trim()||snapshot.drawings?.length||Object.keys(annotation?.nodes||{}).length)return false;
 return Object.entries(doc.headers||{}).every(([key,value])=>key==='Result'&&value==='*');
}
export function annotationFor(store,snapshot,key=''){
 const identity=analysisIdentity(snapshot?.doc)||(key.startsWith('document:')?key.slice(9):null);
 if(!identity)return null;
 const annotationKey='annotation:'+identity;
 // A pending conflict can contain notes absent from the local annotation copy.
 if(store.info(annotationKey).conflict)return {nodes:{conflict:true}};
 return store.get(annotationKey);
}
export function pruneEmptyAnalyses(store){
 const removed=[];
 for(const[key,item]of store.items){
  if((key==='analysis'||key.startsWith('document:'))&&item.data&&!item.conflict&&isPristineAnalysis(analysisSnapshot(store,key),annotationFor(store,item.data,key))){store.remove(key);removed.push(key);}
 }
 return removed;
}
export function draftKeys(store,key){
 const snapshot=analysisSnapshot(store,key);if(!snapshot?.doc)return [];
 const identity=analysisIdentity(snapshot.doc)||(key.startsWith('document:')?key.slice(9):null);
 const keys=[key];
 if(identity){
  keys.push('document:'+identity,'annotation:'+identity,'view:'+identity);
  if(analysisIdentity(store.get('analysis')?.doc)===identity)keys.push('analysis');
 }
 return [...new Set(keys)].filter(item=>store.items.has(item));
}

// Navigation is kept in a small independent slot. Legacy full snapshots remain
// readable, and a restored draft always keeps its original PGN revision.
export function analysisSnapshot(store,key='analysis'){
 const snapshot=store.get(key);if(!snapshot?.doc)return snapshot;
 const identity=analysisIdentity(snapshot.doc)||(key.startsWith('document:')?key.slice(9):null);
 const view=identity?store.get('view:'+identity):null;
 return view?{...snapshot,...view,doc:snapshot.doc}:snapshot;
}
const captured=new WeakMap();
export function persistAnalysisSnapshot(store,doc,view,{draft=false}={}){
 const identity=analysisIdentity(doc);if(!identity)return;
 const previous=captured.get(store),changed=!previous||previous.doc!==doc||previous.nodes!==doc.nodes||previous.length!==doc.nodes?.length||previous.pgn!==doc.pgn||previous.headers!==doc.headers;
 if(changed||!store.items.get('analysis')?.data){store.set('analysis',{doc,...view});captured.set(store,{doc,nodes:doc.nodes,length:doc.nodes?.length,pgn:doc.pgn,headers:doc.headers});}
 if(draft&&(changed||!store.items.get('document:'+identity)?.data))store.set('document:'+identity,{doc,...view});
 store.set('view:'+identity,view);
}
