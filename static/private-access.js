import {t,ui} from './i18n.js';
import {api,esc} from './api.js';

const endpoint='/api/private-access';
function privateHost(host){
 if(host.startsWith('[')&&host.endsWith(']'))return /^\[f[cd][0-9a-f]{2}:/.test(host);
 const parts=host.split('.').map(Number);
 return parts.length===4&&parts.every(n=>Number.isInteger(n)&&n>=0&&n<=255)&&
  (parts[0]===10||parts[0]===172&&parts[1]>=16&&parts[1]<=31||parts[0]===192&&parts[1]===168||parts[0]===100&&parts[1]>=64&&parts[1]<=127);
}
export function privateAccessSettingsHtml(){return ui('<section class="panel settings-width private-access-panel"><h2>Accès depuis un téléphone</h2><p class="hint">Utilise ChessGym sur ton téléphone, sur le même Wi-Fi ou via ton réseau privé Tailscale.</p><p class="hint">Ton ordinateur doit rester allumé et ChessGym ouvert.</p><div id="private-access-settings"><p class="hint">Chargement…</p></div></section>');}
export function privatePairingLinks(data){
 if(!data?.enabled||!Array.isArray(data.pairing_urls))return [];
 return data.pairing_urls.flatMap(item=>{try{const url=new URL(item.url);if(url.protocol!=='http:'||!privateHost(url.hostname)||url.username||url.password||url.search||url.pathname!=='/'||!/^#pair=[0-9a-f]{64}$/.test(url.hash)||!['lan','tailscale'].includes(item.label))return [];return [{label:item.label,url:url.href,address:url.origin+'/'}];}catch{return [];}});
}
export function privateAccessStatusHtml(data){
 return '<p class="private-access-state">'+esc(t(data.enabled?'Accès privé activé.':'Accès désactivé.'))+'</p>'+(data.restart_required?ui('<p class="private-access-restart" role="status">Redémarre ChessGym sur cet ordinateur pour appliquer ce changement.</p>'):'')+(data.enabled?ui('<p class="hint">Ce lien donne accès à tes données. Partage-le uniquement avec tes appareils.</p><p class="hint">Pour un accès hors de chez toi, connecte le téléphone et l’ordinateur au même réseau privé Tailscale.</p>'):'');
}
export async function copyPrivateLink(value,{clipboard=globalThis.navigator?.clipboard,document=globalThis.document}={}){
 if(clipboard?.writeText){try{await clipboard.writeText(value);return;}catch{}}
 if(!document?.body||!document.execCommand)throw new Error('Copy unavailable');
 const field=document.createElement('textarea');field.value=value;field.setAttribute('readonly','');field.style.position='fixed';field.style.opacity='0';document.body.appendChild(field);
 try{field.select();if(!document.execCommand('copy'))throw new Error('Copy unavailable');}finally{field.value='';field.remove();}
}
export function bindPrivateAccess(host,{request=api,isCurrent=()=>true,copy=copyPrivateLink}={}){
 const root=host?.querySelector('#private-access-settings');if(!root)return {dispose(){}};
 const controller=new AbortController();let disposed=false,data=null,busy=false,reveal=false;
 const active=()=>!disposed&&isCurrent(),query=selector=>root.querySelector(selector);
 const call=(path='',options={})=>request(endpoint+path,{...options,signal:controller.signal});
 root.innerHTML=ui('<div data-private-access-status></div><div class="actions"><button type="button" class="primary" data-private-action="toggle" disabled>Activer l’accès privé</button><button type="button" data-private-action="refresh">Actualiser l’accès privé</button></div><div data-private-access-links></div><div data-private-access-revoke hidden><p class="hint">Les appareils associés perdront l’accès. Les anciens liens ne fonctionneront plus.</p><button type="button" data-private-action="rotate">Révoquer les appareils</button></div><p data-private-access-message role="status" aria-live="polite"></p>');
 function message(source,error=false){if(!active())return;query('[data-private-access-message]').textContent=source?t(source):'';query('[data-private-access-message]').classList.toggle('error-text',error);}
 function lock(){if(!active())return;query('[data-private-action="toggle"]').disabled=busy||!data;query('[data-private-action="refresh"]').disabled=busy;query('[data-private-action="rotate"]').disabled=busy||!data?.enabled;for(const button of root.querySelectorAll?.('[data-private-action="copy"], [data-private-action="reveal"]')||[])button.disabled=busy;}
 function linksHtml(){
  if(!data?.enabled)return '';const links=privatePairingLinks(data);
  if(!links.length)return ui('<p class="hint">Adresse privée introuvable. Connecte cet ordinateur au Wi-Fi ou à Tailscale, puis actualise.</p>');
  return '<button type="button" data-private-action="reveal" aria-expanded="'+reveal+'">'+esc(t(reveal?'Masquer les liens d’association':'Afficher les liens d’association'))+'</button><div class="private-access-links">'+links.map((item,index)=>'<div class="private-access-link"><strong>'+esc(t(item.label==='tailscale'?'Réseau privé Tailscale':'Wi-Fi local'))+'</strong><bdi dir="ltr">'+esc(item.address)+'</bdi>'+(reveal?'<input type="text" readonly dir="ltr" aria-label="'+esc(t('Lien d’association privé'))+'" value="'+esc(item.url)+'">':'')+'<button type="button" data-private-action="copy" data-private-link="'+index+'">'+esc(t('Copier le lien d’association'))+'</button></div>').join('')+'</div>';
 }
 function render(value){if(!active())return;data=value;query('[data-private-access-status]').innerHTML=privateAccessStatusHtml(data);query('[data-private-action="toggle"]').textContent=t(data.enabled?'Désactiver l’accès privé':'Activer l’accès privé');query('[data-private-access-revoke]').hidden=!data.enabled;query('[data-private-access-links]').innerHTML=linksHtml();lock();}
 async function perform(action,{mutation=false}={}){if(!active()||busy)return;busy=true;lock();message('');try{await action();}catch(error){if(active()&&error.name!=='AbortError'){if(mutation){try{render(await call());}catch{}}message(mutation?'Impossible de modifier l’accès privé. Réessaie.':'Impossible de charger l’accès privé. Réessaie.',true);}}finally{busy=false;lock();}}
 root.onclick=event=>{const button=event.target.closest?.('[data-private-action]');if(!button||button.disabled||!active()||busy)return;const action=button.dataset.privateAction;
  if(action==='refresh')void perform(async()=>render(await call()));
  else if(action==='toggle'&&data)void perform(async()=>{reveal=false;render(await call('',{method:'PATCH',body:{enabled:!data.enabled}}));},{mutation:true});
  else if(action==='rotate'&&data?.enabled)void perform(async()=>{reveal=false;render(await call('/rotate',{method:'POST',body:{}}));message('Appareils révoqués. Utilise les nouveaux liens pour les associer de nouveau.');},{mutation:true});
  else if(action==='reveal'){reveal=!reveal;render(data);}
  else if(action==='copy'){const item=privatePairingLinks(data)[Number(button.dataset.privateLink)];if(item)void perform(async()=>{try{await copy(item.url);message('Lien d’association copié.');}catch{message('Impossible de copier le lien. Affiche-le pour le copier.',true);}});}
 };
 void perform(async()=>render(await call()));
 return {dispose(){disposed=true;data=null;controller.abort();root.onclick=null;root.innerHTML='';}};
}
