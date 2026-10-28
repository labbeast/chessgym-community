import {api} from './api.js';
import {analysisIdentity} from './workspace-drafts.js';

const stored=(store,key)=>store?.items?.get(key)?.data??store?.get?.(key)??null;
const validIdentity=identity=>typeof identity==='string'&&identity.length<=240&&(/^entry:[1-9]\d*$/.test(identity)||/^free:.+/.test(identity));
const validNode=node=>typeof node?.fen==='string'&&node.fen.trim();

// The compact view is the last visited position, independently of the PGN's
// final move or the older position captured with an unsaved document.
export async function boardRecentPosition({identity,store,currentDoc,currentPath,currentFlipped,request=api,signal}={}){
 if(!validIdentity(identity))return null;
 signal?.throwIfAborted?.();
 const view=stored(store,'view:'+identity)||{},own=stored(store,'document:'+identity),last=stored(store,'analysis');
 const ownIdentity=analysisIdentity(own?.doc);
 const snapshot=own?.doc&&(ownIdentity===identity||!ownIdentity&&identity.startsWith('free:'))?own:analysisIdentity(last?.doc)===identity?last:null;
 const current=analysisIdentity(currentDoc)===identity;
 let doc=current?currentDoc:snapshot?.doc;
 const saved={...snapshot,...view};
 const path=current&&typeof currentPath==='string'?currentPath:saved.path;
 const flipped=current&&typeof currentFlipped==='boolean'?currentFlipped:!!saved.flipped;
 if(!doc&&identity.startsWith('entry:')){
  doc=await request('/api/entries/'+identity.slice(6),{signal});
  signal?.throwIfAborted?.();
  if(analysisIdentity(doc)!==identity)return null;
 }
 if(!Array.isArray(doc?.nodes))return null;
 const at=value=>typeof value==='string'?doc.nodes.find(node=>node.path===value&&validNode(node)):null;
 const node=at(path)||at(doc.start_path)||at('');
 return node?{fen:node.fen,flipped,uci:typeof node.uci==='string'&&node.uci?node.uci:null,path:node.path}:null;
}
