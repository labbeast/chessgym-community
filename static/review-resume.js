import {t} from './i18n.js';
import {api} from './api.js';

const copy=value=>structuredClone(value);
export const solutions=card=>(card.solutions?.length?card.solutions:(card.answers||[]).map(answer=>[answer])).map(line=>line.slice());

export function copySession(snapshot){
 return {...snapshot,base:copy(snapshot.base),cards:copy(snapshot.cards),attempt:snapshot.attempt?copy(snapshot.attempt):null};
}
export function attemptMoves(attempt){
 const nodes=new Map((attempt.completion?.doc||attempt.doc).nodes.map(node=>[node.path,node]));
 let node=nodes.get('');const moves=[];
 for(let index=0;index<attempt.ply;index++){
  node=nodes.get(node?.children?.[0]);if(!node?.uci)return null;moves.push(node.uci);
 }
 return moves;
}
function playSettings(settings){
 return JSON.stringify({side:settings.side,goal:settings.goal,skill:Number(settings.skill??10),engine:settings.engine||'stockfish'});
}
export function reviewSnapshotData(snapshot){if(!snapshot)return null;const {onClose,onPause,onToolbarResume,onSettings,onEditEntry,onExploreLine,onStateChange,...data}=snapshot;return copy(data);}
export async function prepareReviewResume(snapshot){
 if(!snapshot)return null;
 const s=copySession(snapshot);
 // An uncertain submission must be retried with its original card and payload,
 // even if the queue no longer contains a card already graded by the server.
 const rejected=!!s.session_id&&s.pendingAction?.rejected;
 if(s.pendingAction&&!rejected)return s;
 let fresh,remaining,currentKept=false,removed=0,alreadyAnswered=0;
 const messages=[];
 if(s.session_id){
  const offset=s.cards[s.index]?.session_index??s.next_offset;
  if(offset==null){s.finishedSession=true;s.cards=[];s.index=0;return s;}
  const response=await api('/api/review-sessions/'+encodeURIComponent(s.session_id)+'?offset='+offset+'&limit=20');
  // A definitive rejection never recorded this attempt. Revalidate the server's
  // remaining membership before clearing it; failed refreshes retain the draft.
  if(rejected){s.pendingAction=null;if(s.attempt)delete s.attempt.requestId;}
  fresh=response.cards||[];remaining=fresh;s.cards=fresh;s.index=0;s.next_offset=response.next_offset;s.total=response.total;
  s.completed=Math.max(s.completed||0,response.completed||0);s.sessionElapsedMs=Math.max(s.sessionElapsedMs||0,response.elapsed_ms||0);
  if(response.selection)s.selection=response.selection;if(response.mode)s.mode=response.mode;if(response.base_ids)s.base_ids=response.base_ids;
  currentKept=!!fresh.length&&fresh[0].id===snapshot.cards[snapshot.index]?.id;removed=(response.skipped_unavailable||response.skipped||[]).length;alreadyAnswered=(response.skipped_completed||[]).length;
 }else{
  const response=await api('/api/bases/'+s.base.id+'/queue?all=true');
  fresh=response.cards||[];const byId=new Map(fresh.map(card=>[card.id,card]));
  const prefix=s.cards.slice(0,s.index),used=new Set(prefix.map(card=>card.id));remaining=[];
  for(let index=s.index;index<s.cards.length;index++){
   const old=s.cards[index];let card=byId.get(old.id);
   if(!card&&old.type!=='moves'&&old.entry_id!=null){const matches=fresh.filter(candidate=>candidate.entry_id===old.entry_id&&candidate.type===old.type&&!used.has(candidate.id));if(matches.length===1)card=matches[0];}
   if(!card||used.has(card.id)){removed++;continue;}used.add(card.id);remaining.push(copy(card));if(index===s.index)currentKept=true;
  }
  s.cards=[...prefix,...remaining];
 }
 s.skipped=(s.skipped||0)+removed+alreadyAnswered;
 if(alreadyAnswered)messages.push(t('{count} exercices déjà traités ont été ignorés. Aucune réponse n’a été enregistrée deux fois.',{count:alreadyAnswered}));
 if(s.mode!=='daily'&&fresh[0]?.settings)s.base.settings=copy(fresh[0].settings);
 if(removed)messages.push(removed+t(' exercice')+(removed>1?t('s retirés'):t(' retiré'))+t(' de la séance car ')+(removed>1?t('ils ne sont'):t('il n’est'))+t(' plus disponible')+(removed>1?'s':'')+'. Aucune note enregistrée pour '+(removed>1?t('ces exercices.'):t('cet exercice.')));
 if(!currentKept)s.attempt=null;
 if(s.attempt&&remaining.length){
  const card=remaining[0],attempt=s.attempt,settings={...s.base.settings,...card.settings};
  const old=snapshot.cards[snapshot.index],prefix=attemptMoves(attempt);
  const candidates=prefix&&solutions(card).filter(line=>prefix.every((uci,index)=>line[index]===uci));
  const compatible=old.type===card.type&&old.fen===card.fen&&
   (card.type==='play'?playSettings(attempt.settings)===playSettings(settings):candidates?.length>0);
  if(!compatible){
   // Keep the evidence and elapsed review time; only the invalid board is reset.
   s.attempt={errors:attempt.errors,hints:Math.max(1,attempt.hints),assisted:true,elapsedMs:attempt.elapsedMs};
   messages.push(t('L’exercice a changé : la tentative actuelle reprend à sa position de départ. Ta progression dans la séance est conservée.'));
  }else if(card.type!=='play'){
   const ended=candidates.some(line=>line.length===attempt.ply);
   if(attempt.finished&&!ended){
    // Exploratory branches are not accepted answers to the extended solution.
    attempt.doc=copy(attempt.completion?.doc||attempt.doc);
    attempt.path=attempt.completion?.path??attempt.doc.nodes.find(node=>node.children.length===0)?.path??'';
    attempt.finished=false;attempt.completion=null;
    attempt.assisted=true;attempt.hints=Math.max(1,attempt.hints);
    messages.push(t('La solution a été prolongée : continue depuis les coups déjà joués.'));
   }else if(!attempt.finished&&ended)attempt.finished=true;
  }
 }
 s.resumeMessage=messages.join(' ');
 return s;
}
