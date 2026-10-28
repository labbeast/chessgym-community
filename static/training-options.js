import {esc,option} from './api.js';
import {t} from './i18n.js';
import {isNativeTraining} from './training-native.js';

const choice=(name,label,values,value)=>'<label>'+esc(t(label))+'<select data-training-option="'+name+'">'+Object.entries(values).map(([key,text])=>option(key,t(text),String(value))).join('')+'</select></label>';
const number=(name,label,value,min,max,step=1)=>'<label>'+esc(t(label))+'<input data-training-option="'+name+'" type="number" min="'+min+'" max="'+max+'" step="'+step+'" value="'+esc(value)+'"></label>';
const toggle=(name,label,value)=>'<label class="tp-option-toggle"><input data-training-option="'+name+'" type="checkbox" '+(value?'checked':'')+'><span>'+esc(t(label))+'</span></label>';
export function trainingOptionsHtml(block){
 if((block.activity!=='review'&&!isNativeTraining(block.activity))||block.resource?.type==='external')return '';
 const o=block.options||{},a=block.activity;let fields='';
 if(a==='review')fields=choice('selection','Cartes à travailler',{review:'Réviser seulement',learn:'Apprendre seulement',both:'Réviser + Apprendre'},o.selection||'both')+'<p class="hint tp-full">'+esc(t('Les révisions dues passent avant les nouvelles cartes. Le volume dépend de l’objectif du bloc.'))+'</p>';
 if(a==='puzzles')fields=choice('mode','Mode de puzzles',{classic:'Classique',storm:'Storm'},o.mode||'classic')+toggle('rated','Puzzles classiques cotés',o.rated!==false)+number('filters.rating_min','Cote minimale',o.filters?.rating_min??0,0,4000)+number('filters.rating_max','Cote maximale',o.filters?.rating_max??4000,0,4000)+choice('filters.color','Camp',{any:'Les deux camps',white:'Blancs',black:'Noirs'},o.filters?.color||'any')+choice('filters.history','Puzzles proposés',{all:'Tous les puzzles',unseen:'Jamais travaillés',failed:'À retravailler'},o.filters?.history||'all');
 if(a==='guess')fields=choice('side','Camp joué',{white:'Blancs',black:'Noirs',both:'Les deux camps'},o.side||'white')+'<p class="hint tp-full">'+esc(t('Choisis une partie de cette ressource au lancement. Les réglages du bloc seront conservés.'))+'</p>';
 if(a==='computer')fields=choice('provider','Adversaire',{stockfish:'Moteur classique',maia:'Maia'},o.provider||'stockfish')+choice('side','Camp joué',{white:'Blancs',black:'Noirs',random:'Au hasard'},o.side||'white')+(o.provider==='maia'?number('level','Niveau Maia',o.level??1500,600,2600,100):number('skill','Niveau du moteur · 0 à 20',o.skill??10,0,20))+choice('time_control','Pendule',{unlimited:'Sans limite',custom:'Personnalisée'},o.time_control||'unlimited')+(o.time_control==='custom'?number('clock_minutes','Minutes par joueur',o.clock_minutes??10,.1,180,.1)+number('clock_increment','Incrément · secondes',o.clock_increment??0,0,180):'');
 if(a==='coordinates')fields=choice('mode','Exercice',{coordinates:'Coordonnées',notation:'Notation des coups',mixed:'Mixte'},o.mode||'coordinates')+choice('duration','Durée',{30:'30 secondes',60:'60 secondes'},o.duration||30)+choice('orientation','Orientation',{white:'Blancs',black:'Noirs',random:'Au hasard'},o.orientation||'white')+toggle('coordinates','Afficher les coordonnées',o.coordinates===true);
 if(a==='color')fields=choice('duration','Durée',{30:'30 secondes',60:'60 secondes'},o.duration||30);
 if(a==='blindfold')fields=(block.resource?.type==='base'?'<p class="hint tp-full">'+esc(t('Reconstituer une position depuis une partie de cette base.'))+'</p>':choice('mode','Exercice à l’aveugle',{opening:'Ouvertures',positions:'Positions'},o.mode||'opening')+toggle('rated','Exercice classé',o.rated!==false))+choice('input','Réponse',{board:'Échiquier',text:'Notation'},o.input||'board')+toggle('hide_prompt','Masquer la présentation après préparation',o.hide_prompt!==false)+toggle('reconstruct_after','Reconstituer aussi la position finale',o.reconstruct_after!==false)+(block.resource?.type==='base'||o.rated===false?number('max_moves','Nombre maximal de coups complets',o.max_moves??10,1,200)+number('max_pieces','Nombre maximal de pièces',o.max_pieces??7,2,32):'');
 return '<fieldset class="tp-native-options tp-full"><legend>'+esc(t('Réglages au lancement'))+'</legend><div class="tp-form-grid">'+fields+'</div><p class="hint">'+esc(t('Ces réglages préparent la prochaine séance. Une activité déjà commencée conserve ses réglages.'))+'</p></fieldset>';
}
export function setTrainingOption(block,key,value,type='text'){
 if(block.activity!=='review'&&!isNativeTraining(block.activity))return false;
 const allowed={review:['selection'],puzzles:['mode','rated','filters.rating_min','filters.rating_max','filters.color','filters.history'],guess:['side'],computer:['provider','side','skill','level','time_control','clock_minutes','clock_increment'],blindfold:['mode','rated','input','hide_prompt','reconstruct_after','max_moves','max_pieces'],coordinates:['mode','duration','orientation','coordinates'],color:['duration']}[block.activity];
 if(!allowed.includes(key))return false;
 const numeric=['rating_min','rating_max','skill','level','clock_minutes','clock_increment','duration','max_moves','max_pieces'];
 const parts=key.split('.'),name=parts.at(-1);block.options||={};const target=parts.length===2?(block.options[parts[0]]||={}):block.options;
 target[name]=type==='checkbox'?!!value:numeric.includes(name)?Number(value):value;
 if(parts[0]==='filters')block.options.selection='custom';
 return true;
}

export function trainingOptionsSummary(block){
 if(block.activity==='review')return t({'review':'Réviser seulement','learn':'Apprendre seulement','both':'Réviser + Apprendre'}[block.options?.selection||'both']);
 const labels={mode:'Exercice',rated:'Exercice classé',selection:'Sélection',rating_min:'Cote minimale',rating_max:'Cote maximale',color:'Camp',history:'Puzzles proposés',side:'Camp joué',provider:'Adversaire',skill:'Niveau du moteur · 0 à 20',level:'Niveau Maia',time_control:'Pendule',clock_minutes:'Minutes par joueur',clock_increment:'Incrément · secondes',duration:'Durée',orientation:'Orientation',coordinates:'Afficher les coordonnées',input:'Réponse',hide_prompt:'Masquer la présentation après préparation',reconstruct_after:'Reconstituer aussi la position finale',max_moves:'Nombre maximal de coups complets',max_pieces:'Nombre maximal de pièces'};
 const values={classic:'Classique',storm:'Storm',opening:'Ouvertures',positions:'Positions',reconstruct:'Reconstituer une position',coordinates:'Coordonnées',notation:'Notation des coups',mixed:'Mixte',white:'Blancs',black:'Noirs',both:'Les deux camps',any:'Les deux camps',random:'Au hasard',stockfish:'Moteur classique',maia:'Maia',unlimited:'Sans limite',custom:'Personnalisée',all:'Tous les puzzles',unseen:'Jamais travaillés',failed:'À retravailler',board:'Échiquier',text:'Notation'};
 const o=block.options||{},flat={...o,...o.filters};delete flat.filters;
 return Object.entries(flat).filter(([key])=>labels[key]).map(([key,value])=>t(labels[key])+': '+(typeof value==='boolean'?t(value?'Oui':'Non'):t(values[value]||String(value)))).join(' · ');
}
