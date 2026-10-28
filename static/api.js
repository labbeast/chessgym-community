import {t,ui} from './i18n.js';
export async function api(url, options={}) {
  const settings={credentials:'same-origin',...options};
  if (settings.body && typeof settings.body!=='string') settings.body=JSON.stringify(settings.body);
  if (settings.body) settings.headers={'Content-Type':'application/json',...settings.headers};
  const r=await fetch(url,settings);
  if(!r.ok){let msg;try{msg=await r.json()}catch{msg={detail:t('Le serveur ne répond pas comme prévu.')}}const detail=msg.detail;const e=new Error(typeof detail==='string'?t(detail):JSON.stringify(detail));e.status=r.status;e.reason=r.headers.get('X-ChessGym-Reason');e.retryAfter=Number(r.headers.get('Retry-After'))||null;throw e;}
  if(r.status===204)return null;
  return r.headers.get('content-type')?.includes('json')?r.json():r.text();
}
export function notice(message,error=false){const host=document.getElementById('notices');const n=document.createElement('div');n.className='notice'+(error?' error':'');n.textContent=message;host.append(n);setTimeout(()=>n.remove(),error?10000:5000);}
export function fail(error){notice(error.message||String(error),true);console.error(error);}
export function esc(value=''){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
export function option(value,label,selected){return ui('<option value="')+esc(value)+'"'+(String(value)===String(selected)?' selected':'')+'>'+esc(label)+ui('</option>');}
export function field(label,name,value='',type='text',extra=''){return ui('<label>')+esc(label)+ui('<input name="')+esc(name)+'" type="'+type+'" value="'+esc(value)+'" '+extra+ui('></label>');}
export function select(label,name,options,value){return ui('<label>')+esc(label)+ui('<select name="')+esc(name)+'">'+options.map(([v,t])=>option(v,t,value)).join('')+ui('</select></label>');}
export const TYPES={get game(){return t('Partie complète');},get moves(){return t('Mémoriser des coups');},get solve(){return t('Résoudre une position');},get play(){return t('Jouer contre le moteur');}};
export const START='rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export function time(seconds){if(seconds==null)return '—';const s=Math.max(0,Math.round(seconds));return s>=60?Math.floor(s/60)+':'+String(s%60).padStart(2,'0'):s+' s';}
export function modal(title,html,{submit=t('Enregistrer'),onSubmit,wide=false}={}){
  const d=document.getElementById('modal');d.innerHTML=ui('<form class="dialog-form"><div class="dialog-head"><h2>')+esc(title)+ui('</h2><button type="button" data-close aria-label="Fermer">×</button></div>')+html+ui('<div class="dialog-actions"><button type="button" data-close>Annuler</button>')+(onSubmit?ui('<button class="primary" type="submit">')+esc(submit)+ui('</button>'):'')+ui('</div></form>');d.classList.toggle('wide',wide);
  d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());
  d.querySelector('form').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget,b=d.querySelector('[type=submit]');if(b)b.disabled=true;try{await onSubmit(new FormData(form),form);if(d.open&&d.querySelector('form')===form)d.close();}catch(err){if(d.open&&d.querySelector('form')===form){fail(err);if(b)b.disabled=false;}}};
  // Keep DOM order aligned with the top layer when opened above a draft editor.
  if(!d.open){document.body.append(d);d.showModal();}return d;
}
export function download(url){const a=document.createElement('a');a.href=url;a.download='';document.body.append(a);a.click();a.remove();}
