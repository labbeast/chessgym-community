import {esc,option} from './api.js';
import {t,locale} from './i18n.js';

// Navigation state is deliberately kept in memory and cleared on account change.
const states=new Map();
let owner=null;
export function setListOwner(identity){if(owner!==identity){states.clear();owner=identity;}}
export function readListState(key,fallback={}){return structuredClone(key&&states.has(key)?states.get(key):fallback);}
export function writeListState(key,value){if(key)states.set(key,structuredClone(value));}
export const listFold=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase(locale());
export const listPageSize=value=>[25,50,100].includes(Number(value))?Number(value):50;
const number=value=>new Intl.NumberFormat(locale()).format(Math.max(0,Number(value)||0));

export function listSearchHtml({value='',label='Rechercher',placeholder='Rechercher…',attributes=''}={}){
 return `<label class="list-search">${esc(t(label))}<input type="search" maxlength="200" value="${esc(value)}" placeholder="${esc(t(placeholder))}" ${attributes}></label>`;
}
export function listSearchPanelHtml(content,{open=false}={}){
 return `<details class="list-search-menu" data-list-search-menu${open?' open':''}><summary><svg class="list-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"></circle><path d="m16 16 4.5 4.5"></path></svg><span>Search</span><svg class="list-search-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg></summary><div class="list-search-panel">${content}</div></details>`;
}
export function listChipsHtml(items=[]){
 return items.length?`<div class="list-chips" aria-label="${esc(t('Filtres actifs'))}">${items.map(({key,label,value,locked=false})=>`<${locked?'span':'button type="button"'} class="list-chip" ${locked?'':`data-list-clear="${esc(key)}" aria-label="${esc(t('Retirer le filtre : {label}',{label:t(label)}))}"`}><span>${esc(t(label))}${value!==undefined?' : '+esc(value):''}</span>${locked?'':'<span aria-hidden="true">×</span>'}</${locked?'span':'button'}>`).join('')}</div>`:'';
}
export function listPaginationHtml({offset=0,limit=50,total=null,count=0,hasMore=null,loading=false,previous='',next='',size='',className='',label='Pages des résultats'}={}){
 const known=total!==null&&total!==undefined&&Number.isFinite(Number(total));
 const first=count?offset+1:0,last=count?offset+count:0;
 const range=known?t('{first}–{last} sur {total}',{first:number(first),last:number(Math.min(last,Number(total))),total:number(total)}):t('{first}–{last}',{first:number(first),last:number(last)});
 return `<nav class="list-pagination ${className}" aria-label="${esc(t(label))}"><span class="list-range" role="status">${esc(range)}</span><div class="list-page-controls">${size?`<label>${esc(t('Par page'))}<select ${size}${loading?' disabled':''}>${[25,50,100].map(value=>option(value,String(value),String(limit))).join('')}</select></label>`:''}<button type="button" ${previous} ${loading||offset<=0?'disabled ':''}aria-label="${esc(t('Page précédente'))}">‹</button><button type="button" ${next} ${loading||!(hasMore??(known&&offset+count<Number(total)))?'disabled ':''}aria-label="${esc(t('Page suivante'))}">›</button></div></nav>`;
}
export function listAdvancedHtml(fields,{count=0,open=false,actions=''}={}){
 return `<details class="list-advanced" data-list-advanced${open?' open':''}><summary>${esc(t('Recherche avancée'))} <span data-list-count>${count?esc(t('{count} critères actifs',{count})):''}</span><span class="list-dirty" data-list-dirty hidden>${esc(t('Modifications à appliquer'))}</span></summary><div class="list-advanced-fields">${fields}</div>${actions||`<div class="list-actions"><button type="submit" class="primary" data-list-apply>${esc(t('Appliquer'))}</button></div>`}</details>`;
}
export function captureListScroll(){return Number(globalThis.scrollY)||0;}
export function restoreListScroll(host,value){
 if(value==null||!globalThis.requestAnimationFrame)return;
 requestAnimationFrame(()=>{if(host.isConnected)globalThis.scrollTo?.({top:value,behavior:'instant'});});
}
export function markListDirty(host,dirty){const node=host.querySelector('[data-list-dirty]');if(node)node.hidden=!dirty;}

// Local collections use the same controls as server-backed lists. Each item can
// have several nodes (desktop table and mobile cards); listeners stay attached.
export class CollectionList {
 constructor(host,{items=[],filters=[],sorts=[['name','Nom']],stateKey=null,placeholder='Rechercher…',empty='Aucun résultat pour ces filtres.'}={}){
  Object.assign(this,{host,items,filters,sorts,stateKey,placeholder,empty});
  host.classList.add('list-collection');
  this.state=readListState(stateKey,{query:'',sort:sorts[0][0],descending:false,filters:{},offset:0,limit:25});
  this.state.limit=listPageSize(this.state.limit);this.disposed=false;
  if(!sorts.some(([key])=>key===this.state.sort))this.state.sort=sorts[0][0];
  this.toolbar=document.createElement('div');this.toolbar.className='collection-controls';host.prepend(this.toolbar);
  this.footer=document.createElement('div');this.footer.className='collection-footer';host.append(this.footer);
  this.renderControls();
  this.input=event=>{if(!this.toolbar.contains(event.target))return;if(event.target.matches('[data-collection-search]')){this.state.query=event.target.value;this.change(true);}else markListDirty(this.toolbar,true);};
  this.changeHandler=event=>{const node=event.target;if(node.matches('[data-collection-sort]')){this.state.sort=node.value;this.change();}else if(node.matches('[data-collection-size]')){this.state.limit=listPageSize(node.value);this.change();}else if(node.matches('[data-collection-filter]')&&!node.closest('[data-list-advanced]')){this.state.filters[node.dataset.collectionFilter]=node.value;this.change();}};
  this.submit=event=>{if(!this.toolbar.contains(event.target))return;event.preventDefault();event.stopPropagation();clearTimeout(this.timer);this.toolbar.querySelectorAll('[data-collection-filter]').forEach(node=>this.state.filters[node.dataset.collectionFilter]=node.value);this.change();};
  this.keydown=event=>{if(event.key==='Enter'&&event.target.matches('[data-collection-search]')){event.preventDefault();event.stopPropagation();this.state.query=event.target.value;this.change();}else if(event.key==='Enter'&&this.nestedForm&&this.toolbar.contains(event.target)){event.preventDefault();this.applyAdvanced();}};
  this.click=event=>{const button=event.target.closest('[data-collection-action],[data-list-clear]');if(!button||button.disabled)return;const key=button.dataset.listClear,action=button.dataset.collectionAction;if(action==='apply'){this.applyAdvanced();return;}if(key!==undefined){if(key==='query')this.state.query='';else delete this.state.filters[key];this.renderControls();this.change();}else if(action==='reset'){this.state={...this.state,query:'',sort:this.sorts[0][0],descending:false,filters:{},offset:0};this.renderControls();this.change();}else if(action==='direction'){this.state.descending=!this.state.descending;this.change();}else{this.state.offset=Math.max(0,this.state.offset+(action==='next'?1:-1)*this.state.limit);this.update();}};
  host.addEventListener('input',this.input);host.addEventListener('change',this.changeHandler);host.addEventListener('submit',this.submit);host.addEventListener('click',this.click);host.addEventListener('keydown',this.keydown);
  this.update();restoreListScroll(host,this.state.scroll);
 }
 renderControls(){
  this.state.searchOpen=this.toolbar.querySelector('[data-list-search-menu]')?.open??this.state.searchOpen??false;
  this.nestedForm=!!this.host.closest('form');
  const tag=this.nestedForm?'div':'form';
  const select=filter=>`<label>${esc(t(filter.label))}<select data-collection-filter="${esc(filter.key)}">${[['','Tous'],...filter.options].map(([value,label])=>option(value,t(label),this.state.filters[filter.key]||'')).join('')}</select></label>`;
  const advanced=this.filters.filter(filter=>filter.advanced),quick=this.filters.filter(filter=>!filter.advanced);
  this.toolbar.innerHTML=listSearchPanelHtml(`<${tag} role="search"><div class="list-toolbar">${listSearchHtml({value:this.state.query,placeholder:this.placeholder,attributes:'data-collection-search'})}${quick.map(select).join('')}<label>${esc(t('Trier par'))}<select data-collection-sort>${this.sorts.map(([value,label])=>option(value,t(label),this.state.sort)).join('')}</select></label><button type="button" data-collection-action="direction"></button><button type="button" data-collection-action="reset">${esc(t('Réinitialiser'))}</button></div>${advanced.length?listAdvancedHtml(advanced.map(select).join(''),{open:this.state.advancedOpen,count:advanced.filter(filter=>this.state.filters[filter.key]).length,actions:this.nestedForm?`<div class="list-actions"><button type="button" class="primary" data-collection-action="apply">${esc(t('Appliquer'))}</button></div>`:''}):''}</${tag}>`,{open:this.state.searchOpen})+'<div data-collection-chips></div><p class="list-summary" data-collection-summary role="status"></p>';
  const search=this.toolbar.querySelector('[data-list-search-menu]');search.ontoggle=()=>this.state.searchOpen=search.open;
  const details=this.toolbar.querySelector('[data-list-advanced]');if(details)details.ontoggle=()=>this.state.advancedOpen=details.open;
 }
 change(debounce=false){clearTimeout(this.timer);this.state.offset=0;if(debounce)this.timer=setTimeout(()=>this.update(),250);else this.update();}
 applyAdvanced(){this.toolbar.querySelectorAll('[data-collection-filter]').forEach(node=>this.state.filters[node.dataset.collectionFilter]=node.value);this.change();}
 update(){
  if(this.disposed)return;
  const terms=listFold(this.state.query).trim().split(/\s+/).filter(Boolean);
  const selected=this.items.filter(item=>terms.every(term=>listFold(item.text).includes(term))&&this.filters.every(filter=>!this.state.filters[filter.key]||[item.values?.[filter.key]].flat().includes(this.state.filters[filter.key])));
  selected.sort((a,b)=>{const x=a.sort?.[this.state.sort]??'',y=b.sort?.[this.state.sort]??'';return (typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y),locale(),{numeric:true,sensitivity:'base'}))*(this.state.descending?-1:1);});
  if(this.state.offset>=selected.length)this.state.offset=Math.max(0,Math.floor((selected.length-1)/this.state.limit)*this.state.limit);
  const visible=new Set(selected.slice(this.state.offset,this.state.offset+this.state.limit));
  for(const item of this.items)for(const node of item.nodes||[item.node])node.hidden=!visible.has(item);
  for(const item of selected)for(const node of item.nodes||[item.node])node.parentElement.insertBefore(node,node.parentElement===this.host?this.footer:null);
  const chips=[];if(this.state.query)chips.push({key:'query',label:'Rechercher',value:this.state.query});
  for(const filter of this.filters)if(this.state.filters[filter.key])chips.push({key:filter.key,label:filter.label,value:t(filter.options.find(([key])=>key===this.state.filters[filter.key])?.[1]||this.state.filters[filter.key])});
  this.toolbar.querySelector('[data-collection-chips]').innerHTML=listChipsHtml(chips);
  this.toolbar.querySelector('[data-collection-summary]').textContent=t('{count} résultats sur {total}',{count:number(selected.length),total:number(this.items.length)});
  this.toolbar.querySelector('[data-collection-action="direction"]').textContent=t(this.state.descending?'↓ Décroissant':'↑ Croissant');
  const count=this.toolbar.querySelector('[data-list-count]');if(count)count.textContent=chips.filter(item=>item.key!=='query'&&this.filters.find(filter=>filter.key===item.key)?.advanced).length?t('{count} critères actifs',{count:chips.filter(item=>this.filters.find(filter=>filter.key===item.key)?.advanced).length}):'';
  markListDirty(this.toolbar,[...this.toolbar.querySelectorAll('[data-collection-filter]')].some(node=>(node.value||'')!==(this.state.filters[node.dataset.collectionFilter]||'')));
  this.footer.innerHTML=(selected.length?'':`<p class="list-empty" role="status">${esc(t(this.empty))}</p>`)+listPaginationHtml({offset:this.state.offset,limit:this.state.limit,total:selected.length,count:Math.min(this.state.limit,selected.length-this.state.offset),previous:'data-collection-action="previous"',next:'data-collection-action="next"',size:'data-collection-size'});
  writeListState(this.stateKey,this.state);
 }
 dispose(){this.disposed=true;clearTimeout(this.timer);writeListState(this.stateKey,{...this.state,scroll:captureListScroll()});this.host.removeEventListener('input',this.input);this.host.removeEventListener('change',this.changeHandler);this.host.removeEventListener('submit',this.submit);this.host.removeEventListener('click',this.click);this.host.removeEventListener('keydown',this.keydown);}
}
