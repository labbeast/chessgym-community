import assert from 'node:assert/strict';
import {gameSearchHtml,readGameFilters,gameFilterParams,matchesGameFilters,gameFilterCount} from '../static/game-search.js';
import {EntryTable,visibleEntries} from '../static/entry-table.js';
import {LibraryDirectory} from '../static/library-directory.js';
import {TestNode} from './metadata_dom.mjs';
import {setLanguage} from '../static/i18n.js';
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const game=(id,headers={})=>({id,title:'Partie '+id,selected:true,headers:{White:'Labbé, Élodie',Black:'Martin, Marc',Event:'Open de Montréal',Site:'Montréal',Date:'2024.??.??',WhiteElo:'2200',BlackElo:'2100',Result:'1-0',ECO:'B90',Opening:'Sicilienne Najdorf',TimeControl:'180+2',...headers}});
const page=(entries=[],extra={})=>({entries,total:entries.length,total_all:entries.length,selected_total:entries.length,offset:0,has_more:false,...extra});
function entryFixture({remote=true}={}){const host=new TestNode(),calls=[];const table=new EntryTable(host,{entries:remote?[]:[game(1)],base:{id:7,name:'Base',settings:{}},remote:remote?{endpoint:'/api/bases/7/entries'}:null,request:(url,options)=>{const task=deferred();calls.push({url,options,...task});return task.promise;}});return {host,table,calls};}
function value(host,key,value){host.querySelector('[data-game-filter="'+key+'"]').value=value;}
const tests={
 async reference_directory_preparation_is_neutral_bounded_and_cancelled_on_hide(){
  const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,realNow=Date.now,timers=[];let now=0;
  globalThis.setTimeout=(callback,delay)=>{const timer={callback,delay};timers.push(timer);return timer;};globalThis.clearTimeout=timer=>{if(timer)timer.cancelled=true;};Date.now=()=>now;
  const host=new TestNode(),calls=[],directory=new LibraryDirectory(host,{endpoint:'/api/reference-bases/7/directory',request:(url,options)=>{const task=deferred();calls.push({url,options,...task});return task.promise;}});
  try{
   let pending=directory.show('players');calls.at(-1).resolve({status:'preparing',retry_after:3,items:[],total:null});await settle();assert.match(host.querySelector('[data-directory-results]').innerHTML,/Préparation/);assert.doesNotMatch(host.querySelector('[data-directory-results]').innerHTML,/Aucun résultat|0–0/);assert.equal(timers.at(-1).delay,3000);
   now=300001;timers.at(-1).callback();await settle();calls.at(-1).resolve({status:'preparing',retry_after:3});await pending;assert.equal(directory.loading,false);assert.match(host.querySelector('[data-directory-results]').innerHTML,/Actualiser/);assert.doesNotMatch(host.querySelector('[data-directory-results]').innerHTML,/Aucun résultat/);
   pending=directory.load();calls.at(-1).resolve({status:'preparing',retry_after:3});await settle();const timer=timers.at(-1),length=calls.length;directory.hide();await pending;assert.equal(timer.cancelled,true);assert.equal(calls.at(-1).options.signal.aborted,true);assert.equal(calls.length,length);
   pending=directory.show('events');calls.at(-1).resolve({items:[{key:'x',name:'Open',games:2}],offset:0,total:1});await pending;assert.match(host.querySelector('[data-directory-results]').innerHTML,/Open/);assert.doesNotMatch(host.querySelector('[data-directory-results]').innerHTML,/Préparation/);
  }finally{directory.dispose();globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;Date.now=realNow;}
 },
 filters_read_trim_validate_and_omit_defaults(){
  const data=new Map(Object.entries({first_name:' Élodie ',last_name:' Labbé ',player_color:'white',rating_min:'0',rating_max:'2400',rating_side:'either',date_from:'2024-01-01',date_to:'2024-12-31',eco:'b90-b99'}));
  const filters=readGameFilters(data);assert.equal(filters.first_name,'Élodie');assert.equal(filters.eco,'B90-B99');assert.equal(gameFilterCount(filters),7);assert.deepEqual(gameFilterParams({player:'A',player_color:'any',rating_side:'both',rating_min:'0',speed:''}),{player:'A',rating_min:'0'});
  for(const bad of [{rating_min:'2400',rating_max:'2000'},{rating_min:'-1'},{rating_max:'4001'},{date_from:'2024-02-30'},{date_from:'2024-12-31',date_to:'2024-01-01'},{eco:'B99-B00'},{eco:'F10'}])assert.throws(()=>readGameFilters(new Map(Object.entries(bad))));
 },
 local_compatibility_combines_same_player_date_elo_eco_and_search(){
  const games=[game(1),game(2,{White:'Labbé, Marc',Black:'Martin, Élodie'}),game(3,{White:'Marc Martin',Black:'Élodie Labbé',WhiteElo:'?',BlackElo:'2250',Date:'2025.06.01',Result:'0-1'})];
  assert.deepEqual(visibleEntries(games,{advanced:{first_name:'elodie',last_name:'labbe'},query:'Montreal'}).map(g=>g.id),[1,3]);
  assert.equal(matchesGameFilters(games[1],{first_name:'elodie',last_name:'labbe'}),false);
  assert.equal(matchesGameFilters(games[0],{first_name:'elodie',player_color:'black'}),false);
  assert.equal(matchesGameFilters(games[0],{date_from:'2024-06-01',date_to:'2024-06-30',rating_min:'2000',rating_side:'both',eco:'B9',speed:'blitz'}),true);
  assert.equal(matchesGameFilters(games[2],{rating_min:'2200',rating_side:'either'}),true);
  assert.equal(matchesGameFilters(games[2],{rating_min:'2200',rating_side:'both'}),false);
 },
 async applying_filters_clears_old_rows_preserves_selection_and_navigation(){
  const {host,table,calls}=entryFixture();let task=table.loadPage();calls.at(-1).resolve(page([game(1)],{total:120,total_all:150,has_more:true}));await task;
  table.selection.add(1);table.renderRows();table.pageOffset=50;value(host,'first_name','elodie');value(host,'last_name','labbe');value(host,'player_color','white');value(host,'event','Montreal');value(host,'rating_min','2000');value(host,'eco','B90-B99');table.applyAdvanced();
  assert.deepEqual(table.entries,[]);assert.equal(table.pageOffset,0);assert.deepEqual(table.selectedIds,[1]);assert.doesNotMatch(host.querySelector('[data-et-table]').innerHTML,/Labbé/);
  let params=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(params.get('first_name'),'elodie');assert.equal(params.get('eco'),'B90-B99');assert.equal(params.get('offset'),'0');assert.equal(params.has('rating_max'),false);
  calls.at(-1).resolve(page([game(2)],{total:80,total_all:150,has_more:true}));await settle();task=table.loadPage(50);params=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(params.get('offset'),'50');assert.equal(params.get('event'),'Montreal');calls.at(-1).resolve(page([game(51)],{offset:50,total:80,total_all:150}));await task;
  const nav=table.navigation(51);assert.equal(nav.remote.params.eco,'B90-B99');assert.equal(nav.remote.params.first_name,'elodie');assert.equal(nav.currentId,51);
  host.emit('click',host.querySelector('[data-et-action="advanced-reset"]'));params=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(params.has('first_name'),false);assert.equal(params.has('eco'),false);assert.equal(params.get('offset'),'0');assert.equal(table.selection.has(1),true);calls.at(-1).resolve(page());await settle();table.dispose();
 },
 async stale_search_cannot_replace_new_criteria_and_invalid_range_does_not_load(){
  const {host,table,calls}=entryFixture();value(host,'event','Old');table.applyAdvanced();const first=calls.at(-1);value(host,'event','New');table.applyAdvanced();const second=calls.at(-1);assert.equal(first.options.signal.aborted,true);second.resolve(page([game(2)]));await settle();first.resolve(page([game(1)]));await settle();assert.equal(table.entries[0].id,2);
  value(host,'date_from','2025-12-31');value(host,'date_to','2025-01-01');const count=calls.length;table.applyAdvanced();assert.equal(calls.length,count);assert.equal(host.querySelector('[data-game-search-error]').hidden,false);assert.equal(table.advanced.event,'New');table.dispose();
 },
 async directories_use_opaque_keys_preserve_page_and_ignore_late_results(){
  const host=new TestNode(),calls=[],selected=[];const directory=new LibraryDirectory(host,{endpoint:'/api/bases/7/directory',onSelect:(...args)=>selected.push(args),request:(url,options)=>{const task=deferred();calls.push({url,options,...task});return task.promise;}});
  let loading=directory.show('players');calls.at(-1).resolve({kind:'players',items:[{key:'opaque:%&players',name:'Labbé, Élodie',games:54,white_games:54,black_games:0,elo_min:2100,elo_max:2200}],offset:0,total:60,has_more:true});await loading;
  host.emit('click',host.querySelector('[data-directory-use="0"]'));assert.equal(selected[0][1].key,'opaque:%&players');host.emit('click',host.querySelector('[data-directory-action="next"]'));calls.at(-1).resolve({items:[],offset:50,total:60,has_more:false});await settle();assert.equal(directory.state.offset,50);
  loading=directory.show('events',{player_key:'opaque:%&players'});assert.equal(new URL(calls.at(-1).url,'http://local').searchParams.get('player_key'),'opaque:%&players');calls.at(-1).resolve({items:[],offset:0,total:0});await loading;
  const old=directory.show('players'),request=calls.at(-1);assert.equal(new URL(request.url,'http://local').searchParams.get('offset'),'50');loading=directory.show('events');assert.equal(request.options.signal.aborted,true);calls.at(-1).resolve({items:[{name:'New',key:'new'}],offset:0,total:1});await loading;request.resolve({items:[{name:'Old'}],offset:50,total:60});await old;assert.equal(directory.data.items[0].name,'New');directory.dispose();assert.equal(host.listeners.size,0);
 },
 async table_directories_link_player_event_filters_and_clear_selection(){
  const {host,table,calls}=entryFixture();table.setLibraryView('players');calls.at(-1).resolve({items:[{name:'Élodie',key:'name key',games:2}],offset:0,total:1});await settle();const directoryHost=host.querySelector('[data-library-directory]');directoryHost.emit('click',directoryHost.querySelector('[data-directory-use="0"]'));assert.equal(new URL(calls.at(-1).url,'http://local').searchParams.get('player_key'),'name key');calls.at(-1).resolve(page([game(1)]));await settle();assert.equal(table.libraryView,'games');assert.equal(host.querySelector('[data-library-directory]').hidden,true);
  table.setLibraryView('events');assert.equal(new URL(calls.at(-1).url,'http://local').searchParams.get('player_key'),'name key');calls.at(-1).resolve({items:[{name:'Open',key:'event key',games:2}],offset:0,total:1});await settle();directoryHost.emit('click',directoryHost.querySelector('[data-directory-use="0"]'));const params=new URL(calls.at(-1).url,'http://local').searchParams;assert.equal(params.get('event_key'),'event key');assert.equal(params.get('player_key'),'name key');calls.at(-1).resolve(page([game(1)]));await settle();assert.equal(table.navigation(1).remote.params.event_key,'event key');
  host.emit('click',host.querySelector('[data-directory-clear]'));assert.equal(new URL(calls.at(-1).url,'http://local').searchParams.has('player_key'),false);calls.at(-1).resolve(page());await settle();table.dispose();
 },
 english_labels_and_escaping(){setLanguage('en');try{const html=gameSearchHtml({player:'<script>x</script>'});assert.match(html,/Advanced search/);assert.match(html,/First name/);assert.match(html,/Opening name/);assert.doesNotMatch(html,/<script>|Recherche avancée|Nom de famille/);assert.match(html,/&lt;script&gt;/);}finally{setLanguage('fr');}}
};
for(const [name,test]of Object.entries(tests)){await test();console.log('ok '+name);}
