// Attach only annotations on the accepted source branch. Detached review paths
// are usually all zeroes and cannot be used as paths into the original PGN.
export function reviewSourceAnnotations(card,attempt,sourceDoc){
 const doc=attempt.doc,sourceNodes=new Map((sourceDoc?.nodes||[]).map(node=>[node.path,node])),attemptNodes=new Map((doc?.nodes||[]).map(node=>[node.path,node]));
 let source=sourceNodes.get(card.path||''),node=attemptNodes.get('');
 if(!source||!node||source.fen!==card.fen)return {doc,finalComment:''};
 const annotations=new Map();
 const remember=()=>annotations.set(node.path,{comment:source.comment||'',starting_comment:source.starting_comment||'',nags:[...(source.nags||[])]});
 remember();let found=0;
 for(;found<attempt.ply;found++){
  node=attemptNodes.get(node.children?.[0]);if(!node?.uci)break;
  source=(source.children||[]).map(path=>sourceNodes.get(path)).find(child=>child?.uci===node.uci);if(!source)break;
  remember();
 }
 return {doc:{...doc,nodes:doc.nodes.map(node=>annotations.has(node.path)?{...node,...annotations.get(node.path)}:node)},finalComment:found===attempt.ply?source?.comment||'':''};
}

export function reviewExplanationComments(initial,final){
 const comments=[initial,final].map(value=>String(value||'').replace(/\[%[^\]]+\]/g,'').trim()).filter(Boolean);
 return [...new Set(comments)];
}
