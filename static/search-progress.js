import {esc} from './api.js';
import {t} from './i18n.js';

// Searches do not expose a measurable total. Keep the bar indeterminate until
// the current request (including background preparation) actually finishes.
export function searchProgressHtml({label='Recherche en cours…',hint=''}={}){
 const text=esc(t(label));
 return '<div class="search-progress" role="status"><div class="search-progress-label">'+text+'</div><div class="search-progress-track" role="progressbar" aria-label="'+text+'"><span aria-hidden="true"></span></div>'+(hint?'<p class="hint">'+esc(t(hint))+'</p>':'')+'</div>';
}
