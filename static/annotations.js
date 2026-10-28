import {t} from './i18n.js';
// Display only: PGN storage/export must retain the original numerical IDs.
// Meanings: https://www.saremba.de/chessgml/standards/pgn/pgn-complete.htm#c10
// Common glyphs: Lichess scalachess Glyph.scala and RPB Chessboard's NAG table.
const annotations={
 0:['',''],
 1:['!','Bon coup'],
 2:['?','Erreur'],
 3:['!!','Excellent coup'],
 4:['??','Gaffe'],
 5:['!?','Coup intéressant'],
 6:['?!','Coup douteux'],
 7:['□','Coup forcé'],
 8:['□','Seul coup raisonnable'],
 9:['☒','Pire coup'],
 10:['=','Position à tendance nulle'],
 11:['=','Chances égales, position calme'],
 12:['=','Chances égales, position dynamique'],
 13:['∞','Position peu claire'],
 14:['+/=','Léger avantage aux Blancs'],
 15:['=/+','Léger avantage aux Noirs'],
 16:['+/-','Avantage aux Blancs'],
 17:['-/+','Avantage aux Noirs'],
 18:['+-','Avantage décisif aux Blancs'],
 19:['-+','Avantage décisif aux Noirs'],
 20:['+−−','Avantage écrasant aux Blancs'],
 21:['−−+','Avantage écrasant aux Noirs'],
 22:['⨀','Blancs en zugzwang'],
 23:['⨀','Noirs en zugzwang'],
 32:['↑↑','Avantage de développement aux Blancs'],
 33:['↑↑','Avantage de développement aux Noirs'],
 36:['↑','Initiative aux Blancs'],
 37:['↑','Initiative aux Noirs'],
 40:['→','Attaque des Blancs'],
 41:['→','Attaque des Noirs'],
 44:['=∞','Compensation suffisante pour les Blancs'],
 45:['=∞','Compensation suffisante pour les Noirs'],
 132:['⇆','Contre-jeu des Blancs'],
 133:['⇆','Contre-jeu des Noirs'],
 138:['⊕','Blancs en grande pression de temps'],
 139:['⊕','Noirs en grande pression de temps'],
 140:['∆','Avec l’idée de…'],
 141:['∇','Avec l’intention de contrer…'],
 142:['⌓','Meilleur était…'],
 143:['≤','Moins bon était…'],
 146:['N','Nouveauté théorique'],
};
const annotation=nag=>Object.hasOwn(annotations,nag)?annotations[nag]:null;

// Unknown extensions stay visible instead of being silently discarded.
// These helpers return plain text; renderers must escape it as usual.
export function formatNags(nags=[]){
 return nags.map(nag=>annotation(nag)?.[0]??' $'+String(nag)).join('');
}
export function describeNags(nags=[]){
 return nags.map(nag=>t(annotation(nag)?.[1]??'Annotation PGN $')+(annotation(nag)?'':String(nag))).filter(Boolean).join(' · ');
}
