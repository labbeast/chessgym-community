import {esc} from './api.js';
import {t,locale} from './i18n.js';
import {entryNavigationState} from './entry-navigation.js';
import {analysisIdentity,isPristineAnalysis} from './workspace-drafts.js';
import {uiIcon} from './ui-icons.js';

const positive=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const validIdentity=value=>typeof value==='string'&&value.length<=240&&(/^entry:[1-9]\d*$/.test(value)||/^free:.+/.test(value))?value:null;
const timestamp=value=>{if(value==null||value==='')return null;const n=typeof value==='number'?value:Date.parse(value);return Number.isFinite(n)&&Math.abs(n)<=8640000000000000?n:null;};
const iso=value=>{const n=timestamp(value);return n===null?null:new Date(n).toISOString();};
const baseFor=(bases,id)=>Array.isArray(bases)?bases.find(base=>positive(base.id)===id):null;
const text=value=>typeof value==='string'?value.trim():'';
const range=(index,total)=>Number.isInteger(index)&&index>0&&Number.isInteger(total)&&total>=index?{index,total}:{index:null,total:null};
const fallbackTitle=id=>id?t('Partie {id}',{id}):t('Analyse libre');

export function boardRecentMetadata(doc,entryNavigation,bases,openedAt=new Date().toISOString()){
 const entryId=positive(doc?.id),baseId=positive(doc?.base_id)||positive(doc?.reference_source?.base_id),position=entryNavigationState(entryNavigation,doc);
 const location=range(position?position.index+1:null,position?.total);
 return {identity:analysisIdentity(doc),entryId,baseId,title:text(doc?.title),
  baseName:baseFor(bases,baseId)?.name||'',...location,openedAt:iso(openedAt)};
}

function annotations(store,identity){
 if(!identity)return null;
 if(store?.info?.('annotation:'+identity)?.conflict)return {nodes:{conflict:true}};
 return store?.items?.get('annotation:'+identity)?.data??store?.get?.('annotation:'+identity)??null;
}
function draftFor(store,identity,snapshot){
 const notes=annotations(store,identity),doc=snapshot?.doc;
 if(!doc)return !!Object.keys(notes?.nodes||{}).length;
 return doc.id?!!doc.analysis_dirty||!!Object.keys(notes?.nodes||{}).length:!isPristineAnalysis(snapshot,notes);
}

// Only compact metadata leaves this model. Saved entries need no retained PGN,
// and synchronization dirtiness is never interpreted as an unsaved chess edit.
export function boardMenuModel({store,doc,entryNavigation,bases=[]}={}){
 const items=store?.items||new Map(),currentIdentity=analysisIdentity(doc),viewFor=id=>items.get('view:'+id)?.data||{};
 const snapshotFor=id=>{
  const key='document:'+id,own=items.get(key)?.data;if(own?.doc)return {key,snapshot:{...own,...viewFor(id),doc:own.doc}};
  const last=items.get('analysis')?.data;if(last?.doc&&analysisIdentity(last.doc)===id)return {key:'analysis',snapshot:{...last,...viewFor(id),doc:last.doc}};
  return {key:null,snapshot:null};
 };
 const currentView=currentIdentity?viewFor(currentIdentity):{},currentSnapshot={...currentView,doc};
 const current={...boardRecentMetadata(doc,entryNavigation,bases,currentView.boardRecent?.openedAt??null),draft:draftFor(store,currentIdentity,currentSnapshot),snapshotKey:currentIdentity?snapshotFor(currentIdentity).key:null};
 current.title||=fallbackTitle(current.entryId);current.baseName||=entryNavigation?.remote?.played?t('Mes parties'):'';
 if(!doc||!doc.id&&isPristineAnalysis(currentSnapshot,annotations(store,currentIdentity))){current.title=t('Analyse libre');current.draft=false;}
 if(current.draft)current.title=text(currentView.draftLabel).slice(0,160)||current.title;
 const identities=new Set();
 for(const [key,item] of items){
  if(!item?.data)continue;
  if(key.startsWith('view:')||key.startsWith('document:')){const id=validIdentity(key.slice(key.indexOf(':')+1));if(id)identities.add(id);}
  else if(key==='analysis'){const id=validIdentity(analysisIdentity(item.data.doc));if(id)identities.add(id);}
 }
 const recents=[];
 for(const identity of identities){
  if(identity===currentIdentity)continue;
  const viewItem=items.get('view:'+identity),view=viewItem?.data||{},stored=view.boardRecent||{},found=snapshotFor(identity),snapshot=found.snapshot;
  // A free board needs its actual document to be recoverable. Ignore old empty
  // boards even when their view settings remain in the workspace manifest.
  if(identity.startsWith('free:')&&(!snapshot?.doc||isPristineAnalysis(snapshot,annotations(store,identity))))continue;
  const entryId=identity.startsWith('entry:')?positive(identity.slice(6)):null;
  if(identity.startsWith('entry:')&&!entryId)continue;
  const navigation=view.entryNavigation||snapshot?.entryNavigation;
  const baseId=positive(snapshot?.doc?.base_id)||positive(snapshot?.doc?.reference_source?.base_id)||positive(stored.baseId)||positive(navigation?.baseId);
  const fallback=boardRecentMetadata(snapshot?.doc||{id:entryId,base_id:baseId},navigation,bases,null);
  const metadataRange=range(stored.index,stored.total),snapshotRange=range(fallback.index,fallback.total);
  const dates=[stored.openedAt,viewItem?.updated_at,found.key&&items.get(found.key)?.updated_at].map(timestamp).filter(value=>value!==null);
  const draft=draftFor(store,identity,snapshot),title=text(snapshot?.doc?.title)||text(stored.title)||fallbackTitle(entryId);
  recents.push({identity,entryId,baseId,title:draft?text(view.draftLabel).slice(0,160)||title:title,
   baseName:baseFor(bases,baseId)?.name||stored.baseName||(navigation?.remote?.played?t('Mes parties'):''),
   ...(metadataRange.index!==null?metadataRange:snapshotRange),
   openedAt:iso(timestamp(stored.openedAt)??(dates.length?Math.max(...dates):null)),
   draft,snapshotKey:found.key});
 }
 recents.sort((a,b)=>(timestamp(b.openedAt)??-Infinity)-(timestamp(a.openedAt)??-Infinity)||a.identity.localeCompare(b.identity));
 return {current,recents:recents.slice(0,20)};
}

export function boardRelativeDate(value,now=Date.now()){
 const instant=timestamp(value);if(instant===null)return '';
 const seconds=(instant-now)/1000,absolute=Math.abs(seconds);let unit='second',size=1;
 for(const [candidate,span] of [['year',31536000],['month',2592000],['week',604800],['day',86400],['hour',3600],['minute',60]])if(absolute>=span){unit=candidate;size=span;break;}
 return new Intl.RelativeTimeFormat(locale(),{numeric:'auto'}).format(Math.round(seconds/size),unit);
}
function line(item,{current=false,now=Date.now()}={}){
 const context=[item.baseName,item.index&&item.total?t('Partie {index} sur {total}',{index:item.index,total:item.total}):''].filter(Boolean).join(' · ');
 const stamp=boardRelativeDate(item.openedAt,now);
 const actions=item.draft&&item.identity;
 return `<div class="board-recent-item"${actions?` data-board-draft="${esc(item.identity)}"`:''}><button type="button" class="board-recent-row${current?' board-recent-current':''}" ${current?'data-board-command="current" aria-current="true"':`data-board-recent="${esc(item.identity)}"`}><span class="board-recent-heading">${uiIcon(item.draft?'drafts':'analysis','board-menu-icon')}<span class="board-recent-title" title="${esc(item.title)}">${esc(item.title)}</span>${item.draft?'<span class="board-activity-dot" aria-hidden="true"></span>':''}${current?`<span class="board-recent-current-label" title="${esc(t('Échiquier actuel'))}">${esc(t('Actuel'))}</span>`:''}</span><span class="board-recent-meta"><span class="board-recent-info">${context?`<span class="board-recent-context" title="${esc(context)}">${esc(context)}</span>`:''}${item.draft?`<span class="board-recent-draft">${esc(t('Brouillon non enregistré'))}</span>`:''}</span>${stamp?`<time datetime="${esc(item.openedAt)}" title="${esc(new Date(item.openedAt).toLocaleString(locale()))}">${esc(stamp)}</time>`:''}</span></button>${actions?`<button type="button" class="board-draft-options" data-board-draft-options="${esc(item.identity)}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('Actions du brouillon « {title} »',{title:item.title}))}" title="${esc(t('Actions du brouillon'))}">⋯</button>`:''}</div>`;
}
export function boardMenuHtml(model,{now=Date.now()}={}){
 return `<div class="board-menu-content"><div class="board-menu-actions"><button type="button" data-board-command="new">${uiIcon('plus','board-menu-icon')}${esc(t('Nouvelle analyse'))}</button></div><details class="board-recent-section" open><summary>${uiIcon('history','board-menu-icon')}${esc(t('Récemment ouverts'))}</summary><div class="board-recent-list">${line(model.current||{title:t('Analyse libre')},{current:true,now})}${(model.recents||[]).map(item=>line(item,{now})).join('')}</div></details><button type="button" class="board-menu-manage" data-board-command="manage">${uiIcon('drafts','board-menu-icon')}${esc(t('Gérer les brouillons…'))}</button></div>`;
}
