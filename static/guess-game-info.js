import {esc} from './api.js';
import {t,locale} from './i18n.js';
import {nodeIndex} from './chess-document.js';
import {formatClock,positionClocks} from './analysis-clocks.js';

const knownHeader=value=>{
 const text=String(value??'').trim();
 return text&&!/^[?*\s-]+$/.test(text)?text:'';
};

function gameDate(value){
 const match=knownHeader(value).match(/^(\d{4})(?:[.-](\d{2}|\?\?)(?:[.-](\d{2}|\?\?))?)?$/);
 if(!match)return '';
 const year=Number(match[1]),month=match[2]&&match[2]!=='??'?Number(match[2]):null,day=month&&match[3]&&match[3]!=='??'?Number(match[3]):null;
 if(!year||(month!==null&&(month<1||month>12))||(day!==null&&(day<1||day>31)))return '';
 const date=new Date(0);date.setUTCFullYear(year,(month??1)-1,day??1);date.setUTCHours(0,0,0,0);
 if(day!==null&&(date.getUTCMonth()!==month-1||date.getUTCDate()!==day))return '';
 return new Intl.DateTimeFormat(locale(),{timeZone:'UTC',year:'numeric',...(month?{month:'long'}:{}),...(day?{day:'numeric'}:{})}).format(date);
}

export function guessGameDetailsHtml(headers={}){
 const event=knownHeader(headers.Event),date=gameDate(headers.Date)||gameDate(headers.UTCDate);
 const details=[event&&'<span class="guess-event">'+esc(event)+'</span>',date&&'<span class="guess-date">'+esc(date)+'</span>'].filter(Boolean);
 return details.length?'<p class="guess-game-details">'+details.join('<span aria-hidden="true"> · </span>')+'</p>':'';
}

export function guessPlayerBandHtml(board,side,sourceDoc){
 const key=side==='white'?'White':'Black',label=side==='white'?t('Blancs'):t('Noirs'),headers=sourceDoc?.headers||{};
 const name=knownHeader(headers[key])||label,rawElo=knownHeader(headers[key+'Elo']),rating=Number(rawElo),elo=/^\d+$/.test(rawElo)&&Number.isSafeInteger(rating)&&rating>0?String(rating):'';
 const current=nodeIndex(board.doc).get(board.path),source=nodeIndex(sourceDoc).get(board.path);
 // Only the original, already-revealed position owns historical clock values.
 // A proposed move or an engine preview must not inherit either player's time.
 const original=source&&current&&source.fen===current.fen&&source.uci===current.uci;
 const value=original&&!board.preview&&!board.pendingMove?positionClocks(sourceDoc,board.path)[side]:null;
 const clock=value==null?'':formatClock(value),turn=current?.fen?.split(' ')[1]===(side==='white'?'w':'b');
 return '<span class="guess-player-color '+side+'" role="img" aria-label="'+esc(label)+'"></span>'+
  '<span class="guess-player-info"><strong class="guess-player-name">'+esc(name)+'</strong>'+(elo?'<span class="guess-player-rating">'+esc(t('Elo'))+' '+esc(elo)+'</span>':'')+'</span>'+
  (clock?'<span class="guess-player-clock'+(turn?' is-turn':'')+'" aria-label="'+esc(t('Temps de la partie')+' · '+label+' : '+clock)+'"><strong class="guess-player-clock-value">'+esc(clock)+'</strong><small>'+esc(t('Temps de la partie'))+'</small></span>':'');
}
