import {t,ui,locale} from './i18n.js';
import {api,esc,notice} from './api.js';
import {serialize} from './board.js';
import {coverageProbability} from './repertoire-coverage.js';
import {TranspositionNavigation} from './repertoire-transpositions.js';
export {validateTranspositionDocument} from './repertoire-transpositions.js';

const COLORS=()=>[['white',t('Blancs')],['black',t('Noirs')]];
function bestGap(report){return [report?.best_gap,...(Array.isArray(report?.gaps)?report.gaps:[])].filter(gap=>gap&&typeof gap.pgn==='string'&&gap.pgn.trim()&&typeof gap.probability==='number'&&Number.isFinite(gap.probability)&&gap.probability>0&&gap.probability<=1).sort((a,b)=>b.probability-a.probability)[0];}
function gapActions(color,{disabled=false,gapEnabled=false,gapState={}}={}){if(!gapEnabled)return '';const info=gapState[color];return '<button type="button" data-repertoire-action="gap" data-color="'+color+'" '+(disabled?'disabled':'')+ui(' title="Ouvrir la lacune la plus probable du bilan actuel, avec les filtres mémorisés">Plus grande lacune</button>')+(info?'<small class="repertoire-gap-status" role="status">'+esc(info.message)+'</small>':'')+(info?.showCoverage?'<div class="repertoire-gap-links">'+(info.resumable?'<button type="button" data-repertoire-action="continue-gap" data-color="'+color+'" '+(disabled?'disabled':'')+ui('>Continuer l’exploration</button>'):'')+'<button type="button" data-repertoire-action="coverage" data-color="'+color+'" '+(disabled?'disabled':'')+ui('>À compléter →</button></div>'):'');}
function principalKey(bases){return JSON.stringify(bases.filter(b=>b.settings?.is_repertoire).map(b=>[b.id,b.name,b.settings.color,b.entry_count]).sort((a,b)=>a[0]-b[0]));}
function currentLabel(board){const node=board.node();if(!node?.san)return t('Position initiale');const parent=board.doc.nodes.find(n=>n.path===node.parent),fen=(parent?.fen||'').split(' ');return (fen[5]||'')+(fen[1]==='b'?'… ':'. ')+node.san;}
export function repertoireRowsHtml(data,options={}){
 const {disabled=false}=options;
 return COLORS().map(([color,label])=>{const item=data?.[color];return '<div class="repertoire-row"><span class="repertoire-camp">'+label+'</span>'+(item?'<div class="repertoire-description"><strong>'+esc(item.name)+'</strong><span>'+esc(item.reason||(item.compatible?(item.extendable?t('Cette suite prolonge le répertoire.'):t('Cette suite figure dans le répertoire.')):t('Cette suite s’écarte du répertoire.')))+'</span>'+(item.transposition&&!item.compatible?ui('<small>Position connue par transposition. Le parcours diffère : aucun ajout automatique.</small>'):'')+'</div><div class="repertoire-row-actions">'+(item.compatible&&item.extendable?'<button type="button" data-repertoire-action="extend" data-color="'+color+'" '+(disabled?'disabled':'')+ui('>Ajouter jusqu’ici</button>'):'')+gapActions(color,options)+'</div>':ui('<div class="repertoire-description"><span>Aucun répertoire principal.</span></div>'))+'</div>';}).join('');
}
export class RepertoirePanel{
 constructor(host,{board,getBases=()=>[],onLibraryChange=async()=>{},onExploreGap=null,onOpenCoverage=null,onOpenTransposition=null}={}){this.host=host;this.board=board;this.getBases=getBases;this.onLibraryChange=onLibraryChange;this.onExploreGap=onExploreGap;this.onOpenCoverage=onOpenCoverage;this.gapSequence=0;this.gapBusy=false;this.gapStage='';this.gapState={};this.disposed=false;this.sequence=0;this.data=null;this.snapshot=null;this.loading=false;this.extending=false;this.key=null;this.error='';this.feedback='';this.onClick=event=>{this.click(event).catch(error=>{if(!this.disposed){this.error=error.message;this.render();}});};this.transpositions=new TranspositionNavigation({getSnapshot:()=>this.takeSnapshot(),getBases:this.getBases,isCurrent:snapshot=>this.current(snapshot),onOpen:onOpenTransposition,onUpdate:()=>this.render()});this.onChange=event=>{if(event.target?.dataset?.repertoireAction?.startsWith('transposition-'))this.transpositions.change(event.target);};host.addEventListener('change',this.onChange);host.addEventListener('click',this.onClick);this.ready=this.update({immediate:true});}
 takeSnapshot(){const pgn=serialize(this.board.doc),path=this.board.path||'',entryId=this.board.doc.id||null,principals=principalKey(this.getBases());return {pgn,path,entryId,principals,label:currentLabel(this.board),key:JSON.stringify([entryId,pgn,path,principals])};}
 current(snapshot){if(this.disposed||this.board.disposed||this.board.training)return false;try{return snapshot.key===this.takeSnapshot().key;}catch{return false;}}
 source(snapshot){return {pgn:snapshot.pgn,path:snapshot.path,...(snapshot.entryId?{entry_id:snapshot.entryId}:{})};}
 update({force=false,immediate=false}={}){
  if(this.disposed)return Promise.resolve();if(this.board.disposed||this.board.training){this.transpositions.invalidate();this.sequence++;this.controller?.abort();clearTimeout(this.timer);this.data=null;this.snapshot=null;this.key=null;this.loading=false;this.host.innerHTML='';return Promise.resolve();}
  let snapshot;try{snapshot=this.takeSnapshot();}catch(error){this.sequence++;this.controller?.abort();clearTimeout(this.timer);this.loading=false;this.data=null;this.snapshot=null;this.error=error.message;this.render();return Promise.resolve();}
  if(!force&&snapshot.key===this.key)return Promise.resolve();if(snapshot.key!==this.key){this.transpositions.invalidate();this.feedback='';if(this.gapStage==='finding'){this.gapSequence++;this.gapController?.abort();this.gapBusy=false;this.gapStage='';this.gapState={};}}this.key=snapshot.key;this.sequence++;const sequence=this.sequence;this.controller?.abort();clearTimeout(this.timer);this.data=null;this.snapshot=null;this.error='';
  if(!this.getBases().some(b=>b.settings?.is_repertoire&&b.settings?.primary)){this.loading=false;this.data={white:null,black:null};this.render();return Promise.resolve();}
  this.loading=true;this.render();if(immediate)return this.check(snapshot,sequence);this.timer=setTimeout(()=>this.check(snapshot,sequence),350);return Promise.resolve();
 }
 async check(snapshot,sequence){
  if(this.disposed||sequence!==this.sequence||!this.current(snapshot))return;const controller=new AbortController();this.controller=controller;
  try{const data=await api('/api/repertoires/compatibility',{method:'POST',body:this.source(snapshot),signal:controller.signal});if(this.disposed||sequence!==this.sequence||!this.current(snapshot))return;this.data=data;this.snapshot=snapshot;this.loading=false;this.error='';this.render();}
  catch(error){if(this.disposed||sequence!==this.sequence||!this.current(snapshot)||error.name==='AbortError')return;this.loading=false;this.data=null;this.snapshot=null;this.error=error.message;this.render();}
 }
 render(){if(this.disposed||this.board.training||this.board.disposed)return;let body=this.loading?ui('<p class="muted" role="status">Vérification de la suite affichée…</p>'):this.error?'<p class="error-text" role="status">'+esc(this.error)+'</p>':repertoireRowsHtml(this.data,{disabled:this.extending||this.gapBusy||this.board.busy||this.board.inputLocked,gapEnabled:!!this.onExploreGap,gapState:this.gapState});if(this.feedback)body='<p class="repertoire-feedback" role="status">'+esc(this.feedback)+'</p>'+body;
  this.host.innerHTML=ui('<div class="panel repertoire-panel"><div class="section-heading"><h2>Répertoires principaux</h2><button type="button" class="quiet" data-repertoire-action="refresh" ')+(this.loading||this.extending||this.gapBusy?'disabled':'')+ui(' title="Vérifier la compatibilité de la suite affichée">↻ Vérifier</button></div>')+body+(this.snapshot&&!this.loading?ui('<p class="repertoire-position">Jusqu’à ')+esc(this.snapshot.label)+'</p>':'')+(!this.getBases().some(b=>b.settings?.is_repertoire&&b.settings?.primary)?ui('<p class="hint">Choisis un répertoire principal pour chaque camp dans Répertoires.</p>'):'')+this.transpositions.html({disabled:this.extending||this.gapBusy||this.board.busy||this.board.inputLocked})+'</div>';
 }
 async click(event){const button=event.target.closest?.('[data-repertoire-action]');if(!button||!this.host.contains(button)||button.disabled)return;const action=button.dataset.repertoireAction,color=button.dataset.color;if(action.startsWith('transposition-'))return this.transpositions.click(button);if(action==='refresh')return this.update({force:true,immediate:true});if(action==='extend')return this.extend(color);if(action==='gap'||action==='continue-gap')return this.findGap(color,{continueScan:action==='continue-gap'});if(action==='coverage'&&!this.gapBusy&&!this.extending){const item=this.data?.[color];if(item&&this.current(this.snapshot))return this.onOpenCoverage?.(item.base_id);}}
 async findGap(color,{continueScan=false}={}){
  const item=this.data?.[color],snapshot=this.snapshot;
  if(!this.onExploreGap||this.disposed||this.gapBusy||this.extending||this.loading||this.board.busy||this.board.inputLocked||!item||!snapshot)return false;
  if(!this.current(snapshot)){await this.update({force:true,immediate:true});return false;}
  const token=++this.gapSequence,controller=new AbortController();this.gapController?.abort();this.gapController=controller;this.gapBusy=true;this.gapStage='finding';
  const current=()=>!this.disposed&&!this.board.disposed&&!this.board.training&&token===this.gapSequence&&this.getBases().some(base=>base.id===item.base_id&&base.settings?.is_repertoire&&base.settings?.primary&&base.settings.color===color);
  const url='/api/repertoires/'+item.base_id+'/coverage';
  const message=(text,extra={})=>{this.gapState[color]={message:text,...extra};this.render();};
  try{
   message(t('Vérification du bilan enregistré…'));
   let report=await api(url,{signal:controller.signal});if(!current()||!this.current(snapshot))return false;
   if(report.status==='not_scanned'||report.stale||continueScan||(!Object.hasOwn(report,'best_gap')&&!bestGap(report))){
    message(report.stale?t('Bilan périmé : actualisation en cours…'):report.status==='not_scanned'?t('Pas encore exploré : premier examen en cours…'):t('Exploration supplémentaire en cours…'));
    // One bounded server pass, using its saved profile; never scan on mount.
    report=await api(url,{method:'POST',body:{},signal:controller.signal});if(!current()||!this.current(snapshot))return false;
   }
   if(report.status==='not_scanned'||report.stale){message(t('Le bilan a changé. Réessaie pour l’actualiser.'),{showCoverage:true});return false;}
   const gap=bestGap(report),partial=report.status!=='complete';
   if(!gap){message(partial?t('Exploration partielle : aucune lacune trouvée pour le moment.'):t('Aucune lacune trouvée avec les réglages actuels.'),{showCoverage:true,resumable:!!report.resumable});return false;}
   const probability=coverageProbability(gap.probability),threshold=report.options?.min_probability;
   const belowThreshold=typeof threshold==='number'&&Number.isFinite(threshold)&&gap.probability<threshold;
   const openingText=(partial?t('Exploration partielle : ouverture de la lacune la plus probable du bilan actuel…'):t('Ouverture de la lacune la plus probable…'))+' '+probability.percent+' ('+probability.odds+')'+(belowThreshold?' · '+t('Sous le seuil de ')+coverageProbability(threshold).percent:'');message(openingText);
   this.gapStage='opening';
   // Saving an annotation can change this repertoire. Recheck after that save
   // and after loading the PGN, immediately before replacing the live board.
   const validateGap=async()=>{const fresh=await api(url,{signal:controller.signal});if(!current())return false;const best=bestGap(fresh);if(fresh.stale||fresh.status==='not_scanned'||!best||best.pgn!==gap.pgn||best.key!==gap.key||best.probability!==gap.probability||JSON.stringify(fresh.filters)!==JSON.stringify(report.filters)||JSON.stringify(fresh.options)!==JSON.stringify(report.options)){message(t('Le répertoire ou son bilan a changé. Clique à nouveau sur Plus grande lacune.'),{showCoverage:true});return false;}return true;};
   const opened=await this.onExploreGap(structuredClone(gap),{baseId:item.base_id,color:report.color||color,filters:structuredClone(report.filters||{}),partial,conditionalRoot:!!report.conditional_root,isCurrent:current,validateGap});
   if(opened===false&&current()&&this.gapState[color]?.message===openingText)message(t('L’analyse actuelle est conservée.'));return opened;
  }catch(error){if(!current()||error.name==='AbortError')return false;message(error.message,{showCoverage:true});return false;}
  finally{if(token===this.gapSequence){this.gapBusy=false;this.gapStage='';if(!this.disposed)this.render();}}
 }
 async extend(color){
  const snapshot=this.snapshot,data=this.data,item=data?.[color];if(this.disposed||this.extending||this.gapBusy||this.loading||this.board.busy||this.board.inputLocked||!snapshot||!item?.compatible||!item?.extendable)return;
  if(!this.current(snapshot)){await this.update({force:true,immediate:true});return;}
  if(typeof data.source_fingerprint!=='string'||typeof item.repertoire_fingerprint!=='string'){this.error=t('Vérifie de nouveau cette position avant de l’ajouter.');this.data=null;this.render();return;}
  const payload={...this.source(snapshot),source_fingerprint:data.source_fingerprint,repertoire_fingerprint:item.repertoire_fingerprint};this.extending=true;this.feedback='';this.sequence++;this.controller?.abort();clearTimeout(this.timer);this.loading=false;this.render();
  try{const result=await api('/api/repertoires/'+item.base_id+'/extend',{method:'POST',body:payload});if(this.disposed)return;await this.onLibraryChange();if(this.disposed)return;notice(result.added_moves?result.added_moves+t(' coup(s) ajouté(s) à « ')+item.name+' ».':t('Cette suite figure déjà dans le répertoire.'));}
  catch(error){if(this.disposed)return;this.feedback=error.status===409?t('La partie ou le répertoire a changé. La compatibilité a été vérifiée à nouveau ; choisis à nouveau Ajouter jusqu’ici si la suite convient.'):error.message;}
  finally{this.extending=false;if(!this.disposed)await this.update({force:true,immediate:true});}
 }
 dispose(){this.disposed=true;this.transpositions.dispose();this.host.removeEventListener('change',this.onChange);this.sequence++;this.gapSequence++;clearTimeout(this.timer);this.controller?.abort();this.gapController?.abort();this.host.removeEventListener('click',this.onClick);}
}
