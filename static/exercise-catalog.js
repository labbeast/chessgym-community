import {t} from './i18n.js';
import {esc} from './api.js';
import {uiIcon} from './ui-icons.js';

export const EXERCISES=Object.freeze([
 {page:'puzzles',title:'Puzzles',description:'Résous une position ou lance un Puzzle Storm.'},
 {page:'blindfold',title:'Puzzles à l’aveugle',description:'Visualise les coups et reconstruis la position de mémoire.'},
 {page:'coordinates',title:'Coordonnées',description:'Repère les cases et entraîne ta lecture de l’échiquier.'},
 {page:'color',title:'Couleur des cases',description:'Retrouve la couleur des cases le plus vite possible.'},
 {page:'guess',title:'Deviner le coup',description:'Retrouve les coups d’une partie de ta bibliothèque.'},
 {page:'computer',title:'Contre l’ordinateur',description:'Joue une partie à ton niveau et à ton rythme.'}
]);

export function exerciseCatalogHtml(activities=new Set()){
 return '<header class="page-title training-header"><div class="training-header-copy"><h1>'+esc(t('Exercices'))+'</h1><p>'+esc(t('Choisis une activité pour commencer.'))+'</p></div></header><div class="exercise-catalog">'+EXERCISES.map(({page,title,description})=>'<button type="button" class="exercise-card" data-exercise-page="'+page+'"><span class="exercise-card-heading"><span class="exercise-card-icon" aria-hidden="true">'+uiIcon(page)+'</span><strong>'+esc(t(title))+'</strong></span><p>'+esc(t(description))+'</p><span class="exercise-card-action">'+esc(t(activities.has(page)?'Reprendre':'Ouvrir'))+' →</span></button>').join('')+'</div>';
}
