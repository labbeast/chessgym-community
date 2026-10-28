import {t,ui} from './i18n.js';
import {api,esc,modal,option} from './api.js';
import {ExplorerConnection} from './explorer-connection.js';
import {explorerSettingsHtml,readExplorerSettings} from './explorer-settings.js';
import {count,percent,sourceLabel,available,evaluationHelp,evaluationDisplay,explorerRowsHtml,datasetWarning} from './explorer-view.js';
export {ExplorerConnection} from './explorer-connection.js';
export {explorerSettingsHtml} from './explorer-settings.js';
export {explorerRowsHtml,resultsHtml} from './explorer-view.js';
import {ExplorerProbability,probabilityContext,probabilityHtml} from './explorer-probability.js';
import {searchProgressHtml} from './search-progress.js';

function settingsKey(settings){const {repertoire_color,show_probability,...statistics}=settings||{};return JSON.stringify(statistics);}
export class OpeningExplorer{
 constructor(host,{board,getBases=()=>[],visible=true,settingsOverride=null}){
  this.host=host;this.board=board;this.getBases=getBases;this.settingsOverride=settingsOverride;this.visible=visible;this.settings=null;this.data=null;this.dataFen='';this.disposed=false;this.sequence=0;this.timer=null;this.controller=null;this.settingsController=new AbortController();this.key='';this.fen='';this.collapsed=false;this.loading=false;this.playing=false;this.error='';this.dialog=null;this.connection=null;
  this.evaluationEnabled=true;this.evaluations=new Map();this.evaluationSequence=0;this.evaluationController=null;this.evaluationRunning=false;this.evaluationUnavailable=false;
  this.preparationTimer=null;this.preparationController=null;this.preparationEpoch=0;this.preparationStartedAt=null;this.preparationAttempts=0;this.preparationPaused=false;this.preparationInterrupted=false;
  this.onVisibilityChange=()=>{if(globalThis.document?.visibilityState==='hidden')this.stopPreparation();else this.schedulePreparation();};globalThis.document?.addEventListener?.('visibilitychange',this.onVisibilityChange);
  this.probability=new ExplorerProbability({getContext:()=>probabilityContext(this.board,this.settings),isActive:()=>!this.disposed&&!this.board.disposed&&this.visible&&!this.collapsed&&!!this.settings&&this.settings.show_probability!==false,onChange:()=>this.syncProbability()});this.colorSaving=false;this.colorError='';this.colorController=null;
  this.onColorChange=e=>{if(e.target.matches?.('[data-explorer-color]'))void this.setRepertoireColor(e.target.value);};host.addEventListener('change',this.onColorChange);
  this.onClick=e=>this.click(e);host.addEventListener('click',this.onClick);
  host.classList.add('panel','opening-explorer');this.render();this.ready=this.loadSettings();
 }
 async loadSettings(){
  this.error='';this.loading=true;this.render();
  try{const settings=await api('/api/explorer/settings',{signal:this.settingsController.signal});if(this.disposed)return;this.settings={...settings,...this.settingsOverride};this.update({immediate:true,force:true});}
  catch(error){if(this.disposed||error.name==='AbortError')return;this.loading=false;this.error=t('Impossible de charger les réglages de l’explorateur. ')+error.message;this.render();}
 }
 update({immediate=false,force=false}={}){
  if(this.disposed||!this.settings)return;
  this.probability.update({force});
  const fen=this.board.node().fen,key=fen+'|'+settingsKey(this.settings);
  if(!force&&key===this.key)return;
  this.stopPreparation({reset:true});this.stopEvaluations();this.evaluations.clear();this.evaluationUnavailable=false;
  this.key=key;this.fen=fen;this.data=null;this.error='';this.loading=true;
  const sequence=++this.sequence;clearTimeout(this.timer);this.controller?.abort();this.render();
  if(this.collapsed||!this.visible){this.loading=false;this.render();return;}
  if(immediate)this.request(sequence,fen,structuredClone(this.settings));
  else this.timer=setTimeout(()=>this.request(sequence,fen,structuredClone(this.settings)),250);
 }
 async request(sequence,fen,settings,{preparation=false}={}){
  if(this.disposed||!this.visible||this.collapsed||sequence!==this.sequence||preparation&&!this.canPrepare())return;
  const controller=new AbortController(),epoch=this.preparationEpoch;if(preparation)this.preparationController=controller;else this.controller=controller;
  try{
   const data=await api('/api/explorer',{method:'POST',body:{fen,settings},signal:controller.signal});
   if(this.disposed||sequence!==this.sequence||fen!==this.board.node().fen||settingsKey(settings)!==settingsKey(this.settings)||preparation&&(epoch!==this.preparationEpoch||!this.canPrepare()))return;
   const scroll=preparation?this.host.querySelector('.explorer-table-wrap')?.scrollTop:null;
   this.data=data;this.dataFen=fen;this.loading=false;this.error='';this.render();if(scroll!=null){const table=this.host.querySelector('.explorer-table-wrap');if(table)table.scrollTop=scroll;}this.startEvaluations();this.schedulePreparation();
  }catch(error){if(this.disposed||sequence!==this.sequence||error.name==='AbortError'||preparation&&epoch!==this.preparationEpoch)return;if(preparation){this.preparationPaused=true;this.preparationInterrupted=true;this.render();return;}this.loading=false;this.data=null;this.error=t('Explorateur indisponible. ')+error.message;this.render();}
  finally{if(preparation&&this.preparationController===controller)this.preparationController=null;}
 }
 preparing(){return [this.data?.primary,this.data?.masters].some(dataset=>dataset?.status==='preparing');}
 canPrepare(){return !this.disposed&&!this.board.disposed&&this.visible&&!this.collapsed&&globalThis.document?.visibilityState!=='hidden'&&!!this.settings&&this.dataFen===this.board.node().fen&&this.key===this.dataFen+'|'+settingsKey(this.settings);}
 stopPreparation({reset=false}={}){
  clearTimeout(this.preparationTimer);this.preparationTimer=null;this.preparationEpoch++;this.preparationController?.abort();this.preparationController=null;
  if(reset){this.preparationStartedAt=null;this.preparationAttempts=0;this.preparationPaused=false;this.preparationInterrupted=false;}
 }
 schedulePreparation(){
  clearTimeout(this.preparationTimer);this.preparationTimer=null;
  if(!this.preparing()){this.preparationStartedAt=null;this.preparationAttempts=0;this.preparationPaused=false;this.preparationInterrupted=false;return;}
  if(!this.canPrepare()||this.preparationPaused)return;
  this.preparationStartedAt??=Date.now();const remaining=300000-(Date.now()-this.preparationStartedAt);
  if(remaining<=0){this.preparationPaused=true;this.render();return;}
  const retry=Math.max(3,...[this.data.primary,this.data.masters].filter(dataset=>dataset?.status==='preparing').map(dataset=>Number(dataset.retry_after)||3)),delay=Math.min(15000,retry*1000*1.5**Math.min(this.preparationAttempts,8));
  this.preparationTimer=setTimeout(()=>{this.preparationTimer=null;if(!this.canPrepare())return;if(Date.now()-this.preparationStartedAt>=300000){this.preparationPaused=true;this.render();return;}this.preparationAttempts++;void this.request(this.sequence,this.dataFen,structuredClone(this.settings),{preparation:true});},Math.min(delay,remaining));
 }
 refreshPreparation(){
  if(!this.canPrepare()||this.preparationController)return;
  this.stopPreparation({reset:true});this.preparationStartedAt=Date.now();this.render();return this.request(this.sequence,this.dataFen,structuredClone(this.settings),{preparation:true});
 }
 setVisible(visible){
  if(this.disposed||this.visible===!!visible)return;this.visible=!!visible;this.probability.update();
  if(!this.visible){this.stopPreparation();clearTimeout(this.timer);this.controller?.abort();this.sequence++;this.stopEvaluations();this.loading=false;this.render();return;}
  if(this.data&&this.dataFen===this.board.node().fen&&this.key===this.board.node().fen+'|'+settingsKey(this.settings)){this.render();this.startEvaluations();this.schedulePreparation();}
  else this.update({immediate:true,force:true});
 }
 stopEvaluations(){
  this.evaluationSequence++;this.evaluationController?.abort();this.evaluationController=null;this.evaluationRunning=false;
 }
 canEvaluate(){return this.visible&&!this.disposed&&!this.board.disposed&&!this.board.training&&!this.collapsed&&!this.loading&&!this.playing&&this.evaluationEnabled&&!this.evaluationUnavailable&&!!this.data&&this.dataFen===this.board.node().fen;}
 evaluationCurrent(sequence,fen,statistics){return sequence===this.evaluationSequence&&statistics===this.sequence&&fen===this.dataFen&&fen===this.board.node().fen&&this.canEvaluate();}
 async startEvaluations(){
  if(!this.canEvaluate()||this.evaluationRunning)return;
  const sequence=++this.evaluationSequence,fen=this.dataFen,statistics=this.sequence,depth=this.settings.engine_depth??null;
  this.evaluationRunning=true;
  try{
   for(const move of this.data.moves||[]){
    if(!this.evaluationCurrent(sequence,fen,statistics))return;
    if(this.evaluations.has(move.uci))continue;
    const controller=new AbortController();this.evaluationController=controller;
    try{
     const value=await api('/api/explorer/evaluate',{method:'POST',body:{fen,uci:move.uci,depth},signal:controller.signal});
     if(!this.evaluationCurrent(sequence,fen,statistics))return;
     if(value.uci!==move.uci||(!Number.isFinite(value.cp)&&!Number.isFinite(value.mate)))throw new Error(t('Évaluation invalide'));
     this.evaluations.set(move.uci,{...value,status:'ok'});
    }catch(error){
     if(!this.evaluationCurrent(sequence,fen,statistics)||error.name==='AbortError')return;
     this.evaluations.set(move.uci,{status:'error'});
     if(!error.status||error.status>=500||error.status===401||error.status===429)this.evaluationUnavailable=true;
    }
    this.syncEvaluations();
    if(this.evaluationUnavailable)return;
   }
  }finally{if(sequence===this.evaluationSequence){this.evaluationRunning=false;this.evaluationController=null;this.syncEvaluations();if(this.canEvaluate()&&this.data.moves.some(move=>!this.evaluations.has(move.uci)))void this.startEvaluations();}}
 }
 toggleEvaluations(){
  if(this.disposed)return;
  if(this.evaluationControl().retry){this.evaluationUnavailable=false;this.evaluationEnabled=true;}
  else this.evaluationEnabled=!this.evaluationEnabled;
  this.stopEvaluations();
  if(this.evaluationEnabled)for(const [uci,value] of this.evaluations)if(value.status==='error')this.evaluations.delete(uci);
  this.syncEvaluations();this.startEvaluations();
 }
 evaluationControl(){
  const values=[...this.evaluations.values()],done=values.filter(v=>v.status==='ok').length,total=this.data?.moves?.length||0,failed=values.some(v=>v.status==='error');
  const stopped=this.evaluationUnavailable,enabled=this.evaluationEnabled,retry=stopped||(!this.evaluationRunning&&failed&&values.length===total);
  return {retry,text:(retry?'↻':enabled?'⏸':'▶')+t(' Éval.'),label:retry?t('Réessayer les évaluations Stockfish'):enabled?t('Mettre en pause les évaluations Stockfish'):t('Reprendre les évaluations Stockfish'),status:stopped?t('Stockfish indisponible'):!enabled?t('En pause'):retry?t('Évaluations incomplètes'):total?done+'/'+total:'',title:evaluationHelp(this.settings?.engine_depth)+(stopped?t(' Stockfish indisponible : clique pour réessayer.'):failed?t(' Certaines évaluations sont indisponibles : clique pour réessayer.'):'')};
 }
 syncEvaluations(){
  if(this.disposed)return;
  this.host.querySelectorAll('[data-explorer-evaluation]').forEach(cell=>{
   const value=evaluationDisplay(this.evaluations.get(cell.dataset.explorerEvaluation),{enabled:this.evaluationEnabled,unavailable:this.evaluationUnavailable});
   cell.textContent=value.text;cell.title=value.title;cell.dataset.state=value.state;
  });
  const control=this.evaluationControl(),button=this.host.querySelector('[data-explorer-action="evaluation"]'),status=this.host.querySelector('[data-explorer-evaluation-status]');
  if(button){button.textContent=control.text;button.title=control.title;button.setAttribute('aria-label',control.label);button.setAttribute('aria-pressed',String(this.evaluationEnabled));}
  if(status){status.textContent=control.status;status.title=control.title;}
 }
 syncProbability(){
  if(this.disposed)return;
  const host=this.host.querySelector('[data-explorer-probability]');if(host)host.innerHTML=probabilityHtml(this.probability.state,this.probability.context);
 }
 probabilityControls(){
  if(!this.settings||this.settings.show_probability===false)return '';
  return ui('<div class="explorer-repertoire"><label class="explorer-color">Mon camp <select data-explorer-color aria-label="Camp du répertoire pour les probabilités" ')+(this.colorSaving?'disabled':'')+'>'+[['white',t('Blancs')],['black',t('Noirs')]].map(([v,t])=>option(v,t,this.settings.repertoire_color||'white')).join('')+'</select></label><div class="explorer-probability" data-explorer-probability>'+probabilityHtml(this.probability.state,this.probability.context)+'</div></div>'+(this.colorError?'<p class="explorer-warning" role="status">'+esc(this.colorError)+'</p>':'');
 }
 async setRepertoireColor(color){
  if(this.disposed||this.colorSaving||!this.settings||!['white','black'].includes(color)||color===(this.settings.repertoire_color||'white'))return;
  const previous=this.settings.repertoire_color||'white';this.settings={...this.settings,repertoire_color:color};this.colorError='';this.colorSaving=true;this.probability.update();this.render();
  const controller=new AbortController();this.colorController=controller;
  try{const saved=await api('/api/explorer/settings',{method:'PATCH',body:{repertoire_color:color},signal:controller.signal});if(this.disposed)return;this.settings={...this.settings,repertoire_color:saved.repertoire_color};this.probability.update();}
  catch(error){if(this.disposed||error.name==='AbortError')return;this.settings={...this.settings,repertoire_color:previous};this.colorError=t('Impossible d’enregistrer ton camp. Réessaie.');this.probability.update();}
  finally{if(!this.disposed){this.colorSaving=false;this.colorController=null;this.render();}}
 }
 render(){
  if(this.disposed)return;
  const settings=this.settings,data=this.data,comparison=settings?.master_source!=='none',masterLocal=settings?.master_source!=='masters';
  const searching=this.visible&&!this.collapsed&&(this.loading||this.preparing()&&!this.preparationPaused);
  const evaluationControl=this.evaluationControl(),label=data?.primary?.label||sourceLabel(settings?.source),total=data&&available(data.primary)?count(data.primary.total)+t(' partie(s)'):'';
  let body='';
  if(this.loading)body=settings&&searching?searchProgressHtml({label:t('Recherche à cette position…')}):'<p class="explorer-message" role="status">'+(settings?t('Recherche à cette position…'):t('Chargement des réglages…'))+'</p>';
  else if(this.error)body='<p class="explorer-warning" role="status">'+esc(this.error)+ui('</p><button type="button" class="quiet explorer-retry" data-explorer-action="retry">Réessayer</button>');
  else if(data){
   body=datasetWarning(data.primary,'primary');
   if(!(data.primary?.status==='auth_required'&&data.masters?.status==='auth_required'&&data.primary.message===data.masters.message))body+=datasetWarning(data.masters,'masters');
   if(data.moves?.length){
    body+=ui('<div class="explorer-table-wrap"><table class="explorer-table"><caption class="explorer-visually-hidden">Coups joués à la position affichée. Résultats : victoires des Blancs, nulles et victoires des Noirs.</caption><thead><tr><th scope="col">Coup</th><th scope="col" title="Fréquence du coup dans la base sélectionnée">Fréquence</th><th scope="col" title="Victoires des Blancs · nulles · victoires des Noirs">Résultats <span class="explorer-results-order">B / = / N</span></th>')+(comparison?'<th scope="col" class="explorer-masters-heading" title="'+esc(masterLocal?t('Fréquence dans la source de référence choisie'):t('Fréquence dans la base des maîtres Lichess'))+'">'+(masterLocal?t('Réf.'):t('Maîtres'))+'</th>':'')+'<th scope="col" class="explorer-evaluation-heading" title="'+esc(evaluationHelp(settings?.engine_depth))+ui('">Éval.</th></tr></thead><tbody>')+explorerRowsHtml(data,{disabled:this.playing||this.board.busy||this.board.inputLocked,evaluations:this.evaluations,evaluationEnabled:this.evaluationEnabled,evaluationUnavailable:this.evaluationUnavailable})+'</tbody></table></div>';
   }else if(available(data.primary)&&!this.preparing())body+='<p class="explorer-message">'+esc(data.primary.message||(data.primary.terminal_count?t('Cette position apparaît en fin de partie, sans coup suivant.'):t('Aucun coup trouvé dans cette sélection.')))+'</p>';
   else if(!this.preparing())body+=ui('<p class="explorer-message">Aucun résultat disponible pour cette position.</p>');
   const datasets=[data.primary,...(comparison?[data.masters]:[])];
   if(this.preparing()){
    if(searching)body+=searchProgressHtml({label:t('Recherche à cette position…'),hint:t('Les résultats apparaîtront automatiquement dès qu’ils seront prêts.')});
    else if(this.preparationPaused)body+='<p class="hint explorer-preparation-hint">'+(this.preparationInterrupted?t('Actualisation interrompue. Clique sur Actualiser pour réessayer.'):t('La préparation continue sur le serveur. Clique sur Actualiser pour vérifier le résultat.'))+ui('</p><button type="button" class="quiet explorer-retry" data-explorer-action="preparation-refresh">Actualiser</button>');
   }
   if(datasets.some(d=>d?.status==='auth_required'))body+=ui('<button type="button" class="explorer-connect" data-explorer-action="settings">Connecter Lichess</button>');
   if(datasets.some(d=>!['ok','disabled','auth_required','preparing'].includes(d?.status)))body+=ui('<button type="button" class="quiet explorer-retry" data-explorer-action="retry">Réessayer</button>');
   else if(datasets.some(d=>d?.status==='ok'&&d.complete===false))body+=ui('<button type="button" class="quiet explorer-retry" data-explorer-action="retry" title="Relire les statistiques disponibles à cette position">Actualiser</button>');
  }
  this.host.innerHTML='<div class="section-heading explorer-heading"><h2><button type="button" class="explorer-collapse" data-explorer-action="collapse" aria-expanded="'+!this.collapsed+'" aria-label="'+(this.collapsed?t('Afficher'):t('Réduire'))+t(' l’explorateur')+'">'+(this.collapsed?'▸':'▾')+ui(' Explorateur</button></h2><div class="explorer-heading-actions"><span class="explorer-evaluation-status" data-explorer-evaluation-status title="')+esc(evaluationControl.title)+'">'+esc(evaluationControl.status)+'</span><button type="button" class="quiet explorer-evaluation-toggle" data-explorer-action="evaluation" aria-pressed="'+this.evaluationEnabled+'" aria-label="'+esc(evaluationControl.label)+'" title="'+esc(evaluationControl.title)+'">'+evaluationControl.text+ui('</button><button type="button" class="quiet explorer-settings-button" data-explorer-action="settings" title="Base, cadence, niveau, référence et analyse Stockfish" aria-label="Réglages de l’explorateur" ')+(!settings?'disabled':'')+'>⚙</button></div></div><div class="explorer-content" '+(this.collapsed?'hidden':'')+' aria-busy="'+searching+'">'+this.probabilityControls()+body+'<div class="explorer-foot"><span>'+esc([label,total].filter(Boolean).join(' · '))+'</span>'+((settings?.source!=='local'||['masters','lichess'].includes(settings?.master_source))?ui('<a href="https://lichess.org/analysis" target="_blank" rel="noopener noreferrer" title="Données de l’explorateur Lichess">Lichess ↗</a>'):'')+'</div></div>';
 }
 async click(event){
  const action=event.target.closest?.('[data-explorer-action]');
  if(action&&this.host.contains(action)){
   if(action.dataset.explorerAction==='probability-retry')return this.probability.update({force:true,immediate:true});
   if(action.dataset.explorerAction==='evaluation')return this.toggleEvaluations();
   if(action.dataset.explorerAction==='settings')return this.openSettings();
   if(action.dataset.explorerAction==='preparation-refresh')return this.refreshPreparation();
   if(action.dataset.explorerAction==='retry')return this.settings?this.update({immediate:true,force:true}):this.loadSettings();
   if(action.dataset.explorerAction==='collapse'){
    this.collapsed=!this.collapsed;
    if(this.collapsed){this.stopPreparation();this.probability.stop();this.stopEvaluations();clearTimeout(this.timer);this.controller?.abort();this.sequence++;this.loading=false;this.render();}
    else this.update({immediate:true,force:true});
    return;
   }
  }
  const row=event.target.closest?.('[data-explorer-move]');if(!row||!this.host.contains(row))return;
  return this.play(row.dataset.explorerMove);
 }
 async play(uci){
  if(this.disposed||this.loading||this.playing||this.board.disposed||this.board.busy||this.board.inputLocked||!this.data||this.dataFen!==this.board.node().fen||!this.data.moves.some(m=>m.uci===uci))return false;
  this.stopEvaluations();this.playing=true;this.render();
  try{return await this.board.tryMove(uci.slice(0,2),uci.slice(2,4),uci);}
  finally{this.playing=false;if(!this.disposed){this.update();this.render();this.startEvaluations();}}
 }
 openSettings(){
  if(this.disposed||!this.settings)return;
  this.connection?.dispose();
  const dialog=modal(t('Réglages de l’explorateur'),explorerSettingsHtml(this.settings,this.getBases()),{submit:t('Appliquer'),onSubmit:async (fd,submittedForm)=>{
   const next=readExplorerSettings(fd,this.settings,submittedForm);
   const saved=await api('/api/explorer/settings',{method:'PATCH',body:next});
   if(this.disposed||!dialog.open||dialog.querySelector('form')!==submittedForm)return;this.settings=saved;this.update({immediate:true,force:true});
  }});
  this.dialog=dialog;const form=dialog.querySelector('form');this.dialogForm=form;form.noValidate=true;
  const toggle=()=>{const source=form.elements.source.value,reference=form.elements.master_source.value;form.querySelectorAll('[data-source-settings]').forEach(el=>el.hidden=el.dataset.sourceSettings!==source);form.querySelectorAll('[data-reference-settings]').forEach(el=>el.hidden=el.dataset.referenceSettings!==reference);const custom=form.elements.engine_mode.value==='depth';form.querySelectorAll('[data-engine-depth]').forEach(el=>el.hidden=!custom);form.elements.engine_depth.disabled=!custom;form.elements.engine_depth.required=custom;};
  form.elements.source.onchange=toggle;form.elements.master_source.onchange=toggle;form.elements.engine_mode.onchange=toggle;toggle();
  const connection=new ExplorerConnection(form.querySelector('[data-explorer-connection]'),{isActive:()=>!this.disposed&&dialog.open&&dialog.querySelector('form')===form,onChanged:()=>this.update({immediate:true,force:true})});
  this.connection=connection;dialog.addEventListener('close',()=>connection.dispose(),{once:true});
 }
 dispose(){
  this.stopPreparation();globalThis.document?.removeEventListener?.('visibilitychange',this.onVisibilityChange);
  this.stopEvaluations();this.probability.dispose();this.colorController?.abort();this.host.removeEventListener('change',this.onColorChange);this.disposed=true;this.connection?.dispose();this.sequence++;clearTimeout(this.timer);this.controller?.abort();this.settingsController.abort();this.host.removeEventListener('click',this.onClick);
  if(this.dialog?.open&&this.dialog.querySelector('form')===this.dialogForm)this.dialog.close();
 }
}
