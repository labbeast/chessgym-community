import {t,ui,locale} from './i18n.js';
import {esc} from './api.js';

export const REVIEW_PROGRESS_STATES=[
 ['mastered','Maîtrisés'],['learned','Appris'],['due','À réviser'],['unlearned','Non appris']
];
const number=value=>new Intl.NumberFormat(locale()).format(value);
// Only server-provided exclusive counts can be represented as parts of one bar.
// Older totals overlap (mastered is also learned, due can be learning or learned).
export function progressCounts(row){
 const source=row?.progress_counts;
 if(!source||REVIEW_PROGRESS_STATES.some(([key])=>!Number.isSafeInteger(source[key])||source[key]<0))return null;
 const counts=Object.fromEntries(REVIEW_PROGRESS_STATES.map(([key])=>[key,source[key]]));
 if(Object.values(counts).reduce((sum,value)=>sum+value,0)!==Number(row.total))return null;
 return counts;
}
export function reviewProgressLegend(row=null){
 const counts=row?progressCounts(row):null;if(row&&!counts)return '';
 return ui('<ul class="review-progress-legend" aria-label="États de progression">')+REVIEW_PROGRESS_STATES.map(([key,label])=>ui('<li><i class="review-progress-')+key+ui('" aria-hidden="true"></i><span>')+t(label)+ui('</span>')+(counts?ui('<strong>')+number(counts[key])+ui('</strong>'):'')+ui('</li>')).join('')+ui('</ul>');
}
export function reviewProgressHtml(row,{legend=false}={}){
 const counts=progressCounts(row);if(!counts)return '';
 const total=Number(row.total),description=REVIEW_PROGRESS_STATES.map(([key,label])=>t(label)+' : '+number(counts[key])).join(' · ');
 return ui('<div class="review-progress"><div class="review-progress-track" role="img" aria-label="')+esc(t('Progression · ')+description)+'"'+(!total?' data-empty="true"':'')+'>'+REVIEW_PROGRESS_STATES.filter(([key])=>counts[key]>0).map(([key,label])=>ui('<span class="review-progress-')+key+'" style="width:'+(100*counts[key]/total)+ui('%" title="')+esc(t(label)+' : '+number(counts[key])+t(' / ')+number(total))+ui('" aria-hidden="true"></span>')).join('')+ui('</div>')+(legend?reviewProgressLegend(row):'')+ui('</div>');
}
