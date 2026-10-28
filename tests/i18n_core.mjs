import assert from 'node:assert/strict';
import {t,ui,setLanguage,getLanguage,locale} from '../static/i18n.js';
const tests={
 static_html_fragments_translate_text_and_preserve_markup(){
  setLanguage('en');
  assert.equal(ui('<button>Bibliothèque</button>'),'<button>Library</button>');
  assert.equal(ui('<div>Bibliothèque'),'<div>Library');
  assert.equal(ui('Bibliothèque</div>'),'Library</div>');
  assert.equal(ui('>Bibliothèque</span>'),'>Library</span>');
  assert.equal(ui('<p>Solution & variantes</p>'),'<p>Solution &amp; variations</p>');
 },
 whitelisted_attributes_translate_even_without_angle_brackets(){
  setLanguage('en');
  assert.equal(ui('title="Bibliothèque" placeholder="Sans titre" aria-label="Fermer" data-label="Coup"'),
               'title="Library" placeholder="Untitled" aria-label="Close" data-label="Move"');
  const html=ui('<input value="Bibliothèque" name="Bibliothèque" data-title="Bibliothèque" title="Fermer">');
  assert.match(html,/value="Bibliothèque"/);assert.match(html,/name="Bibliothèque"/);
  // Application metadata is not a UI label, even when its attribute contains "title".
  assert.match(html,/data-title="Bibliothèque"/);
  assert.match(html,/\stitle="Close"/);
 },
 whitespace_and_unknown_text_are_preserved(){
  setLanguage('en');
  assert.equal(t('  Bibliothèque\n'),'  Library\n');
  assert.equal(ui('<p>  Bibliothèque \n</p>'),'<p>  Library \n</p>');
  assert.equal(t('Texte personnel intraduisible'), 'Texte personnel intraduisible');
  for(const unknown of ['toString','constructor','__proto__'])assert.equal(t(unknown),unknown);
  assert.equal(ui('<p>Texte personnel intraduisible</p>'),'<p>Texte personnel intraduisible</p>');
 },
 interpolated_values_are_not_translated_or_interpreted_recursively(){
  setLanguage('en');
  assert.equal(t('Action pour {name}',{name:'Bibliothèque {count}'}),'Action for Bibliothèque {count}');
  const rendered=ui('<strong>Bibliothèque</strong><span>')+'Bibliothèque <commentaire>'+ui('</span>');
  assert.equal(rendered,'<strong>Library</strong><span>Bibliothèque <commentaire></span>');
 },
 french_roundtrip_returns_original_literals(){
  const source='<label title="Fermer">Solution & variantes</label>';
  setLanguage('en');assert.notEqual(ui(source),source);
  setLanguage('fr');assert.equal(ui(source),source);assert.equal(t('Bibliothèque'),'Bibliothèque');assert.equal(locale(),'fr-CA');
 },
 invalid_language_falls_back_to_french_and_updates_preferences(){
  const stored=new Map();globalThis.localStorage={setItem:(key,value)=>stored.set(key,value)};
  globalThis.document={documentElement:{lang:''}};
  setLanguage('en');assert.equal(getLanguage(),'en');assert.equal(locale(),'en-CA');assert.equal(document.documentElement.lang,'en');
  assert.equal(setLanguage('unsupported'),'fr');assert.equal(getLanguage(),'fr');assert.equal(stored.get('chessgym.language'),'fr');assert.equal(document.documentElement.lang,'fr');
 }
};
const name=process.argv[2];assert(tests[name],name);try{await tests[name]();console.log('PASS '+name);}finally{setLanguage('fr');}

