import {t} from './i18n.js';
function entryId(value){
 if(typeof value==='string'){
  const text=value.trim();
  if(!/^\d+$/.test(text))return null;
  value=Number(text);
 }
 return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?value:null;
}

// Capture the displayed order so sorting and filtering stay consistent in analysis.
export function makeEntryNavigation(baseId,entriesOrIds,currentId){
 const base=entryId(baseId),current=entryId(currentId);
 if(base===null||current===null||!Array.isArray(entriesOrIds))return null;
 const ids=[],seen=new Set();
 for(const entry of entriesOrIds){
  const id=entryId(entry&&typeof entry==='object'&&!Array.isArray(entry)?entry.id:entry);
  if(id!==null&&!seen.has(id)){ids.push(id);seen.add(id);}
 }
 return seen.has(current)?{baseId:base,ids}:null;
}

export function entryNavigationState(context,doc){
 if(!context||!doc||(!context.remote?.played&&entryId(doc.base_id)!==entryId(context.baseId)))return null;
 if(context.remote)return context.currentId===entryId(doc.id)&&Number.isInteger(context.index)?{index:context.index,total:context.total,previousId:context.previousId??null,nextId:context.nextId??null}:null;
 const navigation=makeEntryNavigation(context.baseId,context.ids,doc.id);
 if(!navigation)return null;
 const index=navigation.ids.indexOf(entryId(doc.id));
 return {index,total:navigation.ids.length,
  previousId:index>0?navigation.ids[index-1]:null,
  nextId:index+1<navigation.ids.length?navigation.ids[index+1]:null};
}

export function entryNavigationHtml(context,doc,{mobile=false}={}){
 const state=entryNavigationState(context,doc);
 if(!state)return '';
 return `<nav class="analysis-entry-navigation analysis-entry-navigation-${mobile?'mobile':'desktop'}" aria-label="${t('Parties de la base')}"><button type="button" data-action="entry-prev" aria-label="${t('Partie précédente')}" title="${t('Partie précédente')}"${state.previousId===null?' disabled':''}>←</button><output class="analysis-entry-counter" aria-live="polite" aria-label="${t('Partie {index} sur {total}',{index:state.index+1,total:state.total})}">${state.index+1} / ${state.total}</output><button type="button" data-action="entry-next" aria-label="${t('Partie suivante')}" title="${t('Partie suivante')}"${state.nextId===null?' disabled':''}>→</button></nav>`;
}
