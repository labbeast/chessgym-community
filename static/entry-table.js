import {listSearchPanelHtml,listChipsHtml,listPaginationHtml,listPageSize,readListState,writeListState,captureListScroll,restoreListScroll,markListDirty} from './list-view.js';
import {requestPreparedCatalog} from './catalog-request.js';
import {t,ui,locale} from './i18n.js';
import {api,esc,modal,notice,fail,option} from './api.js';
import {readingPercent} from './reading-progress.js';
import {editBatchMetadata} from './metadata.js';
import {LibraryDirectory,libraryViewsHtml,directorySelectionHtml} from './library-directory.js';
import {gameSearchHtml,readGameFilters,gameFilterParams,resetGameFilters,gameSearchCountLabel,matchesGameFilters,gameFilterChips,gameFilterDraft,fillGameFilters} from './game-search.js';

export const ENTRY_SORTS=[['added','Date d’ajout'],['updated','Dernière modification'],['date','Date de la partie'],['title','Titre'],['white','Blancs'],['black','Noirs'],['whiteElo','Classement des Blancs'],['blackElo','Classement des Noirs'],['result','Résultat'],['timecontrol','Cadence'],['site','Site'],['review','Inclusion aux révisions']];
const collator={compare:(a,b)=>String(a).localeCompare(String(b),locale(),{sensitivity:'base',numeric:true})};
const fold=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('fr');
const entryName=e=>e.title||e.headers?.Event||'Position';
function gameDate(value){
 const m=String(value||'').match(/^(\d{4})[.-](\d{2}|\?\?)[.-](\d{2}|\?\?)$/);
 if(!m||Number(m[1])<1)return null;
 const month=m[2]==='??'?0:Number(m[2]),day=m[3]==='??'?0:Number(m[3]);
 if(month>12||day>31||m[2]==='00'||m[3]==='00')return null;
 return Number(m[1])*10000+month*100+day;
}
function sortValue(entry,key){
 const h=entry.headers||{};
 if(key==='added'||key==='updated'){const v=Date.parse(entry[key==='added'?'created_at':'updated_at']);return Number.isFinite(v)?v:null;}
 if(key==='date')return gameDate(h.Date);
 if(key==='whiteElo'||key==='blackElo'){const v=String(h[key==='whiteElo'?'WhiteElo':'BlackElo']??'').trim();return /^\d+$/.test(v)?Number(v):null;}
 if(key==='review')return entry.selected?1:0;
 const v=key==='title'?entryName(entry):h[({white:'White',black:'Black',result:'Result',timecontrol:'TimeControl',site:'Site'})[key]];
 return v&&v!=='?'&&v!=='*'?String(v):null;
}
export function visibleEntries(entries,{query='',inclusion='all',sort='added',direction='asc',advanced={}}={}){
 const terms=fold(query).trim().split(/\s+/).filter(Boolean),sign=direction==='asc'?1:-1;
 return entries.filter(entry=>{
  if(inclusion==='included'&&!entry.selected||inclusion==='excluded'&&entry.selected)return false;
  const haystack=fold([entryName(entry),...Object.values(entry.headers||{})].join(' '));
  return terms.every(term=>haystack.includes(term))&&matchesGameFilters(entry,advanced);
 }).map((entry,index)=>({entry,index})).sort((a,b)=>{
  const x=sortValue(a.entry,sort),y=sortValue(b.entry,sort);
  if(x==null||y==null)return x==null?(y==null?a.index-b.index:1):-1;
  const result=typeof x==='number'?x-y:collator.compare(x,y);
  return result*sign||(sort==='added'||sort==='updated'?(Number(a.entry.id)-Number(b.entry.id))*sign:a.index-b.index);
 }).map(item=>item.entry);
}

export class EntryTable{
 constructor(host,{entries=[],base,getBases=()=>[],onOpenEntry,onMetadata,onChanged,onBatchStart,request=api,openModal=modal,notify=notice,onError=fail,remote=null,stateKey=null}={}){
  Object.assign(this,{host,entries:[...entries],base,getBases,onOpenEntry,onMetadata,onChanged,onBatchStart,request,openModal,notify,onError,remote,stateKey});
  this.selection=new Set();this.selectedEntries=new Map();this.pageOffset=0;this.pageLimit=50;this.pageData=null;this.loadSequence=0;this.query='';this.advanced={};this.directoryFilters={};this.directoryLabels={};this.libraryView='games';this.inclusion='all';this.sort=remote?.played?'played':'added';this.direction=remote?.played?'desc':'asc';this.busy=false;this.disposed=false;
  const saved=readListState(stateKey);for(const key of ['query','advanced','directoryFilters','directoryLabels','inclusion','sort','direction','pageOffset','pageLimit'])if(saved[key]!==undefined)this[key]=saved[key];this.restoreScroll=saved.scroll;this.savedDraft=saved.draft;this.advancedOpen=saved.advancedOpen;this.pageLimit=listPageSize(this.pageLimit);
  this.keydown=e=>{if(e.key==='Enter'&&e.target?.dataset?.etControl==='search'){e.preventDefault();this.query=e.target.value;this.queryChanged();}};host.addEventListener('keydown',this.keydown);
  this.click=e=>this.handleClick(e);this.change=e=>this.handleChange(e);this.input=e=>{if(e.target?.dataset?.etControl==='search'){this.query=e.target.value;this.queryChanged(true);}else if(e.target?.hasAttribute?.('data-game-filter'))markListDirty(this.host,true);};
  this.submit=e=>{if(e.target?.hasAttribute?.('data-et-advanced')){e.preventDefault();this.applyAdvanced();}};host.addEventListener('submit',this.submit);host.addEventListener('click',this.click);host.addEventListener('change',this.change);host.addEventListener('input',this.input);this.render();if(this.savedDraft)fillGameFilters(this.host,this.savedDraft);const details=this.host.querySelector('[data-game-search]');if(details)details.open=!!this.advancedOpen;if(saved.libraryView&&saved.libraryView!=='games')this.setLibraryView(saved.libraryView);this.renderFilterChips();markListDirty(this.host,JSON.stringify(gameFilterParams(this.savedDraft||this.advanced))!==JSON.stringify(gameFilterParams(this.advanced)));
 }
 get visible(){return this.remote?this.entries:visibleEntries(this.entries,this);}
 get selectedIds(){return this.remote?[...this.selection]:this.entries.filter(e=>this.selection.has(Number(e.id))).map(e=>Number(e.id));}
 update({entries=this.entries,base=this.base}={}){
  if(this.disposed)return;
  this.entries=[...entries];this.base=base;
  const ids=new Set(this.entries.map(e=>Number(e.id)));if(!this.remote)this.selection=new Set([...this.selection].filter(id=>ids.has(id)));this.renderRows();
 }
 dispose(){
  writeListState(this.stateKey,{query:this.query,advanced:this.advanced,draft:gameFilterDraft(this.host),advancedOpen:!!this.host.querySelector('[data-game-search]')?.open,libraryView:this.libraryView,directoryFilters:this.directoryFilters,directoryLabels:this.directoryLabels,inclusion:this.inclusion,sort:this.sort,direction:this.direction,pageOffset:this.pageOffset,pageLimit:this.pageLimit,scroll:captureListScroll()});
  this.host.removeEventListener('keydown',this.keydown);this.disposed=true;this.directory?.dispose();clearTimeout(this.searchTimer);this.controller?.abort();this.loadSequence++;this.host.removeEventListener('submit',this.submit);this.host.removeEventListener('click',this.click);this.host.removeEventListener('change',this.change);this.host.removeEventListener('input',this.input);
  if(this.dialog?.open&&this.dialog.querySelector('form')===this.dialogForm)this.dialog.close();
 }
 render(){
  this.host.innerHTML=(this.remote&&!this.remote.played?libraryViewsHtml():'')+ui('<section data-library-games><div class="entry-list">')+listSearchPanelHtml(ui('<div class="entry-list-controls list-toolbar"><label class="entry-search list-search">Rechercher<input type="search" data-et-control="search" placeholder="Titre, joueur, site…" value="')+esc(this.query)+ui('"></label><label>Révisions<select data-et-control="inclusion">')+[['all',t('Toutes les parties')],['included',t('Incluses')],['excluded',t('Exclues')]].map(([v,l])=>option(v,l,this.inclusion)).join('')+ui('</select></label><label>Trier par<select data-et-control="sort">')+(this.remote?.played?[['played','Dernières parties jouées'],...ENTRY_SORTS]:ENTRY_SORTS).map(([v,l])=>option(v,t(l),this.sort)).join('')+ui('</select></label><button type="button" data-et-action="direction" class="entry-sort-direction"></button><button type="button" data-et-action="reset">Réinitialiser</button></div><form data-et-advanced>')+gameSearchHtml(this.advanced,ui('<div class="game-search-actions"><button type="submit" class="primary" data-et-action="advanced-apply">Appliquer les critères</button><button type="button" data-et-action="advanced-reset">Effacer les critères avancés</button></div>'))+ui('</form>'))+ui('<div data-list-chips></div><div class="entry-list-summary" aria-live="polite" data-et-summary></div><p class="entry-review-hint" data-et-review-hint hidden>Les inclusions sont conservées. Active les révisions dans les réglages de cette base pour les utiliser.</p><div class="entry-bulk-actions" aria-label="Actions sur la sélection"><span data-et-selection></span><button type="button" data-et-action="clear">Désélectionner</button><button type="button" data-et-action="metadata">Modifier les informations PGN…</button><button type="button" data-et-action="include">Inclure aux révisions</button><button type="button" data-et-action="exclude">Exclure</button><button type="button" data-et-action="duplicate">Dupliquer…</button><button type="button" data-et-action="move">Déplacer…</button><button type="button" data-et-action="delete" class="danger">Supprimer…</button></div><div class="table-scroll entry-table-scroll" data-et-table></div><div class="actions entry-pagination" data-et-pagination></div></div></section>');
  if(this.remote&&!this.remote.played)this.directory=new LibraryDirectory(this.host.querySelector('[data-library-directory]'),{stateKey:this.stateKey?this.stateKey+'/directory':null,endpoint:'/api/bases/'+this.base.id+'/directory',request:this.request,onSelect:(kind,item)=>{const key=kind==='players'?'player_key':'event_key';this.directoryFilters[key]=item.key;this.directoryLabels[key]=item.name;this.setLibraryView('games');this.queryChanged();}});
  this.renderRows();
 }
 setLibraryView(view){
  if(!this.directory)return;this.libraryView=view;this.host.querySelector('[data-library-games]').hidden=view!=='games';this.host.querySelector('[data-library-directory]').hidden=view==='games';this.host.querySelectorAll('[data-library-view]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.libraryView===view)));
  const selection=this.host.querySelector('[data-directory-selection]');selection.innerHTML=directorySelectionHtml(this.directoryLabels);selection.hidden=!Object.keys(this.directoryLabels).length;
  if(view==='games')this.directory.hide();
  if(view!=='games'){const key=view==='players'?'event_key':'player_key';void this.directory.show(view,this.directoryFilters[key]?{[key]:this.directoryFilters[key]}:{});}
 }
 renderRows(){
  if(this.disposed)return;
  for(const entry of this.entries)if(this.selection.has(Number(entry.id)))this.selectedEntries.set(Number(entry.id),entry);
  this.renderFilterChips();
  const rows=this.visible,selected=this.selectedIds,visibleSelected=rows.filter(e=>this.selection.has(Number(e.id))).length,hidden=selected.length-visibleSelected;
  const focus=globalThis.document?.activeElement;
  const focusKey=this.host.contains?.(focus)?['data-et-select','data-et-select-all','data-et-review','data-et-sort'].find(key=>focus.hasAttribute(key)):null;
  const focusSelector=focusKey?'['+focusKey+(focusKey==='data-et-select-all'?'':'="'+focus.getAttribute(focusKey)+'"')+']':null;
  if(this.busy&&focusSelector)this.pendingFocusSelector=focusSelector;
  const heading=(label,key)=>'<th scope="col" aria-sort="'+(this.sort===key?(this.direction==='asc'?'ascending':'descending'):'none')+'"><button type="button" data-et-sort="'+key+'">'+label+(this.sort===key?(this.direction==='asc'?' ↑':' ↓'):'')+'</button></th>';
  this.host.querySelector('[data-et-table]').innerHTML=ui('<table class="entry-table list-table"><thead><tr><th scope="col"><input type="checkbox" data-et-select-all aria-label="Sélectionner toutes les parties affichées"></th>')+heading('Date','date')+heading(t('Blancs'),'white')+heading(t('Noirs'),'black')+heading(t('Résultat'),'result')+heading(t('Cadence'),'timecontrol')+heading(t('Titre / site'),'title')+heading(t('Réviser'),'review')+'<th scope="col"><span class="entry-sr-only">Actions</span></th></tr></thead><tbody>'+rows.map(e=>this.rowHtml(e)).join('')+'</tbody></table>'+(!rows.length?'<div class="entry-list-empty">'+(this.loading?t('Chargement…'):this.remote&&this.pageData?.total_all||this.entries.length?t('Aucune partie ne correspond aux filtres.'):t('Cette base est vide. Importe un PGN ou sauvegarde une partie dans cette base.'))+'</div>':'');
  const all=this.host.querySelector('[data-et-select-all]');all.checked=rows.length>0&&visibleSelected===rows.length;all.indeterminate=visibleSelected>0&&visibleSelected<rows.length;all.disabled=this.busy||!rows.length;all.setAttribute('aria-checked',all.indeterminate?'mixed':String(all.checked));
  this.host.querySelector('[data-et-summary]').textContent=rows.length+' / '+this.entries.length+t(' partie')+(this.entries.length===1?'':'')+t(' ou exercice')+(this.entries.length===1?'':'')+' · '+this.entries.filter(e=>e.selected).length+t(' inclus aux révisions');
  this.host.querySelector('[data-et-review-hint]').hidden=!!this.base.settings?.review_enabled;
  this.host.querySelector('[data-et-selection]').textContent=t(selected.length===1?'{count} sélectionnée':'{count} sélectionnées',{count:selected.length})+(hidden?t(hidden===1?' · dont {count} masquée':' · dont {count} masquées',{count:hidden}):'');
  this.host.querySelector('.entry-bulk-actions').hidden=!selected.length||!!this.remote?.played;
  const dir=this.host.querySelector('[data-et-action="direction"]');dir.textContent=this.direction==='asc'?t('↑ Croissant'):t('↓ Décroissant');dir.setAttribute('aria-label',t('Ordre ')+(this.direction==='asc'?t('croissant'):t('décroissant'))+t(' : inverser le tri'));
  this.host.querySelector('[data-library-games]').querySelectorAll('button,input,select').forEach(el=>{el.disabled=this.busy||(el.hasAttribute('data-et-select-all')&&!rows.length);});
  this.host.setAttribute('aria-busy',String(this.busy||this.loading));
  if(this.remote)this.renderPagination();
  const restoreFocus=focusSelector||(!this.busy?this.pendingFocusSelector:null);
  if(restoreFocus&&!this.busy){this.host.querySelector(restoreFocus)?.focus({preventScroll:true});this.pendingFocusSelector=null;}
 }
 rowHtml(e){
  const h=e.headers||{},id=Number(e.id),name=entryName(e),checked=this.selection.has(id),review=!!e.selected;
  return '<tr'+(checked?' class="entry-selected"':'')+' data-et-row="'+id+ui('"><td class="entry-select-cell" data-label="Sélection"><label><input type="checkbox" data-et-select="')+id+'" aria-label="'+esc(t('Sélectionner {name}',{name}))+'" '+(checked?'checked':'')+ui('><span class="entry-mobile-label">Sélectionner</span></label></td><td data-label="Date">')+esc(h.Date||'—')+ui('</td><td data-label="Blancs"><strong>')+esc(h.White||'—')+'</strong><small>'+esc(h.WhiteElo||'')+ui('</small></td><td data-label="Noirs"><strong>')+esc(h.Black||'—')+'</strong><small>'+esc(h.BlackElo||'')+ui('</small></td><td data-label="Résultat">')+esc(h.Result||'*')+ui('</td><td data-label="Cadence">')+esc(h.TimeControl||'—')+ui('</td><td class="entry-title-cell" data-label="Titre / site"><div class="entry-title-heading"><button type="button" class="entry-title-link" data-et-action="open" data-et-id="')+id+'">'+esc(name)+'</button>'+(e.is_new===true?ui('<span class="entry-new-badge" title="Pas encore consultée ou révisée">Nouveau</span>'):'')+'</div>'+(this.base.settings?.reading_enabled&&e.reading?.enabled?ui('<span class="entry-reading-badge" title="Progression de lecture de la ligne principale">')+readingPercent(e.reading.percent)+(e.reading.completed?t(' · Lu'):'')+'</span>':'')+'<small>'+esc(h.Site||'')+ui('</small></td><td class="entry-review-cell" data-label="Réviser"><label><input type="checkbox" data-et-review="')+id+'" aria-label="'+esc(t('Inclure {name} aux révisions',{name}))+'" '+(review?'checked':'')+ui('><span class="entry-mobile-label">Réviser</span></label></td><td class="entry-row-actions"><button type="button" data-et-action="open" data-et-id="')+id+ui('">Ouvrir</button><button type="button" data-et-action="menu" data-et-id="')+id+'" aria-label="'+esc(t('Actions pour {name}',{name}))+'" aria-haspopup="dialog" title="Actions">⋯</button></td></tr>';
 }
 params(extra={}){return new URLSearchParams({limit:String(this.pageLimit),offset:String(this.pageOffset),search:this.query,inclusion:this.inclusion,sort:this.sort,descending:String(this.direction==='desc'),...gameFilterParams(this.advanced),...this.directoryFilters,...extra});}
 navigation(id){return this.remote?{baseId:this.base.id,remote:{endpoint:this.remote.endpoint,params:Object.fromEntries(this.params())},currentId:Number(id)}:null;}
 renderFilterChips(){
  const chips=gameFilterChips(this.advanced);if(this.query)chips.unshift({key:'query',label:'Rechercher',value:this.query});if(this.inclusion!=='all')chips.push({key:'inclusion',label:'Révisions',value:t(this.inclusion==='included'?'Incluses':'Exclues')});for(const[key,value]of Object.entries(this.directoryLabels))chips.push({key,label:key==='player_key'?'Joueurs':'Tournois',value});const host=this.host.querySelector('[data-list-chips]');if(host)host.innerHTML=listChipsHtml(chips);
 }
 applyAdvanced(){
  if(this.busy||this.disposed)return;const error=this.host.querySelector('[data-game-search-error]');
  try{this.advanced=readGameFilters(this.host);markListDirty(this.host,false);error.hidden=true;error.textContent='';this.host.querySelector('[data-game-search-count]').innerHTML=gameSearchCountLabel(this.advanced);this.queryChanged();}
  catch(problem){error.textContent=problem.message;error.hidden=false;}
 }
 queryChanged(debounce=false){
  if(!this.remote){this.renderRows();return;}
  clearTimeout(this.searchTimer);this.controller?.abort();this.loadSequence++;this.pageOffset=0;this.entries=[];this.pageData=null;this.loading=true;this.renderRows();
  if(debounce)this.searchTimer=setTimeout(()=>void this.loadPage(0),200);else void this.loadPage(0);
 }
 async loadPage(offset=this.pageOffset){
  if(!this.remote||this.disposed)return;
  clearTimeout(this.searchTimer);this.controller?.abort();this.controller=new AbortController();const sequence=++this.loadSequence;
  this.loading=true;this.preparing=false;this.loadError=null;this.renderPagination();
  try{
   const url=this.remote.endpoint+(this.remote.endpoint.includes('?')?'&':'?')+this.params({offset:String(offset)});
   const data=await requestPreparedCatalog((...args)=>this.request(...args),url,{signal:this.controller.signal,onPreparing:()=>{this.preparing=true;this.renderPagination();}});
   if(this.disposed||sequence!==this.loadSequence)return;
   this.pageData=data;this.pageOffset=data.offset;this.entries=data.entries||[];this.renderRows();
   if(!this.entries.length&&data.total>0&&offset>0){await this.loadPage(Math.floor((data.total-1)/this.pageLimit)*this.pageLimit);return;}
  }catch(error){if(this.disposed||sequence!==this.loadSequence||error.name==='AbortError')return;this.loadError=error;}
  finally{if(!this.disposed&&sequence===this.loadSequence){this.loading=false;this.renderRows();if(this.restoreScroll!=null){restoreListScroll(this.host,this.restoreScroll);this.restoreScroll=null;}}}
 }
 renderPagination(){
  const host=this.host.querySelector('[data-et-pagination]');if(!host)return;
  const data=this.pageData,total=data?.total||0;
  const summary=this.host.querySelector('[data-et-summary]');if(summary&&data)summary.textContent=(data.total!==data.total_all?t('{count} résultats sur {total} parties',{count:data.total,total:data.total_all})+' · ':t('{count} parties',{count:data.total_all})+' · ')+t('{count} incluses aux révisions',{count:data.selected_total});
  host.innerHTML=(this.loadError?'<span role="alert">'+esc(this.loadError.message)+'</span><button data-et-action="retry">'+t('Réessayer')+'</button>':'')+(this.loading?'<span role="status">'+(this.preparing?t('Préparation de la liste…'):t('Chargement…'))+'</span>':'')+listPaginationHtml({offset:this.pageOffset,limit:this.pageLimit,total:data?.total??null,count:this.entries.length,hasMore:!!data?.has_more,loading:this.loading,previous:'data-et-action="page-prev"',next:'data-et-action="page-next"',size:'data-list-size'});
 }
 setSort(key){
  if(!ENTRY_SORTS.some(([k])=>k===key)&&!(this.remote?.played&&key==='played'))return;
  if(this.sort===key)this.direction=this.direction==='asc'?'desc':'asc';else{this.sort=key;this.direction='asc';}
  const control=this.host.querySelector('[data-et-control="sort"]');if(control)control.value=this.sort;this.queryChanged();
 }
 handleChange(event){
  if(this.disposed||this.busy)return;
  const el=event.target,d=el?.dataset||{};
  if(el?.hasAttribute?.('data-list-size')){this.pageLimit=listPageSize(el.value);this.queryChanged();}
  else if(d.etSelect!==undefined){const id=Number(d.etSelect);if(!this.entries.some(e=>Number(e.id)===id))return;el.checked?this.selection.add(id):this.selection.delete(id);this.renderRows();}
  else if(el?.hasAttribute?.('data-et-select-all')){for(const e of this.visible)el.checked?this.selection.add(Number(e.id)):this.selection.delete(Number(e.id));this.renderRows();}
  else if(d.etReview!==undefined){this.runBatch({action:'review',entry_ids:[Number(d.etReview)],selected:el.checked}).catch(this.onError);}
  else if(d.etControl==='inclusion'){this.inclusion=el.value;this.queryChanged();}
  else if(d.etControl==='sort'){this.setSort(el.value);}
 }
 handleClick(event){
  if(this.disposed||this.busy)return;
  const button=event.target.closest?.('[data-et-action],[data-et-sort],[data-library-view],[data-directory-clear],[data-list-clear]');if(!button||!this.host.contains(button))return;
  if(button.hasAttribute('data-list-clear')){const key=button.dataset.listClear;if(key==='query'){this.query='';this.host.querySelector('[data-et-control="search"]').value='';}else if(key==='inclusion'){this.inclusion='all';this.host.querySelector('[data-et-control="inclusion"]').value='all';}else if(key==='player_key'||key==='event_key'){delete this.directoryFilters[key];delete this.directoryLabels[key];this.setLibraryView(this.libraryView);}else{delete this.advanced[key];fillGameFilters(this.host,this.advanced);this.host.querySelector('[data-game-search-count]').innerHTML=gameSearchCountLabel(this.advanced);}this.queryChanged();return;}
  if(button.dataset.libraryView){this.setLibraryView(button.dataset.libraryView);return;}
  if(button.hasAttribute('data-directory-clear')){this.directoryFilters={};this.directoryLabels={};this.setLibraryView(this.libraryView);this.queryChanged();return;}
  if(button.dataset.etSort){this.setSort(button.dataset.etSort);return;}
  const action=button.dataset.etAction,id=Number(button.dataset.etId);
  if(action==='reset'){this.query='';this.advanced={};this.inclusion='all';this.sort=this.remote?.played?'played':'added';this.direction=this.remote?.played?'desc':'asc';this.directoryFilters={};this.directoryLabels={};resetGameFilters(this.host);this.host.querySelector('[data-et-control="search"]').value='';this.host.querySelector('[data-et-control="inclusion"]').value='all';this.host.querySelector('[data-et-control="sort"]').value=this.sort;this.host.querySelector('[data-game-search-count]').textContent='';markListDirty(this.host,false);this.setLibraryView('games');this.queryChanged();return;}
  if(action==='advanced-apply'){return;}
  if(action==='advanced-reset'){resetGameFilters(this.host);markListDirty(this.host,false);this.advanced={};this.host.querySelector('[data-game-search-count]').textContent='';this.queryChanged();return;}
  if(action==='direction'){this.direction=this.direction==='asc'?'desc':'asc';this.queryChanged();return;}
  if(action==='page-prev'||action==='page-next'||action==='retry'){void this.loadPage(action==='page-prev'?Math.max(0,this.pageOffset-this.pageLimit):action==='page-next'?this.pageOffset+this.pageLimit:this.pageOffset);return;}
  if(action==='clear'){this.selection.clear();this.selectedEntries.clear();this.renderRows();return;}
  if(action==='open'){Promise.resolve().then(()=>this.onOpenEntry?.(id)).catch(this.onError);return;}
  if(action==='menu'){this.showRowActions(id);return;}
  this.requestAction(action,this.selectedIds);
 }
 showRowActions(id){
  if(this.remote?.played){Promise.resolve(this.onMetadata?.(id)).catch(this.onError);return;}
  const entry=this.entries.find(e=>Number(e.id)===id);if(!entry)return;
  const dialog=this.openModal(entryName(entry),'<div class="entry-action-list">'+[['metadata',t('Informations PGN')],[entry.selected?'exclude':'include',entry.selected?t('Exclure des révisions'):t('Inclure aux révisions')],['duplicate',t('Dupliquer…')],['move',t('Déplacer vers une autre base…')],['delete',t('Supprimer…')]].map(([key,label])=>'<button type="button" data-et-single="'+key+'"'+(key==='delete'?' class="danger"':'')+'>'+label+'</button>').join('')+'</div>');
  this.trackDialog(dialog);
  dialog.querySelectorAll('[data-et-single]').forEach(button=>button.onclick=()=>{if(this.disposed||this.busy)return;dialog.close();const action=button.dataset.etSingle;if(action==='metadata')Promise.resolve().then(()=>this.onMetadata?.(id)).catch(this.onError);else this.requestAction(action,[id]);});
 }
 trackDialog(dialog){this.dialog=dialog;this.dialogForm=dialog.querySelector('form');}
 requestAction(action,ids){
  if(this.disposed||this.busy||!ids.length)return;
  ids=[...new Set(ids.map(Number))];const chosen=ids.map(id=>this.entries.find(e=>Number(e.id)===id)||this.selectedEntries.get(id)).filter(Boolean);if(chosen.length!==ids.length)return;
  if(action==='metadata'){this.trackDialog(editBatchMetadata(chosen,{baseName:this.base.name,openModal:this.openModal,onSubmit:headers=>this.runBatch({action:'metadata',entry_ids:ids,headers})}));return;}
  if(action==='include'||action==='exclude'){this.runBatch({action:'review',entry_ids:ids,selected:action==='include'}).catch(this.onError);return;}
  if(!['delete','duplicate','move'].includes(action))return;
  const source='<p><strong>'+ids.length+t(' partie')+(ids.length===1?'':'s')+t(' ou exercice')+(ids.length===1?'':'s')+ui('</strong> de la base <strong>')+esc(this.base.name)+'</strong>.</p><ul class="entry-confirm-list">'+chosen.slice(0,5).map(e=>'<li>'+esc(entryName(e))+'</li>').join('')+(chosen.length>5?ui('<li>Et ')+(chosen.length-5)+t(' autre')+(chosen.length===6?'':'s')+'…</li>':'')+'</ul>';
  if(action==='delete'){
   this.trackDialog(this.openModal(t('Supprimer la sélection'),source+ui('<p class="hint">Les parties, leurs variantes et annotations seront supprimées de cette base, puis retirées des révisions. Cette action ne peut pas être annulée.</p><p class="hint">Une partie synchronisée pourra être téléchargée de nouveau à la prochaine synchronisation.</p>'),{submit:t('Supprimer ')+ids.length,onSubmit:()=>this.runBatch({action,entry_ids:ids})}));return;
  }
  const bases=this.getBases().filter(b=>action==='duplicate'||Number(b.id)!==Number(this.base.id));
  if(!bases.length){this.notify(t('Crée une autre base avant de déplacer ces parties.'));return;}
  const defaultId=action==='duplicate'?this.base.id:bases[0].id;
  this.trackDialog(this.openModal(action==='move'?t('Déplacer la sélection'):t('Dupliquer la sélection'),source+ui('<label>Base de destination<select name="target_base_id" required>')+bases.map(b=>option(b.id,b.name+(Number(b.id)===Number(this.base.id)?t(' (base actuelle)'):''),defaultId)).join('')+'</select></label><p class="hint">'+(action==='move'?t('Le PGN et l’historique d’édition sont conservés. Les réglages de révision de la destination s’appliquent ; la progression de révision précédente ne sera pas transférée.'):t('Une copie indépendante sera créée avec tous les coups, variantes et commentaires. Les copies utilisent les réglages de la destination. Les positions d’ouverture déjà apprises dans cette base gardent leur progression.'))+'</p>',{submit:action==='move'?t('Déplacer'):t('Dupliquer'),onSubmit:data=>{const target=Number(data.get('target_base_id'));if(!bases.some(b=>Number(b.id)===target))throw new Error(t('Choisis une base de destination.'));return this.runBatch({action,entry_ids:ids,target_base_id:target});}}));
 }
 async runBatch(payload){
  if(this.disposed||this.busy)return false;
  this.busy=true;this.renderRows();let result;
  try{if(this.remote?.played){const entry=this.entries.find(e=>Number(e.id)===payload.entry_ids[0]);if(payload.action!=='review'||!entry)throw Error(t('Ouvre la base pour modifier cette sélection.'));result=await this.request('/api/entries/'+entry.id,{method:'PATCH',body:{selected:payload.selected,...(entry.revision?{expected_revision:entry.revision}:{})}});}else{const revisions=Object.fromEntries(payload.entry_ids.map(id=>{const row=this.entries.find(e=>Number(e.id)===id)||this.selectedEntries.get(id);return [id,row?.revision];}));if(Object.values(revisions).every(Boolean))payload={...payload,expected_revisions:revisions};this.onBatchStart?.(payload);result=await this.request('/api/bases/'+this.base.id+'/entries/batch',{method:'POST',body:payload});}}
  catch(error){this.busy=false;if(!this.disposed)this.renderRows();throw error;}
  const event={...result,...payload,source_base_id:Number(this.base.id),entry_ids:result?.entry_ids||payload.entry_ids};
  if(!this.disposed){
   if(payload.action==='delete'||payload.action==='move'){const ids=new Set(payload.entry_ids);this.entries=this.entries.filter(e=>!ids.has(Number(e.id)));for(const id of ids){this.selection.delete(id);this.selectedEntries.delete(id);}}
   if(payload.action==='review'){const ids=new Set(payload.entry_ids);this.entries=this.entries.map(e=>ids.has(Number(e.id))?{...e,selected:payload.selected}:e);}
   if(payload.action==='metadata'){const updated=new Map((result?.updated_entries||[]).map(e=>[Number(e.id),e]));for(const[id,value]of updated)if(this.selectedEntries.has(id))this.selectedEntries.set(id,{...this.selectedEntries.get(id),...value});this.entries=this.entries.map(e=>updated.has(Number(e.id))?{...e,...updated.get(Number(e.id))}:e);}
   this.renderRows();
   const count=result?.count??payload.entry_ids.length;
   const verb=payload.action==='review'?(payload.selected?t('inclus aux révisions'):(count===1?t('exclu'):t('exclus'))+t(' des révisions')):t(({delete:'supprimé',duplicate:'dupliqué',move:'déplacé',metadata:'mis à jour'})[payload.action]+(payload.action==='metadata'||count===1?'':'s'));
   this.notify(count+t(' élément')+(count===1?'':'s')+' '+verb+'.');
  }
  // Inform the owner even after navigation: the server mutation already succeeded.
  try{await this.onChanged?.(event);}catch(error){this.onError(error);}
  finally{this.busy=false;if(!this.disposed)this.renderRows();}
  return result;
 }
}
