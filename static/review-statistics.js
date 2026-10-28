import {t,ui,locale} from './i18n.js';
import {api,esc,option,TYPES} from './api.js';
import {reviewProgressHtml} from './review-progress.js';

const PERIODS=[[7,'7 jours'],[30,'30 jours'],[90,'90 jours'],[365,'12 mois']];
const GRADES=['Manqué','Difficile','Bien','Facile'];
const PLANNER={now:'Maintenant','1h':'Dans 1 heure','4h':'Dans 4 heures','1d':'Dans 1 jour','3d':'Dans 3 jours','7d':'Dans 7 jours'};
const INTERVALS={lt1:'Moins d’un jour','1to7':'1 à moins de 7 jours','7to30':'7 à moins de 30 jours','30to90':'30 à moins de 90 jours','90plus':'90 jours et plus'};
const count=value=>Math.max(0,Number(value)||0);
const number=value=>new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(count(value));
const percent=(part,total)=>total?number(100*count(part)/count(total))+' %':'—';
const canReview=base=>base.review_enabled&&(count(base.current.maintenance_due)>0||count(base.current.total)>count(base.current.mastered)&&count(base.current.due_now)>0);
const masteredDetail=current=>t('dont ')+number(current.mastered)+t(' maîtrisées');
export function formatDuration(milliseconds){
 const seconds=Math.max(0,Math.round(count(milliseconds)/1000));
 if(seconds<60)return seconds+' s';
 const minutes=Math.floor(seconds/60);
 return minutes<60?minutes+' min'+(seconds%60?' '+seconds%60+' s':''):Math.floor(minutes/60)+' h'+(minutes%60?' '+minutes%60+' min':'');
}
function estimatedTime(minutes){return count(minutes)<1?(count(minutes)?'< 1 min':'0 min'):'≈ '+number(Math.ceil(minutes))+' min';}
function dateLabel(date,{short=false}={}){
 const value=new Date(String(date)+'T12:00:00Z');
 return Number.isNaN(value.getTime())?String(date):new Intl.DateTimeFormat(locale(),{day:'numeric',month:short?'short':'long',...(short?{}:{year:'numeric'}),timeZone:'UTC'}).format(value);
}
function empty(message){return ui('<p class="rs-empty">')+esc(message)+ui('</p>');}
function card(title,content,classes=''){return ui('<section class="rs-card ')+classes+ui('"><h2>')+esc(title)+ui('</h2>')+content+ui('</section>');}
function stat(value,label,detail=''){return ui('<div class="rs-stat"><strong>')+esc(value)+ui('</strong><span>')+esc(label)+ui('</span>')+(detail?ui('<small>')+esc(detail)+ui('</small>'):'')+ui('</div>');}
function distribution(rows,{total=rows.reduce((s,r)=>s+count(r.count),0),emptyMessage=t('Aucune donnée pour le moment.')}={}){
 if(!total)return empty(emptyMessage);
 return ui('<ul class="rs-distribution">')+rows.map((r,index)=>ui('<li><div><span><i class="rs-swatch rs-tone-')+index+ui('" aria-hidden="true"></i>')+esc(r.label)+ui('</span><strong>')+number(r.count)+ui(' <small>')+percent(r.count,total)+ui('</small></strong></div><div class="rs-meter" aria-hidden="true"><span class="rs-tone-')+index+'" style="width:'+Math.min(100,100*count(r.count)/total)+ui('%"></span></div></li>')).join('')+ui('</ul>');
}
export function barChart(items,{metric='count',label=t('Révisions'),time=false}={}){
 if(!items.length)return empty(t('Aucune donnée pour cette période.'));
 const values=items.map(item=>count(item[metric])),max=Math.max(1,...values),width=660,height=155,left=38,top=12,bottom=28,plotWidth=width-left-8,plotHeight=height-top-bottom,step=plotWidth/items.length;
 const valueLabel=value=>time?formatDuration(value):number(value);
 const y=value=>top+plotHeight*(1-value/max);
 const ticks=[0,max/2,max];
 const axes=ticks.map(value=>ui('<line x1="')+left+'" y1="'+y(value)+'" x2="'+(width-8)+'" y2="'+y(value)+ui('" class="rs-gridline"/><text x="')+(left-6)+'" y="'+(y(value)+3)+'" text-anchor="end" class="rs-axis">'+esc(time?number(value/60000):number(value))+ui('</text>')).join('');
 const bars=items.map((item,index)=>ui('<rect x="')+(left+index*step+step*.14)+'" y="'+y(values[index])+'" width="'+Math.max(.6,step*.72)+'" height="'+(plotHeight*values[index]/max)+ui('" class="rs-bar"><title>')+esc(dateLabel(item.date)+' : '+valueLabel(values[index]))+ui('</title></rect>')).join('');
 const labels=[...new Set([0,Math.floor((items.length-1)/2),items.length-1])].map(index=>ui('<text x="')+(left+(index+.5)*step)+'" y="'+(height-6)+'" text-anchor="'+(index===0?'start':index===items.length-1?'end':'middle')+'" class="rs-axis">'+esc(dateLabel(items[index].date,{short:true}))+ui('</text>')).join('');
 const details=ui('<details class="rs-chart-values"><summary>Voir les valeurs</summary><div class="rs-values-scroll"><table><thead><tr><th scope="col">Jour</th><th scope="col">')+esc(time?t('Temps'):label)+ui('</th></tr></thead><tbody>')+items.map((item,i)=>ui('<tr><th scope="row">')+esc(dateLabel(item.date))+ui('</th><td>')+esc(valueLabel(values[i]))+ui('</td></tr>')).join('')+ui('</tbody></table></div></details>');
 return ui('<figure class="rs-chart"><svg viewBox="0 0 ')+width+' '+height+ui('" role="img" aria-label="')+esc(label+(time?t(' en minutes'):'')+' : '+valueLabel(values.reduce((a,b)=>a+b,0))+' sur '+items.length+t(' jours'))+'">'+axes+bars+labels+ui('</svg><figcaption>')+esc(time?t('Axe vertical : minutes.'):t('Axe vertical : nombre de révisions.'))+ui('</figcaption></figure>')+details;
}
export function activityHeatmap(items){
 if(!items.length)return empty(t('Aucune activité pour cette période.'));
 const date=new Date(items[0].date+'T12:00:00Z'),offset=(date.getUTCDay()+6)%7,max=Math.max(1,...items.map(i=>count(i.count)));
 const cells=items.map(item=>{
  const value=count(item.count),level=value?Math.max(1,Math.ceil(value/max*4)):0,label=dateLabel(item.date)+' · '+number(value)+t(' révision')+(value>1?'s':'')+' · '+formatDuration(item.elapsed_ms);
  return ui('<button type="button" class="rs-day rs-level-')+level+'" data-rs-day="'+esc(item.date)+'" tabindex="'+(item===items.at(-1)?'0':'-1')+ui('" aria-pressed="false" title="')+esc(label)+ui('" aria-label="')+esc(label)+ui('"></button>');
 }).join('');
 return ui('<div class="rs-calendar-scroll"><div class="rs-calendar"><div class="rs-weekdays" aria-hidden="true">')+Array.from({length:7},(_,day)=>new Intl.DateTimeFormat(locale(),{weekday:'narrow',timeZone:'UTC'}).format(new Date(Date.UTC(2024,0,1+day)))).map(day=>'<span>'+esc(day)+'</span>').join('')+ui('</div><div class="rs-calendar-grid" aria-label="Calendrier des révisions">')+Array.from({length:offset},()=>ui('<span aria-hidden="true"></span>')).join('')+cells+ui('</div></div></div><div class="rs-calendar-range"><span>')+esc(dateLabel(items[0].date,{short:true}))+' — '+esc(dateLabel(items.at(-1).date,{short:true}))+ui('</span><span class="rs-calendar-legend">Moins ')+[0,1,2,3,4].map(i=>ui('<i class="rs-level-')+i+ui('" aria-hidden="true"></i>')).join('')+ui(' Plus</span></div><p class="rs-day-detail" data-rs-day-detail aria-live="polite">Sélectionne un jour pour voir son activité.</p>');
}

export class ReviewStatistics{
 constructor(host,{options={},onOptionsChange,onOpenBase,onReviewBase,request=api}={}){
  Object.assign(this,{host,onOptionsChange,onOpenBase,onReviewBase,request});
  this.options={baseId:Number.isSafeInteger(Number(options.baseId))&&Number(options.baseId)>0?Number(options.baseId):null,days:PERIODS.some(([days])=>days===Number(options.days))?Number(options.days):90,historyMetric:options.historyMetric==='time'?'time':'count'};
  this.disposed=false;this.generation=0;this.data=null;this.baseSignature=null;
  try{this.timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{this.timeZone='UTC';}
  this.click=event=>this.handleClick(event);this.change=event=>this.handleChange(event);this.keydown=event=>this.handleKey(event);
  host.addEventListener('click',this.click);host.addEventListener('change',this.change);host.addEventListener('keydown',this.keydown);
  host.innerHTML=ui('<div class="review-statistics"><div class="rs-controls"><label>Base<select data-rs-control="base" aria-label="Base des statistiques">')+option('',t('Toutes les bases'),this.options.baseId??'')+(this.options.baseId?option(this.options.baseId,t('Base sélectionnée'),this.options.baseId):'')+ui('</select></label><label>Période de l’historique<select data-rs-control="days">')+PERIODS.map(([days,label])=>option(days,t(label),this.options.days)).join('')+ui('</select></label><button type="button" data-rs-action="refresh">Actualiser</button></div><p class="rs-status" data-rs-status role="status" aria-live="polite"></p><div data-rs-content aria-busy="true"></div></div>');
  this.load();
 }
 dispose(){this.disposed=true;this.generation++;this.host.removeEventListener('click',this.click);this.host.removeEventListener('change',this.change);this.host.removeEventListener('keydown',this.keydown);}
 async load(){
  if(this.disposed)return;
  const generation=++this.generation,params=new URLSearchParams({days:String(this.options.days)});
  if(this.options.baseId)params.set('base_id',String(this.options.baseId));
  const status=this.host.querySelector('[data-rs-status]'),content=this.host.querySelector('[data-rs-content]');
  status.textContent=t('Chargement des statistiques…');content.setAttribute('aria-busy','true');
  content.innerHTML=ui('<div class="rs-loading">Calcul des échéances et de l’activité…</div>');
  try{
   const data=await this.request('/api/reviews/statistics?'+params.toString());
   if(this.disposed||generation!==this.generation)return;
   this.data=data;this.updateBases(data.filters?.bases||[]);this.renderData();content.setAttribute('aria-busy','false');
   status.textContent=t('Du ')+dateLabel(data.period.start)+t(' au ')+dateLabel(data.period.end)+' · '+(data.time_zone||this.timeZone);
  }catch(error){
   if(this.disposed||generation!==this.generation)return;
   this.data=null;content.setAttribute('aria-busy','false');status.textContent=t('Les statistiques n’ont pas pu être chargées.');
   content.innerHTML=ui('<div class="rs-error" role="alert"><p>')+esc(error.message||t('Le serveur ne répond pas.'))+ui('</p><div class="rs-error-actions"><button type="button" data-rs-action="refresh">Réessayer</button>')+(this.options.baseId?ui('<button type="button" data-rs-action="all-bases">Toutes les bases</button>'):'')+ui('</div></div>');
  }
 }
 updateBases(bases){
  const signature=JSON.stringify(bases.map(base=>[base.id,base.name,base.review_enabled]));
  if(signature!==this.baseSignature){
   const control=this.host.querySelector('[data-rs-control="base"]');
   control.innerHTML=option('',t('Toutes les bases'),this.options.baseId??'')+bases.map(base=>option(base.id,base.name+(base.review_enabled?'':' · historique'),this.options.baseId)).join('');
   control.value=this.options.baseId==null?'':String(this.options.baseId);this.baseSignature=signature;
  }
 }
 notifyOptions(){this.onOptionsChange?.({...this.options});}
 handleChange(event){
  if(this.disposed)return;
  const control=event.target?.dataset?.rsControl;
  if(control==='base'){const id=Number(event.target.value);this.options.baseId=Number.isSafeInteger(id)&&id>0?id:null;}
  else if(control==='days'){const days=Number(event.target.value);if(!PERIODS.some(([d])=>d===days))return;this.options.days=days;}
  else return;
  this.notifyOptions();this.load();
 }
 handleClick(event){
  if(this.disposed)return;
  const button=event.target.closest?.('[data-rs-action],[data-rs-day]');
  if(!button||!this.host.contains(button))return;
  const action=button.dataset.rsAction;
  if(action==='refresh'){this.load();return;}
  if(action==='all-bases'){this.options.baseId=null;this.host.querySelector('[data-rs-control="base"]').value='';this.notifyOptions();this.load();return;}
  if(action==='metric'){
   this.options.historyMetric=button.dataset.rsMetric==='time'?'time':'count';this.notifyOptions();this.renderHistory();return;
  }
  if(action==='open-base'||action==='review-base'){
   const id=Number(button.dataset.rsBase),base=this.data?.by_base.find(base=>base.base_id===id);
   if(!base)return;
   if(action==='open-base')this.onOpenBase?.(id);else if(canReview(base))this.onReviewBase?.(id);
   return;
  }
  const day=this.data?.activity.find(day=>day.date===button.dataset.rsDay);
  if(day){
   this.host.querySelector('[data-rs-day-detail]').textContent=dateLabel(day.date)+' : '+number(day.count)+t(' révision')+(day.count>1?'s':'')+', '+formatDuration(day.elapsed_ms)+'.';
   this.host.querySelectorAll('[data-rs-day]').forEach(node=>{node.setAttribute('aria-pressed',node===button?'true':'false');node.setAttribute('tabindex',node===button?'0':'-1');});
  }
 }
 handleKey(event){
  if(this.disposed||!event.target?.dataset?.rsDay)return;
  const buttons=[...this.host.querySelectorAll('[data-rs-day]')],index=buttons.indexOf(event.target);
  const next={ArrowLeft:index-7,ArrowRight:index+7,ArrowUp:index-1,ArrowDown:index+1,Home:0,End:buttons.length-1}[event.key];
  if(next===undefined||index<0)return;
  event.preventDefault();const button=buttons[Math.max(0,Math.min(buttons.length-1,next))];
  this.handleClick({target:button});button.focus();
 }
 renderHistory(){
  if(this.disposed||!this.data)return;
  const target=this.host.querySelector('[data-rs-history]');if(!target)return;
  const time=this.options.historyMetric==='time';
  target.innerHTML=barChart(this.data.activity,{metric:time?'elapsed_ms':'count',label:time?t('Temps de révision'):t('Révisions'),time});
  this.host.querySelectorAll('[data-rs-action="metric"]').forEach(button=>button.setAttribute('aria-pressed',button.dataset.rsMetric===this.options.historyMetric?'true':'false'));
 }
 renderData(){
  if(this.disposed||!this.data)return;
  const d=this.data,c=d.current,today=d.summary.today,period=d.summary.period,grades=today.grade_counts,history=period.reviewed>0;
  const todayCards=stat(number(today.reviewed),t('Révisions aujourd’hui'),number(today.unique_cards)+t(' cartes distinctes'))+stat(formatDuration(today.elapsed_ms),t('Temps de révision aujourd’hui'))+stat(percent(count(grades[2])+count(grades[3]),today.reviewed),t('Notes « Bien » ou « Facile »'),t('Aujourd’hui · selon le mode de notation'))+stat(number(c.due_now),t('À revoir maintenant'),number(c.new_available_today)+t(' nouvelles cartes disponibles pour apprendre.'));
  const planner=ui('<p class="rs-note">Cartes déjà vues arrivant à échéance, si tu ne révises pas d’ici là.</p><table class="rs-planner"><thead><tr><th scope="col">Quand</th><th scope="col">À revoir</th><th scope="col">Temps estimé</th></tr></thead><tbody>')+d.planner.map(row=>ui('<tr><th scope="row">')+esc(t(PLANNER[row.key]||row.key))+ui('</th><td>')+number(row.due)+ui('</td><td>')+esc(estimatedTime(row.estimated_minutes))+ui('</td></tr>')).join('')+ui('</tbody></table><p class="rs-note">Les nombres sont cumulatifs. Les nouvelles cartes et les répétitions après une réponse ne sont pas incluses.</p><details class="rs-estimates"><summary>Comment le temps est-il estimé ?</summary><p>Médiane de tes ')+number(d.estimates.window_days)+ui(' derniers jours, par type d’exercice. Sans durée enregistrée, une valeur indicative est utilisée.</p><ul>')+d.estimates.by_type.map(type=>ui('<li>')+esc(TYPES[type.type]||type.type)+' : '+esc(formatDuration(count(type.seconds)*1000))+t(' / carte · ')+(type.assumed?t('estimation indicative'):number(type.sample_count)+t(' réponses mesurées'))+ui('</li>')).join('')+ui('</ul></details>');
  const exclusiveProgress=reviewProgressHtml(c,{legend:true});
  const progress=(exclusiveProgress||distribution([{label:t('Non apprises'),count:count(c.unseen)+count(c.learning)},{label:t('Apprises (')+masteredDetail(c)+')',count:c.learned}],{total:c.total,emptyMessage:t('Aucune carte active. Active les révisions dans les réglages d’une base et inclus les parties à étudier.')}))+ui('<p class="rs-note">')+number(c.total)+t(' cartes actives. Les rappels des cartes maîtrisées suivent tes réglages d’entretien. ')+(exclusiveProgress?t('La barre compte chaque carte une seule fois; les cartes déjà vues et échues figurent dans « À réviser ». '):'')+ui('Chaque coup à apprendre dans une ouverture compte séparément.</p><p class="rs-note">')+number(c.new_available_today)+t(' nouvelles cartes disponibles pour apprendre.')+'</p>';
  const forecast=ui('<p class="rs-subtitle"><strong>')+number(d.forecast.overdue)+ui('</strong> en retard avant aujourd’hui</p>')+barChart(d.forecast.items,{label:t('Échéances prévues')})+ui('<p class="rs-note">Échéances actuellement enregistrées sur ')+number(d.forecast.days)+ui(' jours, hors retard antérieur. Ce n’est pas une simulation : tes prochaines réponses modifieront ces dates.</p>');
  const activity=activityHeatmap(d.activity)+ui('<div class="rs-mini-stats">')+stat(number(period.days_studied)+t(' / ')+number(d.period.days),t('Jours actifs'))+stat(number(d.streak.current)+t(' jour')+(d.streak.current>1?'s':''),t('Série actuelle'))+stat(number(d.streak.longest)+t(' jour')+(d.streak.longest>1?'s':''),t('Meilleure série'))+ui('</div><p class="rs-note">Séries calculées dans la période affichée; la série actuelle peut se terminer hier.</p>');
  const gradeContent=distribution(GRADES.map((label,i)=>({label:t(label),count:period.grade_counts[i]})),{total:period.reviewed,emptyMessage:t('Révise une première carte pour voir la répartition des notes.')})+ui('<p class="rs-note">Notes enregistrées après évaluation automatique ou choix manuel; ce n’est pas un taux de mémorisation.</p>')+(period.assisted?ui('<p class="rs-note">')+number(period.assisted)+ui(' réponses avec assistance.</p>'):'');
  const historyContent=ui('<div class="rs-history-controls" role="group" aria-label="Mesure de l’activité"><button type="button" data-rs-action="metric" data-rs-metric="count" aria-pressed="')+(this.options.historyMetric==='count')+ui('">Révisions</button><button type="button" data-rs-action="metric" data-rs-metric="time" aria-pressed="')+(this.options.historyMetric==='time')+ui('">Temps</button></div><div class="rs-mini-stats">')+stat(number(period.reviewed),t('Révisions sur la période'))+stat(formatDuration(period.elapsed_ms),t('Temps total'))+stat(period.median_seconds==null?'—':formatDuration(period.median_seconds*1000),t('Durée médiane / réponse'))+ui('</div><div data-rs-history></div>');
  const intervals=distribution(d.intervals.map(interval=>({label:t(INTERVALS[interval.key]||interval.key),count:interval.count})),{emptyMessage:t('Les intervalles apparaîtront après tes premières révisions.')})+ui('<p class="rs-note">Espacement actuel des cartes actives déjà vues et encore soumises à répétition. Les cartes maîtrisées sont exclues.</p>');
  const bases=d.by_base.length?ui('<div class="rs-base-scroll"><table class="rs-base-table"><thead><tr><th scope="col">Base</th><th scope="col">Apprises</th><th scope="col">À revoir</th><th scope="col">Nouvelles disponibles</th><th scope="col">Révisions sur la période</th><th scope="col">Temps</th><th scope="col"><span class="rs-sr-only">Actions</span></th></tr></thead><tbody>')+d.by_base.map(base=>ui('<tr><th scope="row"><strong>')+esc(base.name)+ui('</strong><small>')+esc(TYPES[base.type]||base.type)+(base.review_enabled?'':t(' · révisions désactivées'))+ui('</small>')+reviewProgressHtml(base.current)+ui('</th><td>')+number(base.current.learned)+ui('<small>')+masteredDetail(base.current)+ui('</small></td><td>')+number(count(base.current.due_now)+count(base.current.maintenance_due))+ui('</td><td>')+number(base.current.new_available_today)+ui('</td><td>')+number(base.period.reviewed)+ui('</td><td>')+esc(formatDuration(base.period.elapsed_ms))+ui('</td><td><div class="rs-base-actions">')+(this.onOpenBase?ui('<button type="button" data-rs-action="open-base" data-rs-base="')+base.base_id+ui('">Ouvrir</button>'):'')+(this.onReviewBase&&base.review_enabled?ui('<button type="button" data-rs-action="review-base" data-rs-base="')+base.base_id+'"'+(!canReview(base)?' disabled'+(count(base.current.total)>0&&count(base.current.total)===count(base.current.mastered)?ui(' title="Toutes les cartes sont maîtrisées"'):''):'')+ui('>Réviser</button>'):'')+ui('</div></td></tr>')).join('')+ui('</tbody></table></div>'):empty(t('Aucune base de révision pour le moment. Tu peux activer les révisions dans les réglages de chaque base.'));
  const summaries=card(t('Planifier ma séance'),planner)+card(t('État des cartes'),progress+ui('<h3>Intervalles de révision</h3>')+intervals)+card(t('Notes des réponses'),gradeContent);
  const charts=card(t('Échéances à venir'),forecast,'rs-wide')+card(t('Calendrier d’activité'),activity,'rs-wide')+card(t('Activité sur la période'),historyContent,'rs-wide');
  this.host.querySelector('[data-rs-content]').innerHTML=(!history?ui('<div class="rs-welcome"><strong>Aucune révision sur cette période.</strong> L’activité, les durées et les notes se rempliront au fil de tes révisions.</div>'):'')+ui('<section class="rs-today" aria-label="Résumé du jour">')+todayCards+ui('</section><div class="rs-grid"><div class="rs-column">')+summaries+ui('</div><div class="rs-column">')+charts+ui('</div>')+card(t('Par base'),bases,'rs-full')+ui('</div><p class="rs-scope">Les échéances et les cartes concernent les bases dont les révisions sont activées. L’activité conserve les réponses des cartes retirées et des bases désactivées encore présentes. Les bases supprimées ne sont pas incluses.</p>');
  this.renderHistory();
 }
}
