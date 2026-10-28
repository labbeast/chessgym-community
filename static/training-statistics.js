import {api,esc} from './api.js';
import {t,locale} from './i18n.js';
import {TRAINING_HISTORY_TOOLS,historyDuration} from './training-history.js';
import {createTrainingPanel} from './exercise-tabs.js';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const number=value=>finite(value)?value.toLocaleString(locale(),{maximumFractionDigits:1}):'—';
const percent=value=>finite(value)?number(value)+' %':'—';
const measured=count=>t(count===1?'{count} séance mesurée':'{count} séances mesurées',{count:number(count)});
const card=(label,value,note='')=>`<div class="training-statistics-card"><dt>${esc(t(label))}</dt><dd>${esc(value)}</dd>${note?`<small>${esc(note)}</small>`:''}</div>`;

export function trainingStatisticsHtml(data){
 const {tool,counts={},outcomes={},duration={},metrics={}}=data;
 const ratings=tool==='blindfold'&&data.profiles?`<dl class="training-statistics-grid">${['opening','positions'].map(mode=>{const p=data.profiles[mode];return p?card(mode==='opening'?'Ouvertures':'Positions',number(p.rating),p.provisional?t('Cote provisoire · {count} exercices classés',{count:p.rated_count}):t('{count} exercices classés',{count:p.rated_count})):'';}).join('')}</dl>`:'';
 if(!counts.total)return ratings+`<div class="training-statistics-empty"><strong>${esc(t('Aucune statistique enregistrée'))}</strong><p>${esc(t('Tes séances enregistrées alimenteront ce bilan.'))}</p></div>`;
 const summary=card('Séances enregistrées',number(counts.total))+card('Terminées',number(counts.completed))+card('En cours',number(counts.active))+card('Interrompues',number(counts.interrupted));
 let performance='';
 if(tool==='computer')performance=card('Victoires',number(outcomes.success))+card('Nulles',number(outcomes.draw))+card('Défaites',number(outcomes.failure));
 if(tool==='guess')performance=card('Coups évalués',number(metrics.attempts))+card('Coups de la partie retrouvés',number(metrics.exact_count))+card('Points obtenus',finite(metrics.score)&&finite(metrics.maximum)?`${number(metrics.score)} / ${number(metrics.maximum)}`:'—')+card('Score moyen par coup',percent(metrics.accuracy));
 if(tool==='coordinates'||tool==='color')performance=card('Réponses correctes',number(metrics.score))+card('Erreurs',number(metrics.errors))+card('Précision globale',percent(metrics.accuracy))+card('Meilleur score de séance',number(metrics.best_score));
 if(tool==='blindfold'){
  const samples=key=>measured(metrics[key]);
  performance=card('Exercices réussis',number(outcomes.success))+card('Exercices échoués',number(outcomes.failure))+card('Erreurs',number(metrics.errors));
  if(metrics.solve_success_count)performance+=card('Solutions trouvées',`${number(metrics.solve_success)} / ${number(metrics.solve_success_count)}`);
  if(metrics.reconstruction_success_count)performance+=card('Positions reconstruites',`${number(metrics.reconstruction_success)} / ${number(metrics.reconstruction_success_count)}`);
  if(metrics.accuracy_count)performance+=card('Précision moyenne de reconstruction',percent(metrics.accuracy),samples('accuracy_count'));
 }
 const durationNote=measured(duration.known_count)+' · '+t('{count} sans durée enregistrée',{count:number(duration.unknown_count)});
 return `${ratings}<p class="training-statistics-intro">${esc(t('Tout l’historique enregistré de ce mode.'))}</p><dl class="training-statistics-grid">${summary}</dl><section class="training-statistics-performance"><h3>${esc(t('Résultats des séances terminées'))}</h3>${counts.completed?`<dl class="training-statistics-grid">${performance}${card('Durée mesurée cumulée',historyDuration(duration.total_ms),durationNote)}</dl>`:`<p class="training-statistics-empty">${esc(t('Termine une séance pour afficher tes résultats.'))}</p>`}</section><p class="training-statistics-footnote">${esc(t('Les séances en cours ou interrompues sont exclues des résultats. Les mesures absentes restent indiquées par —.'))}</p>`;
}

export class TrainingStatisticsView{
 constructor(host,{tool,request=api}={}){Object.assign(this,{host,tool,request});this.disposed=false;this.sequence=0;this.controller=null;this.data=null;this.error='';this.loading=false;}
 dispose(){if(this.disposed)return;this.disposed=true;this.sequence++;this.controller?.abort();}
 async load(){
  if(this.disposed)return;this.loading=true;this.error='';const sequence=++this.sequence;this.controller?.abort();const controller=this.controller=new AbortController();this.render();
  try{
   const data=await this.request('/api/training/history/statistics?'+new URLSearchParams({tool:this.tool}),{signal:controller.signal});
   if(this.disposed||sequence!==this.sequence)return;this.data=data;this.loading=false;this.render();
  }catch(error){if(this.disposed||sequence!==this.sequence||error.name==='AbortError')return;this.loading=false;this.error=error.message||String(error);this.render();}
 }
 render(){
  if(this.disposed)return;
  this.host.innerHTML=this.loading?`<p class="training-statistics-empty" role="status">${esc(t('Chargement…'))}</p>`:this.error?`<div class="training-statistics-empty" role="alert"><strong>${esc(t('Statistiques indisponibles'))}</strong><p>${esc(this.error)}</p><button type="button" data-statistics-retry>${esc(t('Réessayer'))}</button></div>`:this.data?trainingStatisticsHtml(this.data):'';
  this.host.querySelector('[data-statistics-retry]')?.addEventListener('click',()=>this.load());
 }
}

export function openTrainingStatistics({host=null,tool,request=api,title=null,extraHtml=''}={}){
 const dialog=host?createTrainingPanel(host,'statistics'):document.createElement('dialog');dialog.className='wide training-statistics-dialog';
 const heading=title||t('Statistiques')+' · '+t(TRAINING_HISTORY_TOOLS[tool]||'Entraînement');
 dialog.innerHTML=`<div class="dialog-form"><div class="dialog-head"><h2>${esc(heading)}</h2><button type="button" data-statistics-close aria-label="${esc(t('Fermer'))}">×</button></div><div data-statistics-host></div>${extraHtml}<div class="dialog-actions"><button type="button" data-statistics-close>${esc(t('Fermer'))}</button></div></div>`;
 const view=new TrainingStatisticsView(dialog.querySelector('[data-statistics-host]'),{tool,request});
 dialog.querySelectorAll('[data-statistics-close]').forEach(button=>button.onclick=()=>dialog.close());
 dialog.addEventListener('close',()=>{view.dispose();dialog.remove();},{once:true});
 if(!host){document.body.append(dialog);dialog.showModal();}void view.load();return dialog;
}
