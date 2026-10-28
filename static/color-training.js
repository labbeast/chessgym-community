import {bindTrainingTabs,setupSummaryHtml} from './exercise-tabs.js';
import {api,esc,option,fail} from './api.js';
import {t} from './i18n.js';
import {playSound} from './sound.js';
import {openTrainingHistory} from './training-history.js';
import {openTrainingSettings} from './training-settings.js';

const endpoint='/api/skills/color';
const text=value=>esc(t(value));
export function colorRecordEligible(result){return !!result?.record_eligible;}
export function colorChoicesHtml(disabled=false){
 return `<div class="color-choices">${[['white','Blanche','←'],['black','Noire','→']].map(([color,label,key])=>`<button type="button" data-color="${color}" ${disabled?'disabled':''}><span class="color-swatch ${color}" aria-hidden="true"></span><span>${text(label)}</span><kbd aria-hidden="true">${key}</kbd></button>`).join('')}</div>`;
}
export function colorRecordsHtml(data={}){
 const records=data.records||[];
 return `<h2>${text('Records personnels')}</h2><p class="hint">${text('Seules les séances à 100 % de bonnes réponses comptent pour les records.')}</p><div class="color-records">${[30,60].map(duration=>{const best=records.find(row=>(row.duration??row.config?.duration)===duration);return `<div><small>${duration} s</small><strong>${best?esc(best.score):'—'}</strong><span>${best?'100 %':text('Aucun record')}</span></div>`;}).join('')}</div>`;
}
import {nativeProgramRequest,acceptedProgramCreation} from './training-native.js';

export class ColorTrainingView {
 constructor(host,{request=api,now=()=>Date.now(),initialSettings=null,onSettingsChange=null}={}){
  Object.assign(this,{host,request,now,onSettingsChange});this.duration=[30,60].includes(initialSettings?.duration)?initialSettings.duration:30;this.data={history:[],records:[]};this.session=null;this.disposed=false;this.sequence=0;this.busy=false;this.error='';this.offset=0;this.timer=null;
  this.key=event=>{if(event.repeat||event.defaultPrevented||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||event.isComposing||event.target?.closest?.('input,select,textarea,[contenteditable],dialog')||globalThis.document?.querySelector('dialog[open]'))return;const color=event.key==='ArrowLeft'?'white':event.key==='ArrowRight'?'black':null;if(color&&this.session&&!this.session.finished){event.preventDefault();void this.answer(color);}};
  globalThis.document?.addEventListener('keydown',this.key);
 }
 dispose(){this.disposed=true;this.sequence++;this.dialogSequence=(this.dialogSequence||0)+1;clearInterval(this.timer);this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();globalThis.document?.removeEventListener('keydown',this.key);}
 async load(){const generation=++this.sequence;try{const data=await this.request(endpoint+'/history');if(this.disposed||generation!==this.sequence)return;this.data=data;this.render();}catch(error){if(!this.disposed&&generation===this.sequence){this.error=error.message;this.render();}}}
 accept(session){this.session=session;this.offset=this.now()/1000-session.server_time;}
 remaining(){return this.session?.deadline==null?this.session?.config.duration||this.duration:Math.max(0,Math.ceil(this.session.deadline-(this.now()/1000-this.offset)));}
 runTimer(){clearInterval(this.timer);this.timer=setInterval(()=>this.tick(),100);this.timer.unref?.();}
 tick(){if(this.disposed||!this.session||this.session.finished)return;const value=this.host.querySelector('[data-color-clock]');if(value)value.textContent=this.remaining()+' s';if(this.session.deadline!=null&&this.remaining()===0&&!this.busy&&!this.error)void this.finish();}
 render(){
  if(this.disposed)return;
  const locked=this.session&&!this.session.finished;
  this.host.innerHTML=`<section class="training-skill-view color-training"><header class="skill-header training-header"><div class="training-header-copy"><h1>${text('Couleur des cases')}</h1><span>${text('Quelle est la couleur de cette case ?')}</span></div><nav class="tabs training-tabs" aria-label="${text('Couleur des cases')}"><span class="training-tab" aria-current="page">${text('Jouer')}</span><button type="button" data-training-history aria-haspopup="dialog" ${locked?'disabled':''}>${text('Historique')}</button><button type="button" data-training-statistics aria-haspopup="dialog" ${locked?'disabled':''}>${text('Statistiques')}</button><button type="button" data-training-settings aria-haspopup="dialog" ${locked?'disabled':''}>${text('Réglages')}</button></nav></header><div class="skill-layout"><div class="skill-stage">${this.session?this.sessionHtml():this.setupHtml()}<p class="color-error" role="alert" ${this.error?'':'hidden'}>${esc(this.error)}</p>${this.error?`<button data-color-retry>${text('Réessayer')}</button>`:''}</div></div></section>`;
  bindTrainingTabs(this.host);
  this.host.querySelector('[data-training-history]')?.addEventListener('click',()=>void this.showHistory().catch(fail));
  this.host.querySelector('[data-training-statistics]')?.addEventListener('click',()=>void this.showStatistics().catch(fail));
  this.host.querySelector('[data-training-settings]')?.addEventListener('click',()=>this.showSettings());
  const form=this.host.querySelector('[data-color-setup]');if(form){form.onchange=()=>{this.duration=Number(new FormData(form).get('duration'));this.onSettingsChange?.({duration:this.duration});};form.onsubmit=event=>{event.preventDefault();void this.start(Number(new FormData(form).get('duration')));};}
  this.host.querySelectorAll('[data-color]').forEach(button=>button.onclick=()=>void this.answer(button.dataset.color));
  this.host.querySelector('[data-color-again]')?.addEventListener('click',()=>void this.start(this.duration));
  this.host.querySelector('[data-color-settings]')?.addEventListener('click',()=>{if(this.busy)return;this.sequence++;clearInterval(this.timer);this.session=null;this.error='';this.render();});
  this.host.querySelector('[data-color-retry]')?.addEventListener('click',()=>{this.error='';if(this.session?.deadline&&this.remaining()===0)void this.finish();else if(this.session)void this.recover();else void this.load();});
 }
 async openTrainingRecord(record){
  const generation=++this.sequence,session=await this.request(endpoint+'/'+encodeURIComponent(record.id));
  if(this.disposed||generation!==this.sequence)return;
  clearInterval(this.timer);this.duration=session.config.duration;this.accept(session);this.error='';this.render();if(!session.finished)this.runTimer();
 }
 async showHistory(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const dialog=await openTrainingHistory({host:this.host,tool:'color',request:this.request,extraHtml:'<aside class="skill-history">'+colorRecordsHtml(this.data)+'</aside>'});if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)dialog.close();else this.historyDialog=dialog;
 }
 settingsFieldsHtml(duration=this.duration){return `<label>${text('Durée')}<select name="duration">${[30,60].map(value=>option(value,value+' s',duration)).join('')}</select></label><p>${text('Réponds à un maximum de questions avant la fin du chrono.')}</p><p class="hint">${text('Le chrono démarre à la première réponse.')}</p>`;}
 setupHtml(){return `<form data-color-setup class="exercise-launch"><label>${text('Durée')}<select name="duration">${[30,60].map(value=>option(value,value+' s',this.duration)).join('')}</select></label><div class="color-example" aria-hidden="true">A1 <span class="color-swatch black"></span></div><p class="exercise-config-summary">${text('Le chrono démarre à la première réponse.')}</p><button class="primary" type="submit" ${this.busy?'disabled':''}>${text('Commencer')}</button></form>`;}
 showSettings(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const inline=this.host.querySelector('[data-color-setup]'),duration=inline?Number(new FormData(inline).get('duration')):this.duration;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  this.settingsDialog=openTrainingSettings({host:this.host,title:t('Réglages')+' · '+t('Couleur des cases'),html:this.settingsFieldsHtml(duration),onSubmit:data=>{
   if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)return;
   this.duration=Number(data.get('duration'));this.onSettingsChange?.({duration:this.duration});this.render();
  }});
 }
 async showStatistics(){
  if(this.disposed||this.busy||this.session&&!this.session.finished)return;
  const sequence=this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  const {openTrainingStatistics}=await import('./training-statistics.js');
  if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)return;
  const dialog=await openTrainingStatistics({host:this.host,tool:'color',request:this.request,extraHtml:'<aside class="skill-history">'+colorRecordsHtml(this.data)+'</aside>'});
  if(this.disposed||sequence!==this.dialogSequence||this.busy||this.session&&!this.session.finished)dialog.close();else this.statisticsDialog=dialog;
 }
 sessionHtml(){
  const session=this.session;
  if(session.finished){const result=session.result||{},eligible=colorRecordEligible(result);return `<div class="skill-result-banner ${eligible?'success':''}" role="status"><strong>${text(eligible?'Sans faute !':'Séance terminée')}</strong><span>${esc(result.accuracy??0)} %</span></div><div class="color-final-score"><strong>${esc(result.score??0)}</strong><span>${text('bonnes réponses')}</span></div><div class="color-result-details"><span>${result.answered??0} ${text('réponses')}</span><span>${result.errors??0} ${text('erreurs')}</span><span>${result.duration??session.config.duration} s</span></div><p class="color-eligibility">${text(eligible?'Résultat admissible aux records.':'Résultat hors records : il faut terminer sans aucune erreur.')}</p><div class="skill-actions"><button class="primary" data-color-again>${text('Rejouer')}</button><button data-color-settings>${text('Durée')}</button></div>`;}
  const last=session.last_answer;
  return `<div class="color-live-score"><span><strong>${session.score}</strong> ${text('bonnes réponses')}</span><b data-color-clock>${this.remaining()} s</b><span>${session.errors} ${text('erreurs')}</span></div><div class="color-question" role="status" aria-label="${text('Case à identifier')}">${esc(session.target?.square?.toUpperCase()||'')}</div>${colorChoicesHtml(this.busy)}<p class="color-feedback ${last?last.correct?'correct':'incorrect':''}" role="status">${last?`${esc(last.square.toUpperCase())} ${last.correct?'✓':'×'} · ${text(last.correct?'Bonne réponse':'Mauvaise réponse')}`:text('Le chrono démarre à la première réponse.')}</p>${session.errors?`<p class="hint">${text('Continue pour t’entraîner. Cette séance ne comptera pas pour les records.')}</p>`:`<p class="hint">${text('Objectif : 100 % de bonnes réponses.')}</p>`}`;
 }
 setBusy(value){this.busy=value;this.host.querySelectorAll('[data-color], [data-color-again], [data-color-settings], [data-color-retry], [data-color-setup] button').forEach(button=>button.disabled=value);for(const selector of ['[data-training-history]','[data-training-statistics]','[data-training-settings]']){const button=this.host.querySelector(selector);if(button)button.disabled=!!(value||this.session&&!this.session.finished);}}
 async start(duration){
  if(this.busy||this.disposed)return;this.setBusy(true);const generation=++this.sequence;this.error='';
  this.dialogSequence=(this.dialogSequence||0)+1;this.historyDialog?.close();this.statisticsDialog?.close();this.settingsDialog?.close();
  try{const session=await nativeProgramRequest(this,'color',{duration},body=>this.request(endpoint,{method:'POST',body}));if(this.disposed||generation!==this.sequence)return;acceptedProgramCreation(this,'color');this.duration=duration;this.accept(session);this.render();this.runTimer();}
  catch(error){if(!this.disposed&&generation===this.sequence){this.error=error.message;this.render();}}finally{if(!this.disposed&&generation===this.sequence)this.setBusy(false);}
 }
 async recover({afterAnswer=false}={}){
  if(!this.session||this.disposed||(this.busy&&!afterAnswer))return;this.setBusy(true);const generation=this.sequence,id=this.session.id;
  try{const session=await this.request(endpoint+'/'+id);if(this.disposed||generation!==this.sequence||id!==this.session?.id)return;this.error='';this.accept(session);if(session.finished)await this.completed();else{this.render();this.runTimer();}}
  catch(error){if(!this.disposed&&generation===this.sequence&&id===this.session?.id){this.error=error.message;this.render();}}
  finally{if(!this.disposed&&generation===this.sequence&&id===this.session?.id)this.setBusy(false);}
 }
 async answer(color){
  if(this.busy||this.disposed||!this.session||this.session.finished||!['white','black'].includes(color))return;
  if(this.session.deadline&&this.remaining()===0){await this.finish();return;}
  this.setBusy(true);this.error='';const generation=this.sequence,previous=this.session;
  try{const session=await this.request(endpoint+'/'+previous.id+'/answer',{method:'POST',body:{index:previous.index,nonce:previous.nonce,color}});if(this.disposed||generation!==this.sequence)return;this.accept(session);if(session.last_answer?.index===previous.index)playSound(session.last_answer.correct?'correct':'incorrect');if(session.finished)await this.completed();else this.render();}
  catch{if(!this.disposed&&generation===this.sequence)await this.recover({afterAnswer:true});}
  finally{if(!this.disposed&&generation===this.sequence)this.setBusy(false);}
 }
 async finish(){
  if(this.busy||this.disposed||!this.session||this.session.finished)return;this.setBusy(true);this.error='';const generation=this.sequence;
  try{const session=await this.request(endpoint+'/'+this.session.id+'/finish',{method:'POST',body:{}});if(this.disposed||generation!==this.sequence)return;this.accept(session);await this.completed();}
  catch(error){if(!this.disposed&&generation===this.sequence&&error.status!==409){this.error=error.message;clearInterval(this.timer);this.render();}}
  finally{if(!this.disposed&&generation===this.sequence)this.setBusy(false);}
 }
 async completed(){
  clearInterval(this.timer);playSound(this.session.result?.record_eligible?'complete':'incorrect');const generation=this.sequence;
  try{const data=await this.request(endpoint+'/history');if(!this.disposed&&generation===this.sequence)this.data=data;}
  catch(error){if(!this.disposed&&generation===this.sequence)this.error=error.message;}
  finally{if(!this.disposed&&generation===this.sequence)this.render();}
 }
}
