import {t,locale} from './i18n.js';
import {esc,time} from './api.js';

const outcomeOf=attempt=>['solved','failed','incomplete'].includes(attempt.outcome)?attempt.outcome:'incomplete';
const count=value=>Math.max(0,Math.round(Number(value)||0));
const number=value=>count(value).toLocaleString(locale());
const outcomes={solved:{icon:'✓',label:'Réussi'},failed:{icon:'×',label:'Puzzle manqué'},incomplete:{icon:'—',label:'Non terminé'}};

export function stormResultRowHtml(attempt,index=1){
 const outcome=outcomeOf(attempt),status=outcomes[outcome],id=esc(attempt.id),puzzle=String(attempt.puzzle_id||'—');
 const disabled=attempt.status==='active'?' disabled':'';
 return `<li class="storm-results-row" data-storm-attempt="${id}" data-outcome="${outcome}">
  <span class="storm-results-index" aria-hidden="true">${number(attempt.index??index)}</span>
  <strong class="storm-results-identity">#${esc(puzzle)}</strong>
  <span class="storm-results-status" data-outcome="${outcome}"><span aria-hidden="true">${status.icon}</span>${esc(t(status.label))}</span>
  <div class="storm-results-details"><span><span class="storm-results-label">${esc(t('Cote'))}</span><strong>${attempt.rating==null?'—':number(attempt.rating)}</strong></span><span><span class="storm-results-label">${esc(t('Temps'))}</span><strong>${esc(attempt.elapsed_ms==null?'—':time(Math.max(0,Number(attempt.elapsed_ms)||0)/1000))}</strong></span>${['white','black'].includes(attempt.color)?`<span class="storm-results-side">${esc(t(attempt.color==='white'?'Blancs':'Noirs'))}</span>`:''}</div>
  <div class="storm-results-actions"><button type="button" data-storm-review="${id}" aria-label="${esc(t('Revoir le puzzle {puzzle}',{puzzle}))}"${disabled}>${esc(t('Revoir'))}</button><button type="button" data-storm-exercise="${id}" aria-label="${esc(t('Créer un exercice avec le puzzle {puzzle}',{puzzle}))}"${disabled}>${esc(t('Créer un exercice'))}</button></div>
 </li>`;
}

export function stormResultsHtml({storm={},attempts=[],summary={}}={}, {filter='all',name='Standard'}={}){
 const active=['all','solved','failed','incomplete'].includes(filter)?filter:'all';
 const rows=attempts.map((attempt,order)=>({attempt,order})).sort((a,b)=>(Number(a.attempt.index)||a.order+1)-(Number(b.attempt.index)||b.order+1));
 const counts={all:summary.total??attempts.length};
 for(const state of ['solved','failed','incomplete'])counts[state]=summary[state]??attempts.filter(attempt=>outcomeOf(attempt)===state).length;
 const visible=rows.filter(({attempt})=>active==='all'||outcomeOf(attempt)===active);
 const metrics=[['Score',number(storm.score)],['Meilleur combo',number(storm.best_combo)],['Erreurs',number(storm.mistakes)],['Puzzle le plus difficile',storm.solved_rating>0?number(storm.solved_rating):'—']];
 return `<section class="panel storm-results" aria-labelledby="storm-results-title">
  <header class="storm-results-header"><div><p class="storm-results-eyebrow">Puzzle Storm · ${esc(name)}</p><h2 id="storm-results-title">${esc(t('Bilan de la séance'))}</h2><span class="storm-results-finished">${esc(t('Séance terminée'))}</span></div><div class="storm-results-controls"><button type="button" class="primary" data-restart>${esc(t('Rejouer'))}</button><button type="button" data-home>${esc(t('Retour aux puzzles'))}</button></div></header>
  <dl class="storm-results-metrics">${metrics.map(([label,value])=>`<div><dt>${esc(t(label))}</dt><dd>${value}</dd></div>`).join('')}</dl>
  <div class="storm-results-filters" role="group" aria-label="${esc(t('Filtrer les puzzles de la séance'))}">${[['all','Tous'],['solved','Réussis'],['failed','Manqués'],['incomplete','Non terminés']].map(([key,label])=>`<button type="button" data-storm-filter="${key}" aria-pressed="${active===key}">${esc(t(label))}<span class="storm-results-count">${number(counts[key])}</span></button>`).join('')}</div>
  ${visible.length?`<ol class="storm-results-list" aria-label="${esc(t('Puzzles de la séance'))}">${visible.map(({attempt,order})=>stormResultRowHtml(attempt,order+1)).join('')}</ol>`:`<p class="storm-results-empty" role="status">${esc(t(attempts.length?'Aucun puzzle dans ce filtre.':'Aucun puzzle dans cette séance.'))}</p>`}
 </section>`;
}
