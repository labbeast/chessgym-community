// Keep the normal board size when tools are hidden so the space improves reading.
export function analysisBoardSize({width,height,toolbarHeight,gap=10,notationMin=280,toolsMin=320,toolsCollapsed=false,boardReduced=false}){
 const normalWidth=width-notationMin-toolsMin-2*gap;
 const availableWidth=width-notationMin-(toolsCollapsed?0:toolsMin)-(toolsCollapsed?gap:2*gap);
 const boardCap=boardReduced?320:toolsCollapsed?normalWidth:Infinity;
 return Math.max(0,Math.floor(Math.min(availableWidth,height-toolbarHeight,boardCap)));
}

export function mobileAnalysisBoardSize({width,height,toolbarHeight,tabsHeight=38,panelMin=216,landscape=false,boardReduced=false}){
 // Portrait prioritizes a full-width board. A short viewport scrolls the workspace.
 const available=landscape?Math.min(width-300-8,height-toolbarHeight):width;
 return Math.max(0,Math.floor(available));
}

export function observeAnalysisLayout(workbench,boardHost,{extraToolbar=null}={}){
 if(!workbench||!boardHost||typeof ResizeObserver==='undefined')return null;
 if(!boardHost.querySelector('.board-toolbar'))return null;
 const px=(style,name,fallback=0)=>Number.parseFloat(style.getPropertyValue(name))||fallback;
 let disposed=false;
 const fit=()=>{
  if(disposed)return;
  const style=getComputedStyle(workbench);
  const mode=style.getPropertyValue('--analysis-fit').trim();
  if(!['1','2'].includes(mode)){
   workbench.style.removeProperty('--analysis-board-size');workbench.style.removeProperty('--analysis-clock-height');workbench.classList.remove('analysis-compact-board');return;
  }
  // Board.render replaces its controls; always measure the currently mounted bar.
  const toolbar=boardHost.querySelector('.board-toolbar');if(!toolbar)return;
  const toolbarStyle=getComputedStyle(toolbar);
  const clockHeight=[...(boardHost.querySelectorAll?.('[data-board-clock]')||[])].reduce((height,band)=>{
   if(band.hidden)return height;const bandStyle=getComputedStyle(band);
   return height+band.getBoundingClientRect().height+px(bandStyle,'margin-top')+px(bandStyle,'margin-bottom');
  },0);
  const clockValue=clockHeight+'px';if(workbench.style.getPropertyValue('--analysis-clock-height')!==clockValue)workbench.style.setProperty('--analysis-clock-height',clockValue);
  const geometry={width:workbench.clientWidth,height:workbench.clientHeight,
   toolbarHeight:toolbar.getBoundingClientRect().height+px(toolbarStyle,'margin-top')+px(toolbarStyle,'margin-bottom')+clockHeight+(extraToolbar?.getBoundingClientRect().height||0),
   gap:px(style,'column-gap',10),
   notationMin:px(style,'--analysis-notation-min',280),toolsMin:px(style,'--analysis-tools-min',320),
   toolsCollapsed:workbench.classList.contains('analysis-tools-collapsed'),
   boardReduced:workbench.classList.contains('analysis-board-reduced')};
  const tabs=workbench.querySelector('.analysis-mobile-tabs');
  const size=mode==='2'?mobileAnalysisBoardSize({...geometry,tabsHeight:tabs?.getBoundingClientRect().height||38,panelMin:px(style,'--analysis-mobile-panel-min',216),landscape:style.getPropertyValue('--analysis-landscape').trim()==='1'}):analysisBoardSize(geometry);
  if(size>=0){
   const value=size+'px';if(workbench.style.getPropertyValue('--analysis-board-size')!==value)workbench.style.setProperty('--analysis-board-size',value);
   workbench.classList.toggle('analysis-compact-board',size<360);
  }
 };
 const observer=new ResizeObserver(fit);
 observer.observe(workbench);observer.observe(boardHost);if(extraToolbar)observer.observe(extraToolbar);
 const engine=workbench.querySelector('#analysis-engine');if(engine)observer.observe(engine);
 // A width/height threshold can change layout while the observed size stays equal.
 window.addEventListener('resize',fit);fit();
 return {refresh:fit,disconnect(){disposed=true;observer.disconnect();window.removeEventListener('resize',fit);}};
}
