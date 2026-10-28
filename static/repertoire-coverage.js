import {t,ui,locale} from './i18n.js';
import {api,esc} from './api.js';

const RATINGS=[[0,'< 1000'],[1000,'1000–1199'],[1200,'1200–1399'],[1400,'1400–1599'],[1600,'1600–1799'],[1800,'1800–1999'],[2000,'2000–2199'],[2200,'2200–2499'],[2500,'2500 +']];
const SPEEDS=()=>[['ultraBullet','UltraBullet'],['bullet','Bullet'],['blitz','Blitz'],['rapid',t('Rapide')],['classical',t('Classique')],['correspondence',t('Correspondance')]];
const DEFAULTS={ratings:[1600,1800],speeds:['rapid'],min_probability:.01,max_ply:20};
const number=value=>new Intl.NumberFormat(locale(),{maximumFractionDigits:2}).format(value);
const count=value=>number(Math.max(0,Number(value)||0));

export function coverageProbability(probability){
 if(typeof probability!=='number'||!Number.isFinite(probability)||probability<=0||probability>1)return {percent:'—',odds:''};
 const inverse=1/probability,rounded=Math.round(inverse);
 return {percent:(probability<.0001?t('< 0,01'):number(probability*100))+' %',odds:(Math.abs(inverse-rounded)>.005?'≈ ':'')+t('1 sur ')+number(rounded)};
}
export function coverageRequestOptions(values){
 const ratings=[...new Set(values.ratings||[])].map(Number),speeds=[...new Set(values.speeds||[])];
 if(!ratings.length||ratings.some(value=>!RATINGS.some(([id])=>id===value)))throw new Error(t('Choisis au moins une tranche de classement.'));
 if(!speeds.length||speeds.some(value=>!SPEEDS().some(([id])=>id===value)))throw new Error(t('Choisis au moins une cadence.'));
 const percent=Number(values.minProbabilityPercent),maxPly=Number(values.maxPly);
 if(!Number.isFinite(percent)||percent<.01||percent>100)throw new Error(t('Le seuil doit être compris entre 0,01 % et 100 %.'));
 if(!Number.isInteger(maxPly)||maxPly<1||maxPly>60)throw new Error(t('La profondeur doit être comprise entre 1 et 60 demi-coups.'));
 return {ratings,speeds,min_probability:percent/100,max_ply:maxPly};
}
function profile(data){return {...DEFAULTS,...data?.filters,...data?.options};}
function checkboxes(name,choices,selected){return choices.map(([value,label])=>'<label><input type="checkbox" name="'+name+'" value="'+value+'"'+(selected.includes(value)?' checked':'')+'> <span>'+label+'</span></label>').join('');}
function scopeLabel(data){
 const options=profile(data),ratings=RATINGS.filter(([id])=>options.ratings.includes(id)).map(([,label])=>label).join(', '),speeds=SPEEDS().filter(([id])=>options.speeds.includes(id)).map(([,label])=>label).join(', ');
 return (data?.color==='black'?t('Noirs'):t('Blancs'))+' · '+ratings+' Lichess · '+speeds+t(' · seuil ')+coverageProbability(options.min_probability).percent+' · '+options.max_ply+t(' demi-coups');
}
function sortedGaps(data){return [...(Array.isArray(data?.gaps)?data.gaps:[])].sort((a,b)=>(Number(b.probability)||0)-(Number(a.probability)||0));}
function reportDate(value){const date=value?new Date(value):null;return date&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat(locale(),{dateStyle:'medium',timeStyle:'short'}).format(date):'';}
export function coverageResultsHtml(data,{opening=false}={}){
 if(!data||data.status==='not_scanned')return ui('<p class="rc-empty">Lance l’exploration pour repérer les réponses fréquentes encore absentes de ce répertoire.</p>');
 const gaps=sortedGaps(data),complete=data.status==='complete';
 const date=reportDate(data.updated_at);
 let html='<p class="rc-scope">'+esc(scopeLabel(data))+'</p>'+(date||data.stale?'<p class="rc-updated">'+(date?t('Dernier bilan : ')+esc(date):'')+(data.stale?ui('<strong>Bilan à actualiser</strong>'):'')+'</p>':'')+'<div class="rc-progress-summary"><strong>'+count(gaps.length)+t(' lacune')+(gaps.length>1?'s':'')+'</strong><span>'+count(data.positions_scanned)+' '+(data.positions_scanned>1?t('positions explorées'):t('position explorée'))+'</span><span>'+count(data.prepared_count)+' '+(data.prepared_count>1?t('positions préparées'):t('position préparée'))+ui(' avec estimation</span></div>')+
  '<p class="rc-status">'+(complete?t('Exploration terminée pour le seuil et la profondeur choisis.'):t('Exploration partielle : les résultats peuvent encore évoluer.'))+'</p>';
 if(data.message)html+='<p class="rc-warning">'+esc(data.message)+'</p>';
 if(data.unknown_count)html+='<p class="rc-warning">'+count(data.unknown_count)+t(' position')+(data.unknown_count>1?'s':'')+ui(' sans estimation exploitable.</p>');
 if(data.mixed_roots)html+=ui('<p class="rc-note">Plusieurs positions de départ sont examinées')+(data.conditional_root?t(', dont des diagrammes'):'')+ui('. Chaque probabilité suppose son départ déjà atteint ; elles ne s’additionnent pas entre ces départs.</p>');
 else if(data.conditional_root)html+=ui('<p class="rc-note">Ce répertoire commence sur un diagramme : les probabilités supposent cette position déjà atteinte.</p>');
 if(!gaps.length)return html+'<p class="rc-empty">'+(complete?t('Aucune lacune trouvée dans les chemins examinés avec ces réglages.'):data.needs_narrowing?t('La limite de cette exploration est atteinte. Affine les réglages pour réduire le nombre de positions à examiner.'):(data.resumable??data.truncated)?t('Aucune lacune trouvée pour le moment. Poursuis l’exploration pour compléter le bilan.'):t('Les données disponibles ne permettent pas encore de compléter le bilan. Ajuste les filtres ou réessaie plus tard.'))+'</p>';
 return html+ui('<ol class="rc-gaps" aria-label="Lacunes par probabilité décroissante">')+gaps.map((gap,index)=>{
  const probability=coverageProbability(gap.probability),label=gap.kind==='own_reply'?t('Choisir un coup pour les ')+(data.color==='black'?t('Noirs'):t('Blancs')):t('Préparer une réponse à ')+(gap.san||t('ce coup'));
  return '<li class="rc-gap"><div class="rc-gap-heading"><h3>'+esc(label)+'</h3><div class="rc-gap-probability"><strong>'+esc(probability.percent)+'</strong><span>'+esc(probability.odds)+'</span></div></div>'+
   (gap.san_line?'<p class="rc-gap-line">'+esc(gap.san_line)+'</p>':'')+
   (typeof gap.frequency==='number'&&Number.isFinite(gap.frequency)&&gap.frequency>=0&&gap.frequency<=1?'<small class="rc-gap-frequency">'+esc(number(gap.frequency*100))+ui(' % des réponses à cette position</small>'):'')+
   (gap.conditional_root&&!data.conditional_root?ui('<small>Depuis la position de départ du diagramme</small>'):'')+
   '<button type="button" data-coverage-gap="'+index+'"'+(opening?' disabled':'')+' aria-label="'+esc(t('Explorer : ')+label)+ui('">Explorer cette position →</button></li>');
 }).join('')+'</ol>';
}

export class RepertoireCoverage{
 constructor(host,{baseId,onExplore=()=>{}}={}){
  if(!Number.isSafeInteger(Number(baseId))||Number(baseId)<=0)throw new Error(t('Répertoire introuvable.'));
  this.host=host;this.baseId=Number(baseId);this.onExplore=onExplore;this.data=null;this.disposed=false;this.sequence=0;this.busy='';this.error='';this.touched=false;this.dirty=false;this.opening=false;
  host.innerHTML=ui('<section class="repertoire-coverage"><p class="rc-intro">Repère les réponses adverses à préparer en priorité. Ouvre une position dans l’analyse, joue ta réponse, puis sauvegarde la ligne dans ce répertoire.</p><form data-coverage-form><details class="rc-settings"><summary>Réglages de l’exploration</summary><fieldset data-coverage-controls><legend class="rc-sr-only">Filtres et profondeur</legend><div class="rc-filter-group"><h3>Classement Lichess moyen des joueurs</h3><div class="rc-checks">')+checkboxes('ratings',RATINGS,DEFAULTS.ratings)+ui('</div></div><div class="rc-filter-group"><h3>Cadences</h3><div class="rc-checks">')+checkboxes('speeds',SPEEDS(),DEFAULTS.speeds)+ui('</div></div><div class="rc-number-fields"><label>Probabilité minimale (%)<input type="number" name="min_probability" min="0.01" max="100" step="0.01" value="1" required></label><label>Profondeur (demi-coups)<input type="number" name="max_ply" min="1" max="60" step="1" value="20" required></label></div><p class="rc-note">Un coup blanc ou noir compte pour un demi-coup. Les tranches Lichess n’ont pas d’équivalence directe avec les classements Chess.com.</p></fieldset></details><div class="rc-actions"><button type="submit" class="primary" data-coverage-action="scan">Explorer le répertoire</button><button type="button" data-coverage-action="reset" hidden>Recalculer</button><button type="button" class="quiet" data-coverage-action="cancel" hidden>Arrêter</button></div></form><div data-coverage-state role="status" aria-live="polite"></div><div data-coverage-error role="alert"></div><div data-coverage-results></div><p class="rc-note rc-probability-note">Les probabilités sont conditionnelles à tes choix de répertoire : seuls les coups adverses les font diminuer. Elles ne constituent pas un pourcentage global de couverture.</p></section>');
  this.onSubmit=event=>{if(event.target!==this.host.querySelector('[data-coverage-form]'))return;event.preventDefault();this.scan();};
  this.onClick=event=>{const button=event.target.closest?.('[data-coverage-action],[data-coverage-gap]');if(!button||!host.contains(button)||button.disabled)return;const action=button.dataset.coverageAction;if(action==='reset')this.scan({reset:true});else if(action==='cancel')this.cancel();else if(button.dataset.coverageGap!==undefined)this.explore(Number(button.dataset.coverageGap));};
  this.onChange=event=>{if(!['ratings','speeds','min_probability','max_ply'].includes(event.target.name))return;this.touched=true;this.dirty=true;this.error='';this.renderStatus();};
  host.addEventListener('submit',this.onSubmit);host.addEventListener('click',this.onClick);host.addEventListener('change',this.onChange);this.ready=this.load();
 }
 controls(){return this.host.querySelector('[data-coverage-controls]');}
 syncControls(){
  const value=profile(this.data);
  for(const key of ['ratings','speeds'])this.host.querySelectorAll('[name="'+key+'"]').forEach(input=>input.checked=value[key].map(String).includes(input.value));
  const threshold=this.host.querySelector('[name="min_probability"]'),depth=this.host.querySelector('[name="max_ply"]');if(threshold)threshold.value=String(value.min_probability*100);if(depth)depth.value=String(value.max_ply);
 }
 readOptions(){return coverageRequestOptions({ratings:[...this.host.querySelectorAll('[name="ratings"]:checked')].map(input=>input.value),speeds:[...this.host.querySelectorAll('[name="speeds"]:checked')].map(input=>input.value),minProbabilityPercent:this.host.querySelector('[name="min_probability"]')?.value,maxPly:this.host.querySelector('[name="max_ply"]')?.value});}
 renderStatus(){
  if(this.disposed)return;
  const scanning=this.busy==='scan',loading=this.busy==='load';
  const state=this.host.querySelector('[data-coverage-state]');if(state)state.innerHTML=scanning?ui('<p class="rc-running">Exploration en cours…</p><progress aria-label="Exploration en cours"></progress>'):loading?ui('<p class="rc-running">Chargement du dernier bilan…</p>'):this.dirty?ui('<p class="rc-note">Réglages modifiés : lance l’exploration pour les appliquer.</p>'):'';
  const error=this.host.querySelector('[data-coverage-error]');if(error)error.innerHTML=this.error?'<p class="rc-error">'+esc(this.error)+'</p>':'';
  if(this.controls())this.controls().disabled=scanning;
  const scan=this.host.querySelector('[data-coverage-action="scan"]'),reset=this.host.querySelector('[data-coverage-action="reset"]'),cancel=this.host.querySelector('[data-coverage-action="cancel"]');
  if(scan){scan.disabled=scanning||this.opening||((this.data?.status==='complete'||!!this.data?.needs_narrowing)&&!this.dirty);scan.textContent=this.dirty?t('Appliquer et explorer'):this.data?.needs_narrowing?t('Affiner les réglages'):this.data?.status==='partial'?((this.data.resumable??this.data.truncated)?t('Continuer l’exploration'):t('Actualiser le bilan')):this.data?.status==='complete'?t('Exploration terminée'):t('Explorer le répertoire');}
  if(reset){reset.hidden=!this.data||this.data.status==='not_scanned';reset.disabled=scanning||this.opening;}
  if(cancel)cancel.hidden=!this.busy;
  this.host.querySelectorAll('[data-coverage-gap]').forEach(button=>button.disabled=this.opening||scanning);
 }
 renderResults(){if(this.disposed)return;const host=this.host.querySelector('[data-coverage-results]');if(host)host.innerHTML=coverageResultsHtml(this.data,{opening:this.opening||this.busy==='scan'});this.renderStatus();}
 async request(method,body){
  if(this.disposed)return false;this.controller?.abort();const controller=new AbortController(),sequence=++this.sequence;this.controller=controller;this.busy=method==='POST'?'scan':'load';this.error='';this.renderStatus();
  try{const data=await api('/api/repertoires/'+this.baseId+'/coverage',{method,...(body?{body}:{}),signal:controller.signal});if(this.disposed||sequence!==this.sequence)return false;this.data=data;if(method==='POST'){this.dirty=false;this.touched=false;this.syncControls();}else if(!this.touched)this.syncControls();if(data.needs_narrowing){const settings=this.host.querySelector('.rc-settings');if(settings)settings.open=true;}this.busy='';this.renderResults();return true;}
  catch(error){if(this.disposed||sequence!==this.sequence||error.name==='AbortError')return false;this.busy='';this.error=error.message;this.renderResults();return false;}
 }
 load(){return this.request('GET');}
 scan({reset=false}={}){
  if(this.disposed||this.busy==='scan'||this.opening||(!reset&&this.data?.needs_narrowing&&!this.dirty))return Promise.resolve(false);
  let options;try{options=this.readOptions();}catch(error){this.error=error.message;this.renderStatus();return Promise.resolve(false);}
  return this.request('POST',{...options,...(reset?{reset:true}:{})});
 }
 cancel(){if(this.disposed)return;this.sequence++;this.controller?.abort();this.busy='';this.renderStatus();}
 async explore(index){
  if(this.disposed||this.opening||this.busy==='scan'||!Number.isInteger(index))return false;const gap=sortedGaps(this.data)[index];if(!gap)return false;
  this.opening=true;this.error='';this.renderStatus();
  try{await this.onExplore(structuredClone(gap),{baseId:this.baseId,color:this.data.color,filters:structuredClone(this.data.filters||DEFAULTS),conditionalRoot:!!this.data.conditional_root});return !this.disposed;}
  catch(error){if(!this.disposed){this.error=error.message;this.renderStatus();}return false;}
  finally{this.opening=false;this.renderStatus();}
 }
 dispose(){this.disposed=true;this.sequence++;this.controller?.abort();this.host.removeEventListener('submit',this.onSubmit);this.host.removeEventListener('click',this.onClick);this.host.removeEventListener('change',this.onChange);}
}
export function mountRepertoireCoverage(host,options){return new RepertoireCoverage(host,options);}
