import {t,ui,locale} from './i18n.js';
import {api,esc,START} from './api.js';

// A position can be reached through different branches with different encounter rates.
export function probabilityContext(board,settings){
 const nodes=board.doc?.nodes;if(!nodes?.length)return null;
 const map=new Map(nodes.map(node=>[node.path,node])),current=board.node(),root=map.get('');
 if(!root?.fen||!current?.fen||!map.has(current.path))return null;
 const moves=[],seen=new Set();let node=current;
 while(node!==root){
  if(seen.has(node.path)||!node.uci||node.parent==null)return null;
  seen.add(node.path);moves.push(node.uci);node=map.get(node.parent);if(!node)return null;
 }
 moves.reverse();
 const filters={source:settings.source,base_ids:[...(settings.base_ids||[])].sort((a,b)=>a-b),speeds:[...(settings.speeds||[])].sort(),ratings:[...(settings.ratings||[])].sort((a,b)=>a-b),repertoire_color:settings.repertoire_color==='black'?'black':'white'};
 if(settings.source==='local'){const local=settings.local_filters||{};filters.local_filters={rating_min:local.rating_min??null,rating_max:local.rating_max??null,speeds:[...new Set(local.speeds||[])].sort()};}
 const context={fen:current.fen,start_fen:root.fen,moves,settings:{...settings,repertoire_color:filters.repertoire_color}};
 context.key=JSON.stringify([context.fen,context.start_fen,moves,filters]);
 context.conditional_root=root.fen.split(' ').slice(0,4).join(' ')!==START.split(' ').slice(0,4).join(' ');
 return context;
}
export function probabilityDisplay(value){
 const probability=value?.status==='ok'?value.probability:null;
 if(!Number.isFinite(probability)||probability<0||probability>1)return {text:'—',ratio:'',title:value?.message||t('Estimation indisponible : les statistiques d’au moins une réponse adverse manquent.')};
 const percentage=probability*100,format=new Intl.NumberFormat(locale(),{maximumFractionDigits:percentage<1?2:1});
 const text=probability>0&&percentage<.01?t('< 0,01 %'):format.format(percentage)+' %';
 const reciprocal=1/probability,ratio=probability===0?t('non observée'):reciprocal>Number.MAX_SAFE_INTEGER?t('moins de 1 sur 9 × 10¹⁵'):t('≈ 1 sur ')+new Intl.NumberFormat(locale(),{maximumFractionDigits:reciprocal<10?1:0}).format(reciprocal);
 return {text,ratio,title:t('Estimation selon la base, la cadence et le niveau sélectionnés. Seules les réponses adverses sont multipliées ; tes propres coups sont supposés joués.')+(value.conditional_root?t(' Calcul depuis la position de départ du PGN, pas depuis le début d’une partie.'):t(' Calcul le long de cette variante, sans additionner les transpositions.'))+(value.stale?t(' Dernières statistiques connues.'):'')};
}
export function probabilityHtml(state,context){
 const value=state.value,display=probabilityDisplay(value);
 if(state.loading)return ui('<span class="explorer-probability-label">Probabilité de la ligne</span><strong role="status">…</strong>');
 return '<span class="explorer-probability-label">'+(context?.conditional_root?t('Depuis le diagramme'):t('Probabilité de la ligne'))+'</span><strong title="'+esc(display.title)+'">'+esc(display.text)+'</strong>'+(display.ratio?'<span class="explorer-probability-ratio" title="'+esc(display.title)+'">'+esc(display.ratio)+'</span>':'')+(value?.status==='unavailable'?ui('<button type="button" class="quiet explorer-probability-retry" data-explorer-action="probability-retry" aria-label="Réessayer la probabilité de cette ligne" title="Réessayer la probabilité">↻</button>'):'')+(value?.stale?ui('<span class="explorer-probability-stale" title="Dernières statistiques connues">↺</span>'):'')+'<span class="explorer-probability-help" tabindex="0" role="note" aria-label="'+esc(display.title)+'" title="'+esc(display.title)+'">ⓘ</span>';
}
export class ExplorerProbability{
 constructor({getContext,isActive,onChange,request=api,delay=400}){Object.assign(this,{getContext,isActive,onChange,request,delay});this.key='';this.sequence=0;this.timer=null;this.controller=null;this.cache=new Map();this.state={loading:false,value:null};this.context=null;this.disposed=false;}
 stop(){clearTimeout(this.timer);this.timer=null;this.controller?.abort();this.controller=null;this.sequence++;this.key='';this.state={loading:false,value:null};}
 update({force=false,immediate=false}={}){
  if(this.disposed)return;
  if(!this.isActive()){this.stop();this.onChange();return;}
  const context=this.getContext();
  if(!context){this.stop();this.context=null;this.state.value={status:'unavailable',message:t('L’historique de cette variante est indisponible.')};this.onChange();return;}
  if(!force&&this.key===context.key)return;
  this.stop();this.context=context;this.key=context.key;const sequence=this.sequence;
  const cached=this.cache.get(context.key);
  if(!force&&cached&&Date.now()-cached.time<120000){this.state={loading:false,value:cached.value};this.onChange();return;}
  this.state={loading:true,value:null};this.onChange();
  if(immediate)this.run(sequence,context);else this.timer=setTimeout(()=>this.run(sequence,context),this.delay);
 }
 current(sequence,context){return !this.disposed&&this.isActive()&&sequence===this.sequence&&context.key===this.getContext()?.key;}
 async run(sequence,context){
  if(!this.current(sequence,context))return;
  const controller=new AbortController();this.controller=controller;
  try{
   const {fen,start_fen,moves,settings}=context;
   const value=await this.request('/api/explorer/probability',{method:'POST',body:{fen,start_fen,moves,settings},signal:controller.signal});
   if(!this.current(sequence,context))return;
   if(value.repertoire_color!==settings.repertoire_color||!['ok','unavailable'].includes(value.status)||(value.status==='ok'&&(!Number.isFinite(value.probability)||value.probability<0||value.probability>1)))throw new Error('Invalid probability');
   this.state={loading:false,value};
   if(value.status==='ok'&&!value.stale){this.cache.delete(context.key);this.cache.set(context.key,{time:Date.now(),value});while(this.cache.size>64)this.cache.delete(this.cache.keys().next().value);}
  }catch(error){if(!this.current(sequence,context)||error.name==='AbortError')return;this.state={loading:false,value:{status:'unavailable',message:t('Probabilité indisponible pour le moment. Clique sur ↻ pour réessayer.')}};}
  finally{if(this.current(sequence,context)){this.controller=null;this.onChange();}}
 }
 dispose(){this.stop();this.disposed=true;this.cache.clear();}
}
