import {t} from './i18n.js';
import {esc} from './api.js';

// A finished puzzle remains a practice result after any mistake or hint.
// An expired Storm attempt must never be presented as a successful solve.
export function puzzleResultState(attempt={}){
 if(attempt.status==='revealed'){
  // The server also uses this terminal status for Storm mistakes and abandons.
  const helped=Number(attempt.hints)>0||attempt.events?.some(event=>Number(event.hint)>0);
  if(attempt.mode==='storm'||(Number(attempt.failed)>0&&!helped))return 'errors';
  return 'revealed';
 }
 if(attempt.status==='expired')return 'expired';
 if(attempt.status!=='completed')return 'active';
 if(Number(attempt.hints)>0)return 'assisted';
 return Number(attempt.failed)>0?'errors':'success';
}

export function puzzleResultLabel(attempt={}){
 // A revealed status alone cannot prove that the user requested the solution.
 return t({success:'Réussi !',errors:'À retravailler',assisted:'À retravailler',revealed:'À retravailler',expired:'Temps écoulé',active:'En cours'}[puzzleResultState(attempt)]);
}

export function puzzleFeedbackHtml(attempt={},feedback=''){
 const state=puzzleResultState(attempt);
 const lastEvent=attempt.events?.at(-1);
 const errorMessage=t('Ce n’est pas la solution. Réessaie.');
 const activeError=state==='active'&&(feedback===errorMessage||(!feedback&&lastEvent?.correct===0));
 let label=puzzleResultLabel(attempt),detail='',icon='';
 if(state==='success')icon='✓';
 else if(state==='errors'||state==='assisted'){
  icon='●';
  detail=t(state==='assisted'?'Terminé avec aide':'Terminé avec erreurs');
 }else if(state==='revealed')icon='↺';
 else if(state==='expired')icon='—';
 else {
  label=feedback||(activeError?errorMessage:t('Trouve la suite gagnante.'));
  if(activeError)icon='×';
 }
 return `<div class="puzzle-feedback training-result" data-state="${state}"${activeError?' data-feedback="error"':''} role="status" aria-live="polite" aria-atomic="true">${icon?`<span class="training-result-icon" aria-hidden="true">${icon}</span>`:''}<span class="training-result-text"><strong>${esc(label)}</strong>${detail?`<span class="training-result-detail">${esc(detail)}</span>`:''}</span></div>`;
}
