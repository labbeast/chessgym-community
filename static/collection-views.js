import {TYPES} from './api.js';
import {CollectionList} from './list-view.js';

const purposes=base=>[base.settings?.review_enabled?'reviews':'',base.settings?.reading_enabled?'reading':'',base.settings?.guess_enabled?'guess':'',base.settings?.is_repertoire?'repertoire':''].filter(Boolean);
const baseItem=(base,nodes,index)=>({nodes,text:[base.name,...base.tags||[]].join(' '),values:{type:base.reference?'reference':'personal',usage:purposes(base),color:base.settings?.color||'',primary:base.settings?.primary?'primary':'secondary'},sort:{order:index,name:base.name,games:Number(base.entry_count)||0,updated:base.updated_at||''}});
const typeFilter={key:'type',label:'Type de base',options:[['personal','Personnelle'],['reference','Référence']]};
const usageFilter={key:'usage',label:'Usage',advanced:true,options:[['reviews','Révisions'],['reading','Lecture'],['guess','Deviner le coup'],['repertoire','Répertoires']]};
const colorFilter={key:'color',label:'Couleur du répertoire',options:[['white','Blancs'],['black','Noirs']]};

export function mountCollectionView({main,page,bases=[],readingBases=[],reviews=[],folder=null}={}){
 if(page==='library'){
  const host=main.querySelector('#library-content>section');if(!host||!host.querySelector('.base-card-item'))return null;
  const items=[...host.querySelectorAll('.base-card-item')].map((node,index)=>baseItem(bases.find(base=>String(base.id)===node.dataset.libraryBase),[node],index));
  return new CollectionList(host,{items,stateKey:'library:'+String(folder),placeholder:'Rechercher une base…',filters:[typeFilter,usageFilter],sorts:[['order','Ordre personnalisé'],['name','Nom'],['games','Nombre de parties']]});
 }
 if(page==='reading'){
  const host=main.querySelector('.reading-grid');if(!host)return null;
  const items=[...host.querySelectorAll('.reading-card')].map((node,index)=>{const row=readingBases[index],base=bases.find(base=>base.id===row.base_id)||{name:row.name};return {...baseItem(base,[node],index),values:{progress:row.percent>=100?'completed':row.percent>0?'active':'new'},sort:{name:base.name,progress:Number(row.percent)||0,time:Number(row.active_seconds)||0}};});
  return new CollectionList(host,{items,stateKey:'reading',placeholder:'Rechercher une base…',filters:[{key:'progress',label:'Progression de lecture',options:[['new','À commencer'],['active','En cours'],['completed','Terminée']]}],sorts:[['name','Nom'],['progress','Progression de lecture'],['time','Temps de lecture']]});
 }
 if(page==='repertoire'){
  const host=main.querySelector('.base-grid');if(!host)return null;
  const rows=bases.filter(base=>base.settings?.is_repertoire),items=[...host.querySelectorAll('.repertoire-card')].map((node,index)=>baseItem(rows[index],[node],index));
  return new CollectionList(host,{items,stateKey:'repertoire',placeholder:'Rechercher une base…',filters:[colorFilter,{key:'primary',label:'Importance',advanced:true,options:[['primary','Principal'],['secondary','Secondaire']]}],sorts:[['name','Nom'],['games','Nombre de parties']]});
 }
 if(page==='reviews'){
  const host=main.querySelector('#review-panel-bases'),table=host?.querySelector('.review-bases-table');if(!table||host.hidden)return null;
  const desktop=[...table.querySelectorAll('tbody tr')],mobile=[...host.querySelectorAll('.review-base-card')];
  const items=desktop.map((node,index)=>{const id=Number(node.querySelector('[data-base]')?.dataset.base),row=reviews.find(row=>row.base_id===id),base=bases.find(base=>base.id===id)||{name:row.name};return {...baseItem(base,[node,...(mobile[index]?[mobile[index]]:[])],index),values:{type:row.type,due:row.due+Number(row.maintenance_due||0)>0?'due':'later'},sort:{name:row.name,due:row.due+Number(row.maintenance_due||0),total:row.total}};});
  table.querySelector('table')?.classList.add('list-table');
  return new CollectionList(host,{items,stateKey:'review-bases',placeholder:'Rechercher une base…',filters:[{key:'due',label:'À réviser',options:[['due','À réviser'],['later','À jour']]},{key:'type',label:'Type de révision',advanced:true,options:[...new Set(reviews.map(row=>row.type))].map(type=>[type,TYPES[type]||type])}],sorts:[['name','Nom'],['due','À réviser'],['total','Total']]});
 }
 return null;
}
