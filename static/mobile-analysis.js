// Switch the existing panels in place: their drafts, engine and board stay alive.
export function mountMobileAnalysis(workbench,{initial='moves',commands=null,onSelect=()=>{},onVisibilityChange=()=>{}}={}){
 const tabs=workbench?.querySelector('.analysis-mobile-tabs');if(!tabs)return null;
 const items=[...tabs.querySelectorAll('[data-mobile-panel]')];
 const media=window.matchMedia('(max-width:850px), (max-width:1000px) and (max-height:500px)');let disposed=false,panel=initial;
 const actions=commands?.actions,dock=commands?.dock,home=actions?.parentElement;
 const reading=actions?.querySelector('.analysis-reading-controls'),readingNext=reading?.nextSibling;
 const menu=actions?.querySelector('.analysis-more-actions');
 // Move the actual controls rather than duplicating save handlers and settings.
 const placeCommands=mobile=>{
  if(!actions||!dock||!home)return;
  if(mobile){if(actions.parentElement!==dock)dock.append(actions);if(reading&&menu&&reading.parentElement!==menu)menu.prepend(reading);}
  else{if(actions.parentElement!==home)home.append(actions);if(reading&&reading.parentElement!==actions)actions.insertBefore(reading,readingNext?.parentElement===actions?readingNext:null);}
 };
 const select=(id,{focus=false,notify=true}={})=>{
  if(disposed||!items.some(item=>item.dataset.mobilePanel===id))return;
  panel=id;workbench.dataset.mobilePanel=id;
  items.forEach(item=>{const selected=item.dataset.mobilePanel===id;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;if(selected&&focus)item.focus({preventScroll:true});});
  if(notify)onSelect(id);onVisibilityChange();
 };
 const click=event=>{const tab=event.target.closest?.('[data-mobile-panel]');if(tab&&tabs.contains(tab))select(tab.dataset.mobilePanel);};
 const keydown=event=>{
  if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
  const index=items.indexOf(event.target);if(index<0)return;
  event.preventDefault();event.stopPropagation();
  const next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowRight'?1:-1)+items.length)%items.length;
  select(items[next].dataset.mobilePanel,{focus:true});
 };
 const changed=()=>{if(disposed)return;placeCommands(media.matches);if(media.matches)onSelect(panel);onVisibilityChange();};
 tabs.addEventListener('click',click);tabs.addEventListener('keydown',keydown);media.addEventListener('change',changed);
 placeCommands(media.matches);select(items.some(item=>item.dataset.mobilePanel===panel)?panel:'moves',{notify:false});
 return {get active(){return media.matches;},get panel(){return panel;},select,disconnect(){if(disposed)return;disposed=true;tabs.removeEventListener('click',click);tabs.removeEventListener('keydown',keydown);media.removeEventListener('change',changed);placeCommands(false);}};
}
