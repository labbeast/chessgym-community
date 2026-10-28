import {t,ui} from './i18n.js';
import {esc,TYPES} from './api.js';
import {progressCounts,reviewProgressHtml,reviewProgressLegend} from './review-progress.js';

function baseDetails(row,base){
 return ui('<small>')+esc(TYPES[row.type]||row.type)+(base?.tags?.length?' · '+esc(base.tags.join(' · ')):'')+ui('</small>')+
  (row.type==='play'?ui('<small>Stockfish · force ')+esc(base?.settings?.skill??10)+ui(' / 20</small>'):'');
}
function masteredDetail(row){
 return (row.mastered||0)>0?ui('<small>dont ')+esc(row.mastered)+t(' maîtrisé')+(row.mastered>1?'s':'')+ui('</small>')+((row.maintenance_due||0)>0?'<small>'+esc(t('{count} rappels d’entretien dus',{count:row.maintenance_due}))+'</small>':''):'';
}
function baseActions(row){
 const reviews=(row.due||0)+(row.maintenance_due||0),learn=row.unseen||0;
 return ui('<button type="button" class="primary" data-review="')+esc(row.base_id)+'"'+(reviews?'':' disabled')+'>'+esc(t('Réviser'))+' · '+reviews+ui('</button>')+
  ui('<button type="button" class="quiet" data-learn="')+esc(row.base_id)+'"'+(learn?'':' disabled')+'>'+esc(t('Apprendre'))+' · '+learn+ui('</button>');
}
function mobileStat(label,value,{detail='',due=false}={}){
 return ui('<div class="review-base-stat')+(due?' review-base-due':'')+ui('"><dt>')+label+ui('</dt><dd>')+esc(value)+detail+ui('</dd></div>');
}

export function reviewBasesTableHtml(rows,bases){
 const byId=new Map(bases.map(base=>[base.id,base]));
 const items=rows.map(row=>({row,details:baseDetails(row,byId.get(row.base_id)),mastered:masteredDetail(row),actions:baseActions(row)}));
 const table=ui('<div class="panel table-scroll review-bases-table"><table class="overview-table"><thead><tr><th>Base / catégorie</th><th>Total</th><th>Nouveaux</th><th>Appris</th><th>À réviser</th><th></th></tr></thead><tbody>')+items.map(({row:r,details,mastered,actions})=>
  ui('<tr><td><button class="text-button" data-base="')+esc(r.base_id)+'">'+esc(r.name)+ui('</button>')+details+reviewProgressHtml(r)+ui('</td><td>')+esc(r.total)+ui('</td><td>')+esc(r.unseen||0)+ui('</td><td>')+esc(r.learned)+mastered+ui('</td><td><strong>')+esc(r.due+(r.maintenance_due||0))+ui('</strong></td><td>')+actions+ui('</td></tr>')
 ).join('')+ui('</tbody></table></div>');
 const cards=ui('<div class="review-bases-list" aria-label="Bases à réviser">')+items.map(({row:r,details,mastered,actions})=>
  ui('<article class="review-base-card"><header><h2><button type="button" class="text-button" data-base="')+esc(r.base_id)+'">'+esc(r.name)+ui('</button></h2>')+details+ui('</header>')+reviewProgressHtml(r)+ui('<dl class="review-base-stats">')+
  mobileStat(t('Total'),r.total)+mobileStat(t('Nouveaux'),r.unseen||0)+mobileStat(t('Appris'),r.learned,{detail:mastered})+mobileStat(t('À réviser'),r.due+(r.maintenance_due||0),{due:true})+
  ui('</dl><div class="review-base-actions">')+actions+ui('</div></article>')
 ).join('')+ui('</div>');
 return (rows.some(row=>progressCounts(row))?reviewProgressLegend():'')+table+cards;
}
