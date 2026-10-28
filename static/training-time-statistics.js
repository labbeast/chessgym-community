import {api,esc,option} from './api.js';
import {t,locale} from './i18n.js';
import {ACTIVITIES,activityLabel} from './training-program.js';

const DAY=86400000;
export const TIME_CATEGORIES=Object.freeze(Object.keys(ACTIVITIES));
const COLORS=['#6da5df','#9c8cdc','#e7ad65','#76b89d','#d9828f','#8bbcc5','#b5ac9c','#b3be73','#ba8fb7','#c6a276','#e08e60'];
const color=id=>COLORS[TIME_CATEGORIES.indexOf(id)]||COLORS[0];
const amount=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:0;
const number=value=>Number(value).toLocaleString(locale(),{maximumFractionDigits:1});
const localDate=()=>{const date=new Date();return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');};

export function validStatisticsDate(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const date=new Date(value+'T12:00:00Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;}
export function shiftStatisticsDate(value,days){const date=new Date(value+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+days);return date.toISOString().slice(0,10);}
export function statisticsRange(from,to){if(!validStatisticsDate(from)||!validStatisticsDate(to)||from>to)return null;const days=Math.round((new Date(to+'T12:00:00Z')-new Date(from+'T12:00:00Z'))/DAY)+1;return days<=730?{date_from:from,date_to:to,days}:null;}
export function previousStatisticsRange(from,to){const range=statisticsRange(from,to);return range?{date_from:shiftStatisticsDate(from,-range.days),date_to:shiftStatisticsDate(from,-1)}:null;}

// Keep known milliseconds and missing measurements separate. A missing duration
// can never silently turn into an observed zero or a guessed active interval.
export function statisticsDays(payload={},from=payload.date_from,to=payload.date_to,selected=TIME_CATEGORIES){
 const range=statisticsRange(from,to);if(!range)return [];
 const enabled=TIME_CATEGORIES.filter(id=>selected.includes(id)),rows=new Map((payload.days||[]).filter(row=>validStatisticsDate(row.date)).map(row=>[row.date,row]));
 return Array.from({length:range.days},(_,index)=>{
  const date=shiftStatisticsDate(from,index),source=rows.get(date)||{},by_activity={},by_activity_unknown={},by_activity_estimated={},by_activity_calculated={};
  for(const id of enabled){by_activity[id]=amount(source.by_activity?.[id]);by_activity_unknown[id]=amount(source.by_activity_unknown?.[id]);if(source.by_activity?.[id]===null&&!by_activity_unknown[id])by_activity_unknown[id]=1;by_activity_estimated[id]=Math.min(by_activity[id],amount(source.by_activity_duration_by_kind?.[id]?.estimated));by_activity_calculated[id]=Math.min(by_activity[id]-by_activity_estimated[id],amount(source.by_activity_duration_by_kind?.[id]?.calculated));}
  return {date,by_activity,by_activity_unknown,by_activity_estimated,by_activity_calculated,duration_ms:Object.values(by_activity).reduce((a,b)=>a+b,0),unknown_duration_count:Object.values(by_activity_unknown).reduce((a,b)=>a+b,0)};
 });
}
export function groupStatisticsDays(days,grouping='day'){
 const groups=new Map();
 for(const day of days){
  let key=day.date;
  if(grouping==='week'){const weekday=new Date(key+'T12:00:00Z').getUTCDay();key=shiftStatisticsDate(key,-((weekday+6)%7));}
  else if(grouping==='month')key=key.slice(0,7)+'-01';
  if(!groups.has(key))groups.set(key,{key,date_from:day.date,date_to:day.date,duration_ms:0,unknown_duration_count:0,by_activity:{},by_activity_unknown:{},by_activity_estimated:{},by_activity_calculated:{},days:0});
  const group=groups.get(key);group.date_to=day.date;group.days++;group.duration_ms+=day.duration_ms;group.unknown_duration_count+=day.unknown_duration_count;
  for(const [id,value] of Object.entries(day.by_activity))group.by_activity[id]=(group.by_activity[id]||0)+value;
  for(const [id,value] of Object.entries(day.by_activity_unknown))group.by_activity_unknown[id]=(group.by_activity_unknown[id]||0)+value;
  for(const kind of ['estimated','calculated'])for(const [id,value] of Object.entries(day['by_activity_'+kind]||{}))group['by_activity_'+kind][id]=(group['by_activity_'+kind][id]||0)+value;
 }
 return [...groups.values()];
}
export function statisticsSummary(days){
 const by_activity=Object.fromEntries(TIME_CATEGORIES.map(id=>[id,0])),by_activity_unknown={...by_activity},by_activity_estimated={...by_activity},by_activity_calculated={...by_activity};let duration_ms=0,unknown_duration_count=0,active_days=0;
 for(const day of days){duration_ms+=day.duration_ms;unknown_duration_count+=day.unknown_duration_count;if(day.duration_ms>0)active_days++;for(const [id,value] of Object.entries(day.by_activity))if(Object.hasOwn(by_activity,id))by_activity[id]+=value;for(const [id,value] of Object.entries(day.by_activity_unknown))if(Object.hasOwn(by_activity_unknown,id))by_activity_unknown[id]+=value;for(const [id,value] of Object.entries(day.by_activity_estimated||{}))if(Object.hasOwn(by_activity_estimated,id))by_activity_estimated[id]+=value;for(const [id,value] of Object.entries(day.by_activity_calculated||{}))if(Object.hasOwn(by_activity_calculated,id))by_activity_calculated[id]+=value;}
 return {duration_ms,unknown_duration_count,active_days,average_ms:days.length?duration_ms/days.length:0,by_activity,by_activity_unknown,by_activity_estimated,by_activity_calculated};
}
export function statisticsWeekdays(days){
 const rows=Array.from({length:7},(_,index)=>({weekday:index,days:0,duration_ms:0,average_ms:0,unknown_duration_count:0}));
 for(const day of days){const row=rows[(new Date(day.date+'T12:00:00Z').getUTCDay()+6)%7];row.days++;row.duration_ms+=day.duration_ms;row.unknown_duration_count+=day.unknown_duration_count;}
 for(const row of rows)row.average_ms=row.days?row.duration_ms/row.days:0;
 return rows;
}
export function statisticsTime(value){if(value==null)return '—';const seconds=Math.round(amount(value)/1000);if(!seconds)return '0 '+t('min');if(seconds<60)return '< 1 '+t('min');const minutes=Math.floor(seconds/60);return minutes>=60?Math.floor(minutes/60)+' '+t('h')+(minutes%60?' '+String(minutes%60).padStart(2,'0'):''):minutes+' '+t('min');}
const formatDate=(value,long=false)=>new Intl.DateTimeFormat(locale(),long?{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}:{day:'numeric',month:'short',timeZone:'UTC'}).format(new Date(value+'T12:00:00Z'));
const periodLabel=group=>group.date_from===group.date_to?formatDate(group.date_from):formatDate(group.date_from)+' – '+formatDate(group.date_to);
const unknownLabel=count=>t('{count} durée(s) inconnue(s)',{count:number(count)});
const knownTime=(value,unknown=0)=>unknown&&!value?'—':statisticsTime(value);
const provenanceLabel=(values,id=null)=>{
 const total=kind=>id==null?Object.values(values['by_activity_'+kind]||{}).reduce((a,b)=>a+b,0):values['by_activity_'+kind]?.[id]||0;
 const estimated=total('estimated'),calculated=total('calculated');
 return [estimated>0?t('Dont {time} estimées d’après la cadence',{time:statisticsTime(estimated)}):'',calculated>0?t('Dont {time} calculées à partir des pendules',{time:statisticsTime(calculated)}):''].filter(Boolean).join(' · ');
};
const dayLabel=day=>formatDate(day.date,true)+' · '+knownTime(day.duration_ms,day.unknown_duration_count)+(day.unknown_duration_count?' · '+unknownLabel(day.unknown_duration_count):'');
const svgTitle=text=>'<title>'+esc(text)+'</title>';
const card=(heading,body,extra='')=>'<section class="tts-card '+extra+'"><h3>'+esc(heading)+'</h3>'+body+'</section>';

export class TrainingTimeStatistics {
 constructor(host,{request=api,isCurrent=()=>true,today=localDate()}={}){
  Object.assign(this,{host,request,isCurrent});this.today=validStatisticsDate(today)?today:localDate();this.range='30';this.date_to=this.today;this.date_from=shiftStatisticsDate(this.today,-29);this.grouping='day';this.selected=[...TIME_CATEGORIES];this.data=null;this.previous=null;this.error='';this.loading=false;this.disposed=false;this.sequence=0;
  this.change=event=>{void this.handleChange(event).catch(error=>this.report(error));};
  this.click=event=>{const action=event.target.closest?.('[data-stats-action]')?.dataset.statsAction;if(action==='all'||action==='none'){this.selected=action==='all'?[...TIME_CATEGORIES]:[];this.render();}else if(action==='retry')void this.load();};
  this.submit=event=>{if(event.target.matches?.('[data-stats-dates]')){event.preventDefault();const form=event.target;void this.setDates(form.elements.date_from.value,form.elements.date_to.value);}};
  this.host.classList.add('training-time-statistics');this.host.addEventListener('change',this.change);this.host.addEventListener('click',this.click);this.host.addEventListener('submit',this.submit);
  this.lastWidth=this.host.clientWidth||0;
  if(globalThis.ResizeObserver){this.resizeObserver=new ResizeObserver(()=>{const width=this.host.clientWidth;if(width>0&&Math.abs(width-this.lastWidth)>1){this.lastWidth=width;this.render();}});this.resizeObserver.observe(this.host);}
 }
 current(){return !this.disposed&&this.isCurrent();}
 dispose(){this.disposed=true;this.sequence++;this.controller?.abort();this.resizeObserver?.disconnect();this.host.removeEventListener('change',this.change);this.host.removeEventListener('click',this.click);this.host.removeEventListener('submit',this.submit);this.host.classList.remove('training-time-statistics');}
 report(error){if(!this.current()||error.name==='AbortError')return;this.error=error.message;this.loading=false;this.render();}
 async load(){
  if(!this.current())return;const seq=++this.sequence;this.controller?.abort();const controller=this.controller=new AbortController(),from=this.date_from,to=this.date_to,previous=previousStatisticsRange(from,to);
  if(!previous){this.error=t('Choisis une période valide de 730 jours au maximum.');this.render();return;}
  this.loading=true;this.error='';this.render();
  const url=range=>'/api/training/statistics?date_from='+range.date_from+'&date_to='+range.date_to;
  const [currentResult,previousResult]=await Promise.allSettled([this.request(url({date_from:from,date_to:to}),{signal:controller.signal}),this.request(url(previous),{signal:controller.signal})]);
  if(!this.current()||seq!==this.sequence)return;this.loading=false;
  if(currentResult.status==='rejected'){this.data=null;this.previous=null;this.report(currentResult.reason);return;}
  this.data=currentResult.value;this.previous=previousResult.status==='fulfilled'?previousResult.value:null;this.render();
 }
 async setDates(from,to){if(!statisticsRange(from,to)){this.error=t('Choisis une période valide de 730 jours au maximum.');this.render();return;}this.date_from=from;this.date_to=to;this.range='custom';await this.load();}
 async handleChange(event){
  const target=event.target;
  if(target.matches?.('[data-stats-range]')){this.range=target.value;if(this.range==='custom'){this.render();return;}const days=Number(this.range);if(![7,30,90,365].includes(days))return;this.date_to=this.today;this.date_from=shiftStatisticsDate(this.today,1-days);await this.load();}
  else if(target.matches?.('[data-stats-grouping]')){if(['day','week','month'].includes(target.value)){this.grouping=target.value;this.render();}}
  else if(target.matches?.('[data-stats-category]')){const id=target.dataset.statsCategory;if(!TIME_CATEGORIES.includes(id))return;this.selected=target.checked?[...new Set([...this.selected,id])]:this.selected.filter(value=>value!==id);this.render();const filter=this.host.querySelector?.('.tts-filter');if(filter)filter.open=true;this.host.querySelector?.('[data-stats-category="'+id+'"]')?.focus();}
 }
 controlsHtml(){return '<div class="tts-controls"><label>'+esc(t('Période'))+'<select data-stats-range>'+[['7','7 derniers jours'],['30','30 derniers jours'],['90','90 derniers jours'],['365','365 derniers jours'],['custom','Période personnalisée']].map(([id,label])=>option(id,t(label),this.range)).join('')+'</select></label><label>'+esc(t('Regrouper par'))+'<select data-stats-grouping>'+[['day','Jour'],['week','Semaine'],['month','Mois']].map(([id,label])=>option(id,t(label),this.grouping)).join('')+'</select></label><span class="tts-period">'+esc(formatDate(this.date_from)+' – '+formatDate(this.date_to))+'</span></div>'+(this.range==='custom'?'<form data-stats-dates class="tts-dates"><label>'+esc(t('Du'))+'<input type="date" name="date_from" value="'+this.date_from+'" required></label><label>'+esc(t('Au'))+'<input type="date" name="date_to" value="'+this.date_to+'" required></label><button type="submit">'+esc(t('Afficher'))+'</button></form>':'')+'<details class="tts-filter"><summary>'+esc(t('Activités'))+' <span>'+this.selected.length+' / '+TIME_CATEGORIES.length+'</span></summary><div class="tts-filter-actions"><button type="button" data-stats-action="all">'+esc(t('Tout sélectionner'))+'</button><button type="button" data-stats-action="none">'+esc(t('Tout désélectionner'))+'</button></div><div class="tts-categories">'+TIME_CATEGORIES.map(id=>'<label><input type="checkbox" data-stats-category="'+id+'" '+(this.selected.includes(id)?'checked':'')+'><span class="tts-swatch" style="--category-color:'+color(id)+'"></span>'+esc(activityLabel(id))+'</label>').join('')+'</div></details>';}
 kpisHtml(summary,days){
  const previousRange=previousStatisticsRange(this.date_from,this.date_to),previous=this.previous?statisticsSummary(statisticsDays(this.previous,previousRange.date_from,previousRange.date_to,this.selected)):null;
  let comparison='—',note=t('Période précédente indisponible');
  if(previous){const delta=summary.duration_ms-previous.duration_ms;comparison=(delta>0?'+':delta<0?'−':'')+statisticsTime(Math.abs(delta));note=previous.duration_ms>0?(delta>0?'+':'')+number(delta/previous.duration_ms*100)+' % · '+t('Période précédente'):t('Aucune durée connue sur la période précédente');if(previous.unknown_duration_count||summary.unknown_duration_count)note+=' · '+t('Durées connues uniquement');}
  if((summary.unknown_duration_count&&!summary.duration_ms)||(previous?.unknown_duration_count&&!previous.duration_ms)){comparison='—';note=t('Durées connues uniquement');}
  if(previous&&[summary,previous].some(values=>Object.values(values.by_activity_estimated||{}).some(value=>value>0)))note+=' · '+t('Durées estimées incluses');
  const cells=[[knownTime(summary.duration_ms,summary.unknown_duration_count),'Temps cumulé',summary.unknown_duration_count?unknownLabel(summary.unknown_duration_count):t('Toutes les durées enregistrées')],[number(summary.active_days)+' / '+number(days.length),'Jours actifs','Jours avec du temps enregistré'],[knownTime(summary.average_ms,summary.unknown_duration_count),'Moyenne par jour','Tous les jours de la période'],[comparison,'Évolution',note]];
  return '<div class="tts-kpis">'+cells.map(([value,title,note])=>'<article><span>'+esc(t(title))+'</span><strong>'+esc(value)+'</strong><small>'+esc(t(note))+'</small></article>').join('')+'</div>';
 }
 timelineHtml(groups){
  const available=Math.max(240,Number(this.host.clientWidth||900)-40),width=Math.max(available,groups.length>90?groups.length*6+62:0),height=245,left=48,right=14,top=16,bottom=38,plotHeight=height-top-bottom,plotWidth=width-left-right,max=Math.max(60000,...groups.map(group=>group.duration_ms)),step=plotWidth/Math.max(groups.length,1),barWidth=Math.max(1,step*.72),labelEvery=Math.max(1,Math.ceil(groups.length/Math.max(2,Math.floor(plotWidth/65))));
  let bars='',grid='';
  for(let tick=0;tick<=4;tick++){const y=top+plotHeight-plotHeight*tick/4;grid+='<line x1="'+left+'" x2="'+(width-right)+'" y1="'+y+'" y2="'+y+'" class="tts-gridline"/><text x="'+(left-7)+'" y="'+(y+4)+'" text-anchor="end">'+esc(statisticsTime(max*tick/4))+'</text>';}
  groups.forEach((group,index)=>{let used=0;const x=left+index*step+(step-barWidth)/2;for(const id of this.selected){const value=group.by_activity[id]||0;if(!value)continue;const h=value/max*plotHeight,y=top+plotHeight-used-h;used+=h;bars+='<rect x="'+x+'" y="'+y+'" width="'+barWidth+'" height="'+h+'" fill="'+color(id)+'" tabindex="0" role="img" aria-label="'+esc(periodLabel(group)+' · '+activityLabel(id)+' · '+statisticsTime(value)+(provenanceLabel(group,id)?' · '+provenanceLabel(group,id):''))+'">'+svgTitle(periodLabel(group)+' · '+activityLabel(id)+' · '+statisticsTime(value)+(provenanceLabel(group,id)?' · '+provenanceLabel(group,id):''))+'</rect>';}
   if(group.unknown_duration_count)bars+='<text x="'+(x+barWidth/2)+'" y="'+Math.max(11,top+plotHeight-used-5)+'" text-anchor="middle">'+svgTitle(unknownLabel(group.unknown_duration_count))+'*</text>';
   if((index%labelEvery===0&&(groups.length-1-index)*step>=60)||index===groups.length-1)bars+='<text class="tts-axis-date" x="'+(x+barWidth/2)+'" y="'+(height-12)+'" text-anchor="'+(index===groups.length-1?'end':'middle')+'">'+esc(formatDate(group.date_from))+'</text>';
  });
  return card(t('Le temps au fil des jours'),'<p class="tts-caption">'+esc(t('Chaque couleur représente une activité. Survole une barre pour voir sa durée.'))+'</p><div class="tts-chart-scroll"'+(width>available?' data-time-scroll':'')+'><svg class="tts-timeline" viewBox="0 0 '+width+' '+height+'"'+(width>available?' style="min-width:'+width+'px"':'')+' role="img" aria-label="'+esc(t('Temps enregistré par période et par activité'))+'">'+svgTitle(t('Temps enregistré par période et par activité'))+grid+bars+'</svg></div>', 'tts-timeline-card');
 }
 distributionHtml(summary){
  const radius=70,circumference=2*Math.PI*radius;let offset=0;
  const categories=this.selected.map(id=>({id,value:summary.by_activity[id]||0})).sort((a,b)=>b.value-a.value),slices=categories.filter(row=>row.value>0).map(row=>{const size=row.value/summary.duration_ms*circumference,result='<circle cx="100" cy="100" r="'+radius+'" fill="none" stroke="'+color(row.id)+'" stroke-width="26" stroke-dasharray="'+size+' '+(circumference-size)+'" stroke-dashoffset="'+(-offset)+'" transform="rotate(-90 100 100)">'+svgTitle(activityLabel(row.id)+' · '+statisticsTime(row.value)+' · '+number(row.value/summary.duration_ms*100)+' %')+'</circle>';offset+=size;return result;}).join('');
  const list=categories.map(row=>{const unknown=summary.by_activity_unknown[row.id]||0;return '<li><span class="tts-swatch" style="--category-color:'+color(row.id)+'"></span><span>'+esc(activityLabel(row.id))+'</span><strong title="'+esc([unknown?unknownLabel(unknown):'',provenanceLabel(summary,row.id)].filter(Boolean).join(' · '))+'">'+esc(knownTime(row.value,unknown))+(summary.by_activity_estimated?.[row.id]?' ≈':'')+(unknown&&row.value?' *':'')+'</strong><small>'+(unknown&&!row.value?'—':number(summary.duration_ms?row.value/summary.duration_ms*100:0)+' %')+'</small></li>';}).join('');
  return card(t('Répartition du temps'),'<div class="tts-distribution"><svg viewBox="0 0 200 200" role="img" aria-label="'+esc(t('Répartition du temps par activité'))+'"><circle cx="100" cy="100" r="70" fill="none" class="tts-donut-track" stroke-width="26"/>'+slices+'<text x="100" y="100" text-anchor="middle" class="tts-donut-total">'+esc(knownTime(summary.duration_ms,summary.unknown_duration_count))+'</text><text x="100" y="121" text-anchor="middle">'+esc(t('au total'))+'</text></svg><ul class="tts-distribution-list">'+list+'</ul></div>');
 }
 calendarHtml(days){
  if(!days.length)return '';const first=shiftStatisticsDate(days[0].date,-((new Date(days[0].date+'T12:00:00Z').getUTCDay()+6)%7)),last=days.at(-1).date,weeks=Math.floor((new Date(last+'T12:00:00Z')-new Date(first+'T12:00:00Z'))/(DAY*7))+1,cell=15,gap=4,left=30,top=26,width=Math.max(180,left+weeks*(cell+gap)+8),height=168,max=Math.max(1,...days.map(day=>day.duration_ms));let cells='',labels='';
  for(let weekday=0;weekday<7;weekday+=2){const date=shiftStatisticsDate('2026-10-26',weekday);labels+='<text x="0" y="'+(top+weekday*(cell+gap)+12)+'">'+esc(new Intl.DateTimeFormat(locale(),{weekday:'narrow',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z')))+'</text>';}
  const monthLabels=[];let lastMonth='';days.forEach(day=>{const offset=Math.round((new Date(day.date+'T12:00:00Z')-new Date(first+'T12:00:00Z'))/DAY),x=left+Math.floor(offset/7)*(cell+gap),y=top+(offset%7)*(cell+gap),intensity=day.duration_ms?Math.max(.23,Math.sqrt(day.duration_ms/max)):0,month=day.date.slice(0,7);
   if(month!==lastMonth){if(monthLabels.length&&x-monthLabels.at(-1).x<42)monthLabels.pop();monthLabels.push({x,date:day.date});lastMonth=month;}
   cells+='<g><rect x="'+x+'" y="'+y+'" width="'+cell+'" height="'+cell+'" rx="3" class="tts-calendar-empty"/><rect x="'+x+'" y="'+y+'" width="'+cell+'" height="'+cell+'" rx="3" class="tts-calendar-day" fill-opacity="'+intensity+'" tabindex="0" role="img" aria-label="'+esc(dayLabel(day))+'">'+svgTitle(dayLabel(day))+'</rect>'+(day.unknown_duration_count?'<circle cx="'+(x+cell-3)+'" cy="'+(y+3)+'" r="2" class="tts-unknown-dot"/>':'')+'</g>';
  });
  labels+=monthLabels.map(item=>'<text class="tts-axis-month" x="'+item.x+'" y="14">'+esc(new Intl.DateTimeFormat(locale(),{month:'short',timeZone:'UTC'}).format(new Date(item.date+'T12:00:00Z')))+'</text>').join('');
  return card(t('La régularité en un regard'),'<p class="tts-caption">'+esc(t('Une case par jour. Plus la couleur est intense, plus tu as consacré de temps.'))+'</p><div class="tts-chart-scroll"><svg class="tts-calendar" viewBox="0 0 '+width+' '+height+'" style="width:'+width+'px;min-width:'+width+'px" role="img" aria-label="'+esc(t('Calendrier du temps consacré'))+'">'+labels+cells+'</svg></div><p class="tts-heat-legend"><span>'+esc(t('Moins'))+'</span>'+[0,.25,.5,.75,1].map(value=>'<i style="--intensity:'+value+'"></i>').join('')+'<span>'+esc(t('Plus'))+'</span></p>');
 }
 weekdaysHtml(days){const rows=statisticsWeekdays(days),max=Math.max(1,...rows.map(row=>row.average_ms));return card(t('Ton rythme dans la semaine'),'<p class="tts-caption">'+esc(t('Temps moyen pour chaque jour de la semaine, jours sans activité inclus.'))+'</p><div class="tts-weekdays">'+rows.map(row=>{const label=new Intl.DateTimeFormat(locale(),{weekday:'long',timeZone:'UTC'}).format(new Date(shiftStatisticsDate('2026-10-26',row.weekday)+'T12:00:00Z'));return '<div><span>'+esc(label)+'</span><div class="tts-weekday-track"><i style="width:'+row.average_ms/max*100+'%"></i></div><strong title="'+esc(row.unknown_duration_count?unknownLabel(row.unknown_duration_count):'')+'">'+esc(row.days?knownTime(row.average_ms,row.unknown_duration_count):'—')+(row.unknown_duration_count&&row.average_ms?' *':'')+'</strong></div>';}).join('')+'</div>');}
 tableHtml(groups){const cell=(value,unknown)=>'<td>'+esc(knownTime(value,unknown))+(unknown?' <span title="'+esc(unknownLabel(unknown))+'">*</span>':'')+'</td>';return '<details class="tts-data"><summary>'+esc(t('Voir les données'))+'</summary><div class="tts-table-scroll"><table><caption>'+esc(t('Durées enregistrées pour les activités sélectionnées'))+'</caption><thead><tr><th scope="col">'+esc(t('Période'))+'</th>'+this.selected.map(id=>'<th scope="col">'+esc(activityLabel(id))+'</th>').join('')+'<th scope="col">'+esc(t('Total'))+'</th></tr></thead><tbody>'+groups.map(group=>'<tr><th scope="row">'+esc(periodLabel(group))+'</th>'+this.selected.map(id=>cell(group.by_activity[id]||0,group.by_activity_unknown[id]||0)).join('')+cell(group.duration_ms,group.unknown_duration_count)+'</tr>').join('')+'</tbody></table></div></details>';}
 render(){
  if(!this.current())return;const days=this.data?statisticsDays(this.data,this.date_from,this.date_to,this.selected):[],summary=statisticsSummary(days),groups=groupStatisticsDays(days,this.grouping);
  let html='<header class="tts-heading"><h2>'+esc(t('Ton temps d’entraînement'))+'</h2><p>'+esc(t('Tout le temps enregistré, avec ou sans programme et même sans objectif.'))+'</p></header>'+this.controlsHtml();
  if(this.error)html+='<div class="tts-error" role="alert">'+esc(this.error)+' <button type="button" data-stats-action="retry">'+esc(t('Réessayer'))+'</button></div>';
  if(this.loading)html+='<p role="status" class="tts-loading">'+esc(t('Chargement des statistiques…'))+'</p>';
  if(this.data&&!this.loading){if(!this.selected.length)html+='<p class="tts-empty">'+esc(t('Sélectionne une activité pour explorer ton temps.'))+'</p>';else{html+=this.kpisHtml(summary,days);const provenance=provenanceLabel(summary);if(provenance)html+='<p class="tts-provenance">'+esc(provenance)+'</p>';if(!summary.duration_ms)html+='<p class="tts-empty">'+esc(t('Aucune durée mesurée sur cette période. Les nouvelles activités apparaîtront ici automatiquement.'))+'</p>';if(summary.unknown_duration_count)html+='<p class="tts-unknown">'+esc(t('{count} activité(s) ont une durée inconnue. Elles ne sont pas comptées comme zéro.',{count:number(summary.unknown_duration_count)}))+'</p>';html+=this.timelineHtml(groups)+'<div class="tts-chart-grid">'+this.distributionHtml(summary)+this.weekdaysHtml(days)+'</div>'+this.calendarHtml(days)+this.tableHtml(groups);}}
  const filterOpen=this.host.querySelector?.('.tts-filter')?.open;this.host.innerHTML=html;if(filterOpen){const filter=this.host.querySelector?.('.tts-filter');if(filter)filter.open=true;}const scroll=this.host.querySelector?.('[data-time-scroll]');if(scroll)scroll.scrollLeft=scroll.scrollWidth;
 }
}
