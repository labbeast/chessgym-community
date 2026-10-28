import {api} from './api.js';
import {t} from './i18n.js';
import {newId as receipt} from './identifiers.js';

export function conflictingReview(snapshot,runId){
 return !!(snapshot?.session_id&&snapshot.training_run_id!==runId&&!snapshot.finishedSession);
}

export function scopedReviewSnapshot(snapshot,run){
 const goal=run?.launch?.review_goal;
 if(!(run?.launch?.goal||run?.launch?.free)||!goal)return snapshot;
 return {...snapshot,goal:{...goal},toolbarTargetMs:Number(goal.minutes)>0?Number(goal.minutes)*60000:null,goalReached:false};
}

// Keep the exact request until its outcome is known, including its CAS revision.
// Reading it back first would break retry after a successful but lost response.
export async function mutateTrainingRun(runId,action,{request=api,store,entryId=null,recoverPending=true}={}){
 // An uncertain pause must be acknowledged before a resume (and vice versa).
 // Otherwise its saved receipt could be replayed on the next pause and return
 // an obsolete state without applying the user's new action.
 if(recoverPending)for(const pending of ['pause','resume']){
  if(pending!==action&&store?.get('training-run-write:'+runId+':'+pending))
   await mutateTrainingRun(runId,pending,{request,store,recoverPending:false});
 }
 const key='training-run-write:'+runId+':'+action+(entryId?':'+entryId:'');
 let payload=store?.get(key);
 if(!payload){
  const run=await request('/api/training/runs/'+encodeURIComponent(runId));
  payload={action,expected_revision:run.revision,mutation_id:receipt(),...(entryId?{entry_id:entryId}:{})};
  store?.set(key,payload);
 }
 try{
  const result=await request('/api/training/runs/'+encodeURIComponent(runId),{method:'PATCH',body:payload});
  store?.remove(key);return result;
 }catch(error){
  if(error.status>=400&&error.status<500)store?.remove(key);
  throw error;
 }
}

export async function prepareTrainingReview(run,{request=api}={}){
 if(run.native_ref?.id){
  return request('/api/review-sessions/'+encodeURIComponent(run.native_ref.id)+'?offset=0&limit=100');
 }
 // A scoped run applies its exact stop threshold on the server after binding.
 // Keep the queue open so changing day/week never truncates future exercises.
 const goal=run.launch.goal||run.launch.free?{minutes:null,cards:null}:{minutes:Math.max(1,Math.min(480,Math.round(run.launch.minutes||run.block.session_minutes||20))),
  cards:run.block.metric==='quantity'&&run.block.unit==='cards'?Math.max(1,Math.min(10000,Math.round(run.block.target))):null};
 const options={base_ids:[Number(run.launch.base_id)],goal,selection:run.launch.options?.selection||run.block.options?.selection||'both'};
 const preview=await request('/api/review-sessions/daily-preview',{method:'POST',body:options});
 if(!preview.total)throw new Error(t('Aucune carte disponible pour ce bloc. Ajuste les révisions de la base ou choisis une autre activité.'));
 return request('/api/review-sessions/daily',{method:'POST',body:{...options,request_id:run.id,training_run_id:run.id}});
}

export function readingLaunchTarget(data,baseId){
 const base=(data.bases||[]).find(item=>Number(item.base_id)===Number(baseId));
 if(!base)throw new Error(t('Cette ressource de lecture est indisponible. Vérifie les réglages de la base.'));
 const entry=base.continue_entry_id||base.last_entry_id,path=base.continue_entry_id?base.continue_path:base.last_path;
 if(!entry)throw new Error(t('Cette base ne contient aucune partie à lire.'));
 return {entryId:entry,path:path??''};
}
