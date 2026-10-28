import {api,esc,option} from './api.js';
import {t} from './i18n.js';
import {requestPreparedCatalog,waitForRetry} from './catalog-request.js';
import {gameSearchHtml,readGameFilters,gameFilterParams,gameFilterChips,fillGameFilters,gameFilterDraft} from './game-search.js';
import {referenceGamesHtml,REFERENCE_SORTS} from './game-results.js';
import {searchProgressHtml} from './search-progress.js';
import {listSearchPanelHtml,listSearchHtml,listChipsHtml,listPageSize,readListState,writeListState,markListDirty} from './list-view.js';

// A read-only game chooser, with the same query contract as the library.
export class GamePicker {
 constructor(host,{bases=[],onSelect=async()=>{},request=api,stateKey='game-picker'}={}){
  Object.assign(this,{host,bases,onSelect,request,stateKey});this.sequence=0;this.disposed=false;
  const savedBaseId=Number(readListState(stateKey).baseId);
  this.baseId=(bases.find(base=>base.id===savedBaseId)||bases[0])?.id;this.restore();this.render();
  this.input=event=>{if(event.target.matches('[data-picker-search]')){this.filters.search=event.target.value;this.offset=0;this.cancel();this.data=null;this.loading=true;this.renderResults();this.timer=setTimeout(()=>void this.load(),250);}else if(event.target.hasAttribute('data-game-filter')){this.draft=gameFilterDraft(host);markListDirty(host,true);}};
  this.change=event=>{const node=event.target;if(node.matches('[data-base]')){this.save();this.baseId=Number(node.value);this.restore();this.render();void this.load();}else if(node.matches('[data-picker-sort]')){this.filters.sort=node.value;this.offset=0;void this.load();}else if(node.hasAttribute('data-list-size')){this.limit=listPageSize(node.value);this.offset=0;void this.load();}};
  this.submit=event=>{event.preventDefault();try{this.filters={search:this.filters.search,sort:this.filters.sort,descending:this.filters.descending,...gameFilterParams(readGameFilters(host))};this.offset=0;this.draft=gameFilterDraft(host);markListDirty(host,false);void this.load();}catch(error){this.error=error.message;this.renderResults();}};
  this.keydown=event=>{if(event.key==='Enter'&&event.target.matches('[data-picker-search]')){event.preventDefault();this.offset=0;void this.load();}};
  this.click=event=>{const button=event.target.closest('[data-entry],[data-reference-action],[data-picker-action],[data-list-clear]');if(!button||button.disabled)return;const action=button.dataset.referenceAction||button.dataset.pickerAction;if(button.hasAttribute('data-entry')){if(this.loading||this.opening)return;this.opening=true;this.renderResults();Promise.resolve(this.onSelect(this.base,Number(button.dataset.entry))).catch(error=>{this.error=error.message;}).finally(()=>{this.opening=false;this.renderResults();});return;}if(button.hasAttribute('data-list-clear')){delete this.filters[button.dataset.listClear];delete this.draft[button.dataset.listClear];this.offset=0;this.render();}else if(action==='reset'){this.filters={search:'',sort:this.base?.reference?'id':'added',descending:false};this.offset=0;this.draft={};this.render();}else if(action==='direction'){this.filters.descending=!this.filters.descending;this.render();}else if(action==='next'||action==='previous'){this.offset=Math.max(0,this.offset+(action==='next'?1:-1)*this.limit);}void this.load();};
  for(const[name,handler]of Object.entries({input:this.input,change:this.change,submit:this.submit,click:this.click,keydown:this.keydown}))host.addEventListener(name,handler);
  this.ready=this.base?this.load():Promise.resolve();
 }
 get base(){return this.bases.find(base=>base.id===Number(this.baseId))||this.bases[0];}
 restore(){const saved=readListState(this.stateKey+':'+this.baseId);this.filters=saved.filters||{search:'',sort:this.base?.reference?'id':'added',descending:false};this.draft=saved.draft||{...this.filters};this.advancedOpen=!!saved.advancedOpen;this.offset=saved.offset||0;this.limit=listPageSize(saved.limit||25);}
 save(){writeListState(this.stateKey,{baseId:this.baseId});writeListState(this.stateKey+':'+this.baseId,{filters:this.filters,offset:this.offset,limit:this.limit,draft:this.draft,advancedOpen:this.advancedOpen});}
 cancel(){clearTimeout(this.timer);this.controller?.abort();this.sequence++;}
 render(){
  const sorts=this.base?.reference?REFERENCE_SORTS:[['added','Date d’ajout'],['date','Date de la partie'],['white','Blancs'],['black','Noirs']];
  const searchOpen=!!this.host.querySelector('[data-list-search-menu]')?.open;
  this.host.innerHTML=listSearchPanelHtml(`<form role="search"><div class="list-toolbar"><label>${esc(t('Base'))}<select data-base>${this.bases.map(base=>option(base.id,base.name,this.base?.id)).join('')}</select></label>${listSearchHtml({value:this.filters.search,placeholder:'Rechercher une partie',attributes:'data-picker-search'})}<label>${esc(t('Trier par'))}<select data-picker-sort>${sorts.map(([key,label])=>option(key,t(label),this.filters.sort)).join('')}</select></label><button type="button" data-picker-action="direction">${esc(t(this.filters.descending?'↓ Décroissant':'↑ Croissant'))}</button><button type="button" data-picker-action="reset">${esc(t('Réinitialiser'))}</button></div>${gameSearchHtml(this.filters,`<div class="list-actions"><button type="submit" class="primary">${esc(t('Appliquer'))}</button></div>`)}</form>`,{open:searchOpen})+`<div data-picker-chips></div><div data-games aria-live="polite"></div>`;
  fillGameFilters(this.host,this.draft);const details=this.host.querySelector('[data-game-search]');details.open=this.advancedOpen;details.ontoggle=()=>this.advancedOpen=details.open;this.renderResults();
 }
 renderResults(){
  if(this.disposed)return;
  const chips=gameFilterChips(this.filters);if(this.filters.search)chips.unshift({key:'search',label:'Rechercher',value:this.filters.search});this.host.querySelector('[data-picker-chips]').innerHTML=listChipsHtml(chips);
  const results=this.host.querySelector('[data-games]');results.setAttribute('aria-busy',String(!!this.loading));
  const progress=this.loading&&this.data?.status!=='preparing'?searchProgressHtml({label:this.preparing?'Préparation de la liste…':'Recherche en cours…',hint:this.preparing?'Les résultats apparaîtront automatiquement dès qu’ils seront prêts.':''}):'';
  results.innerHTML=(this.error?`<p role="alert" class="error-text">${esc(this.error)}</p><button type="button" data-picker-action="retry">${esc(t('Réessayer'))}</button>`:'')+progress+(this.data?referenceGamesHtml(this.data,this.loading||this.opening,{limit:this.limit,openLabel:'Choisir'}).replaceAll('data-reference-game=','data-entry='):'');
 }
 async load(){
  if(this.disposed||!this.base)return;this.cancel();const sequence=this.sequence,controller=this.controller=new AbortController();this.loading=true;this.error='';this.preparing=false;this.data=null;this.renderResults();this.save();
  const endpoint=this.base.reference?'/api/reference-bases/'+this.base.id+'/games':'/api/bases/'+this.base.id+'/entries';const url=endpoint+'?'+new URLSearchParams({...this.filters,offset:this.offset,limit:this.limit});
  try{const started=Date.now();for(;;){const data=await requestPreparedCatalog(this.request,url,{signal:controller.signal});if(this.disposed||sequence!==this.sequence)return;if(data.status!=='preparing'){this.data=data;this.offset=data.offset;if(!data.entries?.length&&data.total>0&&this.offset>0){this.offset=Math.floor((data.total-1)/this.limit)*this.limit;return this.load();}break;}this.preparing=true;this.renderResults();if(Date.now()-started>=300000){this.error=t('La préparation continue sur le serveur. Clique sur Actualiser pour vérifier le résultat.');break;}await waitForRetry(Math.min(15000,Math.max(3000,(data.retry_after||3)*1000)),controller.signal);}}
  catch(error){if(this.disposed||sequence!==this.sequence||error.name==='AbortError')return;this.error=error.message;}
  finally{if(!this.disposed&&sequence===this.sequence){this.loading=false;this.renderResults();}}
 }
 dispose(){this.save();this.disposed=true;this.cancel();for(const[name,handler]of Object.entries({input:this.input,change:this.change,submit:this.submit,click:this.click,keydown:this.keydown}))this.host.removeEventListener(name,handler);}
}
