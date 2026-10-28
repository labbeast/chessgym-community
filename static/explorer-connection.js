import {t,ui} from './i18n.js';
import {api,esc} from './api.js';

// The token editor owns its listeners, cancellation and secret input lifetime.
export class ExplorerConnection{
 constructor(host,{isActive=()=>true,onChanged=()=>{}}={}){
  this.host=host;this.isActive=isActive;this.onChanged=onChanged;this.disposed=false;this.busy=false;this.metadata=null;this.error='';this.controller=null;
  this.onClick=e=>{const action=e.target.closest?.('[data-connection-action]');if(!action||!this.host.contains(action))return;const value=action.dataset.connectionAction;if(value==='retry')this.load();else this.save(value==='remove');};
  this.onKeyDown=e=>{if(e.key==='Enter'&&e.target===this.host.querySelector('[data-explorer-token]')){e.preventDefault();this.save();}};
  host.addEventListener('click',this.onClick);host.addEventListener('keydown',this.onKeyDown);this.ready=this.load();
 }
 active(){return !this.disposed&&this.isActive();}
 render(){
  if(!this.active())return;
  const data=this.metadata,environment=data?.source==='environment';
  let body='';
  if(!data)body='<p class="hint" role="status">'+(this.busy?t('Chargement de la connexion…'):t('Connexion indisponible.'))+'</p>'+(this.error?'<p class="explorer-warning" role="alert">'+esc(this.error)+ui('</p><button type="button" data-connection-action="retry">Réessayer</button>'):'');
  else{
   const status=environment?(data.configured?t('Jeton fourni par le serveur.'):t('Configuration du serveur à corriger.')):(data.configured?t('Jeton enregistré.'):t('Aucun jeton enregistré.'));
   body='<p class="explorer-connection-status" role="status">'+status+'</p>';
   if(environment)body+=ui('<p class="hint">Cette connexion est gérée dans la configuration du serveur.</p>');
   else body+=ui('<p class="hint">Crée un jeton sans cocher de permissions, puis colle-le ici. Il reste sur ton serveur. <a href="https://lichess.org/account/oauth/token/create?description=ChessGym" target="_blank" rel="noopener noreferrer">Créer un jeton Lichess ↗</a></p><label>Jeton personnel Lichess<input type="password" data-explorer-token autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="2048" aria-label="Jeton personnel Lichess" placeholder="')+(data.configured?t('Nouveau jeton pour le remplacer'):t('Coller le jeton'))+ui('"></label><div class="explorer-connection-actions"><button type="button" data-connection-action="save">Enregistrer le jeton</button>')+(data.configured?ui('<button type="button" class="quiet" data-connection-action="remove">Supprimer la connexion</button>'):'')+'</div>';
   body+='<p class="explorer-warning" data-connection-error role="alert" '+(!this.error?'hidden':'')+'>'+esc(this.error)+'</p>';
  }
  this.host.innerHTML=ui('<h3>Connexion Lichess</h3>')+body;
 }
 async load(){
  if(!this.active()||this.busy)return;
  this.busy=true;this.error='';this.render();const controller=new AbortController();this.controller=controller;
  try{const data=await api('/api/explorer/connection',{signal:controller.signal});if(!this.active())return;this.metadata=data;}
  catch(error){if(!this.active()||error.name==='AbortError')return;this.error=t('Impossible de charger la connexion. Réessaie dans un moment.');}
  finally{this.busy=false;if(this.active())this.render();}
 }
 setError(message){
  this.error=message;const el=this.host.querySelector('[data-connection-error]');if(el){el.textContent=message;el.hidden=!message;}
 }
 lock(locked){this.host.querySelectorAll('button,input').forEach(el=>el.disabled=locked);}
 async save(remove=false){
  if(!this.active()||this.busy||!this.metadata||this.metadata.source==='environment')return false;
  const input=this.host.querySelector('[data-explorer-token]'),token=remove?'':input?.value||'';
  if(!remove&&!/^[\x21-\x7e]{8,2048}$/.test(token)){this.setError(t('Le jeton doit contenir de 8 à 2048 caractères, sans espaces.'));return false;}
  this.setError('');this.busy=true;this.lock(true);const controller=new AbortController();this.controller=controller;
  try{
   const metadata=await api('/api/explorer/connection',{method:'PATCH',body:{token},signal:controller.signal});
   if(input)input.value='';
   if(!this.active())return false;
   this.metadata=metadata;this.error='';this.render();this.onChanged();return true;
  }catch(error){
   if(!this.active()||error.name==='AbortError')return false;
   this.setError(t('Impossible de modifier la connexion. Réessaie dans un moment.'));return false;
  }finally{this.busy=false;if(this.active())this.lock(false);}
 }
 dispose(){
  if(this.disposed)return;this.disposed=true;this.controller?.abort();const input=this.host.querySelector('[data-explorer-token]');if(input)input.value='';this.host.removeEventListener('click',this.onClick);this.host.removeEventListener('keydown',this.onKeyDown);
 }
}

