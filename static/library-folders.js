import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';

export function createFolderViewState(){return {collapsed:new Set(),known:new Set()};}

export function isFolderEmpty(id,folders=[],bases=[]){
 const folderId=Number(id);
 return Number.isSafeInteger(folderId)&&folderId>0&&folders.some(folder=>Number(folder.id)===folderId)
  &&!bases.some(base=>Number(base.folder_id)===folderId)&&!folders.some(folder=>Number(folder.parent_id)===folderId);
}

// Produce a finite forest even if an imported folder list contains missing parents or cycles.
export function folderForest(folders=[]){
 const records=new Map();
 for(const folder of folders){const id=Number(folder.id);if(Number.isSafeInteger(id)&&id>0&&!records.has(id))records.set(id,{id,name:String(folder.name??''),parentId:Number(folder.parent_id)||null,children:[]});}
 const seeds=[];
 for(const node of records.values()){const parent=records.get(node.parentId);if(parent&&parent!==node)parent.children.push(node);else seeds.push(node);}
 const roots=[],nodes=[],byId=new Map(),seen=new Set();
 for(const seed of [...seeds,...records.values()]){
  const stack=[{source:seed,parent:null}];
  while(stack.length){
   const {source,parent}=stack.pop();if(seen.has(source.id))continue;seen.add(source.id);
   const node={id:source.id,name:source.name,parentId:parent?.id??null,depth:parent?parent.depth+1:0,path:parent?parent.path+' / '+source.name:source.name,children:[]};
   (parent?parent.children:roots).push(node);nodes.push(node);byId.set(node.id,node);
   for(let i=source.children.length-1;i>=0;i--)stack.push({source:source.children[i],parent:node});
  }
 }
 return {roots,nodes,byId};
}

const folderIcon='<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.5 5.5h5l1.7 2h8.3v8H2.5z"/></svg>';
const chevron='<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>';
function selection(id,name,count,selected,context=''){
 return '<button type="button" data-folder="'+id+'" class="folder-choice'+(selected?' active':'')+'" aria-current="'+(selected?'page':'false')+'"'+context+'><span class="folder-icon">'+folderIcon+'</span><span class="folder-name">'+esc(name)+'</span><span class="folder-count" aria-label="'+count+' base'+(count===1?'':'s')+(id==='all'?t(' dans la bibliothèque'):t(' directement dans ce dossier'))+'">'+count+'</span></button>';
}

export function libraryFoldersHtml(folders,bases,selected,viewState){
 const forest=folderForest(folders),counts=new Map();
 for(const base of bases){const id=Number(base.folder_id)||0;counts.set(id,(counts.get(id)||0)+1);}
 for(const node of forest.nodes){
  // Reveal a new folder even when one of its ancestors was previously collapsed.
  if(!viewState.known.has(node.id)){let parent=forest.byId.get(node.parentId);while(parent){viewState.collapsed.delete(parent.id);parent=forest.byId.get(parent.parentId);}}
 }
 viewState.known=new Set(forest.nodes.map(n=>n.id));
 for(const id of viewState.collapsed)if(!viewState.known.has(id))viewState.collapsed.delete(id);
 const currentAncestors=new Set();let current=forest.byId.get(selected);
 while(current?.parentId){currentAncestors.add(current.parentId);current=forest.byId.get(current.parentId);}
 let html=ui('<aside class="folder-list library-folders" aria-label="Dossiers de la bibliothèque"><div class="folder-shortcuts">')+selection('all',t('Toutes les bases'),bases.length,selected===null)+selection('root',t('Sans dossier'),counts.get(0)||0,selected===0)+ui('</div><div class="folder-tree-heading">Dossiers</div><ul class="folder-tree">');
 const stack=forest.roots.slice().reverse().map(node=>({node}));
 while(stack.length){
  const item=stack.pop();if(item.html){html+=item.html;continue;}
  const node=item.node,expanded=!viewState.collapsed.has(node.id),hasChildren=node.children.length>0;
  html+='<li class="folder-node'+(currentAncestors.has(node.id)?' contains-current':'')+'" data-folder-node="'+node.id+'" data-folder-parent="'+(node.parentId??'')+'" style="--folder-depth:'+Math.min(node.depth,7)+'"><div class="folder-row">'+(hasChildren?'<button type="button" class="folder-toggle" data-folder-toggle="'+node.id+'" data-folder-name="'+esc(node.name)+'" aria-expanded="'+expanded+'" aria-controls="folder-children-'+node.id+'" aria-label="'+(expanded?t('Replier'):t('Déplier'))+t(' le dossier ')+esc(node.name)+'">'+chevron+'</button>':'<span class="folder-toggle-spacer" aria-hidden="true"></span>')+selection(node.id,node.name,counts.get(node.id)||0,selected===node.id,' data-context-name="'+esc(node.name)+'" aria-haspopup="menu" aria-expanded="false" title="'+esc(node.path)+'"')+'</div>';
  stack.push({html:'</li>'});
  if(hasChildren){html+='<ul class="folder-children" id="folder-children-'+node.id+'"'+(expanded?'':' hidden')+'>';stack.push({html:'</ul>'});for(let i=node.children.length-1;i>=0;i--)stack.push({node:node.children[i]});}
 }
 return html+'</ul>'+(forest.nodes.length?'':ui('<p class="folder-tree-empty">Crée un dossier pour organiser tes bases.</p>'))+'</aside>';
}

export function bindLibraryFolders(root,viewState){
 if(!root)return;
 const toggles=[...root.querySelectorAll('[data-folder-toggle]')],choices=[...root.querySelectorAll('[data-folder]')];
 const toggleById=new Map(toggles.map(button=>[Number(button.dataset.folderToggle),button]));
 const setExpanded=(button,expanded)=>{
  const id=Number(button.dataset.folderToggle),group=root.querySelector('#folder-children-'+id);if(!group)return;
  group.hidden=!expanded;button.setAttribute('aria-expanded',String(expanded));button.setAttribute('aria-label',(expanded?t('Replier'):t('Déplier'))+t(' le dossier ')+button.dataset.folderName);
  if(expanded)viewState.collapsed.delete(id);else viewState.collapsed.add(id);
 };
 const visibleChoices=()=>choices.filter(button=>!button.closest('[hidden]'));
 const keydown=(event,button)=>{
  if(event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  event.preventDefault();event.stopPropagation();
  const id=Number(button.dataset.folder??button.dataset.folderToggle),choice=choices.find(item=>Number(item.dataset.folder)===id)||button,toggle=toggleById.get(id),node=choice.closest('[data-folder-node]');
  if(event.key==='ArrowRight'){
   if(toggle?.getAttribute('aria-expanded')==='false')setExpanded(toggle,true);
   else if(toggle)root.querySelector('#folder-children-'+id)?.querySelector('[data-folder]')?.focus();
  }else if(event.key==='ArrowLeft'){
   if(toggle?.getAttribute('aria-expanded')==='true')setExpanded(toggle,false);
   else if(node?.dataset.folderParent)choices.find(item=>item.dataset.folder===node.dataset.folderParent)?.focus();
  }else{
   const visible=visibleChoices(),index=visible.indexOf(choice);let next=index;
   if(event.key==='Home')next=0;else if(event.key==='End')next=visible.length-1;else next=Math.max(0,Math.min(visible.length-1,index+(event.key==='ArrowDown'?1:-1)));
   visible[next]?.focus();
  }
 };
 for(const toggle of toggles){toggle.onclick=()=>setExpanded(toggle,toggle.getAttribute('aria-expanded')!=='true');toggle.onkeydown=event=>keydown(event,toggle);}
 for(const choice of choices)choice.onkeydown=event=>keydown(event,choice);
}
