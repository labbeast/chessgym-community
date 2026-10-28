import {api,esc} from './api.js';
import {t} from './i18n.js';
import {newId} from './identifiers.js';

export function reviewAllActionsHtml(rows,bases,{supported=true}={}){
 const eligible=new Set(bases.filter(base=>base.settings?.review_enabled&&!base.reference&&!base.reference_status).map(base=>base.id));
 const counts=rows.filter(row=>eligible.has(row.base_id)).reduce((total,row)=>({review:total.review+(row.due||0)+(row.maintenance_due||0),learn:total.learn+(row.unseen||0)}),{review:0,learn:0});
 return '<div class="review-all-actions">'+Object.entries({review:'Tout réviser',learn:'Tout apprendre'}).map(([selection,label])=>'<button type="button" class="'+(selection==='review'?'primary':'quiet')+'" data-review-all="'+selection+'"'+(!supported||!counts[selection]?' disabled':'')+'>'+esc(t(label))+' · '+counts[selection]+'</button>').join('')+'</div>';
}

// Keep the same creation receipt after an uncertain reply, including across reloads.
export async function prepareAllReviews(selection,{request=api,store=null,isCurrent=()=>true}={}){
 if(!['review','learn'].includes(selection))throw Error('Invalid review selection');
 const key='review-all-create',pending=store?.get(key);
 if(pending&&pending.selection!==selection)throw Error(t('Un lancement attend une confirmation. Réessaie le même choix pour retrouver tes cartes.'));
 const payload=pending||{base_ids:null,selection,goal:{minutes:null,cards:null},request_id:newId()};
 store?.set(key,payload);
 try{
  const result=await request('/api/review-sessions/daily',{method:'POST',body:payload});
  if(isCurrent())store?.remove(key);
  return result;
 }catch(error){
  if(isCurrent()&&error.status>=400&&error.status<500)store?.remove(key);
  throw error;
 }
}
