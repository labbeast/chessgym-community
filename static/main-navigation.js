import {t} from './i18n.js';
import {esc} from './api.js';
import {EXERCISES} from './exercise-catalog.js';
import {uiIcon} from './ui-icons.js';
const exerciseActivity=(activities,id)=>activities?.has(id)||(id==='exercises'&&EXERCISES.some(item=>activities?.has(item.page)));
const exercisePage=page=>EXERCISES.some(item=>item.page===page)||page==='computer-history';

const navigationIcon=body=>'<svg class="navigation-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+body+'</svg>';
const NAV_ICONS=Object.freeze({
 library:navigationIcon('<rect x="2" y="4" width="5" height="16" rx="1"/><rect x="9" y="2" width="5" height="18" rx="1"/><rect x="16" y="5" width="6" height="15" rx="1"/><path d="M4 8h1m6-2h1m6 3h2M4 17h1m6 0h1m6 0h2"/>'),
 training:navigationIcon('<rect x="4" y="6" width="4" height="12" rx="1"/><rect x="16" y="6" width="4" height="12" rx="1"/><path d="M8 12h8M2 9v6m20-6v6"/>'),
 board:navigationIcon('<path d="M3 3h9v9H3zm9 9h9v9h-9z" fill="currentColor" stroke="none"/><rect x="3" y="3" width="18" height="18" rx="1"/>')
});

export const NAV_GROUPS=Object.freeze([
 {id:'library',label:'Bibliothèque',icon:NAV_ICONS.library,items:[['library','Toutes les bases'],['played','Mes parties'],['repertoire','Mes répertoires']]},
 {id:'training',label:'Entraînement',icon:NAV_ICONS.training,items:[['exercises','Exercices'],['training-plan','Mon entraînement'],['reviews','Révisions'],['reading','Lecture'],['puzzles','Puzzles'],['computer','Jouer contre l’ordinateur'],['guess','Deviner le coup'],['blindfold','Puzzles à l’aveugle'],['coordinates','Coordonnées'],['color','Couleur des cases'],['training-history','Historique']]}
]);
export function activeNavigationGroup(page){if(page==='computer-history')page='computer';return page==='base'?'library':NAV_GROUPS.find(group=>group.items.some(([id])=>id===page))?.id||null;}
export function navigationLabel(page){if(page==='computer-history')return t('Historique contre l’ordinateur');if(page==='board')return t('Analyse');return t(NAV_GROUPS.flatMap(group=>group.items).find(([id])=>id===page)?.[1]||'');}
const ACTIVITY_PAGES=new Set(['training-plan','reviews','reading','puzzles','computer','guess','blindfold','coordinates','color']);
// Workspace synchronization and historical visits are not unfinished activities.
// Only recoverable sessions and authoritative activity summaries mark the menu.
export function navigationActivities({review=null,computer=null,run=null,activities=[]}={}){
 const pages=new Set([...activities].filter(page=>ACTIVITY_PAGES.has(page)));
 if(review?.base&&Array.isArray(review.cards)&&!review.finishedSession&&(review.session_id||Number.isInteger(review.index)&&review.index<review.cards.length))pages.add('reviews');
 const session=computer?.session;
 if(computer?.version===1&&session?.position?.doc?.nodes?.length&&Array.isArray(session.position.history)&&!session.resigned&&!session.timeout&&!session.position.game_over&&(!session.headers?.Result||session.headers.Result==='*')&&(!session.position.result||session.position.result==='*'))pages.add('computer');
 if(run?.id&&['active','paused'].includes(run.state)){pages.add('training-plan');if(run.activity==='review')pages.add('reviews');if(run.activity==='reading')pages.add('reading');}
 return pages;
}
const validReviewCount=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const activityLabel=(label,unfinished,count=null)=>{const activity=t(label)+(count===null?'':' ('+count+')');return unfinished?t('{activity} · activité non terminée',{activity}):activity;};
function link(id,label,page,unfinishedActivities,reviewDueCount){
 const unfinished=exerciseActivity(unfinishedActivities,id),count=id==='reviews'?validReviewCount(reviewDueCount):null;
 return '<button type="button" data-page="'+id+'" aria-current="'+(page===id||id==='exercises'&&exercisePage(page)||page==='computer-history'&&id==='computer'||page==='base'&&id==='library'?'page':'false')+'"'+(unfinished?' data-unfinished-activity="true" aria-label="'+esc(activityLabel(label,true,count))+'" title="'+esc(t('Activité non terminée'))+'"':'')+'>'+uiIcon(id==='training-history'?'history':id,'navigation-item-icon')+'<span class="navigation-item-label">'+esc(t(label))+'</span>'+(id==='reviews'?'<span class="navigation-review-count"'+(count===null?' hidden':' title="'+esc(t('Révisions dues : {count}',{count}))+'"')+'>'+(count===null?'':'('+count+')')+'</span>':'')+'<span class="navigation-activity-dot" aria-hidden="true"'+(unfinished?'':' hidden')+'></span></button>';
}
export function updateNavigationActivities(host,unfinishedActivities=new Set(),{reviewDueCount=null}={}){
 if(!host)return;
 for(const button of host.querySelectorAll('.navigation-menu-content [data-page]')){
  const unfinished=exerciseActivity(unfinishedActivities,button.dataset.page),dot=button.querySelector('.navigation-activity-dot'),count=button.dataset.page==='reviews'?validReviewCount(reviewDueCount):null,badge=button.querySelector('.navigation-review-count');
  if(dot)dot.hidden=!unfinished;
  if(badge){badge.hidden=count===null;badge.textContent=count===null?'':'('+count+')';if(count===null)badge.removeAttribute('title');else badge.title=t('Révisions dues : {count}',{count});}
  if(unfinished){button.dataset.unfinishedActivity='true';button.setAttribute('aria-label',activityLabel(NAV_GROUPS.flatMap(group=>group.items).find(([id])=>id===button.dataset.page)?.[1]||'',true,count));button.title=t('Activité non terminée');}
  else{delete button.dataset.unfinishedActivity;button.removeAttribute('aria-label');button.removeAttribute('title');}
 }
}
const NAV_SECTIONS={
 library:[['',['library','played','repertoire']]],
 training:[['',['training-plan','reviews','exercises','reading','training-history']]]
};
function groupContents(group,page,unfinishedActivities,reviewDueCount){return '<div class="navigation-menu-content">'+NAV_SECTIONS[group.id].map(([label,ids])=>'<section class="navigation-menu-section">'+(label?'<div class="navigation-menu-label">'+esc(t(label))+'</div>':'')+ids.map(id=>link(id,group.items.find(item=>item[0]===id)[1],page,unfinishedActivities,reviewDueCount)).join('')+'</section>').join('')+'</div>';}
function groupSummary(group){return '<summary aria-label="'+esc(t(group.label))+'"><span aria-hidden="true">'+group.icon+'</span><span class="navigation-group-label">'+esc(t(group.label))+'</span><small class="navigation-chevron" aria-hidden="true">▾</small></summary>';}
export function desktopNavigationHtml(page,{boardMenu='',unfinishedActivities=new Set(),reviewDueCount=null}={}){
 const active=activeNavigationGroup(page),board={id:'board',label:'Échiquier',icon:NAV_ICONS.board};
 return '<nav class="top-nav" aria-label="'+t('Navigation principale')+'">'+NAV_GROUPS.map(group=>'<details class="navigation-group" data-active="'+(active===group.id)+'">'+groupSummary(group)+'<div class="navigation-dropdown">'+groupContents(group,page,unfinishedActivities,reviewDueCount)+'</div></details>').join('')+'<details class="navigation-group board-navigation" data-board-menu data-active="'+(page==='board')+'">'+groupSummary(board)+'<div class="navigation-dropdown board-menu-container" data-board-menu-content>'+boardMenu+'</div></details></nav>';
}
export function mobileNavigationHtml(page,{boardMenu='',unfinishedActivities=new Set(),reviewDueCount=null}={}){
 const active=page==='board'?'board':activeNavigationGroup(page),board={id:'board',label:'Échiquier',icon:NAV_ICONS.board};
 return '<nav class="mobile-navigation" aria-label="'+t('Navigation mobile')+'">'+NAV_GROUPS.map(group=>'<details class="mobile-navigation-group" data-navigation-section="'+group.id+'" data-active="'+(active===group.id)+'">'+groupSummary(group)+'<div class="mobile-navigation-dropdown">'+groupContents(group,page,unfinishedActivities,reviewDueCount)+'</div></details>').join('')+'<details class="mobile-navigation-group mobile-board-navigation" data-navigation-section="board" data-board-menu data-active="'+(active==='board')+'">'+groupSummary(board)+'<div class="mobile-navigation-dropdown" data-board-menu-content>'+boardMenu+'</div></details></nav>';
}
export function bindMainNavigation(host,{onOpen=()=>{},onBoardOpen=()=>{},onBoardAction=()=>{}}={}){
 if(!host)return {dispose(){}};
 const groups=[...host.querySelectorAll('.navigation-group,.mobile-navigation-group')];
 const click=event=>{if(event.target.closest?.('[data-board-draft-menu]'))return;for(const group of groups)if(!group.contains(event.target))group.open=false;};
 const action=event=>{const button=event.target.closest?.('[data-board-command],[data-board-recent]');if(!button||!host.contains(button))return;event.preventDefault();for(const group of groups)group.open=false;onBoardAction(button.dataset.boardCommand,button.dataset.boardRecent);};
 const key=event=>{
  if(event.key==='Escape'){for(const group of groups)if(group.open){group.open=false;group.querySelector('summary')?.focus();event.preventDefault();}return;}
  if(event.altKey||event.ctrlKey||event.metaKey||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
  const group=event.target.closest?.('.navigation-group,.mobile-navigation-group');if(!group)return;
  if(!group.open){for(const other of groups)if(other!==group)other.open=false;group.open=true;}
  const items=[...group.querySelectorAll('button:not(:disabled),summary')].filter(item=>item.getClientRects().length),index=items.indexOf(event.target);
  if(!items.length)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;items[next].focus();
 };
 const toggles=groups.map(group=>{const toggle=()=>{if(group.open){for(const other of groups)if(other!==group)other.open=false;onOpen();}};group.addEventListener('toggle',toggle);return()=>group.removeEventListener('toggle',toggle);});
 for(const group of host.querySelectorAll('[data-board-menu]')){const toggle=()=>{if(group.open)onBoardOpen();};group.addEventListener('toggle',toggle);toggles.push(()=>group.removeEventListener('toggle',toggle));}
 document.addEventListener('click',click);host.addEventListener('click',action);host.addEventListener('keydown',key);
 return {dispose(){document.removeEventListener('click',click);host.removeEventListener('click',action);host.removeEventListener('keydown',key);toggles.forEach(fn=>fn());}};
}
