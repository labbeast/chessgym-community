import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';

export const BASE_ICONS=[
 ['database','Base PGN','<ellipse cx="24" cy="10" rx="15" ry="6"/><path d="M9 10v28c0 8 30 8 30 0V10M9 24c0 8 30 8 30 0"/>'],
 ['book','Cours et livres','<path d="M24 12C18 8 10 8 5 10v29c6-2 13-2 19 2 6-4 13-4 19-2V10c-5-2-13-2-19 2v29M11 17l7 1M11 24l7 1M30 18l7-1M30 25l7-1"/>'],
 ['puzzle','Tactique','<path d="M8 8h12c-3 9 11 9 8 0h12v12c-9-3-9 11 0 8v12H28c3-9-11-9-8 0H8V28c9 3 9-11 0-8z"/>'],
 ['knight','Cavalier','<path d="m15 37 5-12-9 4-5-6L23 8l-1-5 9 5c11 9 11 17 6 29M13 38h26v6H10zM25 16h1"/>'],
 ['pawn','Pion et finales','<circle cx="24" cy="10" r="7"/><path d="M16 20h16v5H16zM19 25c0 6-4 10-6 13h22c-2-3-6-7-6-13M12 39h24v5H12z"/>'],
 ['rook','Tour','<path d="M10 5h7v7h4V5h6v7h4V5h7v15H10zM14 20l2 16h16l2-16M11 37h26v7H11z"/>'],
 ['king','Roi','<path d="M24 3v12M19 8h10M12 29 7 19c-3-8 9-11 17-2 8-9 20-6 17 2l-5 10M12 30h24v7H12zM10 38h28v6H10z"/>'],
 ['target','Objectif','<circle cx="24" cy="24" r="19"/><circle cx="24" cy="24" r="12"/><circle cx="24" cy="24" r="4"/><path d="m24 24 16-16m-5 0h5v5"/>'],
 ['trophy','Parties remarquables','<path d="M14 5h20v16c0 14-20 14-20 0zM14 10H6v8c0 8 8 8 8 8M34 10h8v8c0 8-8 8-8 8M24 31v9M15 43h18M18 40h12"/>'],
 ['star','Favoris','<path d="m24 4 6 13 14 2-10 10 2 15-12-7-12 7 2-15L4 19l14-2z"/>'],
 ['lightning','Calcul rapide','<path d="m28 3-18 24h12l-3 18 19-25H26z"/>'],
 ['graduation','Apprentissage','<path d="m3 16 21-11 21 11-21 11zM12 21v12c7 6 17 6 24 0V21M44 17v17M41 39l3-5 3 5"/>'],
];
const iconMap=new Map(BASE_ICONS.map(([id,label,path])=>[id,{label,path}]));
export function baseIconSvg(icon){const item=iconMap.get(icon)||iconMap.get('database');return '<svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">'+item.path+'</svg>';}
function savedImageUrl(logo){return logo?.kind==='image'&&/^\/api\/bases\/\d+\/logo(?:\?[^\s"<>]*)?$/.test(logo.image_url||'')?logo.image_url:null;}
export function baseLogoHtml(base){
 const logo=base?.logo||{},url=savedImageUrl(logo);
 return '<span class="base-logo'+(url?' base-logo-image':'')+'">'+(url?'<img src="'+esc(url)+'" alt="" draggable="false" loading="lazy" decoding="async">':baseIconSvg(logo.icon))+'</span>';
}
export function baseAppearanceSettingsHtml(){return ui('<section class="panel base-appearance-panel"><h2>Logo de la base</h2><div id="base-appearance-settings"></div></section>');}

export class BaseAppearanceEditor {
 constructor(host,base){this.host=host;this.base=base;this.original=base.logo||{kind:'icon',icon:'database'};this.choice={...this.original};this.sequence=0;this.loading=false;this.disposed=false;this.render();}
 render(){
  this.host.innerHTML='<div class="base-appearance-summary"><div data-logo-preview>'+baseLogoHtml({logo:this.choice})+'</div><div><strong data-logo-label>'+esc(this.choice.kind==='image'?t('Image personnelle'):t((iconMap.get(this.choice.icon)||iconMap.get('database')).label))+ui('</strong><p class="hint">Choisis une icône ou une image pour repérer cette base dans ta bibliothèque.</p></div></div><div class="base-icon-grid" role="group" aria-label="Icônes de la base">')+BASE_ICONS.map(([id,label])=>'<button type="button" class="base-icon-choice" data-logo-icon="'+id+'" aria-pressed="'+(this.choice.kind!=='image'&&(this.choice.icon||'database')===id)+'" title="'+esc(t(label))+'">'+baseIconSvg(id)+'<span>'+esc(t(label))+'</span></button>').join('')+ui('</div><div class="base-image-upload"><label class="base-image-label">Téléverser une image<input type="file" data-logo-file accept="image/png,image/jpeg,image/webp"></label><p class="hint">PNG, JPEG ou WebP · 5 Mo maximum. L’image sera adaptée au logo; le choix sera enregistré avec les réglages de la base.</p><p class="base-image-message" data-logo-message role="status" hidden></p></div>');
  for(const button of this.host.querySelectorAll('[data-logo-icon]'))button.onclick=()=>{if(this.disposed||this.disabled)return;this.sequence++;this.loading=false;this.choice={kind:'icon',icon:button.dataset.logoIcon};this.changed=true;this.clearFile();this.update();};
  const input=this.host.querySelector('[data-logo-file]');if(input)input.onchange=()=>{const file=input.files?.[0];if(file)this.chooseFile(file);};
 }
 message(text,error=false){const node=this.host.querySelector('[data-logo-message]');if(node){node.hidden=!text;node.textContent=text;node.classList.toggle('error-text',error);}}
 async chooseFile(file){
  if(this.disposed||this.disabled)return;const sequence=++this.sequence;this.loading=false;
  if(file.size>5*1024*1024){this.message(t('Choisis une image de 5 Mo ou moins.'),true);this.clearFile();return;}
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){this.message(t('Choisis une image PNG, JPEG ou WebP.'),true);this.clearFile();return;}
  this.loading=true;this.message(t('Chargement de l’image…'));
  try{
   const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(t('Cette image ne peut pas être lue.')));reader.readAsDataURL(file);});
   if(this.disposed||sequence!==this.sequence)return;
   if(typeof data!=='string'||!/^data:image\/(png|jpeg|webp);base64,/.test(data))throw new Error(t('Cette image ne peut pas être lue.'));
   this.choice={kind:'image',data_url:data};this.changed=true;this.loading=false;this.update();
   this.message(t('Image prête. Enregistre les réglages pour l’appliquer.'));
  }catch(error){if(!this.disposed&&sequence===this.sequence){this.loading=false;this.message(error.message||t('Cette image ne peut pas être lue.'),true);}}
  finally{if(!this.disposed&&sequence===this.sequence)this.clearFile();}
 }
 clearFile(){const input=this.host.querySelector('[data-logo-file]');if(input)input.value='';}
 update(){
  this.message('');const preview=this.host.querySelector('[data-logo-preview]'),label=this.host.querySelector('[data-logo-label]');
  if(preview)preview.innerHTML=this.choice.data_url?'<span class="base-logo base-logo-image"><img src="'+esc(this.choice.data_url)+ui('" alt="Aperçu du logo" draggable="false"></span>'):baseLogoHtml({logo:this.choice});
  if(label)label.textContent=this.choice.kind==='image'?t('Image personnelle'):t((iconMap.get(this.choice.icon)||iconMap.get('database')).label);
  for(const button of this.host.querySelectorAll('[data-logo-icon]'))button.setAttribute('aria-pressed',String(this.choice.kind==='icon'&&this.choice.icon===button.dataset.logoIcon));
 }
 getPatch(){if(this.loading)throw new Error(t('Attends la fin du chargement de l’image avant d’enregistrer.'));return this.changed?{...this.choice}:undefined;}
 setDisabled(disabled){this.disabled=disabled;for(const control of this.host.querySelectorAll('button,input'))control.disabled=disabled;}
 dispose(){this.disposed=true;this.sequence++;}
}
