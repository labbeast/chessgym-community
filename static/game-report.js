import {t,locale} from './i18n.js';
import {api,esc,option,field,modal,notice} from './api.js';
import {mainlineNodes} from './reading-progress.js';

export const REPORT_KINDS={inaccuracy:'Imprécision',mistake:'Erreur',blunder:'Gaffe'};
const number=value=>new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(value);
export const reportMove=f=>{const value=Number(String(f.fen||'').split(' ')[5]);return (value>0?value:Math.ceil(f.ply/2))+(f.side==='black'?'… ':'. ')+(f.san||'');};
export function reportTime(value){if(!Number.isFinite(value)||value<0)return null;if(value<60)return number(value)+' s';return Math.floor(value/60)+':'+String(Math.floor(value%60)).padStart(2,'0');}
export function sourceLineMatches(doc){
 if(!Array.isArray(doc?.analysis_source_line))return !doc?.analysis_dirty;
 const saved=doc.analysis_source_line,current=mainlineNodes(doc);
 return saved.length>0&&saved.length===current.length&&saved.every((node,index)=>node.path===current[index].path&&node.fen===current[index].fen);
}
export function reportMoments(report,side='all',all=false){
 const findings=(report?.findings||[]).filter(f=>side==='all'||f.side===side);
 if(all)return findings;
 const priorities=side==='all'?report?.summary?.priority_plies:report?.summary?.by_side?.[side]?.priority_plies;
 const order=new Map((priorities||[]).map((ply,index)=>[Number(ply),index]));
 const impact=f=>Number.isFinite(f.loss_win_pct)?f.loss_win_pct:f.mate_change?100:(Number(f.loss_cp)||0)/10;
 return [...findings].sort((a,b)=>{if(order.has(a.ply)||order.has(b.ply))return (order.get(a.ply)??Infinity)-(order.get(b.ply)??Infinity);return impact(b)-impact(a)||a.ply-b.ply;}).slice(0,5);
}
export function reportImpact(f){return Number.isFinite(f.loss_win_pct)?t('Impact : {value} points',{value:number(f.loss_win_pct)}):t(REPORT_KINDS[f.kind]||'À revoir');}
export function impactTimeline(findings,selected=null,totalPlies=null){
 if(!findings.length)return '';
 const maxPly=Math.max(1,Number(totalPlies)||0,...findings.map(f=>f.ply)),max=Math.max(1,...findings.map(f=>Number(f.loss_win_pct)||Number(f.loss_cp)/10||1));
 const marks=findings.map(f=>{const x=8+284*f.ply/maxPly,height=6+30*Math.min(1,(Number(f.loss_win_pct)||Number(f.loss_cp)/10||1)/max);return '<rect x="'+(x-2)+'" y="'+(42-height)+'" width="4" height="'+height+'" rx="2" class="'+(selected===f.ply?'is-selected':'')+'"/>';}).join('');
 return '<div class="report-impact"><svg viewBox="0 0 300 48" aria-hidden="true" focusable="false"><path d="M8 43H292"/>'+marks+'</svg><div class="report-impact-targets">'+findings.map(f=>'<button type="button" data-work-action="finding" data-ply="'+esc(f.ply)+'" style="left:'+Math.min(96,Math.max(4,100*f.ply/maxPly))+'%" aria-label="'+esc(t('Revoir {move} · {impact}',{move:reportMove(f),impact:reportImpact(f)}))+'" title="'+esc(reportMove(f)+' · '+reportImpact(f))+'"><span class="sr-only">'+esc(reportMove(f))+'</span></button>').join('')+'</div></div>';
}
export function repertoireCard(data,{loading=false,error='',color='white',blocked=false,suppressed=false}={}){
 const options='<details class="report-repertoire-options" '+(data?.status==='no_repertoire'?'open':'')+'><summary>'+esc(t('Changer'))+'</summary><div class="report-selects"><label>'+esc(t('Mon camp'))+'<select data-report-color>'+option('white',t('Blancs'),color)+option('black',t('Noirs'),color)+'</select></label><label>'+esc(t('Répertoire'))+'<select data-report-repertoire>'+option('',t('Répertoire principal'),data?.base_id??'')+(data?.choices||[]).map(b=>option(b.id,b.name+(b.primary?' · '+t('Principal'):''),data?.base_id)).join('')+'</select></label></div></details>';
 let body=loading&&!data?'<p class="report-hint" role="status">'+esc(t('Lecture du répertoire…'))+'</p>':error?'<p class="report-hint" role="status">'+esc(error)+'</p><button type="button" data-work-action="repertoire-reload">'+esc(t('Réessayer'))+'</button>':'';
 if(!loading&&!error&&data&&!suppressed){
  const exit=data.first_exit,known=Number(data.covered_plies)||0,total=Number(data.total_plies)||0;
  if(data.status==='inside')body+='<p class="report-repertoire-result">'+esc(t('Ta partie reste dans le répertoire.'))+'</p>';
  else if(exit){const label=exit.kind==='own_deviation'?t('Tu quittes ton répertoire'):exit.kind==='opponent_gap'?t('Réponse adverse non couverte'):t('Fin de la ligne préparée'),move=reportMove({...exit,side:String(exit.fen||'').split(' ')[1]==='b'?'black':'white'});body+='<details class="report-opening-details"><summary><span>'+esc(label)+'</span><strong>'+esc(move)+'</strong></summary><div><button type="button" class="report-exit-link" data-work-action="repertoire-exit" '+(blocked?'disabled':'')+'>'+esc(t('Voir la sortie'))+' <span aria-hidden="true">↗</span></button>';
   if(exit.kind==='own_deviation'&&exit.expected?.length)body+='<p class="report-hint">'+esc(t('Dans ton répertoire : {moves}',{moves:exit.expected.map(move=>move.san).join(', ')}))+'</p>';
   if(exit.transposition)body+='<p class="report-hint">'+esc(t('Une position connue est retrouvée plus tard.'))+'</p>';
   if(data.choices?.some(base=>Number(base.id)===Number(data.base_id)&&base.primary))body+='<button type="button" class="report-text-action" data-work-action="repertoire-build" '+(blocked?'disabled':'')+'>'+esc(t('Compléter mon répertoire'))+'</button>';
   body+='</div></details>';
  }else body+='<p class="report-hint">'+esc(t(data.message||'Choisis ton répertoire pour comparer cette partie.'))+'</p>';
  if(data.base_id&&total&&data.status==='inside')body+='<div class="report-coverage" aria-label="'+esc(t('{known} demi-coups couverts sur {total}',{known,total}))+'"><span style="width:'+Math.min(100,100*known/total)+'%"></span></div>';
 }
 if(suppressed)body='<p class="report-hint">'+esc(t('Recherche en cours sur l’échiquier.'))+'</p>';
 return '<section class="report-repertoire"><div class="report-card-heading"><div><span class="report-eyebrow">'+esc(t('Répertoire'))+'</span><strong>'+esc(data?.name||t('Ton ouverture'))+'</strong></div>'+options+'</div>'+body+'</section>';
}
export function momentCard(f,{index=0,total=1,disabled=false,revealed=false,hint=false,result=null,sessionActive=false,sessionOpen=false,verifying=false,canRetry=false,canCompare=false,canReset=false,score=()=>'',solution=()=>''}={}){
 const button=(action,label,extra='',locked=false)=>'<button type="button" data-work-action="'+action+'" data-ply="'+esc(f.ply)+'" '+(disabled||locked?'disabled':'')+' '+extra+'>'+esc(t(label))+'</button>';
 const elapsed=reportTime(f.elapsed),clock=reportTime(f.clock),done=['solved','revealed','reviewed'].includes(result?.outcome);
 let body='<article class="report-moment"><header class="report-moment-nav"><span>'+esc(t('Moment {current}/{total}',{current:index+1,total}))+'</span><div>'+button('moment-previous','Moment précédent','aria-label="'+esc(t('Moment précédent'))+'" class="report-icon-button"',index<=0).replace('>'+esc(t('Moment précédent'))+'</button>','><span aria-hidden="true">←</span></button>')+button('moment-next','Moment suivant','aria-label="'+esc(t('Moment suivant'))+'" class="report-icon-button"',index>=total-1).replace('>'+esc(t('Moment suivant'))+'</button>','><span aria-hidden="true">→</span></button>')+'</div></header><div class="report-moment-title"><button type="button" data-work-action="finding" data-ply="'+esc(f.ply)+'" '+(disabled?'disabled':'')+'>'+esc(reportMove(f))+'</button><span class="report-kind">'+esc(t(f.missed_opportunity?'Occasion manquée':REPORT_KINDS[f.kind]||'À revoir'))+'</span></div>';
 if(!sessionActive){body+='<p class="report-explanation">'+esc(t(f.explanation||'Cherche une meilleure décision dans cette position.'))+'</p>';if(elapsed||clock)body+='<p class="report-clock">'+esc([elapsed?t('{time} de réflexion',{time:elapsed}):'',clock?t('{time} à la pendule',{time:clock}):''].filter(Boolean).join(' · '))+'</p>';}
 if(result)body+='<p class="report-result" role="status">'+esc(t(({solved:'Bonne décision retrouvée.',missed:'Essaie encore sur l’échiquier.',revealed:'Solution consultée.',reviewed:'Moment revu.',cancelled:'Retour à la partie.'})[result.outcome]||'Recherche en cours sur l’échiquier.'))+'</p>';
 body+='<div class="report-practice-actions">'+button('retry-position',sessionActive?'Recherche en cours…':'Réessayer','class="primary"',!canRetry||sessionActive)+button('moment-hint','Indice','',sessionActive)+button('moment-solution','Solution','',sessionActive)+'</div>';
 if(hint&&!revealed&&!sessionActive)body+='<p class="report-hint report-reveal" role="status">'+esc(t(f.hint||'Repère les échecs, les prises et les menaces, puis vérifie la réponse adverse.'))+'</p>';
 if(revealed&&!sessionActive){body+='<div class="report-solution"><span class="report-eyebrow">'+esc(t('Alternative à étudier'))+'</span><strong>'+esc(f.best_san||'—')+'</strong><p>'+esc(solution(f,6))+'</p><div class="report-eval-comparison"><span>'+esc(t('Évaluation avant / après'))+'</span><b>'+esc(score(f.before))+' → '+esc(score(f.after))+'</b></div><p class="report-hint">'+esc(t('Évaluations du point de vue des Blancs.'))+'</p><div class="report-compare">'+button('compare-played','Coup joué','',!canCompare)+button('compare-alternative','Alternative','',!canCompare)+'</div></div>';}
 body+='<footer class="report-moment-footer">'+button('exercise',f.exercise_ids?.length?'Déjà dans mes exercices':'Créer un exercice','class="report-text-action"',sessionOpen)+button('verify-position',verifying?'Vérification…':f.verified?'Vérifié':'Vérifier','class="report-text-action"',verifying||f.verified||sessionOpen)+button('moment-reviewed',done?'Revu':'Marquer comme revu','class="report-text-action"',done||sessionActive)+(canReset&&(result||hint||revealed)?button('moment-reset-progress','Effacer le suivi de ce moment','class="report-text-action"',sessionOpen):'')+'</footer></article>';
 return body;
}

// Shared background-job plumbing stays with PlayedGamesPanel. Keeping the
// report renderer separate lets both views evolve without changing sync.
export function createGameAnalysisPanel(WorkPanel,{jobsHtml,analysisScore,solutionPreview,openExerciseEditor,integer,active,count}){
 return class GameAnalysisPanel extends WorkPanel{
  constructor(host,{board,getBases=()=>[],onLibraryChange=async()=>{},onOpenEntry=async()=>{},onReport=()=>{},onRetry=null,onCompare=null,onRepertoire=null,progressStore=null}={}){
   super(host);Object.assign(this,{board,getBases,onLibraryChange,onOpenEntry,onReport,onRetry,onCompare,onRepertoire,progressStore});
   this.entryId=board.doc.id;this.signature=board.doc.pgn;this.settings={time_ms:400,depth:null};this.data=null;this.reportFingerprint=null;this.loading=true;this.side='all';this.view='summary';this.allMoments=false;this.selectedPly=null;
   this.revealed=new Set();this.hints=new Set();this.results=new Map();this.sessionActive=false;this.sessionOpen=false;this.sessionSequence=0;this.verifying=null;this.repertoireData=null;this.repertoireColor='white';this.repertoireBase='';this.repertoireLoading=true;this.repertoireSequence=0;
   this.progressState=null;this.progressFingerprint=null;this.progressError='';this.unsubscribeProgress=progressStore?.subscribe(()=>this.applyProgress());this.render();this.ready=this.load();void this.loadRepertoire();
  }
  acceptReport(data){
   // A PGN reload clears display data, but review state still belongs to this fingerprint.
   if(this.reportFingerprint&&data.fingerprint!==this.reportFingerprint){this.revealed.clear();this.hints.clear();this.results.clear();}
   this.reportFingerprint=data.fingerprint;
   this.data=data;this.loading=false;this.error='';this.bindProgress(data.fingerprint);
   if(!this.sideChosen)this.side=['white','black'].includes(data.user_side)?data.user_side:'all';
   if(!this.settingsChosen)this.settings={...this.settings,...(data.settings||data.summary?.settings||{})};
   if(!this.repertoireColorChosen&&['white','black'].includes(data.user_side)&&data.user_side!==this.repertoireColor){this.repertoireColor=data.user_side;this.repertoireBase='';void this.loadRepertoire();}
   this.onReport(data);this.render();
  }
  async load(){
   if(this.disposed||!this.entryId||this.board.disposed)return;const sequence=++this.sequence;this.controller?.abort();const controller=new AbortController();this.controller=controller;clearTimeout(this.pollTimer);
   try{const data=await api('/api/game-analysis/'+this.entryId,{signal:controller.signal});if(this.disposed||sequence!==this.sequence||this.board.disposed||this.entryId!==this.board.doc.id)return;this.acceptReport(data);if(active(data.job))this.schedule(2000,()=>this.load());}
   catch(error){if(this.disposed||sequence!==this.sequence||error.name==='AbortError')return;this.loading=false;this.error=error.message;this.render();}
  }
  async loadRepertoire(){
   if(this.disposed||this.board.disposed)return;const sequence=++this.repertoireSequence;this.repertoireController?.abort();const controller=new AbortController();this.repertoireController=controller;this.repertoireLoading=true;this.repertoireError='';this.render();
   const query=new URLSearchParams({color:this.repertoireColor});if(this.repertoireBase)query.set('base_id',String(this.repertoireBase));
   try{const data=await api('/api/game-analysis/'+this.entryId+'/repertoire?'+query,{signal:controller.signal});if(this.disposed||sequence!==this.repertoireSequence||this.board.disposed||this.board.doc.id!==this.entryId)return;this.repertoireData=data;this.repertoireLoading=false;this.render();}
   catch(error){if(this.disposed||sequence!==this.repertoireSequence||error.name==='AbortError')return;this.repertoireLoading=false;this.repertoireError=error.message;this.render();}
  }
  acceptEvaluationDocument(source){
   // A position score changes the PGN comment, not the game covered by this report.
   if(!this.disposed&&this.signature===source.pgn)this.signature=this.board.doc.pgn;
  }
  update(){
   if(this.disposed)return;if(this.entryId!==this.board.doc.id||this.board.disposed){this.dispose();this.host.innerHTML='';return;}
   if(this.signature===this.board.doc.pgn){const matches=sourceLineMatches(this.board.doc);if(matches!==this.lastSourceMatch)this.render();return;}
   this.signature=this.board.doc.pgn;this.sequence++;this.controller?.abort();clearTimeout(this.pollTimer);clearTimeout(this.updateTimer);this.loading=true;this.data=null;this.onReport(null);this.render();this.updateTimer=setTimeout(()=>{void this.load();void this.loadRepertoire();},350);
  }
  bindProgress(fingerprint){if(!this.progressStore||!fingerprint)return;if(fingerprint!==this.progressFingerprint){this.progressFingerprint=fingerprint;this.progressError='';this.applyProgress();void this.progressStore.load(this.entryId,fingerprint);}else this.applyProgress();}
  applyProgress(){if(this.disposed||!this.progressStore||!this.progressFingerprint)return;this.progressState=this.progressStore.snapshot(this.entryId,this.progressFingerprint);const states=new Map(this.progressState.items.map(item=>[item.ply,item.state]));for(const ply of new Set([...this.results.keys(),...this.hints,...this.revealed,...states.keys()])){if(this.sessionActive&&ply===this.selectedPly)continue;const value=states.get(ply);if(value?.outcome)this.results.set(ply,{outcome:value.outcome,attempts:value.attempts,hinted:value.hint});else this.results.delete(ply);if(value?.hint)this.hints.add(ply);else this.hints.delete(ply);if(value?.revealed)this.revealed.add(ply);else this.revealed.delete(ply);}this.render();}
  saveProgress(ply){if(!this.progressStore||!this.data?.fingerprint)return;const result=this.results.get(ply);try{this.progressError='';this.progressStore.record(this.entryId,this.data.fingerprint,ply,{outcome:result?.outcome||null,attempts:result?.attempts||0,hint:this.hints.has(ply)||result?.hinted===true,revealed:this.revealed.has(ply)});}catch(error){this.progressError=error.message;this.render();}}
  progressHtml(){if(!this.progressStore||!this.progressFingerprint)return '';const info=this.progressState||{},error=this.progressError||info.error;const label=state=>[t(({reviewed:'Moment revu.',solved:'Bonne décision retrouvée.',revealed:'Solution consultée.',missed:'À retravailler',cancelled:'Retour à la partie.'})[state?.outcome]||'Sans suivi'),state?.hint?t('Indice consulté'):'',state?.revealed?t('Solution consultée.'):''].filter(Boolean).join(' · ');return '<section class="report-progress-status" aria-live="polite">'+(error?'<p class="report-warning">'+esc(error)+'</p>':(info.loading||!info.loaded&&!info.pending)?'<p class="report-hint">'+esc(t('Chargement du suivi…'))+'</p>':info.pending?'<p class="report-hint">'+esc(t('Suivi conservé sur cet appareil · synchronisation en attente.'))+'</p>':'<p class="report-hint">'+esc(t('Suivi enregistré dans ChessGym.'))+'</p>')+(error&&!info.sourceChanged?'<button type="button" data-work-action="progress-retry">'+esc(t('Réessayer la synchronisation du suivi'))+'</button>':'')+(info.conflicts||[]).map(item=>'<div class="report-progress-conflict"><strong>'+esc(t('Conflit au demi-coup {ply}',{ply:item.ply}))+'</strong><p>'+esc(t('Cet appareil'))+' : '+esc(label(item.local))+'</p><p>'+esc(t('Autre appareil'))+' : '+esc(item.remoteKnown?label(item.remote):t('À recharger'))+'</p><button type="button" data-work-action="progress-remote" data-ply="'+item.ply+'">'+esc(t('Garder le suivi du serveur'))+'</button><button type="button" data-work-action="progress-local" data-ply="'+item.ply+'">'+esc(t('Conserver mon suivi local'))+'</button></div>').join('')+'</section>';}
  moments(){return reportMoments(this.data,this.side,this.allMoments);}
  resetScroll(){const container=this.host.closest?.('.analysis-tool-content');if(container)container.scrollTop=0;}
  isBlocked(){return this.loading||this.busy||this.verifying!==null||!!this.progressState?.sourceChanged||!!this.progressState?.conflicts?.length||(this.progressStore&&!this.progressStore.ready)||this.data?.status==='stale'||this.data?.stale||!sourceLineMatches(this.board.doc);}
  render(){
   if(this.disposed)return;const data=this.data,running=active(data?.job),stale=data?.status==='stale'||data?.stale,summary=data?.summary,partial=summary&&count(summary.analysed_positions)<count(summary.total_positions),moments=this.moments(),all=reportMoments(data,this.side,true),ownSide=['white','black'].includes(data?.user_side)?data.user_side:null;
   this.lastSourceMatch=sourceLineMatches(this.board.doc);const blocked=this.isBlocked();if(!moments.some(f=>f.ply===this.selectedPly))this.selectedPly=moments[0]?.ply??null;const selected=moments.find(f=>f.ply===this.selectedPly),reviewed=moments.filter(f=>['solved','revealed','reviewed'].includes(this.results.get(f.ply)?.outcome)).length,exercises=new Set(all.flatMap(f=>f.exercise_ids||[])).size;
   let body='<header class="report-heading"><div><h2>'+esc(t('Bilan de partie'))+'</h2></div><div class="report-heading-actions"><button type="button" data-work-action="analyse" '+(this.busy||this.loading||running||this.sessionOpen||!this.lastSourceMatch?'disabled':'')+'>' +esc(this.busy?t('Ajout…'):running?t('Analyse en cours'):summary?t('Ré-analyser'):t('Analyser'))+'</button><button type="button" class="report-icon-button" data-work-action="analysis-settings" aria-label="'+esc(t('Réglages de l’analyse de partie'))+'" '+(this.busy?'disabled':'')+'><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6"/></svg></button></div></header>';
   if(!this.lastSourceMatch)body+='<p class="report-warning" role="status">'+esc(t('Le brouillon diffère de la partie enregistrée. Sauvegarde la partie pour mettre le bilan à jour.'))+'</p>';
   body+=this.progressHtml();body+=repertoireCard(this.repertoireData,{loading:this.repertoireLoading,error:this.repertoireError,color:this.repertoireColor,blocked:blocked||this.sessionActive,suppressed:this.sessionActive});
   if(this.loading)body+='<p class="report-hint" role="status">'+esc(t('Chargement du bilan…'))+'</p>';
   else if(this.error)body+='<p class="report-warning" role="status">'+esc(this.error)+'</p><button type="button" data-work-action="reload">'+esc(t('Réessayer'))+'</button>';
   if(stale)body+='<p class="report-warning">'+esc(t('La partie a changé depuis ce bilan. Relance l’analyse pour mettre les exercices à jour.'))+'</p>';
   if(data?.job&&(running||['error','cancelled'].includes(data.job.status)))body+=jobsHtml([data.job],{disabled:this.pendingJobs.size>0});
   if(this.feedback)body+='<p class="report-result" role="status">'+esc(this.feedback)+'</p>';
   if(summary){
    if(partial)body+='<p class="report-hint">'+esc(t('Bilan partiel · {done} / {total} positions analysées',{done:count(summary.analysed_positions),total:count(summary.total_positions)}))+'</p>';
    body+='<div class="report-overview"><div class="report-metrics"><div><strong>'+moments.length+'</strong><span>'+esc(t('À revoir'))+'</span></div><div><strong>'+reviewed+'</strong><span>'+esc(t(this.progressStore?'Revus':'Revus ici'))+'</span></div><div><strong>'+exercises+'</strong><span>'+esc(t('Exercices'))+'</span></div></div><label class="analysis-side">'+esc(t('Coups à revoir'))+'<select data-analysis-side>'+option('all',t('Les deux camps'),this.side)+option('white',ownSide==='white'?t('Mes coups · Blancs'):ownSide==='black'?t('Adversaire · Blancs'):t('Blancs'),this.side)+option('black',ownSide==='black'?t('Mes coups · Noirs'):ownSide==='white'?t('Adversaire · Noirs'):t('Noirs'),this.side)+'</select></label>'+(!ownSide?'<p class="report-hint">'+esc(t('Camp personnel non identifié. Choisis Blancs ou Noirs pour cibler le bilan.'))+'</p>':'')+'</div>';
    body+='<nav class="report-view-switch" aria-label="'+esc(t('Vue du bilan'))+'">'+[['summary','Résumé'],['moments','Moments']].map(([view,label])=>'<button type="button" data-work-action="report-view" data-view="'+view+'" aria-pressed="'+(this.view===view)+'">'+esc(t(label))+'</button>').join('')+'<button type="button" class="report-all" data-work-action="report-all" aria-pressed="'+this.allMoments+'">'+esc(this.allMoments?t('Priorités'):t('Tous ({count})',{count:all.length}))+'</button></nav>';
    if(this.view==='summary'){
     body+=impactTimeline(all,this.selectedPly,summary.moves);
     if(moments.length){body+='<div class="report-summary-title"><h3>'+esc(t('Tes moments à retenir'))+'</h3><span>'+esc(t('Par impact'))+'</span></div><div class="report-moment-list">'+moments.map((f,index)=>'<button type="button" data-work-action="finding" data-ply="'+esc(f.ply)+'" '+(blocked?'disabled':'')+'><span class="report-list-index">'+(index+1)+'</span><span><strong>'+esc(reportMove(f))+'</strong><small>'+esc(t(f.missed_opportunity?'Occasion manquée':REPORT_KINDS[f.kind]||'À revoir'))+'</small></span><span class="report-list-impact">'+esc(['solved','revealed','reviewed'].includes(this.results.get(f.ply)?.outcome)?t('Revu'):reportImpact(f))+'</span></button>').join('')+'</div><button type="button" class="primary report-start" data-work-action="start-moments" '+(blocked?'disabled':'')+'>'+esc(t('Revoir mes moments'))+'</button>';}
    }else if(selected)body+=momentCard(selected,{index:moments.indexOf(selected),total:moments.length,disabled:blocked,revealed:this.revealed.has(selected.ply),hint:this.hints.has(selected.ply),result:this.results.get(selected.ply),sessionActive:this.sessionActive,sessionOpen:this.sessionOpen,verifying:this.verifying===selected.ply,canRetry:!!this.onRetry&&!!data.fingerprint,canCompare:!!this.onCompare&&!!data.fingerprint,canReset:!!this.progressStore,score:analysisScore,solution:solutionPreview});
    if(!moments.length)body+='<p class="report-empty">'+esc(all.length?t('Aucun coup signalé pour ce camp.'):partial?t('Aucun coup signalé dans les positions déjà analysées.'):data.findings?.length?t('Aucun coup signalé pour ce camp.'):t('Aucune erreur dépassant les seuils de ce bilan.'))+'</p>';
    body+='<details class="report-method"><summary>'+esc(t('Qualité de l’analyse'))+'</summary><p>'+esc(t(summary.quality||'Première analyse indicative ; vérifier les positions importantes avec une analyse approfondie.'))+'</p><p>'+esc(t('Les moments sont classés par impact. Les exercices restent créés et validés par toi.'))+'</p><p>'+esc(t('L’impact mesure une baisse indicative des chances de résultat, en points. Ce n’est pas une note de précision.'))+'</p></details>';
   }else if(!this.loading&&!this.error&&!running)body+='<div class="report-empty"><h3>'+esc(t('Comprendre ta prochaine partie'))+'</h3><p>'+esc(t('Lance le bilan pour retrouver quelques décisions importantes, les rejouer et en faire des exercices.'))+'</p></div>';
   this.host.innerHTML='<div class="panel game-analysis-panel cg-report '+(this.view==='moments'?'is-moments':'')+'">'+body+'</div>';
   const side=this.host.querySelector('[data-analysis-side]');if(side){side.disabled=this.sessionOpen;side.onchange=()=>{if(this.sessionOpen){this.render();return;}this.side=side.value;this.sideChosen=true;this.selectedPly=null;this.render();};}
   const color=this.host.querySelector('[data-report-color]');if(color)color.onchange=()=>{this.repertoireColor=color.value;this.repertoireColorChosen=true;this.repertoireBase='';this.repertoireData=null;void this.loadRepertoire();};
   const repertoire=this.host.querySelector('[data-report-repertoire]');if(repertoire)repertoire.onchange=()=>{this.repertoireBase=repertoire.value;this.repertoireData=null;void this.loadRepertoire();};
  }
  async click(event){
   const button=event.target.closest?.('[data-work-action]');if(!button||!this.host.contains(button)||button.disabled)return;const action=button.dataset.workAction;
   if(action==='progress-retry'){this.progressError='';return this.progressStore?.retry(this.entryId,this.data?.fingerprint);}if(action==='progress-local'||action==='progress-remote'){try{this.progressError='';return await this.progressStore?.resolve(this.entryId,this.data?.fingerprint,Number(button.dataset.ply),action==='progress-local'?'local':'remote');}catch(error){this.progressError=error.message;this.render();return;}}if(action==='reload')return this.load();if(action==='analyse')return this.analyse();if(action==='analysis-settings')return this.openSettings();if(action.endsWith('-job'))return this.jobAction(action,button.dataset.id);if(action==='repertoire-reload')return this.loadRepertoire();
   if(action==='report-view'){this.view=button.dataset.view==='moments'?'moments':'summary';this.render();this.resetScroll();return;}if(action==='report-all'){this.allMoments=!this.allMoments;this.selectedPly=null;this.render();return;}
   if(action==='repertoire-exit'||action==='repertoire-build'){
    const report=this.repertoireData,exit=report?.first_exit;if(!exit||this.isBlocked()||this.sessionActive||this.board.busy||this.board.inputLocked)return;
    if(report.source_fingerprint&&this.data?.fingerprint&&report.source_fingerprint!==this.data.fingerprint){notice(t('La position a changé. Actualise le bilan avant de créer cet exercice.'),true);return;}
    if(action==='repertoire-build'){if(report.choices?.some(base=>Number(base.id)===Number(report.base_id)&&base.primary))return this.onRepertoire?.({report,exit});return;}
    const node=this.board.doc.nodes?.find(n=>n.path===exit.before_path);if(node?.fen===exit.fen)return this.board.go(exit.before_path);return;
   }
   if(this.isBlocked())return;
   const moments=this.moments();let finding=this.data?.findings?.find(f=>f.ply===Number(button.dataset.ply));
   if(action==='start-moments')finding=moments[0];
   if(action==='moment-previous'||action==='moment-next'){const index=moments.findIndex(f=>f.ply===this.selectedPly);finding=moments[index+(action==='moment-next'?1:-1)];}
   if(!finding)return;
   if(['finding','start-moments','moment-previous','moment-next'].includes(action))return this.goFinding(finding);
   if(action==='exercise')return this.openExercise(finding);
   if(action==='retry-position')return this.practice(finding);
   if(action==='verify-position')return this.verify(finding);
   if(this.sessionActive)return;
   if(action==='moment-hint'){this.hints.add(finding.ply);this.saveProgress(finding.ply);this.render();return;}
   if(action==='moment-solution'){this.revealed.add(finding.ply);this.results.set(finding.ply,{outcome:'revealed'});this.saveProgress(finding.ply);this.render();return;}
   if(action==='moment-reviewed'){this.results.set(finding.ply,{outcome:'reviewed'});this.saveProgress(finding.ply);this.render();return;}
   if(action==='moment-reset-progress'&&!this.sessionOpen){this.results.delete(finding.ply);this.hints.delete(finding.ply);this.revealed.delete(finding.ply);this.saveProgress(finding.ply);this.render();return;}if(action==='compare-played'||action==='compare-alternative')return this.practice(finding,action==='compare-played'?'played':'alternative');
  }
  async analyse(){if(this.disposed||this.busy||this.sessionOpen||active(this.data?.job)||this.board.disposed||!sourceLineMatches(this.board.doc))return;this.busy=true;this.render();try{const response=await api('/api/game-analysis/'+this.entryId,{method:'POST',body:this.settings});if(this.disposed)return;if(response.job)this.data={...this.data,job:response.job};await this.load();}finally{this.busy=false;if(!this.disposed)this.render();}}
  openSettings(){
   if(this.disposed)return;
   const mode=this.settings.depth==null?'time':'depth',durationDigits=String(this.settings.time_ms??400).padStart(4,'0');
   const timeSeconds=durationDigits.slice(0,-3)+'.'+durationDigits.slice(-3);
   const dialog=modal(t('Analyse de la partie'),'<div class="fields"><label>'+esc(t('Mode d’analyse'))+'<select name="depth_mode">'+option('time',t('Durée par position'),mode)+option('depth',t('Profondeur cible'),mode)+'</select></label></div><div data-analysis-time>'+field(t('Durée par position · secondes'),'time_seconds',timeSeconds,'number','min="0.1" step="0.001"')+'</div><div data-analysis-depth>'+field(t('Profondeur cible'),'depth',this.settings.depth??18,'number','min="1" step="1"')+'</div><p class="hint">'+esc(t('En mode profondeur, chaque position est analysée jusqu’à la cible, sans limite de temps ajoutée. En mode durée, le calcul utilise le temps choisi. Tu peux continuer à utiliser ChessGym ou annuler le bilan.'))+'</p>',{submit:t('Appliquer'),onSubmit:async(fd,form)=>{
    const selected=fd.get('depth_mode');
    if(selected!=='time'&&selected!=='depth')throw new Error(t('Choisis un mode d’analyse Stockfish.'));
    let next;
    if(selected==='depth'){
     const raw=fd.get('depth'),depth=Number(raw);
     if(typeof raw!=='string'||!/^\d+$/.test(raw)||!Number.isSafeInteger(depth)||depth<1||depth>2147483647)throw new Error(t('Choisis une profondeur entière positive compatible avec le moteur.'));
     next={time_ms:null,depth};
    }else{
     const raw=fd.get('time_seconds'),match=typeof raw==='string'&&/^(\d+)(?:\.(\d{1,3}))?$/.exec(raw);
     const time_ms=match?Number(match[1])*1000+Number((match[2]||'').padEnd(3,'0')):NaN;
     if(!Number.isSafeInteger(time_ms)||time_ms<100)throw new Error(t('Choisis une durée d’au moins 0,1 seconde, avec au plus trois décimales.'));
     next={time_ms,depth:null};
    }
    if(this.owns(dialog,form)){this.settings=next;this.settingsChosen=true;notice(t('Réglages appliqués à la prochaine analyse de cette partie.'));}
   }});
   const form=this.ownDialog(dialog),toggle=()=>{
    const custom=form.elements.depth_mode.value==='depth';
    form.querySelector('[data-analysis-depth]').hidden=!custom;form.elements.depth.disabled=!custom;form.elements.depth.required=custom;
    form.querySelector('[data-analysis-time]').hidden=custom;form.elements.time_seconds.disabled=custom;form.elements.time_seconds.required=!custom;
   };
   form.elements.depth_mode.onchange=toggle;toggle();
  }
  async goFinding(finding){if(this.disposed||this.board.disposed||this.board.busy||this.isBlocked())return;if(this.sessionOpen)return this.practice(finding);if(this.board.inputLocked)return;this.selectedPly=finding.ply;this.view='moments';await this.board.go(finding.before_path??'');if(!this.disposed){this.render();this.resetScroll();}}
  async practice(finding,kind=null){
   const callback=kind?this.onCompare:this.onRetry;if(!callback||this.disposed||this.isBlocked()||this.board.busy||this.board.inputLocked&&!this.sessionOpen||!this.data?.fingerprint)return;
   const sequence=++this.sessionSequence,fingerprint=this.data.fingerprint;this.selectedPly=finding.ply;this.view='moments';this.sessionOpen=true;this.sessionActive=true;if(!kind){this.revealed.delete(finding.ply);this.hints.delete(finding.ply);this.results.delete(finding.ply);}this.render();this.resetScroll();
   try{const started=await callback({finding,fingerprint,...(kind?{kind}:{}),onResult:result=>{if(this.disposed||sequence!==this.sessionSequence||fingerprint!==this.data?.fingerprint)return;if(result.hintOnly){this.hints.add(finding.ply);this.saveProgress(finding.ply);this.render();return;}this.sessionOpen=!result.final;if(result.outcome==='reset'){this.revealed.delete(finding.ply);this.results.delete(finding.ply);this.sessionActive=true;}else{this.results.set(finding.ply,result);if(['solved','revealed'].includes(result.outcome))this.revealed.add(finding.ply);this.sessionActive=!result.final&& !['solved','revealed'].includes(result.outcome);}if(result.hinted)this.hints.add(finding.ply);this.saveProgress(finding.ply);this.render();}});if(started===false&&sequence===this.sessionSequence){this.sessionActive=false;this.sessionOpen=false;this.render();}}
   catch(error){if(!this.disposed&&sequence===this.sessionSequence){this.sessionActive=false;this.sessionOpen=false;this.render();}throw error;}
  }
  async verify(finding){
   if(this.disposed||this.isBlocked()||this.verifying!==null||this.sessionOpen||!this.data?.fingerprint)return;const fingerprint=this.data.fingerprint;this.verifying=finding.ply;this.feedback='';this.verifyController?.abort();const controller=new AbortController();this.verifyController=controller;this.render();
   try{const result=await api('/api/game-analysis/'+this.entryId+'/verify',{method:'POST',body:{ply:finding.ply,fingerprint},signal:controller.signal});if(this.disposed||this.board.disposed||this.board.doc.id!==this.entryId||fingerprint!==this.data?.fingerprint)return;if(result.report){this.acceptReport(result.report);if(!result.report.findings?.some(f=>f.ply===finding.ply))this.feedback=t('Après vérification, ce coup n’est plus signalé.');}}
   finally{if(this.verifyController===controller){this.verifyController=null;this.verifying=null;if(!this.disposed)this.render();}}
  }
  openExercise(finding){
   if(this.disposed||this.board.disposed||this.board.busy||this.board.inputLocked||this.isBlocked()||this.sessionActive)return;if(finding.exercise_ids?.length)return this.onOpenEntry(finding.exercise_ids[0]);const path=finding.before_path??'',node=this.board.doc.nodes?.find(n=>n.path===path);
   if(!node||node.fen!==finding.fen){notice(t('La position a changé. Actualise le bilan avant de créer cet exercice.'),true);return;}
   const bases=this.getBases(),selected=bases.find(b=>b.settings?.review_enabled&&b.settings?.type==='solve')?.id??'new';
   return openExerciseEditor({sourceDoc:this.board.doc,sourcePath:path,flipped:finding.side==='black',bases,baseId:selected,newBaseName:t('Mes erreurs'),initialTitle:t(REPORT_KINDS[finding.kind]||'Position à revoir')+' · '+reportMove(finding),sourceLink:this.data?.fingerprint?{entry_id:this.entryId,fingerprint:this.data.fingerprint,ply:finding.ply}:null,onCreated:async result=>{if(result?.entry?.id){finding.exercise_ids=[...new Set([...(finding.exercise_ids||[]),result.entry.id])];this.render();}await this.onLibraryChange();notice(t('Exercice ajouté à la base. Ton analyse est conservée.'));}});
  }
  dispose(){this.unsubscribeProgress?.();this.repertoireSequence++;this.sessionSequence++;this.repertoireController?.abort();this.verifyController?.abort();super.dispose();}
 };
}
