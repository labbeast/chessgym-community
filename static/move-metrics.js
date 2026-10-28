// Pure move metrics: comparisons always use the mover's perspective and a
// matched pair of evaluations. A missing score is never treated as equality.
export const finiteNumber=value=>typeof value==='number'&&Number.isFinite(value);

// Keep an existing score at equal depth; live updates must never downgrade it.
export function preferredEvaluation(current,candidate){
 const valid=value=>!!value&&(Number.isInteger(value.mate)||finiteNumber(value.cp));
 const depth=value=>Number.isSafeInteger(value?.depth)&&value.depth>=0?value.depth:-1;
 if(!valid(current))return valid(candidate)?candidate:null;
 return valid(candidate)&&depth(candidate)>depth(current)?candidate:current;
}

export function importedMoveEvaluation(comment){
 const match=String(comment||'').match(/\[%eval\s+(#[+-]?\d+|[+-]?\d+(?:\.\d{1,2})?)(?:\s*,\s*(\d+))?\s*\]/i);
 if(!match)return null;
 const raw=match[1],isMate=raw.includes('#'),number=Number(raw.replace('#',''));
 if(!Number.isFinite(number)||Math.abs(number)>100000)return null;
 const depth=match[2]===undefined?null:Number(match[2]);
 return {...(isMate?{mate:number}:{cp:Math.round(number*100)}),depth:Number.isSafeInteger(depth)?depth:null,source:'pgn'};
}

function evaluationAt(value,node,source){
 if(!value||(!Number.isInteger(value.mate)&&!finiteNumber(value.cp)))return null;
 const result={...value,source};
 // [%eval #0] belongs to the position after the move: the side to move is mated.
 if(result.mate===0&&!['white','black'].includes(result.winner)){
  const turn=String(node?.fen||'').split(/\s+/)[1];
  if(turn==='w'||turn==='b')result.winner=turn==='w'?'black':'white';
 }
 return result;
}
export function mateSign(value){
 if(!Number.isInteger(value?.mate))return null;
 if(value.winner==='white')return 1;
 if(value.winner==='black')return -1;
 return value.mate===0?null:value.mate>0?1:-1;
}
export function winningChances(value,side){
 const sign=side==='white'?1:-1,mate=mateSign(value);
 if(mate!==null)return mate===sign?100:0;
 if(Number.isInteger(value?.mate)||!finiteNumber(value?.cp))return null;
 return 100/(1+Math.exp(Math.max(-60,Math.min(60,-.00368208*value.cp*sign))));
}
export function evaluationLoss(before,after,side,playedUci){
 if(!before||!after||!['white','black'].includes(side))return null;
 const beforeChance=winningChances(before,side),afterChance=winningChances(after,side);
 if(beforeChance===null||afterChance===null)return null;
 const sign=side==='white'?1:-1,beforeMate=mateSign(before),afterMate=mateSign(after);
 const best=typeof playedUci==='string'&&playedUci.length>0&&before.best_uci===playedUci;
 const result={before,after,best,lossCp:null,lossWinPercent:best?0:Math.max(0,beforeChance-afterChance),judgement:null,mateChange:null};
 if(best){result.lossCp=0;return result;}
 if(beforeMate!==null||afterMate!==null){
  if(beforeMate===sign&&afterMate!==sign){
   result.mateChange='missed';
   const remaining=finiteNumber(after.cp)?after.cp*sign:0;
   if(!best)result.judgement=remaining>999?'inaccuracy':remaining>700?'mistake':'blunder';
  }else if(beforeMate===null&&afterMate===-sign){
   result.mateChange='allowed';
   const previous=before.cp*sign;
   if(!best)result.judgement=previous< -999?'inaccuracy':previous< -700?'mistake':'blunder';
  }else if(afterMate===sign)result.mateChange=beforeMate===sign?'retained':'found';
  else if(beforeMate===-sign)result.mateChange=afterMate===-sign?'forced':'escaped';
  return result;
 }
 result.lossCp=best?0:Math.max(0,(before.cp-after.cp)*sign);
 result.judgement=result.lossWinPercent>=15?'blunder':result.lossWinPercent>=10?'mistake':result.lossWinPercent>=5?'inaccuracy':null;
 return result;
}

function sameStoredSource(before,after){
 const identity=value=>value?.engine_identity??value?.provenance?.engine_identity??null;
 const a=identity(before),b=identity(after);
 // A terminal, rules-based evaluation legitimately follows an engine evaluation.
 if(a!==null&&b!==null&&a!==b)return false;
 const nameA=before?.engine_name,nameB=after?.engine_name;
 return !nameA||!nameB||nameA===nameB;
}
export function moveMetricContext(doc,report,nodes){
 const usable=!report?.stale&&report?.status!=='stale'&&Array.isArray(report?.positions);
 const positions=new Map((usable?report.positions:[]).map(position=>[position.path,position]));
 const stored=node=>{
  const value=positions.get(node?.path);
  return node&&value?.fen===node.fen?evaluationAt(value,node,'stored'):null;
 };
 const imported=node=>node?evaluationAt(importedMoveEvaluation(node.comment),node,'pgn'):null;
 const evaluation=node=>preferredEvaluation(stored(node),imported(node));
 const control=typeof doc?.headers?.TimeControl==='string'?doc.headers.TimeControl.match(/^(\d+)(?:\+\d+)?$/):null;
 const initial=control?Number(control[1]):null;
 const base=finiteNumber(initial)&&initial>0?initial:null;
 const metrics=node=>{
  const parent=nodes.get(node.parent),turn=String(parent?.fen||'').split(/\s+/)[1];
  const side=turn==='w'?'white':turn==='b'?'black':null;
  const selectedBefore=evaluation(parent),selectedAfter=evaluation(node);
  const comparable=(before,after)=>before&&after&&before.source===after.source&&
   (before.source==='pgn'||sameStoredSource(before,after));
  let before=selectedBefore,after=selectedAfter;
  // Live analysis deepens one PGN annotation at a time. Keep a complete
  // comparison from the report (or PGN) until the deeper pair is comparable.
  // The position score still uses the deepest result independently.
  if(!comparable(before,after)){
   before=stored(parent);after=stored(node);
   if(!comparable(before,after)){before=imported(parent);after=imported(node);}
  }
  const elapsed=finiteNumber(node.elapsed)&&node.elapsed>=0?node.elapsed:null;
  const remaining=finiteNumber(node.clock)&&node.clock>=0?node.clock:null;
  const percent=base!==null&&elapsed!==null?elapsed/base*100:null;
  return {evaluation:selectedAfter,loss:comparable(before,after)?evaluationLoss(before,after,side,node.uci):null,side,
   elapsed,remaining,base,percent,timeSeverity:percent>10?'high':percent>5?'moderate':null};
 };
 return {evaluation,metrics,base};
}

// Omitted settings preserve the exercise editor's original, quiet presentation.
export function normalizeMoveDisplay(display={}){
 return {evaluationMode:display?.evaluationMode==='loss'?'loss':'position',
  timeMode:display?.timeMode==='remaining'?'remaining':'elapsed',
  highlightEvaluation:display?.highlightEvaluation===true,highlightTime:display?.highlightTime===true};
}
