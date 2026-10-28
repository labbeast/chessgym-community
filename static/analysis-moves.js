import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';
import {nodeIndex} from './chess-document.js';
import {formatNags,describeNags} from './annotations.js';
import {formatClock} from './analysis-clocks.js';
import {moveMetricContext,normalizeMoveDisplay} from './move-metrics.js';
export {importedMoveEvaluation} from './move-metrics.js';

const real=value=>typeof value==='number'&&Number.isFinite(value);
const cleanComment=value=>String(value||'').replace(/\[%[^\]]*\]/g,'').trim();

// Scroll only the notation pane, leaving room to read the selected move's notes.
export function followAnalysisMove(list,selected){
 const frame=list?.getBoundingClientRect?.(),box=selected?.getBoundingClientRect?.();
 if(!frame||!box||!(list.clientHeight>0))return;
 const margin=8,previousScroll=list.scrollTop;
 // Extra room after the notation lets even the last move reach the top.
 list.style.setProperty('--analysis-move-tail',Math.max(0,list.clientHeight-box.height-margin)+'px');
 list.scrollTop=Math.max(0,previousScroll+box.top-frame.top-(list.clientTop||0)-margin);
}

// Scores are always from White's perspective, as in Stockfish reports and PGN.
export function moveScore(value){
 if(Number.isInteger(value?.mate))return value.mate===0?(value.winner==='white'?'+M0':value.winner==='black'?'−M0':'M0'):(value.mate>0?'+':'−')+'M'+Math.abs(value.mate);
 return real(value?.cp)?(value.cp>0?'+':value.cp<0?'−':'')+new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(Math.abs(value.cp)/100):null;
}

export function analysisMovesHtml(doc,path='',report=null,variationPath=null,reading=null,display={}){
 const nodes=nodeIndex(doc),root=nodes.get('');
 if(!root)return ui('<div class="analysis-moves"><p class="analysis-moves-empty">Aucun coup.</p></div>');
 const settings=normalizeMoveDisplay(display),context=moveMetricContext(doc,report,nodes);
 const seen=new Set(['']);
 const info=node=>{const fields=String(nodes.get(node.parent)?.fen||'').split(/\s+/),number=Number(fields[5]);return {side:fields[1]==='b'?'black':'white',number:Number.isInteger(number)&&number>0?number:1};};
 const prose=(value,extra='',ownerPath=null)=>{const text=cleanComment(value);return text?'<div class="analysis-move-comment '+extra+(ownerPath===path?' analysis-current-comment':'')+'" data-comment-path="'+esc(ownerPath??'')+'">'+esc(text)+'</div>':'';};
 const button=(node,inline=false)=>{
  const {side,number}=info(node),metric=context.metrics(node),value=metric.evaluation,score=moveScore(value),loss=metric.loss;
  const nags=formatNags(node.nags||[]),description=describeNags(node.nags||[]);
  const duration=seconds=>seconds===null?null:seconds<60?new Intl.NumberFormat(locale(),{maximumFractionDigits:1}).format(seconds)+' s':formatClock(seconds);
  const elapsed=duration(metric.elapsed),remaining=metric.remaining===null?null:formatClock(metric.remaining);
  const lossNumber=loss?.lossCp===null||loss?.lossCp===undefined?null:new Intl.NumberFormat(locale(),{minimumFractionDigits:2,maximumFractionDigits:2}).format(loss.lossCp/100);
  const mateLabels={missed:'Mat manqué',allowed:'Mat concédé',retained:'Mat conservé',found:'Mat trouvé',forced:'Mat subi',escaped:'Mat évité'};
  const lossText=loss?.mateChange?t(mateLabels[loss.mateChange]):lossNumber;
  const shownScore=settings.evaluationMode==='loss'?(loss?.mateChange?lossText:lossNumber===null?null:(loss.lossCp>0?'−':'')+lossNumber):score;
  const shownTime=settings.timeMode==='remaining'?remaining:elapsed;
  const percent=metric.percent===null?null:new Intl.NumberFormat(locale(),{maximumFractionDigits:2}).format(metric.percent);
  const judgement=settings.highlightEvaluation?loss?.judgement:null,timeSeverity=settings.highlightTime?metric.timeSeverity:null;
  const judgementLabels={inaccuracy:'Imprécision',mistake:'Erreur',blunder:'Gaffe'},glyphs={inaccuracy:'?!',mistake:'?',blunder:'??'};
  const label=number+(side==='black'?'… ':'. ')+String(node.san||'—')+nags;
  const sourceOf=evaluation=>evaluation?.source==='stored'?t('Analyse Stockfish enregistrée'):t('Évaluation du PGN');
  const chosen=node.path===variationPath,bookmarked=reading?.enabled&&reading?.visited&&reading.bookmark_path===node.path;
  let title=(chosen?t('Variante choisie · → pour entrer · '):'')+(score===null?label+t(' · Pas d’évaluation enregistrée'):label+' · '+sourceOf(value)+(Number.isSafeInteger(value?.depth)&&value.depth>=0?t(' · profondeur ')+value.depth:'')+' · '+score+t(' (point de vue des Blancs)'))+(description?' · '+description:'');
  if(loss){
   title+=' · '+t('Perte par rapport au meilleur coup : {loss}',{loss:lossText})+t(' (point de vue du joueur)');
   title+=' · '+t('Source de la comparaison : {source}',{source:sourceOf(loss.after)});
   title+=' · '+t('Évaluations avant/après : {before} → {after}',{before:moveScore(loss.before),after:moveScore(loss.after)});
   const beforeDepth=Number.isSafeInteger(loss.before.depth)&&loss.before.depth>=0?loss.before.depth:'—',afterDepth=Number.isSafeInteger(loss.after.depth)&&loss.after.depth>=0?loss.after.depth:'—';
   title+=' · '+t('Profondeurs avant/après : {before}/{after}',{before:beforeDepth,after:afterDepth});
   if(loss.before.best_san||loss.before.best_uci)title+=' · '+t('Meilleur coup : {move}',{move:loss.before.best_san||loss.before.best_uci});
  }else if(settings.evaluationMode==='loss')title+=' · '+t('Perte indisponible : évaluations comparables manquantes');
  if(judgement)title+=' · '+t('Jugement automatique : {judgement}',{judgement:t(judgementLabels[judgement])});
  if(elapsed!==null)title+=' · '+t('Temps pris pour ce coup : {time}',{time:elapsed});
  if(remaining!==null)title+=' · '+t('Temps restant après ce coup : {time}',{time:remaining});
  if(percent!==null)title+=' · '+t('{percent} % du temps initial ({time})',{percent,time:formatClock(metric.base)});
  else if(elapsed!==null&&settings.highlightTime)title+=' · '+t('Pourcentage indisponible : temps initial inconnu');
  const source=settings.evaluationMode==='loss'?loss?.after?.source:value?.source;
  let details=shownScore===null?(inline&&settings.evaluationMode==='position'?'':'<span class="analysis-move-score analysis-score-missing" data-eval-mode="'+settings.evaluationMode+'" aria-hidden="true">—</span>'):'<span class="analysis-move-score" data-eval-mode="'+settings.evaluationMode+'" data-eval-source="'+source+'" aria-hidden="true">'+esc(shownScore)+'</span>';
  if(shownTime!==null)details+='<span class="analysis-move-clock" data-time-mode="'+settings.timeMode+'" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l3 2"/></svg>'+esc(shownTime)+'</span>';
  const accent=(judgement?' data-eval-severity="'+judgement+'"':'')+(timeSeverity?' data-time-severity="'+timeSeverity+'"':'');
  return '<button type="button" class="move analysis-move'+(inline?' analysis-move-inline':'')+(node.path===path?' current':'')+(chosen?' variation-choice':'')+(bookmarked?' reading-bookmark':'')+'" data-path="'+esc(node.path)+'"'+accent+' aria-label="'+esc(title+(bookmarked?t(' · Signet de lecture'):''))+'" title="'+esc(title+(bookmarked?t(' · Signet de lecture'):''))+'"'+(node.path===path?' aria-current="true"':'')+'><span class="analysis-move-san">'+('<span class="reading-bookmark-icon" aria-hidden="true"'+(bookmarked?'':' hidden')+'>⚑</span>')+(inline?'<span class="analysis-inline-number">'+number+(side==='black'?'…':'.')+'</span> ':'')+esc(node.san||'—')+(nags?'<span class="analysis-move-nags">'+esc(nags)+'</span>':'')+(judgement?'<span class="analysis-move-judgement" aria-hidden="true">'+glyphs[judgement]+'</span>':'')+'</span>'+(details?'<span class="analysis-move-details">'+details+'</span>':'')+'</button>';
 };
 const children=node=>(node.children||[]).map(child=>nodes.get(child)).filter(child=>child&&!seen.has(child.path));
 const variant=(start,depth=0)=>{
  if(depth>500||seen.has(start.path))return '';
  seen.add(start.path);
  const content=prose(start.starting_comment,'analysis-starting-comment',start.path)+button(start,true)+prose(start.comment,'',start.path)+continuation(start,depth);
  return ui('<div class="analysis-variation" role="group" aria-label="Variante"><span class="analysis-variation-bracket" aria-hidden="true">(</span>')+content+'<span class="analysis-variation-bracket" aria-hidden="true">)</span></div>';
 };
 const continuation=(parent,depth)=>{
  if(depth>500)return '';
  let content='',node=parent;
  while(node){
   const [main,...alternatives]=children(node);if(!main)break;
   seen.add(main.path);content+=prose(main.starting_comment,'analysis-starting-comment',main.path)+button(main,true)+prose(main.comment,'',main.path);
   content+=alternatives.map(alternative=>variant(alternative,depth+1)).join('');node=main;
  }
  return content;
 };
 let html=prose(root.starting_comment,'analysis-starting-comment',root.path)+prose(root.comment,'',root.path),row=null,node=root;
 const flush=()=>{
  if(!row)return;
  html+='<div class="analysis-move-row"><span class="analysis-move-number" aria-hidden="true">'+row.number+'</span>'+(row.white||'<span class="analysis-move-empty" aria-hidden="true">…</span>')+(row.black||'<span class="analysis-move-empty" aria-hidden="true"></span>')+'</div>';row=null;
 };
 while(node){
  const [main,...alternatives]=children(node);if(!main)break;
  seen.add(main.path);const {side,number}=info(main),starting=prose(main.starting_comment,'analysis-starting-comment',main.path);
  if(starting){flush();html+=starting;}
  if(row&&(row.number!==number||row[side]))flush();
  row||={number,white:'',black:''};row[side]=button(main);
  const comment=prose(main.comment,'',main.path);
  if(comment||alternatives.length){flush();html+=comment+alternatives.map(alternative=>variant(alternative)).join('');}
  else if(side==='black')flush();
  node=main;
 }
 flush();
 const result=doc?.headers?.Result;
 if(!seen.size||seen.size===1)html+=ui('<p class="analysis-moves-empty">Joue un coup pour commencer.</p>');
 if(result&&result!=='*')html+='<div class="analysis-moves-result">'+esc(result)+'</div>';
 return ui('<div class="analysis-moves" aria-label="Coups de la partie">')+html+'</div>';
}

// Cursor-only updates preserve elements, focus, scroll and long annotations.
const renderedPanes=new WeakMap();
function commentIndex(comments){const map=new Map();for(const comment of comments){const path=comment.dataset.commentPath;if(!map.has(path))map.set(path,[]);map.get(path).push(comment);}return map;}
export function renderAnalysisMovesInto(host,doc,path='',report=null,variationPath=null,reading=null,{force=false,display={}}={}){
 const bookmark=reading?.enabled&&reading?.visited?reading.bookmark_path:null;
 const previous=renderedPanes.get(host),language=locale(),displayKey=JSON.stringify(normalizeMoveDisplay(display));
 const changed=force||!previous||previous.doc!==doc||previous.nodes!==doc?.nodes||previous.headers!==doc?.headers||previous.length!==doc?.nodes?.length||previous.pgn!==doc?.pgn||previous.report!==report||previous.language!==language||previous.displayKey!==displayKey;
 if(changed){
  host.innerHTML=analysisMovesHtml(doc,path,report,variationPath,reading,display);
  const buttons=[...host.querySelectorAll('[data-path]')],comments=[...host.querySelectorAll('[data-comment-path]')];
  renderedPanes.set(host,{doc,headers:doc?.headers,nodes:doc?.nodes,length:doc?.nodes?.length,pgn:doc?.pgn,report,bookmark,language,displayKey,buttons,comments,byPath:new Map(buttons.map(button=>[button.dataset.path,button])),commentsByPath:commentIndex(comments),path,variationPath});
  return {changed:true,buttons};
 }
 if(!previous.buttons.length){previous.buttons=[...host.querySelectorAll('[data-path]')];previous.byPath=new Map(previous.buttons.map(button=>[button.dataset.path,button]));if(!previous.buttons.length&&doc?.nodes?.length>1){host.innerHTML=analysisMovesHtml(doc,path,report,variationPath,reading,display);previous.path=path;previous.variationPath=variationPath;return {changed:true,buttons:[]};}}
 const prefix=t('Variante choisie · → pour entrer · ');
 for(const selectedPath of new Set([previous.path,path,previous.variationPath,variationPath,previous.bookmark,bookmark])){
  const button=previous.byPath.get(selectedPath);if(!button)continue;
  const current=button.dataset.path===path,chosen=button.dataset.path===variationPath,bookmarked=button.dataset.path===bookmark;
  if(previous.bookmark!==bookmark){button.classList.toggle('reading-bookmark',bookmarked);const icon=button.querySelector?.('.reading-bookmark-icon');if(icon)icon.hidden=!bookmarked;const suffix=t(' · Signet de lecture'),old=String(button.getAttribute('title')||''),plain=old.endsWith(suffix)?old.slice(0,-suffix.length):old;button.setAttribute('title',plain+(bookmarked?suffix:''));button.setAttribute('aria-label',plain+(bookmarked?suffix:''));}
  button.classList.toggle('current',current);button.classList.toggle('variation-choice',chosen);
  if(current)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');
  if(previous.variationPath!==variationPath&&(button.dataset.path===previous.variationPath||chosen)){
   const title=String(button.getAttribute('title')||'');const plain=title.startsWith(prefix)?title.slice(prefix.length):title;
   button.setAttribute('title',(chosen?prefix:'')+plain);button.setAttribute('aria-label',(chosen?prefix:'')+plain);
  }
 }
 for(const selectedPath of new Set([previous.path,path]))for(const comment of previous.commentsByPath.get(selectedPath)||[])comment.classList.toggle('analysis-current-comment',selectedPath===path);
 previous.path=path;previous.variationPath=variationPath;previous.bookmark=bookmark;
 return {changed:false,buttons:previous.buttons};
}
