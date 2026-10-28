import {t,ui} from './i18n.js';
import {api} from './api.js';

export const PIECE_SETS = Object.freeze([
  {id:'cburnett', name:'Cburnett', detail:'Classique · par défaut'},
  {id:'merida', name:'Merida', detail:'Silhouettes traditionnelles'},
  {id:'chessnut', name:'Chessnut', detail:'Lignes contemporaines'},
  {id:'celtic', name:'Celtic', detail:'Courbes celtiques'},
  {id:'fantasy', name:'Fantasy', detail:'Silhouettes fantastiques'},
  {id:'shapes', name:'Shapes', detail:'Formes géométriques'},
  {id:'pirouetti', name:'Pirouetti', detail:'Traits fins et élancés'},
  {id:'spatial', name:'Spatial', detail:'Relief et perspective'}
]);

export const BOARD_THEMES = Object.freeze([
  {id:'brown', name:'Brun classique', light:'#f0d9b5', dark:'#b58863'},
  {id:'blue', name:'Bleu', light:'#dee3e6', dark:'#8ca2ad'},
  {id:'green', name:'Vert', light:'#eeeed2', dark:'#769656'},
  {id:'slate', name:'Ardoise', light:'#c5c8cc', dark:'#737a83'},
  {id:'walnut', name:'Noyer', light:'#eedcc2', dark:'#916443'},
  {id:'sand', name:'Sable', light:'#f7edda', dark:'#c2a46f'},
  {id:'olive', name:'Olive', light:'#ecebd5', dark:'#929468'},
  {id:'ocean', name:'Océan', light:'#d9e9ec', dark:'#5e929b'},
  {id:'lavender', name:'Lavande', light:'#e9e2f0', dark:'#9a83b1'},
  {id:'rose', name:'Rosé', light:'#f1e1dd', dark:'#b77f86'},
  {id:'ice', name:'Glacier', light:'#edf4fa', dark:'#88a9ce'},
  {id:'graphite', name:'Graphite', light:'#e4e5e7', dark:'#6d737c'}
]);

export const UI_THEMES = Object.freeze([
  {id:'copper', name:'Graphite & cuivre', detail:'Sombre et chaleureux', bg:'#18191c', surface:'#222326', accent:'#d69a70', scheme:'dark'},
  {id:'sage', name:'Ardoise & sauge', detail:'Sombre et naturel', bg:'#171c1b', surface:'#222926', accent:'#a2c3aa', scheme:'dark'},
  {id:'midnight', name:'Bleu de minuit', detail:'Sombre et bleuté', bg:'#131a25', surface:'#1c2736', accent:'#91b7e7', scheme:'dark'},
  {id:'plum', name:'Prune', detail:'Sombre et violacé', bg:'#201923', surface:'#2b2330', accent:'#c6a0dc', scheme:'dark'},
  {id:'forest', name:'Forêt', detail:'Vert profond', bg:'#11221e', surface:'#1a3029', accent:'#87cbb0', scheme:'dark'},
  {id:'pearl', name:'Perle', detail:'Clair et épuré', bg:'#f1f4f8', surface:'#ffffff', accent:'#315c93', scheme:'light'},
  {id:'sand', name:'Lin', detail:'Clair et chaleureux', bg:'#f5efdf', surface:'#fffaf0', accent:'#875029', scheme:'light'},
  {id:'contrast', name:'Contraste élevé', detail:'Noir, blanc et or', bg:'#090b0e', surface:'#11151a', accent:'#ffda78', scheme:'dark'}
]);

let activeAppearance = {theme:'copper', piece_set:'cburnett', board_theme:'brown'};

export function normalizeAppearance(prefs={}) {
  return {
    theme:UI_THEMES.some(x=>x.id===prefs?.theme)?prefs.theme:'copper',
    piece_set:PIECE_SETS.some(x=>x.id===prefs?.piece_set)?prefs.piece_set:'cburnett',
    board_theme:BOARD_THEMES.some(x=>x.id===prefs?.board_theme)?prefs.board_theme:'brown'
  };
}

export function pieceUrl(piece, set=activeAppearance.piece_set) {
  if(typeof piece!=='string'||!/^[KQRBNPkqrbnp]$/.test(piece))return '';
  const safeSet=PIECE_SETS.some(x=>x.id===set)?set:'cburnett';
  const file=(piece===piece.toUpperCase()?'w':'b')+piece.toUpperCase()+'.svg';
  return '/static/pieces/'+(safeSet==='cburnett'?'':safeSet+'/')+file;
}

export function applyAppearance(prefs={}) {
  activeAppearance=normalizeAppearance(prefs);
  const colors=BOARD_THEMES.find(x=>x.id===activeAppearance.board_theme);
  const theme=UI_THEMES.find(x=>x.id===activeAppearance.theme);
  if(typeof document!=='undefined') {
    const root=document.documentElement;
    root.style.colorScheme=theme.scheme;
    root.style.setProperty('--board-light', colors.light);
    root.style.setProperty('--board-dark', colors.dark);
    root.dataset.pieceSet=activeAppearance.piece_set;
    root.dataset.boardTheme=activeAppearance.board_theme;
    if(document.body) {
      document.body.dataset.theme=activeAppearance.theme;
      document.body.dataset.pieceSet=activeAppearance.piece_set;
      document.body.dataset.boardTheme=activeAppearance.board_theme;
    }
    const browserColor=document.querySelector('meta[name="theme-color"]');
    if(browserColor)browserColor.content=theme.bg;
  }
  try{globalThis.localStorage?.setItem('chessgym-theme',activeAppearance.theme);}catch{}
  if(typeof window!=='undefined'&&typeof window.CustomEvent==='function') {
    window.dispatchEvent(new window.CustomEvent('chessgym:appearancechange',{detail:{...activeAppearance}}));
  }
  return {...activeAppearance};
}

const samplePieces=['k','','n','','','P','','K'];

function sampleBoard(set, colors, className='') {
  return '<span class="appearance-sample '+className+'" aria-hidden="true" style="--sample-light:'+colors.light+';--sample-dark:'+colors.dark+'">'+samplePieces.map((p,i)=>'<span class="appearance-square '+((Math.floor(i/4)+i%4)%2?'dark':'light')+'">'+(p?'<img src="'+pieceUrl(p,set)+'" alt="" draggable="false">':'')+'</span>').join('')+'</span>';
}

function sampleInterface(theme) {
  return '<span class="appearance-interface-sample" aria-hidden="true" style="--preview-bg:'+theme.bg+';--preview-surface:'+theme.surface+';--preview-accent:'+theme.accent+'"><span class="appearance-preview-bar"></span><span class="appearance-preview-sidebar"></span><span class="appearance-preview-content"><span></span><span></span><span></span></span></span>';
}

export function appearanceSettingsHtml(prefs={}) {
  const value=normalizeAppearance(prefs);
  const colors=BOARD_THEMES.find(x=>x.id===value.board_theme);
  return '<section class="appearance-settings panel settings-width" data-appearance-settings data-theme="'+value.theme+'" data-piece-set="'+value.piece_set+'" data-board-theme="'+value.board_theme+'">'+
    ui('<h2>Apparence</h2><p class="muted">Compose ton espace avec un thème, un échiquier et un jeu de pièces. Chaque choix est enregistré automatiquement.</p>')+
    ui('<div class="appearance-group" role="group" aria-label="Thème de l’interface"><h3>Thème de l’interface</h3><div class="appearance-choices interface-themes">')+UI_THEMES.map(theme=>'<button type="button" class="appearance-choice" data-theme-choice="'+theme.id+'" aria-pressed="'+(theme.id===value.theme)+'">'+sampleInterface(theme)+'<strong>'+t(theme.name)+'</strong><small>'+t(theme.detail)+'</small></button>').join('')+'</div></div>'+
    '<div class="appearance-board-heading">'+
    ui('<h2>Échiquier et pièces</h2><p class="muted">Ces choix s’appliquent à tous les échiquiers et sont enregistrés dans ChessGym.</p>')+
    '</div>'+
    ui('<div class="appearance-group" role="group" aria-label="Jeu de pièces"><h3>Pièces</h3><div class="appearance-choices">')+PIECE_SETS.map(set=>'<button type="button" class="appearance-choice" data-appearance-piece="'+set.id+'" aria-pressed="'+(set.id===value.piece_set)+'">'+sampleBoard(set.id,colors)+'<strong>'+set.name+'</strong><small>'+t(set.detail)+'</small></button>').join('')+'</div></div>'+
    ui('<div class="appearance-group" role="group" aria-label="Couleur de l’échiquier"><h3>Couleurs de l’échiquier</h3><div class="appearance-choices board-colors">')+BOARD_THEMES.map(theme=>'<button type="button" class="appearance-choice" data-appearance-board="'+theme.id+'" aria-pressed="'+(theme.id===value.board_theme)+'">'+sampleBoard(value.piece_set,theme)+'<strong>'+t(theme.name)+'</strong></button>').join('')+'</div></div>'+
    '<p class="appearance-status" data-appearance-status role="status" aria-live="polite"></p></section>';
}

export function bindAppearanceSettings(host,{onSaved,preferencesService,isCurrent=()=>true,canSave=isCurrent}={}) {
  const panel=host.matches?.('[data-appearance-settings]')?host:host.querySelector('[data-appearance-settings]');
  if(!panel)return ()=>{};
  let current=normalizeAppearance({theme:panel.dataset.theme,piece_set:panel.dataset.pieceSet,board_theme:panel.dataset.boardTheme});
  let saving=false;
  const selector='[data-theme-choice], [data-appearance-piece], [data-appearance-board]';
  const buttons=[...panel.querySelectorAll(selector)];
  const status=panel.querySelector('[data-appearance-status]');
  function refresh() {
    panel.dataset.pieceSet=current.piece_set;
    panel.dataset.boardTheme=current.board_theme;
    panel.dataset.theme=current.theme;
    const theme=BOARD_THEMES.find(x=>x.id===current.board_theme);
    for(const button of buttons) {
      const piece=button.dataset.appearancePiece;
      const color=button.dataset.appearanceBoard;
      const interfaceTheme=button.dataset.themeChoice;
      button.setAttribute('aria-pressed',String(interfaceTheme?interfaceTheme===current.theme:piece?piece===current.piece_set:color===current.board_theme));
      if(interfaceTheme)continue;
      const sample=button.querySelector('.appearance-sample');
      if(piece) {
        sample.style.setProperty('--sample-light',theme.light);
        sample.style.setProperty('--sample-dark',theme.dark);
      } else {
        const images=[...sample.querySelectorAll('img')];
        samplePieces.filter(Boolean).forEach((p,i)=>{images[i].src=pieceUrl(p,current.piece_set);});
      }
    }
  }
  async function choose(event) {
    const button=event.target.closest(selector);
    if(!button||!panel.contains(button)||saving||!isCurrent())return;
    const change=button.dataset.themeChoice?{theme:button.dataset.themeChoice}:button.dataset.appearancePiece?{piece_set:button.dataset.appearancePiece}:{board_theme:button.dataset.appearanceBoard};
    if(Object.keys(change).every(key=>current[key]===change[key]))return;
    saving=true;
    panel.setAttribute('aria-busy','true');
    buttons.forEach(b=>{b.disabled=true;});
    status.classList.remove('error');
    status.textContent=t('Enregistrement…');
    try {
      const prefs=preferencesService?await preferencesService.patch(change,{isCurrent:canSave}):await api('/api/preferences',{method:'PATCH',body:change});
      if(!prefs||!canSave())return;
      current=normalizeAppearance({...current,...change,...prefs});
      applyAppearance(current);
      await onSaved?.({...prefs,...current});
      if(!isCurrent())return;
      refresh();
      status.textContent=t('Apparence enregistrée.');
    } catch(error) {
      if(!isCurrent())return;
      status.classList.add('error');
      status.textContent=error.message||t('Impossible d’enregistrer ce choix.');
    } finally {
      saving=false;
      panel.setAttribute('aria-busy','false');
      buttons.forEach(b=>{b.disabled=false;});
    }
  }
  panel.addEventListener('click',choose);
  return ()=>panel.removeEventListener('click',choose);
}
