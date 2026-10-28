import {t} from './i18n.js';
import {esc} from './api.js';
import {uiIcon} from './ui-icons.js';

const modes=[
 {key:'guess_enabled',label:'Deviner le coup',icon:'guess'},
 {key:'review_enabled',label:'Révisions',icon:'reviews'},
 {key:'is_repertoire',label:'Répertoire',icon:'repertoire'},
 {key:'reading_enabled',label:'Lecture',icon:'reading'},
];

export function libraryModes(base){
 return base?modes.filter(mode=>!base.reference||mode.key==='guess_enabled').map(mode=>({...mode,label:t(mode.label),checked:!!base.settings?.[mode.key]})):[];
}

export function libraryModeSettings(base,key,enabled){
 if(typeof enabled!=='boolean'||!libraryModes(base).some(mode=>mode.key===key))return null;
 return key==='is_repertoire'&&!enabled?{is_repertoire:false,primary:false}:{[key]:enabled};
}

export function libraryModeBadgesHtml(base){
 return libraryModes(base).filter(mode=>mode.checked).map(mode=>'<span class="library-mode-badge" data-library-mode="'+mode.key+'" role="img" aria-label="'+esc(mode.label)+'" title="'+esc(mode.label)+'">'+uiIcon(mode.icon)+'</span>').join('');
}
