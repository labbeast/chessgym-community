import {esc} from './api.js';
import {t} from './i18n.js';
import {boardRecentMetadata,boardRelativeDate} from './board-menu.js';
import {analysisIdentity,analysisSnapshot,annotationFor,draftKeys,isPristineAnalysis} from './workspace-drafts.js';

// Draft management is not limited to the twenty most recently visited boards.
export function draftManagerModel({store,doc,bases=[]}={}){
 const snapshots=new Map(),rows=[],currentIdentity=analysisIdentity(doc);
 for(const [key,item] of store?.items||[]){
  if(key!=='analysis'&&!key.startsWith('document:'))continue;
  const local=analysisSnapshot(store,key),snapshot=local?.doc?local:item.conflict?.data;if(!snapshot?.doc)continue;
  const identity=analysisIdentity(snapshot.doc)||(key.startsWith('document:')?key.slice(9):null);
  if(!snapshots.has(identity||key)||key.startsWith('document:'))snapshots.set(identity||key,{key,item,snapshot,identity,available:!!local?.doc});
 }
 for(const {key,item,snapshot,identity,available} of snapshots.values()){
  const notes=annotationFor(store,snapshot,key),conflicts=[...new Set([key,...draftKeys(store,key)])].filter(key=>store.info(key)?.conflict);
  const draft=snapshot.doc.id?!!snapshot.doc.analysis_dirty||!!Object.keys(notes?.nodes||{}).length:!isPristineAnalysis(snapshot,notes);
  if(!draft&&!conflicts.length)continue;
  const view=identity?store.get('view:'+identity)||{}:{},recent=view.boardRecent||{};
  const updatedAt=item.updated_at||recent.openedAt||null;
  const metadata=boardRecentMetadata(snapshot.doc,snapshot.entryNavigation,bases,updatedAt);
  const row={key,identity,current:!!identity&&identity===currentIdentity,conflicts,updatedAt,available,
   title:String(view.draftLabel||snapshot.doc.title||(snapshot.doc.id?t('Partie {id}',{id:snapshot.doc.id}):t('Analyse libre'))),
   baseName:metadata.baseName||recent.baseName||'',index:metadata.index??recent.index,total:metadata.total??recent.total};
  rows.push(row);
 }
 return rows.sort((a,b)=>Number(b.current)-Number(a.current)||(Date.parse(b.updatedAt)||0)-(Date.parse(a.updatedAt)||0)||a.title.localeCompare(b.title));
}

export function workspaceConflictHtml(keys){
 return keys.map(key=>'<div class="workspace-draft-conflict"><p>'+esc(t(key.startsWith('annotation:')?'Deux versions de ces annotations sont conservées.':'Deux versions de ce brouillon sont conservées.'))+'</p><div class="actions">'+['remote','local'].map(choice=>'<button type="button" data-resolve-key="'+esc(key)+'" data-choice="'+choice+'">'+esc(t(choice==='remote'?'Garder celle du serveur':'Garder celle de cet appareil'))+'</button>').join('')+'</div></div>').join('');
}

export function draftManagerHtml(rows,{now=Date.now()}={}){
 if(!rows.length)return '<p class="workspace-draft-empty muted">'+esc(t('Aucun brouillon enregistré.'))+'</p>';
 return '<ul class="workspace-draft-list">'+rows.map(row=>{
  const context=[row.baseName,row.index&&row.total?t('Partie {index} sur {total}',{index:row.index,total:row.total}):''].filter(Boolean).join(' · ');
  const stamp=boardRelativeDate(row.updatedAt,now);
  const disabled=row.available===false?' disabled':'';
  const deleteLabel=esc(t('Supprimer le brouillon « {title} »',{title:row.title}));
  return `<li class="workspace-draft-row"><div class="workspace-draft-main"><button type="button" class="workspace-draft-open" data-workspace-document="${esc(row.key)}"${disabled}${row.current?' aria-current="true"':''}><span class="workspace-draft-heading board-recent-heading"><span class="workspace-draft-title board-recent-title" title="${esc(row.title)}">${esc(row.title)}</span><span class="board-activity-dot" aria-hidden="true"></span>${row.current?`<span class="board-recent-current-label">${esc(t('Actuel'))}</span>`:''}</span><span class="workspace-draft-meta board-recent-meta"><span class="board-recent-info">${context?`<span class="board-recent-context" title="${esc(context)}">${esc(context)}</span>`:''}<span class="board-recent-draft">${esc(t('Brouillon non enregistré'))}</span></span>${stamp?`<time datetime="${esc(row.updatedAt)}">${esc(stamp)}</time>`:''}</span></button><button type="button" class="workspace-draft-delete danger" data-delete-workspace="${esc(row.key)}"${disabled} aria-label="${deleteLabel}" title="${deleteLabel}">×</button></div>${workspaceConflictHtml(row.conflicts)}</li>`;
 }).join('')+'</ul>';
}
