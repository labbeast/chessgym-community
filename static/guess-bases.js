import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';

export const associatedGuessBases=bases=>bases.filter(base=>base.settings?.guess_enabled===true);

export function guessDashboardHtml(bases,{onLibrary=false}={}){
 if(!bases.length)return '<div class="empty"><h2>'+esc(t('Aucune base pour Deviner le coup'))+'</h2><p>'+esc(t('Active « Inclure cette base dans Deviner le coup » dans les réglages des bases que tu veux retrouver ici.'))+'</p>'+(onLibrary?'<button type="button" data-guess-library>'+esc(t('Ouvrir la bibliothèque'))+'</button>':'')+'</div>';
 return '<div class="reading-grid guess-base-grid">'+bases.map(base=>'<section class="panel reading-card guess-base-card" data-guess-card="'+base.id+'"><div class="reading-card-heading"><h2>'+esc(base.name)+'</h2></div><div class="reading-card-stats"><span><strong>'+Math.max(0,Number(base.entry_count)||0).toLocaleString(locale())+'</strong>'+esc(t('Parties'))+'</span><span><strong>'+esc(t(base.reference?'Référence':'Personnelle'))+'</strong>'+esc(t('Type de base'))+'</span></div><div class="actions"><button type="button" class="primary" data-guess-base="'+base.id+'">'+esc(t('Choisir une partie'))+'</button></div></section>').join('')+'</div>';
}

export function guessBaseSettingsHtml(base){
 return ui('<section class="panel guess-base-settings"><h2>Deviner le coup</h2><label class="check"><input type="checkbox" name="guess_enabled" ')+(base.settings?.guess_enabled?'checked':'')+ui('> Inclure cette base dans Deviner le coup</label><p class="hint">Seules les bases cochées apparaissent dans le menu Deviner le coup.</p></section>');
}
