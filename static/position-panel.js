import {t,ui,locale} from './i18n.js';
import {api,esc} from './api.js';

const PAGE_SIZE=50;
const number=value=>new Intl.NumberFormat(locale()).format(Number(value)||0);
const positionKey=fen=>String(fen||'').trim().split(/\s+/).slice(0,4).join(' ');
const plural=(n,singular,multiple=singular+'s')=>Number(n)===1?singular:multiple;
const entryCount=count=>number(count)+' '+plural(count,t('partie ou exercice'),t('parties ou exercices'));
const known=value=>value&& !/^[?\s.]+$/.test(String(value))?String(value):'';

export function positionBasesHtml(data,{disabled=false}={}){
 return (data?.bases||[]).map((base,index)=>'<li><button type="button" class="position-base-choice" data-position-action="base" data-base-index="'+index+'" '+(disabled?'disabled':'')+'><span class="position-base-text"><strong>'+esc(base.base_name||t('Sans nom'))+'</strong>'+(base.folder_path?'<small>'+esc(base.folder_path)+'</small>':'')+'<small>'+number(base.total_occurrences)+' '+plural(base.total_occurrences,'occurrence')+(base.complete===false?t(' · Recherche partielle'):'')+'</small></span><span class="position-base-count"><b>'+number(base.total_entries)+'</b><small>'+plural(base.total_entries,t('partie'),t('parties'))+'</small></span><span aria-hidden="true">›</span></button></li>').join('');
}

export function positionMatchesHtml(data,{disabled=false}={}){
 return (data?.matches||[]).map((entry,index)=>{
  const h=entry.headers||{},occurrences=entry.occurrences||[],count=Number(entry.occurrence_count)||occurrences.length;
  const date=known(h.Date)&&!String(h.Date).startsWith('0000')?h.Date:known(h.UTCDate)||'—';
  const player=(side,label)=>'<span class="position-player"><span class="position-player-side">'+label+'</span><span class="position-player-name">'+esc(known(h[side])||'?')+'</span><small>'+esc(known(h[side+'Elo'])||'—')+'</small></span>';
  const names=known(h.White)||known(h.Black)?player('White',t('Blancs'))+player('Black',t('Noirs')):'<strong class="position-entry-title">'+esc(entry.entry_title||t('Sans titre'))+'</strong>';
  const opening=occurrences[0],label=t('Ouvrir ')+(entry.entry_title||t('la partie'))+t(' à ')+(opening?.label||t('cette position'));
  const links=occurrences.length>1||occurrences.some(item=>item.variation);
  return '<li class="position-match"><button type="button" class="position-game-link" data-position-action="open" data-entry-index="'+index+'" data-occurrence-index="0" '+(disabled||!opening?'disabled':'')+' aria-label="'+esc(label)+'"><span class="position-players">'+names+'</span><span class="position-game-meta"><strong>'+esc(h.Result||'*')+'</strong><time>'+esc(date)+'</time></span></button>'+(links?'<div class="position-occurrences">'+occurrences.map((occurrence,occurrenceIndex)=>'<button type="button" data-position-action="open" data-entry-index="'+index+'" data-occurrence-index="'+occurrenceIndex+'" '+(disabled?'disabled':'')+' title="'+esc(t('Ouvrir à ')+(occurrence.label||t('cette position'))+(occurrence.variation?t(' · Variante'):''))+'">'+esc(occurrence.label||t('Position initiale'))+(occurrence.variation?ui('<span class="position-variation">Var.</span>'):'')+'</button>').join('')+'</div>':'')+(count>occurrences.length?'<small class="position-occurrence-limit">'+number(occurrences.length)+t(' sur ')+number(count)+ui(' occurrences affichées dans cette partie.</small>'):'')+'</li>';
 }).join('');
}

export class PositionPanel{
 constructor(host,{board,visible=true,onOpenEntry=async()=>{},onOpenBase=null}={}){
  this.host=host;this.board=board;this.visible=visible;this.onOpenEntry=onOpenEntry;this.onOpenBase=onOpenBase;this.disposed=false;this.sequence=0;this.data=null;this.summary=null;this.selectedBase=null;this.snapshot=null;this.key=null;this.error='';this.loading=false;this.opening=false;this.nextOffset=0;
  this.onClick=event=>{this.click(event).catch(error=>{if(!this.disposed&&this.visible){this.error=error.message||String(error);this.render();}});};
  host.addEventListener('click',this.onClick);this.ready=this.update({immediate:true});
 }
 takeSnapshot(){const fen=this.board.node()?.fen;if(!fen)throw new Error(t('Aucune position à rechercher.'));return {fen,key:positionKey(fen),entryId:this.board.doc?.id??null,baseId:this.board.doc?.base_id??null};}
 current(snapshot){if(!snapshot||this.disposed||!this.visible||this.board.disposed||this.board.training)return false;try{const current=this.takeSnapshot();return snapshot.entryId===current.entryId&&snapshot.baseId===current.baseId&&snapshot.key===current.key;}catch{return false;}}
 cancel(){this.sequence++;clearTimeout(this.timer);this.timer=null;this.controller?.abort();this.controller=null;this.loading=false;}
 update({force=false,immediate=false}={}){
  if(this.disposed)return Promise.resolve();
  if(!this.visible||this.board.disposed||this.board.training){this.cancel();this.key=null;return Promise.resolve();}
  let snapshot;try{snapshot=this.takeSnapshot();}catch(error){this.cancel();this.key=null;this.data=null;this.summary=null;this.selectedBase=null;this.snapshot=null;this.error=error.message;this.render();return Promise.resolve();}
  const unchanged=snapshot.key===this.key&&snapshot.entryId===this.snapshot?.entryId&&snapshot.baseId===this.snapshot?.baseId;
  if(!force&&unchanged){this.render();return Promise.resolve();}
  this.cancel();if(!unchanged)this.selectedBase=null;this.key=snapshot.key;this.snapshot=snapshot;this.data=null;this.summary=null;this.nextOffset=0;this.error='';this.loading=true;this.render();const sequence=this.sequence,baseId=this.selectedBase?.base_id??null;
  if(immediate)return this.search(snapshot,sequence,0,baseId);
  this.timer=setTimeout(()=>{this.timer=null;this.search(snapshot,sequence,0,baseId);},250);return Promise.resolve();
 }
 setVisible(visible){const changed=this.visible!==Boolean(visible);this.visible=Boolean(visible);if(!this.visible){this.cancel();this.key=null;return Promise.resolve();}if(changed)return this.update({immediate:true});return Promise.resolve();}
 async search(snapshot,sequence,offset,baseId=null){
  const valid=()=>sequence===this.sequence&&baseId===(this.selectedBase?.base_id??null)&&this.current(snapshot);
  if(!valid())return;
  const controller=new AbortController();this.controller=controller;
  try{
   const query=new URLSearchParams({fen:snapshot.fen,offset:String(offset),limit:String(PAGE_SIZE)});
   if(baseId===null)query.set('summary','true');else query.set('base_id',String(baseId));
   const result=await api('/api/library/position?'+query,{signal:controller.signal});
   if(!valid())return;
   if(baseId===null){this.summary={...result,bases:Array.isArray(result.bases)?result.bases:[],matches:[],has_more:false};this.data=this.summary;this.nextOffset=0;}
   else{
    const received=Array.isArray(result.matches)?result.matches:[],existing=offset?this.data?.matches||[]:[],ids=new Set(existing.map(entry=>entry.entry_id));
    this.data={...result,matches:[...existing,...received.filter(entry=>!ids.has(entry.entry_id))],has_more:Boolean(result.has_more)&&received.length>0};this.nextOffset=offset+received.length;
   }
   this.loading=false;this.error='';this.render();
  }catch(error){if(!valid()||error.name==='AbortError')return;this.loading=false;this.error=error.message||String(error);this.render();}
  finally{if(this.controller===controller)this.controller=null;}
 }
 async selectBase(index){
  if(this.loading||this.opening||this.board.busy||this.board.inputLocked||!this.current(this.snapshot))return;
  const base=this.summary?.bases?.[index];if(!base)return;
  this.cancel();this.selectedBase=base;this.data=null;this.nextOffset=0;this.loading=true;this.error='';this.render();return this.search(this.snapshot,this.sequence,0,base.base_id);
 }
 async back(){
  if(this.opening||this.board.busy||this.board.inputLocked||!this.current(this.snapshot))return;
  this.cancel();this.selectedBase=null;this.data=this.summary;this.nextOffset=0;this.error='';this.loading=!this.summary;this.render();
  if(!this.summary)return this.search(this.snapshot,this.sequence,0);
 }
 async more(){if(!this.selectedBase||this.loading||this.opening||!this.data?.has_more||!this.current(this.snapshot))return;this.cancel();this.loading=true;this.error='';this.render();return this.search(this.snapshot,this.sequence,this.nextOffset,this.selectedBase.base_id);}
 render(){
  if(this.disposed||!this.visible||this.board.disposed)return;
  const data=this.data,selected=this.selectedBase,disabled=this.loading||this.opening||this.board.busy||this.board.inputLocked;
  let body='';
  if(selected)body+=ui('<div class="position-selected-base"><button type="button" class="quiet" data-position-action="back" aria-label="Retour à toutes les bases" ')+(this.opening||this.board.busy||this.board.inputLocked?'disabled':'')+ui('>← Bases</button><span><strong>')+esc(selected.base_name)+'</strong>'+(selected.folder_path?'<small>'+esc(selected.folder_path)+'</small>':'')+'</span></div>';
  if(this.error)body+='<p class="position-error" role="alert">'+esc(this.error)+'</p>';
  if(data){
   const total=Number(data.total_entries)||0,occurrences=Number(data.total_occurrences)||0;
   body+=total?'<p class="position-summary" role="status">'+(!selected?number(data.bases?.length)+' '+plural(data.bases?.length,t('base'))+' · ':'')+entryCount(total)+' · '+number(occurrences)+' '+plural(occurrences,'occurrence')+'</p>':ui('<p class="position-empty" role="status">Aucune correspondance ')+(selected?t('dans cette base'):t('dans la bibliothèque'))+(data.complete===false?t(' parmi les parties vérifiées'):'')+'.</p>';
   if(selected&&data.matches?.length)body+='<ul class="position-matches">'+positionMatchesHtml(data,{disabled})+'</ul>';
   else if(!selected&&data.bases?.length)body+='<ul class="position-bases">'+positionBasesHtml(data,{disabled})+'</ul>';
   if(data.complete===false||Number(data.skipped_entries)>0)body+=ui('<p class="position-warning" role="status">Recherche partielle : ')+(Number(data.skipped_entries)>0?number(data.skipped_entries)+' '+plural(data.skipped_entries,t('partie n’a pas pu être vérifiée'),t('parties n’ont pas pu être vérifiées'))+'.':t('certaines parties ne sont pas encore disponibles ou n’ont pas pu être vérifiées.'))+'</p>';
   if(selected&&data.has_more)body+='<button type="button" class="position-more" data-position-action="more" '+(this.loading||this.opening?'disabled':'')+'>'+(this.loading?t('Recherche…'):t('Afficher la suite'))+' <span>'+number(data.matches.length)+' / '+number(total)+'</span></button>';
  }
  if(this.loading&&!data)body+=ui('<p class="position-empty" role="status">Recherche ')+(selected?t('dans cette base'):t('dans la bibliothèque'))+'…</p>';
  this.host.innerHTML=ui('<section class="panel position-panel" aria-label="Position dans la bibliothèque" aria-busy="')+(this.loading?'true':'false')+ui('"><div class="position-toolbar"><span>Dans la bibliothèque</span><button type="button" class="quiet" data-position-action="refresh" title="Actualiser la recherche" aria-label="Actualiser la recherche" ')+(this.loading||this.opening?'disabled':'')+'>↻</button></div>'+body+ui('<p class="position-hint">Bases personnelles : lignes principales et variantes. Grandes bases de référence : ligne principale seulement. Trait et droits de jeu identiques ; compteurs de coups ignorés.</p></section>');
 }
 async click(event){
  const button=event.target.closest?.('[data-position-action]');if(!button||!this.host.contains(button)||button.disabled||this.disposed||!this.visible)return;
  const action=button.dataset.positionAction;
  if(action==='refresh')return this.update({force:true,immediate:true});
  if(action==='more')return this.more();
  if(action==='back')return this.back();
  if(action==='base')return this.selectBase(Number(button.dataset.baseIndex));
  if(action!=='open'||!this.selectedBase||this.loading||this.opening||this.board.busy||this.board.inputLocked)return;
  const snapshot=this.snapshot;
  if(!this.current(snapshot)){await this.update({immediate:true});return;}
  const entry=this.data?.matches?.[Number(button.dataset.entryIndex)];if(!entry)return;
  const sequence=this.sequence,path=this.board.path,baseId=this.selectedBase.base_id,isCurrent=()=>sequence===this.sequence&&baseId===this.selectedBase?.base_id&&this.current(snapshot)&&path===this.board.path;
  this.opening=true;this.error='';this.render();
  try{
   const occurrence=entry.occurrences?.[Number(button.dataset.occurrenceIndex)];
   if(occurrence&&typeof occurrence.path==='string'&&typeof occurrence.fen==='string')await this.onOpenEntry(entry.entry_id,{path:occurrence.path,fen:occurrence.fen,isCurrent});
  }catch(error){if(isCurrent())this.error=error.message||String(error);}
  finally{this.opening=false;if(isCurrent())this.render();}
 }
 dispose(){this.disposed=true;this.cancel();this.host.removeEventListener('click',this.onClick);}
}
