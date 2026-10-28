import assert from 'node:assert/strict';
import {createFolderViewState,folderForest,libraryFoldersHtml,bindLibraryFolders,isFolderEmpty} from '../static/library-folders.js';
const folders=[{id:3,name:'Italienne',parent_id:2},{id:1,name:'Cours',parent_id:null},{id:2,name:'Ouvertures',parent_id:1},{id:4,name:'Finales',parent_id:null}];
const bases=[{id:1,folder_id:1},{id:2,folder_id:3},{id:3,folder_id:3},{id:4,folder_id:null}];
const tests={
 only_existing_leaf_without_bases_is_deletable(){
  assert.equal(isFolderEmpty(4,folders,bases),true);assert.equal(isFolderEmpty(2,folders,bases),false,'A zero-direct-base folder with children is not empty');
  assert.equal(isFolderEmpty(1,folders,bases),false);assert.equal(isFolderEmpty(3,folders,bases),false);
  for(const id of [0,null,'all','root',99,-1])assert.equal(isFolderEmpty(id,folders,[]),false);
  assert.equal(isFolderEmpty(4,folders,[]),true,'An empty folder can be removed before any base exists');
  assert.equal(isFolderEmpty(4,[...folders,{id:5,parent_id:4}],[]),false,'Even an empty child protects its parent');
  assert.equal(isFolderEmpty(4,folders,[{id:5,folder_id:4,entry_count:0}]),false,'A base with zero games protects its folder');
 },
 hierarchy_names_are_short_counts_are_direct_and_menu_stays_available(){
  const html=libraryFoldersHtml(folders,bases,3,createFolderViewState());
  assert.deepEqual(folderForest(folders).nodes.map(n=>[n.id,n.parentId,n.depth]),[[1,null,0],[2,1,1],[3,2,2],[4,null,0]]);
  assert.match(html,/title="Cours \/ Ouvertures \/ Italienne"/);assert.match(html,/<span class="folder-name">Italienne<\/span>/);
  assert.doesNotMatch(html,/<span class="folder-name">Cours \/ Ouvertures/);
  assert.match(html,/data-folder="3" class="folder-choice active" aria-current="page" data-context-name="Italienne" aria-haspopup="menu" aria-expanded="false"/);
  assert.match(html,/data-folder="2"[^]*?<span class="folder-count"[^>]*>0<\/span>/);
  assert.match(html,/data-folder="3"[^]*?<span class="folder-count"[^>]*>2<\/span>/);
  assert.match(html,/data-folder="all"[^]*?<span class="folder-count"[^>]*>4<\/span>/);
  assert.match(html,/data-folder="root"[^]*?<span class="folder-count"[^>]*>1<\/span>/);
  let nesting=0;for(const tag of html.match(/<\/?button\b[^>]*>/g)){if(tag.startsWith('</'))nesting--;else nesting++;assert.ok(nesting>=0&&nesting<=1,'Disclosure is not nested within folder selection');}assert.equal(nesting,0);
 },
 branch_state_survives_renders_and_new_folder_reveals_its_ancestors(){
  const state=createFolderViewState();libraryFoldersHtml(folders,bases,null,state);state.collapsed.add(1);state.collapsed.add(2);
  let html=libraryFoldersHtml(folders,bases,4,state);assert.match(html,/id="folder-children-1" hidden/);assert.match(html,/id="folder-children-2" hidden/);
  html=libraryFoldersHtml([...folders,{id:5,name:'Nouveauté',parent_id:3}],bases,4,state);assert.equal(state.collapsed.size,0);assert.doesNotMatch(html,/id="folder-children-1" hidden/);
  state.collapsed.add(999);libraryFoldersHtml(folders,bases,null,state);assert.equal(state.collapsed.has(999),false);
 },
 missing_parents_cycles_and_duplicates_render_once_without_recursion_limit(){
  const corrupt=[{id:1,name:'A',parent_id:2},{id:2,name:'B',parent_id:1},{id:3,name:'Orphelin',parent_id:99},{id:4,name:'Soi',parent_id:4},{id:2,name:'Doublon'},{id:'invalid',name:'Invalide'}];
  const forest=folderForest(corrupt);assert.deepEqual([...forest.byId.keys()].sort(),[1,2,3,4]);assert.equal(forest.nodes.length,4);assert.ok(forest.nodes.every(n=>n.depth<3));
  const html=libraryFoldersHtml(corrupt,[],null,createFolderViewState());for(let id=1;id<=4;id++)assert.equal(html.split('data-folder="'+id+'"').length,2);
  const deep=Array.from({length:600},(_,i)=>({id:i+1,name:'D'+i,parent_id:i||null}));const tree=folderForest(deep);assert.equal(tree.nodes.at(-1).depth,599);
  const deepHtml=libraryFoldersHtml(deep,[],null,createFolderViewState());assert.match(deepHtml,/data-folder="600"/);assert.doesNotMatch(deepHtml,/--folder-depth:(?:[89]|\d{2,})/);
 },
 folder_names_are_escaped_in_content_and_attributes(){
  const html=libraryFoldersHtml([{id:1,name:'<img src=x onerror="bad"> & \'test\''},{id:2,name:'Sous',parent_id:1}],[],null,createFolderViewState());assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/&quot;bad&quot;/);assert.doesNotMatch(html,/data-folder-name="<img/);
 },
 keyboard_navigation_skips_closed_branches_and_does_not_select_a_folder(){
  const state=createFolderViewState(),ui=fakeTree(state);let selected=0;ui.choices[1].onclick=()=>selected++;
  press(ui.choices[1],'ArrowLeft');assert.equal(ui.group.hidden,true);assert.equal(state.collapsed.has(1),true);assert.equal(ui.toggle.getAttribute('aria-expanded'),'false');
  press(ui.choices[1],'ArrowDown');assert.equal(ui.focused(),ui.choices[3]);press(ui.choices[3],'ArrowUp');assert.equal(ui.focused(),ui.choices[1]);
  press(ui.choices[1],'ArrowRight');assert.equal(ui.group.hidden,false);assert.equal(ui.choices[1].getAttribute('aria-expanded'),'false','Context-menu state stays separate');
  press(ui.choices[1],'ArrowRight');assert.equal(ui.focused(),ui.choices[2]);press(ui.choices[2],'ArrowLeft');assert.equal(ui.focused(),ui.choices[1]);
  press(ui.choices[1],'End');assert.equal(ui.focused(),ui.choices[3]);press(ui.choices[3],'Home');assert.equal(ui.focused(),ui.choices[0]);assert.equal(selected,0);ui.choices[1].onclick();assert.equal(selected,1);
 },
 disclosure_click_and_keyboard_only_update_the_relevant_branch(){
  const state=createFolderViewState(),ui=fakeTree(state);ui.toggle.onclick();assert.equal(ui.group.hidden,true);assert.equal(ui.toggle.getAttribute('aria-label'),'Déplier le dossier Cours');
  press(ui.toggle,'ArrowRight');assert.equal(ui.group.hidden,false);assert.equal(ui.toggle.getAttribute('aria-label'),'Replier le dossier Cours');
  const event=press(ui.choices[1],'F10',{shiftKey:true});assert.equal(event.prevented,0,'Context menu shortcut remains available');
  const modified=press(ui.choices[1],'ArrowLeft',{altKey:true});assert.equal(modified.prevented,0,'Browser navigation shortcuts remain available');
 },
 empty_library_keeps_fixed_views_and_invites_folder_creation(){
  const html=libraryFoldersHtml([],[],null,createFolderViewState());assert.match(html,/Toutes les bases/);assert.match(html,/Sans dossier/);assert.match(html,/Crée un dossier/);assert.doesNotMatch(html,/data-folder-toggle/);
 }
};
function press(button,key,extra={}){const event={key,prevented:0,stopped:0,preventDefault(){this.prevented++;},stopPropagation(){this.stopped++;},...extra};button.onkeydown(event);return event;}
function fakeTree(state){
 let focused=null;const group={hidden:false},nodes=[{dataset:{folderParent:''}},{dataset:{folderParent:'1'}},{dataset:{folderParent:''}}];
 const make=(data,node=null,hiddenGroup=null)=>({dataset:data,attrs:new Map(),getAttribute(k){return this.attrs.get(k)??null;},setAttribute(k,v){this.attrs.set(k,String(v));},focus(){focused=this;},closest(selector){if(selector==='[data-folder-node]')return node;if(selector==='[hidden]')return hiddenGroup?.hidden?hiddenGroup:null;return null;}});
 const choices=[make({folder:'all'}),make({folder:'1'},nodes[0]),make({folder:'2'},nodes[1],group),make({folder:'3'},nodes[2])];choices[1].setAttribute('aria-expanded','false');
 const toggle=make({folderToggle:'1',folderName:'Cours'},nodes[0]);toggle.setAttribute('aria-expanded','true');group.querySelector=()=>choices[2];
 const root={querySelectorAll(selector){return selector==='[data-folder-toggle]'?[toggle]:choices;},querySelector(selector){return selector==='#folder-children-1'?group:null;}};
 bindLibraryFolders(root,state);return {group,toggle,choices,focused:()=>focused};
}
const scenario=process.argv[2];if(!tests[scenario])throw new Error('Unknown scenario '+scenario);await tests[scenario]();console.log('ok '+scenario);
