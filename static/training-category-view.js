import {esc,option} from './api.js';
import {t,locale} from './i18n.js';
import {activityLabel,planTime} from './training-program.js';
import {EXERCISES} from './exercise-catalog.js';
import {uiIcon} from './ui-icons.js';

export const CATEGORY_IDS=['review',...EXERCISES.map(item=>item.page),'games','reading','analysis','external'];
export const orderedCategories=categories=>[...categories].sort((a,b)=>CATEGORY_IDS.indexOf(a.activity)-CATEGORY_IDS.indexOf(b.activity));
export const categoryLabel=activity=>t(({review:'Révisions',reading:'Lecture',analysis:'Analyse'})[activity]||EXERCISES.find(item=>item.page===activity)?.title||activityLabel(activity));
export const categoryIcon=activity=>uiIcon(({review:'reviews',games:'played',external:'drafts'})[activity]||activity);
const number=value=>Number(value||0).toLocaleString(locale(),{maximumFractionDigits:1});
export const categoryTarget=(category,scope)=>Number(scope==='today'?category.daily_target_minutes:category.target_minutes)||0;
export const categoryRemaining=(category,scope)=>Math.max(0,categoryTarget(category,scope)-Number((scope==='today'?category.today:category.progress)?.duration_ms||0)/60000);

export function categoryPeriodHtml(category,scope,{effortHtml,workCounts}){
 const values=(scope==='today'?category.today:category.progress)||{},target=categoryTarget(category,scope),realized=Number(values.duration_ms||0)/60000;
 const title=t(scope==='today'?'Objectif du jour':'Objectif de la semaine'),estimated=Number(values.duration_by_kind?.estimated)||0;
 const estimate=estimated>0?'<small class="tp-estimated-time">'+esc(t('Dont {time} estimées d’après la cadence',{time:planTime(estimated/60000)}))+'</small>':'';
 return '<span class="tp-period-label">'+esc(t(scope==='today'?'Aujourd’hui':'Cette semaine'))+'</span>'+(target>0?
  '<strong title="'+esc(title)+'">'+(values.duration_ms==null?'—':number(realized))+' / '+number(target)+' '+esc(t('min'))+'</strong><progress value="'+Math.min(target,realized)+'" max="'+target+'" aria-label="'+esc(title+' · '+categoryLabel(category.activity))+'"></progress>'+(workCounts(values)?'<small>'+workCounts(values)+'</small>':''):
  '<strong>'+planTime(values.duration_ms==null?null:values.duration_ms/60000)+'</strong><small class="tp-no-goal">'+esc(t('Sans objectif'))+(workCounts(values)?' · '+workCounts(values):'')+'</small>')+estimate;
}

export function categorySourceHtml(category,{resources=[],baseId=''}={}){
 const activity=category.activity,choices=resources.filter(resource=>resource.type==='base'&&resource.activities?.includes(activity));
 return ['review','reading','guess'].includes(activity)&&choices.length?'<select class="tp-category-source" aria-label="'+esc(t('Base de données')+' · '+categoryLabel(activity))+'" data-category-source="'+esc(activity)+'">'+(!['review','reading'].includes(activity)?option('',t('Toutes les ressources'),baseId):'')+choices.map(resource=>option(String(resource.id),resource.name,baseId)).join('')+'</select>':'';
}

export function categoryLaunchHtml(category,{resources=[],baseId='',run=null}={}){
 const activity=category.activity,choices=resources.filter(resource=>resource.type==='base'&&resource.activities?.includes(activity));
 if(activity==='external')return '<button type="button" data-plan-action="manual-category" data-category="external">'+esc(t('Déclarer un travail'))+'</button>';
 if(activity==='games')return '<button type="button" data-plan-action="launch-category" data-category="games" data-scope="free">'+esc(t('Ouvrir mes parties'))+'</button>';
 if(activity==='analysis')return '<button type="button" data-plan-action="launch-category" data-category="analysis" data-scope="free">'+esc(t('Ouvrir l’analyse'))+'</button>';
 if(['review','reading'].includes(activity)&&!choices.length)return '<small>'+esc(t('Ajoute une base compatible pour commencer.'))+'</small>';
 const button=scope=>{
  const target=categoryTarget(category,scope),remaining=categoryRemaining(category,scope),free=scope==='free'||target<=0;
  const label=scope==='free'?(run?t('Reprendre librement'):t('Commencer librement')):scope==='today'?(run?t('Reprendre aujourd’hui'):t('Commencer aujourd’hui')):(run?t('Reprendre la semaine'):t('Commencer la semaine'));
  const amount=remaining>0&&remaining<1?t('{count} s',{count:Math.ceil(remaining*60)}):number(remaining)+' '+t('min');
  return '<button type="button" class="tp-period-launch'+(scope==='today'&&!free&&remaining>0?' primary':'')+'" data-plan-action="launch-category" data-category="'+esc(activity)+'" data-scope="'+(free?'free':scope)+'"'+(run?' data-run="'+esc(run.id)+'"':'')+(free||remaining>0?'':' disabled')+'><span>'+esc(label)+'</span>'+(scope==='free'?'':'<small>'+esc(free?t('Sans objectif'):remaining>0?t('{amount} restants',{amount}):t('Objectif atteint'))+'</small>')+'</button>';
 };
 if(categoryTarget(category,'today')>0&&categoryTarget(category,'week')>0&&categoryRemaining(category,'today')<=0&&categoryRemaining(category,'week')<=0)return '<div class="tp-period-actions">'+button('free')+'</div>';
 return '<div class="tp-period-actions">'+(categoryTarget(category,'today')<=0&&categoryTarget(category,'week')<=0?button('free'):button('today')+button('week'))+'</div>';
}

export function categoryRowHtml(category,{resources,baseId,run,effortHtml,workCounts}={}){
 const activity=category.activity;
 return '<article class="tp-overview-row tp-category-row" data-category-row="'+esc(activity)+'"><div class="tp-overview-main"><div class="tp-block-identity"><span class="tp-category-icon" aria-hidden="true">'+categoryIcon(activity)+'</span><div class="tp-category-name"><h3>'+esc(categoryLabel(activity))+'</h3>'+categorySourceHtml(category,{resources,baseId})+((category.active_runs||[]).length?'<small class="tp-run-state">'+esc(t('Séance en cours'))+'</small>':'')+'</div></div><div class="tp-block-today">'+categoryPeriodHtml(category,'today',{effortHtml,workCounts})+'</div><div class="tp-block-week">'+categoryPeriodHtml(category,'week',{effortHtml,workCounts})+'</div><div class="tp-block-launch">'+categoryLaunchHtml(category,{resources,baseId,run})+'</div></div></article>';
}

export function categoryManagementHtml(category,{blockHtml,manualHtml,effortHtml}={}){
 const activity=category.activity,blocks=category.blocks||[],sources=category.resources||[],manual=category.manual_activities||[];
 return '<div class="tp-category-settings"><form data-category-goal-form="'+esc(activity)+'" class="tp-category-goal-form"><label>'+esc(t('Objectif du jour · minutes'))+'<input name="daily_target_minutes" type="number" min="0" max="1440" step="0.25" required value="'+esc(category.daily_target_minutes||0)+'"></label><label>'+esc(t('Objectif de la semaine · minutes'))+'<input name="target_minutes" type="number" min="0" max="10080" step="0.25" required value="'+esc(category.target_minutes||0)+'"></label><button type="submit">'+esc(t('Enregistrer les objectifs'))+'</button></form><p class="hint">'+esc(t('Zéro signifie sans objectif. Tout le temps travaillé reste comptabilisé.'))+'</p>'+
  '<div class="actions">'+(activity==='games'?categoryLaunchHtml(category):'<button type="button" data-plan-action="manual-category" data-category="'+esc(activity)+'">'+esc(t('Déclarer un travail'))+'</button>'+(activity!=='external'&&activity!=='analysis'?'<button type="button" data-plan-action="launch-category" data-category="'+esc(activity)+'" data-scope="free">'+esc(t('Continuer librement'))+'</button>':''))+'</div>'+
  (sources.length?'<div class="tp-category-sources"><table><caption>'+esc(t('Temps par ressource'))+'</caption><thead><tr><th scope="col">'+esc(t('Ressource'))+'</th><th scope="col">'+esc(t('Aujourd’hui'))+'</th><th scope="col">'+esc(t('Cette semaine'))+'</th></tr></thead><tbody>'+sources.map(source=>'<tr><th scope="row">'+esc(source.resource?.name||source.name||t('Sans base de données'))+'</th><td>'+effortHtml(source.today||{})+'</td><td>'+effortHtml(source.progress||source)+'</td></tr>').join('')+'</tbody></table></div>':'')+
  (blocks.length?'<details class="tp-category-blocks"><summary>'+esc(t('Blocs du programme'))+' ('+blocks.length+')</summary>'+blocks.map(blockHtml).join('')+'</details>':'')+
  (manual.length?'<details class="tp-recorded-work"><summary>'+esc(t('Travail déclaré'))+'</summary>'+manual.map(item=>manualHtml(item)).join('')+'</details>':'')+'</div>';
}
