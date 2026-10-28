import {referenceGamesHtml,REFERENCE_SORTS} from './game-results.js';
export {referenceGamesHtml,REFERENCE_SORTS} from './game-results.js';
import {t,ui,locale} from './i18n.js';
import {api,esc,field,select,modal,notice,option} from './api.js';
import {LibraryDirectory,libraryViewsHtml,directorySelectionHtml} from './library-directory.js';
import {listSearchPanelHtml,listChipsHtml,listPaginationHtml,listPageSize,readListState,writeListState,captureListScroll,restoreListScroll,markListDirty} from './list-view.js';
import {gameSearchHtml,readGameFilters,gameFilterParams,gameSearchCountLabel,gameFilterChips,gameFilterDraft,fillGameFilters} from './game-search.js';
import {searchProgressHtml} from './search-progress.js';

const count=value=>new Intl.NumberFormat(locale()).format(Number(value)||0);
const available=status=>Number(status.game_count??status.imported)||0;
const active=status=>['queued','running'].includes(status);
export function referenceStatusLabel(status){return ({queued:t('En attente'),running:t('Importation en cours'),paused:t('Importation en pause'),completed:t('Importation terminée'),limited:t('Limite atteinte'),error:t('Importation interrompue')})[status]||t('Base de référence');}
export function referenceImportDialog({foldersHtml='',onCreated=async()=>{}}={}){
 return modal(t('Importer une grande base'),field(t('Nom de la base'),'name','','text','required maxlength="200"')+ui('<label>Dossier<select name="folder_id">')+foldersHtml+'</select></label>'+field(t('Chemin du fichier PGN ou PGN.ZST'),'path','','text','required spellcheck="false" placeholder="C:\\Bases\\maitres.pgn"')+ui('<p class="hint">Indique le chemin sur le PC ou le serveur qui héberge Chess Gym. Le fichier est lu progressivement, sans le téléverser depuis cet appareil.</p>')+field(t('Maximum de parties à lire · vide = tout le fichier'),'max_games','100000','number','min="1" max="1000000000" step="1"')+ui('<p class="hint">Commence avec 100 000 parties pour vérifier ta base. Tu pourras poursuivre ensuite par lots de cette taille. L’original reste conservé.</p><details><summary>Options avancées</summary>')+select(t('Encodage du fichier'),'encoding',[['utf-8-sig',t('UTF-8 · Lichess et exports récents')],['cp1252',t('Windows-1252 · anciens PGN ChessBase')],['latin-1','Latin-1']], 'utf-8-sig')+ui('<p class="hint">Garde UTF-8 pour Lichess. Pour un export ChessBase, choisis l’encodage utilisé lors de l’exportation afin de préserver les accents.</p></details>'),{submit:t('Lancer l’importation'),onSubmit:async form=>{
  const name=String(form.get('name')||'').trim(),path=String(form.get('path')||'').trim(),maximum=String(form.get('max_games')||'').trim();
  if(!name||!path)throw new Error(t('Indique un nom et le chemin du fichier.'));
  if(maximum&&(!/^\d+$/.test(maximum)||!Number.isSafeInteger(Number(maximum))||Number(maximum)<1))throw new Error(t('La limite doit être un nombre entier positif.'));
  const encoding=String(form.get('encoding')||'utf-8-sig');if(!['utf-8-sig','cp1252','latin-1'].includes(encoding))throw new Error(t('Choisis un encodage proposé pour ce fichier.'));
  const body={name,path,folder_id:form.get('folder_id')?Number(form.get('folder_id')):null,encoding};if(maximum)body.max_games=Number(maximum);
  const base=await api('/api/reference-bases',{method:'POST',body});await onCreated(base);
 }});
}
export function referencePhaseLabel(status={}){
 if(!active(status.status)&&!status.worker_active)return referenceStatusLabel(status.status);
 const phase=status.phase;
 if(status.pause_requested)return phase==='finalizing'?t('Mise en pause · finalisation'):phase==='committing'?t('Mise en pause · enregistrement'):t('Mise en pause en cours');
 return ({preparing:t('Préparation de l’import'),replaying:t('Reprise du fichier compressé'),processing:t('Lecture et indexation'),committing:t('Enregistrement du lot'),finalizing:t('Finalisation sur disque'),stopping:t('Mise en pause en cours')})[phase]||referenceStatusLabel(status.status);
}
export function referenceStatusHtml(status={},busy=false){
 const state=status.status,running=active(state)||Boolean(status.worker_active),workers=Number(status.workers),parallel=running&&Number.isInteger(workers)&&workers>1,progress=Number(status.total_bytes)>0?Math.min(100,Math.max(0,100*(Number(status.bytes_read)||0)/Number(status.total_bytes))):null;
 const actions=running?'<button type="button" data-reference-action="pause" '+(busy||status.pause_requested?'disabled':'')+'>'+(status.pause_requested?t('Pause demandée'):t('Mettre en pause'))+'</button>':['paused','limited','error'].includes(state)?'<button type="button" data-reference-action="resume" '+(busy?'disabled':'')+ui('>Poursuivre l’importation</button>'):'';
 const phaseHint=status.phase==='finalizing'?t('Le traitement termine l’écriture sur disque. Il reste actif jusqu’à la fin de cette étape.'):status.pause_requested?t('La pause prend effet après l’enregistrement du lot en cours.'):status.phase==='replaying'?t('Relecture de la portion déjà importée du fichier compressé, sans ajouter de doublons.'):status.phase==='committing'?t('Les compteurs affichent le dernier lot enregistré.'):'';
 return '<div class="reference-import-heading"><strong>'+esc(referencePhaseLabel(status))+'</strong>'+actions+'</div><div class="reference-import-counts"><span>'+count(available(status))+ui(' parties disponibles</span><span>')+count(status.processed)+ui(' lues</span>')+(parallel?ui('<span title="Traitement parallèle">')+count(workers)+ui(' cœurs</span>'):'')+(Number(status.rejected)?'<span>'+count(status.rejected)+ui(' écartées</span>'):'')+(Number(status.duplicates)?'<span>'+count(status.duplicates)+ui(' doublons</span>'):'')+'</div>'+(running?ui('<progress aria-label="Progression de lecture du fichier" max="100" ')+(progress===null?'':'value="'+progress+'"')+ui('></progress><p class="hint">Lecture du fichier')+(progress===null?'': ' : '+Math.floor(progress)+' %')+ui(' · la finalisation peut continuer après 100 %.</p>'):'')+(running&&phaseHint?'<p class="hint">'+esc(phaseHint)+'</p>':'')+(state==='limited'?ui('<p class="hint">La limite de lecture a été atteinte. Les statistiques portent sur les parties déjà importées.</p>'):state!=='completed'?ui('<p class="hint">Les parties déjà importées restent consultables ; les statistiques sont encore partielles.</p>'):'')+(status.error?'<p class="reference-error" role="alert">'+esc(status.error)+'</p>':'');
}

export class ReferenceLibrary{
 constructor(host,{base,onOpenGame=async()=>{},onStatus=()=>{},request=api,pollMs=2500,stateKey=null,getBases=()=>[],openModal=modal,notify=notice,onChanged=async()=>{}}={}){
  this.getBases=getBases;this.openModal=openModal;this.notify=notify;this.onChanged=onChanged;this.selection=new Set();this.selectedEntries=new Map();this.batchBusy=false;
  this.host=host;this.base=base;this.onOpenGame=onOpenGame;this.onStatus=onStatus;this.request=request;this.pollMs=pollMs;this.disposed=false;this.sequence=0;this.status=base.reference_status||{};this.filters={search:'',sort:'id',descending:false,rating_min:'',rating_max:'',speed:''};this.offset=0;this.limit=50;this.loading=false;this.opening=false;this.mutating=false;this.data=null;this.dataFiltersKey=null;this.directoryLabels={};this.libraryView='games';
  this.stateKey=stateKey;const saved=readListState(stateKey);if(saved.filters)this.filters=saved.filters;this.offset=saved.offset||0;this.limit=listPageSize(saved.limit||50);this.directoryLabels=saved.directoryLabels||{};this.restoreScroll=saved.scroll;
  this.preparationTimer=null;this.preparingSince=null;this.preparationAttempt=0;this.preparationPaused=false;this.preparationFailed=false;
  host.innerHTML='<section class="reference-library"><div class="reference-import-status" data-reference-status aria-live="polite"></div><div data-reference-error role="alert" hidden></div>'+libraryViewsHtml()+'<section data-library-games>'+listSearchPanelHtml('<form class="reference-filters"><div class="list-toolbar">'+field(t('Rechercher joueurs ou événement'),'search','','search',ui('maxlength="200" placeholder="Joueur, tournoi…"'))+select(t('Trier par'),'sort',REFERENCE_SORTS.map(([value,label])=>[value,t(label)]),'id')+select(t('Ordre'),'descending',[['false',t('Croissant')],['true',t('Décroissant')]],'false')+ui('<button type="button" data-reference-action="reset">Réinitialiser</button></div>')+gameSearchHtml(this.filters,ui('<div class="game-search-actions"><button type="submit" class="primary">Appliquer</button></div>'))+'</form>')+ui('<div data-list-chips></div><div class="entry-bulk-actions" data-reference-selection hidden aria-label="Actions sur la sélection"></div><div data-reference-games aria-live="polite"></div></section><p class="hint reference-footnote">Sélectionne des parties pour les dupliquer, les déplacer ou les supprimer. Pour les annoter ou les réviser, duplique-les dans une base personnelle. L’explorer et la recherche de positions utilisent la ligne principale des parties de référence.</p></section>');
  this.statusHost=host.querySelector('[data-reference-status]');this.gamesHost=host.querySelector('[data-reference-games]');this.errorHost=host.querySelector('[data-reference-error]');this.form=host.querySelector('form');this.directory=new LibraryDirectory(host.querySelector('[data-library-directory]'),{stateKey:stateKey?stateKey+'/directory':null,endpoint:'/api/reference-bases/'+base.id+'/directory',request:this.request,onSelect:(kind,item)=>{const key=kind==='players'?'player_key':'event_key';this.filters[key]=item.key;this.directoryLabels[key]=item.name;this.offset=0;this.setLibraryView('games');void this.load();}});
  for(const key of ['search','sort','descending']){const node=this.form.querySelector('[name="'+key+'"]');if(node)node.value=String(this.filters[key]??(key==='descending'?false:''));}fillGameFilters(this.form,saved.draft||this.filters);const details=this.form.querySelector('[data-game-search]');if(details)details.open=!!saved.advancedOpen;
  this.inputHandler=event=>{if(this.batchBusy)return;if(event.target?.name==='search'){clearTimeout(this.searchTimer);this.filters.search=event.target.value;this.offset=0;this.sequence++;this.controller?.abort();this.data=null;this.loading=true;this.renderGames();this.searchTimer=setTimeout(()=>void this.load(),250);}else if(event.target?.hasAttribute?.('data-game-filter'))markListDirty(this.form,true);};
  this.changeHandler=event=>{if(this.batchBusy)return;const node=event.target;if(node?.hasAttribute?.('data-reference-select')||node?.hasAttribute?.('data-reference-select-all'))return this.handleSelection(event);if(['sort','descending'].includes(node?.name)){this.filters[node.name]=node.name==='descending'?node.value==='true':node.value;this.offset=0;void this.load();}else if(node?.hasAttribute?.('data-list-size')){this.limit=listPageSize(node.value);this.offset=0;void this.load();}};
  this.keyHandler=event=>{if(this.batchBusy)return;if(event.key==='Enter'&&event.target?.name==='search'){event.preventDefault();clearTimeout(this.searchTimer);this.filters.search=event.target.value;this.offset=0;void this.load();}};host.addEventListener('input',this.inputHandler);host.addEventListener('change',this.changeHandler);host.addEventListener('keydown',this.keyHandler);
  this.clickHandler=event=>{this.click(event).catch(error=>this.error(error));};this.submitHandler=event=>{event.preventDefault();this.applyFilters().catch(error=>this.error(error));};
  host.addEventListener('click',this.clickHandler);this.form.addEventListener('submit',this.submitHandler);this.setLibraryView(saved.libraryView||'games');this.renderStatus();markListDirty(this.form,JSON.stringify(gameFilterParams(saved.draft||this.filters))!==JSON.stringify(gameFilterParams(this.filters)));this.ready=Promise.allSettled([this.load(),this.poll()]);
 }
 setLibraryView(view){
  this.libraryView=view;this.host.querySelector('[data-library-games]').hidden=view!=='games';this.host.querySelector('[data-library-directory]').hidden=view==='games';this.host.querySelectorAll?.('[data-library-view]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.libraryView===view)));
  const selection=this.host.querySelector('[data-directory-selection]');selection.innerHTML=directorySelectionHtml(this.directoryLabels);selection.hidden=!Object.keys(this.directoryLabels).length;
  if(view==='games')this.directory.hide();
  if(view!=='games'){const key=view==='players'?'event_key':'player_key';void this.directory.show(view,this.filters[key]?{[key]:this.filters[key]}:{});}
 }
 error(error){if(this.disposed||error?.name==='AbortError')return;this.errorHost.hidden=false;this.errorHost.className='reference-error';this.errorHost.textContent=error?.message||String(error);}
 clearError(){this.errorHost.hidden=true;this.errorHost.textContent='';}
 renderStatus(){if(!this.disposed)this.statusHost.innerHTML=referenceStatusHtml(this.status,this.mutating||this.batchBusy)+(this.refreshPending?'<button type="button" data-reference-action="refresh" '+(this.loading||this.opening?'disabled':'')+'>'+esc(t('De nouvelles parties sont disponibles · Actualiser la liste'))+'</button>':'');}
 get selectedIds(){return [...this.selection];}
 renderGames(){
  if(this.disposed)return;
  const focus=globalThis.document?.activeElement,focusKey=this.host.contains?.(focus)?['data-reference-select','data-reference-select-all'].find(key=>focus?.hasAttribute?.(key)):null;
  const focusSelector=focusKey?'['+focusKey+(focusKey==='data-reference-select-all'?'':'="'+focus.getAttribute(focusKey)+'"')+']':null;
  const chips=gameFilterChips(this.filters);if(this.filters.search)chips.unshift({key:'search',label:'Rechercher',value:this.filters.search});for(const[key,value]of Object.entries(this.directoryLabels))chips.push({key,label:key==='player_key'?'Joueurs':'Tournois',value});this.host.querySelector('[data-list-chips]').innerHTML=listChipsHtml(chips);
  const busy=this.loading||this.opening||this.batchBusy||this.mutating,entries=this.data?.entries||[];
  for(const entry of entries)if(this.selection.has(Number(entry.id)))this.selectedEntries.set(Number(entry.id),entry);
  this.gamesHost.setAttribute('aria-busy',String(busy||this.data?.status==='preparing'&&!this.preparationPaused));
  const progress=this.loading&&this.data?.status!=='preparing'?searchProgressHtml({label:'Chargement des parties…'}):'';
  this.gamesHost.innerHTML=progress+(this.data?referenceGamesHtml(this.data,busy,{preparationPaused:this.preparationPaused,preparationFailed:this.preparationFailed,limit:this.limit,selection:this.selection}):this.loading?'':'<p class="reference-empty">'+t('Aucune partie chargée. Utilise Filtrer pour réessayer.')+'</p>');
  const visibleSelected=entries.filter(entry=>this.selection.has(Number(entry.id))).length,hidden=this.selection.size-visibleSelected,all=this.gamesHost.querySelector('[data-reference-select-all]');
  if(all){all.checked=entries.length>0&&visibleSelected===entries.length;all.indeterminate=visibleSelected>0&&visibleSelected<entries.length;all.disabled=busy||!entries.length;all.setAttribute('aria-checked',all.indeterminate?'mixed':String(all.checked));}
  const bar=this.host.querySelector('[data-reference-selection]');bar.hidden=!this.selection.size;
  bar.innerHTML='<span aria-live="polite">'+esc(t(this.selection.size===1?'{count} sélectionnée':'{count} sélectionnées',{count:this.selection.size})+(hidden?t(hidden===1?' · dont {count} masquée':' · dont {count} masquées',{count:hidden}):''))+'</span>'+[['clear','Désélectionner'],['duplicate','Dupliquer…'],['move','Déplacer…'],['delete','Supprimer…']].map(([action,label])=>'<button type="button" data-reference-action="'+action+'" '+(busy?'disabled ':'')+(action==='delete'?'class="danger"':'')+'>'+esc(t(label))+'</button>').join('');
  this.form.querySelectorAll?.('button,input,select').forEach(node=>node.disabled=this.batchBusy);
  if(focusSelector&&!busy)this.gamesHost.querySelector(focusSelector)?.focus?.({preventScroll:true});
 }
 handleSelection(event){
  if(this.disposed||this.batchBusy||this.loading||this.opening||this.mutating)return;
  const node=event.target,entries=this.data?.entries||[];
  const chosen=node?.hasAttribute?.('data-reference-select-all')?entries:entries.filter(entry=>Number(entry.id)===Number(node?.dataset?.referenceSelect));
  for(const entry of chosen){const id=Number(entry.id);if(node.checked){this.selection.add(id);this.selectedEntries.set(id,entry);}else{this.selection.delete(id);this.selectedEntries.delete(id);}}
  this.renderGames();
 }
 trackDialog(dialog){this.dialog=dialog;this.dialogForm=dialog.querySelector?.('form');}
 showRowActions(id){
  if(this.disposed||this.batchBusy||this.loading||this.opening||this.mutating)return;
  const entry=this.data?.entries.find(entry=>Number(entry.id)===Number(id));if(!entry)return;
  const dialog=this.openModal(this.gameName(entry),'<div class="entry-action-list">'+[['duplicate','Dupliquer…'],['move','Déplacer vers une autre base…'],['delete','Supprimer…']].map(([action,label])=>'<button type="button" data-reference-single="'+action+'"'+(action==='delete'?' class="danger"':'')+'>'+esc(t(label))+'</button>').join('')+'</div>');
  this.trackDialog(dialog);dialog.querySelectorAll('[data-reference-single]').forEach(button=>button.onclick=()=>{if(this.disposed||this.batchBusy)return;dialog.close();this.requestAction(button.dataset.referenceSingle,[Number(id)]);});
 }
 gameName(entry){const h=entry.headers||{};return (h.White||'?')+t(' contre ')+(h.Black||'?')+(h.Event?' · '+h.Event:'');}
 requestAction(action,ids){
  if(this.disposed||this.batchBusy||this.loading||this.opening||this.mutating||!ids.length||!['duplicate','move','delete'].includes(action))return;
  ids=[...new Set(ids.map(Number))];const chosen=ids.map(id=>this.data?.entries.find(entry=>Number(entry.id)===id)||this.selectedEntries.get(id));if(chosen.some(entry=>!entry))return;
  const source='<p><strong>'+esc(t(ids.length===1?'{count} partie':'{count} parties',{count:ids.length}))+'</strong> · '+esc(this.base.name)+'</p><ul class="entry-confirm-list">'+chosen.slice(0,5).map(entry=>'<li>'+esc(this.gameName(entry))+'</li>').join('')+(chosen.length>5?'<li>'+esc(t('Et {count} autres…',{count:chosen.length-5}))+'</li>':'')+'</ul>';
  if(action==='delete'){
   this.trackDialog(this.openModal(t('Supprimer la sélection'),source+'<p class="hint">'+esc(t('Les parties sélectionnées seront supprimées de cette base de référence. Le fichier PGN original est conservé. Cette action ne peut pas être annulée.'))+'</p>',{submit:t('Supprimer ')+ids.length,onSubmit:()=>this.runBatch({action,game_ids:ids})}));return;
  }
  const bases=[this.base,...this.getBases().filter(base=>Number(base.id)!==Number(this.base.id))].filter(base=>action==='duplicate'||Number(base.id)!==Number(this.base.id));
  if(!bases.length){this.notify(t('Crée une autre base avant de déplacer ces parties.'));return;}
  this.trackDialog(this.openModal(t(action==='move'?'Déplacer la sélection':'Dupliquer la sélection'),source+ui('<label>Base de destination<select name="target_base_id" required>')+bases.map(base=>option(base.id,base.name+(Number(base.id)===Number(this.base.id)?t(' (base actuelle)'):''),bases[0].id)).join('')+'</select></label><p class="hint">'+esc(t(action==='move'?'Les parties seront copiées dans la base choisie, puis supprimées de cette base de référence. Le fichier PGN original est conservé.':'Une copie indépendante sera créée avec tous les coups, variantes et commentaires.'))+'</p>',{submit:t(action==='move'?'Déplacer':'Dupliquer'),onSubmit:form=>{const target=Number(form.get('target_base_id'));if(!bases.some(base=>Number(base.id)===target))throw Error(t('Choisis une base de destination.'));return this.runBatch({action,game_ids:ids,target_base_id:target});}}));
 }
 async runBatch(payload){
  if(this.disposed||this.batchBusy||this.loading||this.opening||this.mutating)return false;
  this.batchBusy=true;this.renderGames();this.renderStatus();this.clearError();let result;
  try{result=await this.request('/api/reference-bases/'+this.base.id+'/games/batch',{method:'POST',body:payload});}
  catch(error){this.batchBusy=false;this.renderGames();this.renderStatus();throw error;}
  const change={...result,...payload,source_base_id:Number(this.base.id)};
  if(payload.action==='delete'||payload.action==='move'){
   const removed=new Set(payload.game_ids);for(const id of removed){this.selection.delete(id);this.selectedEntries.delete(id);}
   if(this.data)this.data={...this.data,entries:this.data.entries.filter(entry=>!removed.has(Number(entry.id)))};
  }
  if(!this.disposed){const count=result.count??payload.game_ids.length,messages={delete:['{count} partie supprimée.','{count} parties supprimées.'],duplicate:['{count} partie dupliquée.','{count} parties dupliquées.'],move:['{count} partie déplacée.','{count} parties déplacées.']};this.notify(t(messages[payload.action][count===1?0:1],{count}));}
  // The server mutation is complete even if the user navigated elsewhere.
  try{await this.onChanged(change);}catch(error){this.error(error);}
  try{if(!this.disposed){this.statusController?.abort();this.statusController=null;await this.poll();await this.load();}}
  finally{this.batchBusy=false;this.renderGames();this.renderStatus();}
  return result;
 }
 stopPreparation(){clearTimeout(this.preparationTimer);this.preparationTimer=null;this.preparingSince=null;this.preparationAttempt=0;this.preparationPaused=false;this.preparationFailed=false;}
 schedulePreparation(sequence,data){
  clearTimeout(this.preparationTimer);this.preparationTimer=null;
  if(this.disposed||sequence!==this.sequence||data.status!=='preparing')return;
  this.preparingSince??=Date.now();const remaining=300000-(Date.now()-this.preparingSince);
  if(remaining<=0){this.preparationPaused=true;return;}
  const retry=Number(data.retry_after),baseDelay=Number.isFinite(retry)?Math.max(3000,retry*1000):3000,delay=Math.min(15000,baseDelay*1.5**Math.min(this.preparationAttempt++,8));
  this.preparationTimer=setTimeout(()=>{
   if(this.disposed||sequence!==this.sequence)return;this.preparationTimer=null;
   if(Date.now()-this.preparingSince>=300000){this.preparationPaused=true;this.renderGames();return;}
   return this.load({preparationPoll:true});
  },Math.min(delay,remaining));
 }
 async load({preparationPoll=false}={}){
  if(this.disposed)return;clearTimeout(this.searchTimer);
  if(!preparationPoll)this.stopPreparation();else{clearTimeout(this.preparationTimer);this.preparationTimer=null;}
  const sequence=++this.sequence;this.controller?.abort();const controller=new AbortController();this.controller=controller;
  // A previous page may stay visible during pagination, but results from other
  // filters must never look like the answer to the newly submitted search.
  const filtersKey=JSON.stringify(this.filters);if(this.dataFiltersKey!==filtersKey)this.data=null;
  this.loading=true;this.renderGames();if(!preparationPoll)this.refreshPending=false;this.renderStatus();
  try{const query=new URLSearchParams({...this.filters,offset:String(this.offset),limit:String(this.limit)});for(const key of Object.keys(this.filters))if(this.filters[key]===''||this.filters[key]===null||this.filters[key]===undefined)query.delete(key);
   const data=await this.request('/api/reference-bases/'+this.base.id+'/games?'+query,{signal:controller.signal});
   if(this.disposed||sequence!==this.sequence)return;
   this.data={...data,offset:Number(data.offset)||0,entries:data.status==='preparing'?[]:Array.isArray(data.entries)?data.entries:[]};this.dataFiltersKey=filtersKey;this.offset=this.data.offset;this.clearError();
   if(data.status!=='preparing'&&!this.data.entries.length&&this.offset>0&&data.total!=null){const last=Number(data.total)>0?Math.floor((Number(data.total)-1)/this.limit)*this.limit:0;if(last<this.offset){this.offset=last;return await this.load();}}
   if(data.status==='preparing')this.schedulePreparation(sequence,data);else this.stopPreparation();
  }catch(error){if(!this.disposed&&sequence===this.sequence){if(this.data)this.offset=this.data.offset;if(this.data?.status==='preparing'){this.preparationPaused=true;this.preparationFailed=true;}this.error(error);}}
  finally{if(!this.disposed&&sequence===this.sequence){this.loading=false;this.renderGames();this.renderStatus();if(this.restoreScroll!=null&&this.data?.status!=='preparing'){restoreListScroll(this.host,this.restoreScroll);this.restoreScroll=null;}}if(this.controller===controller)this.controller=null;}
 }
 async applyFilters(){
  if(this.disposed||this.opening||this.batchBusy)return;const values=new FormData(this.form),next={...this.filters};
  for(const key of ['search','sort'])next[key]=String(values.get(key)||'').trim();next.descending=values.get('descending')==='true';
  for(const key of Object.keys(next))if(!['search','sort','descending','player_key','event_key'].includes(key))delete next[key];Object.assign(next,gameFilterParams(readGameFilters(values)));
  const count=this.form.querySelector('[data-game-search-count]');if(count)count.innerHTML=gameSearchCountLabel(next);
  this.filters=next;markListDirty(this.form,false);this.offset=0;this.clearError();return this.load();
 }
 async poll(){
  if(this.disposed||this.statusController)return;clearTimeout(this.timer);const controller=new AbortController();this.statusController=controller;
  try{const response=await this.request('/api/reference-bases/'+this.base.id+'/status',{signal:controller.signal});if(this.disposed||this.statusController!==controller)return;
   const next=response.reference_status||response,changed=available(next)!==available(this.status)||(Number(next.imported)||0)!==(Number(this.status.imported)||0);this.status=next;this.renderStatus();this.onStatus(next);
   if(changed){this.refreshPending=true;this.renderStatus();}
  }catch(error){if(this.statusController===controller)this.error(error);}
  finally{if(this.statusController===controller){this.statusController=null;if(!this.disposed&&(active(this.status.status)||this.status.worker_active||this.status.status==null))this.timer=setTimeout(()=>this.poll(),this.pollMs);}}
 }
 async click(event){
  const button=event.target.closest?.('[data-reference-action],[data-reference-game],[data-reference-menu],[data-library-view],[data-directory-clear],[data-list-clear]');if(!button||!this.host.contains(button)||button.disabled||this.disposed||this.batchBusy)return;
  if(button.hasAttribute?.('data-list-clear')){const key=button.dataset.listClear;delete this.filters[key];delete this.directoryLabels[key];const node=this.form.querySelector('[name="'+key+'"]');if(node)node.value=key==='player_color'?'any':key==='rating_side'?'both':'';this.form.querySelector('[data-game-search-count]').innerHTML=gameSearchCountLabel(this.filters);this.offset=0;this.setLibraryView(this.libraryView);return this.load();}
  if(button.dataset.libraryView){this.setLibraryView(button.dataset.libraryView);return;}
  if(button.hasAttribute?.('data-directory-clear')){delete this.filters.player_key;delete this.filters.event_key;this.directoryLabels={};this.offset=0;this.setLibraryView(this.libraryView);return this.load();}
  if(button.dataset.referenceMenu){this.showRowActions(Number(button.dataset.referenceMenu));return;}
  if(button.dataset.referenceGame){if(this.opening||this.loading)return;const entry=this.data?.entries.find(entry=>String(entry.id)===button.dataset.referenceGame);if(!entry)return;
   this.opening=true;this.renderGames();try{await this.onOpenGame(entry.id,{isCurrent:()=>!this.disposed});}finally{this.opening=false;this.renderGames();this.renderStatus();}return;
  }
  const action=button.dataset.referenceAction;
  if(action==='clear'){if(this.loading||this.opening||this.mutating)return;this.selection.clear();this.selectedEntries.clear();this.renderGames();return;}
  if(['duplicate','move','delete'].includes(action))return this.requestAction(action,this.selectedIds);
  if(action==='refresh'){if(this.loading||this.opening)return;return this.load();}
  if(action==='reset'){clearTimeout(this.searchTimer);this.form.reset();this.filters={search:'',sort:'id',descending:false};fillGameFilters(this.form,{});for(const[key,value]of Object.entries({search:'',sort:'id',descending:'false'})){const node=this.form.querySelector('[name="'+key+'"]');if(node)node.value=value;}markListDirty(this.form,false);delete this.filters.player_key;delete this.filters.event_key;this.directoryLabels={};this.setLibraryView('games');return this.applyFilters();}
  if(action==='previous'||action==='next'){if(this.loading||this.opening)return;if(action==='previous'&&this.offset<=0||action==='next'&&!this.data?.has_more)return;this.offset=action==='previous'?Math.max(0,this.offset-this.limit):this.offset+this.limit;return this.load();}
  if(!['pause','resume'].includes(action)||this.mutating)return;
  this.mutating=true;this.renderStatus();this.renderGames();this.clearError();
  try{await this.request('/api/reference-bases/'+this.base.id+'/'+(action==='pause'?'cancel':'resume'),{method:'POST',body:{}});if(this.disposed)return;this.statusController?.abort();this.statusController=null;await this.poll();}
  finally{this.mutating=false;this.renderStatus();this.renderGames();}
 }
 dispose(){if(this.dialog?.open&&this.dialog.querySelector('form')===this.dialogForm)this.dialog.close();writeListState(this.stateKey,{filters:this.filters,offset:this.offset,limit:this.limit,libraryView:this.libraryView,directoryLabels:this.directoryLabels,draft:gameFilterDraft(this.form),advancedOpen:!!this.form.querySelector('[data-game-search]')?.open,scroll:captureListScroll()});clearTimeout(this.searchTimer);this.host.removeEventListener('input',this.inputHandler);this.host.removeEventListener('change',this.changeHandler);this.host.removeEventListener('keydown',this.keyHandler);this.disposed=true;this.directory.dispose();this.sequence++;this.stopPreparation();clearTimeout(this.timer);this.controller?.abort();this.statusController?.abort();this.host.removeEventListener('click',this.clickHandler);this.form.removeEventListener('submit',this.submitHandler);}
}
