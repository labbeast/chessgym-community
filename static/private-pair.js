import {privateAccessText,privateAccessLanguage,PRIVATE_ACCESS_LANGUAGES,consumePrivatePairingToken as consumePairingToken} from './private-access-messages.js';

export {consumePairingToken};
export function bindPrivatePair(root,{request=globalThis.fetch,location=globalThis.location,history=globalThis.history,language=globalThis.navigator?.languages?.[0]||globalThis.navigator?.language||'fr',navigate=()=>location.replace('/')}={}){
 const consumed=consumePairingToken(location,history);let token=consumed.token,locale=privateAccessLanguage(language),disposed=false,busy=false,state=consumed.error||'pairing';const controller=new AbortController();
 const query=selector=>root.querySelector(selector),text=source=>privateAccessText(locale,source);
 const source={missing:'Ouvre sur ce téléphone le lien d’association affiché dans les réglages de ChessGym sur ton ordinateur.',invalid:'Ce lien est incomplet. Ouvre le lien entier depuis ton ordinateur.',pairing:'Association en cours…',expired:'Ce lien a expiré ou a été révoqué. Ouvre un nouveau lien depuis ton ordinateur.',network:'Impossible de joindre ChessGym. Vérifie que ton ordinateur est allumé et que les deux appareils sont sur le même Wi-Fi ou réseau privé Tailscale.',busy:'Trop de tentatives. Patiente un moment, puis réessaie.',success:'Cet appareil est associé. Ouverture de ChessGym…'};
 function render(){if(disposed)return;const document=root.ownerDocument;document.documentElement.lang=locale;document.documentElement.dir=locale==='ar'?'rtl':'ltr';query('[data-pair-title]').textContent=text('Associer ce téléphone');query('[data-pair-language-label]').textContent=text('Langue d’affichage');query('[data-pair-language]').value=locale;query('[data-pair-status]').textContent=text(source[state]);query('[data-pair-status]').setAttribute('data-state',state);query('[data-pair-retry]').textContent=text('Réessayer l’association');query('[data-pair-retry]').hidden=!['network','busy'].includes(state);query('[data-pair-retry]').disabled=busy;}
 const select=query('[data-pair-language]');select.textContent='';for(const [code,label] of Object.entries(PRIVATE_ACCESS_LANGUAGES)){const option=root.ownerDocument.createElement('option');option.value=code;option.textContent=label;option.lang=code;option.dir='auto';select.appendChild(option);}select.onchange=()=>{locale=privateAccessLanguage(select.value);render();};
 async function pair(){if(disposed||busy||!token)return;busy=true;state='pairing';render();try{
  const response=await request('/api/private-access/pair',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',body:JSON.stringify({token}),signal:controller.signal});
  if(disposed)return;if(!response.ok){if(response.status===429)state='busy';else if([400,401,403].includes(response.status)){state='expired';token='';}else state='network';return;}
  const result=await response.json();if(disposed)return;if(result.paired!==true){state='network';return;}token='';state='success';render();navigate();
 }catch(error){if(!disposed)state='network';}finally{busy=false;render();}}
 query('[data-pair-retry]').onclick=()=>void pair();render();if(token)void pair();
 return {dispose(){disposed=true;token='';controller.abort();select.onchange=null;query('[data-pair-retry]').onclick=null;}};
}
// Pasting the full pairing link after opening the bare address is a same-document
// navigation. Replace the active attempt, aborting it before accepting a new link.
export function mountPrivatePair(root,{events=globalThis,...options}={}){
 let binding=null,disposed=false;
 const location=options.location??globalThis.location;
 function mount(){
  if(disposed)return;
  const language=binding?root.querySelector('[data-pair-language]').value:options.language;
  binding?.dispose();binding=bindPrivatePair(root,{...options,language});
 }
 const changed=()=>{if(new URLSearchParams(String(location?.hash||'').replace(/^#/, '')).has('pair'))mount();};
 events.addEventListener?.('hashchange',changed);mount();
 return {dispose(){disposed=true;events.removeEventListener?.('hashchange',changed);binding?.dispose();}};
}
const root=globalThis.document?.getElementById?.('private-pair');
if(root){const binding=mountPrivatePair(root);globalThis.addEventListener?.('pagehide',()=>binding.dispose(),{once:true});}