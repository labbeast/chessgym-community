import {pieces} from './chess-document.js';

// Keep an accepted drop on its destination while the server validates it.
// This is display-only; the PGN and legal position still come from the server.
export function pendingPieces(fen,uci){
 const map=pieces(fen),from=uci.slice(0,2),to=uci.slice(2,4),piece=map[from];if(!piece)return map;
 const pawn=piece.toLowerCase()==='p';
 if(pawn&&from[0]!==to[0]&&!map[to]&&to===fen.split(' ')[3])delete map[to[0]+from[1]];
 delete map[from];map[to]=uci[4]?(piece===piece.toUpperCase()?uci[4].toUpperCase():uci[4]):piece;
 if(piece.toLowerCase()==='k'&&Math.abs(from.charCodeAt(0)-to.charCodeAt(0))===2){
  const rookFrom=(to[0]>from[0]?'h':'a')+from[1],rookTo=(to[0]>from[0]?'f':'d')+from[1];
  if(map[rookFrom]){map[rookTo]=map[rookFrom];delete map[rookFrom];}
 }
 return map;
}
export function squareAtPoint(rect,x,y,flipped=false){
 if(!rect||rect.width<=0||rect.height<=0||x<rect.left||y<rect.top||x>=rect.left+rect.width||y>=rect.top+rect.height)return null;
 let file=Math.floor((x-rect.left)/rect.width*8),rank=Math.floor((y-rect.top)/rect.height*8);
 if(flipped){file=7-file;rank=7-rank;}
 return 'abcdefgh'[file]+(8-rank);
}
export function squareCenter(square,flipped=false){
 let x='abcdefgh'.indexOf(square[0]),y=8-Number(square[1]);
 if(flipped){x=7-x;y=7-y;}
 return [(x+.5)*100,(y+.5)*100];
}

export function engineArrowsSvg({engineOn,lines,arrows,id,flipped}){if(!engineOn||!lines.length||!arrows)return '';const point=s=>squareCenter(s,flipped);return '<svg class="board-arrows" viewBox="0 0 800 800" aria-hidden="true"><defs>'+lines.slice(0,arrows).map((_,i)=>'<marker id="arrow-'+id+'-'+i+'" markerWidth="3" markerHeight="3" refX="2.3" refY="1.5" orient="auto"><path d="M0,0 L3,1.5 L0,3Z" fill="#484a4d"/></marker>').join('')+'</defs>'+lines.slice(0,arrows).map((line,i)=>{const m=line.uci||line.pv?.[0];if(!m)return '';const a=point(m.slice(0,2)),b=point(m.slice(2,4));return '<line x1="'+a[0]+'" y1="'+a[1]+'" x2="'+b[0]+'" y2="'+b[1]+'" stroke="#484a4d" stroke-width="12" stroke-linecap="round" opacity="'+[.82,.55,.32][i]+'" marker-end="url(#arrow-'+id+'-'+i+')"/>';}).join('')+'</svg>';}
export function drawingsSvg({draw,drawings,preview,pendingMove,id,flipped}){
  const draft=draw?.to?draw:null,shapes=drawings.filter(shape=>!draft||shape.from!==draft.from||shape.to!==draft.to);
  if(draft)shapes.push(draft);if(!shapes.length||preview||pendingMove)return '';
  const point=s=>squareCenter(s,flipped);
  return '<svg class="board-drawings" viewBox="0 0 800 800" aria-hidden="true"><defs><marker id="drawing-arrow-'+id+'" markerWidth="4" markerHeight="4" refX="3.1" refY="2" orient="auto"><path d="M0,0 L4,2 L0,4 Z" fill="#15781b"/></marker></defs>'+shapes.map(shape=>{
   const a=point(shape.from),b=point(shape.to),opacity=shape===draft?'.5':'.72';
   return shape.from===shape.to?'<circle cx="'+a[0]+'" cy="'+a[1]+'" r="43" fill="none" stroke="#15781b" stroke-width="10" opacity="'+opacity+'"/>':'<g opacity="'+opacity+'"><line x1="'+a[0]+'" y1="'+a[1]+'" x2="'+b[0]+'" y2="'+b[1]+'" stroke="#15781b" stroke-width="11" stroke-linecap="round" marker-end="url(#drawing-arrow-'+id+')"/></g>';
  }).join('')+'</svg>';
 }
