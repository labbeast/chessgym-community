import {t} from './i18n.js';

const panes=new WeakMap();
let identity=0;
const selectors={play:'[data-training-play-tab],[data-tab="play"]',history:'[data-training-history],[data-computer-history],[data-tab="history"]',statistics:'[data-training-statistics],[data-computer-statistics],[data-tab="stats"]',settings:'[data-training-settings],[data-computer-settings],[data-tab="settings"]'};

function select(header,name){
 for(const [key,selector] of Object.entries(selectors)){
  const tab=header.querySelector(selector);if(!tab)continue;
  tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(key===name));tab.tabIndex=key===name?0:-1;
  tab.removeAttribute('aria-current');tab.removeAttribute('aria-haspopup');if(tab.hasAttribute('aria-pressed'))tab.setAttribute('aria-pressed',String(key===name));
 }
}

// Keep the mounted exercise intact when browsing a secondary tab. Returning to
// Play restores the same form or session; closing a pane disposes its requests.
export function bindTrainingTabs(host,{active='play'}={}){
 const previous=panes.get(host);if(previous&&!previous.isConnected)previous.close();
 const header=host?.querySelector?.('.training-header'),nav=header?.querySelector?.('.training-tabs');
 if(!nav||!globalThis.document?.createElement)return;
 const current=nav.querySelector('span[aria-current="page"]');
 if(current&&typeof current.replaceWith==='function'){
  const button=document.createElement('button');button.type='button';button.className='training-tab';button.dataset.trainingPlayTab='';button.textContent=current.textContent;current.replaceWith(button);
  button.onclick=()=>panes.get(host)?.close();
 }
 nav.setAttribute('role','tablist');
 const id=header.dataset.exerciseTabsId||('exercise-tabs-'+(++identity));header.dataset.exerciseTabsId=id;
 for(const [name,selector] of Object.entries(selectors)){
  const tab=nav.querySelector(selector);if(!tab)continue;tab.id=id+'-'+name;tab.setAttribute('aria-controls',id+'-panel-'+name);
 }
 select(header,panes.get(host)?.open?panes.get(host).dataset.trainingPanel:active);
 if(!nav.dataset.exerciseKeys){nav.dataset.exerciseKeys='true';nav.addEventListener('keydown',event=>{
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||event.altKey||event.ctrlKey||event.metaKey)return;
  const tabs=[...nav.querySelectorAll('[role=tab]')].filter(tab=>!tab.disabled),index=tabs.indexOf(event.target);if(index<0)return;
  event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(index+(event.key==='ArrowLeft'?-1:1)+tabs.length)%tabs.length;
  tabs[next].focus();tabs[next].click();
 });}
}

export function createTrainingPanel(host,name){
 bindTrainingTabs(host);panes.get(host)?.close();
 const header=host.querySelector('.training-header');if(!header)throw new Error('Exercise header is missing');
 let play=header.parentElement.querySelector(':scope > [data-training-play]');
 if(!play){
  play=document.createElement('section');play.dataset.trainingPlay='';
  while(header.nextSibling)play.append(header.nextSibling);
  header.after(play);
 }
 const id=header.dataset.exerciseTabsId;play.id=id+'-panel-play';play.setAttribute('role','tabpanel');play.setAttribute('aria-labelledby',id+'-play');play.hidden=true;play.inert=true;
 const panel=document.createElement('section');panel.dataset.trainingPanel=name;panel.id=id+'-panel-'+name;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',id+'-'+name);panel.setAttribute('open','');panel.open=true;
 panel.close=()=>{
  if(!panel.open)return;panel.open=false;panel.removeAttribute('open');panel.remove();
  host.removeEventListener('keydown',blockBoardKeys);
  if(panes.get(host)===panel){panes.delete(host);play.hidden=false;play.inert=false;select(header,'play');}
  panel.dispatchEvent(new Event('close'));
 };
 const blockBoardKeys=event=>{if(panel.open&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))event.stopPropagation();};
 host.addEventListener('keydown',blockBoardKeys);
 header.parentElement.append(panel);panes.set(host,panel);select(header,name);return panel;
}

export function configurationSummary(values){return values.filter(Boolean).join(' · ');}

export function setupSummaryHtml(summary){
 const node=String(summary).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 return '<p class="exercise-config-summary">'+node+'</p><button type="button" class="exercise-customize" data-exercise-customize>'+t('Modifier les réglages')+'</button>';
}
