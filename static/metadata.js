import {t,ui,locale} from './i18n.js';
import {api, esc, field, select, modal, notice} from './api.js';
import {serialize} from './board.js';

const STANDARD = [
  ['White', 'Joueur avec les blancs'], ['Black', 'Joueur avec les noirs'],
  ['WhiteElo', 'Elo des blancs'], ['BlackElo', 'Elo des noirs'],
  ['Event', 'Événement'], ['Site', 'Site / lieu'],
  ['Date', 'Date · AAAA.MM.JJ'], ['Round', 'Ronde'],
  ['Result', 'Résultat'], ['TimeControl', 'Cadence · secondes + incrément'],
  ['ECO', 'Code ECO'], ['Opening', 'Ouverture'],
];
const structural = name => ['fen', 'setup', 'variant'].includes(name.toLowerCase());
const standard = new Set(STANDARD.map(([name]) => name));

// The header patch never serializes a saved entry's move tree. For a free
// analysis, send its current tree to the same validated parser before editing.
export function editMetadata(doc, {onSaved,viewPath,persist=true,openModal=modal} = {}) {
  const original = {...doc.headers};
  const extra = Object.entries(original).filter(([name]) => !standard.has(name) && !structural(name));
  const fields = STANDARD.map(([name,label]) => name === 'Result'
    ? select(t(label), name, [['*',t('En cours / non précisé')],['1-0',t('1–0 · Blancs')],['0-1',t('0–1 · Noirs')],['1/2-1/2',t('½–½ · Nulle')]], original[name] || '*')
    : field(t(label), name, original[name] || '', 'text', 'maxlength="2000"' + (name==='Date'?' placeholder="2026.10.19 ou ????.??.??"':name==='TimeControl'?' placeholder="600+5"':''))).join('');
  const extraRow = (name='', value='') => '<div class="fields metadata-extra-row">'+field(t('Champ PGN'),'extra_name',name,'text','maxlength="80"')+field(t('Valeur · vide pour supprimer'),'extra_value',value,'text','maxlength="2000"')+'</div>';
  const fixed = Object.entries(original).filter(([name])=>structural(name));
  const d = openModal(t('Informations PGN'),
    '<div class="fields">'+field(t('Titre dans la bibliothèque'),'title',doc.title||'','text',ui('maxlength="200" placeholder="Titre facultatif"'))+'</div>'+
    '<div class="fields">'+fields+'</div>'+
    ui('<details class="metadata-extra"><summary>Autres champs PGN (')+extra.length+ui(')</summary><p class="muted">Les champs laissés inchangés sont conservés. Vide une valeur pour la supprimer.</p><div data-extra-rows>')+extra.map(([k,v])=>extraRow(k,v)).join('')+ui('</div><button type="button" data-add-header>＋ Ajouter un champ</button></details>')+
    (fixed.length?ui('<details><summary>Position initiale</summary><p class="muted">Ces informations se modifient dans l’éditeur de position.</p>')+fixed.map(([k,v])=>'<p><strong>'+esc(k)+'</strong> <span class="muted">'+esc(v)+'</span></p>').join('')+'</details>':''),
    {wide:true,...(!persist?{submit:t('Appliquer au brouillon')}:{}),onSubmit:async (form,element)=>{
      const patch={};
      for(const [name] of STANDARD){
        const value=String(form.get(name)??'');
        if(value!==String(original[name]??''))patch[name]=value||null;
      }
      const custom=new Map();
      for(const row of element.querySelectorAll('.metadata-extra-row')){
        const name=row.querySelector('[name=extra_name]').value.trim();
        const value=row.querySelector('[name=extra_value]').value;
        if(!name&&!value)continue;
        if(!name)throw new Error(t('Indique le nom de chaque champ PGN ajouté.'));
        if(standard.has(name)||structural(name))throw new Error(t('Utilise le champ prévu pour ')+name+'.');
        if(custom.has(name))throw new Error(t('Ce champ est présent deux fois : ')+name);
        custom.set(name,value);
      }
      for(const [name] of extra)if(!custom.has(name))patch[name]=null;
      for(const [name,value] of custom)if(value!==String(original[name]??''))patch[name]=value||null;
      const title=String(form.get('title')||'').trim();
      let updated;
      if(doc.id&&persist){
        const body={headers:patch,...(doc.revision?{expected_revision:doc.revision}:{})};
        if(viewPath!==undefined)body.view_path=viewPath;
        if(title&&title!==doc.title)body.title=title;
        updated=await api('/api/entries/'+doc.id,{method:'PATCH',body});
      }else{
        updated={...doc,...await api('/api/board',{method:'POST',body:{pgn:serialize(doc),headers:patch}})};
        if(title)updated.title=title;
        if(Object.keys(patch).length||title&&title!==doc.title)updated.analysis_dirty=true;
      }
      await onSaved?.(updated);
      notice(doc.id&&persist?t('Informations PGN enregistrées.'):t('Informations PGN appliquées au brouillon. Sauvegarde la partie pour les conserver dans la base.'));
    }});
  d.querySelector('[data-add-header]').onclick=()=>{
    d.querySelector('[data-extra-rows]').insertAdjacentHTML('beforeend',extraRow());
    d.querySelector('[data-extra-rows]').lastElementChild.querySelector('input').focus();
  };
  return d;
}


// Batch edits are explicit patches: the default action preserves each entry's
// own value, even when the selected games have different metadata.
export function batchMetadataFields(entries) {
  const ordered=[['Event',t('Tournoi / événement')],...STANDARD.filter(([name])=>name!=='Event')];
  const extra=[...new Set(entries.flatMap(entry=>Object.keys(entry.headers||{})))].filter(name=>!standard.has(name)&&!structural(name)).sort();
  return [...ordered,...extra.map(name=>[name,name])].map(([name,label])=>{
    const values=entries.map(entry=>String(entry.headers?.[name]??''));
    const mixed=values.some(value=>value!==values[0]);
    return {name,label,mixed,value:mixed?'':values[0]||'',custom:!standard.has(name)};
  });
}

export function batchMetadataPatch(rows) {
  const patch={},seen=new Set();
  for(const row of rows){
    if(row.action==='keep')continue;
    if(!['set','clear'].includes(row.action))throw new Error(t('Choisis une action valide pour chaque champ.'));
    const name=String(row.name||'').trim();
    if(!/^[A-Za-z0-9][A-Za-z0-9_+#=:-]{0,79}$/.test(name))throw new Error(t('Indique un nom de champ PGN valide : lettres, chiffres et signes _ + # = : - .'));
    if(structural(name))throw new Error(t('La position initiale et la variante se modifient dans l’éditeur de position.'));
    if(row.custom&&[...standard].some(key=>key.toLowerCase()===name.toLowerCase()))throw new Error(t('Utilise le champ prévu pour ')+name+'.');
    if(seen.has(name))throw new Error(t('Ce champ est présent deux fois : ')+name);
    seen.add(name);
    if(row.action==='clear'){patch[name]=null;continue;}
    const value=String(row.value??'');
    if(!value.trim())throw new Error(t('Saisis une valeur pour ')+name+t(' ou choisis « Effacer ».'));
    if(value.length>2000)throw new Error(t('La valeur du champ ')+name+t(' est trop longue.'));
    if(name==='Result'&&!['*','1-0','0-1','1/2-1/2'].includes(value))throw new Error(t('Choisis un résultat valide.'));
    patch[name]=value;
  }
  if(!Object.keys(patch).length)throw new Error(t('Choisis au moins un champ à remplacer ou à effacer.'));
  return patch;
}

export function editBatchMetadata(entries,{baseName='',onSubmit,openModal=modal}={}){
  if(!entries?.length)throw new Error(t('Sélectionne au moins une partie ou un exercice.'));
  const allFields=batchMetadataFields(entries),common=allFields.filter(f=>!f.custom),extra=allFields.filter(f=>f.custom);
  const rowHtml=({name='',label='',value='',mixed=false,custom=false}={})=>{
    const fieldId='batch-pgn-'+(name||'custom');
    const heading=custom?ui('<label>Champ PGN<input data-bm-name value="')+esc(name)+ui('" maxlength="80" placeholder="Annotator" aria-label="Nom du champ PGN"></label>'):'<label for="'+fieldId+'">'+esc(custom?label:t(label))+'</label>';
    const control=name==='Result'?'<select id="'+fieldId+'" data-bm-value disabled>'+[['',t('Choisir un résultat')],['*',t('En cours / non précisé')],['1-0',t('1–0 · Blancs')],['0-1',t('0–1 · Noirs')],['1/2-1/2',t('½–½ · Nulle')]].map(([v,l])=>'<option value="'+v+'"'+(v===value?' selected':'')+'>'+l+'</option>').join('')+'</select>':'<input'+(custom?'':' id="'+fieldId+'"')+' data-bm-value value="'+esc(value)+'" maxlength="2000" disabled placeholder="'+esc(mixed?t('Valeurs différentes'):name==='Date'?'2026.10.20 ou ????.??.??':name==='TimeControl'?'600+5':t('Non renseigné'))+'" aria-label="'+esc(custom?t('Valeur du champ PGN'):t(label))+'">';
    return '<div class="batch-metadata-row'+(name==='Event'?' batch-metadata-event':'')+'" data-bm-row data-bm-field="'+esc(name)+'"'+(custom?' data-bm-custom':'')+'>'+heading+'<div class="batch-metadata-controls"><select data-bm-action aria-label="'+esc(t('Action pour {name}',{name:custom?(label||name||t('ce champ')):t(label)}))+ui('"><option value="keep">Conserver</option><option value="set">Remplacer</option><option value="clear">Effacer</option></select>')+control+'</div>'+(mixed?ui('<small class="batch-metadata-mixed">Valeurs différentes dans la sélection</small>'):'')+'</div>';
  };
  let pending=false;
  const d=openModal(t('Modifier les informations PGN'),
    '<p><strong>'+entries.length+t(' partie')+(entries.length===1?'':'s')+t(' ou exercice')+(entries.length===1?'':'s')+'</strong>'+(baseName?ui(' de la base <strong>')+esc(baseName)+'</strong>':'')+ui('.</p><p class="hint">Choisis uniquement les champs à modifier. « Conserver » garde la valeur propre à chaque partie. « Effacer » retire la valeur du champ.</p>')+
    '<div class="batch-metadata-grid">'+common.map(rowHtml).join('')+'</div>'+
    ui('<details class="metadata-extra batch-metadata-extra"><summary>Autres champs PGN (')+extra.length+')</summary><div class="batch-metadata-grid" data-bm-extra>'+extra.map(rowHtml).join('')+ui('</div><button type="button" data-bm-add>＋ Ajouter un champ</button></details>')+
    ui('<p class="hint">Les coups, variantes, annotations et titres personnalisés sont conservés.</p>'),
    {wide:true,submit:t('Appliquer à ')+entries.length+t(' partie')+(entries.length===1?'':'s'),onSubmit:async(_form,element)=>{
      const rows=[...element.querySelectorAll('[data-bm-row]')].map(row=>({name:row.hasAttribute('data-bm-custom')?row.querySelector('[data-bm-name]').value:row.dataset.bmField,custom:row.hasAttribute('data-bm-custom'),action:row.querySelector('[data-bm-action]').value,value:row.querySelector('[data-bm-value]').value}));
      const patch=batchMetadataPatch(rows);
      if(pending)throw new Error(t('La modification est déjà en cours.'));
      pending=true;
      const controls=[...element.querySelectorAll('button,input,select')].map(control=>({control,disabled:control.disabled}));
      const preventCancel=event=>event.preventDefault();
      d.addEventListener('cancel',preventCancel);
      for(const {control} of controls)control.disabled=true;
      element.setAttribute('aria-busy','true');
      try{await onSubmit?.(patch);}
      finally{
        pending=false;d.removeEventListener('cancel',preventCancel);
        for(const {control,disabled} of controls)control.disabled=disabled;
        element.setAttribute('aria-busy','false');
        if(d.querySelector('form')===element)updateRows();
      }
    }});
  const updateRows=()=>{
    let edits=0;
    for(const row of d.querySelectorAll('[data-bm-row]')){
      const action=row.querySelector('[data-bm-action]').value,input=row.querySelector('[data-bm-value]');
      input.disabled=action!=='set';input.required=action==='set';row.classList.toggle('batch-metadata-active',action!=='keep');
      if(action!=='keep')edits++;
    }
    const submit=d.querySelector('[type=submit]');if(submit)submit.disabled=!edits;
  };
  const form=d.querySelector('form');
  form.addEventListener('change',event=>{if(!pending&&event.target.hasAttribute('data-bm-action'))updateRows();});
  d.querySelector('[data-bm-add]').onclick=()=>{
    const host=d.querySelector('[data-bm-extra]');host.insertAdjacentHTML('beforeend',rowHtml({custom:true}));
    const row=host.lastElementChild;row.querySelector('[data-bm-action]').value='set';updateRows();row.querySelector('[data-bm-name]').focus();
  };
  updateRows();
  return d;
}
