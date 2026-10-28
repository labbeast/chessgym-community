import {t} from './i18n.js';
import {esc} from './api.js';
import {uiIcon} from './ui-icons.js';

const STORAGE_KEY='chessgym.settings-tab.v1';
const TAB_ICONS={general:'settings',appearance:'palette',sounds:'sound',reviews:'reviews',performance:'performance',installation:'computer',engines:'computer',backups:'backup',account:'account'};
let lastTab='general';

function selectedTab(sections){
 try{lastTab=globalThis.sessionStorage?.getItem(STORAGE_KEY)||lastTab;}catch{}
 return sections.some(section=>section.id===lastTab)?lastTab:sections[0]?.id;
}

export function settingsTabsHtml(sections){
 const selected=selectedTab(sections);
 const tabs=sections.map(({id,label})=>'<button type="button" role="tab" id="settings-tab-'+esc(id)+'" data-settings-tab="'+esc(id)+'" aria-controls="settings-panel-'+esc(id)+'" aria-selected="'+(id===selected)+'" tabindex="'+(id===selected?'0':'-1')+'">'+uiIcon(TAB_ICONS[id]||'settings')+'<span>'+esc(t(label))+'</span></button>').join('');
 const panels=sections.map(({id,content})=>'<div role="tabpanel" id="settings-panel-'+esc(id)+'" data-settings-panel="'+esc(id)+'" aria-labelledby="settings-tab-'+esc(id)+'" tabindex="0"'+(id===selected?'':' hidden')+'>'+content+'</div>').join('');
 return '<div class="settings-workspace"><div class="settings-tabs" role="tablist" aria-label="'+esc(t('Rubriques des réglages'))+'">'+tabs+'</div>'+panels+'</div>';
}

export function bindSettingsTabs(host,{initialTab=null}={}){
 const tabs=[...host.querySelectorAll('[data-settings-tab]')];
 const panels=[...host.querySelectorAll('[data-settings-panel]')];
 function activate(button,{focus=false}={}){
  if(!tabs.includes(button))return;
  lastTab=button.dataset.settingsTab;
  try{globalThis.sessionStorage?.setItem(STORAGE_KEY,lastTab);}catch{}
  for(const tab of tabs){const selected=tab===button;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
  // Keep each form mounted so switching sections preserves unsaved fields.
  for(const panel of panels)panel.hidden=panel.dataset.settingsPanel!==lastTab;
  const panel=panels.find(item=>!item.hidden),navigation=button.parentElement;
  if(panel&&panel.getBoundingClientRect().top<navigation.getBoundingClientRect().bottom){
   navigation.parentElement.scrollIntoView({block:'start',behavior:'auto'});
  }
  if(focus)button.focus({preventScroll:true});
 }
 if(initialTab)activate(tabs.find(tab=>tab.dataset.settingsTab===initialTab));
 for(const tab of tabs){
  tab.onclick=()=>activate(tab);
  tab.onkeydown=event=>{
   const index=tabs.indexOf(tab);
   const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:null;
   if(next===null)return;
   event.preventDefault();activate(tabs[next],{focus:true});
  };
 }
}
