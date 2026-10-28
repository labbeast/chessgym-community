import {t,locale} from './i18n.js';
import {esc} from './api.js';

const finite=value=>typeof value==='number'&&Number.isFinite(value)?value:null;
const setText=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
const activityNames={analysis:'Analyse',review:'Révision',reading:'Lecture',puzzles:'Puzzles',guess:'Deviner le coup',computer:'Partie contre l’ordinateur',blindfold:'À l’aveugle',coordinates:'Coordonnées',color:'Couleur'};
const quantityNumber=value=>Number(value).toLocaleString(locale(),{maximumFractionDigits:1});
const quantityUnit=unit=>t(({cards:'cartes',games:'parties',positions:'exercices',sessions:'séances'})[unit]||'unités');
const quantityRemaining=unit=>t(({cards:'cartes restantes',games:'parties restantes',positions:'exercices restants',sessions:'séances restantes'})[unit]||'unités restantes');

function trainingQuantityText(context){
 let total=finite(context.targetQuantity),completed=finite(context.completedQuantity),unit=context.quantityUnit;
 if(total!==null&&completed===null&&finite(context.remainingQuantity)!==null)completed=Math.max(0,total-context.remainingQuantity);
 if(total===null||completed===null){
  total=finite(context.total);completed=finite(context.completed);unit=context.quantityUnit||(context.activity==='review'?'cards':'positions');
 }
 if(total===null||completed===null||total<0||completed<0)return '';
 return quantityNumber(completed)+' / '+quantityNumber(total)+' '+quantityUnit(unit);
}

export function trainingClockText(milliseconds,{countdown=false}={}){
 const value=finite(milliseconds);if(value===null)return '—';
 const seconds=Math.max(0,countdown?Math.ceil(value/1000):Math.floor(value/1000));
 const minutes=Math.floor(seconds/60),rest=String(seconds%60).padStart(2,'0');
 return minutes>=60?Math.floor(minutes/60)+':'+String(minutes%60).padStart(2,'0')+':'+rest:String(minutes).padStart(2,'0')+':'+rest;
}

// This projects native measurements. It never starts a clock or records time.
export function trainingToolbarDisplay(context){
 const elapsed=finite(context.elapsedMs),target=finite(context.targetMs),remaining=finite(context.remainingMs);
 const quantity=context.clockType==='quantity'&&finite(context.remainingQuantity)!==null&&finite(context.targetQuantity)!==null;
 const hasTarget=target!==null&&target>0,countdown=context.clockType==='countdown'&&remaining!==null;
 const reached=!!context.program&&(quantity?context.remainingQuantity<=0:hasTarget&&((elapsed!==null&&elapsed>=target)||(countdown&&remaining<=0)));
 const overrun=!quantity&&reached&&elapsed!==null&&elapsed>target?elapsed-target:null;
 const clock=overrun!==null?'+'+trainingClockText(overrun):countdown?trainingClockText(remaining,{countdown:true}):context.clockType==='unknown'?'—':trainingClockText(elapsed);
 const kind=context.paused?'En pause':overrun!==null?'Prolongation':reached?'Objectif atteint':countdown?'restantes':clock==='—'?'Durée indisponible':'Temps effectué';
 const prefix=context.clockLabel&&['Séance','Défi'].includes(context.clockLabel);
 const label=context.paused?t('En pause'):prefix?t(context.clockLabel)+' · '+t(kind):context.clockLabel&&!reached?t(context.clockLabel):t(kind);
 let status=context.paused?t('En pause'):context.status?t(context.status):reached?t('Objectif atteint'):t('En cours');
 if(context.goalMetric==='sessions'&&finite(context.remainingQuantity)!==null)status+=' · '+quantityNumber(context.remainingQuantity)+' '+quantityRemaining('sessions');
 let progress=hasTarget&&elapsed!==null?elapsed/target:hasTarget&&remaining!==null?1-remaining/target:null;
 if(finite(context.progress)!==null)progress=context.progress;
 else if(context.progress&&finite(context.progress.value)!==null&&context.progress.max>0)progress=context.progress.value/context.progress.max;
 if(progress!==null)progress=Math.max(0,Math.min(1,progress));
 return {clock,label,status,reached,progress,quantity:trainingQuantityText(context)};
}

export class TrainingSessionBar {
 constructor(host,{getContext=()=>null,onAction=async()=>{},observeHost=null}={}){
  Object.assign(this,{host,getContext,onAction});this.disposed=false;this.busy=false;this.error='';this.identity=null;this.bar=null;
  this.media=globalThis.matchMedia?.('(max-width:850px), (max-width:1000px) and (max-height:500px)');
  this.onResize=()=>this.placeFinish();this.media?.addEventListener('change',this.onResize);
  this.observer=new MutationObserver(()=>this.render());
  if(observeHost)this.observer.observe(observeHost,{childList:true,subtree:true});
  this.onKey=event=>{if(event.key==='Escape'&&this.menu?.open){this.menu.open=false;this.menu.querySelector('summary').focus();}};
  this.onOutside=event=>{if(this.menu?.open&&!this.menu.contains(event.target))this.menu.open=false;};
  host.ownerDocument.addEventListener('keydown',this.onKey);host.ownerDocument.addEventListener('pointerdown',this.onOutside);
  this.interval=setInterval(()=>this.render(),250);this.render();
 }
 create(){
  const bar=this.bar=document.createElement('aside');bar.className='training-session-bar';bar.dataset.trainingSessionBar='';bar.setAttribute('aria-label',t('Activité Training en cours'));
  const button=(action,label,className='')=>'<button type="button" data-program-session="'+action+'" class="'+className+'">'+esc(t(label))+'</button>';
  bar.innerHTML='<div class="training-toolbar-row"><button type="button" class="training-toolbar-home" data-program-session="return" aria-label="'+esc(t('Retour à Training'))+'">Training</button><span class="training-toolbar-title" data-training-title></span><div class="training-toolbar-metrics"><span class="training-toolbar-quantity" data-training-quantity hidden></span><div class="training-toolbar-clock" role="timer" aria-live="off"><strong data-training-clock>—</strong><span data-training-clock-label></span></div></div><div class="training-toolbar-controls">'+button('pause','Pause','training-toolbar-pause')+button('finish','Terminer','training-toolbar-finish')+'<details class="training-session-menu"><summary aria-label="'+esc(t('Autres actions de l’entraînement'))+'">⋯</summary><div class="training-session-menu-actions"><div class="training-toolbar-details"><p data-training-details-title></p><p data-training-details-clock></p><p data-training-details-quantity hidden></p><div class="training-toolbar-status" role="status" aria-live="polite"><span data-training-status></span></div></div><div class="training-toolbar-goal" hidden><span>'+esc(t('Objectif de la séance'))+'</span><strong></strong></div><div class="training-toolbar-progress" role="progressbar" aria-label="'+esc(t('Progression de la séance'))+'" aria-valuemin="0" aria-valuemax="100" hidden><span></span></div><div class="training-session-actions">'+button('confirm_reading','Confirmer cette partie étudiée')+'</div></div></details></div></div><p class="training-toolbar-error error-text" role="alert" hidden></p>';
  const returnMenu=document.createElement('button');returnMenu.type='button';returnMenu.dataset.trainingReturn='';returnMenu.onclick=()=>this.act('return');
  bar.querySelector('.training-session-actions').append(returnMenu);
  for(const button of bar.querySelectorAll('[data-program-session]'))button.onclick=()=>this.act(button.dataset.programSession);
  this.host.append(bar);this.menu=bar.querySelector('details');
  this.elements={clock:bar.querySelector('[data-training-clock]'),label:bar.querySelector('[data-training-clock-label]'),title:bar.querySelector('[data-training-title]'),quantity:bar.querySelector('[data-training-quantity]'),detailsTitle:bar.querySelector('[data-training-details-title]'),detailsClock:bar.querySelector('[data-training-details-clock]'),detailsQuantity:bar.querySelector('[data-training-details-quantity]'),status:bar.querySelector('[data-training-status]'),pause:bar.querySelector('.training-toolbar-pause'),finish:bar.querySelector('.training-toolbar-finish'),confirm:bar.querySelector('[data-program-session="confirm_reading"]'),home:bar.querySelector('.training-toolbar-home'),returnMenu,goal:bar.querySelector('.training-toolbar-goal'),progress:bar.querySelector('.training-toolbar-progress'),error:bar.querySelector('.training-toolbar-error')};
  // Keep the original logo, its responsive picture and its navigation handler.
  this.brand=this.host.querySelector('.brand');this.brandDisabled=this.brand?.disabled;
  this.host.classList.add('training-toolbar-active');this.placeFinish();
 }
 placeFinish(){
  if(!this.bar)return;const mount=this.media?.matches?this.bar.querySelector('.training-session-actions'):this.bar.querySelector('.training-toolbar-controls');
  if(this.elements.finish.parentElement!==mount){if(this.media?.matches)mount.prepend(this.elements.finish);else mount.insertBefore(this.elements.finish,this.menu);}
 }
 clear(){
  this.bar?.remove();this.bar=null;this.menu=null;this.elements=null;this.host.classList.remove('training-toolbar-active');
  if(this.brand)this.brand.disabled=this.brandDisabled;this.brand=null;
 }
 render(){
  if(this.disposed||!this.host.isConnected)return;
  const context=this.getContext();if(!context||context.active===false&&!context.program){if(this.bar)this.clear();return;}
  if(this.identity!==context.id){this.identity=context.id;this.error='';if(this.menu)this.menu.open=false;}
  if(!this.bar)this.create();
  const d=trainingToolbarDisplay(context),el=this.elements;
  setText(el.clock,d.clock);setText(el.label,d.label);setText(el.status,d.status);
  const activity=t(activityNames[context.activity]||'Entraînement'),title=context.title&&context.title!==activity?activity+' · '+context.title:context.title||activity;
  setText(el.title,title);el.title.title=title;setText(el.detailsTitle,title);
  el.clock.parentElement.title=d.label;el.clock.parentElement.setAttribute('aria-label',d.label+' : '+d.clock);
  setText(el.detailsClock,d.label+' · '+d.clock);
  for(const node of [el.quantity,el.detailsQuantity]){node.hidden=!d.quantity;setText(node,d.quantity);}
  this.bar.dataset.paused=String(!!context.paused);this.bar.dataset.goalReached=String(d.reached);
  const action=context.paused?'resume':'pause',pauseLabel=t(context.paused?'Reprendre':'Pause');
  el.pause.dataset.programSession=action;setText(el.pause,pauseLabel);
  el.pause.setAttribute('aria-label',pauseLabel);el.pause.hidden=context.canPause===false;
  setText(el.finish,t('Terminer'));el.finish.setAttribute('aria-label',t(context.program?'Terminer ce bloc':'Terminer'));el.finish.hidden=context.canFinish===false;
  el.confirm.hidden=!(context.program&&context.activity==='reading'&&context.entry_id);
  const back=t(context.program?'Retour au programme':'Retour à Training');setText(el.returnMenu,back);el.home.setAttribute('aria-label',back);
  const target=finite(context.targetMs),targetQuantity=finite(context.targetQuantity);
  el.goal.hidden=!(target>0||targetQuantity!==null);
  setText(el.goal.querySelector('span'),t(context.goalScope==='today'?'Objectif de la journée':context.goalScope==='week'?'Objectif de la semaine':'Objectif de la séance'));
  if(!el.goal.hidden)setText(el.goal.querySelector('strong'),[target>0?trainingClockText(target):null,targetQuantity!==null?quantityNumber(targetQuantity)+' '+quantityUnit(context.quantityUnit):null].filter(Boolean).join(' · '));
  el.progress.hidden=d.progress===null;if(d.progress!==null){const percent=Math.round(d.progress*100);el.progress.setAttribute('aria-valuenow',String(percent));el.progress.firstElementChild.style.width=(d.progress*100)+'%';}
  el.error.hidden=!this.error;setText(el.error,this.error);
  for(const button of this.bar.querySelectorAll('button'))button.disabled=this.busy;
  if(this.brand)this.brand.disabled=this.busy||this.brandDisabled;
 }
 async act(action){
  if(this.disposed||this.busy)return;const context=this.getContext();if(!context||context.id!==this.identity)return;
  if((action==='pause'||action==='resume')&&context.canPause===false||action==='finish'&&context.canFinish===false)return;
  this.busy=true;this.error='';this.render();
  try{await this.onAction(action,context);if(this.menu)this.menu.open=false;}catch(error){if(!this.disposed&&this.getContext()?.id===context.id)this.error=error.message||String(error);}
  finally{this.busy=false;if(!this.disposed)this.render();}
 }
 dispose(){
  this.disposed=true;clearInterval(this.interval);this.observer.disconnect();this.media?.removeEventListener('change',this.onResize);
  this.host.ownerDocument.removeEventListener('keydown',this.onKey);this.host.ownerDocument.removeEventListener('pointerdown',this.onOutside);this.clear();
 }
}
