import {START} from './api.js';
import {nodeIndex} from './chess-document.js';

export function clockSeconds(value){
 return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
}

export function formatClock(value){
 const seconds=clockSeconds(value);if(seconds===null)return '—';
 // Historical snapshots round to tenths below a minute, whole seconds above.
 // Keep the fractional digit when present; normalize a rounded minute boundary.
 const rounded=seconds<60?Math.round(seconds*10)/10:Math.round(seconds),whole=Math.floor(rounded);
 const hours=Math.floor(whole/3600),minutes=Math.floor(whole/60)%60,rest=whole%60;
 const fraction=seconds<60&&!Number.isInteger(seconds)&&rounded<60?'.'+Math.round((rounded-whole)*10):'';
 return (hours?hours+':'+String(minutes).padStart(2,'0'):String(minutes))+':'+String(rest).padStart(2,'0')+fraction;
}

export function positionClocks(doc,path=''){
 const nodes=Array.isArray(doc?.nodes)?doc.nodes:[];
 const available=nodes.some(node=>node?.path!==''&&node?.uci&&clockSeconds(node.clock)!==null);
 const unknown=()=>({white:null,black:null,available});
 if(!available)return unknown();
 const index=nodeIndex(doc),root=index.get(''),chain=[],seen=new Set();let node=index.get(path);
 if(!root||!node)return unknown();
 while(node.path!==''){
  if(seen.has(node.path))return unknown();seen.add(node.path);
  const parent=index.get(node.parent);if(!parent)return unknown();
  chain.push({node,parent});node=parent;
 }
 const control=typeof doc.headers?.TimeControl==='string'?doc.headers.TimeControl.match(/^(\d+)(?:\+\d+)?$/):null;
 const initial=root.fen===START&&control?clockSeconds(Number(control[1])):null;
 const result={white:initial,black:initial,available};
 for(let i=chain.length-1;i>=0;i--){
  const {node:move,parent}=chain[i];if(!move.uci)continue;
  const turn=String(parent.fen||'').split(' ')[1];
  if(turn!=='w'&&turn!=='b'){result.white=result.black=null;continue;}
  // The annotation belongs to the player who just moved. A missing annotation
  // ends knowledge of that player's clock; never borrow a value across the gap.
  result[turn==='w'?'white':'black']=clockSeconds(move.clock);
 }
 return result;
}
