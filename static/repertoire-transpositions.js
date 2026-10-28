import {t,ui} from './i18n.js';
import {api,esc} from './api.js';

const key=fen=>String(fen||'').trim().split(/\s+/).slice(0,4).join(' ');
export function validateTranspositionDocument(doc,target){
 if(!doc||Number(doc.id)!==Number(target.entry_id)||Number(doc.base_id)!==Number(target.base_id)||doc.revision!==target.revision||!doc.nodes?.some(node=>node.path===target.path&&key(node.fen)===target.position_key))throw new Error(t('Cette ligne a changé depuis la recherche. Actualise les transpositions avant de l’ouvrir.'));
 return true;
}

// Parent owns the host and event listeners; this controller survives its renders.
export class TranspositionNavigation{
 constructor({getSnapshot,getBases,isCurrent,onOpen,onUpdate}){Object.assign(this,{getSnapshot,getBases,isCurrent,onOpen,onUpdate});this.open=false;this.baseId=null;this.sameOrder=false;this.data=null;this.snapshot=null;this.error='';this.busy=false;this.opening=false;this.sequence=0;this.disposed=false;}
 invalidate(){this.sequence++;this.controller?.abort();this.data=null;this.snapshot=null;this.busy=false;this.opening=false;this.error='';}
 html({disabled=false}={}){
  const bases=this.getBases().filter(base=>base.settings?.is_repertoire&&!base.reference);if(!bases.length||!this.onOpen)return '';
  const locked=disabled||this.busy||this.opening;
  let html='<section class="repertoire-transpositions"><button type="button" class="quiet" data-repertoire-action="transposition-toggle" aria-expanded="'+this.open+'">'+esc(t('Transpositions de cette position'))+'</button>';
  if(!this.open)return html+'</section>';
  html+='<p class="hint">'+esc(t('Compare les ordres de coups qui aboutissent exactement à cette position, avec le même trait et les mêmes droits de roque et de prise en passant.'))+'</p><div class="transposition-filters"><label>'+esc(t('Répertoire à parcourir'))+'<select data-repertoire-action="transposition-base" '+(locked?'disabled':'')+'><option value="">'+esc(t('Tous les répertoires'))+'</option>'+bases.map(base=>'<option value="'+base.id+'" '+(Number(this.baseId)===base.id?'selected':'')+'>'+esc(base.name)+'</option>').join('')+'</select></label><label class="check"><input type="checkbox" data-repertoire-action="transposition-same" '+(this.sameOrder?'checked':'')+' '+(locked?'disabled':'')+'>'+esc(t('Inclure aussi le même ordre de coups'))+'</label><button type="button" data-repertoire-action="transposition-search" '+(locked?'disabled':'')+'>'+esc(t(this.busy?'Recherche des transpositions…':'Rechercher cette position'))+'</button></div>';
  if(this.error)html+='<p role="alert" class="error-text">'+esc(this.error)+'</p>';
  if(this.busy)html+='<p role="status">'+esc(t('Recherche des transpositions…'))+'</p>';
  if(this.data&&!this.busy){
   html+='<p class="transposition-summary" role="status">'+esc(this.data.total)+' '+esc(t('occurrence(s) trouvée(s)'))+(this.data.partial?' · '+esc(t('Recherche partielle')):'')+'</p>';
   if(this.data.partial)html+='<p class="hint">'+esc(t(this.data.message))+'</p>';
   if(!this.data.matches.length)html+='<p class="muted">'+esc(t(this.data.partial?'Aucune transposition trouvée dans les lignes examinées.':'Aucune transposition trouvée avec cette sélection.'))+'</p>';
   html+='<ol class="transposition-matches">'+this.data.matches.map((match,index)=>'<li><div class="transposition-source"><strong>'+esc(match.title)+'</strong><span>'+esc(match.base_name)+'</span></div><small>'+esc(t(match.same_move_order?'Même ordre de coups':'Autre ordre de coups'))+'</small><p class="transposition-line">'+esc(match.move_order||t('Position initiale'))+'</p>'+(match.comment?'<p class="transposition-comment">'+esc(match.comment)+'</p>':'')+'<p class="hint">'+esc(t('Suites disponibles'))+' : '+esc(match.continuations?.map(move=>move.san).join(' · ')||t('Fin de ligne'))+(match.continuation_count>match.continuations?.length?'…':'')+'</p><button type="button" data-repertoire-action="transposition-open" data-index="'+index+'" '+(locked?'disabled':'')+'>'+esc(t('Ouvrir cette ligne à la même position'))+'</button></li>').join('')+'</ol>';
   if(this.data.offset>0||this.data.next_offset!==null)html+='<nav class="transposition-pages" aria-label="'+esc(t('Pages des transpositions'))+'"><button type="button" data-repertoire-action="transposition-prev" '+(locked||this.data.offset<=0?'disabled':'')+'>'+esc(t('Précédent'))+'</button><span>'+Math.min(this.data.offset+1,this.data.total)+'–'+Math.min(this.data.offset+this.data.matches.length,this.data.total)+' / '+this.data.total+'</span><button type="button" data-repertoire-action="transposition-next" '+(locked||this.data.next_offset===null?'disabled':'')+'>'+esc(t('Suivant'))+'</button></nav>';
  }else if(!this.busy&&!this.error)html+='<p class="hint">'+esc(t('Lance la recherche pour comparer les chemins jusqu’à la position affichée.'))+'</p>';
  return html+'</section>';
 }
 async click(button){
  const action=button.dataset.repertoireAction;
  if(this.disposed||button.disabled)return false;
  if(action==='transposition-toggle'){this.open=!this.open;if(!this.open)this.invalidate();this.onUpdate();return true;}
  if(this.busy||this.opening)return false;
  if(action==='transposition-search')return this.search();
  if(action==='transposition-prev')return this.search(Math.max(0,(this.data?.offset||0)-(this.data?.limit||20)));
  if(action==='transposition-next'&&this.data?.next_offset!=null)return this.search(this.data.next_offset);
  if(action==='transposition-open')return this.openMatch(Number(button.dataset.index));
  return false;
 }
 change(control){if(this.disposed||this.busy||this.opening)return;const action=control.dataset.repertoireAction;if(action==='transposition-base')this.baseId=control.value?Number(control.value):null;else if(action==='transposition-same')this.sameOrder=control.checked;else return;this.invalidate();this.onUpdate();}
 async search(offset=0){
  if(this.disposed||this.busy||this.opening)return false;
  const snapshot=this.getSnapshot();if(!this.isCurrent(snapshot))return false;
  const sequence=++this.sequence,controller=new AbortController();this.controller?.abort();this.controller=controller;this.busy=true;this.error='';this.snapshot=snapshot;this.onUpdate();
  try{
   const data=await api('/api/repertoires/transpositions',{method:'POST',body:{pgn:snapshot.pgn,path:snapshot.path,...(snapshot.entryId?{entry_id:snapshot.entryId}:{}),...(this.baseId?{base_id:this.baseId}:{}),different_only:!this.sameOrder,offset,limit:20},signal:controller.signal});
   if(this.disposed||sequence!==this.sequence||!this.isCurrent(snapshot))return false;
   this.data=data;return true;
  }catch(error){if(this.disposed||sequence!==this.sequence||!this.isCurrent(snapshot)||error.name==='AbortError')return false;this.error=error.message;this.data=null;return false;}
  finally{if(sequence===this.sequence){this.busy=false;if(!this.disposed)this.onUpdate();}}
 }
 async openMatch(index){
  if(this.disposed||this.busy||this.opening||!Number.isInteger(index)||index<0||!this.data?.matches?.[index]||!this.snapshot)return false;
  const snapshot=this.snapshot,sequence=this.sequence;if(!this.isCurrent(snapshot)){this.invalidate();this.onUpdate();return false;}
  const target=structuredClone(this.data.matches[index]);this.opening=true;this.error='';this.onUpdate();
  const current=()=>!this.disposed&&sequence===this.sequence&&this.isCurrent(snapshot);
  try{return await this.onOpen(target,{isCurrent:current});}
  catch(error){if(current()){this.error=error.message;}return false;}
  finally{if(sequence===this.sequence){this.opening=false;if(!this.disposed)this.onUpdate();}}
 }
 dispose(){this.disposed=true;this.invalidate();}
}
