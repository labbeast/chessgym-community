import {t} from './i18n.js';
import {esc,option} from './api.js';

export const GAME_FILTER_FIELDS=['player','first_name','last_name','player_color','white','black','event','site','round','date_from','date_to','rating_min','rating_max','rating_side','result','eco','opening','speed'];
export const GAME_FILTER_DEFAULTS={player_color:'any',rating_side:'both'};
const text=(key,label,values,attributes='')=>'<label>'+esc(t(label))+'<input name="'+key+'" data-game-filter="'+key+'" value="'+esc(values[key]||'')+'" '+attributes+'></label>';
const select=(key,label,options,values)=>'<label>'+esc(t(label))+'<select name="'+key+'" data-game-filter="'+key+'">'+options.map(([value,label])=>option(value,t(label),values[key]||GAME_FILTER_DEFAULTS[key]||'')).join('')+'</select></label>';
export function gameFilterCount(filters={}){return GAME_FILTER_FIELDS.filter(key=>!['player_color','rating_side'].includes(key)&&String(filters[key]??'').trim()).length;}
export function gameSearchHtml(values={},actions=''){
 return '<details class="game-search list-advanced" data-game-search><summary>'+esc(t('Recherche avancée'))+' <span data-game-search-count>'+gameSearchCountLabel(values)+'</span><span class="list-dirty" data-list-dirty hidden>'+esc(t('Modifications à appliquer'))+'</span></summary><div class="game-search-groups"><fieldset><legend>'+esc(t('Joueurs'))+'</legend><div class="game-search-fields">'+
 text('player','Joueur · nom complet ou pseudonyme',values,'type="search" maxlength="200"')+text('last_name','Nom de famille',values,'type="search" maxlength="200"')+text('first_name','Prénom',values,'type="search" maxlength="200"')+select('player_color','Couleur du joueur',[['any','Peu importe'],['white','Blancs'],['black','Noirs']],values)+text('white','Joueur avec les Blancs',values,'type="search" maxlength="200"')+text('black','Joueur avec les Noirs',values,'type="search" maxlength="200"')+
 '</div><p class="hint">'+esc(t('Les mots du nom et du prénom doivent appartenir au même joueur, dans n’importe quel ordre. Accents et majuscules sont ignorés.'))+'</p></fieldset><fieldset><legend>'+esc(t('Partie'))+'</legend><div class="game-search-fields">'+
 text('event','Tournoi / événement',values,'type="search" maxlength="200"')+text('site','Lieu / site',values,'type="search" maxlength="200"')+text('round','Ronde',values,'type="text" maxlength="200"')+text('date_from','Date · à partir du',values,'type="date"')+text('date_to','Date · jusqu’au',values,'type="date"')+select('result','Résultat',[['','Tous les résultats'],['1-0','1–0 · victoire des Blancs'],['0-1','0–1 · victoire des Noirs'],['1/2-1/2','½–½ · partie nulle'],['*','* · résultat non déterminé']],values)+select('speed','Cadence',[['','Toutes'],['ultraBullet','Ultra bullet'],['bullet','Bullet'],['blitz','Blitz'],['rapid','Rapide'],['classical','Classique'],['correspondence','Correspondance'],['unknown','Cadence inconnue']],values)+
 '</div><p class="hint">'+esc(t('Les bornes de date sont inclusives. Une date PGN partielle est retenue si son mois ou son année recoupe la période.'))+'</p></fieldset><fieldset><legend>'+esc(t('Classement et ouverture'))+'</legend><div class="game-search-fields">'+
 text('rating_min','Elo minimum',values,'type="number" min="0" max="4000" step="1"')+text('rating_max','Elo maximum',values,'type="number" min="0" max="4000" step="1"')+select('rating_side','Appliquer la plage Elo à',[['both','Aux deux joueurs'],['either','À au moins un joueur'],['white','Aux Blancs'],['black','Aux Noirs']],values)+text('eco','Code ECO',values,'type="text" maxlength="7" placeholder="B90, B9, B90-B99" autocapitalize="characters"')+text('opening','Nom de l’ouverture',values,'type="search" maxlength="200"')+
 '</div><p class="hint">'+esc(t('ECO accepte un code, un préfixe ou une plage : B90, B9 ou B90-B99.'))+'</p></fieldset></div><p class="game-search-error" data-game-search-error role="alert" hidden></p>'+actions+'</details>';
}
export function gameSearchCountLabel(filters){const count=gameFilterCount(filters);return count?esc(t(count===1?'{count} critère actif':'{count} critères actifs',{count})):'';}
export function readGameFilters(source){
 const values={};for(const key of GAME_FILTER_FIELDS){const value=String(typeof source.get==='function'?source.get(key)??'':source.querySelector('[data-game-filter="'+key+'"]')?.value??'').trim();if(value)values[key]=value;}
 values.player_color??='any';values.rating_side??='both';if(values.eco)values.eco=values.eco.toUpperCase();validateGameFilters(values);return values;
}
export function gameFilterParams(values={}){
 const result={};for(const key of GAME_FILTER_FIELDS)if(values[key]!==undefined&&String(values[key]).trim()!==''&&values[key]!==GAME_FILTER_DEFAULTS[key])result[key]=String(values[key]).trim();return result;
}
export function validateGameFilters(values){
 for(const key of ['rating_min','rating_max'])if(values[key]&&(!/^\d+$/.test(values[key])||Number(values[key])>4000))throw Error(t('Le classement doit être un nombre entre 0 et 4000.'));
 if(values.rating_min&&values.rating_max&&Number(values.rating_min)>Number(values.rating_max))throw Error(t('Le minimum ne peut pas dépasser le maximum.'));
 for(const key of ['date_from','date_to'])if(values[key]&&(!/^\d{4}-\d{2}-\d{2}$/.test(values[key])||!Number.isFinite(Date.parse(values[key]))||new Date(values[key]).toISOString().slice(0,10)!==values[key]))throw Error(t('Choisis une date valide.'));
 if(values.date_from&&values.date_to&&values.date_from>values.date_to)throw Error(t('La date de début ne peut pas dépasser la date de fin.'));
 if(values.eco&&(!/^[A-E](?:\d{0,2})$|^[A-E]\d{2}-[A-E]\d{2}$/.test(values.eco)||values.eco.includes('-')&&values.eco.split('-')[0]>values.eco.split('-')[1]))throw Error(t('Indique un code ECO de A00 à E99, un préfixe ou une plage croissante.'));
}
export function resetGameFilters(host){for(const key of GAME_FILTER_FIELDS){const node=host.querySelector('[data-game-filter="'+key+'"]');if(node)node.value=GAME_FILTER_DEFAULTS[key]||'';}const error=host.querySelector('[data-game-search-error]');if(error){error.textContent='';error.hidden=true;}}
const fold=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const words=value=>fold(value).split(/\s+/).filter(Boolean);
const matches=(value,terms)=>terms.every(term=>fold(value).includes(term));
function dateInterval(h){
 for(const value of [h.Date,h.UTCDate]){const m=String(value||'').match(/^(\d{4})[.-](\d{2}|\?\?)[.-](\d{2}|\?\?)$/);if(!m||Number(m[1])<1)continue;const year=m[1],month=m[2]&&m[2]!=='??'?Number(m[2]):null,day=m[3]&&m[3]!=='??'?Number(m[3]):null;if(month!==null&&(month<1||month>12)||day!==null&&(month===null||day<1||day>new Date(Number(year),month,0).getDate()))continue;return [year+'-'+String(month||1).padStart(2,'0')+'-'+String(day||1).padStart(2,'0'),year+'-'+String(month||12).padStart(2,'0')+'-'+String(day||(month?new Date(Number(year),month,0).getDate():31)).padStart(2,'0')];}return null;
}
function speedOf(h){const raw=String(h.TimeControl||'').trim();if(raw.startsWith('1/'))return 'correspondence';const m=raw.match(/^(\d+)(?:\+(\d+))?$/);if(!m)return 'unknown';const seconds=Number(m[1])+40*Number(m[2]||0);return seconds<30?'ultraBullet':seconds<180?'bullet':seconds<480?'blitz':seconds<1500?'rapid':'classical';}
export function matchesGameFilters(entry,values={}){
 const h=entry.headers||{},terms=words([values.player,values.first_name,values.last_name].filter(Boolean).join(' ')),players=values.player_color==='white'?[h.White]:values.player_color==='black'?[h.Black]:[h.White,h.Black];
 if(terms.length&&!players.some(player=>matches(player,terms)))return false;
 for(const [key,header]of Object.entries({white:'White',black:'Black',event:'Event',site:'Site',round:'Round'}))if(values[key]&&!matches(h[header],words(values[key])))return false;
 if(values.opening&&!matches(h.Opening,words(values.opening)))return false;
 if(values.result&&h.Result!==values.result)return false;
 if(values.eco){const eco=String(h.ECO||'').trim().toUpperCase(),[start,end]=values.eco.split('-');if(!/^[A-E]\d{2}$/.test(eco))return false;if(end?eco<start||eco>end:!eco.startsWith(start))return false;}
 if(values.date_from||values.date_to){const dates=dateInterval(h);if(!dates||values.date_from&&dates[1]<values.date_from||values.date_to&&dates[0]>values.date_to)return false;}
 if(values.rating_min!==undefined||values.rating_max!==undefined){const rating=value=>/^\d+$/.test(value||'')&&(!values.rating_min||Number(value)>=Number(values.rating_min))&&(!values.rating_max||Number(value)<=Number(values.rating_max)),white=rating(h.WhiteElo),black=rating(h.BlackElo),side=values.rating_side||'both';if(!(side==='white'?white:side==='black'?black:side==='either'?white||black:white&&black))return false;}
 if(values.speed&&speedOf(h)!==values.speed)return false;return true;
}

const FILTER_LABELS={player:'Joueur · nom complet ou pseudonyme',first_name:'Prénom',last_name:'Nom de famille',player_color:'Couleur du joueur',white:'Joueur avec les Blancs',black:'Joueur avec les Noirs',event:'Tournoi / événement',site:'Lieu / site',round:'Ronde',date_from:'Date · à partir du',date_to:'Date · jusqu’au',rating_min:'Elo minimum',rating_max:'Elo maximum',rating_side:'Appliquer la plage Elo à',result:'Résultat',eco:'Code ECO',opening:'Nom de l’ouverture',speed:'Cadence'};
const FILTER_VALUES={white:'Blancs',black:'Noirs',both:'Aux deux joueurs',either:'À au moins un joueur',ultraBullet:'Ultra bullet',bullet:'Bullet',blitz:'Blitz',rapid:'Rapide',classical:'Classique',correspondence:'Correspondance',unknown:'Cadence inconnue'};
export function gameFilterChips(filters={}){return Object.entries(gameFilterParams(filters)).map(([key,value])=>({key,label:FILTER_LABELS[key]||key,value:['player_color','rating_side','speed'].includes(key)?t(FILTER_VALUES[value]||value):value}));}
export function gameFilterDraft(host){return Object.fromEntries(GAME_FILTER_FIELDS.map(key=>[key,host.querySelector('[data-game-filter="'+key+'"]')?.value||GAME_FILTER_DEFAULTS[key]||'']));}
export function fillGameFilters(host,values={}){for(const key of GAME_FILTER_FIELDS){const node=host.querySelector('[data-game-filter="'+key+'"]');if(node)node.value=values[key]||GAME_FILTER_DEFAULTS[key]||'';}}
