import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';

// Stateless formatting shared by the explorer and its tests.
export const count=n=>Number.isFinite(n)?new Intl.NumberFormat(locale()).format(n):'—';
export const percent=n=>Number.isFinite(n)?n>0&&n<.01?t('< 0,01 %'):new Intl.NumberFormat(locale(),{maximumFractionDigits:n>0&&n<1?2:1}).format(n)+' %':'—';
export const sourceLabel=s=>({lichess:t('Joueurs Lichess'),masters:t('Maîtres Lichess'),local:t('Mes bases')}[s]||'');
export const available=dataset=>!!dataset&&(dataset.status==='ok'||dataset.stale===true);
function resultLabel(move){
 const white=Number(move.white)||0,draws=Number(move.draws)||0,black=Number(move.black)||0,unknown=Number(move.unknown)||0,known=white+draws+black;
 return {white,draws,black,unknown,known,text:known?t('Blancs : ')+count(white)+' ('+percent(100*white/known)+t(') · Nulles : ')+count(draws)+' ('+percent(100*draws/known)+t(') · Noirs : ')+count(black)+' ('+percent(100*black/known)+')'+(unknown?t(' · Résultat inconnu : ')+count(unknown)+t(' (exclu des pourcentages)'):''):t('Aucun résultat connu')+(unknown?' · '+count(unknown)+t(' partie(s) sans résultat'):'')};
}
export function resultsHtml(move){
 if(move.results_available===false)return '<span class="explorer-no-results" title="'+esc(t('Résultats indisponibles pendant l’importation; la fréquence reste exacte.'))+'">—</span>';
 const r=resultLabel(move);
 if(!r.known)return '<span class="explorer-no-results" title="'+esc(r.text)+'">—'+(r.unknown?'<small>'+count(r.unknown)+ui(' sans résultat</small>'):'')+'</span>';
 const segments=[['white',r.white],['draw',r.draws],['black',r.black]];
 return '<span class="explorer-results" role="img" aria-label="'+esc(r.text)+'" title="'+esc(r.text)+'">'+segments.filter(([,n])=>n).map(([name,n])=>'<span class="result-'+name+'" style="width:'+100*n/r.known+'%">'+(100*n/r.known>=12?Math.round(100*n/r.known)+'%':'')+'</span>').join('')+'</span>'+(r.unknown?'<small class="explorer-unknown">'+count(r.unknown)+ui(' sans résultat</small>'):'');
}
export function evaluationHelp(depth=null){
 return t('Évaluation après ce coup, du point de vue des Blancs : + favorise les Blancs, − les Noirs. ')+(depth==null?t('Analyse rapide Stockfish (~250 ms par coup), indicative.'):t('Stockfish : profondeur cible ')+depth+t(', sans limite de temps ajoutée. ≈ indique une cible non atteinte.'))+t(' Survole une valeur pour voir sa profondeur réelle.');
}
export function evaluationDisplay(value,{enabled=true,unavailable=false}={}){
 if(value?.status==='ok'){
  const score=value.mate!=null?'#'+(value.mate>0?'+':'')+value.mate:(value.cp>0?'+':value.cp<0?'−':'')+new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.abs(value.cp)/100);
  const exact=value.engine==='Règles des échecs',limited=!exact&&value.requested_depth!=null&&value.depth_reached===false;
  const mode=exact?t('Position finale · Évaluation exacte'):value.requested_depth==null?t('Analyse rapide (~250 ms) · Profondeur ')+value.depth:t('Profondeur ')+value.depth+t(' · Cible ')+value.requested_depth+(limited?t(' non atteinte'):t(' atteinte'));
  return {text:(limited?'≈ ':'')+score,state:limited?'approximate':'ready',title:(exact?t('Règles des échecs'):(value.engine||'Stockfish'))+' · '+mode+t(' · Du point de vue des Blancs')+(value.cached?t(' · Évaluation en cache'):'')};
 }
 if(value?.status==='error'||unavailable)return {text:'—',state:'unavailable',title:t('Évaluation indisponible. Relance les évaluations pour réessayer.')};
 return enabled?{text:'…',state:'pending',title:t('Évaluation Stockfish en attente')}:{text:'—',state:'paused',title:t('Évaluations en pause')};
}
export function explorerRowsHtml(data,{disabled=false,evaluations=new Map(),evaluationEnabled=true,evaluationUnavailable=false}={}){
 const primaryOK=available(data.primary),masterOK=available(data.masters),comparison=data.settings?.master_source!=='none';
 return (data.moves||[]).map(m=>{
  const primaryKnown=primaryOK&&!(data.primary.complete===false&&m.frequency==null);
  const move=esc(m.san),frequency=esc(primaryKnown?percent(m.frequency):'—'),evaluation=evaluationDisplay(evaluations.get(m.uci),{enabled:evaluationEnabled,unavailable:evaluationUnavailable});
  const masters=esc(masterOK?percent(m.master_frequency):'—');
  const primaryTitle=primaryKnown?count(m.total)+t(' partie(s) · fréquence à cette position'):t('Fréquence inconnue pour ce coup');
  const masterTitle=masterOK&&m.master_total!=null?count(m.master_total)+t(' partie(s) · ')+(data.masters?.label||t('Référence'))+t(' · fréquence à cette position'):t('Fréquence de référence inconnue pour ce coup');
  return '<tr data-explorer-move="'+esc(m.uci)+'"><th scope="row"><button type="button" class="explorer-play" data-explorer-play="'+esc(m.uci)+'" aria-label="'+t('Jouer ')+move+'" '+(disabled?'disabled':'')+'>'+move+'</button></th><td class="explorer-frequency" title="'+esc(primaryTitle)+'">'+frequency+'<small>'+ (primaryKnown?count(m.total):'—')+'</small></td><td>'+ (primaryKnown?resultsHtml(m):ui('<span class="explorer-no-results" title="Statistiques indisponibles">—</span>'))+'</td>'+(comparison?'<td class="explorer-masters" title="'+esc(masterTitle)+'">'+masters+'</td>':'')+'<td class="explorer-evaluation" data-explorer-evaluation="'+esc(m.uci)+'" data-state="'+evaluation.state+'" title="'+esc(evaluation.title)+'">'+esc(evaluation.text)+'</td></tr>';
 }).join('');
}
export function datasetWarning(dataset,kind){
 if(!dataset||dataset.status==='disabled'||(dataset.status==='ok'&&!dataset.stale&&dataset.complete!==false))return '';
 if(dataset.status==='preparing')return '<p class="explorer-preparing" role="status">'+esc((kind==='primary'?t('Base'):t('Référence'))+' : '+t(dataset.message||'Préparation des statistiques exactes de cette position…'))+'</p>';
 const label=kind==='primary'?t('Base'):t('Référence'),message=t(dataset.message)||(dataset.complete===false?t('Statistiques partielles à cette position.'):dataset.status==='rate_limited'?t('Trop de demandes. Réessaie dans un moment.'):t('Source momentanément indisponible.'));
 const seconds=Number.isFinite(dataset.retry_after)&&dataset.retry_after>0?Math.ceil(dataset.retry_after):0;
 const wait=seconds?(seconds>=60?count(Math.ceil(seconds/60))+' min':count(seconds)+' s'):'';
 return '<p class="explorer-warning">'+esc(label+' : '+message)+(dataset.status==='rate_limited'&&wait?t(' Réessaie dans ')+esc(wait)+'.':'')+(dataset.stale?t(' Dernières données connues affichées.'):'')+'</p>';
}
