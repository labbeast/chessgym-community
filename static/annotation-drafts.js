export const ANNOTATION_NAGS=[1,2,3,4,5,6,10,14,15,16,17,18,19];
export const visibleComment=node=>(node.comment||'').replace(/\[%[^\]]+\]/g,'').trim();
export function documentKey(doc){if(doc.id)return 'entry:'+doc.id;if(!doc.workspace_id)doc.workspace_id=globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);return 'free:'+doc.workspace_id;}
const same=(a,b)=>a.comment===b.comment&&JSON.stringify([...(a.nags||[])].sort((a,b)=>a-b))===JSON.stringify([...(b.nags||[])].sort((a,b)=>a-b));
export class AnnotationDrafts {
 constructor(store){this.store=store;}
 key(doc){return 'annotation:'+documentKey(doc);}
 all(doc){return this.store.get(this.key(doc))?.nodes||{};}
 get(doc,path){const draft=this.all(doc)[path],node=doc.nodes.find(n=>n.path===path);return draft&&node&&draft.fen===node.fen&&draft.uci===node.uci?draft:null;}
 capture(doc,path,form){const node=doc.nodes.find(n=>n.path===path),input=form?.querySelector('[name="comment"]');if(!node||!input)return;
  const draft={comment:input.value,nags:[...form.querySelectorAll('input[name="nag"]:checked')].map(el=>Number(el.value)).concat((node.nags||[]).filter(n=>!ANNOTATION_NAGS.includes(n))),fen:node.fen,uci:node.uci};
  const nodes=this.all(doc);if(same(draft,{comment:visibleComment(node),nags:node.nags}))delete nodes[path];else nodes[path]=draft;
  if(Object.keys(nodes).length)this.store.set(this.key(doc),{entry_id:doc.id||null,revision:this.store.get(this.key(doc))?.revision||doc.revision||null,nodes});else if(this.store.get(this.key(doc)))this.store.remove(this.key(doc));
 }
 advance(source,saved){if(!source?.id||source.id!==saved?.id||source.revision===saved.revision)return;const key=this.key(source),value=this.store.get(key);if(value&&value.revision===source.revision)this.store.set(key,{...value,revision:saved.revision});}
 overlay(doc){let result=doc;for(const node of doc.nodes){const draft=this.get(doc,node.path);if(!draft||same(draft,{comment:visibleComment(node),nags:node.nags}))continue;if(result===doc)result=structuredClone(doc);const target=result.nodes.find(n=>n.path===node.path);target.comment=[draft.comment,...(node.comment||'').match(/\[%[^\]]+\]/g)||[]].filter(Boolean).join(' ');target.nags=[...draft.nags];}return result;}
 acknowledge(source,saved){const nodes=this.all(source);for(const[path,draft]of Object.entries(nodes)){const node=saved.nodes.find(n=>n.path===path&&n.fen===draft.fen);if(node&&same(draft,{comment:visibleComment(node),nags:node.nags}))delete nodes[path];}if(Object.keys(nodes).length)this.store.set(this.key(source),{entry_id:source.id||null,revision:saved.revision||null,nodes});else this.store.remove(this.key(source));}
 has(doc){return Object.keys(this.all(doc)).length>0;}
}
