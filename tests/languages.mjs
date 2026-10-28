import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {LANGUAGES,LOCALES,languageDirection} from '../static/languages.js';
import {t,ui,setLanguage,getLanguage,locale,direction,sourceMessages,TRANSLATIONS} from '../static/i18n.js';
import {languageSettingsHtml} from '../static/settings-page.js';
import {boardRelativeDate} from '../static/board-menu.js';
import {activityHeatmap} from '../static/review-statistics.js';

const expected=['fr','en','es','de','pt','it','ru','zh-CN','ja','ko','ar','hi'];
const templateKeys=value=>[...value.matchAll(/\{([A-Za-z_][A-Za-z_0-9]*)\}/g)].map(match=>match[1]).sort();

test('all twelve native language choices persist and set locale and direction',()=>{
 const store=new Map();
 globalThis.localStorage={setItem:(key,value)=>store.set(key,value),getItem:key=>store.get(key)};
 globalThis.document={documentElement:{lang:'',dir:''}};
 assert.deepEqual(Object.keys(LANGUAGES),expected);
 for(const code of expected){
  assert.equal(setLanguage(code),code);
  assert.equal(getLanguage(),code);
  assert.equal(locale(),LOCALES[code]);
  assert.equal(direction(),code==='ar'?'rtl':'ltr');
  assert.equal(document.documentElement.lang,code);
  assert.equal(document.documentElement.dir,languageDirection(code));
  assert.equal(store.get('chessgym.language'),code);
  const selector=languageSettingsHtml();
  assert.equal((selector.match(/<option /g)||[]).length,12);
  assert(selector.includes('lang="'+code+'" dir="auto"'));
  assert(selector.includes(LANGUAGES[code]));
 }
 setLanguage('fr');
});

test('stored Arabic is applied before the first page render',async()=>{
 globalThis.localStorage={getItem:()=> 'ar',setItem(){}};
 globalThis.document={documentElement:{lang:'',dir:''}};
 const module=await import('../static/i18n.js?stored-language-test');
 assert.equal(module.getLanguage(),'ar');
 assert.equal(document.documentElement.dir,'rtl');
 assert.equal(document.documentElement.lang,'ar');
 module.setLanguage('fr');
});

test('translations preserve interpolated data and never rewrite PGN or names',()=>{
 const personal='Bibliothèque {count} <PGN> 1. Nf3 d5';
 for(const code of expected){
  setLanguage(code);
  assert(t('Action pour {name}',{name:personal}).includes(personal));
  assert.equal(t('personnel non répertorié '+personal),'personnel non répertorié '+personal);
  const html=ui('<span title="Fermer">Bibliothèque</span><input value="Bibliothèque" data-title="Bibliothèque">');
  assert(html.includes('value="Bibliothèque" data-title="Bibliothèque"'));
  assert.equal((html.match(/<span/g)||[]).length,1);
  assert.equal((html.match(/<input/g)||[]).length,1);
 }
 setLanguage('fr');
});

test('calendar and recent-board dates use the selected locale',()=>{
 const current=Date.UTC(2026,9,26,12),previous=current-24*3600*1000;
 for(const code of expected){
  setLanguage(code);
  assert.equal(boardRelativeDate(previous,current),new Intl.RelativeTimeFormat(LOCALES[code],{numeric:'auto'}).format(-1,'day'));
  const label=new Intl.DateTimeFormat(LOCALES[code],{weekday:'narrow',timeZone:'UTC'}).format(new Date(Date.UTC(2024,0,1)));
  assert(activityHeatmap([{date:'2026-10-26',count:1,elapsed_ms:0}]).includes('<span>'+label+'</span>'));
 }
 setLanguage('fr');
});

test('Arabic layout keeps board coordinates and chess notation left to right',async()=>{
 const css=await readFile(new URL('../static/languages.css',import.meta.url),'utf8');
 assert.match(css,/\.chess-board[\s\S]*?direction:ltr/);
 assert.match(css,/\.skill-square-grid[\s\S]*?direction:ltr/);
 assert.match(css,/\.board-recent-preview-board[\s\S]*?direction:ltr/);
 assert.match(css,/\.analysis-move-row[\s\S]*?direction:ltr/);
 assert.match(css,/unicode-bidi:plaintext/);
 const index=await readFile(new URL('../static/index.html',import.meta.url),'utf8');
 assert(index.includes('/static/languages.css'));
});

test('every shipped language translates all source keys and preserves placeholders',()=>{
 for(const code of expected.filter(value=>value!=='fr')){
  const dictionary=TRANSLATIONS[code];
  for(const [source] of Object.entries(sourceMessages)){
   assert.equal(typeof dictionary[source],'string',code+' missing '+source);
   assert(dictionary[source].trim()||!source.trim(),code+' empty '+source);
   assert.deepEqual(templateKeys(dictionary[source]),templateKeys(source),code+' placeholders '+source);
  }
 }
});
