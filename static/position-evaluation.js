import {nodeIndex,serialize} from './chess-document.js';
import {importedMoveEvaluation,preferredEvaluation} from './move-metrics.js';

// Metadata dialogs can stay open while automatic evaluations enrich comments.
// All other content changes still invalidate an older dialog response.
export function evaluationIndependentContent(doc){
 return JSON.stringify({headers:doc.headers,title:doc.title,start_path:doc.start_path,revision:doc.revision,
  nodes:doc.nodes.map(node=>({...node,comment:String(node.comment||'').replace(/\[%eval\b[^\]]*\]/gi,'').trim()}))});
}

// Keep the deepest exact-position score in the move's portable PGN annotation.
// A fresh document lets draft persistence and notation rendering detect the edit.
export function recordPositionEvaluation(doc,path,fen,line,stored=null){
 const node=nodeIndex(doc).get(path);
 if(!node||node.fen!==fen||!Number.isSafeInteger(line?.depth)||line.depth<0)return doc;
 const mate=Number.isInteger(line.mate)&&Math.abs(line.mate)<=100000;
 const cp=Number.isInteger(line.cp)&&Math.abs(line.cp)<=10000000;
 if(!mate&&!cp)return doc;
 const value={...(mate?{mate:line.mate}:{cp:line.cp}),depth:line.depth};
 const previous=preferredEvaluation(stored,importedMoveEvaluation(node.comment));
 if(preferredEvaluation(previous,value)!==value)return doc;
 const tag='[%eval '+(mate?'#'+line.mate:(line.cp/100).toFixed(2))+','+line.depth+']';
 let found=false;
 let comment=String(node.comment||'').replace(/\[%eval\b[^\]]*\]/gi,()=>{if(found)return '';found=true;return tag;});
 if(!found)comment+=(comment&&!/\s$/.test(comment)?' ':'')+tag;
 const result={...doc,nodes:doc.nodes.map(item=>item===node?{...item,comment}:item),analysis_dirty:true};
 result.pgn=serialize(result);return result;
}
