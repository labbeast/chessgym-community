import {listSearchHtml,listSearchPanelHtml,listChipsHtml,listPaginationHtml,listAdvancedHtml,listPageSize,readListState,writeListState,captureListScroll,restoreListScroll,markListDirty} from './list-view.js';
import {api,esc,option,notice} from './api.js';
import {t,locale} from './i18n.js';
import {createTrainingPanel} from './exercise-tabs.js';

const endpoint='/api/training/history';
export const TRAINING_HISTORY_TOOLS=Object.freeze({review:'Révisions',reading:'Lecture',puzzles:'Puzzles',storm:'Puzzle Storm',guess:'Deviner le coup',coordinates:'Coordonnées',blindfold:'Puzzles à l’aveugle',color:'Couleur des cases',computer:'Contre l’ordinateur'});
const statuses={all:'Tous les états',completed:'Terminé',active:'En cours',interrupted:'Interrompu'};
const outcomes={all:'Tous les résultats',success:'Réussi',failure:'Échoué',mixed:'Résultat partiel',draw:'Nulle',unknown:'Sans résultat'};
const units={reading_session:'Visite',answer:'Réponse',attempt:'Tentative',session:'Séance',game:'Partie',visit:'Visite'};
const detailLabels={exercise_rating:'Difficulté Blindfold',rating_delta:'Variation de cote',rated:'Exercice classé',rating_eligible:'Admissible au classement',points:'Points gagnés',completed:'Terminé',proposed:'Position proposée',misplaced:'Pièces mal placées',orientation:'Orientation',input:'Saisie',hide_prompt:'Liste des coups masquée',max_moves:'Nombre maximal de coups',max_pieces:'Nombre maximal de pièces',whole_game:'Partie entière',duration:'Durée de la séance',exact_count:'Coups de la partie retrouvés',exact:'Coup de la partie retrouvé',hint:'Indice',interval_days:'Intervalle de révision (jours)',proposed_grade:'Évaluation proposée',requested_grade:'Évaluation choisie',first_ply:'Premier demi-coup',last_ply:'Dernier demi-coup',ply:'Demi-coup',success:'Exercice réussi',abandoned:'Séance interrompue',failed:'Erreur enregistrée',solved_rating:'Difficulté cumulée',configuration:'Sélection',type:'Type d’exercice',answered:'Réponses données',record:'Record',mode:'Mode',side:'Camp',base_name:'Base',grade:'Évaluation de révision',errors:'Erreurs',hints:'Aides',assisted:'Avec assistance',accuracy:'Précision',rating:'Classement',rating_before:'Classement avant',rating_after:'Classement après',record_eligible:'Admissible au record',solve_success:'Solution trouvée',reconstruction_success:'Position reconstruite',reconstruction_skipped:'Reconstruction non effectuée',preparation_ms:'Temps de visualisation',total_elapsed_ms:'Temps total',solve_elapsed_ms:'Résolution',reconstruction_elapsed_ms:'Reconstruction',white:'Blancs',black:'Noirs',result:'Résultat',reason:'Fin de la partie',time_control:'Cadence',provider:'Moteur',plies:'Demi-coups',best_combo:'Meilleure série',expected:'Réponse attendue',answer:'Réponse donnée',score:'Points',maximum:'Maximum',puzzle_id:'Puzzle',entry_title:'Exercice',entry_name:'Partie',starting_ply:'Coup de départ',ending_ply:'Dernier coup',start_ply:'Coup de départ',end_ply:'Dernier coup',moves_read:'Coups parcourus',progress_before:'Progression avant',progress_after:'Progression après',new_moves:'Nouveaux coups lus',successes:'Réussites',failures:'Échecs',correct:'Réponses correctes',wrong:'Réponses incorrectes',questions:'Questions',duration_seconds:'Durée de la séance',target:'Objectif',reconstruction_errors:'Erreurs de reconstruction',matches:'Pièces bien placées',total_pieces:'Pièces à placer',missing:'Pièces manquantes',extra:'Pièces en trop',missing_pieces:'Pièces manquantes',extra_pieces:'Pièces en trop',mistakes:'Erreurs',attempts:'Tentatives',moves:'Coups',solved:'Résolus',count:'Nombre',opening:'Ouverture',themes:'Thèmes',set_name:'Sélection',set_kind:'Type de sélection',game_title:'Partie',bookmarked_ply:'Signet',first_path:'Premier coup',last_path:'Dernier coup',read_moves:'Signet (demi-coups)',total_moves:'Longueur de la partie (demi-coups)',progress:'Progression de la partie',duration_ms:'Durée',elapsed_ms:'Durée écoulée',source:'Origine',completion:'Progression',result_label:'Résultat'};
const valueLabels={positions:'Positions',white:'Blancs',black:'Noirs',mixed:'Mixte',both:'Les deux camps',success:'Réussi',failure:'Échoué',unknown:'Non disponible',draw:'Nulle',completed:'Terminé',active:'En cours',interrupted:'Interrompu',again:'Manqué',hard:'Difficile',good:'Bien',easy:'Facile',mastered:'Maîtrisé',coordinates:'Coordonnées',notation:'Notation',opening:'Ouverture',endgame:'Finale',reconstruction:'Reconstruction',puzzle:'Puzzle',game:'Partie',classic:'Classique',standard:'Standard',custom:'Personnalisée',unlimited:'Sans limite',checkmate:'Échec et mat',stalemate:'Pat',resignation:'Abandon',timeout:'Temps écoulé',timeout_insufficient_material:'Temps écoulé · matériel insuffisant',insufficient_material:'Matériel insuffisant',fifty_moves:'Règle des 50 coups',threefold_repetition:'Triple répétition',seventyfive_moves:'Règle des 75 coups',fivefold_repetition:'Quintuple répétition'};
Object.assign(detailLabels,{delta_cp:'Écart cumulé',threshold_cp:'Écart pour gagner',thinking_ms:'Temps de réflexion',historical_ms:'Temps du joueur',preparation_ms:'Temps de visualisation',minimum_time_seconds:'Temps minimum par décision',total_topup_ms:'Complément de temps'});
Object.assign(valueLabels,{mix:'Guess the Move Mix',positions:'Positions',win:'Victoire',loss:'Défaite'});
const pieceGlyphs={K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};
const booleanFields=new Set(['rated','rating_eligible','assisted','record_eligible','solve_success','reconstruction_success','reconstruction_skipped','hint','exact','hide_prompt','whole_game','abandoned','success','coordinates','failed','completed']);
const finite=value=>value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
const number=value=>finite(value)?Number(value).toLocaleString(locale(),{maximumFractionDigits:2}):'—';
const toolLabel=value=>t(TRAINING_HISTORY_TOOLS[value]||'Entraînement');
const labelFor=key=>t(detailLabels[key]||key.replace(/_/g,' '));
const scalar=value=>typeof value==='boolean'?t(value?'Oui':'Non'):typeof value==='number'?number(value):String(value??'—');
const timeZone=()=>{try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';}catch{return 'UTC';}};

export function historyDuration(milliseconds){
 if(!finite(milliseconds))return '—';
 if(Number(milliseconds)>0&&Number(milliseconds)<1000)return number(Number(milliseconds)/1000)+' s';
 const seconds=Math.max(0,Math.round(Number(milliseconds)/1000)),hours=Math.floor(seconds/3600),minutes=Math.floor((seconds%3600)/60),rest=seconds%60;
 return hours?`${number(hours)} h ${number(minutes)} min`:minutes?`${number(minutes)} min ${number(rest)} s`:`${number(rest)} s`;
}
export function historyDate(value){
 if(!value)return '—';const date=new Date(value);
 return Number.isFinite(date.valueOf())?date.toLocaleString(locale(),{dateStyle:'medium',timeStyle:'short'}):'—';
}
function durationKind(value){return t(({active:'Temps actif',elapsed:'Durée écoulée',clock:'Temps joué à la pendule'})[value]||'Durée non mesurée');}
function detailValue(key,value){
 if(key==='minimum_time_seconds')return Number(value)===0?t('Temps historique'):historyDuration(Number(value)*1000);
 if(key.endsWith('_cp'))return finite(value)?(key==='delta_cp'&&Number(value)>0?'+':'')+number(Number(value)/100)+' '+t('pion'):'—';
 if(key.endsWith('_ms'))return historyDuration(value);
 if(key.endsWith('_at'))return historyDate(value);
 if(key==='accuracy'||key==='progress'||key.startsWith('progress_')||key==='completion')return finite(value)?number(value)+' %':'—';
 if(booleanFields.has(key)&&value!=null)return t(value?'Oui':'Non');
 if(key==='time_control'&&typeof value==='string'){const cadence=value.match(/^(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?$/);return cadence?`${number(Number(cadence[1])/60)} + ${number(Number(cadence[2]||0))}`:value==='-'?t('Sans limite'):value;}
 if(key==='duration_seconds'||key==='duration')return historyDuration(Number(value)*1000);
 if(['grade','proposed_grade','requested_grade'].includes(key)&&finite(value))return t(({0:'Manqué',1:'Difficile',2:'Bien',3:'Facile'})[value]||String(value));
 if(['answer','expected'].includes(key)&&['white','black'].includes(value))return t(valueLabels[value]);
 if(['mode','side','grade','reason','set_kind','orientation','input'].includes(key)&&typeof value==='string')return t(valueLabels[value]||value);
 if(Array.isArray(value))return value.map(scalar).join(', ');
 return scalar(value);
}
function factHtml(key,value){
 if(value==null||key==='path'||key.endsWith('_path')||key==='id'||key.endsWith('_id')&&key!=='puzzle_id'||['solution_index','clock_started'].includes(key))return '';
 let display;
 if(['expected','proposed'].includes(key)&&value&&typeof value==='object'&&!Array.isArray(value)){
  display=Object.entries(value).filter(([square,piece])=>/^[a-h][1-8]$/.test(square)&&Object.hasOwn(pieceGlyphs,piece)).sort(([a],[b])=>a.localeCompare(b)).map(([square,piece])=>`${pieceGlyphs[piece]} ${square}`).join(' · ')||t('Aucune pièce');
 }else if(['missing','misplaced','missing_pieces','extra_pieces'].includes(key)&&Array.isArray(value)){
  display=value.map(item=>typeof item==='object'&&item?`${pieceGlyphs[item.piece]||item.piece||''} ${item.square||''}${Object.hasOwn(item,'expected')?' ('+t('attendu : {piece}',{piece:pieceGlyphs[item.expected]||t('vide')})+')':''}`:scalar(item)).join(' · ')||t('Aucune');
 }else{
  if(typeof value==='object'&&!Array.isArray(value)||Array.isArray(value)&&value.some(item=>item&&typeof item==='object'))return '';
  display=detailValue(key,value);
 }
 return `<div><dt>${esc(labelFor(key))}</dt><dd>${esc(display)}</dd></div>`;
}
function countText(item){
 if(!finite(item.completed_count))return '';
 const count=number(item.completed_count),total=finite(item.total_count)?number(item.total_count):null;
 const unit=item.tool==='reading'?'coups lus':item.tool==='computer'?'demi-coups':item.tool==='guess'?'coups':item.tool==='storm'?'puzzles':'réponses';
 return t(total?'{count} / {total} '+unit:'{count} '+unit,{count,total});
}
function resultHtml(item){
 const status=Object.hasOwn(statuses,item.status)?item.status:'completed',outcome=Object.hasOwn(outcomes,item.outcome)?item.outcome:'unknown';
 const grade=item.tool==='review'&&(item.metrics?.grade??item.score);
 const gradeLabel=finite(grade)&&grade!==false?t(({0:'Manqué',1:'Difficile',2:'Bien',3:'Facile'})[grade]||''):'';
 const computerResult=(item.tool==='computer'||item.metrics?.mode==='mix')&&status==='completed'?({success:'Victoire',failure:'Défaite',draw:'Nulle'})[outcome]:null;
 const text=computerResult||gradeLabel||(status==='active'||status==='interrupted'?statuses[status]:outcome==='unknown'?statuses[status]:outcomes[outcome]);
 const style=status==='active'||status==='interrupted'?status:outcome;
 let score='';
 if(item.tool!=='review'&&finite(item.score))score=finite(item.maximum)?t('{score} / {maximum} points',{score:number(item.score),maximum:number(item.maximum)}):t('{score} points',{score:number(item.score)});
 const accuracy=finite(item.metrics?.accuracy)?t('{accuracy} % de précision',{accuracy:number(item.metrics.accuracy)}):'';
 const delta=item.metrics?.mode==='mix'&&finite(item.metrics.delta_cp)?t('Écart cumulé : {delta}',{delta:detailValue('delta_cp',item.metrics.delta_cp)}):'';
 const metrics=[score,accuracy,delta].filter(Boolean);
 return `<span class="training-history-result ${esc(style)}">${esc(t(text))}</span>${metrics.map(value=>`<small>${esc(value)}</small>`).join('')}`;
}
export function trainingHistoryRowsHtml(items=[],{onOpen=false,selected=null}={}){
 return items.map((item,index)=>`<tr${item.key===selected?' class="selected"':''}><td class="training-history-date" data-label="${esc(t('Date'))}"><time datetime="${esc(item.started_at||'')}">${esc(historyDate(item.started_at))}</time><small>${esc(t(units[item.unit]||'Séance'))}</small></td><td class="training-history-activity" data-label="${esc(t('Activité'))}"><strong>${esc(item.title||toolLabel(item.tool))}</strong><small>${esc(toolLabel(item.tool))}${item.metrics?.base_name?' · '+esc(item.metrics.base_name):''}</small>${countText(item)?`<small>${esc(countText(item))}</small>`:''}${item.tool==='reading'&&finite(item.metrics?.progress)?`<small>${esc(t('Progression de la partie : {progress} %',{progress:number(item.metrics.progress)}))}</small>`:''}</td><td class="training-history-duration" data-label="${esc(t('Durée'))}"><span title="${esc(durationKind(finite(item.duration_ms)?item.duration_kind:'unknown'))}">${esc(historyDuration(item.duration_ms))}</span></td><td class="training-history-outcome" data-label="${esc(t('Résultat'))}">${resultHtml(item)}</td><td class="training-history-actions"><button type="button" data-training-detail="${index}" aria-label="${esc(t('Détails de {title}',{title:item.title||toolLabel(item.tool)}))}" aria-expanded="${item.key===selected?'true':'false'}">${esc(t('Détails'))}</button>${onOpen&&item.open_available!==false?`<button type="button" data-training-open="${index}">${esc(t('Consulter'))}</button>`:''}</td></tr>`).join('');
}
export function trainingHistoryPaginationHtml({offset=0,limit=25,total=0}={}){
 return listPaginationHtml({offset,limit,total,count:Math.min(limit,Math.max(0,total-offset)),previous:`data-training-page="${Math.max(0,offset-limit)}"`,next:`data-training-page="${offset+limit}"`,size:'data-history-size',className:'training-history-pagination'});
}
export function trainingHistoryDetailHtml(payload){
 const item=payload.item||{},details=payload.details||{},events=payload.events||[],facts=Object.entries(details).filter(([key])=>!['event_count','events_truncated'].includes(key)).map(([key,value])=>factHtml(key,value)).join('');
 const truncated=payload.events_truncated||details.events_truncated,eventCount=payload.event_count??details.event_count??events.length;
 return `<section class="training-history-detail" aria-label="${esc(t('Détails de l’activité'))}"><header><div><span class="eyebrow">${esc(toolLabel(item.tool))}</span><h2>${esc(item.title||t('Détails de l’activité'))}</h2></div><button type="button" data-training-close-detail aria-label="${esc(t('Fermer les détails'))}">×</button></header><div class="training-history-detail-summary"><div><small>${esc(t('Début'))}</small><strong>${esc(historyDate(item.started_at))}</strong></div><div><small>${esc(t('Fin'))}</small><strong>${esc(historyDate(item.finished_at))}</strong></div><div><small>${esc(durationKind(finite(item.duration_ms)?item.duration_kind:'unknown'))}</small><strong>${esc(historyDuration(item.duration_ms))}</strong></div><div>${resultHtml(item)}</div></div>${facts?`<dl class="training-history-facts">${facts}</dl>`:''}${events.length?`<h3>${esc(t('Déroulement'))} <small>${esc(number(eventCount))}</small></h3><div class="training-history-events-wrap"><table class="training-history-events"><thead><tr><th scope="col">${esc(t('Moment'))}</th><th scope="col">${esc(t('Action'))}</th><th scope="col">${esc(t('Résultat'))}</th><th scope="col">${esc(t('Durée'))}</th><th scope="col">${esc(t('Précisions'))}</th></tr></thead><tbody>${events.map((event,index)=>`<tr><td data-label="${esc(t('Moment'))}">${esc(event.at?historyDate(event.at):t('Étape {number}',{number:index+1}))}</td><td data-label="${esc(t('Action'))}">${esc(event.action||'—')}</td><td data-label="${esc(t('Résultat'))}"><span class="training-history-result ${['success','failure','mixed','draw'].includes(event.result)?event.result:'unknown'}">${esc(t(outcomes[event.result]||'Sans résultat'))}</span></td><td data-label="${esc(t('Durée'))}">${esc(historyDuration(event.duration_ms))}</td><td class="training-history-event-facts"><dl>${Object.entries(event.details||{}).map(([key,value])=>factHtml(key,value)).join('')}</dl></td></tr>`).join('')}</tbody></table></div>${truncated?`<div class="training-history-event-more"><span class="hint">${esc(t('{count} actions affichées sur {total}.',{count:number(events.length),total:number(eventCount)}))}</span><button type="button" data-training-events-more>${esc(t('Afficher la suite'))}</button></div>`:''}`:`<p class="hint">${esc(t('Aucune action détaillée enregistrée pour cette activité.'))}</p>`}</section>`;
}

// Every tool uses this view. It reads historical data only: opening a history
// never starts, completes or resumes a training session.
export class TrainingHistoryView {
 constructor(host,{tool=null,tools=null,onOpen=null,request=api,embedded=false,title=null,stateKey=null}={}){
  Object.assign(this,{host,onOpen,request,embedded,title});
  this.tools=Array.isArray(tools)?tools.filter(value=>Object.hasOwn(TRAINING_HISTORY_TOOLS,value)):null;
  this.lockedTool=!this.tools&&Object.hasOwn(TRAINING_HISTORY_TOOLS,tool)?tool:null;
  this.filters={tool:this.lockedTool||this.tools?.includes(tool)&&tool||this.tools?.[0]||'all',status:'all',outcome:'all',date_from:'',date_to:'',q:''};
  this.stateKey=stateKey||(host?.ownerDocument?'history:'+(this.lockedTool||this.tools?.join(',')||'all'):null);const saved=readListState(this.stateKey);if(saved.filters)this.filters={...this.filters,...saved.filters};if(this.lockedTool)this.filters.tool=this.lockedTool;this.draft={...this.filters,...saved.draft};this.sort=saved.sort||'date';this.descending=saved.descending??true;this.advancedOpen=!!saved.advancedOpen;this.searchOpen=!!saved.searchOpen;this.restoreScroll=saved.scroll;
  this.offset=saved.offset||0;this.limit=listPageSize(saved.limit||25);this.total=0;this.items=[];this.disposed=false;this.loading=false;this.error='';this.sequence=0;this.detailSequence=0;this.detail=null;this.detailKey=null;this.detailLoading=false;this.eventLoading=false;this.controller=null;this.detailController=null;this.actionBusy=false;
 }
 dispose(){
  if(this.disposed)return;writeListState(this.stateKey,{filters:this.filters,draft:this.draft,sort:this.sort,descending:this.descending,offset:this.offset,limit:this.limit,advancedOpen:this.advancedOpen,searchOpen:!!this.host.querySelector('[data-list-search-menu]')?.open,scroll:captureListScroll()});clearTimeout(this.searchTimer);this.disposed=true;this.sequence++;this.detailSequence++;this.controller?.abort();this.detailController?.abort();this.host.classList.remove('training-history');
 }
 query(){
  const params=new URLSearchParams({...this.filters,time_zone:timeZone(),offset:this.offset,limit:this.limit,sort:this.sort,descending:this.descending});
  for(const [key,value] of [...params])if(value===''||value==='all')params.delete(key);
  return endpoint+'?'+params.toString();
 }
 async load(offset=this.offset){
  if(this.disposed)return;
  clearTimeout(this.searchTimer);this.offset=Math.max(0,Number(offset)||0);this.error='';this.loading=true;this.clearDetail();
  const sequence=++this.sequence;this.controller?.abort();const controller=this.controller=new AbortController();this.render();
  try{
   const result=await this.request(this.query(),{signal:controller.signal});if(this.disposed||sequence!==this.sequence)return;
   this.items=result.items||[];this.total=Math.max(0,Number(result.total)||0);this.limit=Number(result.limit)||this.limit;this.loading=false;
   if(this.total>0&&this.offset>=this.total)return this.load(Math.floor((this.total-1)/this.limit)*this.limit);
   this.render();if(this.restoreScroll!=null){restoreListScroll(this.host,this.restoreScroll);this.restoreScroll=null;}
  }catch(error){if(this.disposed||sequence!==this.sequence||error.name==='AbortError')return;this.loading=false;this.error=error.message||String(error);this.items=[];this.total=0;this.render();}
 }
 clearDetail(){this.detailSequence++;this.detailController?.abort();this.detailController=null;this.detail=null;this.detailKey=null;this.detailLoading=false;this.eventLoading=false;}
 async setFilters(values){
  if(this.disposed)return;
  const next={...this.filters,...values};
  if(next.date_from&&next.date_to&&next.date_from>next.date_to){this.error=t('La date de début doit précéder la date de fin.');this.showError();return;}
  if(this.lockedTool)next.tool=this.lockedTool;
  else if(this.tools&&!this.tools.includes(next.tool))next.tool=this.tools[0];
  else if(!this.tools&&!Object.hasOwn(TRAINING_HISTORY_TOOLS,next.tool))next.tool='all';
  if(!Object.hasOwn(statuses,next.status))next.status='all';if(!Object.hasOwn(outcomes,next.outcome))next.outcome='all';
  next.q=String(next.q||'').trim().slice(0,200);this.filters=next;Object.assign(this.draft,values);return this.load(0);
 }
 filterHtml(){
  const f=this.draft,select=(name,label,options)=>`<label>${esc(t(label))}<select data-training-filter="${name}">${Object.entries(options).map(([value,text])=>option(value,t(text),f[name])).join('')}</select></label>`;
  const tools=this.tools?Object.fromEntries(this.tools.map(key=>[key,TRAINING_HISTORY_TOOLS[key]])):{all:'Tous les outils',...TRAINING_HISTORY_TOOLS};
  return listSearchPanelHtml(`<form class="training-history-filters" role="search" aria-label="${esc(t('Filtrer l’historique'))}"><div class="list-toolbar">${listSearchHtml({value:f.q,placeholder:'Partie, exercice, base…',attributes:'data-training-filter="q"'})}${this.lockedTool?'':select('tool','Outil',tools)}${select('status','État',statuses)}${select('outcome','Résultat',outcomes)}<label>${esc(t('Trier par'))}<select data-history-sort>${[['date','Date'],['duration','Durée'],['activity','Activité']].map(([key,label])=>option(key,t(label),this.sort)).join('')}</select></label><button type="button" data-history-direction>${esc(t(this.descending?'↓ Décroissant':'↑ Croissant'))}</button><button type="button" data-training-reset>${esc(t('Réinitialiser'))}</button></div>${listAdvancedHtml(`<label>${esc(t('Du'))}<input data-training-filter="date_from" type="date" value="${esc(f.date_from)}"></label><label>${esc(t('Au'))}<input data-training-filter="date_to" type="date" value="${esc(f.date_to)}"></label>`,{open:this.advancedOpen,count:['date_from','date_to'].filter(key=>this.filters[key]).length,actions:`<div class="list-actions"><button type="submit" data-training-apply class="primary">${esc(t('Appliquer'))}</button></div>`})}</form>`,{open:this.searchOpen})+listChipsHtml(this.chips());
 }
 chips(){const labels={q:'Rechercher',tool:'Outil',status:'État',outcome:'Résultat',date_from:'Date de début',date_to:'Date de fin'};return Object.entries(this.filters).filter(([key,value])=>value&&value!=='all').map(([key,value])=>({key,label:labels[key],value:['tool','status','outcome'].includes(key)?t(({tool:TRAINING_HISTORY_TOOLS,status:statuses,outcome:outcomes}[key]||{})[value]||value):value,locked:key==='tool'&&!!this.lockedTool}));}
 render(){
  const active=globalThis.document?.activeElement,focusKey=this.host.contains?.(active)?active?.dataset?.trainingFilter:null,start=active?.selectionStart,end=active?.selectionEnd;
  if(this.disposed)return;this.searchOpen=this.host.querySelector('[data-list-search-menu]')?.open??this.searchOpen;this.host.classList.add('training-history');
  this.host.innerHTML=`${this.embedded?'':`<header class="training-history-heading"><div><h1>${esc(this.title||t('Historique des entraînements'))}</h1><p>${esc(t('Retrouve tes activités, leur durée et leurs résultats.'))}</p></div><button type="button" data-training-refresh>${esc(t('Actualiser'))}</button></header>`}${this.filterHtml()}<p class="training-history-error" data-training-error role="alert"${this.error?'':' hidden'}>${esc(this.error)}</p><div class="training-history-results" aria-busy="${this.loading}">${this.loading?`<p class="training-history-empty" role="status">${esc(t('Chargement…'))}</p>`:this.items.length?`<div class="training-history-table-wrap"><table class="training-history-table list-table"><thead><tr><th scope="col">${esc(t('Date'))}</th><th scope="col">${esc(t('Activité'))}</th><th scope="col">${esc(t('Durée'))}</th><th scope="col">${esc(t('Résultat'))}</th><th scope="col"><span class="sr-only">${esc(t('Actions'))}</span></th></tr></thead><tbody>${trainingHistoryRowsHtml(this.items,{onOpen:!!this.onOpen,selected:this.detailKey})}</tbody></table></div>${trainingHistoryPaginationHtml(this)}`:`<div class="training-history-empty"><strong>${esc(t(this.error?'Historique indisponible':this.chips().filter(item=>!item.locked).length?'Aucune activité pour ces filtres':'Aucune activité enregistrée.'))}</strong><p>${esc(t(this.error?'Réessaie dans un instant.':'Tes entraînements enregistrés apparaîtront ici.'))}</p>${this.error?`<button type="button" data-training-refresh>${esc(t('Réessayer'))}</button>`:''}</div>`}</div><div data-training-detail-host></div><p class="training-history-footnote">${esc(t('Les durées non enregistrées sont indiquées par —. Une réponse de révision correspond à un exercice évalué.'))}</p>`;
  this.bind();this.renderDetail();markListDirty(this.host,['date_from','date_to'].some(key=>this.draft[key]!==this.filters[key]));if(focusKey){const input=this.host.querySelector('[data-training-filter="'+focusKey+'"]');input?.focus?.({preventScroll:true});if(start!=null&&input?.type==='search')input.setSelectionRange?.(start,end);}
 }
 bind(){
  const search=this.host.querySelector('[data-list-search-menu]');if(search)search.ontoggle=()=>this.searchOpen=search.open;
  this.host.querySelectorAll('[data-training-refresh]').forEach(button=>button.onclick=()=>this.load());
  const form=this.host.querySelector('.training-history-filters');form?.addEventListener('submit',event=>{event.preventDefault();void this.applyFields();});const details=this.host.querySelector('[data-list-advanced]');if(details)details.ontoggle=()=>this.advancedOpen=details.open;
  this.host.querySelector('[data-history-sort]')?.addEventListener('change',event=>{this.sort=event.target.value;void this.load(0);});this.host.querySelector('[data-history-direction]')?.addEventListener('click',()=>{this.descending=!this.descending;void this.load(0);});this.host.querySelector('[data-history-size]')?.addEventListener('change',event=>{this.limit=listPageSize(event.target.value);void this.load(0);});
  this.host.querySelectorAll('[data-list-clear]').forEach(button=>button.onclick=()=>{const key=button.dataset.listClear;this.draft[key]=['tool','status','outcome'].includes(key)?'all':'';void this.setFilters({[key]:this.draft[key]});});
  this.host.querySelector('[data-training-reset]')?.addEventListener('click',()=>{this.draft={};this.sort='date';this.descending=true;return this.setFilters({tool:this.lockedTool||this.tools?.[0]||'all',status:'all',outcome:'all',date_from:'',date_to:'',q:''});});
  this.host.querySelectorAll('[data-training-filter]').forEach(input=>{
   if(input.tagName==='SELECT')input.onchange=()=>this.setFilters({[input.dataset.trainingFilter]:input.value});
   input.oninput=()=>{const key=input.dataset.trainingFilter;this.draft[key]=input.value;if(key==='q'){clearTimeout(this.searchTimer);this.sequence++;this.controller?.abort();this.searchTimer=setTimeout(()=>void this.setFilters({q:this.draft.q}),250);}else markListDirty(this.host,true);};
   input.onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();if(input.dataset.trainingFilter==='q')this.setFilters({q:input.value});else this.applyFields();}};
  });
  this.host.querySelectorAll('[data-training-page]').forEach(button=>button.onclick=()=>this.load(Number(button.dataset.trainingPage)));
  this.host.querySelectorAll('[data-training-detail]').forEach(button=>button.onclick=()=>this.showDetail(this.items[Number(button.dataset.trainingDetail)]));
  this.host.querySelectorAll('[data-training-open]').forEach(button=>button.onclick=()=>this.open(this.items[Number(button.dataset.trainingOpen)]));
 }
 applyFields(){const values={};this.host.querySelectorAll('[data-training-filter]').forEach(input=>values[input.dataset.trainingFilter]=input.value);return this.setFilters(values);}
 showError(){const error=this.host.querySelector('[data-training-error]');if(error){error.textContent=this.error;error.hidden=!this.error;}}
 async detailFor(item,signal){return this.request(`${endpoint}/${encodeURIComponent(item.tool)}/${encodeURIComponent(item.id)}`,{signal});}
 async showDetail(item){
  if(!item||this.disposed)return;if(this.detailKey===item.key){this.clearDetail();this.render();return;}
  this.clearDetail();this.detailKey=item.key;this.detailLoading=true;this.error='';this.showError();
  const sequence=++this.detailSequence,listSequence=this.sequence,controller=this.detailController=new AbortController();this.render();
  try{const result=await this.detailFor(item,controller.signal);if(this.disposed||sequence!==this.detailSequence||listSequence!==this.sequence)return;this.detail=result;this.detailLoading=false;this.renderDetail();this.host.querySelector('[data-training-detail-host]')?.scrollIntoView?.({block:'nearest',behavior:'smooth'});}
  catch(error){if(this.disposed||sequence!==this.detailSequence||listSequence!==this.sequence||error.name==='AbortError')return;this.detailLoading=false;this.error=error.message||String(error);this.clearDetail();this.render();}
 }
 renderDetail(){
  if(this.disposed)return;const host=this.host.querySelector('[data-training-detail-host]');if(!host)return;
  const eventScroll=host.querySelector('.training-history-events-wrap')?.scrollTop;
  host.innerHTML=this.detailLoading?`<p class="training-history-empty" role="status">${esc(t('Chargement des détails…'))}</p>`:this.detail?trainingHistoryDetailHtml(this.detail):'';
  host.querySelector('[data-training-close-detail]')?.addEventListener('click',()=>{const index=this.items.findIndex(item=>item.key===this.detailKey);this.clearDetail();this.render();this.host.querySelector(`[data-training-detail="${index}"]`)?.focus();});
  if(eventScroll!=null){const events=host.querySelector('.training-history-events-wrap');if(events)events.scrollTop=eventScroll;}
  const more=host.querySelector('[data-training-events-more]');if(more){more.disabled=this.eventLoading;more.onclick=()=>this.loadMoreEvents();}
 }
 async loadMoreEvents(){
  if(this.disposed||this.eventLoading||!this.detail||this.detail.next_events_offset==null)return;
  const detail=this.detail,item=detail.item,offset=detail.next_events_offset,sequence=this.detailSequence,listSequence=this.sequence;
  this.eventLoading=true;this.error='';this.showError();this.renderDetail();
  try{
   const next=await this.request(`${endpoint}/${encodeURIComponent(item.tool)}/${encodeURIComponent(item.id)}?events_offset=${encodeURIComponent(offset)}&events_limit=100`,{signal:this.detailController?.signal});
   if(this.disposed||sequence!==this.detailSequence||listSequence!==this.sequence)return;
   this.detail={...next,events:[...(detail.events||[]),...(next.events||[])]};this.eventLoading=false;this.renderDetail();
  }catch(error){if(this.disposed||sequence!==this.detailSequence||listSequence!==this.sequence||error.name==='AbortError')return;this.eventLoading=false;this.error=error.message||String(error);this.showError();this.renderDetail();}
 }
 async open(item){
  if(this.disposed||this.actionBusy||!item||item.open_available===false||!this.onOpen)return;this.actionBusy=true;this.error='';this.showError();const sequence=this.sequence;
  try{const detail=this.detailKey===item.key&&this.detail?this.detail:await this.detailFor(item);if(this.disposed||sequence!==this.sequence)return;await this.onOpen(structuredClone(item),structuredClone(detail));}
  catch(error){if(!this.disposed&&sequence===this.sequence&&error.name!=='AbortError'){this.error=error.message||String(error);this.showError();}}
  finally{this.actionBusy=false;}
 }
}

export async function openTrainingHistory({host=null,tool=null,tools=null,onOpen=null,request=api,title=null}={}){
 const dialog=host?createTrainingPanel(host,'history'):document.createElement('dialog');dialog.className='wide training-history-dialog';
 const heading=title||t('Historique')+(tool?' · '+toolLabel(tool):'');
 dialog.innerHTML=`<div class="dialog-form"><div class="dialog-head"><h2>${esc(heading)}</h2><button type="button" data-history-dialog-close aria-label="${esc(t('Fermer'))}">×</button></div><div data-history-dialog-host></div><div class="dialog-actions"><button type="button" data-history-dialog-close>${esc(t('Fermer'))}</button></div></div>`;
 const view=new TrainingHistoryView(dialog.querySelector('[data-history-dialog-host]'),{tool,tools,request,embedded:true,onOpen:onOpen?async(item,detail)=>{dialog.close();try{await onOpen(item,detail);}catch(error){notice(error.message||String(error),true);}}:null});
 dialog.querySelectorAll('[data-history-dialog-close]').forEach(button=>button.onclick=()=>dialog.close());
 dialog.addEventListener('close',()=>{view.dispose();dialog.remove();},{once:true});
 if(!host){document.body.append(dialog);dialog.showModal();}void view.load();return dialog;
}
