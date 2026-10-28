import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';
import {nodeIndex} from './chess-document.js';
import {moveMetricContext} from './move-metrics.js';

const W=700,H=190,LEFT=32,RIGHT=686,TOP=13,MID=91,BOTTOM=169,LIMIT=500;
const real=value=>typeof value==='number'&&Number.isFinite(value);
const seconds=value=>real(value)&&value>=0?value:null;
const comma=value=>locale().startsWith('fr')?String(value).replace('.',','):String(value);
let serial=0;

export function chartTime(value){
 if(seconds(value)===null)return t('Non disponible');
 if(value<60)return comma(Math.round(value*10)/10)+' s';
 const rounded=Math.round(value),hours=Math.floor(rounded/3600),minutes=Math.floor(rounded/60)%60,rest=rounded%60;
 return (hours?hours+':'+String(minutes).padStart(2,'0'):String(minutes))+':'+String(rest).padStart(2,'0');
}
export function chartScore(value){
 if(real(value?.mate))return value.mate===0?(value.winner==='white'?t('Mat · Blancs gagnent'):value.winner==='black'?t('Mat · Noirs gagnent'):t('Mat')):(value.mate>0?'+':'−')+'M'+Math.abs(value.mate);
 return real(value?.cp)?(value.cp>0?'+':value.cp<0?'−':'')+comma((Math.abs(value.cp)/100).toFixed(2)):t('Non disponible');
}
export function evaluationValue(value){
 if(real(value?.mate)){if(value.mate!==0)return value.mate>0?LIMIT:-LIMIT;return value.winner==='white'?LIMIT:value.winner==='black'?-LIMIT:null;}
 return real(value?.cp)?Math.max(-LIMIT,Math.min(LIMIT,value.cp)):null;
}
// Child order, not path spelling, defines the current main line after promotions.
export function chartMainline(doc){
 const nodes=new Map((doc?.nodes||[]).map(node=>[node.path,node])),root=nodes.get('');if(!root)return [];
 const result=[],seen=new Set();let node=root,parent=null;
 while(node&&!seen.has(node.path)){
  seen.add(node.path);const fields=String(parent?.fen||node.fen||'').split(' '),side=parent?(fields[1]==='b'?'black':'white'):null,number=Number(fields[5]);
  result.push({index:result.length,path:node.path,fen:node.fen,uci:node.uci,side,number:Number.isInteger(number)&&number>0?number:1,san:node.san||'',label:parent?((Number.isInteger(number)&&number>0?number:1)+(side==='black'?'… ':'. ')+(node.san||'—')):t('Position initiale'),clock:seconds(node.clock),elapsed:seconds(node.elapsed)});
  parent=node;node=nodes.get(node.children?.[0]);
 }
 return result;
}
export function chartModel(doc,report){
 const points=chartMainline(doc),stale=report?.status==='stale'||!!report?.stale,nodes=nodeIndex(doc),context=moveMetricContext(doc,report,nodes);
 for(const point of points){point.evaluation=context.evaluation(nodes.get(point.path));point.value=evaluationValue(point.evaluation);}
 const moves=points.slice(1),evaluated=points.filter(p=>p.value!==null).length,elapsed=moves.filter(p=>p.elapsed!==null),clocks=moves.filter(p=>p.clock!==null);
 return {points,stale,evaluated,elapsedCount:elapsed.length,clockCount:clocks.length,maxElapsed:Math.max(0,...elapsed.map(p=>p.elapsed)),maxClock:Math.max(0,...clocks.map(p=>p.clock)),lineKey:points.map(p=>p.path+'|'+p.fen+'|'+p.uci).join('\n')};
}
// Missing values split paths. In particular a missing clock on one's own move
// ends that side's curve; an opponent's move merely leaves its last value held.
export function contiguousSegments(points,value){
 const segments=[];let segment=[];
 for(const point of points){const y=value(point);if(y===null||!real(y)){if(segment.length)segments.push(segment);segment=[];}else segment.push({...point,y});}
 if(segment.length)segments.push(segment);return segments;
}
export function clockSeries(points,side){
 let clock=null;return points.map(point=>{if(point.side===side)clock=point.clock;return {...point,clockValue:clock};});
}
const xAt=(index,length)=>LEFT+(RIGHT-LEFT)*index/Math.max(1,length-1);
const fixed=value=>Number(value.toFixed(2));
const linePath=(segment,length)=>segment.map((p,index)=>(index?'L':'M')+fixed(xAt(p.index,length))+','+fixed(p.y)).join(' ');
function svgLines(segments,length,className,fill=false){return segments.map(segment=>{const line=linePath(segment,length),first=segment[0],last=segment.at(-1);return (fill&&segment.length>1?'<path class="chart-eval-area" d="M'+fixed(xAt(first.index,length))+','+MID+' '+line.replace(/^M/,'L')+' L'+fixed(xAt(last.index,length))+','+MID+' Z"/>':'')+(segment.length>1?'<path class="'+className+'" d="'+line+'"/>':'<circle class="'+className+'" cx="'+fixed(xAt(first.index,length))+'" cy="'+fixed(first.y)+'" r="2.5"/>');}).join('');}
export function chartSvg(model,mode){
 const {points}=model,length=points.length;let body='<rect class="chart-upper" x="'+LEFT+'" y="'+TOP+'" width="'+(RIGHT-LEFT)+'" height="'+(MID-TOP)+'"/><rect class="chart-lower" x="'+LEFT+'" y="'+MID+'" width="'+(RIGHT-LEFT)+'" height="'+(BOTTOM-MID)+'"/>';
 body+='<line class="chart-axis" x1="'+LEFT+'" x2="'+RIGHT+'" y1="'+MID+'" y2="'+MID+'"/>';
 if(mode==='evaluation'){
  body+=svgLines(contiguousSegments(points,p=>p.value===null?null:MID-p.value/LIMIT*(MID-TOP)),length,'chart-eval-line',true);
  for(const [label,y] of [['+5',TOP+4],['0',MID+3],['−5',BOTTOM]])body+='<text class="chart-scale" x="24" y="'+y+'" text-anchor="end">'+label+'</text>';
 }else{
  const width=Math.max(1,Math.min(26,(RIGHT-LEFT)/Math.max(2,length-1)*.76));
  for(const point of points.slice(1)){if(point.elapsed===null)continue;const height=Math.max(.8,point.elapsed/Math.max(1,model.maxElapsed)*(MID-TOP-4)),y=point.side==='white'?MID-height:MID;body+='<rect class="chart-time-bar '+point.side+'" x="'+fixed(xAt(point.index,length)-width/2)+'" y="'+fixed(y)+'" width="'+fixed(width)+'" height="'+fixed(height)+'"/>';}
  for(const side of ['white','black'])body+=svgLines(contiguousSegments(clockSeries(points,side),p=>p.clockValue===null?null:MID+(side==='white'?-1:1)*p.clockValue/Math.max(1,model.maxClock)*(MID-TOP-4)),length,'chart-clock-line '+side);
  body+='<text class="chart-scale chart-side-label" x="24" y="'+(TOP+5)+'" text-anchor="end">B</text><text class="chart-scale chart-side-label" x="24" y="'+BOTTOM+'" text-anchor="end">N</text>';
 }
 const tickIndices=[...new Set([0,Math.floor((length-1)/2),length-1])].filter(i=>i>=0);
 for(const index of tickIndices){const point=points[index];body+='<text class="chart-scale" x="'+fixed(xAt(index,length))+'" y="185" text-anchor="'+(index===0?'start':index===length-1?'end':'middle')+'">'+esc(index===0?t('Départ'):point.number+(point.side==='black'?'…':'.'))+'</text>';}
 return body+'<line data-chart-selection class="chart-selection" x1="0" x2="0" y1="'+TOP+'" y2="'+BOTTOM+'" hidden/><line data-chart-hover class="chart-hover" x1="0" x2="0" y1="'+TOP+'" y2="'+BOTTOM+'" hidden/>';
}

export class AnalysisCharts{
 constructor(host,{board}={}){
  this.host=host;this.board=board;this.id=++serial;this.mode='evaluation';this.report=null;this.disposed=false;this.navigationSequence=0;this.listeners=[];this.model=chartModel(board.doc,null);this.docId=board.doc.id;
  this.listen('click',event=>this.click(event));this.listen('pointermove',event=>this.pointer(event));this.listen('pointerleave',()=>this.hideTooltip());this.listen('keydown',event=>this.keydown(event));this.listen('focusout',event=>{if(!this.host.contains(event.relatedTarget))this.hideTooltip();});this.render();
 }
 listen(type,fn){this.host.addEventListener(type,fn);this.listeners.push([type,fn]);}
 updateReport(report){if(this.disposed)return;this.report=report;this.docId=this.board.doc.id;this.model=chartModel(this.board.doc,report);this.render();}
 update(){
  if(this.disposed)return;if(this.board.disposed){this.dispose();return;}
  const next=chartModel(this.board.doc,this.report),changed=next.lineKey!==this.model.lineKey||this.docId!==this.board.doc.id;
  if(changed){this.report=null;this.docId=this.board.doc.id;this.model=chartModel(this.board.doc,null);this.render();}
  else if(JSON.stringify(next.points.map(p=>[p.clock,p.elapsed,p.evaluation]))!==JSON.stringify(this.model.points.map(p=>[p.clock,p.elapsed,p.evaluation]))){this.model=next;this.render();}
  else this.selectPosition();
 }
 render(){
  if(this.disposed)return;const model=this.model,hasMoves=model.points.length>1,hasData=this.mode==='evaluation'?model.evaluated>0:model.elapsedCount+model.clockCount>0;
  const activeElement=globalThis.document?.activeElement,focusChart=this.host.contains(activeElement)&&activeElement?.hasAttribute?.('data-analysis-graph'),focusTab=this.host.contains(activeElement)?activeElement?.dataset?.chartTab:null;
  const status=model.stale&&!model.evaluated&&this.mode==='evaluation'?t('La partie a changé. Relance l’analyse pour actualiser la courbe.'):!hasMoves?t('Ajoute ou importe une partie pour afficher ses graphiques.'):this.mode==='evaluation'?(model.evaluated?t('Blancs en haut · Noirs en bas · Échelle ±5')+(model.evaluated<model.points.length?' · '+model.evaluated+'/'+model.points.length+t(' positions'):''):t('Active le moteur pour analyser la position, ou lance l’analyse de la partie.')):hasData?t('Barres : temps du coup · Courbes : horloge restante'):t('Ce PGN ne contient pas de temps de réflexion ni d’horloges.');
  this.host.innerHTML=ui('<section class="analysis-charts" aria-label="Graphiques de la partie"><div class="chart-tabs" role="tablist" aria-label="Graphique de la partie">')+[['evaluation',t('Évaluation')],['time',t('Temps des coups')]].map(([mode,label])=>'<button type="button" role="tab" id="chart-tab-'+this.id+'-'+mode+'" data-chart-tab="'+mode+'" aria-selected="'+(mode===this.mode)+'" aria-controls="chart-panel-'+this.id+'" tabindex="'+(mode===this.mode?0:-1)+'">'+label+'</button>').join('')+ui('<span class="chart-scope">Ligne principale</span></div><div id="chart-panel-')+this.id+'" role="tabpanel" aria-labelledby="chart-tab-'+this.id+'-'+this.mode+'"><div class="chart-stage"><svg data-analysis-graph class="analysis-graph" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none" tabindex="0" role="slider" aria-label="'+(this.mode==='evaluation'?t('Évaluation'):t('Temps de réflexion'))+t(' par coup. Flèches gauche et droite pour parcourir la partie.')+'" aria-valuemin="0" aria-valuemax="'+Math.max(0,model.points.length-1)+'" aria-valuenow="0" aria-valuetext="Position initiale">'+(hasMoves?chartSvg(model,this.mode):'')+'</svg>'+(!hasData?'<p class="chart-empty">'+esc(status)+'</p>':'')+'<div class="chart-tooltip" data-chart-tooltip hidden></div></div><div class="chart-caption"><span data-chart-status>'+esc(hasData?status:t('Ligne principale · Clique sur la courbe pour naviguer'))+'</span>'+(this.mode==='time'&&hasData?'<span class="chart-time-scale">'+(model.elapsedCount?t('Barres max. ')+esc(chartTime(model.maxElapsed)):t('Temps du coup absent'))+' · '+(model.clockCount?t('Horloges max. ')+esc(chartTime(model.maxClock)):t('Horloges absentes'))+'</span>':'')+ui('<span data-chart-branch hidden>Variante affichée sur l’échiquier</span></div></div></section>');
  this.graph=this.host.querySelector('[data-analysis-graph]');this.tooltip=this.host.querySelector('[data-chart-tooltip]');this.selectPosition();
  if(focusChart)this.graph?.focus({preventScroll:true});else if(focusTab)this.host.querySelector('[data-chart-tab="'+focusTab+'"]')?.focus({preventScroll:true});
 }
 selectPosition(){
  if(!this.graph)return;const index=this.model.points.findIndex(p=>p.path===this.board.path),selection=this.graph.querySelector('[data-chart-selection]');
  if(selection){selection.hidden=index<0;selection.toggleAttribute('hidden',index<0);if(index>=0){const x=xAt(index,this.model.points.length);selection.setAttribute('x1',x);selection.setAttribute('x2',x);}}
  this.graph.setAttribute('aria-valuenow',Math.max(0,index));this.graph.setAttribute('aria-valuetext',index<0?t('Variante : hors de la ligne principale'):this.description(this.model.points[index]));const branch=this.host.querySelector('[data-chart-branch]');if(branch)branch.hidden=index>=0;
 }
 description(point){if(!point)return '';return point.label+' · '+(this.mode==='evaluation'?t('Évaluation : ')+chartScore(point.evaluation):t('Temps du coup : ')+chartTime(point.elapsed)+t(' · Horloge restante : ')+chartTime(point.clock));}
 indexAt(event){const rect=this.graph?.getBoundingClientRect();if(!rect?.width)return null;const x=(event.clientX-rect.left)/rect.width*W;return Math.max(0,Math.min(this.model.points.length-1,Math.round((x-LEFT)/(RIGHT-LEFT)*Math.max(1,this.model.points.length-1))));}
 showTooltip(index){
  const point=this.model.points[index];if(!point||!this.tooltip)return;
  this.tooltip.hidden=false;this.tooltip.textContent=this.description(point);
  // Measure the bubble at its natural width, then keep it inside the stage.
  // Translating a width:auto box near the right edge first shrinks its text.
  const stage=this.tooltip.parentElement.getBoundingClientRect(),graph=this.graph.getBoundingClientRect(),width=this.tooltip.getBoundingClientRect().width;
  const anchor=graph.left-stage.left+xAt(index,this.model.points.length)/W*graph.width;
  this.tooltip.style.left=Math.max(8,Math.min(stage.width-width-8,anchor-width/2))+'px';this.tooltip.style.transform='none';
  const hover=this.graph.querySelector('[data-chart-hover]');if(hover){hover.removeAttribute('hidden');const x=xAt(index,this.model.points.length);hover.setAttribute('x1',x);hover.setAttribute('x2',x);}
 }
 hideTooltip(){if(this.tooltip)this.tooltip.hidden=true;this.graph?.querySelector('[data-chart-hover]')?.setAttribute('hidden','');}
 pointer(event){if(this.disposed||event.pointerType==='touch'||!event.target.closest?.('[data-analysis-graph]'))return;const index=this.indexAt(event);if(index!==null)this.showTooltip(index);}
 async navigate(index){if(this.disposed||this.board.disposed||this.board.busy||this.board.inputLocked)return;const point=this.model.points[index];if(!point)return;const sequence=++this.navigationSequence,doc=this.board.doc,lineKey=this.model.lineKey;await this.board.go(point.path);if(!this.disposed&&sequence===this.navigationSequence&&this.board.doc===doc&&this.model.lineKey===lineKey&&this.board.path===point.path){this.selectPosition();this.showTooltip(index);}}
 click(event){
  if(this.disposed)return;const tab=event.target.closest?.('[data-chart-tab]');if(tab&&this.host.contains(tab)){this.mode=tab.dataset.chartTab;this.render();this.host.querySelector('[data-chart-tab="'+this.mode+'"]')?.focus({preventScroll:true});return;}
  if(event.target.closest?.('[data-analysis-graph]')){const index=this.indexAt(event);if(index!==null)void this.navigate(index);}
 }
 keydown(event){
  if(this.disposed||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey)return;const tab=event.target.closest?.('[data-chart-tab]'),graph=event.target.closest?.('[data-analysis-graph]');
  if(tab&&['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();this.mode=event.key==='Home'?'evaluation':event.key==='End'?'time':this.mode==='evaluation'?'time':'evaluation';this.render();this.host.querySelector('[data-chart-tab="'+this.mode+'"]')?.focus({preventScroll:true});return;}
  if(!graph||!['ArrowLeft','ArrowRight','Home','End','Escape'].includes(event.key))return;event.preventDefault();event.stopPropagation();if(event.key==='Escape'){this.hideTooltip();return;}const current=this.model.points.findIndex(p=>p.path===this.board.path),last=this.model.points.length-1,index=event.key==='Home'?0:event.key==='End'?last:Math.max(0,Math.min(last,Math.max(0,current)+(event.key==='ArrowRight'?1:-1)));void this.navigate(index);
 }
 dispose(){if(this.disposed)return;this.disposed=true;for(const [type,fn] of this.listeners)this.host.removeEventListener(type,fn);this.listeners=[];this.hideTooltip();}
}
