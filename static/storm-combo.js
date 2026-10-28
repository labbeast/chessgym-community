import {esc} from './api.js';
import {t} from './i18n.js';

export function stormComboHtml(storm){
 const progress=storm?.combo_progress;
 if(!progress)return '';
 const label=t(progress.remaining===1?'Bonus dans 1 coup : +{seconds} s':'Bonus dans {moves} coups : +{seconds} s',{moves:progress.remaining,seconds:progress.seconds});
 return `<div class="puzzle-storm-combo" data-storm-combo><span>${esc(label)}</span><progress value="${progress.moves}" max="${progress.target}" aria-label="${esc(label)}"></progress></div>`;
}
