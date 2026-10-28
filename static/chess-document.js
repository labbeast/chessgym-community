import {t} from './i18n.js';
import {START} from './api.js';

// Documents are replaced on edits; cursor changes reuse their indexed tree.
const indexes=new WeakMap();
export function nodeIndex(doc){
 const nodes=doc?.nodes||[],old=doc&&indexes.get(doc);
 if(old&&old.nodes===nodes&&old.length===nodes.length)return old.map;
 const map=new Map(nodes.map(node=>[node.path,node]));
 if(doc)indexes.set(doc,{nodes,length:nodes.length,map});return map;
}
export function pieces(fen){const p={};fen.split(' ')[0].split('/').forEach((row,i)=>{let col=0;for(const c of row){if(/[1-8]/.test(c))col+=Number(c);else{p['abcdefgh'[col]+(8-i)]=c;col++;}}});return p;}
export function makeDoc(fen=START){return {headers:fen===START?{Result:'*'}:{SetUp:'1',FEN:fen,Result:'*'},nodes:[{path:'',parent:null,fen,san:null,uci:null,comment:'',nags:[],clock:null,elapsed:null,children:[]}]};}
export function serialize(doc){
 const map=nodeIndex(doc);const root=map.get('');
 const comment=n=>{let s=n.comment||'';if(n.clock!=null&&!s.includes('[%clk')){let seconds=Math.max(0,Number(n.clock));s+=' [%clk '+Math.floor(seconds/3600)+':'+String(Math.floor(seconds/60)%60).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')+']';}return s?' {'+s.replace(/[{}]/g,'')+'}':'';};
 const move=n=>{const parent=map.get(n.parent);const f=parent.fen.split(' ');return (n.starting_comment?' {'+n.starting_comment.replace(/[{}]/g,'')+'} ':'')+f[5]+(f[1]==='w'?'. ':'... ')+n.san+(n.nags||[]).map(x=>' $'+x).join('')+comment(n);};
 const line=(node,depth=0)=>{if(depth>500)throw new Error(t('Cette partie est trop longue pour être exportée depuis cet éditeur. Utilise l’export de la base.'));const children=(node.children||[]).map(p=>map.get(p)).filter(Boolean);if(!children.length)return '';const [main,...alts]=children;return move(main)+(alts.length?' '+alts.map(n=>'('+move(n)+' '+line(n,depth+1)+')').join(' '):'')+' '+line(main,depth+1);};
 const headers={...doc.headers};headers.Result=headers.Result||'*';if(root.fen!==START){headers.SetUp='1';headers.FEN=root.fen;}
 return Object.entries(headers).map(([k,v])=>'['+k+' "'+String(v).replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"]' ).join('\n')+'\n\n'+comment(root).trim()+' '+line(root).trim()+' '+headers.Result+'\n';
}

// Backend-validated snapshots are copied into the selected branch; existing
// annotations and sibling variations retain their paths and contents.
export function appendLine(doc, path, positions, {detached=false}={}) {
 const copy=structuredClone(doc);
 if(detached){delete copy.id;delete copy.base_id;delete copy.created_at;delete copy.updated_at;}
 const nodes=nodeIndex(copy);let parent=nodes.get(path);
 let changed=false;
 if(!parent)throw new Error(t('La position de départ de cette variante est introuvable.'));
 for(const step of positions){
  if(!step.uci||!step.san||!step.fen)throw new Error(t('La variante du moteur est incomplète.'));
  let child=(parent.children||[]).map(p=>nodes.get(p)).find(n=>n?.uci===step.uci);
  if(child&&child.fen!==step.fen)throw new Error(t('Cette variante ne correspond plus à la position.'));
  if(!child){
   changed=true;
   parent.children||=[];let index=parent.children.length;
   let nextPath=parent.path?parent.path+'.'+index:String(index);
   while(nodes.has(nextPath)){index++;nextPath=parent.path?parent.path+'.'+index:String(index);}
   child={path:nextPath,parent:parent.path,fen:step.fen,san:step.san,uci:step.uci,comment:'',starting_comment:'',nags:[],clock:null,elapsed:null,children:[]};
   parent.children.push(nextPath);copy.nodes.push(child);nodes.set(nextPath,child);
  }
  parent=child;
 }
 if(changed)copy.analysis_dirty=true;
 copy.pgn=serialize(copy);
 return {doc:copy,path:parent.path};
}
